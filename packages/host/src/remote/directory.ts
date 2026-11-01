import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  DIRECTORY_RECENT_MS, RemoteProtocolError, directoryListParamsSchema,
  directoryListResultSchema, redactRemoteText,
  type DirectoryListResult, type RemoteDirectoryEntry,
} from '@gian/remote-protocol';
import { normalizeSearchText, type Session } from '@gian/shared';
import type { Db } from '../storage/db.js';
import type { SessionManager } from '../session/manager.js';
import { foldTurnMessages, foldedSearchText } from '../search/fold.js';
import type { RemoteDeviceRecord, RemoteDeviceStore } from './device-store.js';
import type { RemoteExecutionJournal } from './execution-journal.js';
import { remoteStableUuid, UNFILED_WORKSPACE_ID } from './projection.js';

const CURSOR_TTL_MS = 5 * 60 * 1000;
const CANDIDATE_BUDGET = 100;
const SEARCH_TURN_BUDGET = 16;
const cursorSchema = z.strictObject({
  version: z.literal(1), scope: z.string(), request: z.string(), revision: z.string(),
  asOf: z.number().int().nonnegative(), expires: z.number().int().nonnegative(),
  after: z.string(), scanning: z.string().nullable(), before: z.number().int().positive().nullable(),
});
type Cursor = z.infer<typeof cursorSchema>;
type DirectoryDeps = {
  db: Db;
  sessions: SessionManager;
  devices: Pick<RemoteDeviceStore, 'get'>;
  executions: Pick<RemoteExecutionJournal, 'authorize' | 'scope'>;
  hostGeneration: string;
  now?: () => number;
  negotiated: (deviceId: string) => boolean;
};

/** A separate directory, not a broader legacy snapshot or replay stream. */
export class RemoteDirectory {
  private readonly secret = randomBytes(32);
  private epoch = 0;
  // The command context must survive await without one connection's opt-in
  // leaking into concurrent legacy commands or their file/translation calls.
  private readonly request = new AsyncLocalStorage<{ deviceId: string; enabled: boolean }>();

  constructor(private readonly deps: DirectoryDeps) {}

  get revision(): string { return `${this.deps.hostGeneration}:${this.epoch}`; }
  invalidate(): void { this.epoch += 1; }

  run<T>(deviceId: string, features: readonly string[], action: () => T): T {
    return this.request.run({ deviceId, enabled: features.includes('wire.session_directory_v1') }, action);
  }

  negotiated(deviceId: string): boolean {
    const request = this.request.getStore();
    return request?.deviceId === deviceId ? request.enabled : this.deps.negotiated(deviceId);
  }

