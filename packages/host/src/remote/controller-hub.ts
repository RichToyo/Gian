import {
  RemoteProtocolError, canonicalIdSchema, canonicalJson, catalogReadResultSchema, executionChangedSchema, executionSessionSchema,
  executionSyncResultSchema, generateCanonicalId, generateUuidV7, parseClosed,
  type AccountLoginStarted, type ExecutionSession, type CommandStatusResult,
  type RemoteInteraction, type RemoteMethod, type RemoteTranscriptItem,
  type ExecutionHistoryEntry, type ExecutionItemDetail, type ExecutionSyncResult,
  remoteAgentCatalogSchema,
  remoteExecutionTargetSchema,
  remoteFileRefSchema,
  commandStatusResultSchema,
  REMOTE_METHOD_RESULTS,
} from '@gian/remote-protocol';
import type {
  ApprovalResolvedData, ChatDisplay, ClientToServerMessage, CommandExecutionData, EventEnvelope, NoticeData, Session, RemoteSettingsSnapshot,
  RemoteEnvironmentStatus,
} from '@gian/shared';
import type { ComposerDocument, InputItem, MessageContextItem } from '@gian/shared';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { resolveDataDir } from '../storage/paths.js';
import { readBoundedFile, isLikelyBinary } from '../workspace/bounded-file.js';
import { assertLocalFilesBelongToSession } from '../session/input-items.js';
import { compileContextIntoInput, normalizeMessageContextItems, normalizeMessageComposerDocument } from '../session/context-items.js';
import { previewMimeForAttachment } from '../storage/attachments.js';
import { RemoteControllerContent, RemoteTransferSlots, TRANSFER_RETRY_DELAYS_MS, retryTransientTransfer } from './controller-content.js';
import { RemoteAttachmentCache, type CachedRemoteAttachment, type RemoteAttachmentKey } from './controller-attachment-cache.js';
import type { Db } from '../storage/db.js';
import { SessionRepository } from '../session/repository.js';
import { compactHistoryEnvelopes, SessionHistoryStore, type EventHistoryPage } from '../session/history-store.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import type { RemoteIdentityMaterial } from './identity.js';
import { RemoteExecutionBindings, type RemoteExecutionBinding } from './execution-bindings.js';
import { RemoteExecutionReplicas, localRemoteTurnId } from './execution-journal.js';
import { RemoteControllerClient, type RemoteConnectionHooks, type RemoteControllerEnvironment } from './controller-client.js';
import { HttpRemoteServerAuthClient } from './server-client.js';
import { REMOTE_DECISION_LABELS, remoteActionId, remoteStableUuid } from './projection.js';
import { recordInboxProjection } from '../inbox/projection-facts.js';
import { DEFAULT_TRANSLATION_PREFERENCES } from '@gian/shared';
import { loadConfig } from '../storage/config.js';
import type { TranslationService } from '../translation/service.js';
import { remoteTranslationOrigin, translatedRemoteInput } from '../translation/remote.js';

export interface RemoteSessionCreate {
  environment_id: string;
  workspace_id: string;
  agent_id: string;
  task_id?: string;
  name?: string;
  model?: string | null;
  thinking_effort?: string | null;
  service_tier?: 'fast' | null;
  approval_mode?: string | null;
  session_config?: Record<string, import('@gian/shared').ConfigValue>;
  turn_config?: Record<string, import('@gian/shared').ConfigValue>;
}

export interface RemoteSessionInput {
  send_id?: string;
  /** Local receipt only; never forwarded to the executing Host. */
  translation_id?: string;
  text: string;
  items?: InputItem[];
  context_items?: MessageContextItem[];
  composer_document?: ComposerDocument;
}

/** Per-session controller state. The reason selects honest copy; it never
 *  leaves this Mac. */
export interface RemoteSessionAvailability {
  status: 'ready' | 'offline' | 'auth_required' | 'unavailable' | 'history_reset';
  reason?: 'pairing' | 'server_identity' | 'host_key' | 'not_found' | 'denied' | 'unsupported' | 'removed';
}

/** The session's environment was removed in Settings › Remote: its history
 *  stays readable here, and nothing reaches its Host until Restore. */
export class RemoteEnvironmentRemovedError extends RemoteProtocolError {
  constructor() {
    super('REMOTE_CAPABILITY_DENIED', 'This environment was removed from Settings › Remote. Restore it there to continue this session.');
  }
}

/** Fork, Side Chat, worktree merge and drop need this Mac to run the
 *  session: a session running on another Gian refuses them plainly instead
 *  of failing somewhere inside. */
export class RemoteFeatureUnavailableError extends RemoteProtocolError {
  constructor(feature: string) {
    super('REMOTE_CAPABILITY_DENIED', `${feature} is not available for sessions running on another Gian.`);
  }
}

/** Session messages the local session manager handles for a remote session. */
const LOCAL_SESSION_MESSAGES = new Set(['session:rename', 'session:archive', 'session:pin', 'session:set_unread',
  'session:assign_task', 'session:delete']);

type EnvironmentRow = RemoteControllerEnvironment & { removed_at: number | null; last_seen_at: number | null };
/** A failed sync or connection attempt, as a session banner or Settings shows it. */
type RemoteFailure = NonNullable<RemoteEnvironmentStatus['last_error']>;

/** The Server presented a different identity than an environment pinned.
 *  Settings shows both fingerprints and only an explicit confirmation of
 *  `fingerprint` lets a re-pair replace the pin. */
export class RemoteServerIdentityChangedError extends RemoteProtocolError {
  constructor(readonly serverOrigin: string, readonly previousFingerprints: string[], readonly fingerprint: string) {
    super('AUTH_REQUIRED', 'Server identity changed; confirm the new identity to pair again');
  }
}

/** At most one history rebuild per session per window, so a Host that keeps
 *  restarting its stream is retried through the poller's backoff instead. */
const HISTORY_RESET_INTERVAL_MS = 60_000;

/** Background sync cadence (ms) after a successful pass. A Host whose
 *  connection negotiated wire.execution_hints_v1 announces its changes, so
 *  only a slow fallback poll remains (hints are lost across a reconnect);
 *  every other Host is polled as before. */
const POLL_MS = {
  hinted: { active: 10_000, idle: 60_000 },
  polled: { active: 1000, idle: 15_000 },
};
/** Background syncs in flight at once across all environments. */
const MAX_BACKGROUND_SYNCS = 4;

/** After a pairing or Restore the poller connects the environment without
 *  waiting for a session. A pairing the Host owner has not confirmed yet
 *  keeps the environment wanted for this long, so its connection retries
 *  (with its own backoff) and Pending clears once they do. */
const LINK_WINDOW_MS = 10 * 60_000;

/** This Mac's own Host connection to its Remote Server, as the hub follows
 *  it (see watchLocalRelay). */
export interface LocalServerRelay {
  /** The relay bound to the Server now; null while there is none. */
  current(): object | null;
  /** The Server this Mac is enrolled with as a Host. */
  origin(): string | null;
}

/** Inbox fact ids for one remote card, keyed by its turn-bound remote id. */
const REMOTE_INBOX_OPEN = 'gian:remote-interaction:';
const REMOTE_INBOX_CLOSE = 'gian:remote-interaction-closed:';

export class RemoteControllerHub {
  readonly bindings: RemoteExecutionBindings;
  readonly replicas: RemoteExecutionReplicas;
  private readonly repository: SessionRepository;
  private readonly clients = new Map<string, RemoteControllerClient>();
  private readonly syncing = new Map<string, Promise<void>>();
  /** Sessions hinted while their sync was running: exactly one more follows. */
  private readonly resync = new Set<string>();
  private readonly sending = new Map<string, { input: string; promise: Promise<void> }>();
  private readonly scheduled = new Map<string, { next: number; failures: number }>();
  private readonly availability = new Map<string, RemoteSessionAvailability>();
  private readonly historyResets = new Map<string, number>();
  /** Sessions whose replica was reset during the sync pass in flight. */
  private readonly rebuilding = new Set<string>();
  private readonly pendingLogin = new Map<string, { client: HttpRemoteServerAuthClient; started: AccountLoginStarted }>();
  /** Environments whose link dropped (null) or whose last connection attempt
   *  failed, since this Host started; cleared by a connection. */
  private readonly offline = new Map<string, RemoteFailure | null>();
  /** Connections owed after a pairing or Restore (see LINK_WINDOW_MS). */
  private readonly linkAttempts = new Map<string, { until: number; started: boolean }>();
  /** This Mac's own relay to its Server, and the bound one last seen. */
  private localRelay: { relay: LocalServerRelay; seen: object | null } | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private translations?: TranslationService;
  private onTurnCompleted?: (localId: string, turn: number) => void;
  /** Last broadcast remote:environments payload — dedups connectivity pushes. */
  private environmentsSignature: string | null = null;
  /** Remote cards this Mac answered, so their Inbox close counts as the user's. */
  private readonly answered = new Set<string>();
  private inboxDrain?: () => void;
  /** Per environment: downloads in flight never exceed its Host's limit. */
  private readonly transferSlots = new Map<string, RemoteTransferSlots>();
  private readonly transferRetryDelays: readonly number[] = TRANSFER_RETRY_DELAYS_MS;
  readonly attachmentCache: RemoteAttachmentCache;
  /** Attachment reads in flight, so concurrent requests share one download. */
  private readonly attachmentReads = new Map<string, Promise<CachedRemoteAttachment>>();

  /** The session Inbox adapter applies the facts projectInbox writes. */
  setInboxDrain(drain: () => void): void {
    this.inboxDrain = drain;
  }

  setTranslationService(service: TranslationService, onTurnCompleted: (localId: string, turn: number) => void): void {
    this.translations = service;
    this.onTurnCompleted = onTurnCompleted;
  }

