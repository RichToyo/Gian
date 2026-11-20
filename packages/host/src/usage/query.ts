import type { UsageSelection, UsageSummary, UsageTotals, UsageGroup } from '@gian/shared';
import type { Db } from '../storage/db.js';
import { trackingState, safeTokens } from './recorder.js';
import { usageRange } from './range.js';

const AGGREGATE = `COALESCE(SUM(total_tokens), 0) AS totalTokens,
 CASE WHEN COUNT(*) = COUNT(input_tokens) THEN SUM(input_tokens) END AS inputTokens,
 CASE WHEN COUNT(*) = COUNT(output_tokens) THEN SUM(output_tokens) END AS outputTokens,
 CASE WHEN COUNT(*) = COUNT(cache_read_tokens) THEN SUM(cache_read_tokens) END AS cacheReadTokens,
 CASE WHEN COUNT(*) = COUNT(cache_write_tokens) THEN SUM(cache_write_tokens) END AS cacheWriteTokens,
 CASE WHEN COUNT(*) = COUNT(reasoning_tokens) THEN SUM(reasoning_tokens) END AS reasoningTokens`;
function checked<T extends UsageTotals>(totals: T): T {
  for (const value of Object.values(totals)) {
    if (typeof value === 'number' && !safeTokens(value)) throw new Error('Usage total overflow');
  }
  return totals;
}

export class UsageQueryService {
  constructor(private readonly db: Db, private readonly agentExists?: (id: string) => boolean) {}
  summary(selection: UsageSelection, now = Date.now()): UsageSummary {
    return this.db.transaction((): UsageSummary => {
      const state = trackingState(this.db, now);
      const range = usageRange(selection, now);
      const where = 'generation = ? AND occurred_at >= ? AND occurred_at < ?';
      const params = [state.generation, range.from, range.to];
      const totals = checked(this.db.prepare(`SELECT ${AGGREGATE} FROM usage_samples WHERE ${where}`).get(...params) as UsageTotals);
      const byAgent = (this.db.prepare(`SELECT src.agent_id AS id, MIN(src.agent_label) AS label, src.plugin_id AS pluginId,
        ${AGGREGATE} FROM usage_samples s JOIN usage_sources src USING(source_key)
        WHERE ${where} GROUP BY src.agent_id, src.plugin_id ORDER BY totalTokens DESC`).all(...params) as UsageGroup[]).map(checked);
      for (const group of byAgent) {
        if (group.id === null) group.pluginId = null;
        if (group.id && this.agentExists && !this.agentExists(group.id)) group.label = 'Removed Agent';
      }
      const byModel = (this.db.prepare(`SELECT model_id AS id, COALESCE(model_id, 'Unknown model') AS label,
        CASE WHEN model_id IS NOT NULL AND COUNT(DISTINCT src.agent_id) = 1
          AND COUNT(DISTINCT src.plugin_id) = 1 AND COUNT(src.agent_id) = COUNT(*)
          AND COUNT(src.plugin_id) = COUNT(*) THEN MIN(src.plugin_id) END AS pluginId,
        ${AGGREGATE} FROM usage_samples s JOIN usage_sources src USING(source_key)
        WHERE ${where} GROUP BY model_key ORDER BY totalTokens DESC`).all(...params) as UsageGroup[]).map(checked);
      const buckets = range.boundaries.slice(0, -1).map((from, index) => {
        const to = range.boundaries[index + 1]!;
        const noData = to <= state.started_at;
        const bucket = this.db.prepare(`SELECT COALESCE(SUM(total_tokens), 0) AS tokens
          FROM usage_samples WHERE ${where}`).get(state.generation, from, to) as { tokens: number };
        if (!safeTokens(bucket.tokens)) throw new Error('Usage total overflow');
        return { from, to, tokens: noData ? null : bucket.tokens, coverage: noData ? 'no_data' as const : 'partial' as const };
      });
      return {
        ...totals, selection, from: range.from, to: range.to, timezone: range.timezone,
        asOf: now, trackingStartedAt: state.started_at, generation: state.generation, revision: state.revision,
        // The initial producers do not prove whole-Host completeness. In
        // particular unknown models, unsupported usage and anchors stay partial.
        coverage: now <= state.started_at ? 'no_data' : 'partial', byAgent, byModel, buckets,
      };
    })();
  }
}
