import { createHash } from 'node:crypto';
import type { UsageTotals } from '@gian/shared';
import type { Db } from '../storage/db.js';

export const usageKey = (...parts: unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const UNKNOWN_MODEL = 'unknown:model';
export const usageSourceKey = (pluginId: string, configHome: string | null, nativeId: string): string =>
  usageKey('local-usage-v1', pluginId, configHome, nativeId);
export const COUNTERS = ['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;

export interface UsageSample {
  sourceKey: string;
  sampleKey: string;
  agentId: string | null;
  agentLabel: string;
  pluginId: string | null;
  modelId: string | null;
  mode: 'delta' | 'cumulative' | 'reset';
  hostTurn: string;
  turnStartedAt: number;
  occurredAt: number;
  observedAt: number;
  timeBasis: 'provider' | 'observed';
  totals: UsageTotals;
}

export function safeTokens(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function trackingState(db: Db, now = Date.now()): { generation: number; revision: number; started_at: number; cleared_at: number | null } {
  const existing = db.prepare('SELECT * FROM usage_tracking_state WHERE id = 1').get() as ReturnType<typeof trackingState> | undefined;
  if (existing) return existing;
  db.prepare('INSERT OR IGNORE INTO usage_tracking_state(id, started_at) VALUES(1, ?)').run(now);
  return db.prepare('SELECT * FROM usage_tracking_state WHERE id = 1').get() as ReturnType<typeof trackingState>;
}

export class UsageRecorder {
  private warned = false;
  constructor(private readonly db: Db) {}

  /** Called from successful native create/attach, not from usage notifications.
   * Only a genuinely new native source can authorize an initial zero baseline. */
  bindSource(sourceKey: string, isNew: boolean, now = Date.now()): void {
    this.db.transaction(() => {
      const origin = this.db.prepare('INSERT OR IGNORE INTO usage_origins VALUES(?, ?, ?)').run(sourceKey, isNew ? 'zero' : 'anchor', now);
      if (!origin.changes) this.db.prepare("UPDATE usage_origins SET baseline = 'anchor', bound_at = ? WHERE source_key = ?").run(now, sourceKey);
      // A fresh attachment can span external writes. Reconnection is not a new
      // epoch, but its first snapshot must exclude any unowned gap.
      this.db.prepare('UPDATE usage_sources SET anchor_required = 1 WHERE source_key = ?').run(sourceKey);
    })();
  }

  /** Accounting failure never fails generation or retries the Provider. */
  recordSafely(sample: UsageSample): void {
    try { this.record(sample); } catch {
      if (!this.warned) {
        this.warned = true;
        console.warn('[usage] local recording incomplete');
      }
    }
  }

  record(sample: UsageSample): void {
    for (const key of COUNTERS) {
      if (sample.totals[key] !== null && !safeTokens(sample.totals[key])) throw new Error('Invalid usage counter');
    }
    if (![sample.occurredAt, sample.observedAt, sample.turnStartedAt].every(safeTokens)) throw new Error('Invalid usage time');
    this.db.transaction(() => {
      const state = trackingState(this.db, sample.observedAt);
      this.db.prepare(`INSERT OR IGNORE INTO usage_sources(source_key, agent_id, agent_label, plugin_id)
        VALUES(?, ?, ?, ?)`).run(sample.sourceKey, sample.agentId, sample.agentLabel, sample.pluginId);
      const source = this.db.prepare('SELECT epoch, anchor_required FROM usage_sources WHERE source_key = ?').get(sample.sourceKey) as { epoch: string; anchor_required: number };
      const { epoch } = source;
      const bound = this.db.prepare('SELECT bound_at FROM usage_origins WHERE source_key = ?').get(sample.sourceKey) as { bound_at: number } | undefined;
      if (sample.mode === 'reset' && bound && sample.occurredAt < bound.bound_at) return;
      // Reset receipts use a fixed namespace so replaying a reset cannot rotate again.
      const receiptEpoch = sample.mode === 'reset' ? 'reset' : epoch;
      const modelKey = sample.modelId === null ? UNKNOWN_MODEL : `model:${sample.modelId}`;
      const receipt = this.db.prepare(`INSERT OR IGNORE INTO usage_receipts VALUES(?, ?, ?, ?)`)
        .run(sample.sourceKey, receiptEpoch, sample.sampleKey, modelKey);
      if (!receipt.changes) return;
      if (sample.mode === 'reset') {
        this.db.prepare('UPDATE usage_sources SET epoch = ?, partial = 1 WHERE source_key = ?')
          .run(sample.sampleKey, sample.sourceKey);
        this.db.prepare(`INSERT INTO usage_origins VALUES(?, 'zero', ?) ON CONFLICT(source_key)
          DO UPDATE SET baseline = 'zero', bound_at = excluded.bound_at`).run(sample.sourceKey, sample.occurredAt);
        this.bump();
        return;
      }
      let totals = { ...sample.totals };
      let include = sample.turnStartedAt >= state.started_at
        && sample.turnStartedAt > (state.cleared_at ?? -1)
        && sample.occurredAt >= state.started_at && sample.occurredAt <= sample.observedAt;
      if (sample.mode === 'cumulative') {
        const previous = this.db.prepare(`SELECT * FROM usage_cursors
          WHERE source_key = ? AND epoch = ? AND model_key = ?`).get(sample.sourceKey, epoch, modelKey) as
          { counters_json: string; occurred_at: number; host_turn: string } | undefined;
        if (previous && sample.occurredAt < previous.occurred_at) return;
        const before = previous ? JSON.parse(previous.counters_json) as UsageTotals : null;
        const origin = this.db.prepare('SELECT baseline, bound_at FROM usage_origins WHERE source_key = ?').get(sample.sourceKey) as
          { baseline: 'zero' | 'anchor'; bound_at: number } | undefined;
        if (origin && sample.occurredAt < origin.bound_at) return;
        const fromZero = !previous && origin?.baseline === 'zero' && origin.bound_at >= state.started_at;
        // Baseline is source-scoped. A new Gian-created source counts its first
        // terminal and later turns subtract the durable source cursor, not a
        // per-turn anchor. Old/fork/uncertain attachments anchor exactly once.
        include = include && (fromZero || (Boolean(previous) && !source.anchor_required));
        if (before && sample.totals.totalTokens < before.totalTokens) {
          // Unexplained decrease: retain the trusted high-water, never add the
          // new absolute value as consumption. Only an explicit reset changes it.
          this.bump();
          return;
        }
        for (const key of COUNTERS) {
          if (key === 'totalTokens') continue;
          const old = before?.[key];
          const current = sample.totals[key];
          totals[key] = fromZero ? current : current === null || old == null || current < old ? null : current - old;
        }
        totals.totalTokens = before ? sample.totals.totalTokens - before.totalTokens : fromZero ? sample.totals.totalTokens : 0;
        this.db.prepare(`INSERT INTO usage_cursors VALUES(?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_key, epoch, model_key) DO UPDATE SET counters_json=excluded.counters_json,
          occurred_at=excluded.occurred_at, host_turn=excluded.host_turn`)
          .run(sample.sourceKey, epoch, modelKey, JSON.stringify(sample.totals), sample.occurredAt, sample.hostTurn);
        this.db.prepare('UPDATE usage_sources SET anchor_required = 0 WHERE source_key = ?').run(sample.sourceKey);
      }
      if (include) {
        this.db.prepare(`INSERT INTO usage_samples VALUES(
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(sample.sourceKey, epoch, sample.sampleKey, modelKey, sample.modelId, state.generation,
            sample.occurredAt, sample.observedAt, sample.timeBasis, totals.totalTokens,
            totals.inputTokens, totals.outputTokens, totals.cacheReadTokens, totals.cacheWriteTokens, totals.reasoningTokens);
      }
      this.bump();
    })();
  }

  clear(generation: number, idempotencyKey: string, now = Date.now()): { generation: number } {
    return this.db.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM usage_clear_requests WHERE request_key = ?').get(idempotencyKey) as
        { expected_generation: number; result_generation: number } | undefined;
      if (previous) {
        if (previous.expected_generation !== generation) throw new Error('GENERATION_CONFLICT');
        return { generation: previous.result_generation };
      }
      const state = trackingState(this.db, now);
      if (state.generation !== generation) throw new Error('GENERATION_CONFLICT');
      if (!safeTokens(generation + 1)) throw new Error('Usage generation overflow');
      this.db.prepare('DELETE FROM usage_samples').run();
      this.db.prepare('UPDATE usage_sources SET anchor_required = 1').run();
      this.db.prepare(`UPDATE usage_tracking_state SET generation = generation + 1,
        revision = revision + 1, started_at = ?, cleared_at = ? WHERE id = 1`).run(now, now);
      this.db.prepare('INSERT INTO usage_clear_requests VALUES(?, ?, ?)').run(idempotencyKey, generation, generation + 1);
      // Keep cursors and receipts as replay tombstones. Active cross-clear turns
      // re-anchor, but never contribute to the new visible generation.
      return { generation: generation + 1 };
    })();
  }

  private bump(): void {
    this.db.prepare('UPDATE usage_tracking_state SET revision = revision + 1 WHERE id = 1').run();
  }
}

const recorders = new WeakMap<Db, UsageRecorder>();
export function usageRecorderFor(db: Db): UsageRecorder {
  let recorder = recorders.get(db);
  if (!recorder) { recorder = new UsageRecorder(db); recorders.set(db, recorder); }
  return recorder;
}