  constructor(
    private readonly db: Db,
    private readonly broadcaster: WsBroadcaster,
    private readonly identity: RemoteIdentityMaterial,
    private readonly admit?: (origin: string) => Promise<import('./controller-client.js').RemoteControllerAdmission>,
    /** Gian's data directory (resolved on first use when omitted); remote
     *  attachments are kept in its remote-cache/attachments. */
    dataDir?: string,
  ) {
    this.bindings = new RemoteExecutionBindings(db);
    this.replicas = new RemoteExecutionReplicas(db);
    this.repository = new SessionRepository(db);
    let cacheDir: string | undefined;
    this.attachmentCache = new RemoteAttachmentCache(() => cacheDir ??= join(dataDir ?? resolveDataDir(), 'remote-cache', 'attachments'),
      (environmentId, localId) => this.db.prepare('SELECT 1 FROM sessions WHERE id = ? AND remote_environment_id = ?')
        .get(localId, environmentId) !== undefined);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.closed) return;
      this.followLocalRelay();
      for (const [id, attempt] of this.linkAttempts) if (!attempt.started) this.attemptLink(id);
      // A removed environment's sessions are history only: never polled.
      const rows = this.db.prepare(`SELECT b.local_session_id, s.remote_environment_id FROM remote_execution_bindings b
        JOIN sessions s ON s.id = b.local_session_id
        LEFT JOIN remote_controller_environments e ON e.id = s.remote_environment_id
        WHERE s.archived = 0 AND e.removed_at IS NULL`).all() as Array<{ local_session_id: string; remote_environment_id: string | null }>;
      for (const row of rows) {
        const id = row.local_session_id;
        if (this.syncing.size >= MAX_BACKGROUND_SYNCS) break;
        if (this.syncing.has(id) || (this.scheduled.get(id)?.next ?? 0) > Date.now()) continue;
        // Its environment's connection is backing off and reconnects on its
        // own, or its pairing was refused and waits for the user.
        const client = this.clients.get(row.remote_environment_id ?? '');
        if (client?.backingOff === true || client?.refused === true) continue;
        this.poll(id);
      }
    }, 1000);
    this.timer.unref();
  }

  /** Follow this Mac's own Host relay: each newly bound one shows its Server
   *  reachable again (serverReachable). Checked on every poller tick. */
  watchLocalRelay(relay: LocalServerRelay): void {
    this.localRelay = { relay, seen: null };
  }

  private followLocalRelay(): void {
    const watched = this.localRelay;
    const current = watched?.relay.current() ?? null;
    if (!watched || current === watched.seen) return;
    watched.seen = current;
    const origin = current ? watched.relay.origin() : null;
    if (origin) this.serverReachable(origin);
  }

  /**
   * The Remote Server at `origin` is reachable again: this Mac's own Host
   * relay to it just came back. Every environment on that Server that is
   * down but needed reconnects now, with its backoff started over, instead
   * of waiting out a backoff grown during the outage; an attempt already in
   * flight is joined, never doubled. A removed environment, or one waiting
   * out the Server's rate limit, is left alone.
   */
  serverReachable(origin: string): void {
    const server = originKey(origin);
    if (this.closed || !server) return;
    for (const [id, client] of this.clients) {
      if (originKey(client.environment.server_origin) === server && !this.removed(id)) client.reconnectNow();
    }
  }

  /** One background sync. Success schedules the next fallback poll. A
   *  failure while the environment's link is down waits for that link: its
   *  client retries with one backoff for all its sessions (and a reconnect
   *  syncs them). Any other failure backs off this session exponentially,
   *  or a full minute when rate limited. */
  private poll(id: string): void {
    void this.sync(id).then(() => {
      if (this.closed) return;
      this.scheduled.set(id, { failures: 0, next: Date.now() + this.pollInterval(id) });
    }).catch(error => {
      const environmentId = (this.db.prepare('SELECT remote_environment_id FROM sessions WHERE id = ?')
        .get(id) as { remote_environment_id: string | null } | undefined)?.remote_environment_id;
      const client = environmentId ? this.clients.get(environmentId) : undefined;
      if (client && !client.connected) {
        this.scheduled.set(id, { failures: 0, next: client.retryAt || Date.now() });
        return;
      }
      const failures = (this.scheduled.get(id)?.failures ?? 0) + 1;
      const delay = error instanceof RemoteProtocolError && error.code === 'RATE_LIMITED'
        ? 60_000 : Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
      this.scheduled.set(id, { failures, next: Date.now() + delay });
    });
  }

  private pollInterval(id: string): number {
    const row = this.db.prepare('SELECT remote_environment_id FROM sessions WHERE id = ?')
      .get(id) as { remote_environment_id: string | null } | undefined;
    const hinted = row?.remote_environment_id ? this.hinted(row.remote_environment_id) : false;
    const cadence = hinted ? POLL_MS.hinted : POLL_MS.polled;
    return this.replicas.snapshot(id)?.session.active_turn ? cadence.active : cadence.idle;
  }

  /** Whether this environment's live connection negotiated change hints. */
  private hinted(environmentId: string): boolean {
    return this.clients.get(environmentId)?.supports('wire.execution_hints_v1') === true;
  }

  /**
   * Sync one session now, for a change hint or a reconnect. A failure backoff
   * still holds it (the backoff poll catches up); a sync already running is
   * followed by exactly one more; past the concurrency bound it is only made
   * due, for the next poller tick.
   */
  private requestSync(id: string): void {
    if (this.closed) return;
    const scheduled = this.scheduled.get(id);
    if (scheduled?.failures && scheduled.next > Date.now()) return;
    if (this.syncing.has(id)) {
      this.resync.add(id);
      return;
    }
    if (this.syncing.size >= MAX_BACKGROUND_SYNCS) {
      this.scheduled.set(id, { failures: scheduled?.failures ?? 0, next: 0 });
      return;
    }
    this.poll(id);
  }

  /** A change hint from an environment's Host. Hints arrive only on a
   *  connection that negotiated them, and one for a session this Mac has not
   *  bound (or archived) is ignored. */
  private receiveHint(client: RemoteControllerClient, environmentId: string, message: Record<string, unknown>): void {
    if (message.type !== 'execution.changed' || this.closed || this.clients.get(environmentId) !== client
      || !client.supports('wire.execution_hints_v1')) return;
    const hint = executionChangedSchema.safeParse(message);
    if (!hint.success) return;
    const row = this.db.prepare(`SELECT b.local_session_id FROM remote_execution_bindings b
      JOIN sessions s ON s.id = b.local_session_id
      WHERE s.remote_environment_id = ? AND s.archived = 0 AND b.host_id = ? AND b.remote_session_id = ?`)
      .get(environmentId, client.environment.host_id, hint.data.session_id) as { local_session_id: string } | undefined;
    if (row) this.requestSync(row.local_session_id);
  }

  /**
   * Connectivity of one environment flipped. Without live hints the poller
   * falls back to the plain cadence (which also reconnects); a connection
   * that negotiated hints syncs every bound session once, since hints sent
   * while it was down are lost. A pass already running sends its request on
   * this new connection, so it counts as that sync.
   */
  private connectionChanged(environmentId: string, connected: boolean): void {
    if (!this.closed) {
      this.markSeen(environmentId);
      if (connected) {
        this.offline.delete(environmentId);
        this.linkAttempts.delete(environmentId);
      } else this.offline.set(environmentId, null);
    }
    this.broadcastEnvironments();
    if (this.closed) return;
    const ids = (this.db.prepare(`SELECT b.local_session_id FROM remote_execution_bindings b
      JOIN sessions s ON s.id = b.local_session_id WHERE s.remote_environment_id = ? AND s.archived = 0`)
      .all(environmentId) as Array<{ local_session_id: string }>).map(row => row.local_session_id);
    if (!connected) {
      for (const id of ids) {
        const scheduled = this.scheduled.get(id);
        if (scheduled && !scheduled.failures) scheduled.next = Math.min(scheduled.next, Date.now() + this.pollInterval(id));
      }
      return;
    }
    if (!this.hinted(environmentId)) return;
    queueMicrotask(() => {
      for (const id of ids) if (!this.syncing.has(id)) this.requestSync(id);
    });
  }

  close(): void {
    if (!this.closed) for (const [id, client] of this.clients) if (client.connected) this.markSeen(id);
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.resync.clear();
    this.linkAttempts.clear();
    for (const client of this.clients.values()) client.close();
    this.clients.clear(); this.pendingLogin.clear();
  }

  owns(sessionId: string): boolean {
    // Local resources (including sc_<uuid> Side Chats) are not Remote IDs.
    // Binding reads still validate stored targets and must not hide corruption.
    return canonicalIdSchema.safeParse(sessionId).success && this.bindings.get(sessionId) !== null;
  }

  /** Refuse a feature that needs this Mac to run the session. */
  refuseIfMirrored(sessionId: string, feature: string): void {
    if (this.owns(sessionId)) throw new RemoteFeatureUnavailableError(feature);
  }

  /** `reconnecting`: the link dropped moments ago and is being restored
   *  (the composer stays usable; a send waits for it). It never hides a
   *  pairing, identity or availability problem. */
  status(sessionId: string): {
    status: RemoteSessionAvailability['status'] | 'connecting' | 'reconnecting'; reason?: RemoteSessionAvailability['reason'];
  } {
    const session = this.repository.get(sessionId);
    const environment = session.remote_execution?.environment_id;
    if (environment && this.removed(environment)) return { status: 'unavailable', reason: 'removed' };
    const client = this.clients.get(environment ?? '');
    const current = this.availability.get(sessionId);
    // Why the environment's last connection attempt failed, while it is down.
    const problem = client?.connected ? undefined : this.offline.get(environment ?? '');
    // A refused pairing outlasts whatever this session's last sync met.
    if (client?.refused === true && problem) return problem;
    if (client?.reconnecting === true && (!current || current.status === 'ready' || current.status === 'offline')
      && (!problem || problem.status === 'offline')) return { status: 'reconnecting' };
    if (!current) return { status: 'connecting' };
    if (current.status !== 'ready' || client?.connected) return current;
    return problem && problem.status !== 'offline' ? problem : { status: 'offline' };
  }

  /** Every environment, removed ones included (Settings lists them under
   *  Removed; pickers leave them out), with its status from real state. */
  listEnvironments(): RemoteEnvironmentStatus[] {
    const rows = this.db.prepare(`SELECT e.*, EXISTS (SELECT 1 FROM sessions s
        JOIN remote_execution_bindings b ON b.local_session_id = s.id
        WHERE s.remote_environment_id = e.id AND s.archived = 0) AS active
      FROM remote_controller_environments e ORDER BY e.created_at`).all() as Array<EnvironmentRow & { active: number }>;
    return rows.map(environment => {
      const id = environment.id;
      const client = environment.removed_at === null ? this.clients.get(id) : undefined;
      const connected = client?.connected === true;
      const problem = connected ? undefined : this.offline.get(id);
      // A link that just dropped and is being restored reads Reconnecting
      // unless the Host refused this Mac; one that merely dropped reads
      // Offline only while sessions need it.
      const reconnecting = client?.reconnecting === true && (!problem || problem.status === 'offline');
      const status = environment.removed_at !== null ? 'removed' : connected ? 'connected'
        : environment.pairing_id !== null ? 'pending' : reconnecting ? 'reconnecting'
          : problem || (problem === null && environment.active) ? 'offline'
            : environment.active || this.linkAttempts.has(id) ? 'connecting' : 'idle';
      return { id, name: environment.name, host_id: environment.host_id,
        server_origin: environment.server_origin, pending: environment.pairing_id !== null, connected, status,
        removed_at: environment.removed_at, last_seen_at: environment.last_seen_at,
        ...(problem && status !== 'removed' ? { last_error: problem } : {}) };
    });
  }

  /** Push the full environment snapshot to web clients when anything flipped
   *  (per-environment `connected` or the list itself). Clean disconnects are
   *  real-time via the client callback; unclean remote death surfaces through
   *  the sync failure paths below (presence lease, up to ~30s). */
  broadcastEnvironments(): void {
    if (this.closed) return;
    const environments = this.listEnvironments();
    const signature = canonicalJson(environments);
    if (signature === this.environmentsSignature) return;
    this.environmentsSignature = signature;
    this.broadcaster.broadcast({ type: 'remote:environments', environments });
  }

  async startLogin(origin: string): Promise<RemoteSettingsSnapshot['account']> {
    const url = new URL(origin);
    if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('invalid_url');
    const client = new HttpRemoteServerAuthClient(origin, this.identity);
    const saved = await client.existingAccount('controller');
    if (saved) {
      this.pendingLogin.delete(origin);
      return { status: 'authorized', server_url: origin, login: saved.accountLogin, expires_at: saved.expiresAt };
    }
    const started = await client.startAccountLogin('controller');
    this.pendingLogin.set(origin, { client, started });
    return { status: 'pending', server_url: origin, user_code: started.user_code,
      verification_uri: started.verification_uri, expires_at: started.expires_at, interval_seconds: started.interval_seconds };
  }

  async pollLogin(origin: string): Promise<RemoteSettingsSnapshot['account']> {
    const pending = this.pendingLogin.get(origin);
    if (!pending) throw new Error('authorization_not_started');
    const result = await pending.client.pollAccountLogin(pending.started);
    if (result.status !== 'pending') this.pendingLogin.delete(origin);
    return { status: result.status, server_url: origin,
      expires_at: result.status === 'authorized' ? result.expires_at : pending.started.expires_at,
      ...(result.status === 'authorized' ? { login: result.account.login } : {}),
      ...(result.status === 'pending' ? { user_code: pending.started.user_code,
        verification_uri: pending.started.verification_uri, interval_seconds: result.interval_seconds } : {}) };
  }

  /** Pair (or re-pair) another Gian. A Server identity that differs from the
   *  one an existing environment pinned is never accepted implicitly: the
   *  caller must echo the exact new fingerprint the user confirmed. Pairing
   *  the Server and Host of a removed environment restores that environment
   *  (same id, same sessions) instead of adding a second one. */
  async pair(input: { origin: string; code: string; name: string; confirm_server_identity?: string }) {
    if (!this.admit) throw new RemoteProtocolError('CONTROLLER_NOT_ADMITTED', 'local Server admission required');
    const admission = await this.admit(input.origin);
    // Ask before the one-time code is spent, so declining keeps it usable.
    const pinned = (this.db.prepare(`SELECT DISTINCT server_identity_fingerprint AS fingerprint
      FROM remote_controller_environments WHERE server_origin = ? AND server_identity_fingerprint != ? ORDER BY fingerprint`)
      .all(input.origin, admission.serverIdentityFingerprint) as Array<{ fingerprint: string }>).map(row => row.fingerprint);
    if (pinned.length && input.confirm_server_identity !== admission.serverIdentityFingerprint) {
      throw new RemoteServerIdentityChangedError(input.origin, pinned, admission.serverIdentityFingerprint);
    }
    const environment = await RemoteControllerClient.pair({ origin: input.origin, code: input.code, name: input.name },
      this.identity, admission);
    const old = this.db.prepare('SELECT * FROM remote_controller_environments WHERE server_origin = ? AND host_id = ?')
      .get(environment.server_origin, environment.host_id) as RemoteControllerEnvironment | undefined;
    const identityChanged = old !== undefined && old.server_identity_fingerprint !== environment.server_identity_fingerprint;
    if (identityChanged && input.confirm_server_identity !== environment.server_identity_fingerprint) {
      throw new RemoteServerIdentityChangedError(input.origin, [old.server_identity_fingerprint], environment.server_identity_fingerprint);
    }
    if (old) {
      environment.id = old.id;
      // The Host key stays pinned across re-pairs, so end-to-end authenticity
      // with that Host never depends on the Server identity.
      environment.host_public_key_json = old.host_public_key_json;
      this.clients.get(old.id)?.close(); this.clients.delete(old.id);
    }
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO remote_controller_environments
        (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, device_id,
          device_public_key_json, crypto_connection_id, host_public_key_json, pairing_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
          name = excluded.name, server_identity_fingerprint = excluded.server_identity_fingerprint,
          browser_id = excluded.browser_id, device_id = excluded.device_id,
          device_public_key_json = excluded.device_public_key_json,
          crypto_connection_id = excluded.crypto_connection_id, host_public_key_json = excluded.host_public_key_json,
          pairing_id = excluded.pairing_id, removed_at = NULL`)
        .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
          environment.host_id, environment.browser_id, environment.device_id, environment.device_public_key_json ?? null,
          environment.crypto_connection_id, environment.host_public_key_json, environment.pairing_id, environment.created_at);
      if (identityChanged) {
        this.bindings.rebaseServerIdentity({ environment_id: old.id, server_origin: old.server_origin, host_id: old.host_id,
          from: old.server_identity_fingerprint, to: environment.server_identity_fingerprint });
      }
    })();
    this.offline.delete(environment.id);
    this.link(environment.id);
    this.broadcastEnvironments();
    return this.listEnvironments().find(item => item.id === environment.id)!;
  }

  /**
   * Remove an environment from this Mac. The row stays (its sessions and
   * create requests reference it) with removed_at set: its client closes for
   * good, polling and hint syncs stop, pickers leave it out, and its sessions
   * stay as read-only history the user can still delete one by one. Nothing
   * is revoked on the Server or the Host: the Server refuses a second
   * pairing of this Mac's key with that Host, so Restore is the way back.
   * False when no such environment exists.
   */
  removeEnvironment(environmentId: string): boolean {
    const found = this.db.prepare('UPDATE remote_controller_environments SET removed_at = COALESCE(removed_at, ?) WHERE id = ?')
      .run(Date.now(), environmentId).changes > 0;
    if (!found) return false;
    this.clients.get(environmentId)?.retire();
    this.clients.delete(environmentId);
    this.linkAttempts.delete(environmentId);
    this.offline.delete(environmentId);
    for (const { id } of this.db.prepare('SELECT id FROM sessions WHERE remote_environment_id = ?').all(environmentId) as Array<{ id: string }>) {
      this.scheduled.delete(id);
      this.resync.delete(id);
      this.availability.delete(id);
    }
    this.broadcastEnvironments();
    return true;
  }

  /** Undo a removal: the environment is offered and connected again, and its
   *  sessions resume syncing on the next poll. False when it does not exist. */
  restoreEnvironment(environmentId: string): boolean {
    const row = this.db.prepare('SELECT removed_at FROM remote_controller_environments WHERE id = ?')
      .get(environmentId) as { removed_at: number | null } | undefined;
    if (!row) return false;
    if (row.removed_at !== null) {
      this.db.prepare('UPDATE remote_controller_environments SET removed_at = NULL WHERE id = ?').run(environmentId);
      this.offline.delete(environmentId);
      this.link(environmentId);
    }
    this.broadcastEnvironments();
    return true;
  }

  /** Owe one environment a connection; the poller makes it (start()). */
  private link(environmentId: string): void {
    if (this.closed) return;
    this.linkAttempts.set(environmentId, { until: Date.now() + LINK_WINDOW_MS, started: false });
  }

  /** Start an owed connection. Its retries are the environment's own (see
   *  wantsConnection and connectionFailed). */
  private attemptLink(environmentId: string): void {
    const attempt = this.linkAttempts.get(environmentId);
    if (!attempt || attempt.started || this.closed) return;
    let client: RemoteControllerClient;
    try { client = this.client(environmentId); } catch {
      this.linkAttempts.delete(environmentId);
      return;
    }
    attempt.started = true;
    void client.connect().catch(() => undefined);
  }

  /** Whether anything needs this environment connected: a bound, unarchived
   *  session or an owed link. Its client reconnects and probes only then. */
  private wantsConnection(environmentId: string): boolean {
    if (this.closed) return false;
    if (this.linkAttempts.has(environmentId)) return true;
    return this.db.prepare(`SELECT 1 FROM remote_execution_bindings b JOIN sessions s ON s.id = b.local_session_id
      WHERE s.remote_environment_id = ? AND s.archived = 0 LIMIT 1`).get(environmentId) !== undefined;
  }

  /** One of this environment's connection attempts failed, whoever started
   *  it: Settings shows why. A pairing the Host has not confirmed yet stays
   *  owed until it is, the window ends or the environment is removed; any
   *  other owed link was tried once and shows the outcome. */
  private connectionFailed(environmentId: string, error: unknown): void {
    if (this.closed) return;
    this.offline.set(environmentId, remoteSessionAvailability(error));
    const attempt = this.linkAttempts.get(environmentId);
    if (attempt) {
      const pending = (this.db.prepare('SELECT pairing_id FROM remote_controller_environments WHERE id = ?')
        .get(environmentId) as { pairing_id: string | null } | undefined)?.pairing_id;
      if (!pending || Date.now() >= attempt.until) this.linkAttempts.delete(environmentId);
    }
    this.broadcastEnvironments();
  }

  private removed(environmentId: string): boolean {
    const row = this.db.prepare('SELECT removed_at FROM remote_controller_environments WHERE id = ?')
      .get(environmentId) as { removed_at: number | null } | undefined;
    return row?.removed_at != null;
  }

  /** Commands for a removed environment's sessions stop here. */
  private assertEnvironmentActive(localId: string): void {
    const row = this.db.prepare('SELECT remote_environment_id FROM sessions WHERE id = ?')
      .get(localId) as { remote_environment_id: string | null } | undefined;
    if (row?.remote_environment_id && this.removed(row.remote_environment_id)) throw new RemoteEnvironmentRemovedError();
  }

  private markSeen(environmentId: string): void {
    this.db.prepare('UPDATE remote_controller_environments SET last_seen_at = ? WHERE id = ?').run(Date.now(), environmentId);
  }

  private deviceTarget(environment: RemoteControllerEnvironment, remoteSessionId: string) {
    if (!environment.device_id || !environment.device_public_key_json || !environment.crypto_connection_id) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'paired device evidence required');
    }
    return parseClosed(remoteExecutionTargetSchema, {
      target_version: 2,
      server_origin: environment.server_origin,
      server_identity_fingerprint: environment.server_identity_fingerprint,
      host_id: environment.host_id,
      remote_session_id: remoteSessionId,
      device_id: environment.device_id,
      device_public_key: JSON.parse(environment.device_public_key_json),
      crypto_connection_id: environment.crypto_connection_id,
    });
  }

  private async requireDeviceExecution(client: RemoteControllerClient): Promise<void> {
    await client.connect({ user: true });
    if (!client.supports('wire.device_execution_target')) {
      throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'execution Host did not negotiate device targets');
    }
  }

  /** The binding this controller may use now. A re-pair of the same device
   *  key to the same Server and Host re-attaches it to the new pairing
   *  generation; any other change of device needs the user. A user's
   *  operation (`user`) may cut a reconnect backoff short or wait for it. */
  private async requireExecutionOwner(localId: string, user = false): Promise<RemoteExecutionBinding> {
    const binding = this.bindings.get(localId);
    if (!binding) throw new RemoteProtocolError('AUTH_REQUIRED', 'execution binding unavailable');
    this.assertEnvironmentActive(localId);
    const client = this.client(this.repository.get(localId).remote_execution!.environment_id);
    const environment = client.environment;
    await client.connect(user ? { user: true } : undefined);
    if (this.closed) throw new RemoteProtocolError('HOST_OFFLINE', 'controller is closed');
    const target = binding.target;
    const sameRemote = environment.server_origin === target.server_origin
      && environment.server_identity_fingerprint === target.server_identity_fingerprint
      && environment.host_id === target.host_id && environment.device_id && environment.device_public_key_json
      && environment.crypto_connection_id;
    const legacyDeviceEvidence = !('target_version' in target) && sameRemote && (this.db.prepare(
      'SELECT COUNT(*) AS count FROM remote_execution_send_requests WHERE local_session_id = ? AND browser_id != ?',
    ).get(localId, environment.browser_id) as { count: number }).count === 0;
    const sameDeviceKey = 'target_version' in target && sameRemote
      && canonicalJson(JSON.parse(environment.device_public_key_json!)) === canonicalJson(target.device_public_key);
    if (client.supports('wire.device_execution_target')) {
      if (legacyDeviceEvidence) return binding;
      if (sameDeviceKey) {
        return environment.device_id === target.device_id && environment.crypto_connection_id === target.crypto_connection_id
          ? binding : this.bindings.reattachDevice(localId, binding.revision, this.deviceTarget(environment, target.remote_session_id));
      }
    } else if (sameDeviceKey) {
      throw new RemoteProtocolError('PROTOCOL_VERSION_UNSUPPORTED', 'execution Host did not negotiate device targets');
    }
    if ('target_version' in target) throw new RemoteProtocolError('AUTH_REQUIRED', 'paired execution device changed');
    const account = await this.identity.getAccountSession?.(target.server_origin, 'controller');
    if (this.closed || account?.accountId !== target.account_id || account.expiresAt <= Date.now()) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'original execution account or proven paired device required');
    }
    return binding;
  }

  /** The client for an operation the user is waiting on, connected. */
  private async userClient(environmentId: string): Promise<RemoteControllerClient> {
    const client = this.client(environmentId);
    await client.connect({ user: true });
    return client;
  }

  async catalog(environmentId: string) {
    return parseClosed(catalogReadResultSchema, await (await this.userClient(environmentId)).request('catalog.read', {}));
  }

  async listExecutions(environmentId: string, after?: string): Promise<{ sessions: ExecutionSession[]; has_more: boolean }> {
    return await (await this.userClient(environmentId)).request('execution.list', { ...(after ? { after } : {}) }) as { sessions: ExecutionSession[]; has_more: boolean };
  }

  async agentCatalog(environmentId: string, agentId: string, input?: {
    catalogRevision: string; sessionConfig: Record<string, import('@gian/shared').ConfigValue>;
    turnConfig: Record<string, import('@gian/shared').ConfigValue>;
  }) {
    return parseClosed(remoteAgentCatalogSchema, await (await this.userClient(environmentId)).request('catalog.agent', {
      agent_id: agentId, ...(input ? { catalog_revision: input.catalogRevision,
        session_config: input.sessionConfig, turn_config: input.turnConfig } : {}),
    }));
  }

  async create(input: RemoteSessionCreate, requestId: string): Promise<Session> {
    if (input.task_id && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'open'").get(input.task_id)) throw new Error('local Task is not open');
    const client = this.client(input.environment_id);
    await this.requireDeviceExecution(client);
    const catalog = await this.catalog(input.environment_id);
    const repo = catalog.workspaces.find(item => item.id === input.workspace_id);
    const agentId = input.agent_id.startsWith(`remote:${input.environment_id}:`)
      ? input.agent_id.slice(`remote:${input.environment_id}:`.length) : input.agent_id;
    const agent = catalog.agents.find(item => item.id === agentId);
    if (!repo || !agent || agent.readiness !== 'ready') throw new Error('remote repository or Agent unavailable');
    const serialized = canonicalJson(input);
    const existing = this.db.prepare('SELECT * FROM remote_execution_create_requests WHERE request_id = ?')
      .get(requestId) as { command_id: string; input_json: string; result_json: string | null;
        params_json: string | null; browser_id: string; repository_name: string } | undefined;
    if (existing && existing.input_json !== serialized) throw new Error('creation request changed');
    if (existing && !existing.result_json && existing.browser_id !== client.environment.browser_id) {
      throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'pairing changed; recover the existing remote execution before retrying');
    }
    const commandId = existing?.command_id ?? generateUuidV7();
    if (!existing) this.db.prepare(`INSERT INTO remote_execution_create_requests
      (request_id, environment_id, command_id, input_json, browser_id, repository_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, input.environment_id, commandId, serialized, client.environment.browser_id, repo.name, Date.now());
    const remote = existing?.result_json ? parseClosed(executionSessionSchema, JSON.parse(existing.result_json))
      : parseClosed(executionSessionSchema, await client.request('execution.create', this.freezeCreateParams(requestId, {
        catalog_revision: catalog.catalog_revision, workspace_id: repo.id, agent_id: agent.id,
        ...(input.name ? { name: input.name } : {}), ...(input.model ? { model: input.model } : {}),
        ...(input.thinking_effort ? { thinking: input.thinking_effort } : {}),
        ...(input.service_tier ? { service_tier: input.service_tier } : {}),
        ...(input.approval_mode ? { approval_mode: input.approval_mode } : {}),
        ...(input.session_config ? { session_config: input.session_config } : {}),
        ...(input.turn_config ? { turn_config: input.turn_config } : {}),
      }), commandId));
    this.db.prepare('UPDATE remote_execution_create_requests SET result_json = ? WHERE request_id = ?').run(JSON.stringify(remote), requestId);
    return this.importSession(input.environment_id, remote, repo.name, input.task_id);
  }

  private freezeCreateParams(requestId: string, params: Record<string, unknown>): Record<string, unknown> {
    this.db.prepare('UPDATE remote_execution_create_requests SET params_json = COALESCE(params_json, ?) WHERE request_id = ?')
      .run(canonicalJson(params), requestId);
    const row = this.db.prepare('SELECT params_json FROM remote_execution_create_requests WHERE request_id = ?')
      .get(requestId) as { params_json: string };
    return JSON.parse(row.params_json) as Record<string, unknown>;
  }

  async takeOver(environmentId: string, remoteSessionId: string, taskId?: string): Promise<Session> {
    const snapshot = parseClosed(executionSyncResultSchema,
      await (await this.userClient(environmentId)).request('execution.sync', { session_id: remoteSessionId, after: 0 }));
    const catalog = await this.catalog(environmentId);
    const repoName = catalog.workspaces.find(item => item.id === snapshot.session.workspace_id)?.name ?? '';
    return this.importSession(environmentId, snapshot.session, repoName, taskId);
  }

  private async importSession(environmentId: string, remote: ExecutionSession, repositoryName: string, taskId?: string): Promise<Session> {
    const client = this.client(environmentId);
    await this.requireDeviceExecution(client);
    const target = this.deviceTarget(client.environment, remote.id);
    let bound = this.bindings.find(target) ?? this.bindings.findRemoteSession(target);
    if (!bound) {
      if (taskId && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ? AND status = 'open'").get(taskId)) throw new Error('local Task is not open');
      const localId = generateCanonicalId();
      bound = this.db.transaction(() => {
        this.db.prepare(`INSERT INTO sessions
          (id, name, type, task_id, workspace_id, executor, native_session_id, agent_id, agent_name,
            proxy_plugin_id, remote_environment_id, remote_repository_id, remote_repository_name)
          VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(localId, remote.name, taskId ? 'subtask' : 'coding', taskId ?? null, remote.agent.proxy,
            generateCanonicalId(), `remote:${environmentId}:${remote.agent.id}`, remote.agent.name, remote.agent.proxy,
            environmentId, remote.workspace_id, repositoryName);
        return this.bindings.bind({ local_session_id: localId, target });
      })();
    }
    await this.sync(bound.local_session_id);
    return this.repository.get(bound.local_session_id);
  }

  sync(localSessionId: string): Promise<void> {
    const current = this.syncing.get(localSessionId);
    if (current) return current;
    const environment = this.db.prepare(`SELECT e.id, e.removed_at FROM sessions s
      JOIN remote_controller_environments e ON e.id = s.remote_environment_id WHERE s.id = ?`)
      .get(localSessionId) as { id: string; removed_at: number | null } | undefined;
    // A removed environment's sessions are read-only history: opening one
    // reads the saved replica and never reaches the Host.
    if (environment?.removed_at != null) return Promise.resolve();
    const run = this.syncOnce(localSessionId).then(() => {
      this.availability.set(localSessionId, { status: 'ready' });
      this.broadcastEnvironments();
    }).catch(error => {
      const failure = remoteSessionAvailability(error);
      this.availability.set(localSessionId, failure);
      // Failing without a live link is the environment's state too (Settings).
      if (environment && !this.closed && !this.clients.get(environment.id)?.connected) this.offline.set(environment.id, failure);
      this.broadcastEnvironments();
      throw error;
    }).finally(() => {
      this.syncing.delete(localSessionId);
      // Reload an open transcript after a reset, even if the rebuild stopped part-way.
      if (this.rebuilding.delete(localSessionId) && !this.closed) {
        this.broadcaster.broadcast({ type: 'session:history-rebuilt', session_id: localSessionId });
      }
      // A hint that arrived during this pass may postdate what it fetched. The
      // follow-up waits for the pass's own scheduling, so its backoff applies.
      if (this.resync.delete(localSessionId) && !this.closed) setTimeout(() => this.requestSync(localSessionId), 0);
    });
    this.syncing.set(localSessionId, run);
    return run;
  }

  private async syncOnce(localId: string): Promise<void> {
    if (this.closed) return;
    if (!this.bindings.get(localId)) return;
    const session = this.repository.get(localId);
    const client = this.client(session.remote_execution!.environment_id);
    const binding = await this.requireExecutionOwner(localId);
    // Every card listed pending during this pass, including the last saved
    // list, so one the Host dropped can be settled once history caught up.
    const listed = new Map((this.replicas.snapshot(localId)?.interactions ?? []).map(item => [item.id, item]));
    for (let page = 0; page < 16; page += 1) {
      const rebuilding = this.rebuilding.has(localId);
      const previous = this.replicas.snapshot(localId);
      let next: ExecutionSyncResult;
      try {
        const data = await client.request('execution.sync', { session_id: binding.target.remote_session_id,
          after: previous?.cursor ?? 0, ...(previous ? { stream_id: previous.stream_id } : {}) });
        if (this.closed) return;
        next = this.replicas.apply(binding, data);
      } catch (error) {
        // The Host restarted this history (e.g. a restored database). Rebuild
        // the replica from 0 once; a second request in the same pass fails.
        if (!(error instanceof RemoteProtocolError) || error.code !== 'SNAPSHOT_REQUIRED' || !previous || rebuilding) throw error;
        this.resetHistory(localId);
        continue;
      }
      await this.reconcileTranslationReceipts(localId, client, binding.revision);
      this.linkToolDeliveries(localId);
      const remote = next.session;
      this.db.prepare('UPDATE sessions SET remote_worktree_root = ? WHERE id = ?').run(remote.worktree_root, localId);
      this.db.prepare('UPDATE sessions SET executor_config_json = ?, turn_config_json = ?, turn_config_options_json = ? WHERE id = ?')
        .run(JSON.stringify({ schemaVersion: 1, values: remote.session_config }), JSON.stringify(remote.turn_config),
          remote.turn_config_options ? JSON.stringify(remote.turn_config_options) : null, localId);
      this.db.prepare(`UPDATE sessions SET status = ?, model = ?, thinking_effort = ?, service_tier = ?, approval_mode = ?,
        context_tokens_used = ?, context_window_tokens = ?, context_usage_updated_at = ?,
        conversation_input_tokens = ?, conversation_output_tokens = ?, conversation_cached_input_tokens = ?,
        conversation_total_tokens = ?, conversation_usage_complete = ?, updated_at = ?, name = COALESCE(name, ?)
        WHERE id = ?`)
        .run(remote.status, remote.model ?? null, remote.thinking ?? null, remote.service_tier ?? null, remote.approval_mode ?? null,
          remote.context_tokens_used, remote.context_window_tokens, remote.context_usage_updated_at,
          remote.conversation_input_tokens, remote.conversation_output_tokens, remote.conversation_cached_input_tokens,
          remote.conversation_total_tokens, remote.conversation_usage_complete ? 1 : 0, remote.updated_at, remote.name, localId);
      for (const event of next.events) {
        // A rebuilt transcript reloads once below instead of streaming old turns.
        if (rebuilding || event.sequence <= (previous?.cursor ?? 0)) continue;
        this.broadcaster.broadcast({ type: 'event', ...this.historyEvent(localId, event) });
        if (previous && 'item' in event && event.item.kind === 'turn-end' && event.item.outcome === 'worked'
          && this.translations?.shouldReadRemoteEvent(localId, event.sequence)) {
          this.onTurnCompleted?.(localId, event.item.turn);
        }
      }
      for (const interaction of next.interactions) {
        listed.set(interaction.id, interaction);
        if (previous?.interactions.some(item => item.id === interaction.id && item.revision === interaction.revision)) continue;
        this.broadcaster.broadcast({ type: 'event', ...remoteInteractionEvent(localId, interaction, this.interactionTurn(localId, interaction, remote)) });
      }
      if (!previous || canonicalJson(previous.session) !== canonicalJson(remote) || next.events.length) {
        this.broadcaster.broadcast({ type: 'session:updated', session: this.repository.get(localId) });
        this.broadcaster.broadcast({ type: 'queue:updated', session_id: localId,
          queue_revision: remote.queue.revision, queue: this.queue(localId) });
      }
      if (!next.has_more) {
        this.closeVanished(localId, listed, next);
        this.projectInbox(localId, next);
        break;
      }
    }
  }

  /**
   * A card the Host listed as pending is gone from its list, and its history
   * carries no close: an older Host released it, or it was answered where
   * only that Host could see it. Only after this pass caught up with every
   * history page (so a close on a later page counts), settle the open card
   * neutral once; the next pass no longer lists it. historyEvents derives the
   * same close, so a reload never brings the card back. A card still listed
   * pending is never closed.
   */
  private closeVanished(localId: string, listed: Map<string, RemoteInteraction>, current: ExecutionSyncResult): void {
    const pending = new Set(current.interactions.map(item => item.id));
    for (const [id, interaction] of listed) {
      if (pending.has(id) || this.replicaResolution(localId, id) !== null) continue;
      // A rebuilt transcript reloads and derives the close itself.
      if (this.rebuilding.has(localId)) continue;
      this.broadcaster.broadcast({ type: 'event', ...remoteInteractionClosedEvent(localId, interaction,
        this.interactionTurn(localId, interaction, current.session), Date.now()) });
    }
  }

  /**
   * Inbox rows and OS notifications for the Host's pending cards, through the
   * durable facts local cards use: the session Inbox adapter applies them and
   * publishes one notification for a fresh row. Runs once a pass has caught
   * up, and converges: each listed card has one open occurrence keyed by its
   * remote id, so repeated syncs, restarts and history rebuilds reuse it, and
   * each open occurrence the Host no longer lists closes, with the Host's
   * decision when its history carries one and as cancelled otherwise.
   */
  private projectInbox(localId: string, current: ExecutionSyncResult): void {
    const stored = this.db.prepare(`SELECT 1 FROM inbox_projection_facts
      WHERE session_id = ? AND source = 'native' AND writer = 'host' AND provider_event_id = ?`);
    const listed = new Set(current.interactions.map(item => item.id));
    let changed = false;
    for (const interaction of current.interactions) {
      const eventId = REMOTE_INBOX_OPEN + interaction.id;
      if (stored.get(localId, eventId) || this.replicaResolution(localId, interaction.id)) continue;
      const turn = this.interactionTurn(localId, interaction, current.session);
      const p = interaction.presentation;
      recordInboxProjection(this.db, { sessionId: localId, providerEventId: eventId, turnId: localRemoteTurnId(localId, turn),
        turnNumber: turn, origin: 'live', source: 'native', writer: 'host', method: 'interaction.requested',
        raw: { interactionId: localInteractionId(localId, interaction.id) },
        displayType: isRemoteQuestion(interaction) ? 'interaction.question' : 'interaction.approval',
        // Without a subject the Host's title is only its category name.
        displayData: { title: p.subject ? p.title : p.description, description: p.description,
          ...(p.subject ? { subject: p.subject } : {}), category: remoteInteractionCategory(interaction) },
        userPending: true, userSource: false });
      changed = true;
    }
    const open = this.db.prepare(`SELECT f.provider_event_id AS eventId, f.turn_id AS turnId,
        f.turn_number AS turnNumber, f.interaction_id AS interactionId
      FROM inbox_projection_facts f
      WHERE f.session_id = ? AND f.source = 'native' AND f.writer = 'host' AND f.direction = 'open'
        AND f.provider_event_id = f.occurrence_event_id AND substr(f.provider_event_id, 1, ?) = ?
        AND NOT EXISTS (SELECT 1 FROM inbox_projection_facts c WHERE c.session_id = f.session_id
          AND c.turn_id = f.turn_id AND c.interaction_id = f.interaction_id AND c.source = f.source AND c.direction = 'close')`)
      .all(localId, REMOTE_INBOX_OPEN.length, REMOTE_INBOX_OPEN) as Array<{
        eventId: string; turnId: string; turnNumber: number | null; interactionId: string;
      }>;
    for (const row of open) {
      const remoteId = row.eventId.slice(REMOTE_INBOX_OPEN.length);
      if (listed.has(remoteId)) continue;
      const answered = this.answered.delete(remoteId);
      const resolution = this.replicaResolution(localId, remoteId);
      // An automatic decline is a release (turn end, Stop, Proxy exit): nobody decided.
      const cancelled = !resolution || (resolution.auto && resolution.decision === 'decline');
      recordInboxProjection(this.db, { sessionId: localId, providerEventId: REMOTE_INBOX_CLOSE + remoteId, turnId: row.turnId,
        turnNumber: row.turnNumber ?? 0, origin: 'live', source: 'native', writer: 'host', method: 'interaction.resolved',
        raw: { interactionId: row.interactionId, outcome: cancelled ? 'cancelled' : 'submitted' },
        displayType: 'interaction.resolved', displayData: cancelled ? null : { decision: resolution.decision },
        userPending: false, userSource: answered && !cancelled && !resolution.auto });
      changed = true;
    }
    if (changed) this.inboxDrain?.();
  }

  /** The newest resolution the Host journaled for one card, if any. */
  private replicaResolution(localId: string, interactionId: string): { decision: string; auto: boolean } | null {
    const row = this.db.prepare(`SELECT json_extract(item_json, '$.resolution.decision') AS decision,
        json_extract(item_json, '$.resolution.auto') AS auto FROM remote_execution_replica_events
      WHERE local_session_id = ? AND json_extract(item_json, '$.resolution.interaction_id') = ?
      ORDER BY sequence DESC LIMIT 1`).get(localId, interactionId) as { decision: string; auto: number } | undefined;
    return row ? { decision: row.decision, auto: row.auto === 1 } : null;
  }

  /** Whether the Host still lists this card (by its local id) as pending. */
  hasPendingInteraction(localId: string, approvalId: string): boolean {
    return this.replicas.snapshot(localId)?.interactions.some(item => localInteractionId(localId, item.id) === approvalId) === true;
  }

  /** The turn a pending card belongs to: the active turn when it owns the
   *  card, else the turn its history request was recorded on. */
  private interactionTurn(localId: string, interaction: RemoteInteraction, session: ExecutionSession): number {
    if (session.active_turn?.id === interaction.turn_id) return session.active_turn.turn_number;
    const row = this.db.prepare(`SELECT json_extract(item_json, '$.turn') AS turn FROM remote_execution_replica_events
      WHERE local_session_id = ? AND json_extract(item_json, '$.interaction.id') = ? ORDER BY sequence DESC LIMIT 1`)
      .get(localId, interaction.id) as { turn: number } | undefined;
    return row?.turn ?? session.active_turn?.turn_number ?? 0;
  }

  private resetHistory(localId: string): void {
    const last = this.historyResets.get(localId);
    if (last !== undefined && Date.now() - last < HISTORY_RESET_INTERVAL_MS) {
      throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'execution history keeps changing; retrying later');
    }
    this.historyResets.set(localId, Date.now());
    this.replicas.reset(localId);
    this.rebuilding.add(localId);
  }

  async command(localId: string, method: RemoteMethod, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'queue.update') return this.updateTranslatedQueue(localId, params);
    if (!this.bindings.get(localId)) throw new Error('remote binding missing');
    const session = this.repository.get(localId);
    const beforeQueue = method === 'queue.clear' ? this.queue(localId).map(entry => entry.id) : [];
    const binding = await this.requireExecutionOwner(localId, true);
    if (method === 'session.send') this.bindings.markStarted(localId, binding.revision);
    const result = await this.client(session.remote_execution!.environment_id).request(method,
      { ...params, ...(method === 'interaction.respond' ? {} : { session_id: binding.target.remote_session_id }) });
    this.bindings.assertCurrent(binding);
    if (!['file.resolve', 'file.tree', 'file.list', 'git.read', 'file.preview', 'command.status'].includes(method)) await this.sync(localId);
    const removed = method === 'queue.remove' ? [String(params.queue_id)] : method === 'queue.clear' ? beforeQueue : [];
    for (const id of removed) this.db.prepare(`UPDATE tool_deliveries SET state = 'cancelled', queue_entry_id = NULL, updated_at = ?
      WHERE session_id = ? AND queue_entry_id = ? AND state IN ('pending', 'queued')`).run(new Date().toISOString(), localId, id);
    if (method === 'queue.send_now') {
      const affected = (result as { affected?: Array<{ queue_id: string; turn_number: number; state: string }> }).affected ?? [];
      for (const item of affected) {
        const turnId = localRemoteTurnId(localId, item.turn_number);
        if (!this.db.prepare('SELECT 1 FROM turns WHERE id = ?').get(turnId)) continue;
        this.db.prepare(`UPDATE tool_deliveries SET state = ?, queue_entry_id = NULL, turn_id = ?, updated_at = ?
          WHERE session_id = ? AND queue_entry_id = ? AND state IN ('pending', 'queued')`)
          .run(item.state, turnId, new Date().toISOString(), localId, item.queue_id);
      }
    }
    return result;
  }

  async handleMessage(msg: ClientToServerMessage): Promise<boolean> {
    if (!('session_id' in msg) || typeof msg.session_id !== 'string' || !this.owns(msg.session_id)) return false;
    const localId = msg.session_id;
    if (msg.type === 'events:subscribe') { await this.sync(localId); return true; }
    if (!LOCAL_SESSION_MESSAGES.has(msg.type)) this.assertEnvironmentActive(localId);
    const snapshot = this.replicas.snapshot(localId);
    if (!snapshot) throw new Error('remote state not loaded');
    switch (msg.type) {
      case 'message:send':
      case 'queue:add':
        await this.send(localId, msg, 'queue'); return true;
      case 'message:steer':
        await this.send(localId, msg, 'steer'); return true;
      case 'session:stop':
        if (this.translations?.cancelSession(localId) && !snapshot.session.active_turn) return true;
        try { await this.command(localId, 'session.stop', { session_revision: snapshot.session.revision }); }
        catch (error) { throw remoteStopError(error); }
        return true;
      case 'session:set_model':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, model: msg.model }); return true;
      case 'session:set_effort':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, thinking: msg.effort }); return true;
      case 'session:set_service_tier':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, service_tier: msg.service_tier ?? 'standard' }); return true;
      case 'session:set_mode':
        await this.command(localId, 'session.update', { session_revision: snapshot.session.revision, approval_mode: msg.approval_mode }); return true;
      case 'session:set_native_config':
        await this.command(localId, 'execution.configure', { session_revision: snapshot.session.revision,
          binding: 'session', option_id: msg.config_id, value: msg.value }); return true;
      case 'session:set_turn_config':
        await this.command(localId, 'execution.configure', { session_revision: snapshot.session.revision,
          binding: 'turn', option_id: msg.option_id, value: msg.value }); return true;
      case 'queue:clear':
        await this.command(localId, 'queue.clear', { expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'queue:send_now':
        await this.command(localId, 'queue.send_now', { expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'queue:remove':
        await this.command(localId, 'queue.remove', { queue_id: msg.queue_id, expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'queue:update':
        await this.command(localId, 'queue.update', { queue_id: msg.queue_id, text: msg.text, expected_queue_revision: snapshot.session.queue.revision }); return true;
      case 'approval:resolve': {
        const interaction = snapshot.interactions.find(item => localInteractionId(localId, item.id) === msg.approval_id);
        // The card sends the Host's exact action. A plain decision (the Inbox
        // plan actions) maps only to the Host's own action for that decision,
        // never to an Agent option it would have to guess.
        const actionId = msg.native_option_id ?? (interaction && msg.decision ? remoteActionId(interaction.id, msg.decision) : undefined);
        if (!interaction || !actionId || !interaction.presentation.actions.some(item => item.id === actionId)) throw new Error('remote interaction changed');
        // Marked first: the sync that follows the answer may already close its Inbox row.
        this.answered.add(interaction.id);
        try {
          await this.command(localId, 'interaction.respond', { interaction_id: interaction.id,
            interaction_revision: interaction.revision, action_id: actionId, ...(msg.answers ? { values: msg.answers } : {}) });
        } catch (error) {
          this.answered.delete(interaction.id);
          throw error;
        }
        return true;
      }
      default:
        if (LOCAL_SESSION_MESSAGES.has(msg.type)) return false;
        throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'remote operation is not supported');
    }
  }

  queue(localId: string): import('../queue/manager.js').QueueEntry[] {
    return (this.replicas.snapshot(localId)?.session.queue.entries ?? []).map(entry => {
      const request = this.db.prepare(`SELECT r.request_id FROM remote_execution_send_requests r
        JOIN tool_requests t ON t.id = r.request_id WHERE r.local_session_id = ? AND json_extract(r.result_json, '$.queue_id') = ?`)
        .get(localId, entry.id) as { request_id: string } | undefined;
      const origin = this.translations ? remoteTranslationOrigin(this.db, this.translations, localId,
        { text: entry.text, queueId: entry.id }) : undefined;
      return { id: entry.id, sessionId: localId, text: origin?.translation.sourceText ?? entry.text, createdAt: Date.parse(entry.created_at),
        ...(request ? { toolRequestId: request.request_id } : {}) };
    });
  }

  private linkToolDeliveries(localId: string): void {
    const links = this.db.prepare(`SELECT r.request_id, h.item_json FROM remote_execution_send_requests r
      JOIN tool_deliveries d ON d.request_id = r.request_id AND d.turn_id IS NULL
      JOIN remote_execution_replica_events h ON h.local_session_id = r.local_session_id
        AND json_extract(h.item_json, '$.item.delivery_id') = json_extract(r.result_json, '$.delivery_id')
      WHERE r.local_session_id = ?`).all(localId) as Array<{ request_id: string; item_json: string }>;
    for (const row of links) {
      const entry = JSON.parse(row.item_json) as ExecutionHistoryEntry;
      if (!('item' in entry) || entry.item.kind !== 'user') continue;
      this.db.prepare('UPDATE turns SET tool_request_id = ? WHERE id = ? AND tool_request_id IS NULL')
        .run(row.request_id, localRemoteTurnId(localId, entry.item.turn));
    }
  }

  async sendForTool(localId: string, input: RemoteSessionInput, requestId: string,
    busy: 'queue' | 'steer' | 'fail' = 'queue') {
    await this.send(localId, { ...input, request_id: requestId }, busy);
    const row = this.db.prepare('SELECT result_json FROM remote_execution_send_requests WHERE request_id = ?')
      .get(requestId) as { result_json: string };
    const result = JSON.parse(row.result_json) as { delivery_id?: string; delivery_state?: string; queue_id?: string;
      turn_number?: number; session: { active_turn?: { turn_number: number } } };
    const number = result.delivery_state === 'queued' ? undefined : result.turn_number ?? result.session.active_turn?.turn_number;
    if (number && result.delivery_state !== 'queued') this.db.prepare(`UPDATE turns SET tool_request_id = ?
      WHERE id = ? AND tool_request_id IS NULL AND EXISTS (SELECT 1 FROM tool_requests WHERE id = ?)`)
      .run(requestId, localRemoteTurnId(localId, number), requestId);
    return { state: result.delivery_state ?? 'unknown', queueId: result.queue_id,
      turnId: number ? localRemoteTurnId(localId, number) : undefined, turnNumber: number };
  }

  private send(localId: string, input: RemoteSessionInput & { request_id?: string }, busy: 'queue' | 'steer' | 'fail'): Promise<void> {
    if (input.send_id !== undefined && (typeof input.send_id !== 'string' || !input.send_id || input.send_id.length > 128)) {
      return Promise.reject(new Error('Invalid local send identity.'));
    }
    const requestId = input.send_id ?? input.request_id ?? generateCanonicalId();
    const { request_id: _correlation, ...submission } = input;
    const serialized = canonicalJson({ localId, input: input.send_id ? submission : input, busy });
    const pending = this.sending.get(requestId);
    if (pending) return pending.input === serialized ? pending.promise : Promise.reject(new Error('send request changed'));
    const promise = this.sendOnce(localId, requestId, serialized, input, busy).finally(() => this.sending.delete(requestId));
    this.sending.set(requestId, { input: serialized, promise });
    return promise;
  }

  private async sendOnce(localId: string, requestId: string, serialized: string, input: RemoteSessionInput,
    busy: 'queue' | 'steer' | 'fail'): Promise<void> {
    const session = this.repository.get(localId);
    const client = this.client(session.remote_execution!.environment_id);
    const binding = await this.requireExecutionOwner(localId, true);
    const existing = this.db.prepare('SELECT * FROM remote_execution_send_requests WHERE request_id = ?').get(requestId) as {
      local_session_id: string; binding_revision: number; browser_id: string; command_id: string;
      input_json: string; params_json: string; result_json: string | null; method: string;
    } | undefined;
    if (existing && (existing.method !== 'session.send' || existing.input_json !== serialized || existing.local_session_id !== localId
      || existing.binding_revision !== binding.revision)) throw new RemoteProtocolError('PRECONDITION_FAILED', 'send request changed');
    if (existing?.result_json) {
      await this.syncSendReceipt(localId, JSON.parse(existing.result_json) as { delivery_id?: string; delivery_state?: string });
      return;
    }
    if (existing && existing.browser_id !== client.environment.browser_id) {
      throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'pairing changed; reconcile execution history before sending again');
    }
    const commandId = existing?.command_id ?? generateUuidV7();
    if (!existing && input.translation_id !== 'original' && !this.translations && (input.translation_id
      || (this.db.prepare('SELECT enabled FROM session_translation_preferences WHERE session_id = ?')
        .get(localId) as { enabled: number } | undefined)?.enabled === 1)) {
      throw new Error('Local translation service is unavailable.');
    }
    const translation = !existing ? await this.translations?.prepareSend(localId,
      { text: input.text, document: input.composer_document, translationId: input.translation_id },
      loadConfig(this.db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES }, requestId) : undefined;
    const params = existing ? JSON.parse(existing.params_json) as Record<string, unknown>
      : { ...await this.prepareSend(localId, translation ? translatedRemoteInput(input, translation) : input), session_id: binding.target.remote_session_id, busy };
    this.bindings.assertCurrent(binding);
    if (!existing) this.db.prepare(`INSERT INTO remote_execution_send_requests
      (request_id, local_session_id, binding_revision, browser_id, command_id, input_json, params_json, translation_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(requestId, localId, binding.revision, client.environment.browser_id,
        commandId, serialized, canonicalJson(params), translation?.id ?? null, Date.now());
    this.bindings.markStarted(localId, binding.revision);
    const result = await client.request('session.send', params, commandId);
    this.bindings.assertCurrent(binding);
    this.db.prepare('UPDATE remote_execution_send_requests SET result_json = ? WHERE request_id = ?')
      .run(JSON.stringify(result), requestId);
    this.linkToolDeliveries(localId);
    await this.syncSendReceipt(localId, result as { delivery_id?: string; delivery_state?: string });
  }

  /** Restore the ws-handler ordering contract for remote sends: the canonical
   *  user_message broadcast must precede the send's operation result. Never
   *  join an in-flight poller sync — its execution.sync response may predate
   *  the remote journaling of this send — and retry briefly when the fresh
   *  replica still lacks the journaled delivery. A queued delivery has no
   *  user_message yet; its queue:updated broadcast inside the sync carries
   *  the ordering instead. */
  private async syncSendReceipt(localId: string, receipt: { delivery_id?: string; delivery_state?: string }): Promise<void> {
    const deliveryId = receipt.delivery_state === 'queued' ? undefined : receipt.delivery_id;
    for (let attempt = 1; ; attempt += 1) {
      await this.syncing.get(localId)?.catch(() => {});
      await this.sync(localId);
      this.broadcastTranslatedHistory(localId);
      if (!deliveryId || this.replicaHasDelivery(localId, deliveryId)) return;
      if (attempt >= 3) {
        console.error('[remote] send delivery not journaled after fresh syncs; the poller reconciles it later', deliveryId);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }

  private replicaHasDelivery(localId: string, deliveryId: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM remote_execution_replica_events
      WHERE local_session_id = ? AND json_extract(item_json, '$.item.delivery_id') = ? LIMIT 1`)
      .get(localId, deliveryId));
  }

  private async reconcileTranslationReceipts(localId: string, client: RemoteControllerClient, revision: number): Promise<void> {
    const rows = this.db.prepare(`SELECT request_id, command_id, method FROM remote_execution_send_requests
      WHERE local_session_id = ? AND binding_revision = ? AND browser_id = ?
      AND translation_id IS NOT NULL AND result_json IS NULL LIMIT 8`)
      .all(localId, revision, client.environment.browser_id) as Array<{ request_id: string; command_id: string; method: string }>;
    let changed = false;
    for (const row of rows) {
      // Query-only recovery: never resubmit a command or infer delivery from text.
      let status: CommandStatusResult;
      try {
        status = parseClosed(commandStatusResultSchema,
          await client.request('command.status', { command_id: row.command_id }));
      } catch { continue; }
      if (status.command_id !== row.command_id || status.state !== 'succeeded' || status.result === undefined
        || this.bindings.get(localId)?.revision !== revision || this.closed) continue;
      let result: unknown;
      try {
        if (row.method === 'queue.update') result = parseClosed(REMOTE_METHOD_RESULTS['queue.update'], status.result);
        else if (row.method === 'session.send') {
          const receipt = parseClosed(REMOTE_METHOD_RESULTS['session.send'], status.result);
          if (receipt.session.id !== this.bindings.get(localId)?.target.remote_session_id) continue;
          result = receipt;
        } else continue;
      } catch { continue; }
      this.db.prepare('UPDATE remote_execution_send_requests SET result_json = ? WHERE request_id = ? AND result_json IS NULL')
        .run(JSON.stringify(result), row.request_id);
      changed = true;
    }
    if (changed) this.broadcastTranslatedHistory(localId);
  }

  private async updateTranslatedQueue(localId: string, input: Record<string, unknown>): Promise<unknown> {
    if (typeof input.text !== 'string' || typeof input.queue_id !== 'string' || typeof input.expected_queue_revision !== 'string') {
      throw new Error('Invalid queue update.');
    }
    if (!this.bindings.get(localId)) throw new Error('remote binding missing');
    const session = this.repository.get(localId);
    const client = this.client(session.remote_execution!.environment_id);
    const binding = await this.requireExecutionOwner(localId, true);
    const serialized = canonicalJson({ localId, input: { text: input.text }, queueId: input.queue_id, revision: input.expected_queue_revision });
    const requestId = remoteStableUuid('translated-queue-edit', serialized);
    const existing = this.db.prepare('SELECT * FROM remote_execution_send_requests WHERE request_id = ?')
      .get(requestId) as { method: string; input_json: string; params_json: string; result_json: string | null;
        command_id: string; binding_revision: number; browser_id: string } | undefined;
    if (existing && (existing.method !== 'queue.update' || existing.input_json !== serialized || existing.binding_revision !== binding.revision
      || existing.browser_id !== client.environment.browser_id)) throw new RemoteProtocolError('UNKNOWN_OUTCOME', 'queue update binding changed');
    if (existing?.result_json) { await this.sync(localId); return JSON.parse(existing.result_json); }
    if (!existing && !this.translations && (this.db.prepare('SELECT enabled FROM session_translation_preferences WHERE session_id = ?')
      .get(localId) as { enabled: number } | undefined)?.enabled === 1) throw new Error('Local translation service is unavailable.');
    const translation = !existing ? await this.translations?.prepareSend(localId, { text: input.text },
      loadConfig(this.db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES }, requestId) : undefined;
    const params = existing ? JSON.parse(existing.params_json) as Record<string, unknown> : {
      session_id: binding.target.remote_session_id, queue_id: input.queue_id,
      expected_queue_revision: input.expected_queue_revision,
      text: translation ? translatedRemoteInput({ text: input.text }, translation).text : input.text,
    };
    const commandId = existing?.command_id ?? generateUuidV7();
    this.bindings.assertCurrent(binding);
    if (!existing) this.db.prepare(`INSERT INTO remote_execution_send_requests
      (request_id, local_session_id, binding_revision, browser_id, command_id, input_json, params_json, translation_id, method, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queue.update', ?)`).run(requestId, localId, binding.revision, client.environment.browser_id,
        commandId, serialized, canonicalJson(params), translation?.id ?? null, Date.now());
    const result = await client.request('queue.update', params, commandId);
    this.bindings.assertCurrent(binding);
    this.db.prepare('UPDATE remote_execution_send_requests SET result_json = ? WHERE request_id = ?').run(JSON.stringify(result), requestId);
    await this.sync(localId);
    this.broadcastTranslatedHistory(localId);
    return result;
  }

  private broadcastTranslatedHistory(localId: string): void {
    for (const entry of this.replicas.items(localId)) {
      if (!('item' in entry) || entry.item.kind !== 'user') continue;
      const event = this.historyEvent(localId, entry);
      if (event.data.translation) this.broadcaster.broadcast({ type: 'event', ...event });
    }
  }

  historyEvent(localId: string, entry: ExecutionHistoryEntry): EventEnvelope {
    const event = remoteHistoryEvent(localId, entry);
    if (!this.translations || !('item' in entry) || entry.item.kind !== 'user') return event;
    const origin = remoteTranslationOrigin(this.db, this.translations, localId,
      { text: entry.item.text, deliveryId: entry.item.delivery_id });
    if (!origin) return event;
    return { ...event, data: { ...event.data, text: origin.translation.sourceText, translation: origin.translation,
      ...(origin.sendId ? { send_id: origin.sendId } : {}),
      ...(origin.document ? { composer_document: origin.document } : {}),
      ...(origin.contextItems ? { context_items: origin.contextItems } : {}) } };
  }

  /** A history card the Host neither lists as pending nor closed in its
   *  history was dropped without a close (see closeVanished); it settles
   *  neutral here, so every reload agrees with the live transcript. */
  historyEvents(localId: string): EventEnvelope[] {
    const entries = this.replicas.items(localId);
    const pending = new Set((this.replicas.snapshot(localId)?.interactions ?? []).map(item => item.id));
    const resolved = new Set(entries.flatMap(entry => 'resolution' in entry ? [entry.resolution.interaction_id] : []));
    return entries.flatMap(entry => {
      const event = this.historyEvent(localId, entry);
      if (!('interaction' in entry) || pending.has(entry.interaction.id) || resolved.has(entry.interaction.id)) return [event];
      return [event, remoteInteractionClosedEvent(localId, entry.interaction, entry.turn, event.ts)];
    });
  }

  async resolveFile(localId: string, reference: string) {
    return parseClosed(remoteFileRefSchema, await this.command(localId, 'file.resolve', { reference }));
  }

  /** One remote file's current bytes. Each attempt resolves the reference
   *  again and waits for a download slot of its environment; a transient
   *  failure is retried twice. */
  async readFile(localId: string, reference: string) {
    return retryTransientTransfer(async () => {
      const file = await this.resolveFile(localId, reference);
      const environmentId = this.repository.get(localId).remote_execution!.environment_id;
      let slots = this.transferSlots.get(environmentId);
      if (!slots) this.transferSlots.set(environmentId, slots = new RemoteTransferSlots());
      const content = await slots.run(() => new RemoteControllerContent(this.client(environmentId)).download(file.id));
      return { ...content, file };
    }, this.transferRetryDelays);
  }

  /**
   * A message attachment's bytes. They never change for one reference, so
   * they are kept on disk and served from there without the relay, also
   * for a removed environment's history. Concurrent reads of one attachment
   * share a download, and only a complete, verified one is kept.
   */
  async readAttachment(localId: string, reference: string): Promise<CachedRemoteAttachment> {
    const binding = this.bindings.get(localId);
    const environmentId = this.repository.find(localId)?.remote_execution?.environment_id;
    if (!binding || !environmentId) throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'remote session not found');
    const key: RemoteAttachmentKey = { environmentId, localSessionId: localId,
      remoteSessionId: binding.target.remote_session_id, reference };
    const cached = await this.attachmentCache.get(key);
    if (cached) return cached;
    const id = canonicalJson(key);
    const running = this.attachmentReads.get(id);
    if (running) return running;
    const read = (async () => {
      const file = await this.readFile(localId, reference);
      const value = { bytes: file.bytes, name: file.name, mime: file.mime,
        sha256: createHash('sha256').update(file.bytes).digest('hex') };
      await this.attachmentCache.put(key, value).catch(() => undefined);
      return value;
    })().finally(() => this.attachmentReads.delete(id));
    this.attachmentReads.set(id, read);
    return read;
  }

  /** A deleted remote session's cached attachments go with it. */
  sessionDeleted(localId: string): Promise<void> {
    return this.attachmentCache.evictSession(localId);
  }

  async tree(localId: string, directory: string, after?: string) {
    return this.command(localId, 'file.tree', { directory, ...(after ? { after } : {}) });
  }

  async directory(localId: string, directory: string) {
    const entries: Array<{ name: string; reference: string; kind: 'directory' | 'file' }> = [];
    let after: string | undefined;
    do {
      const page = await this.tree(localId, directory, after) as { entries: typeof entries; has_more: boolean };
      entries.push(...page.entries);
      const next = page.has_more ? page.entries.at(-1)?.name : undefined;
      if (next && after && next <= after) throw new RemoteProtocolError('INVALID_FRAME', 'directory cursor did not advance');
      after = next;
    } while (after && entries.length < 20_000);
    return entries;
  }

  private async prepareSend(localId: string, input: RemoteSessionInput) {
    assertLocalFilesBelongToSession(localId, input.items);
    const session = this.repository.get(localId);
    const binding = this.bindings.get(localId)!;
    const content = new RemoteControllerContent(this.client(session.remote_execution!.environment_id));
    const contexts: MessageContextItem[] = [];
    if ((input.context_items?.length ?? 0) > 16) throw new Error('too many context items');
    for (const item of input.context_items ?? []) {
      if (item.type === 'file') {
        const read = await this.readFile(localId, item.path);
        const bytes = Buffer.from(read.bytes);
        const text = isLikelyBinary(bytes) ? item.name
          : item.name + '\n' + bytes.subarray(0, 60 * 1024).toString('utf8')
            + (bytes.length > 60 * 1024 ? '\n[truncated]' : '');
        contexts.push(pastedContext(item.id, text));
      } else if (item.type === 'folder') {
        await this.tree(localId, item.path);
        contexts.push(pastedContext(item.id, 'Remote worktree folder: ' + item.path));
      } else if (item.type === 'session') {
        const linked = this.repository.find(item.sessionId);
        const events = linked?.remote_execution ? this.replicas.items(item.sessionId).map(entry => remoteHistoryEvent(item.sessionId, entry))
          : new SessionHistoryStore(this.db).listEvents(item.sessionId);
        const text = events.flatMap(event => event.event === 'user_message' && typeof event.data.text === 'string'
          ? ['User: ' + event.data.text] : event.display?.type === 'message'
            ? ['Assistant: ' + String(event.display.data.text)] : []).join('\n\n');
        contexts.push(pastedContext(item.id, 'Session: ' + item.title + '\n' + text.slice(-48 * 1024)));
      } else contexts.push(item);
    }
    const normalized = normalizeMessageContextItems(contexts);
    const document = normalizeMessageComposerDocument(input.composer_document, input.items, normalized);
    if (!normalized.length && !document && (!input.items?.length
      || (input.items.length === 1 && input.items[0]?.type === 'text' && 'text' in input.items[0] && input.items[0].text === input.text))) {
      return { text: input.text };
    }
    const compiled = compileContextIntoInput(input.text, input.items, normalized, document);
    const items: Array<{ type: 'text'; text: string } | { type: 'attachment' | 'compiled_text'; attachment_id: string }> = [];
    for (const item of compiled) {
      if (item.type === 'text' && 'text' in item) {
        const text = String(item.text);
        if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('compiled context too large');
        if (text.length <= 16000) items.push({ type: 'text', text });
        else {
          const uploaded = await content.upload(binding.target.remote_session_id, 'context.txt', 'text/plain', new TextEncoder().encode(text));
          items.push({ type: 'compiled_text', attachment_id: uploaded.id });
        }
      } else if ((item.type === 'localFile' || item.type === 'localImage') && 'path' in item && typeof item.path === 'string') {
        const bytes = await readBoundedFile(item.path, 20 * 1024 * 1024);
        const uploaded = await content.upload(binding.target.remote_session_id, basename(item.path), previewMimeForAttachment(item.path), bytes);
        items.push({ type: 'attachment', attachment_id: uploaded.id });
      } else throw new RemoteProtocolError('REMOTE_CAPABILITY_DENIED', 'remote input type is not supported');
    }
    this.bindings.assertCurrent(binding);
    return { text: input.text, items };
  }

  historyPage(localId: string, before: number | null, count = 3): EventHistoryPage {
    const stored = this.historyEvents(localId);
    const turns = [...new Set(stored.map(item => item.turn))].filter(turn => before === null || turn < before).sort((a, b) => b - a);
    const selected = turns.slice(0, Math.max(1, Math.min(10, count)));
    const selectedSet = new Set(selected);
    const events = compactHistoryEnvelopes(stored.filter(item => selectedSet.has(item.turn)));
    if (before === null) {
      const snapshot = this.replicas.snapshot(localId);
      for (const interaction of snapshot?.interactions ?? []) {
        events.push(remoteInteractionEvent(localId, interaction, this.interactionTurn(localId, interaction, snapshot!.session)));
      }
    }
    return { events, hasMore: turns.length > selected.length, nextCursor: turns.length > selected.length ? selected.at(-1)! : null };
  }

  client(environmentId: string): RemoteControllerClient {
    if (this.closed) throw new RemoteProtocolError('HOST_OFFLINE', 'controller is closed');
    const existing = this.clients.get(environmentId);
    if (existing) return existing;
    const environment = this.db.prepare('SELECT * FROM remote_controller_environments WHERE id = ?')
      .get(environmentId) as EnvironmentRow | undefined;
    if (!environment) throw new Error('remote environment not found');
    // Never connected again until Restore; catalogs, pickers and take over stop here.
    if (environment.removed_at !== null) throw new RemoteEnvironmentRemovedError();
    // The client is this environment's one connection manager: every sync,
    // hint, download, owed link and user operation goes through its backoff.
    const client = this.createClient(environment, connected => this.connectionChanged(environmentId, connected), {
      wanted: () => this.wantsConnection(environmentId),
      onAttemptFailed: error => this.connectionFailed(environmentId, error),
    });
    client.onControl(message => this.receiveHint(client, environmentId, message));
    this.clients.set(environmentId, client);
    return client;
  }

  private createClient(environment: RemoteControllerEnvironment,
    onConnectionChange: (connected: boolean) => void, hooks: RemoteConnectionHooks): RemoteControllerClient {
    return new RemoteControllerClient(environment, this.identity, next => {
      this.db.prepare(`UPDATE remote_controller_environments SET device_id = ?, device_public_key_json = ?,
        crypto_connection_id = ?, host_public_key_json = ?, pairing_id = ? WHERE id = ?`)
        .run(next.device_id, next.device_public_key_json ?? null, next.crypto_connection_id,
          next.host_public_key_json, next.pairing_id, next.id);
    }, undefined, undefined, onConnectionChange, undefined, hooks);
  }

  workingTrees() {
    // A removed environment's worktrees are not browsable; its history stays.
    const removed = new Set((this.db.prepare('SELECT id FROM remote_controller_environments WHERE removed_at IS NOT NULL')
      .all() as Array<{ id: string }>).map(row => row.id));
    return this.repository.list().flatMap(session => session.remote_execution
      && !removed.has(session.remote_execution.environment_id) ? [{
      id: 'remote:' + session.id, kind: 'worktree' as const,
      label: session.remote_execution.environment_name + ' / ' + session.remote_execution.repository_name,
      path: 'gian-remote://' + session.id, branch: null,
      workspace_id: 'remote:' + session.remote_execution.environment_id + ':' + session.remote_execution.repository_id,
      workspace_name: session.remote_execution.environment_name + ' / ' + session.remote_execution.repository_name,
      session_id: session.id, session_name: session.name,
    }] : []);
  }

  async files(localId: string): Promise<string[]> {
    const references: string[] = [];
    let after: string | undefined;
    do {
      const page = await this.command(localId, 'file.list', { ...(after ? { after } : {}) }) as { references: string[]; has_more: boolean };
      references.push(...page.references);
      after = page.has_more ? page.references.at(-1) : undefined;
    } while (after && references.length < 20_000);
    return references.slice(0, 20_000);
  }
}

/** Map a failed sync to an honest session state; the web picks copy by reason. */
function remoteSessionAvailability(error: unknown): RemoteFailure {
  const code = error instanceof RemoteProtocolError ? error.code : '';
  const message = error instanceof Error ? error.message : '';
  if (code === 'SNAPSHOT_REQUIRED') return { status: 'history_reset' };
  if (code === 'RESOURCE_NOT_FOUND') return { status: 'unavailable', reason: 'not_found' };
  if (code === 'REMOTE_CAPABILITY_DENIED') return { status: 'unavailable', reason: 'denied' };
  if (code === 'PROTOCOL_VERSION_UNSUPPORTED') return { status: 'unavailable', reason: 'unsupported' };
  if (code === 'AUTH_REQUIRED' && /server identity changed/i.test(message)) return { status: 'auth_required', reason: 'server_identity' };
  if (code === 'AUTH_REQUIRED' && /host key changed/i.test(message)) return { status: 'auth_required', reason: 'host_key' };
  if (code === 'AUTH_REQUIRED' || code === 'DEVICE_REVOKED' || code === 'DEVICE_NOT_PAIRED' || code === 'CONTROLLER_REVOKED'
    || code === 'CONTROLLER_NOT_ADMITTED') {
    return { status: 'auth_required', reason: 'pairing' };
  }
  return { status: 'offline' };
}

/** A Server origin as browsers compare them (lower-case host, no default
 *  port or trailing slash); null when it is not one. */
function originKey(origin: string): string | null {
  try {
    const key = new URL(origin).origin;
    return key === 'null' ? null : key;
  } catch { return null; }
}

/** A failed remote Stop reaches the Desktop as an error toast; say what the
 *  user can do about it instead of only the wire code. The code is kept. */
function remoteStopError(error: unknown): unknown {
  if (!(error instanceof RemoteProtocolError)) return error;
  const message = error.details?.reason === 'timeout'
    ? 'The remote Host did not answer the stop request in time. The Turn may still be running; check that the Host is online, then press Stop again.'
    : REMOTE_STOP_ERRORS[error.code];
  return message ? new RemoteProtocolError(error.code, message, error.details) : error;
}

const REMOTE_STOP_ERRORS: Partial<Record<RemoteProtocolError['code'], string>> = {
  HOST_OFFLINE: 'Cannot reach the remote Host to stop this Turn. Check that it is online and connected to Remote, then press Stop again.',
  UNKNOWN_OUTCOME: 'The remote Host did not confirm the stop. The Turn may still be running; press Stop again once the session refreshes.',
  PRECONDITION_FAILED: 'The remote session changed before the stop arrived. Review its latest state, then press Stop again.',
  // Hosts before the stop fallback reported an unreachable Agent this way.
  INVALID_FRAME: 'The remote Host could not interrupt its Agent. Update Gian on that Host, or recover the session there.',
  AUTH_REQUIRED: 'This Host needs to be reconnected. Reconnect it in Settings › Remote, then press Stop again.',
  DEVICE_REVOKED: 'This Mac is no longer paired with the remote Host. Pair it again in Settings › Remote.',
  DEVICE_NOT_PAIRED: 'This Mac is no longer paired with the remote Host. Pair it again in Settings › Remote.',
  REMOTE_CAPABILITY_DENIED: 'The remote Host does not allow this Mac to stop its sessions.',
  RESOURCE_NOT_FOUND: 'This session no longer exists on the remote Host.',
};

function pastedContext(id: string, text: string): MessageContextItem {
  const bytes = Buffer.from(text);
  const bounded = bytes.length <= 64 * 1024 ? text : bytes.subarray(0, 60 * 1024).toString('utf8') + '\n[truncated]';
  return { type: 'pastedText', id, text: bounded, byteSize: Buffer.byteLength(bounded), lineCount: bounded.split('\n').length };
}

export function localInteractionId(localId: string, remoteId: string): string {
  return remoteStableUuid('remote-interaction', `${localId}:${remoteId}`);
}

function remoteInteractionCategory(interaction: RemoteInteraction): 'question' | 'exit_plan_mode' | 'command' {
  return isRemoteQuestion(interaction) ? 'question' : interaction.kind === 'exit_plan_mode' ? 'exit_plan_mode' : 'command';
}

/** Hosts before human decision labels sent the raw decision as the label of
 *  their own decision actions; Agent-supplied labels pass through. */
function remoteActionLabel(interaction: RemoteInteraction, action: RemoteInteraction['presentation']['actions'][number]): string {
  const label = REMOTE_DECISION_LABELS[action.label];
  return label && action.id === remoteActionId(interaction.id, action.label) ? label : action.label;
}

function remoteInteractionEvent(localId: string, interaction: RemoteInteraction, turn: number): EventEnvelope {
  const p = interaction.presentation;
  const question = isRemoteQuestion(interaction);
  return { session_id: localId, turn, call_id: localInteractionId(localId, interaction.id), event: 'remote.interaction',
    ts: Date.parse(interaction.created_at), data: {}, display: {
      type: question ? 'interaction.question' : 'interaction.approval',
      data: { approvalId: localInteractionId(localId, interaction.id),
        category: remoteInteractionCategory(interaction),
        // Required by the display type only: remote cards render the Host's
        // actions, which already include any session-scoped choice.
        title: p.title, description: p.description, subject: p.subject, risk: p.risk, scopeOptions: ['once'],
        ...(question ? { interactionKind: 'question' } : {}),
        actions: p.actions.map(action => ({ id: action.id, label: remoteActionLabel(interaction, action),
          style: action.tone === 'danger' ? 'danger' : 'secondary' })),
        inputs: p.inputs?.map(input => ({ id: input.id, type: input.type, label: input.label, required: false,
          choices: input.options?.map(option => ({ value: option.value, displayName: option.label })) })),
      },
    } };
}

/** Questions from current Agents arrive as native choices that carry inputs. */
function isRemoteQuestion(interaction: RemoteInteraction): boolean {
  return interaction.kind === 'question' || (interaction.kind === 'native_choice' && (interaction.presentation.inputs?.length ?? 0) > 0);
}

/** Close for a card the Host dropped without one. It claims no decision, so
 *  an approval settles neutral ("Resolved") and a question that never got
 *  its answer settles cancelled; `auto` never overrides a decision the card
 *  already shows. */
function remoteInteractionClosedEvent(localId: string, interaction: RemoteInteraction, turn: number, ts: number): EventEnvelope {
  const id = localInteractionId(localId, interaction.id);
  const data: Omit<ApprovalResolvedData, 'decision'> & Partial<ApprovalResolvedData> = isRemoteQuestion(interaction)
    ? { approvalId: id, decision: 'decline', auto: true } : { approvalId: id, auto: true };
  return { session_id: localId, turn, call_id: id, event: 'remote.interaction.closed', ts, data: {},
    display: { type: 'interaction.resolved', data: data as ApprovalResolvedData } };
}

/** One mirrored history item as the display event a local row of the same
 *  kind renders from. Detail (wire.execution_detail_v1) fills command,
 *  file-change, tool and error rows; without it a row keeps what the item
 *  itself says under a readable label. File references stay relative to the
 *  remote worktree, so the rows open them only through the remote tree. */
export function remoteItemEvent(localId: string, item: RemoteTranscriptItem, detail?: ExecutionItemDetail): EventEnvelope {
  const base = { session_id: localId, turn: item.turn, call_id: item.id, ts: item.ts, data: {} };
  const activity = (display: ChatDisplay): EventEnvelope => ({ ...base, event: 'remote.activity', display });
  if (item.kind === 'user') return { ...base, event: 'user_message', data: { text: item.text,
    ...(item.attachments ? { attachments: item.attachments.map(file => ({ name: file.name, mime: file.mime, size: file.size,
      url: `/api/remote/sessions/${localId}/files/${encodeURIComponent(file.reference ?? file.id)}` })) } : {}) } };
  if (item.kind === 'assistant') return { ...base, event: 'remote.message', display: { type: 'message', data: { text: item.text, delta: item.delta, itemId: item.id } } };
  if (item.kind === 'turn-end') return { ...base, event: 'turn_completed', display: { type: 'state.turn-completed',
    data: { turnId: localRemoteTurnId(localId, item.turn), status: item.outcome === 'worked' ? 'completed' : item.outcome === 'stopped' ? 'stopped' : 'error' } } };
  if (item.kind === 'error') return { ...base, event: 'session_error', display: { type: 'state.error',
    data: { message: detail?.message ?? 'Remote execution failed', retryable: false } } };
  if (item.kind === 'command' && detail) {
    const output = detail.output ? remoteOutput(detail.output) : undefined;
    // A streamed row without the command line must not blank the one an
    // earlier row of this command set when a reload merges them.
    return activity({ type: 'activity.command', data: { ...(detail.command ? { command: detail.command } : {}),
      status: item.status, itemId: item.id, ...(item.exit_code !== undefined ? { exitCode: item.exit_code } : {}),
      ...(output === undefined ? {} : detail.output!.delta ? { stdoutDelta: output } : { stdout: output }) } as CommandExecutionData });
  }
  if (item.kind === 'file-change' && detail?.files) return activity({ type: 'activity.file-change', data: {
    files: detail.files.map(file => ({ path: file.reference, kind: file.change,
      ...(file.added !== undefined ? { added: file.added } : {}), ...(file.removed !== undefined ? { removed: file.removed } : {}) })),
    ...(detail.diff ? { diff: detail.diff } : {}) } });
  if (item.kind === 'tool') return activity({ type: 'activity.tool', data: { itemId: item.id, title: item.name, status: item.status,
    ...(detail?.input ? { input: detail.input } : {}), ...(detail?.output ? { output: remoteOutput(detail.output) } : {}) } });
  if (item.kind === 'classifier-denied') return activity({ type: 'activity.classifier-denied',
    data: { action: '', reason: '', consecutive: item.consecutive, total: item.total } });
  if (item.kind === 'circuit-breaker') return activity({ type: 'activity.circuit-breaker',
    data: { trigger: item.trigger, consecutive: item.consecutive, total: item.total } });
  return activity({ type: 'activity.notice', data: remoteActivityNotice(item) });
}

/** A Host cut this output to its tail; say so where the cut is. */
function remoteOutput(output: NonNullable<ExecutionItemDetail['output']>): string {
  return output.truncated ? `[earlier output truncated]\n${output.text}` : output.text;
}

/** A readable row for an item that arrived without detail. */
function remoteActivityNotice(item: Exclude<RemoteTranscriptItem,
  { kind: 'user' | 'assistant' | 'turn-end' | 'error' | 'tool' | 'classifier-denied' | 'circuit-breaker' }>): NoticeData {
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  switch (item.kind) {
    case 'command':
      return { severity: 'info', code: '', title: 'Ran a command', message: item.status === 'running' ? 'Running'
        : `${item.status === 'error' ? 'Failed' : 'Done'}${item.exit_code !== undefined ? ` · exit ${item.exit_code}` : ''}` };
    case 'file-change':
      return { severity: 'info', code: '', title: 'Changed files', message: plural(item.file_count, 'file', 'files') };
    case 'file-read':
      return { severity: 'info', code: '', title: 'Read a file', message: '' };
    case 'file-search':
      return { severity: 'info', code: '', title: item.search_kind === 'glob' ? 'Searched file names' : 'Searched file contents',
        message: item.match_count !== undefined ? plural(item.match_count, 'match', 'matches') : '' };
    case 'web-search':
      return { severity: 'info', code: '', title: 'Searched the web',
        message: item.result_count !== undefined ? plural(item.result_count, 'result', 'results') : '' };
    case 'agent':
      return { severity: item.status === 'error' ? 'warning' : 'info', code: '', title: 'Agent',
        message: [item.agent_type, item.status === 'running' ? 'Running' : item.status === 'done' ? 'Done' : 'Failed'].filter(Boolean).join(' · ') };
    case 'notice':
      return { severity: item.severity, code: '', title: 'Notice', message: item.code };
  }
}

export function remoteHistoryEvent(localId: string, entry: ExecutionHistoryEntry): EventEnvelope {
  if ('item' in entry) return remoteItemEvent(localId, entry.item, entry.detail);
  if ('interaction' in entry) return remoteInteractionEvent(localId, entry.interaction, entry.turn);
  const resolution = entry.resolution;
  const id = localInteractionId(localId, resolution.interaction_id);
  return { session_id: localId, turn: resolution.turn, call_id: id, event: 'remote.interaction.resolved',
    ts: resolution.ts, data: {}, display: { type: 'interaction.resolved',
      data: { approvalId: id, decision: resolution.decision, auto: resolution.auto,
        ...(resolution.answers ? { answers: resolution.answers } : {}) } } };
}
