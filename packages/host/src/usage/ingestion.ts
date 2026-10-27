import type { ProxyNotification, Session, UsageTotals } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { parseTokenUsageUpdate } from '../session/token-usage.js';
import { safeTokens, usageRecorderFor, usageKey, usageSourceKey, type UsageSample } from './recorder.js';

interface UsageConversation {
  mode: 'absolute' | 'delta' | 'reset';
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  totalTokens?: number;
}

/** Adapt existing wire counters, not context occupancy or the selected model. */
export function usageSample(
  session: Session,
  notification: ProxyNotification,
  localTurn: { id: string; startedAt: number },
  observedAt: number,
  nativeSource = session.native_session_id,
): UsageSample | null {
  if (!notification || typeof notification !== 'object' || !notification.params) return null;
  if (session.remote_execution || !nativeSource) return null;
  if (notification.method !== 'usage.updated' && notification.method !== 'token_usage.updated') return null;
  const params = notification.params as Record<string, unknown>;
  const data = params.data as Record<string, unknown> | undefined;
  const conversation = parseTokenUsageUpdate(data, session.executor)?.conversation;
  if (!conversation || conversation.mode === 'reset') return null;
  const turn = params.sourceTurnId ?? params.turnId;
  if (typeof turn !== 'string' || !turn || typeof params.eventId !== 'string') return null;
  const totals = session.proxy_plugin_id === 'kimi'
    ? kimiAbsoluteTotals(conversation)
    : otherProviderTotals(conversation);
  if (!totals) return null;
  const emitted = typeof params.emittedAt === 'string' ? Date.parse(params.emittedAt) : NaN;
  const providerTime = safeTokens(emitted) && emitted <= observedAt;
  const profile = session.runtime_profile;
  const sourceKey = usageSourceKey(session.proxy_plugin_id ?? session.executor, profile?.configHome ?? null, nativeSource);
  const step = data?.stepId;
  return {
    sourceKey, sampleKey: usageKey(conversation.mode === 'delta' ? [turn, step ?? 'turn-result'] : params.eventId),
    agentId: session.agent_id ?? null, agentLabel: session.agent_name ?? 'Unknown Agent',
    pluginId: session.proxy_plugin_id ?? null, modelId: null,
    mode: conversation.mode === 'absolute' ? 'cumulative' : 'delta',
    hostTurn: usageKey(localTurn.id), turnStartedAt: localTurn.startedAt,
    occurredAt: providerTime ? emitted : observedAt, observedAt,
    timeBasis: providerTime ? 'provider' : 'observed', totals,
  };
}

/** Kimi admission is a complete absolute snapshot. Cache is already inside
 * input, so the total must be input plus output. Missing fields stay unknown.
 * Sub-agent usage is not in this snapshot; the source remains partial. */
function kimiAbsoluteTotals(conversation: UsageConversation): UsageTotals | null {
  if (conversation.mode !== 'absolute') return null;
  const input = conversation.inputTokens;
  const output = conversation.outputTokens;
  const total = conversation.totalTokens;
  const cached = conversation.cachedInputTokens;
  if (!safeTokens(input) || !safeTokens(output) || !safeTokens(total) || !safeTokens(cached)) return null;
  if (cached > input || !Number.isSafeInteger(input + output) || input + output !== total) return null;
  return {
    totalTokens: total,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
}

function otherProviderTotals(conversation: UsageConversation): UsageTotals | null {
  const input = conversation.inputTokens ?? null;
  const output = conversation.outputTokens ?? null;
  const cached = conversation.cachedInputTokens ?? null;
  const total = conversation.totalTokens ?? (input !== null && output !== null ? input + output : null);
  if (!safeTokens(total)) return null;
  let inclusiveInput = input;
  if (input !== null && output !== null && total !== input + output) {
    // Existing DSH wire reports uncached input plus a combined cache subtotal.
    // Admit it only when the returned total proves the relationship.
    inclusiveInput = cached !== null && total === input + output + cached ? input + cached : null;
  }
  return {
    totalTokens: total,
    inputTokens: inclusiveInput,
    outputTokens: output,
    // The existing wire combines cache read/write; do not pretend it is read.
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
}

export function recordLocalUsage(
  db: Db, session: Session, notification: ProxyNotification, hostTurnId: string | undefined, observedAt = Date.now(),
): void {
  try {
    if (!notification || !notification.params || (notification.method !== 'usage.updated' && notification.method !== 'token_usage.updated')) return;
    if (db.prepare('SELECT 1 FROM remote_execution_bindings WHERE local_session_id = ?').get(session.id)) return;
    const params = notification.params as Record<string, unknown>;
    if (parseTokenUsageUpdate(params.data, session.executor)?.conversation?.mode === 'reset') {
      // Kimi's pinned agent total is durable. A wire reset is not a native
      // usage boundary and would count that cumulative snapshot again.
      if (session.proxy_plugin_id === 'kimi') return;
      const occurredAt = typeof params.emittedAt === 'string' ? Date.parse(params.emittedAt) : NaN;
      if (!session.native_session_id || typeof params.eventId !== 'string' || !safeTokens(occurredAt) || occurredAt > observedAt) return;
      usageRecorderFor(db).recordSafely({ sourceKey: usageSourceKey(session.proxy_plugin_id ?? session.executor,
        session.runtime_profile?.configHome ?? null, session.native_session_id),
        sampleKey: usageKey('reset', params.eventId), agentId: session.agent_id ?? null, agentLabel: session.agent_name ?? 'Unknown Agent',
        pluginId: session.proxy_plugin_id ?? null, modelId: null, mode: 'reset',
        // Control identity, not an invented model Turn. Reset stores no consumption.
        hostTurn: usageKey('reset-control', params.eventId), turnStartedAt: occurredAt,
        occurredAt, observedAt, timeBasis: 'provider', totals: { totalTokens: 0, inputTokens: null, outputTokens: null,
          cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null } });
      return;
    }
    const sourceTurn = params.sourceTurnId ?? params.turnId;
    const known = typeof sourceTurn === 'string' ? db.prepare(`SELECT turn_id FROM proxy_replay_turns
      WHERE session_id = ? AND provider_turn_id = ? AND replay_owned = 0`).get(session.id, sourceTurn) as { turn_id: string } | undefined : undefined;
    // A late earlier-turn sample must retain its actual start time across
    // clear. Unknown provider turn ids cannot borrow the current Host turn.
    const attributedTurn = known?.turn_id ?? (hostTurnId && params.turnId === hostTurnId ? hostTurnId : null);
    if (!attributedTurn) return;
    const turn = db.prepare('SELECT created_at FROM turns WHERE id = ? AND session_id = ?').get(attributedTurn, session.id) as { created_at: string } | undefined;
    if (!turn) return;
    const sample = usageSample(session, notification, { id: attributedTurn, startedAt: Date.parse(turn.created_at) }, observedAt);
    if (sample) usageRecorderFor(db).recordSafely(sample);
  } catch { warnUsageFailure(db); }
}

const warned = new WeakSet<Db>();
export function warnUsageFailure(db: Db): void {
  if (!warned.has(db)) { warned.add(db); console.warn('[usage] local recording incomplete'); }
}
