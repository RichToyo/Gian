import { hostname } from 'node:os';
import {
  EXECUTION_HINT_COALESCE_MS,
  EXECUTION_HINT_HISTORY_COALESCE_MS,
  MAX_NAME_CHARS,
  PRESENCE_HEARTBEAT_MS,
  PRESENCE_LEASE_MS,
  RemoteProtocolError,
  cryptoAcceptPayload,
  cryptoOfferPayload,
  discoverServerIdentity,
  executionChangedSchema,
  exportPublicJwk,
  generateCanonicalId,
  generateP256KeyPair,
  importP256PublicKey,
  redactRemoteText,
  verifyBytes,
  type CanonicalEvent,
  type CommandRequest,
  type CryptoOffer,
  type RelayNotice,
  type RemoteAttention,
  type RemoteControlMessage,
  type RemoteStatePatch,
  type StatePatch,
  type AccountLoginStarted,
} from '@gian/remote-protocol';
import type { ServerToClientMessage, RemoteSettingsSnapshot, RemoteSettingsPairing } from '@gian/shared';
import { DEFAULT_TRANSLATION_PREFERENCES, OPENAI_TRANSLATION_AGENT_ID, type TranslationPreferences, type TranslationRecord } from '@gian/shared';
import { loadConfig } from '../storage/config.js';
import { PeerCryptoSession } from './crypto-session.js';
import type { GianToolAccessController } from '../tool/access.js';
import type { GianToolService } from '../tool/service.js';
import { ApprovalScopeError } from '../approval/manager.js';
import type { SessionManager } from '../session/manager.js';
import type { TaskManager } from '../task/manager.js';
import type { Db } from '../storage/db.js';
import type { TranslationNotification, TranslationService } from '../translation/service.js';
import { RemoteMutationAudit } from './audit.js';
import { RemoteAttachmentService } from './attachment-stream.js';
import { effectiveRemoteCapabilities } from './capability.js';
import { RemoteCommandAdapter } from './command-adapter.js';
import { RemoteDirectory } from './directory.js';
import { RemoteConnector, type RemotePeerTransport } from './connector.js';
import { RemoteDeviceStore, devicePublicKeyCanonical } from './device-store.js';
import type { RemoteDeviceRecord } from './device-store.js';
import {
  GENERIC_REMOTE_DEVICE_NAME,
  normalizeRemoteDeviceName,
  remoteDeviceDisplayName,
} from './device-label.js';
import { RemoteEnrollmentStore } from './enrollment.js';
import { RemoteFileRefService } from './file-ref.js';
import { HostRelaySocket } from './host-relay.js';
import type { RemoteIdentityMaterial } from './identity.js';
import { RemotePairingService, type RemotePairingRecord } from './pairing.js';
import {
  RemoteProjector,
  isRemoteSessionVisible,
  projectRemoteInteraction,
  projectRemoteTranslation,
  projectReadyTranslationState,
  remoteInteractionResourceId,
} from './projection.js';
import { RemoteReplayBuffer } from './replay-buffer.js';
import { HttpRemoteServerAuthClient } from './server-client.js';
import type { RemoteControllerAdmission } from './controller-client.js';
import { RemoteExecutionJournal } from './execution-journal.js';
import { conversationReferencesFile, conversationReferencesAttachment } from './file-references.js';

export interface RemoteRuntimeDeps {
  gitRead?: (params: unknown) => Promise<unknown>;
  db: Db;
  sessions: SessionManager;
  tasks: TaskManager;
  access: GianToolAccessController;
  tool: GianToolService;
  identity: RemoteIdentityMaterial;
  dataDir: string;
  hostVersion: string;
  hostName?: string;
  now?: () => Date;
  /** Host UI locale for state snapshots; defaults to the stored config. */
  locale?: () => 'en' | 'zh-CN';
  listAgents?: () => Array<{
    id: string;
    name?: string;
    proxy?: string;
    defaults?: { model?: string | null; thinking?: string | null };
  }>;
  hostEvents?: {
    onBroadcast(listener: (message: ServerToClientMessage) => void): () => void;
  };
  /** Branding bytes for one Proxy (manifest branding.logo), keyed by the
   *  proxy name Remote catalogs carry. Null when unknown. */
  proxyLogo?: (proxy: string, variant: 'light' | 'dark') => Promise<{
    bytes: Uint8Array;
    mediaType: 'image/png' | 'image/webp';
    sha256: string;
  } | null>;
  /** Conversation translation service (wire.conversation_translation). When
   *  absent, every translation command/field/event stays off the wire. */
  translation?: TranslationService;
  /** Live Host translation preferences; defaults to loadConfig at call time. */
  translationPreferences?: () => TranslationPreferences;
}

/** A heartbeat that failed while the relay stayed bound is retried after
 *  this, doubling up to the regular heartbeat interval. */
const HEARTBEAT_RETRY_MS = { first: 1000, max: PRESENCE_HEARTBEAT_MS };

/** A relay that could not connect or closed is rebuilt after this, doubling
 *  up to 10 s (plus up to 200 ms of jitter), like the controller's cap. */
const RELAY_RECONNECT_MS = { first: 500, max: 10_000 };

/** Server answers to a device revoke meaning nothing is left to revoke there. */
const REVOCATION_SETTLED_CODES: ReadonlySet<string> = new Set(['DEVICE_NOT_PAIRED', 'DEVICE_REVOKED', 'RESOURCE_NOT_FOUND']);

export class RemoteRuntime {
  readonly generation = generateCanonicalId();
  readonly devices: RemoteDeviceStore;
  readonly pairings: RemotePairingService;
  readonly enrollment: RemoteEnrollmentStore;
  readonly executions: RemoteExecutionJournal;
  readonly audit: RemoteMutationAudit;
  readonly attachments: RemoteAttachmentService;
  readonly fileRefs: RemoteFileRefService;
  readonly projector: RemoteProjector;
  readonly replay = new RemoteReplayBuffer();
  readonly commands: RemoteCommandAdapter;
  readonly directory: RemoteDirectory;
  private directoryHintQueued = false;
  /** Open execution.changed coalescing windows by exported session id. */
  private readonly executionHints = new Map<string, ExecutionHintWindow>();
  private readonly connectors = new Map<string, RemoteConnector>();
  private relay: HostRelaySocket | null = null;
  private authClient: HttpRemoteServerAuthClient | null = null;
  private accountLogin: { client: HttpRemoteServerAuthClient; started: AccountLoginStarted; serverUrl: string } | null = null;
  private accountState: RemoteSettingsSnapshot['account'] = null;
  private readonly identity: RemoteIdentityMaterial;
  private shuttingDown = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Heartbeats failed in a row while the relay stayed bound. */
  private heartbeatFailures = 0;
  /** When the Server last confirmed this Host's presence (relay bind or
   *  heartbeat), by the real clock. */
  private lastPresenceAt = 0;
  private pulsing: Promise<void> | null = null;
  /** The connector login in flight; each one rotates the refresh secret. */
  private loggingIn: { auth: HttpRemoteServerAuthClient; promise: Promise<void> } | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connecting: Promise<void> | null = null;
  private enrolling: { origin: string; attempt: Promise<{ host_id: string }> } | null = null;
  private connectionEpoch = 0;
  private lastHeartbeatAt: string | null = null;
  private heartbeatFailed = false;
  private displayGrant: { id: string; code: string; nonce: string } | null = null;
  private dismissedPairingId: string | null = null;
  private creatingPairing = false;
  private readonly decidingPairings = new Set<string>();
  private readonly revokingDevices = new Set<string>();
  private readonly hostName: string;
  private readonly hostVersion: string;
  private readonly sessions: SessionManager;
  private readonly tasks: TaskManager;
  private readonly db: Db;
  private readonly subscriptions = new Map<string, string>();
  /** Resource ids this process issued per session+provider id, so a removal
   *  reaches the exact turn-bound card even after the pending record is gone. */
  private readonly issuedInteractionIds = new Map<string, Set<string>>();
  private attention: RemoteAttention[] = [];
  private detachHostEvents: (() => void) | null = null;
  private detachTranslation: (() => void) | null = null;
  private readonly translationService: TranslationService | undefined;
  private readonly translationPreferences: () => TranslationPreferences;
  private translationHealthTimer: ReturnType<typeof setInterval> | null = null;
  private translationHealthPending = false;
  private translationHealthLast = '';
  private readonly clock: () => number;

