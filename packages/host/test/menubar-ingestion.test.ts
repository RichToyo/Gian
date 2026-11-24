import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import type { ProxyNotification, Session, UsageSelection } from '@gian/shared';
type OuterNotification = { method: string; params: Record<string, unknown> };
import { recordLocalUsage, usageSample } from '../src/usage/ingestion.js';
import { trackingState, UsageRecorder, usageSourceKey } from '../src/usage/recorder.js';
import { UsageQueryService } from '../src/usage/query.js';

const session = { id: 's1', executor: 'ai.deepseek.harness', proxy_plugin_id: 'ai.deepseek.harness', native_session_id: 'native',
  agent_id: 'a1', agent_name: 'DSH', runtime_profile: { configHome: '/isolated/agent' } } as Session;
const message = (conversation: unknown, stepId = 'step1', emittedAt = '2026-10-22T01:00:00Z') => ({
  method: 'usage.updated', params: { eventId: `event:${stepId}`, sourceTurnId: 'native-turn', emittedAt,
    data: { stepId, conversation } },
}) as ProxyNotification;
const now = Date.parse('2026-10-22T01:00:01Z');
const turn = { id: 'host-turn', startedAt: now - 5_000 };

describe('menubar passive local ingestion', () => {
  it('normalizes DSH inclusive input without double-counting combined cache', () => {
    const sample = usageSample(session, message({ mode: 'delta', inputTokens: 20, outputTokens: 5, cachedInputTokens: 10, totalTokens: 35 }), turn, now)!;
    assert.equal(sample.totals.inputTokens, 30);
    assert.equal(sample.totals.totalTokens, 35);
    assert.equal(sample.totals.cacheReadTokens, null);
    assert.equal(sample.modelId, null);
    const second = usageSample(session, message({ mode: 'delta', totalTokens: 50 }, 'step2'), turn, now)!;
    assert.notEqual(sample.sampleKey, second.sampleKey);
  });
  it('keeps already-inclusive input unchanged and unknown components null', () => {
    const sample = usageSample(session, message({ mode: 'delta', inputTokens: 30, outputTokens: 5, cachedInputTokens: 10, totalTokens: 35 }), turn, now)!;
    assert.equal(sample.totals.inputTokens, 30);
    assert.equal(sample.totals.reasoningTokens, null);
  });
  it('rejects remote mirrors, occupancy-only data, unsafe values and unqualified mixed Kimi snapshots', () => {
    assert.equal(usageSample({ ...session, remote_execution: {} } as Session, message({ mode: 'delta', totalTokens: 5 }), turn, now), null);
    assert.equal(usageSample(session, { method: 'usage.updated', params: { data: { context: { used: 8_000, window: 128_000 } } } } as ProxyNotification, turn, now), null);
    assert.equal(usageSample(session, message({ mode: 'delta', totalTokens: Number.MAX_SAFE_INTEGER + 1 }), turn, now), null);
    const kimi = { ...session, executor: 'kimi', proxy_plugin_id: 'kimi' } as Session;
    assert.equal(usageSample(kimi, message({ mode: 'absolute', totalTokens: 100 }), turn, now), null);
    assert.equal(usageSample(kimi, message({ mode: 'absolute', inputTokens: 20, outputTokens: 5, cachedInputTokens: 10, totalTokens: 35 }), turn, now), null);
    // The Kimi 2.7 Proxy reports one delta per Gian turn; it must be counted.
    assert.deepEqual(usageSample(kimi, message({ mode: 'delta', inputTokens: 20, outputTokens: 5, cachedInputTokens: 0, totalTokens: 25 }), turn, now)?.totals, {
      totalTokens: 25, inputTokens: 20, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null,
    });
    assert.equal(usageSample(kimi, message({ mode: 'delta', inputTokens: 20, outputTokens: 5, cachedInputTokens: 0, totalTokens: 24 }), turn, now), null);
  });
  it('uses stable native/HOME identity, not stream or current model alias, and labels observed time', () => {
    const first = usageSample(session, message({ mode: 'absolute', totalTokens: 100 }), turn, now)!;
    const second = usageSample({ ...session, id: 'another-local-row', model: 'selected-alias' }, message({ mode: 'absolute', totalTokens: 150 }), turn, now)!;
    assert.equal(first.sourceKey, second.sourceKey);
    const observed = usageSample(session, message({ mode: 'delta', totalTokens: 5 }, 's', 'invalid'), turn, now)!;
    assert.equal(observed.timeBasis, 'observed');
    assert.equal(observed.occurredAt, now);
  });
  it('attributes late usage to its actual local turn and never borrows a post-clear active turn', () => {
    const db = new Database(':memory:');
    try {
      db.exec(readFileSync(new URL('../migrations/093_menubar_usage.sql', import.meta.url), 'utf8'));
      db.exec(`CREATE TABLE remote_execution_bindings(local_session_id);
        CREATE TABLE turns(id, session_id, created_at);
        CREATE TABLE proxy_replay_turns(session_id, provider_turn_id, turn_id, replay_owned)`);
      trackingState(db, now - 10_000);
      const recorder = new UsageRecorder(db);
      recorder.bindSource(usageSourceKey('ai.deepseek.harness', '/isolated/agent', 'native'), true, now - 9_000);
      db.prepare('INSERT INTO turns VALUES(?,?,?)').run('old-turn', 's1', new Date(now - 5_000).toISOString());
      db.prepare('INSERT INTO turns VALUES(?,?,?)').run('new-turn', 's1', new Date(now - 1_000).toISOString());
      db.prepare('INSERT INTO proxy_replay_turns VALUES(?,?,?,0)').run('s1', 'native-turn', 'old-turn');
      recorder.clear(1, 'clear', now - 2_000);
      recordLocalUsage(db, session, message({ mode: 'delta', totalTokens: 50 }), 'new-turn', now);
      assert.equal(new UsageQueryService(db).summary({ mode: 'rolling', period: 'day' }, now + 1).totalTokens, 0);
      recordLocalUsage(db, session, message({ mode: 'reset' }, 'reset', new Date(now).toISOString()), undefined, now + 1);
      const next = message({ mode: 'absolute', totalTokens: 50 }, 'new', new Date(now + 2).toISOString());
      (next.params as Record<string, unknown>).turnId = 'new-turn';
      (next.params as Record<string, unknown>).sourceTurnId = 'new-native-turn';
      recordLocalUsage(db, session, next, 'new-turn', now + 3);
      assert.equal(new UsageQueryService(db).summary({ mode: 'rolling', period: 'day' }, now + 4).totalTokens, 50);
    } finally { db.close(); }
  });
});

