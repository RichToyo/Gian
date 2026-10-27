import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { Session } from '@gian/shared';
import { OfficialQuotaService } from '../src/agents/official-quota.js';
import { pendingConversations } from '../src/usage/pending.js';
import { registerMenubarRoutes } from '../src/web/routes/menubar.js';
import { requireDesktopClient } from '../src/web/desktop-boundary.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(auth = false) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(readFileSync(new URL('../migrations/093_menubar_usage.sql', import.meta.url), 'utf8'));
  db.exec(`CREATE TABLE inbox_items(id, generation, revision, source_kind, target_json, updated_at, status, tombstone);
    CREATE TABLE turns(id, session_id, turn_number);
    INSERT INTO turns VALUES('t1', 's0', 1)`);
  const sessions: Session[] = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, name: `Conversation ${i}`, status: 'done', unread: 1,
    archived: 0, updated_at: `2026-10-22T01:00:0${i}Z`, agent_id: 'a1', proxy_plugin_id: 'codex' } as Session));
  const app = new Hono();
  if (auth) app.use('*', requireDesktopClient('isolated-test-token', 'http://localhost'));
  let quotaReads = 0;
  const quota = new OfficialQuotaService(async () => [{ agentId: 'a1', scopeKey: 'one', label: 'Codex', pluginId: 'codex',
    installed: true, firstParty: true, eligibility: 'eligible', read: async () => { quotaReads++; return { windows: [], balances: [] }; } }]);
  registerMenubarRoutes(app, { db, sessions: { listSessions: () => sessions }, approvals: { listPending: () => [] }, quota,
    now: () => Date.parse('2026-10-22T02:00:00Z') });
  return { app, db, sessions, quotaReads: () => quotaReads };
}

describe('menubar local routes and Todo projection', () => {
  it('returns first three and the real total; All/cache reads never query quota or mutate read state', async () => {
    const { app, sessions, quotaReads } = fixture();
    const snapshot = await (await app.request('/api/menubar/snapshot')).json();
    assert.equal(snapshot.pending.length, 3); assert.equal(snapshot.pendingTotal, 8);
    assert.equal(snapshot.today.revision, snapshot.selectedRange.revision);
    const all = await (await app.request('/api/menubar/pending')).json();
    assert.equal(all.pending.length, 8); assert.equal(all.pendingTotal, 8);
    await app.request('/api/agents/official-quota');
    assert.equal(quotaReads(), 0);
    assert.equal(sessions.every(session => session.unread === 1), true);
  });
  it('ignores generic pending/sending without real interaction and excludes archived/hidden rows', () => {
    const { db, sessions } = fixture();
    sessions[0]!.status = 'pending'; sessions[1]!.archived = 1;
    (sessions[2] as Session & { hidden: number }).hidden = 1;
    const rows = pendingConversations(db, sessions, []);
    assert.equal(rows.pendingTotal, 5);
    db.prepare(`INSERT INTO inbox_items VALUES('i',1,1,'session.question',?,'2026-10-22T03:00:00Z','pending',0)`)
      .run(JSON.stringify({ type: 'session', session_id: 's0', turn: 1, interaction_id: 'question' }));
    const next = pendingConversations(db, sessions, []);
    assert.equal(next.pendingTotal, 6);
    assert.equal(next.pending[0]?.reason, 'reply');
    assert.equal(next.pending[0]?.sessionId, 's0');
  });
  it('validates freshness before navigation, does not mark read and rejects deleted targets', async () => {
    const { app, sessions } = fixture();
    const current = await (await app.request('/api/menubar/pending')).json();
    const row = current.pending.find((item: { sessionId: string }) => item.sessionId === 's0');
    const navigate = () => app.request('/api/menubar/navigate', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: row.sessionId, revision: row.revision }) });
    assert.equal((await (await navigate()).json()).valid, true);
    assert.equal(sessions[0]!.unread, 1);
    sessions.shift();
    assert.equal((await (await navigate()).json()).valid, false);
  });
  it('rejects unauthenticated Host access and invalid input without side effects', async () => {
    const protectedApp = fixture(true).app;
    assert.equal((await protectedApp.request('/api/menubar/snapshot')).status, 401);
    const { app, quotaReads } = fixture();
    assert.equal((await app.request('/api/usage/summary?period=year')).status, 400);
    assert.equal((await app.request('/api/usage/summary?url=https://example.com')).status, 400);
    assert.equal((await app.request('/api/usage/clear', { method: 'POST', body: '{}' })).status, 400);
    assert.equal(quotaReads(), 0);
  });
});