  constructor(deps: RemoteRuntimeDeps) {
    this.clock = () => (deps.now?.() ?? new Date()).getTime();
    this.hostName = deps.hostName ?? (hostname().replace(/\.local$/i, '').trim().slice(0, MAX_NAME_CHARS) || 'Gian Host');
    this.hostVersion = deps.hostVersion;
    this.sessions = deps.sessions;
    this.tasks = deps.tasks;
    this.db = deps.db;
    this.devices = new RemoteDeviceStore(deps.db);
    this.pairings = new RemotePairingService(deps.db, this.devices, deps.now ?? (() => new Date()));
    this.identity = deps.identity;
    this.enrollment = new RemoteEnrollmentStore(deps.db, deps.identity);
    this.audit = new RemoteMutationAudit(deps.db);
    const sessionVisible = (sessionId: string, deviceId?: string): boolean => {
      try {
        if (deviceId && this.directory.negotiated(deviceId)) {
          const device = this.devices.getActive(deviceId);
          return !!device && this.directory.canAccess(sessionId, device);
        }
        const session = deps.sessions.getSession(sessionId);
        return isRemoteSessionVisible(deps.db, session)
          || Boolean(deps.db.prepare('SELECT 1 FROM remote_execution_exports WHERE session_id = ?').get(sessionId));
      } catch {
        return false;
      }
    };
    this.attachments = new RemoteAttachmentService(deps.db, deps.dataDir, sessionVisible);
    this.fileRefs = new RemoteFileRefService(deps.db, (sessionId, deviceId) => {
      try {
        if (!sessionVisible(sessionId, deviceId)) return null;
        const session = deps.sessions.getSession(sessionId);
        if (session.worktree_path) return session.worktree_path;
        const workspaceId = session.workspace_id;
        if (!workspaceId) return null;
        const row = deps.db.prepare('SELECT path FROM workspaces WHERE id = ?')
          .get(workspaceId) as { path: string } | undefined;
        return row?.path ?? null;
      } catch {
        return null;
      }
    }, sessionVisible, (sessionId, path) => conversationReferencesFile(deps.sessions.listEvents(sessionId), path),
    (sessionId, filename) => conversationReferencesAttachment(deps.sessions.listEvents(sessionId), sessionId, filename));
    const fallbackHostId = generateCanonicalId();
    const enrollment = this.enrollment;
    const hostName = this.hostName;
    const hostVersion = this.hostVersion;
    this.translationService = deps.translation;
    this.translationPreferences = deps.translationPreferences
      ?? (() => loadConfig(deps.db).translation ?? { ...DEFAULT_TRANSLATION_PREFERENCES });
    if (this.translationService) {
      this.translationHealthTimer = setInterval(() => this.pollTranslationHealth(), 10_000);
      this.translationHealthTimer.unref();
    }
    this.projector = new RemoteProjector({
      db: deps.db,
      sessions: deps.sessions,
      tasks: deps.tasks,
      hostGeneration: this.generation,
      host: {
        get id() {
          return enrollment.current()?.hostId ?? fallbackHostId;
        },
        get name() {
          return enrollment.current()?.hostName ?? hostName;
        },
        version: hostVersion,
      },
      listAgents: deps.listAgents,
      attachments: this.attachments,
      fileRefs: this.fileRefs,
      ...(deps.translation ? { translations: deps.translation } : {}),
      workspacePath: sessionId => {
        try {
          const session = deps.sessions.getSession(sessionId);
          if (session.worktree_path) return session.worktree_path;
          const workspaceId = session.workspace_id;
          if (!workspaceId) return null;
          const row = deps.db.prepare('SELECT path FROM workspaces WHERE id = ?')
            .get(workspaceId) as { path: string } | undefined;
          return row?.path ?? null;
        } catch {
          return null;
        }
      },
    });
    this.executions = new RemoteExecutionJournal(deps.db, deps.sessions, this.projector, () => {
      const current = enrollment.current();
      return current ? {
        server_origin: current.serverUrl,
        server_identity_fingerprint: current.serverIdentityFingerprint,
        host_id: current.hostId,
      } : null;
    }, sessionId => this.executionChanged(sessionId));
    this.directory = new RemoteDirectory({ db: deps.db, sessions: deps.sessions, devices: this.devices,
      executions: this.executions,
      hostGeneration: this.generation, now: () => deps.now?.().getTime() ?? Date.now(),
      negotiated: deviceId => this.connectors.get(deviceId)?.supportsFeature('wire.session_directory_v1') === true });
    this.commands = new RemoteCommandAdapter({
      gitRead: deps.gitRead,
      executions: this.executions,
      db: deps.db,
      access: deps.access,
      tool: deps.tool,
      sessions: deps.sessions,
      projector: this.projector,
      attachments: this.attachments,
      fileRefs: this.fileRefs,
      audit: this.audit,
      hostGeneration: this.generation,
      directory: this.directory,
      pushSnapshotParts: async (deviceId, part) => {
        await this.connectors.get(deviceId)?.sendControl(part);
      },
      listAgents: deps.listAgents,
      snapshot: (device, options) => {
        // Cards delivered by a snapshot never passed publishInteraction, so
        // register their exact turn-bound ids here as well — otherwise a
        // pending that predates this runtime could never be removed precisely.
        this.registerIssuedInteractions();
        return this.projector.snapshot({
          capabilities: effectiveRemoteCapabilities({
            device,
            hostOnline: true,
            wireFeatures: ['wire.snapshot_parts', 'wire.content_resume'],
          }),
          attention: this.attention,
          deviceId: device.id,
          eventSequence: this.replay.eventSequence,
          // `locale` rides the snapshot only for connections that negotiated
          // `wire.host_locale`; older clients parse the snapshot closed.
          ...(options.wireFeatures.includes('wire.host_locale')
            ? { locale: (deps.locale ?? (() => loadConfig(deps.db).locale))() }
            : {}),
        });
      },
      onSubscribe: (deviceId, sessionId) => this.subscriptions.set(deviceId, sessionId),
      proxyLogo: deps.proxyLogo,
      ...(deps.translation ? { translation: deps.translation } : {}),
      translationPreferences: this.translationPreferences,
      onTranslationSettled: (sessionId, requestId, outcome) => this.publishTranslationSettled(sessionId, requestId, outcome),
    });
    this.detachTranslation = deps.translation?.subscribe(notification => {
      this.publishTranslationNotification(notification);
    }) ?? null;
    this.detachHostEvents = deps.hostEvents?.onBroadcast(message => {
      if (message.type === 'event') this.executions.append(message);
      // A release (turn end, Stop recovery, Proxy exit or fault) settles a
      // pending card as an automatic decline without any Provider event.
      if (message.type === 'approval:updated' && message.approval.session_id
        && message.approval.status === 'declined' && message.approval.resolved_by === 'auto') {
        this.executions.closeReleased(message.approval.session_id, message.approval.id);
      }
      this.observeHostBroadcast(message);
    }) ?? null;
  }

  get relaySocket(): HostRelaySocket | null {
    return this.relay;
  }

  async enroll(input: { serverUrl: string; enrollmentToken: string; publicUrl?: string; hostName?: string }): Promise<{ host_id: string }> {
    const origin = remoteOrigin(input.serverUrl);
    const current = this.enrollment.current();
    if (current || this.enrolling) {
      // The same Server again is a retry of an attempt that went through, or
      // is still going, after its answer was lost or late: that attempt's
      // result. Another Server stays refused until this one is disconnected.
      if (current?.serverUrl === origin) return { host_id: current.hostId };
      if (!current && this.enrolling?.origin === origin) return this.enrolling.attempt;
      throw new Error('already_enrolled');
    }
    const attempt = this.enrollOnce(input);
    this.enrolling = { origin, attempt };
    try { return await attempt; } finally { this.enrolling = null; }
  }

  async controllerAdmission(serverUrl: string): Promise<RemoteControllerAdmission> {
    const origin = remoteOrigin(serverUrl);
    const enrolled = this.enrollment.current();
    if (!enrolled || enrolled.serverUrl !== origin || enrolled.pendingIdentityFingerprint) {
      throw new RemoteProtocolError('CONTROLLER_NOT_ADMITTED', 'local Server admission required');
    }
    const discovered = await discoverServerIdentity({
      origin,
      pinnedFingerprint: enrolled.serverIdentityFingerprint,
    });
    const auth = new HttpRemoteServerAuthClient(origin, this.identity);
    const login = () => auth.controllerLogin(enrolled.hostId, bytes => this.identity.sign(bytes));
    let access: Awaited<ReturnType<typeof login>>;
    try {
      access = await login();
    } catch (error) {
      if (!(error instanceof RemoteProtocolError) || error.code !== 'CONTROLLER_NOT_ADMITTED') throw error;
      await this.ensureRelay();
      const claimed = await this.withConnectorAccess(auth => auth.claimHostController('macOS'));
      if (claimed.browser_installation_id !== enrolled.hostId
        || claimed.server_identity.fingerprint !== discovered.fingerprint) {
        throw new RemoteProtocolError('AUTH_REQUIRED', 'controller admission identity changed');
      }
      access = await login();
    }
    return {
      installationId: enrolled.hostId,
      accessToken: access.controller_access_token,
      serverIdentityFingerprint: discovered.fingerprint,
      hostIdentity: true,
    };
  }

