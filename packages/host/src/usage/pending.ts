import { attentionSessionName, sessionNeedsAttention, type MenubarPending, type MenubarTodo, type Session } from '@gian/shared';
import type { ApprovalRecord } from '../approval/manager.js';
import type { Db } from '../storage/db.js';
import { usageKey } from './recorder.js';

export function pendingConversations(db: Db, sessions: Session[], approvals: ApprovalRecord[], limit?: number): MenubarPending {
  const items = db.prepare(`SELECT id, generation, revision, source_kind, target_json, updated_at
    FROM inbox_items WHERE source_kind IN ('session.question', 'session.approval')
    AND status = 'pending' AND tombstone = 0`).all() as Array<{
      id: string; generation: number; revision: number; source_kind: string; target_json: string; updated_at: string;
    }>;
  const rows = sessions.flatMap(session => {
    if (session.archived || (session as Session & { hidden?: number }).hidden) return [];
    const stored = items.filter(item => {
      try {
        const target = JSON.parse(item.target_json) as { type?: string; session_id?: string };
        return target.type === 'session' && target.session_id === session.id;
      } catch { return false; }
    }).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const live = approvals.filter(item => item.sessionId === session.id && item.status === 'pending')
      .sort((a, b) => b.createdAt - a.createdAt);
    const waiting = live[0] ?? stored[0];
    if (!sessionNeedsAttention(session, Boolean(waiting))) return [];
    const reason: MenubarTodo['reason'] = waiting
      ? ('category' in waiting ? waiting.category === 'question' || waiting.projected === 'question'
        : waiting.source_kind === 'session.question') ? 'reply' : 'approval'
      : session.status === 'error' ? 'failed' : 'unread';
    const updatedAt = stored[0]?.updated_at ?? session.updated_at;
    const revision = usageKey(session.id, session.updated_at, session.status, session.unread,
      live.map(item => [item.id, item.turnId, item.createdAt]), stored.map(item => [item.id, item.generation, item.revision]));
    return [{ sessionId: session.id, revision, title: attentionSessionName(session.name),
      agentId: session.agent_id ?? null, pluginId: session.proxy_plugin_id ?? null,
      reason, updatedAt }];
  });
  const rank = { approval: 0, reply: 0, failed: 1, unread: 2 };
  rows.sort((a, b) => rank[a.reason] - rank[b.reason] || b.updatedAt.localeCompare(a.updatedAt) || a.sessionId.localeCompare(b.sessionId));
  return { pendingTotal: rows.length, pending: (limit === undefined ? rows : rows.slice(0, limit))
    .map(({ updatedAt: _, ...row }) => row) };
}