  currentDevice(captured: RemoteDeviceRecord): RemoteDeviceRecord {
    const current = this.deps.devices.get(captured.id);
    if (!current || current.revokedAt !== null || captured.revokedAt !== null) {
      throw new RemoteProtocolError('DEVICE_REVOKED', 'device is no longer active');
    }
    if (current.publicKey !== captured.publicKey || current.accountId !== captured.accountId
      || current.revision !== captured.revision || current.cryptoConnectionId !== captured.cryptoConnectionId
      || current.role !== captured.role) {
      throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'device identity or pairing generation changed');
    }
    if (!current.grants.includes('session.read')) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'device read grant missing');
    }
    return current;
  }

  scope(device: RemoteDeviceRecord): string {
    return this.deps.executions.scope(device);
  }

  canAccess(sessionId: string, device: RemoteDeviceRecord): boolean {
    try { this.assertAccess(sessionId, device); return true; }
    catch (error) {
      if (error instanceof RemoteProtocolError && error.code === 'REMOTE_CAPABILITY_DENIED') return false;
      throw error;
    }
  }

  assertAccess(sessionId: string, captured: RemoteDeviceRecord): void {
    const device = this.currentDevice(captured);
    const row = this.deps.db.prepare(`SELECT s.archived, s.hidden, s.workspace_id,
      w.id AS workspace, w.hidden AS workspace_hidden, e.session_id AS export_session
      FROM sessions s LEFT JOIN workspaces w ON w.id = s.workspace_id
      LEFT JOIN remote_execution_exports e ON e.session_id = s.id WHERE s.id = ?`)
      .get(sessionId) as { archived: number; hidden: number; workspace_id: string | null;
        workspace: string | null; workspace_hidden: number | null; export_session: string | null } | undefined;
    if (!row || row.archived || row.hidden || (row.workspace_id !== null && (!row.workspace || row.workspace_hidden))) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'conversation is not available to this device');
    }
    if (row.export_session !== null) this.deps.executions.authorize(sessionId, device);
  }

  assertWorkspace(workspaceId: string): void {
    if (!this.deps.db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND hidden = 0').get(workspaceId)) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'workspace is not available');
    }
  }

  activity(sessionId: string): number | null {
    // MAX on normalized instants, not lexical mixed SQLite/ISO timestamps.
    // Views, session.updated_at and session.completed_at do not enter this query.
    const row = this.deps.db.prepare(`SELECT ROUND(MAX(instant)) AS activity FROM (
      SELECT (julianday(created_at) - 2440587.5) * 86400000 AS instant FROM events WHERE session_id = ?
      UNION ALL SELECT (julianday(created_at) - 2440587.5) * 86400000 FROM turns WHERE session_id = ?
      UNION ALL SELECT (julianday(completed_at) - 2440587.5) * 86400000 FROM turns WHERE session_id = ?
    )`).get(sessionId, sessionId, sessionId) as { activity: number | null };
    return row.activity !== null && Number.isSafeInteger(row.activity) && row.activity >= 0 ? row.activity : null;
  }

  list(captured: RemoteDeviceRecord, raw: unknown, features: readonly string[]): DirectoryListResult {
    if (!features.includes('wire.session_directory_v1')) {
      throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'session directory v1 was not negotiated');
    }
    const device = this.currentDevice(captured);
    const params = directoryListParamsSchema.parse(raw);
    const now = this.deps.now?.() ?? Date.now();
    const limit = params.limit ?? 30;
    const scope = createHash('sha256').update(JSON.stringify([
      this.deps.executions.scope(device), device.role, [...device.grants].sort(),
    ])).digest('hex');
    const request = JSON.stringify([params.view, params.query ?? null, limit, features.includes('wire.controller_source')]);
    const decoded = params.cursor ? this.decode(params.cursor) : null;
    if (params.cursor && (!decoded || decoded.expires <= now || decoded.scope !== scope
      || decoded.request !== request || decoded.revision !== this.revision)) {
      return { version: 1, view: params.view, as_of: now, revision: this.revision,
        state: 'cursor_invalid', entries: [], next_cursor: null };
    }
    const cursor: Cursor = decoded ?? { version: 1, scope, request, revision: this.revision,
      asOf: now, expires: now + CURSOR_TTL_MS, after: '', scanning: null, before: null };
    const waiting = new Set(this.deps.sessions.listPendingApprovals().map(record => record.sessionId));
    const entries: RemoteDirectoryEntry[] = [];
    const needle = params.query ? normalizeSearchText(params.query) : '';
    let examined = 0;
    let turnsLeft = SEARCH_TURN_BUDGET;
    let finished = false;
    while (entries.length < limit && examined < CANDIDATE_BUDGET) {
      const row = cursor.scanning ? { id: cursor.scanning } : this.deps.db.prepare(
        'SELECT id FROM sessions WHERE id > ? AND archived = 0 AND hidden = 0 ORDER BY id LIMIT 1',
      ).get(cursor.after) as { id: string } | undefined;
      if (!row) { finished = true; break; }
      examined += 1;
      if (!this.canAccess(row.id, device)) { this.advance(cursor, row.id); continue; }
      const session = this.deps.sessions.getSession(row.id);
      const entry = this.entry(session, waiting.has(row.id));
      if (params.view === 'tasks' && entry.task?.status !== 'open') { this.advance(cursor, row.id); continue; }
      if (params.view === 'repos' && !(entry.last_activity_at !== null
        && entry.last_activity_at >= cursor.asOf - DIRECTORY_RECENT_MS)
        && session.status !== 'running' && !this.deps.sessions.getActiveTurn(row.id) && !entry.waiting_for_user) {
        this.advance(cursor, row.id); continue;
      }
      if (params.view !== 'search') { entries.push(entry); this.advance(cursor, row.id); continue; }
      if (!cursor.scanning && normalizeSearchText([
        entry.name ?? '', entry.workspace.name, entry.task?.name ?? '',
      ].join('\n')).includes(needle)) {
        entries.push(entry); this.advance(cursor, row.id); continue;
      }
      cursor.scanning = row.id;
      while (turnsLeft > 0) {
        const page = this.deps.sessions.listEventPage(row.id, cursor.before, 1);
        turnsLeft -= 1;
        if (foldTurnMessages(page.events).some(message => normalizeSearchText(foldedSearchText(message)).includes(needle))) {
          entries.push(entry); this.advance(cursor, row.id); break;
        }
        if (!page.hasMore) { this.advance(cursor, row.id); break; }
        if (page.nextCursor === null || page.nextCursor === cursor.before) {
          throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'conversation history continuation did not advance');
        }
        cursor.before = page.nextCursor;
      }
      if (turnsLeft === 0) break;
    }
    // An exact page boundary still needs a truthful exhaustion probe.
    if (!finished && !cursor.scanning) finished = !this.deps.db.prepare(
      'SELECT 1 FROM sessions WHERE id > ? AND archived = 0 AND hidden = 0 LIMIT 1',
    ).get(cursor.after);
    return directoryListResultSchema.parse({ version: 1, view: params.view, as_of: cursor.asOf,
      revision: cursor.revision, entries, state: finished ? 'complete' : 'incomplete',
      next_cursor: finished ? null : this.encode(cursor) });
  }

  private entry(session: Session, waiting: boolean): RemoteDirectoryEntry {
    const workspace = session.workspace_id ? this.deps.db.prepare('SELECT id, name FROM workspaces WHERE id = ?')
      .get(session.workspace_id) as { id: string; name: string } : { id: UNFILED_WORKSPACE_ID, name: 'Unfiled' };
    const task = session.task_id ? this.deps.db.prepare('SELECT id, name, status FROM tasks WHERE id = ?')
      .get(session.task_id) as { id: string; name: string; status: 'open' | 'done' | 'archived' } | undefined : undefined;
    return {
      id: session.id, revision: this.deps.sessions.getResourceRevision(session.id),
      name: session.name === null ? null : safeName(session.name),
      workspace: { id: workspace.id, name: safeName(workspace.name) },
      task: task ? { ...task, name: safeName(task.name) } : null,
      agent: { id: remoteStableUuid('agent', session.agent_id ?? session.executor),
        name: safeName(session.agent_name ?? session.executor), proxy: safeName(session.executor) },
      status: session.status, unread: session.unread === 1, waiting_for_user: waiting,
      last_activity_at: this.activity(session.id), completed_at: session.completed_at ?? null,
    };
  }

  private advance(cursor: Cursor, sessionId: string): void {
    cursor.after = sessionId; cursor.scanning = null; cursor.before = null;
  }

  private encode(cursor: Cursor): string {
    const payload = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${payload}.${createHmac('sha256', this.secret).update(payload).digest('base64url')}`;
  }

  private decode(token: string): Cursor | null {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra !== undefined) return null;
    const expected = createHmac('sha256', this.secret).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    try {
      const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }
}

function safeName(value: string): string { return redactRemoteText(value).slice(0, 256) || ' '; }