  async startAccountLogin(serverUrl: string): Promise<void> {
    const origin = remoteOrigin(serverUrl);
    const enrolled = this.enrollment.current();
    if (enrolled && enrolled.serverUrl !== origin) throw new Error('invalid_url');
    const client = new HttpRemoteServerAuthClient(origin, this.identity);
    const saved = await client.existingAccount('host');
    if (saved) {
      if (enrolled && enrolled.serverIdentityFingerprint !== saved.serverFingerprint) throw new Error('identity_changed');
      this.accountLogin = null;
      this.accountState = { status: 'authorized', server_url: origin, login: saved.accountLogin, expires_at: saved.expiresAt };
      return;
    }
    const started = await client.startAccountLogin('host');
    if (enrolled && enrolled.serverIdentityFingerprint !== started.challenge.server_identity_fingerprint) {
      throw new Error('identity_changed');
    }
    this.accountLogin = { client, started, serverUrl: origin };
    this.accountState = { status: 'pending', server_url: origin, user_code: started.user_code,
      verification_uri: started.verification_uri, expires_at: started.expires_at, interval_seconds: started.interval_seconds };
  }

  async pollAccountLogin(): Promise<void> {
    const pending = this.accountLogin;
    if (!pending) return;
    const result = await pending.client.pollAccountLogin(pending.started);
    if (pending !== this.accountLogin) return;
    if (result.status === 'pending') {
      if (this.accountState) this.accountState.interval_seconds = result.interval_seconds;
      return;
    }
    this.accountLogin = null;
    this.accountState = { status: result.status, server_url: pending.serverUrl,
      expires_at: result.status === 'authorized' ? result.expires_at : Date.now(),
      ...(result.status === 'authorized' ? { login: result.account.login } : {}) };
    if (result.status === 'authorized' && this.enrollment.current()) {
      this.authClient = pending.client;
    }
  }