const kimiSession = {
  id: 'kimi-local', executor: 'kimi', proxy_plugin_id: 'kimi', native_session_id: 'native-kimi',
  agent_id: 'kimi-agent', agent_name: 'Kimi', runtime_profile: { configHome: '/isolated/kimi' },
} as Session;
const kimiSelections: UsageSelection[] = [
  { mode: 'rolling', period: 'day' }, { mode: 'rolling', period: 'week' }, { mode: 'rolling', period: 'month' },
  { mode: 'calendar', period: 'day' }, { mode: 'calendar', period: 'week' }, { mode: 'calendar', period: 'month' },
];

/** Absolute main-agent snapshots as the pre-2.7 Kimi Proxy (0.4.17) emitted
 * them: input already includes cache read and creation, total = input + output.
 * Each snapshot gets its own event id, so a replayed snapshot is a duplicate. */
let kimiEventSequence = 0;
function kimiSnapshots(turns: Array<{ gianTurnId: string; promptId: string; totals: Array<[number, number, number]> }>): OuterNotification[] {
  return turns.flatMap(turn => turn.totals.map(([input, output, cached]) => ({
    method: 'usage.updated',
    params: {
      eventId: `kimi-usage-${kimiEventSequence += 1}`, sourceTurnId: turn.promptId, turnId: turn.gianTurnId,
      data: { conversation: { mode: 'absolute', inputTokens: input, outputTokens: output, cachedInputTokens: cached, totalTokens: input + output } },
    },
  })));
}

function openUsageDb(startedAt: number): Database.Database {
  const db = new Database(':memory:');
  db.exec(readFileSync(new URL('../migrations/093_menubar_usage.sql', import.meta.url), 'utf8'));
  db.exec(`CREATE TABLE remote_execution_bindings(local_session_id);
    CREATE TABLE turns(id, session_id, created_at);
    CREATE TABLE proxy_replay_turns(session_id, provider_turn_id, turn_id, replay_owned)`);
  trackingState(db, startedAt);
  return db;
}

function rememberTurn(db: Database.Database, sessionId: string, turnId: string, promptId: string, startedAt: number): void {
  db.prepare('INSERT INTO turns VALUES(?,?,?)').run(turnId, sessionId, new Date(startedAt).toISOString());
  db.prepare('INSERT INTO proxy_replay_turns VALUES(?,?,?,0)').run(sessionId, promptId, turnId);
}

function timedUsage(event: OuterNotification, emittedAt: number): ProxyNotification {
  return { method: event.method, params: { ...event.params, emittedAt: new Date(emittedAt).toISOString() } } as ProxyNotification;
}

