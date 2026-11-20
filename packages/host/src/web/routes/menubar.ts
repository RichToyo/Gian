import type { Hono } from 'hono';
import { isMenubarNavigation, isUsageClearRequest, isUsageSelection, type UsageSelection } from '@gian/shared';
import type { Db } from '../../storage/db.js';
import type { SessionManager } from '../../session/manager.js';
import type { ApprovalManager } from '../../approval/manager.js';
import { UsageQueryService } from '../../usage/query.js';
import { UsageRecorder, trackingState } from '../../usage/recorder.js';
import { pendingConversations } from '../../usage/pending.js';
import { OfficialQuotaService } from '../../agents/official-quota.js';

export function registerMenubarRoutes(app: Hono, options: {
  db: Db; sessions: Pick<SessionManager, 'listSessions'>; approvals: Pick<ApprovalManager, 'listPending'>;
  quota: OfficialQuotaService; now?: () => number;
  agentExists?: (id: string) => boolean;
}): void {
  const { db, sessions, approvals, quota } = options;
  const now = options.now ?? Date.now;
  trackingState(db, now());
  const query = new UsageQueryService(db, options.agentExists);
  const recorder = new UsageRecorder(db);
  const pending = (limit?: number) => pendingConversations(db, sessions.listSessions(), approvals.listPending(), limit);
  const selection = (params: Record<string, string>): UsageSelection | null => {
    if (Object.keys(params).some(key => key !== 'mode' && key !== 'period')) return null;
    const value = { mode: params.mode ?? 'calendar', period: params.period ?? 'day' };
    return isUsageSelection(value) ? value : null;
  };
  app.get('/api/usage/summary', c => {
    const selected = selection(c.req.query());
    if (!selected) return c.json({ error: 'Invalid usage selection' }, 400);
    return c.json(query.summary(selected, now()));
  });
  app.get('/api/menubar/snapshot', c => {
    const selected = selection(c.req.query());
    if (!selected) return c.json({ error: 'Invalid usage selection' }, 400);
    const asOf = now();
    return c.json(db.transaction(() => ({ asOf, today: query.summary({ mode: 'calendar', period: 'day' }, asOf),
      selectedRange: query.summary(selected, asOf), ...pending(3) }))());
  });
  app.get('/api/menubar/pending', c => c.json(pending()));
  app.post('/api/menubar/navigate', async c => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (!isMenubarNavigation(body)) return c.json({ error: 'Invalid navigation target' }, 400);
    const current = pending().pending.find(item => item.sessionId === body.sessionId && item.revision === body.revision);
    const turn = current ? db.prepare('SELECT MAX(turn_number) AS ordinal FROM turns WHERE session_id = ?').get(body.sessionId) as { ordinal: number | null } : null;
    return c.json(current && turn?.ordinal ? { valid: true, target: { type: 'session', session_id: body.sessionId, turn: turn.ordinal, interaction_id: null } }
      : { valid: false });
  });
  app.post('/api/usage/clear', async c => {
    const body = await c.req.json<unknown>().catch(() => null);
    if (!isUsageClearRequest(body)) return c.json({ error: 'Invalid clear request' }, 400);
    try { return c.json(recorder.clear(body.generation, body.idempotencyKey, now())); }
    catch (error) {
      if (error instanceof Error && error.message === 'GENERATION_CONFLICT') return c.json({ error: 'Stale usage generation' }, 409);
      throw error;
    }
  });
  app.get('/api/agents/official-quota', async c => c.json(await quota.snapshot()));
  app.post('/api/agents/:id/official-quota/refresh', async c => c.json(await quota.refresh(c.req.param('id'))));
}