  private async enrollOnce(input: { serverUrl: string; enrollmentToken: string; publicUrl?: string; hostName?: string }): Promise<{ host_id: string }> {
    const epoch = this.connectionEpoch;
    const serverUrl = remoteOrigin(input.serverUrl);
    const publicUrl = input.publicUrl ? remoteOrigin(input.publicUrl) : serverUrl;
    const hostName = (input.hostName?.trim().slice(0, MAX_NAME_CHARS) ?? '') || this.hostName;
    const identity = await this.identity.ensurePublic();
    const auth = new HttpRemoteServerAuthClient(serverUrl, this.identity, undefined, undefined, this.clock);
    const discovered = await discoverServerIdentity({ origin: serverUrl });
    const claimed = await auth.claimEnrollment({
      enrollmentToken: input.enrollmentToken,
      hostName,
      hostVersion: this.hostVersion,
      hostPublicKey: identity.public_key,
    });
    if (claimed.server_identity.fingerprint !== discovered.fingerprint) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity changed');
    }
    if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    await this.enrollment.recordClaim({
      hostId: claimed.host_id,
      serverUrl,
      serverIdentity: claimed.server_identity,
      hostName,
      refreshSecret: claimed.connector_refresh_secret,
    });
    if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    this.enrollment.setPublicUrl(publicUrl);
    this.authClient = auth;
    // Enrollment is stored: answer now. The relay connect takes several more
    // Server round trips and identity broker calls; it retries on its own
    // through scheduleReconnect, and Settings polls the live link state.
    void this.start().catch(() => this.scheduleReconnect());
    return { host_id: claimed.host_id };
  }

  async start(): Promise<void> {
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint) return;
    if (this.relay?.bound) return;
    this.shuttingDown = false;
    // Source previews start Host before Desktop's identity broker. Arm
    // recovery before the first broker request, including account lookup.
    this.startHeartbeat();
    try {
      await this.connectRelay();
      if (!this.relay?.bound && this.enrollment.current()?.serverUrl) {
        this.scheduleReconnect();
      }
    } catch {
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    this.enrollment.setEnabled(false);
    this.stopConnection();
  }

  async reconnect(): Promise<void> {
    if (!this.enrollment.current()) throw new Error('not_enrolled');
    if (this.enrollment.current()?.pendingIdentityFingerprint) throw new Error('identity_changed');
    this.enrollment.setEnabled(true);
    await this.start();
  }

  setPublicUrl(url: string): void {
    if (!this.enrollment.current()) throw new Error('not_enrolled');
    this.enrollment.setPublicUrl(remoteOrigin(url));
  }

  async setHostName(name: string): Promise<void> {
    const next = name.trim();
    if (!next || next.length > MAX_NAME_CHARS) throw new Error('invalid_host_name');
    const enrollment = this.enrollment.current();
    if (!enrollment) throw new Error('not_enrolled');
    const epoch = this.connectionEpoch;
    await this.ensureRelay();
    const checkCurrent = () => {
      if (epoch !== this.connectionEpoch || this.enrollment.current()?.hostId !== enrollment.hostId) {
        throw new Error('connection_cancelled');
      }
    };
    checkCurrent();
    await this.withConnectorAccess(auth => auth.renameHost(next));
    checkCurrent();
    this.enrollment.setHostName(next);
    this.fanout({ type: 'snapshot.required', reason: 'revision_mismatch' });
  }

  renameDevice(deviceId: string, name: string): RemoteDeviceRecord {
    return this.devices.rename(deviceId, normalizeRemoteDeviceName(name));
  }

  async disableRemote(): Promise<void> {
    this.disconnect();
    // Fence late network/identity writes before dropping the saved credential.
    await Promise.allSettled([this.connecting, this.enrolling?.attempt].filter(Boolean));
    for (const device of this.devices.list()) this.devices.revoke(device.id);
    this.pairings.clear();
    this.displayGrant = null;
    // The existing broker treats an empty secret as absent.
    await this.identity.setRefreshSecret('');
    this.enrollment.clear();
  }

  async confirmServerIdentityChange(expectedFingerprint: string): Promise<void> {
    if (this.enrollment.current()?.pendingIdentityFingerprint !== expectedFingerprint) {
      throw new Error('identity_changed');
    }
    this.enrollment.confirmServerIdentityChange();
    await this.reconnect();
  }

  rejectServerIdentityChange(): void {
    this.disconnect();
    this.enrollment.rejectServerIdentityChange();
  }

  async revokeDevice(deviceId: string, options?: { notifyServer?: boolean }): Promise<RemoteDeviceRecord> {
    const device = this.devices.revoke(deviceId);
    this.releaseDevice(deviceId);
    if (options?.notifyServer === false) this.devices.markRevocationSynced(deviceId);
    if (options?.notifyServer !== false) {
      this.revokingDevices.add(deviceId);
      try {
        if (!this.authClient) await this.connectRelay();
        await this.syncRevocation(deviceId);
      } catch {
        // Host remains the authority even if Server is unreachable.
      } finally {
        this.revokingDevices.delete(deviceId);
      }
    }
    return device;
  }

  /** Close a revoked record's connection and drop what it was subscribed to
   *  or referenced. */
  private releaseDevice(deviceId: string): void {
    this.connectors.get(deviceId)?.close();
    this.connectors.delete(deviceId);
    this.subscriptions.delete(deviceId);
    this.fileRefs.invalidateDevice(deviceId);
    this.attachments.invalidateDevice(deviceId);
  }

  async createPairingGrant(): Promise<{
    pairing_id: string;
    grant_id: string;
    code: string;
    grant_nonce: string;
    expires_at: string;
  }> {
    if (this.creatingPairing) throw new Error('pairing_busy');
    this.creatingPairing = true;
    const epoch = this.connectionEpoch;
    try {
      await this.ensureRelay();
      for (const pending of this.pairings.listPending()) await this.cancelPairing(pending.id);
      const grant = await this.withConnectorAccess(auth => auth.createPairing());
      if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
      const pairing = this.pairings.recordServerGrant({
        grantId: grant.grant_id,
        code: grant.code,
        grantNonce: grant.grant_nonce,
        expiresAt: grant.expires_at,
      });
      this.displayGrant = { id: pairing.id, code: grant.code, nonce: grant.grant_nonce };
      this.dismissedPairingId = null;
      return {
        pairing_id: pairing.id,
        grant_id: grant.grant_id,
        code: grant.code,
        grant_nonce: grant.grant_nonce,
        expires_at: pairing.expiresAt,
      };
    } finally {
      this.creatingPairing = false;
    }
  }

  async cancelPairing(pairingId: string): Promise<void> {
    const pairing = this.pairings.get(pairingId);
    if (!pairing) throw new Error('pairing_not_found');
    if (this.decidingPairings.has(pairing.id)) throw new Error('pairing_busy');
    if (pairing.status === 'pending_claim' || pairing.status === 'pending_confirmation') {
      this.pairings.reject(pairing.id);
      const serverPairingId = pairing.serverPairingId;
      if (serverPairingId && this.authClient) {
        await this.withConnectorAccess(auth => auth.confirmPairing(serverPairingId, 'reject')).catch(() => undefined);
      }
    }
    this.displayGrant = null;
    this.dismissedPairingId = pairing.id;
  }

  async confirmPairing(pairingId: string, decision: 'confirm' | 'reject'): Promise<{
    pairing_id: string;
    status: string;
    device_id?: string;
  }> {
    if (this.decidingPairings.has(pairingId)) throw new Error('pairing_busy');
    this.decidingPairings.add(pairingId);
    const epoch = this.connectionEpoch;
    try {
      await this.ensureRelay();
      const local = this.pairings.get(pairingId);
      if (!local || local.status !== 'pending_confirmation' || !local.devicePublicKey) {
        throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'pairing is not waiting for confirmation');
      }
      const serverId = local.serverPairingId ?? pairingId;
      const result = await this.withConnectorAccess(auth => auth.confirmPairing(serverId, decision));
      if (epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
      if (decision === 'reject') {
        this.pairings.reject(local.id);
        return { pairing_id: local.id, status: 'rejected' };
      }
      if (!local.devicePublicKey || !result.device_id) {
        throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'pairing confirm did not create a device');
      }
      const publicKey = local.devicePublicKey;
      const deviceId = result.device_id;
      // Re-pairing a key that is still paired supersedes its record, so the
      // key keeps exactly one active record. Its exported sessions follow the
      // key to the new record.
      const { device, superseded } = this.db.transaction(() => {
        const replaced = this.devices.replaceGeneration({
          id: deviceId,
          publicKey,
          name: remoteDeviceDisplayName({
            name: local.deviceName,
            platform: local.platform,
            userAgent: local.userAgent,
          }),
          platform: local.platform ?? 'unknown',
          cryptoConnectionId: result.crypto_connection_id,
        });
        if (local.accountId) this.devices.bindAccount(replaced.device.id, local.accountId);
        this.pairings.confirm(local.id, replaced.device.id);
        return replaced;
      })();
      if (superseded) this.releaseDevice(superseded.id);
      return { pairing_id: local.id, status: 'confirmed', device_id: device.id };
    } finally {
      this.decidingPairings.delete(pairingId);
    }
  }

  connectDevice(
    device: RemoteDeviceRecord,
    crypto: PeerCryptoSession,
    transport?: RemotePeerTransport,
  ): RemoteConnector {
    this.connectors.get(device.id)?.close();
    const route = transport ?? this.relay?.attachDevice(device.id);
    if (!route) {
      throw new Error('Host relay is not connected');
    }
    const requiresAccount = this.enrollment.current() !== null;
    const connector = new RemoteConnector(
      route,
      crypto,
      this.replay,
      (record, command: CommandRequest, hooks) => {
        const live = this.devices.get(record.id) ?? record;
        return this.commands.execute(hooks?.wireFeatures?.includes('wire.session_directory_v1') ? record : live, command, hooks);
      },
      device,
      this.authClient ?? undefined,
      this.enrollment.current()?.hostId,
      {
        authorize: async () => {
          if (this.directory.negotiated(device.id)) this.directory.currentDevice(device);
          if (requiresAccount) await this.authorizeDeviceAccount(device);
        },
        attachments: this.attachments,
        hostVersion: this.hostVersion,
        fileRefs: this.fileRefs,
        transcriptPage: (sessionId, deviceId, options) => {
          if (!this.connectionSessionVisible(sessionId, deviceId)) return null;
          return this.projector.transcriptPage(sessionId, 3, {
            deviceId,
            includeTranslations: options?.wireFeatures?.includes('wire.conversation_translation') === true,
          });
        },
        ...(this.translationService ? {
          translationState: async (sessionId: string, deviceId: string) => {
            if (!this.connectionSessionVisible(sessionId, deviceId)) return null;
            if (this.translationExport(sessionId)) return null;
            const state = await projectReadyTranslationState(this.translationService!, sessionId, this.translationPreferences);
            return this.connectionSessionVisible(sessionId, deviceId) && !this.translationExport(sessionId) ? state : null;
          },
        } : {}),
      },
    );
    this.connectors.set(device.id, connector);
    return connector;
  }

  connectorFor(deviceId: string): RemoteConnector | undefined {
    return this.connectors.get(deviceId);
  }

  private async authorizeDeviceAccount(device: RemoteDeviceRecord): Promise<void> {
    const active = this.devices.getActive(device.id);
    if (!active || active.publicKey !== device.publicKey) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'device key is not admitted');
    }
  }

  private async ensureRelay(): Promise<void> {
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Remote connection is disabled or awaiting identity confirmation');
    }
    if (this.relay?.bound && this.authClient) return;
    await this.start();
    if (!this.relay?.bound || !this.authClient) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
    }
  }

  private async connectRelay(): Promise<void> {
    if (this.connecting) return this.connecting;
    const run = this.connectRelayOnce().finally(() => {
      if (this.connecting === run) this.connecting = null;
    });
    this.connecting = run;
    return run;
  }

  private async connectRelayOnce(): Promise<void> {
    const epoch = this.connectionEpoch;
    const checkCurrent = () => {
      if (this.shuttingDown || epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    };
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint || this.shuttingDown) return;
    const account = await this.identity.getAccountSession?.(enrollment.serverUrl, 'host');
    checkCurrent();
    if (account && account.expiresAt > Date.now()) {
      this.accountState = { status: 'authorized', server_url: enrollment.serverUrl, expires_at: account.expiresAt, login: account.accountLogin };
    }
    const discovered = await discoverServerIdentity({
      origin: enrollment.serverUrl,
      pinnedFingerprint: enrollment.serverIdentityFingerprint,
    });
    if (discovered.fingerprint !== enrollment.serverIdentityFingerprint) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity changed');
    }
    checkCurrent();
    const refreshSecret = await this.identity.getRefreshSecret();
    checkCurrent();
    if (!enrollment?.serverUrl || !refreshSecret) return;
    const auth = this.authClient
      ?? new HttpRemoteServerAuthClient(enrollment.serverUrl, this.identity, undefined, undefined, this.clock);
    await this.connectorLogin(auth);
    checkCurrent();
    const ticket = await auth.hostWsTicket();
    checkCurrent();
    const wsUrl = `${enrollment.serverUrl.replace(/^http/i, 'ws').replace(/\/$/, '')}/ws`;
    this.authClient = auth;
    this.relay?.close('replaced');
    const relay = await HostRelaySocket.connect({ url: wsUrl, ticket });
    if (this.shuttingDown || epoch !== this.connectionEpoch) {
      relay.close('connection_cancelled');
      return;
    }
    this.relay = relay;
    this.lastHeartbeatAt = new Date().toISOString();
    this.lastPresenceAt = Date.now();
    this.heartbeatFailed = false;
    this.heartbeatFailures = 0;
    this.clearHeartbeatRetry();
    this.relay.onNotice((notice) => this.handleNotice(notice));
    this.relay.onHandshake((offer) => {
      void this.acceptHandshake(offer).catch((error) => {
        console.error('[remote] handshake accept failed', error);
      });
    });
    this.relay.onClose((reason) => {
      if (this.relay === relay) this.relay = null;
      // Crypto sessions belong to the dead socket; keeping them would make
      // fanout drop frames silently until the next handshake replaced them.
      for (const connector of this.connectors.values()) connector.close();
      this.connectors.clear();
      if (this.shuttingDown || reason === 'replaced') return;
      this.scheduleReconnect();
    });
    this.reconnectAttempts = 0;
    await this.syncRevokedDevices();
  }

  async maintainPresence(): Promise<void> {
    await this.pulse();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.pulse();
    }, PRESENCE_HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private pulse(): Promise<void> {
    if (this.pulsing) return this.pulsing;
    const run = this.pulseOnce().finally(() => {
      if (this.pulsing === run) this.pulsing = null;
    });
    this.pulsing = run;
    return run;
  }

  private async pulseOnce(): Promise<void> {
    if (this.shuttingDown) return;
    const enrollment = this.enrollment.current();
    if (!enrollment?.serverUrl || !enrollment.connectorEnabled || enrollment.pendingIdentityFingerprint) return;
    // No relay, or the Server has not heard from this Host for longer than
    // its presence lease (this Mac slept, or every retry failed): it dropped
    // this Host's presence and may hold a dead socket for it. Build anew.
    if (!this.relay?.bound || !this.authClient || Date.now() - this.lastPresenceAt > PRESENCE_LEASE_MS) {
      await this.rebuildRelay();
      return;
    }
    try {
      await this.withConnectorAccess(auth => auth.heartbeat(enrollment.hostId));
    } catch (error) {
      this.heartbeatFailed = true;
      if (this.shuttingDown) return;
      // Refused even after a fresh login: the Server no longer accepts this
      // Host as enrolled and alive.
      if (error instanceof RemoteProtocolError && error.code === 'AUTH_REQUIRED') {
        await this.rebuildRelay();
        return;
      }
      // Network, Server or rate-limit trouble while the relay is still bound:
      // keep it, and every device session on it, and try again soon.
      this.scheduleHeartbeatRetry();
      return;
    }
    if (this.shuttingDown) return;
    this.lastHeartbeatAt = new Date().toISOString();
    this.lastPresenceAt = Date.now();
    this.heartbeatFailed = false;
    this.heartbeatFailures = 0;
    this.clearHeartbeatRetry();
    await this.syncRevokedDevices();
  }

  private async rebuildRelay(): Promise<void> {
    try {
      await this.connectRelay();
    } catch {
      this.scheduleReconnect();
    }
  }

  private scheduleHeartbeatRetry(): void {
    if (this.shuttingDown || this.heartbeatRetryTimer) return;
    const delay = Math.min(HEARTBEAT_RETRY_MS.max, HEARTBEAT_RETRY_MS.first * (2 ** this.heartbeatFailures))
      + Math.floor(Math.random() * 200);
    this.heartbeatFailures += 1;
    this.heartbeatRetryTimer = setTimeout(() => {
      this.heartbeatRetryTimer = null;
      void this.pulse();
    }, delay);
    this.heartbeatRetryTimer.unref?.();
  }

  private clearHeartbeatRetry(): void {
    if (this.heartbeatRetryTimer) clearTimeout(this.heartbeatRetryTimer);
    this.heartbeatRetryTimer = null;
  }

  /**
   * Run one Host→Server call with a live connector token. A token near its
   * expiry is renewed first; an AUTH_REQUIRED answer to an older token logs
   * in again and retries the call once. Renewal never touches the relay: the
   * Server authenticated that socket once, by its single-use ws ticket, and
   * afterwards only checks that this Host's key is still admitted, so the
   * socket and every device session on it stay up.
   */
  private async withConnectorAccess<T>(call: (auth: HttpRemoteServerAuthClient) => Promise<T>): Promise<T> {
    const auth = this.authClient;
    if (!auth) throw new RemoteProtocolError('HOST_OFFLINE', 'Host relay is not connected');
    const renewed = !auth.accessTokenFresh();
    if (renewed) await this.connectorLogin(auth);
    try {
      return await call(auth);
    } catch (error) {
      if (renewed || !(error instanceof RemoteProtocolError) || error.code !== 'AUTH_REQUIRED') throw error;
      await this.connectorLogin(auth);
      return call(auth);
    }
  }

  /** Log the connector in for a fresh access token, after checking the
   *  Server's signed proof against the pinned identity. Callers share the
   *  login in flight: each one rotates the refresh secret. */
  private connectorLogin(auth: HttpRemoteServerAuthClient): Promise<void> {
    if (this.loggingIn?.auth === auth) return this.loggingIn.promise;
    const promise = this.connectorLoginOnce(auth).finally(() => {
      if (this.loggingIn?.promise === promise) this.loggingIn = null;
    });
    this.loggingIn = { auth, promise };
    return promise;
  }

  private async connectorLoginOnce(auth: HttpRemoteServerAuthClient): Promise<void> {
    const epoch = this.connectionEpoch;
    const checkCurrent = () => {
      if (this.shuttingDown || epoch !== this.connectionEpoch) throw new Error('connection_cancelled');
    };
    const enrollment = this.enrollment.current();
    if (!enrollment?.connectorEnabled || enrollment.pendingIdentityFingerprint) {
      throw new RemoteProtocolError('HOST_OFFLINE', 'Remote connection is disabled or awaiting identity confirmation');
    }
    const refreshSecret = await this.identity.getRefreshSecret();
    checkCurrent();
    if (!refreshSecret) throw new RemoteProtocolError('AUTH_REQUIRED', 'Host connector credential is missing');
    const challenge = await auth.challenge(enrollment.hostId);
    checkCurrent();
    if (challenge.server_identity.fingerprint !== enrollment.serverIdentityFingerprint
      || challenge.server_identity_fingerprint !== enrollment.serverIdentityFingerprint) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity changed');
    }
    await this.enrollment.verifySignedChallenge({
      hostId: enrollment.hostId,
      challengeId: challenge.challenge_id,
      challenge: challenge.challenge,
      expiresAt: challenge.expires_at,
      serverIdentity: challenge.server_identity,
      signature: challenge.server_identity_signature,
    });
    checkCurrent();
    const signature = await this.identity.sign(new TextEncoder().encode(challenge.challenge_id));
    checkCurrent();
    await auth.login({
      hostId: enrollment.hostId,
      challengeId: challenge.challenge_id,
      signature,
      refreshSecret: (await this.identity.getRefreshSecret()) ?? refreshSecret,
    });
    checkCurrent();
  }

  /** Retry every revocation the Server has not settled yet. Runs on each
   *  relay connect and after each heartbeat. */
  private async syncRevokedDevices(): Promise<void> {
    if (!this.authClient) return;
    for (const device of this.devices.list()) {
      if (!device.revokedAt || this.devices.revocationSynced(device.id)) continue;
      try {
        await this.syncRevocation(device.id);
      } catch {
        // Server unreachable or refusing for now; the next connect retries.
      }
    }
  }

  /** Tell the Server a device is revoked. An answer that it holds no live
   *  pairing under that id for this Host settles the revocation as well: a
   *  re-pair replaced it (the Server deletes the old row) or it is already
   *  revoked. An expired connector token is AUTH_REQUIRED instead, which
   *  withConnectorAccess logs in again for; it never settles anything. */
  private async syncRevocation(deviceId: string): Promise<void> {
    try {
      await this.withConnectorAccess(auth => auth.revokeDevice(deviceId));
    } catch (error) {
      if (!(error instanceof RemoteProtocolError) || !REVOCATION_SETTLED_CODES.has(error.code)) throw error;
    }
    this.devices.markRevocationSynced(deviceId);
  }

  private scheduleReconnect(): void {
    if (this.shuttingDown || this.reconnectTimer || this.enrollment.current()?.pendingIdentityFingerprint) return;
    const delay = Math.min(RELAY_RECONNECT_MS.max, RELAY_RECONNECT_MS.first * (2 ** this.reconnectAttempts))
      + Math.floor(Math.random() * 200);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectRelay().catch(() => this.scheduleReconnect());
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async acceptHandshake(offer: CryptoOffer): Promise<void> {
    if (!this.relay) return;
    const device = this.devices.getActive(offer.device_id);
    if (!device) return;
    if (!device.cryptoConnectionId || device.cryptoConnectionId !== offer.crypto_connection_id) return;
    if (devicePublicKeyCanonical(offer.device_identity) !== device.publicKey) return;
    const enrollment = this.enrollment.current();
    if (!enrollment || enrollment.hostId !== offer.host_id) return;
    await this.authorizeDeviceAccount(device);
    const deviceKey = await importP256PublicKey(JSON.parse(device.publicKey) as {
      kty: 'EC'; crv: 'P-256'; x: string; y: string;
    }, 'verify');
    const offerOk = await verifyBytes(
      deviceKey,
      new TextEncoder().encode(cryptoOfferPayload({
        host_id: offer.host_id,
        device_id: offer.device_id,
        crypto_connection_id: offer.crypto_connection_id,
        handshake_nonce: offer.handshake_nonce,
        sent_at: offer.sent_at,
        device_identity: offer.device_identity,
        device_ephemeral: offer.device_ephemeral,
      })),
      Buffer.from(offer.signature, 'base64url'),
    );
    if (!offerOk) return;
    if (!this.pairings.consumeHandshakeNonce({
      handshakeNonce: offer.handshake_nonce,
      deviceId: offer.device_id,
      signedAt: offer.sent_at,
    })) {
      return;
    }
    const hostIdentity = await this.identity.ensurePublic();
    const ephemeral = await generateP256KeyPair();
    const hostEphemeral = await exportPublicJwk(ephemeral.publicKey);
    const sentAt = Date.now();
    const acceptFields = {
      host_id: offer.host_id,
      device_id: offer.device_id,
      crypto_connection_id: offer.crypto_connection_id,
      handshake_nonce: offer.handshake_nonce,
      sent_at: sentAt,
      host_generation: this.generation,
      host_identity: hostIdentity.public_key,
      device_identity: offer.device_identity,
      host_ephemeral: hostEphemeral,
      device_ephemeral: offer.device_ephemeral,
    };
    const crypto = await PeerCryptoSession.fromHandshake({
      localPrivate: ephemeral.privateKey,
      remotePublic: await importP256PublicKey(offer.device_ephemeral, 'deriveBits'),
      transcript: {
        host_identity: hostIdentity.public_key,
        device_identity: offer.device_identity,
        host_ephemeral: hostEphemeral,
        device_ephemeral: offer.device_ephemeral,
        connection_id: offer.crypto_connection_id,
      },
      sendDirection: 'host_to_device',
      binding: {
        hostGeneration: this.generation,
        hostId: offer.host_id,
        deviceId: offer.device_id,
        routeId: offer.device_id,
        connectionId: offer.crypto_connection_id,
      },
    });
    // Sign BEFORE attaching: when the identity broker is unreachable the
    // accept never ships, and an already-attached connector would keep
    // soaking up Host pushes on a route the Server never crypto-bound (they
    // bounce back as route.not_bound and the device sees nothing live).
    const signature = await this.identity.sign(new TextEncoder().encode(cryptoAcceptPayload(acceptFields)));
    const connector = this.connectDevice(device, crypto);
    try {
      this.relay.sendHandshake({
        protocol: 'gian.relay/1',
        type: 'crypto.accept',
        host_id: acceptFields.host_id,
        device_id: acceptFields.device_id,
        crypto_connection_id: acceptFields.crypto_connection_id,
        handshake_nonce: acceptFields.handshake_nonce,
        host_generation: acceptFields.host_generation,
        host_identity: acceptFields.host_identity,
        host_ephemeral: acceptFields.host_ephemeral,
        device_ephemeral: acceptFields.device_ephemeral,
        signature,
        sent_at: sentAt,
      });
    } catch (error) {
      connector.close();
      this.connectors.delete(device.id);
      throw error;
    }
    connector.scheduleInitialSnapshot();
  }

  private handleNotice(notice: RelayNotice): void {
    if (notice.type === 'route.not_bound') {
      if (notice.device_id) {
        console.error('[remote] relay rejected frames for a stale route; dropping it', notice.device_id);
        this.relay?.dropRoute(notice.device_id);
      }
      return;
    }
    if (notice.type === 'pairing.claimed' && notice.grant_id && notice.pairing_id && notice.device_public_key) {
      try {
      this.pairings.applyServerClaim({
        accountId: notice.account_id,
        grantId: notice.grant_id,
        pairingId: notice.pairing_id,
        publicKey: notice.device_public_key,
        platform: notice.platform,
        userAgent: notice.user_agent,
        name: notice.device_name,
      });
      } catch {
        // A delayed claim must never revive a locally cancelled/expired grant.
        const pairingId = notice.pairing_id;
        if (this.authClient) void this.withConnectorAccess(auth => auth.confirmPairing(pairingId, 'reject')).catch(() => undefined);
      }
      return;
    }
    if (notice.type === 'device.revoked' && notice.device_id) {
      void this.handleSignedSelfRevoke(notice);
    }
  }

  private async handleSignedSelfRevoke(notice: RelayNotice): Promise<void> {
    if (
      !notice.device_id
      || !notice.signature
      || !notice.signed_at
      || !notice.device_public_key
    ) {
      return;
    }
    try {
      await this.pairings.applySignedSelfRevoke({
        deviceId: notice.device_id,
        hostId: notice.host_id,
        signedAt: notice.signed_at,
        signature: notice.signature,
        publicKey: notice.device_public_key,
      });
      await this.revokeDevice(notice.device_id, { notifyServer: false });
      this.relay?.ackRevoked(notice);
    } catch {
      // Unsigned or invalid notices must not permanently revoke.
    }
  }

  observeHostBroadcast(message: ServerToClientMessage): void {
    try {
      if (message.type === 'event' || message.type.startsWith('session:') || message.type.startsWith('task:')
        || message.type === 'queue:updated' || message.type.startsWith('approval:')) this.directoryChanged();
      const execution = changedExecution(message);
      if (execution) this.executionChanged(execution, true);
      if (message.type === 'session:created' || message.type === 'session:updated') {
        this.publishSession(message.session.id);
        return;
      }
      if (message.type === 'session:deleted') {
        for (const key of [...this.issuedInteractionIds.keys()]) {
          if (key.startsWith(`${message.session_id} `)) this.issuedInteractionIds.delete(key);
        }
        this.publishRemove('sessions', message.session_id);
        return;
      }
      if (message.type === 'queue:updated') {
        this.publishSession(message.session_id);
        return;
      }
      if (message.type === 'task:created' || message.type === 'task:updated') {
        this.publishTask(message.task.id, 'status' in message.task ? message.task.status : undefined);
        return;
      }
      if (message.type === 'task:deleted') {
        this.publishTaskUnavailable(message.task_id);
        return;
      }
      if (message.type === 'approval:created' || message.type === 'approval:updated') {
        this.publishInteraction(
          message.approval.id,
          message.type === 'approval:updated',
          message.approval.session_id,
        );
        return;
      }
      if (message.type === 'attention') {
        if (!this.projector.isSessionIdVisible(message.session_id)) {
          const filtered = this.attention.filter(item => item.session_id !== message.session_id);
          if (filtered.length !== this.attention.length) {
            this.attention = filtered;
            this.publish({
              type: 'event',
              host_generation: this.generation,
              event_sequence: this.replay.eventSequence,
              event: { kind: 'attention.updated', attention: this.attention },
            });
            this.publishPatch({ attention: this.attention });
          }
          return;
        }
        const kind = message.kind === 'turn-completed'
          ? 'completed'
          : message.kind === 'error'
            ? 'failed'
            : message.kind === 'approval' || message.kind === 'question'
              ? 'interaction'
              : 'running';
        const attention: RemoteAttention = {
          session_id: message.session_id,
          kind,
          updated_at: new Date(message.timestamp).toISOString(),
        };
        this.attention = [
          ...this.attention.filter(item => item.session_id !== attention.session_id),
          attention,
        ];
        this.publish({
          type: 'event',
          host_generation: this.generation,
          event_sequence: this.replay.eventSequence,
          event: { kind: 'attention.updated', attention: this.attention },
        });
        this.publishPatch({ attention: this.attention });
        return;
      }
      if (message.type === 'event') {
        this.publishTranscriptEvent(message);
      }
    } catch {
      // A bad local broadcast must not drop the Host relay.
    }
  }

  private publishSession(sessionId: string): void {
    try {
      const session = this.sessions.getSession(sessionId);
      if (!this.projector.isSessionVisible(session)) {
        const filtered = this.attention.filter(item => item.session_id !== sessionId);
        const attentionChanged = filtered.length !== this.attention.length;
        this.attention = filtered;
        this.publishPatch({
          sessions: { upsert: [], remove_ids: [sessionId] },
          ...(attentionChanged ? { attention: this.attention } : {}),
        });
        return;
      }
      const projected = this.projector.projectSession(session);
      this.publish({
        type: 'event',
        host_generation: this.generation,
        event_sequence: this.replay.eventSequence,
        event: { kind: 'session.updated', session: projected },
      });
      this.publishPatch({ sessions: { upsert: [projected], remove_ids: [] } });
    } catch {
      this.publishRemove('sessions', sessionId);
    }
  }

  private publishTask(taskId: string, status?: string): void {
    if (status && status !== 'open') {
      this.publishTaskUnavailable(taskId);
      return;
    }
    const task = this.tasks.listTasks().find(item => item.id === taskId);
    if (!task || task.status !== 'open') {
      this.publishTaskUnavailable(taskId);
      return;
    }
    const projected = {
      id: task.id,
      name: task.name,
      updated_at: task.updated_at,
      session_ids: this.sessions.listSessions({ includeArchived: false })
        .filter(session => session.task_id === task.id && this.projector.isSessionVisible(session))
        .map(session => session.id),
    };
    this.publishPatch({ tasks: { upsert: [projected], remove_ids: [] } });
  }

  private publishTaskUnavailable(taskId: string): void {
    const sessionIds = this.sessions.listSessions({ includeArchived: true })
      .filter((session) => session.task_id === taskId)
      .map((session) => session.id);
    const removed = new Set(sessionIds);
    const filtered = this.attention.filter((item) => !removed.has(item.session_id));
    const attentionChanged = filtered.length !== this.attention.length;
    this.attention = filtered;
    this.publishPatch({
      tasks: { upsert: [], remove_ids: [taskId] },
      ...(sessionIds.length > 0
        ? { sessions: { upsert: [], remove_ids: sessionIds } }
        : {}),
      ...(attentionChanged ? { attention: this.attention } : {}),
    });
  }

  private publishInteraction(
    interactionId: string,
    maybeResolved: boolean,
    sessionId?: string,
  ): void {
    let pending;
    try {
      pending = this.sessions.getPendingApproval(interactionId, sessionId);
    } catch (error) {
      if (error instanceof ApprovalScopeError) return;
      throw error;
    }
    if (!pending) {
      if (!maybeResolved || !sessionId) return;
      for (const id of this.interactionRemoveIds(sessionId, interactionId)) {
        this.publishRemove('interactions', id);
      }
      return;
    }
    if (!this.projector.isSessionIdVisible(pending.sessionId)) return;
    const row = this.db.prepare(
      'SELECT resource_revision FROM proxy_interactions WHERE session_id = ? AND interaction_id = ?',
    ).get(pending.sessionId, interactionId) as { resource_revision?: number } | undefined;
    const projected = projectRemoteInteraction(pending, String(row?.resource_revision ?? 0));
    this.rememberIssuedInteraction(pending.sessionId, pending.id, projected.id);
    this.publish({
      type: 'event',
      host_generation: this.generation,
      event_sequence: this.replay.eventSequence,
      event: { kind: 'interaction.updated', interaction: projected },
    });
    this.publishPatch({ interactions: { upsert: [projected], remove_ids: [] } });
  }

  /** Record one issued card id under its session+provider occurrence key. */
  private rememberIssuedInteraction(sessionId: string, interactionId: string, resourceId: string): void {
    const issuedKey = `${sessionId} ${interactionId}`;
    const issued = this.issuedInteractionIds.get(issuedKey) ?? new Set<string>();
    issued.add(resourceId);
    this.issuedInteractionIds.set(issuedKey, issued);
  }

  /**
   * Register every currently pending, remotely visible card. Snapshot and
   * reconnect delivery meets pendings that never produced a live
   * approval:created for this process; their exact turn-bound ids must be
   * removable later without touching another session or turn.
   */
  private registerIssuedInteractions(): void {
    for (const record of this.sessions.listPendingApprovals()) {
      if (!this.projector.isSessionIdVisible(record.sessionId)) continue;
      this.rememberIssuedInteraction(
        record.sessionId,
        record.id,
        remoteInteractionResourceId(record.sessionId, record.turnId, record.id),
      );
    }
  }

  /**
   * Remove this session's card. Every turn-bound resource id this process
   * issued for the provider id is removed, so a stale earlier-turn card cannot
   * survive next to a new occurrence. A provider id that an older client
   * stored as the resource id is removed too, unless that exact UUID is now
   * the live resource id of another pending card.
   */
  private interactionRemoveIds(sessionId: string, interactionId: string): string[] {    const issuedKey = `${sessionId} ${interactionId}`;
    const issued = this.issuedInteractionIds.get(issuedKey);
    this.issuedInteractionIds.delete(issuedKey);
    const ids = [...issued ?? []];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(interactionId)) {
      return ids;
    }
    if (ids.includes(interactionId)) return ids;
    const occupied = this.sessions.listPendingApprovals().some(item => (
      remoteInteractionResourceId(item.sessionId, item.turnId, item.id) === interactionId
    ));
    if (!occupied) ids.push(interactionId);
    return ids;
  }

  private publishRemove(collection: 'sessions' | 'tasks' | 'interactions', id: string): void {
    this.publishPatch({
      [collection]: { upsert: [], remove_ids: [id] },
    } as RemoteStatePatch);
  }

  private publishPatch(patch: RemoteStatePatch): void {
    const baseRevision = this.replay.currentRevision;
    const revision = this.projector.revision();
    this.publish({
      type: 'state.patch',
      host_generation: this.generation,
      event_sequence: this.replay.eventSequence,
      base_revision: baseRevision,
      revision,
      patch,
    });
  }

  private publish(
    message: CanonicalEvent | StatePatch,
    scope?: { sessionId?: string },
  ): void {
    const stamped = {
      ...message,
      host_generation: this.generation,
      event_sequence: this.replay.eventSequence,
    } as RemoteControlMessage;
    if (scope?.sessionId) {
      this.fanout(stamped, scope);
      return;
    }
    const revision = stamped.type === 'state.patch' ? stamped.revision : this.replay.currentRevision;
    this.replay.push(stamped, revision);
    this.fanout(stamped);
  }

  private fanout(message: object, scope?: { sessionId?: string }): void {
    for (const [deviceId, connector] of this.connectors) {
      if (scope?.sessionId && this.subscriptions.get(deviceId) !== scope.sessionId) continue;
      void connector.sendControl(message).catch(() => undefined);
    }
  }

  private publishTranscriptEvent(message: Extract<ServerToClientMessage, { type: 'event' }>): void {
    for (const [deviceId, connector] of this.connectors) {
      if (this.subscriptions.get(deviceId) !== message.session_id) continue;
      if (!this.connectionSessionVisible(message.session_id, deviceId)) continue;
      const item = this.projector.projectTranscriptEvent(message, deviceId, {
        translation: connector.supportsFeature('wire.conversation_translation'),
      });
      if (!item) continue;
      connector.sendTranscript({
        type: 'event',
        host_generation: this.generation,
        event_sequence: this.replay.eventSequence,
        event: {
          kind: 'transcript.item',
          session_id: message.session_id,
          item,
        },
      });
    }
  }

  private translationExport(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM remote_execution_exports WHERE session_id = ?').get(sessionId));
  }

  private connectionSessionVisible(sessionId: string, deviceId: string): boolean {
    if (!this.directory.negotiated(deviceId)) return this.projector.isSessionIdVisible(sessionId);
    const device = this.devices.getActive(deviceId);
    return !!device && this.directory.canAccess(sessionId, device);
  }

  private directoryChanged(): void {
    this.directory.invalidate();
    if (this.directoryHintQueued) return;
    this.directoryHintQueued = true;
    queueMicrotask(() => {
      this.directoryHintQueued = false;
      if (this.shuttingDown) return;
      for (const [deviceId, connector] of this.connectors) {
        if (!connector.supportsFeature('wire.session_directory_v1')) continue;
        const device = this.devices.getActive(deviceId);
        if (!device?.grants.includes('session.read')) continue;
        void connector.sendControl({ type: 'directory.changed', version: 1,
          host_generation: this.generation, revision: this.directory.revision }).catch(() => undefined);
      }
    });
  }

  /**
   * Something execution.sync returns for an exported session changed. Each
   * controller that negotiated wire.execution_hints_v1 gets a content-free
   * hint: the first change is sent once the current tick ends, so one burst
   * of broadcasts is one hint, and later changes inside the window coalesce
   * into one trailing hint. History appends alone keep the longer history
   * window, so a streaming Turn costs the relay what the controller's old
   * active-Turn poll did; an `urgent` change (state, queue, interaction)
   * pulls the trailing hint forward. Like directory.changed it is live-only;
   * a lost hint is covered by the controller's fallback sync.
   */
  private executionChanged(sessionId: string, urgent = false): void {
    if (this.shuttingDown) return;
    const open = this.executionHints.get(sessionId);
    if (open) {
      open.dirty = true;
      if (urgent && open.timer && !open.urgent) {
        open.urgent = true;
        clearTimeout(open.timer);
        open.timer = setTimeout(() => this.flushExecutionHint(sessionId, open),
          Math.max(0, open.sentAt + EXECUTION_HINT_COALESCE_MS - Date.now()));
        open.timer.unref?.();
      }
      return;
    }
    if (![...this.connectors.values()].some(connector => connector.supportsFeature('wire.execution_hints_v1'))) return;
    if (!this.executions.contains(sessionId)) return;
    const pending: ExecutionHintWindow = { dirty: true, urgent: false, sentAt: 0, timer: null };
    this.executionHints.set(sessionId, pending);
    queueMicrotask(() => this.flushExecutionHint(sessionId, pending));
  }

  private flushExecutionHint(sessionId: string, pending: ExecutionHintWindow): void {
    if (this.executionHints.get(sessionId) !== pending) return;
    if (!pending.dirty || this.shuttingDown) {
      this.executionHints.delete(sessionId);
      return;
    }
    pending.dirty = false;
    for (const [deviceId, connector] of this.connectors) {
      if (!connector.supportsFeature('wire.execution_hints_v1')) continue;
      // The same authorization execution.sync applies to this device.
      const device = this.devices.getActive(deviceId);
      const sequence = device ? this.executions.hintSequence(sessionId, device) : null;
      if (sequence === null) continue;
      const hint = executionChangedSchema.safeParse({ type: 'execution.changed', version: 1,
        host_generation: this.generation, session_id: sessionId, sequence });
      if (hint.success) void connector.sendControl(hint.data).catch(() => undefined);
    }
    pending.sentAt = Date.now();
    pending.urgent = false;
    pending.timer = setTimeout(() => this.flushExecutionHint(sessionId, pending), EXECUTION_HINT_HISTORY_COALESCE_MS);
    pending.timer.unref?.();
  }

  /** Host translation preferences were saved: re-push the small per-session
   *  state to every currently subscribed, negotiated connection so no view
   *  keeps a stale configured/language snapshot. */
  notifyTranslationPreferencesChanged(): void {
    const service = this.translationService;
    if (!service) return;
    for (const sessionId of new Set(this.subscriptions.values())) {
      if (this.translationExport(sessionId)) continue;
      void projectReadyTranslationState(service, sessionId, this.translationPreferences).then(state => {
        if (!this.shuttingDown && !this.translationExport(sessionId)) this.publishTranslationEvent(sessionId, { state });
      }).catch(() => undefined);
    }
  }

  private pollTranslationHealth(): void {
    const service = this.translationService;
    const sessionId = this.subscriptions.values().next().value as string | undefined;
    if (!service || !sessionId || this.shuttingDown || this.translationHealthPending
      || this.translationPreferences().agent_id !== OPENAI_TRANSLATION_AGENT_ID) return;
    this.translationHealthPending = true;
    void projectReadyTranslationState(service, sessionId, this.translationPreferences).then(state => {
      if (this.shuttingDown) return;
      const health = `${state.config_revision}:${state.configured}`;
      if (health !== this.translationHealthLast) {
        this.translationHealthLast = health;
        this.notifyTranslationPreferencesChanged();
      }
    }).catch(() => undefined).finally(() => { this.translationHealthPending = false; });
  }

  /**
   * Translation events ride the live connection exactly like transcript
   * items: session-subscription scoped, feature-gated per connection, and
   * NOT part of the canonical replay sequence. Missed changes are recovered
   * by the resume-time state push plus session.subscribe / session.page
   * reads, never by replaying to a closed-schema peer.
   */
  private publishTranslationNotification(notification: TranslationNotification): void {
    const service = this.translationService;
    if (!service || this.translationExport(notification.sessionId)) return;
    if (notification.enabled !== undefined) {
      void projectReadyTranslationState(service, notification.sessionId, this.translationPreferences).then(state => {
        if (!this.shuttingDown && !this.translationExport(notification.sessionId)) this.publishTranslationEvent(notification.sessionId, { state });
      }).catch(() => undefined);
    }
    if (notification.automatic) {
      this.publishTranslationEvent(notification.sessionId, {
        automatic: {
          source_id: notification.automatic.sourceId,
          pending: notification.automatic.pending,
          ...(notification.automatic.error
            ? { error: redactRemoteText(notification.automatic.error).slice(0, 16_000) }
            : {}),
        },
        // Deltas share the wholesale state's ordered version: the client's
        // version advances with every delta, so a stale snapshot can never
        // resurrect an older pending entry over a settled outcome.
        automatic_revision: service.automaticRevision(notification.sessionId),
        automatic_epoch: service.automaticEpoch,
      });
    }
    if (notification.result) {
      this.publishTranslationEvent(notification.sessionId, {
        upsert: projectRemoteTranslation(notification.result),
      });
    }
  }

  private publishTranslationSettled(
    sessionId: string,
    requestId: string,
    outcome: { record?: TranslationRecord; error?: string },
  ): void {
    this.publishTranslationEvent(sessionId, {
      request_id: requestId,
      ...(outcome.record ? { upsert: projectRemoteTranslation(outcome.record) } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    });
  }

  private publishTranslationEvent(
    sessionId: string,
    event: Record<string, unknown>,
  ): void {
    for (const [deviceId, connector] of this.connectors) {
      if (this.subscriptions.get(deviceId) !== sessionId) continue;
      if (!connector.supportsFeature('wire.conversation_translation')) continue;
      if (!this.connectionSessionVisible(sessionId, deviceId)) continue;
      void connector.sendControl({
        type: 'event',
        host_generation: this.generation,
        event_sequence: this.replay.eventSequence,
        event: { kind: 'translation.updated', session_id: sessionId, ...event },
      }).catch(() => undefined);
    }
  }

  settingsState(): RemoteSettingsSnapshot {
    const enrollment = this.enrollment.current();
    const latest = this.pairings.latest();
    const pairing = latest?.id === this.dismissedPairingId ? null : latest;
    if (this.displayGrant && (!pairing || pairing.id !== this.displayGrant.id
        || !['pending_claim', 'pending_confirmation'].includes(pairing.status))) this.displayGrant = null;
    const presentPairing = (record: RemotePairingRecord): RemoteSettingsPairing => {
      const display = record.id === this.displayGrant?.id ? this.displayGrant : null;
      const qr = display && enrollment ? new URL('/', enrollment.publicUrl) : null;
      if (qr && display) qr.hash = new URLSearchParams({ nonce: display.nonce }).toString();
      return {
        id: record.id, status: record.status,
        code: display?.code ?? null, qr_payload: qr?.href ?? null,
        device_name: record.deviceName, platform: record.platform,
        user_agent: record.userAgent, claimed_network: record.claimedNetwork,
        claimed_at: record.claimedAt, created_at: record.createdAt, expires_at: record.expiresAt,
      };
    };
    return {
      enrolled: enrollment !== null,
      account: this.accountState,
      host_id: enrollment?.hostId ?? null,
      host_name: enrollment?.hostName ?? null,
      server_url: enrollment?.serverUrl ?? null,
      public_url: enrollment?.publicUrl ?? null,
      connection: !enrollment ? 'offline'
        : !enrollment.connectorEnabled || this.shuttingDown ? 'disconnected'
          : enrollment.pendingIdentityFingerprint ? 'offline'
            : this.relay?.bound && !this.heartbeatFailed ? 'online' : 'reconnecting',
      last_heartbeat_at: this.lastHeartbeatAt,
      server_identity_fingerprint: enrollment?.serverIdentityFingerprint ?? null,
      pending_identity_fingerprint: enrollment?.pendingIdentityFingerprint ?? null,
      identity_changed_at: enrollment?.identityChangedAt ?? null,
      pairing: pairing ? presentPairing(pairing) : null,
      devices: (enrollment ? this.devices.list() : []).map(device => {
        const pairing = !device.nameCustomized && device.name === GENERIC_REMOTE_DEVICE_NAME
          ? this.pairings.forDevice(device.id) : null;
        return {
          id: device.id,
          name: !device.nameCustomized && device.name === GENERIC_REMOTE_DEVICE_NAME
            ? remoteDeviceDisplayName({
              platform: pairing?.platform ?? device.platform,
              userAgent: pairing?.userAgent,
            })
            : device.name,
          platform: device.platform,
          grants: [...device.grants],
          created_at: device.createdAt,
          last_seen_at: device.lastSeenAt,
          revoked_at: device.revokedAt,
          revision: device.revision,
          active_connections: this.connectors.get(device.id)?.connected ? 1 : 0,
          revoke_status: !device.revokedAt ? 'active'
            : this.revokingDevices.has(device.id) ? 'revoke-pending'
              : this.devices.revocationSynced(device.id) ? 'revoked' : 'pending-reconciliation',
        };
      }),
      pending_pairings: this.pairings.listPending().map(record => {
        const { code: _code, qr_payload: _qr, ...metadata } = presentPairing(record);
        return metadata;
      }),
    };
  }

  close(): void {
    if (this.translationHealthTimer) clearInterval(this.translationHealthTimer);
    this.translationHealthTimer = null;
    this.stopConnection();
    this.detachHostEvents?.();
    this.detachHostEvents = null;
    this.detachTranslation?.();
    this.detachTranslation = null;
    this.displayGrant = null;
  }

  private stopConnection(): void {
    this.shuttingDown = true;
    this.connectionEpoch += 1;
    this.stopHeartbeat();
    this.clearHeartbeatRetry();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const pending of this.executionHints.values()) if (pending.timer) clearTimeout(pending.timer);
    this.executionHints.clear();
    this.subscriptions.clear();
    for (const connector of this.connectors.values()) connector.close();
    this.connectors.clear();
    this.relay?.close('host_closed');
    this.relay = null;
    this.authClient = null;
  }
}

interface ExecutionHintWindow {
  /** A change arrived that no hint has carried yet. */
  dirty: boolean;
  /** The trailing hint was already pulled forward by a non-history change. */
  urgent: boolean;
  /** When this window's last hint was sent. */
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The session whose execution.sync result a local broadcast may change: its
 *  state, status, name or queue, or one of its pending interactions. History
 *  appends hint from the journal itself. */
function changedExecution(message: ServerToClientMessage): string | undefined {
  if (message.type === 'session:created' || message.type === 'session:updated') return message.session.id;
  if (message.type === 'queue:updated') return message.session_id;
  if (message.type === 'approval:created' || message.type === 'approval:updated') return message.approval.session_id;
  return undefined;
}

export function remoteOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('invalid_url'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('invalid_url');
  }
  return url.origin;
}