function assertTotals(db: Database.Database, at: number, earliest: number, total: number): void {
  const query = new UsageQueryService(db);
  const rolling = (['day', 'week', 'month'] as const).map((period) => query.summary({ mode: 'rolling', period }, at).totalTokens);
  assert.deepEqual(rolling, [total, total, total]);
  for (const selection of kimiSelections) {
    const summary = query.summary(selection, at);
    if (earliest >= summary.from && earliest < summary.to) {
      assert.equal(summary.totalTokens, total, `${selection.mode} ${selection.period}`);
    }
  }
}

describe('kimi main-agent cumulative local usage', () => {
  it('diffs absolute main-agent totals across turns without counting cache, context, or replays twice', async () => {
    const origin = Date.now() - 20_000;
    const observed = origin + 9_000;
    const db = openUsageDb(origin);
    try {
      const source = usageSourceKey('kimi', '/isolated/kimi', 'native-kimi');
      new UsageRecorder(db).bindSource(source, true, origin + 100);
      rememberTurn(db, kimiSession.id, 'host-1', 'prompt-1', origin + 1_000);
      rememberTurn(db, kimiSession.id, 'host-2', 'prompt-2', origin + 5_000);
      const usage = kimiSnapshots([
        { gianTurnId: 'host-1', promptId: 'prompt-1', totals: [[100, 20, 30], [130, 40, 30], [0, 0, 0], [150, 50, 30], [140, 50, 30]] },
        { gianTurnId: 'host-2', promptId: 'prompt-2', totals: [[150, 50, 30], [160, 60, 30]] },
      ]);
      const [first, second, zero, grown, older, repeated, later] = usage;
      recordLocalUsage(db, kimiSession, timedUsage(first!, origin + 2_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 120);
      recordLocalUsage(db, kimiSession, timedUsage(second!, origin + 2_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 170);
      recordLocalUsage(db, kimiSession, timedUsage(second!, origin + 2_000), undefined, observed);
      recordLocalUsage(db, kimiSession, timedUsage(older!, origin + 1_500), undefined, observed);
      recordLocalUsage(db, kimiSession, timedUsage(zero!, origin + 3_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 170);
      recordLocalUsage(db, kimiSession, timedUsage(grown!, origin + 4_000), undefined, observed);
      recordLocalUsage(db, kimiSession, timedUsage(repeated!, origin + 6_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 200);
      recordLocalUsage(db, kimiSession, timedUsage(later!, origin + 7_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 220);
      const summary = new UsageQueryService(db).summary({ mode: 'rolling', period: 'day' }, observed + 1);
      assert.equal(summary.inputTokens, 160);
      assert.equal(summary.outputTokens, 60);
      assert.equal(summary.cacheReadTokens, null);
      assert.equal(summary.coverage, 'partial');
      assert.equal(summary.byModel[0]?.id, null);
      assert.deepEqual(db.prepare('SELECT COUNT(*) AS n, MIN(partial) AS partial FROM usage_sources').get(), { n: 1, partial: 1 });
    } finally { db.close(); }
  });

  it('records one Kimi 2.7 delta per Gian turn and never counts its replay again', () => {
    const origin = Date.now() - 20_000;
    const observed = origin + 9_000;
    const db = openUsageDb(origin);
    try {
      const source = usageSourceKey('kimi', '/isolated/kimi', 'native-kimi');
      new UsageRecorder(db).bindSource(source, true, origin + 100);
      rememberTurn(db, kimiSession.id, 'host-1', 'prompt-1', origin + 1_000);
      rememberTurn(db, kimiSession.id, 'host-2', 'prompt-2', origin + 3_000);
      const delta = (promptId: string, turnId: string, eventId: string, input: number, output: number, cached: number) => ({
        method: 'usage.updated',
        params: { eventId, sourceTurnId: promptId, turnId,
          data: { conversation: { mode: 'delta', inputTokens: input, outputTokens: output, cachedInputTokens: cached, totalTokens: input + output } } },
      }) as OuterNotification;
      recordLocalUsage(db, kimiSession, timedUsage(delta('prompt-1', 'host-1', 'live-1', 100, 20, 30), origin + 2_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 120);
      // Replay of the same native turn carries another event id but the same turn key.
      recordLocalUsage(db, kimiSession, timedUsage(delta('prompt-1', 'host-1', 'replay-1', 100, 20, 30), origin + 2_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 120);
      recordLocalUsage(db, kimiSession, timedUsage(delta('prompt-2', 'host-2', 'live-2', 50, 10, 0), origin + 4_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 180);
    } finally { db.close(); }
  });

  it('anchors a recovered source once and shares that cursor across local rows for one native HOME', async () => {
    const origin = Date.now() - 20_000;
    const observed = origin + 9_000;
    const db = openUsageDb(origin);
    try {
      const source = usageSourceKey('kimi', '/isolated/kimi', 'native-kimi');
      new UsageRecorder(db).bindSource(source, false, origin + 100);
      rememberTurn(db, kimiSession.id, 'host-1', 'prompt-1', origin + 1_000);
      const other = { ...kimiSession, id: 'kimi-local-2' } as Session;
      rememberTurn(db, other.id, 'host-2', 'prompt-2', origin + 1_000);
      const projected = kimiSnapshots([
        { gianTurnId: 'host-1', promptId: 'prompt-1', totals: [[800, 200, 0], [950, 250, 50]] },
        { gianTurnId: 'host-2', promptId: 'prompt-2', totals: [[1_100, 300, 50]] },
      ]);
      assert.deepEqual(projected.map((event) => (event.params.data as { conversation: { totalTokens: number } }).conversation.totalTokens), [1000, 1200, 1400]);
      recordLocalUsage(db, kimiSession, timedUsage(projected[0]!, origin + 2_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 0);
      recordLocalUsage(db, kimiSession, timedUsage(projected[1]!, origin + 3_000), undefined, observed);
      recordLocalUsage(db, other, timedUsage(projected[2]!, origin + 4_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 400);
      assert.equal((db.prepare('SELECT COUNT(*) AS n FROM usage_sources').get() as { n: number }).n, 1);
    } finally { db.close(); }
  });

  it('keeps a real zero, ignores a wire reset, and does not restore cleared usage from an old turn', async () => {
    const origin = Date.now() - 20_000;
    const observed = origin + 12_000;
    const db = openUsageDb(origin);
    try {
      const source = usageSourceKey('kimi', '/isolated/kimi', 'native-kimi');
      new UsageRecorder(db).bindSource(source, true, origin + 100);
      rememberTurn(db, kimiSession.id, 'host-1', 'prompt-1', origin + 1_000);
      const projected = kimiSnapshots([
        { gianTurnId: 'host-1', promptId: 'prompt-1', totals: [[0, 0, 0], [100, 20, 10], [120, 30, 10]] },
      ]);
      assert.deepEqual(projected.map((event) => (event.params.data as { conversation: { totalTokens: number } }).conversation.totalTokens), [0, 120, 150]);
      recordLocalUsage(db, kimiSession, timedUsage(projected[0]!, origin + 2_000), undefined, observed);
      recordLocalUsage(db, kimiSession, timedUsage(projected[1]!, origin + 3_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 120);
      recordLocalUsage(db, kimiSession, {
        method: 'usage.updated',
        params: {
          eventId: 'kimi-reset', sourceTurnId: 'prompt-1', turnId: 'host-1',
          emittedAt: new Date(origin + 3_500).toISOString(),
          data: { conversation: { mode: 'reset' } },
        },
      } as ProxyNotification, undefined, observed);
      recordLocalUsage(db, kimiSession, timedUsage(projected[2]!, origin + 4_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 2_000, 150);
      const cleared = new UsageRecorder(db).clear(1, 'clear-kimi', origin + 5_000);
      assert.equal(cleared.generation, 2);
      assertTotals(db, observed + 1, origin + 8_000, 0);
      recordLocalUsage(db, kimiSession, timedUsage(projected[2]!, origin + 4_000), undefined, observed);
      const late = kimiSnapshots([{ gianTurnId: 'host-1', promptId: 'prompt-1', totals: [[140, 40, 10]] }])[0]!;
      recordLocalUsage(db, kimiSession, timedUsage(late, origin + 6_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 8_000, 0);
      rememberTurn(db, kimiSession.id, 'host-2', 'prompt-2', origin + 7_000);
      const next = kimiSnapshots([{ gianTurnId: 'host-2', promptId: 'prompt-2', totals: [[160, 50, 10]] }])[0]!;
      recordLocalUsage(db, kimiSession, timedUsage(next, origin + 8_000), undefined, observed);
      assertTotals(db, observed + 1, origin + 8_000, 30);
      assert.equal(usageSample(kimiSession, {
        method: 'usage.updated',
        params: {
          eventId: 'missing-kimi', sourceTurnId: 'prompt-2', turnId: 'host-2',
          emittedAt: new Date(origin + 8_500).toISOString(),
          data: { conversation: { mode: 'absolute', outputTokens: 50, cachedInputTokens: 0, totalTokens: 50 }, context: { used: 42_000 } },
        },
      } as ProxyNotification, { id: 'host-2', startedAt: origin + 7_000 }, observed), null);
    } finally { db.close(); }
  });
});
