import {
  ACCESS_TOKEN_TTL_MS, AUTH_PROTOCOL, DeviceRelayClient, REMOTE_METHOD_RESULTS, RemoteProtocolError, canonicalJson,
  commandResultSchema, deviceChallengeResultSchema, deviceLoginResultSchema, controllerChallengeResultSchema,
  discoverServerIdentity, generateCanonicalId, generateUuidV7, identityFingerprint, importP256PublicKey,
  isRemoteErrorCode, parseClosed, pairingClaimResultSchema, serverChallengePayload, verifyBytes, base64UrlToBytes,
  wsTicketResultSchema, type RemoteMethod, type DeviceRelayClientOptions,
} from '@gian/remote-protocol';
import type { RemoteIdentityMaterial } from './identity.js';
import { HttpRemoteServerAuthClient } from './server-client.js';

export interface RemoteControllerEnvironment {
  id: string;
  name: string;
  server_origin: string;
  server_identity_fingerprint: string;
  host_id: string;
  browser_id: string;
  device_id: string | null;
  device_public_key_json?: string | null;
  crypto_connection_id: string | null;
  host_public_key_json: string | null;
  pairing_id: string | null;
  created_at: number;
}

export interface RemoteControllerAdmission {
  installationId: string;
  accessToken: string;
  serverIdentityFingerprint: string;
  hostIdentity: true;
}

type ControllerRelay = Pick<DeviceRelayClient, 'isOpen' | 'hostGeneration' | 'connect' | 'sendControl' | 'sendContent' | 'close'>
  & Partial<Pick<DeviceRelayClient, 'negotiatedCapabilities'>>;

/** How long one remote call may stay unanswered. Its expiry fails only that
 *  call; the relay itself closes only when nothing at all arrived from the
 *  execution Host while the call was outstanding. */
export const REMOTE_CALL_TIMEOUT_MS = 90_000;

/** After a failed connection attempt the next one waits about `first`,
 *  doubling per failure up to `max`; each wait is drawn between half and
 *  all of that, so many controllers do not retry in step. `max` stays short
 *  so a Server back from an outage is found within seconds even when
 *  nothing else says so (see reconnectNow). */
export const RECONNECT_BACKOFF_MS = { first: 1000, max: 10_000 };
/** A rate-limited attempt without a Retry-After waits a full Server window. */
const RATE_LIMIT_WAIT_MS = 60_000;
/** A user's action waits at most this long, from its start, for a reconnect. */
export const USER_RECONNECT_WAIT_MS = 15_000;
/** A link lost this recently, and being restored, is reconnecting rather
 *  than offline. */
export const RECONNECTING_WINDOW_MS = 2 * 60_000;
/** While sessions need the environment, a channel silent this long is
 *  probed with a cheap read; a probe unanswered within `timeout`, with
 *  nothing else heard either, drops the channel. */
export const KEEPALIVE_MS = { idle: 30_000, timeout: 10_000 };
/** A Server access token is reused until this long before it expires. */
const ACCESS_RENEW_MARGIN_MS = 60_000;

/** How the hub steers one environment's connection. */
export interface RemoteConnectionHooks {
  /** Whether anything needs this environment connected now (bound sessions,
   *  an owed pairing link). Only then does the client reconnect and probe on
   *  its own. */
  wanted?: () => boolean;
  /** A connection attempt failed, whichever caller started it. */
  onAttemptFailed?: (error: unknown) => void;
  /** Jitter source in [0, 1). */
  random?: () => number;
  keepalive?: { idle: number; timeout: number };
}

/** A device token and the pairing evidence it was issued for. */
interface DeviceAccess {
  /** The environment fields the token is valid for (see accessKey). */
  key: string;
  token: string;
  renewAt: number;
  deviceId: string;
  cryptoConnectionId: string;
  hostPublicKey: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

export class RemoteControllerClient {
  private relay: ControllerRelay | null = null;
  private connecting: Promise<void> | null = null;
  private epoch = 0;
  /** Whether connected was reported through onConnectionChange and not yet
   *  balanced by a disconnect report — closing a never-connected client is
   *  not a transition. The relay's own isOpen cannot serve here: it is
   *  already false by the time a socket-initiated close reaches us. */
  private reportedConnected = false;
  /** When the current relay last delivered any decrypted frame. */
  private lastInboundAt = 0;
  private retired = false;
  /** Bumped by every close() a caller asked for; an attempt it interrupts
   *  is superseded, not failed. */
  private closes = 0;
  /** Failed attempts in a row, and when the next one may start. */
  private failures = 0;
  private nextAttemptAt = 0;
  private lastFailure: unknown = null;
  /** The Server refused this Mac's pairing (see pairingRefusal). Nothing
   *  connects again, on its own or for a user's action, and every caller
   *  fails at once with this; pairing the environment again or restoring it
   *  gives it a new client. */
  private refusal: RemoteProtocolError | null = null;
  /** A user's action may cut one backoff wait short. */
  private userRetry = true;
  /** When a live channel was last lost. */
  private droppedAt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private probing = false;
  private access: DeviceAccess | null = null;
  /** Controller admission was proven until then. */
  private admittedUntil = 0;
  private readonly requests = new Map<string, { method: RemoteMethod; params: string; promise: Promise<unknown> }>();
  private readonly pending = new Map<string, { method: RemoteMethod; resolve(value: unknown): void; reject(error: Error): void;
    timer: ReturnType<typeof setTimeout> }>();
  private readonly controls = new Set<(message: Record<string, unknown>) => void | Promise<void>>();
  /** Waiting on the relay that is open now; close() runs them once. */
  private readonly closeWatchers = new Set<() => void>();
  /** User actions sleeping until the scheduled attempt; any attempt that
   *  starts sooner wakes them to share it. */
  private readonly attemptWaiters = new Set<() => void>();

  constructor(
    readonly environment: RemoteControllerEnvironment,
    private readonly identity: RemoteIdentityMaterial,
    private readonly save: (environment: RemoteControllerEnvironment) => void,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
    private readonly createRelay: (options: DeviceRelayClientOptions) => ControllerRelay = options => new DeviceRelayClient(options),
    /** Connectivity notification: fires once per transition — after a relay
     *  connect succeeds, and from close() when connected had been reported. */
    private readonly onConnectionChange?: (connected: boolean) => void,
    private readonly callTimeoutMs: number = REMOTE_CALL_TIMEOUT_MS,
    private readonly hooks: RemoteConnectionHooks = {},
  ) {}

  get connected(): boolean { return this.relay?.isOpen === true; }
  /** When the next connection attempt may start; 0 when one may now. */
  get retryAt(): number { return this.nextAttemptAt; }
  /** Not connected, and waiting out the backoff of a failed attempt. */
  get backingOff(): boolean { return !this.connected && this.nextAttemptAt > Date.now(); }
  /** The Server refused this Mac's pairing: no attempt is made until the
   *  environment is paired again. */
  get refused(): boolean { return this.refusal !== null; }
  /** A link that was live moments ago is being restored: an attempt runs or
   *  is scheduled. Brief drops read this way instead of offline. */
  get reconnecting(): boolean {
    return !this.retired && !this.connected && this.droppedAt > 0 && Date.now() - this.droppedAt <= RECONNECTING_WINDOW_MS
      && (this.connecting !== null || this.reconnectTimer !== null);
  }
  supports(feature: string): boolean { return this.connected && this.relay?.negotiatedCapabilities?.includes(feature) === true; }

  static async pair(input: { origin: string; code: string; name: string }, identity: RemoteIdentityMaterial,
    admission: RemoteControllerAdmission, fetchImpl: typeof fetch = globalThis.fetch): Promise<RemoteControllerEnvironment> {
    const discovered = await discoverServerIdentity({
      origin: input.origin,
      fetchFn: fetchImpl,
      pinnedFingerprint: admission.serverIdentityFingerprint,
    });
    const publicIdentity = await identity.ensurePublic();
    const result = await fetchImpl(new URL('/api/v1/pairings/claim', input.origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        origin: input.origin,
        authorization: `Bearer ${admission.accessToken}`,
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, code: input.code, browser_installation_id: admission.installationId,
        device_public_key: publicIdentity.public_key, platform: process.platform, user_agent: 'Gian Desktop',
        controller_admission: 1 }),
    });
    const json = await result.json() as Record<string, unknown> & { error?: { code?: string } };
    if (!result.ok) {
      const code = json.error?.code;
      const retryAfterSeconds = Number(result.headers.get('retry-after'));
      if (code === 'RATE_LIMITED') {
        throw new RemoteProtocolError(code, 'Remote Server rate limited this Mac',
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : undefined);
      }
      if (code && isRemoteErrorCode(code)) throw new RemoteProtocolError(code, 'pairing rejected');
      throw new RemoteProtocolError('AUTH_REQUIRED', 'pairing rejected');
    }
    const claim = parseClosed(pairingClaimResultSchema, json);
    return { id: generateCanonicalId(), name: input.name, server_origin: input.origin,
      server_identity_fingerprint: discovered.fingerprint, host_id: claim.host_id,
      browser_id: admission.installationId, device_id: null,
      device_public_key_json: JSON.stringify(publicIdentity.public_key),
      crypto_connection_id: claim.crypto_connection_id, host_public_key_json: null,
      pairing_id: claim.pairing_id, created_at: Date.now() };
  }

  /**
   * Connect, through the one backoff this environment has. Every caller
   * shares the attempt in flight. While a failed attempt's backoff runs, a
   * background caller fails at once with that failure. A user's action
   * starts one attempt early (once per wait, never inside the Server's
   * Retry-After), then waits for the scheduled attempts, or one started
   * sooner (reconnectNow), while they fail transiently (Server unreachable,
   * or rate limited for a wait that fits), until USER_RECONNECT_WAIT_MS
   * after it began. A permanent failure ends that wait at once, as does any
   * failure after close() or removal; a scheduled attempt the window cannot
   * reach ends it with the backoff's failure. Once the Server refused this
   * Mac's pairing, every caller fails at once with that refusal.
   */
  async connect(options: { user?: boolean } = {}): Promise<void> {
    if (!options.user) return this.connectStep();
    const deadline = Date.now() + USER_RECONNECT_WAIT_MS;
    const closes = this.closes;
    for (let early = true; ; early = false) {
      try {
        return await this.connectStep({ early, deadline });
      } catch (error) {
        if (this.closes !== closes || this.retired || !transientFailure(error)) throw error;
        if (this.nextAttemptAt > deadline) throw this.backoffError();
      }
    }
  }

  /** One pass of connect(). A user's pass may start the early attempt, or
   *  wait for the scheduled one when it is due by the deadline. */
  private async connectStep(user?: { early: boolean; deadline: number }): Promise<void> {
    if (this.retired) throw new RemoteProtocolError('HOST_OFFLINE', 'remote environment removed');
    if (this.connected) return;
    if (this.refusal) throw new RemoteProtocolError(this.refusal.code, this.refusal.message, this.refusal.details);
    if (this.connecting) return this.connecting;
    const wait = this.nextAttemptAt - Date.now();
    if (wait > 0) {
      if (user?.early && this.userRetry && !this.rateLimited()) {
        this.userRetry = false;
        return this.attempt();
      }
      if (user && this.nextAttemptAt <= user.deadline) {
        await this.nextAttempt(wait);
        // Joins the scheduled attempt (or one started sooner), starts it,
        // or meets its failure.
        return this.connectStep();
      }
      this.scheduleReconnect(wait);
      throw this.backoffError();
    }
    this.userRetry = true;
    return this.attempt();
  }

  private async attempt(): Promise<void> {
    // This attempt replaces any scheduled one; its failure schedules the next.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reset();
    const epoch = this.epoch;
    const closes = this.closes;
    const login = { fresh: false };
    const run = this.connectVerified(epoch, login).then(() => {
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.lastFailure = null;
      this.userRetry = true;
      this.startKeepalive();
    }, (error: unknown) => {
      // A caller's close() cancelled it: nothing failed.
      if (this.closes !== closes || this.retired) throw error;
      const failure = connectionFailure(error);
      const refusal = this.pairingRefusal(failure, login.fresh);
      if (refusal) {
        // Retrying cannot get past it: nothing is scheduled, and no caller
        // tries again until the user pairs again (a new client).
        this.refusal = refusal;
        this.lastFailure = refusal;
        this.nextAttemptAt = 0;
        this.hooks.onAttemptFailed?.(refusal);
        throw refusal;
      }
      this.failures += 1;
      this.lastFailure = failure;
      const delay = this.backoffDelay(failure);
      this.nextAttemptAt = Date.now() + delay;
      this.scheduleReconnect(delay);
      this.hooks.onAttemptFailed?.(failure);
      throw failure;
    });
    this.connecting = run;
    for (const wake of [...this.attemptWaiters]) wake();
    try { await run; } finally { if (this.connecting === run) this.connecting = null; }
  }

  /** Sleep until the scheduled attempt is due, or an attempt starts sooner. */
  private nextAttempt(wait: number): Promise<void> {
    return new Promise(resolve => {
      const wake = () => { clearTimeout(timer); this.attemptWaiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, wait);
      this.attemptWaiters.add(wake);
    });
  }

  /**
   * The Server is reachable again: this Mac's own connection to it just came
   * back. While this environment is wanted and down, its backoff starts over
   * and one attempt starts now (or the one in flight is joined); user actions
   * waiting for the scheduled attempt share it. The Server's rate limit is
   * still waited out, and neither a removed environment nor a refused
   * pairing connects again.
   */
  reconnectNow(): void {
    if (this.retired || this.refusal || this.connected || !this.hooks.wanted?.()) return;
    if (this.rateLimited() && this.nextAttemptAt > Date.now()) return;
    this.failures = 0;
    this.nextAttemptAt = 0;
    if (this.connecting) return;
    this.userRetry = true;
    void this.attempt().catch(() => undefined);
  }

  private rateLimited(): boolean {
    return this.lastFailure instanceof RemoteProtocolError && this.lastFailure.code === 'RATE_LIMITED';
  }

  /** The failure as a refusal of this Mac's pairing, which no retry gets
   *  past, or null. The Server refusing this device, its pairing or this
   *  controller is one; so is an AUTH_REQUIRED that a fresh login met (a
   *  token the Server dropped logs in afresh within the same attempt, so an
   *  expired one never gets here). A pairing the Host owner has not
   *  confirmed yet reads as not paired until then: that one is waited for. */
  private pairingRefusal(error: unknown, fresh: boolean): RemoteProtocolError | null {
    if (!(error instanceof RemoteProtocolError)) return null;
    if (error.code === 'AUTH_REQUIRED') return fresh ? error : null;
    const message = PAIRING_REFUSALS[error.code];
    if (!message || (error.code === 'DEVICE_NOT_PAIRED' && this.environment.pairing_id !== null)) return null;
    return new RemoteProtocolError(error.code, message, error.details);
  }

  private backoffDelay(error: unknown): number {
    const base = Math.min(RECONNECT_BACKOFF_MS.max, RECONNECT_BACKOFF_MS.first * 2 ** (this.failures - 1));
    const delay = base / 2 + (this.hooks.random ?? Math.random)() * base / 2;
    if (!(error instanceof RemoteProtocolError) || error.code !== 'RATE_LIMITED') return delay;
    // The Server's Retry-After decides; without one, wait out its window.
    const after = Number(error.details?.retryAfterSeconds);
    return Math.max(delay, Number.isFinite(after) && after > 0 ? after * 1000 : RATE_LIMIT_WAIT_MS);
  }

  /** The failure a caller meets while its backoff runs. */
  private backoffError(): RemoteProtocolError {
    const retryAfterSeconds = Math.max(1, Math.ceil((this.nextAttemptAt - Date.now()) / 1000));
    const last = this.lastFailure;
    return last instanceof RemoteProtocolError
      ? new RemoteProtocolError(last.code, last.message, { ...last.details, retryAfterSeconds })
      : new RemoteProtocolError('HOST_OFFLINE', 'remote Host unreachable; retrying', { retryAfterSeconds });
  }

  /** An attempt of its own when this environment is wanted and none is due. */
  private scheduleReconnect(delay: number): void {
    if (this.retired || this.refusal || this.reconnectTimer || !this.hooks.wanted?.()) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.retired && !this.connected && this.hooks.wanted?.()) void this.connect().catch(() => undefined);
    }, Math.max(0, delay));
    this.reconnectTimer.unref();
  }

  /** The channel was lost (socket close, presence notice, silence). A live
   *  one is not a failed attempt: callers may connect again at once, and
   *  when sessions need it the client reconnects on its own, scheduled
   *  before the loss is reported so it reads as reconnecting. An attempt
   *  this interrupts fails and schedules its own retry. */
  private drop(options: { immediate?: boolean } = {}): void {
    if (this.reportedConnected) {
      this.droppedAt = Date.now();
      if (this.nextAttemptAt <= Date.now()) {
        this.scheduleReconnect(options.immediate ? 0 : RECONNECT_BACKOFF_MS.first * (0.5 + (this.hooks.random ?? Math.random)() / 2));
      }
    }
    this.reset();
  }

  /** While sessions need this environment, probe a quiet channel with a
   *  command.status for an unused id: the Host answers it at once from its
   *  ledger and never queues it behind other work. */
  private startKeepalive(): void {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    const keepalive = this.hooks.keepalive ?? KEEPALIVE_MS;
    this.keepaliveTimer = setInterval(() => {
      if (this.probing || !this.connected || !this.hooks.wanted?.() || Date.now() - this.lastInboundAt < keepalive.idle) return;
      this.probing = true;
      const commandId = generateUuidV7();
      void this.requestOnce('command.status', { command_id: commandId }, commandId, keepalive.timeout)
        // An answer, or a refusal, proves the channel; silence dropped it.
        .catch(() => undefined).finally(() => { this.probing = false; });
    }, Math.max(1, Math.min(keepalive.idle / 3, 10_000)));
    this.keepaliveTimer.unref();
  }

  /** One attempt. `login.fresh` tells whether it went past a held token to a
   *  full login, the identity proof included. */
  private async connectVerified(epoch: number, login: { fresh: boolean } = { fresh: false }): Promise<void> {
    const reused = await this.reusedTicket(epoch);
    if (reused) {
      await this.openRelay(epoch, reused.access, reused.ticket);
      return;
    }
    login.fresh = true;
    try {
      const discovered = await discoverServerIdentity({
        origin: this.environment.server_origin,
        fetchFn: this.fetchImpl,
        pinnedFingerprint: this.environment.server_identity_fingerprint,
      });
      if (discovered.fingerprint !== this.environment.server_identity_fingerprint) {
        throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity changed');
      }
    } catch (error) {
      if (this.epoch === epoch && error instanceof RemoteProtocolError && error.message === 'server identity changed') this.reset();
      throw error;
    }
    this.assertEpoch(epoch);
    await this.connectOnce(epoch);
  }

  /**
   * A ws ticket from the device token this client holds, while it stays
   * valid for the same pinned Server, Host and device key: a reconnect then
   * costs one request instead of the identity proof and three logins. Null
   * when there is none, or the Server no longer accepts it (a full login
   * follows).
   */
  private async reusedTicket(epoch: number): Promise<{ access: DeviceAccess; ticket: string } | null> {
    const access = this.access;
    if (!access || access.key !== accessKey(this.environment) || Date.now() >= access.renewAt) {
      this.access = null;
      return null;
    }
    let ticket: string;
    try {
      ticket = parseClosed(wsTicketResultSchema, await this.post('/api/v1/ws-tickets',
        { host_id: this.environment.host_id }, access.token)).ticket;
    } catch (error) {
      if (this.access === access) this.access = null;
      if (!(error instanceof RemoteProtocolError) || error.code !== 'AUTH_REQUIRED') throw error;
      // Something changed on the Server: prove admission again as well.
      this.admittedUntil = 0;
      return null;
    }
    this.assertEpoch(epoch);
    return { access, ticket };
  }

  request(method: RemoteMethod, params: unknown, commandId = generateUuidV7()): Promise<unknown> {
    const serialized = JSON.stringify(params);
    const existing = this.requests.get(commandId);
    if (existing) return existing.method === method && existing.params === serialized ? existing.promise
      : Promise.reject(new RemoteProtocolError('INVALID_FRAME', 'command identity reused with different input'));
    const promise = this.requestOnce(method, params, commandId).finally(() => this.requests.delete(commandId));
    this.requests.set(commandId, { method, params: serialized, promise });
    return promise;
  }

  private async requestOnce(method: RemoteMethod, params: unknown, commandId: string,
    timeoutMs = this.callTimeoutMs): Promise<unknown> {
    await this.connect();
    const relay = this.relay;
    if (!relay?.isOpen) throw new RemoteProtocolError('HOST_OFFLINE', 'execution Host disconnected');
    return new Promise((resolve, reject) => {
      const sentAt = Date.now();
      const timer = setTimeout(() => {
        if (this.relay !== relay || !this.pending.has(commandId)) return;
        // A live relay socket does not prove the executing Host still has
        // this E2EE channel. A lost notice must not pin later calls to it, so
        // silence for the whole window closes the channel. Any frame that
        // arrived meanwhile proves the channel alive: only this call failed.
        if (this.lastInboundAt <= sentAt) { this.drop(); return; }
        this.pending.delete(commandId);
        reject(new RemoteProtocolError(isRead(method) ? 'HOST_OFFLINE' : 'UNKNOWN_OUTCOME',
          `remote Host did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`, { reason: 'timeout' }));
      }, timeoutMs);
      timer.unref();
      this.pending.set(commandId, { method, resolve, reject, timer });
      void relay.sendControl({ type: 'command.request', command_id: commandId,
        attempt_id: generateCanonicalId(), created_at: timestampOf(commandId), method, params,
        expected: { host_generation: relay.hostGeneration } }).catch(() => {
        const request = this.pending.get(commandId);
        if (!request) return;
        clearTimeout(timer); this.pending.delete(commandId);
        reject(new RemoteProtocolError(isRead(method) ? 'HOST_OFFLINE' : 'UNKNOWN_OUTCOME', 'remote connection lost'));
      });
    });
  }

  onControl(listener: (message: Record<string, unknown>) => void | Promise<void>): () => void {
    this.controls.add(listener);
    return () => this.controls.delete(listener);
  }

  /** Run `listener` once when the connection open now closes, for whatever
   *  reason (socket, presence notice, removal); at once when none is open.
   *  A transfer uses it to fail fast instead of waiting out its timeout. */
  onClose(listener: () => void): () => void {
    if (!this.connected) {
      queueMicrotask(listener);
      return () => {};
    }
    this.closeWatchers.add(listener);
    return () => this.closeWatchers.delete(listener);
  }

  async sendControl(message: object): Promise<void> { await this.connect(); await this.relay!.sendControl(message); }
  async sendContent(message: object): Promise<void> { await this.connect(); await this.relay!.sendContent(message); }

  /** Close for good: a removed environment's client never connects again,
   *  not even for a call that already held it (a sync between pages). */
  retire(): void {
    this.retired = true;
    this.close();
  }

  /** Close the channel on purpose: an attempt in flight is cancelled, and
   *  nothing reconnects until a caller asks. */
  close(): void {
    this.closes += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reset();
  }

  private reset(): void {
    this.epoch += 1;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
    this.connecting = null;
    const relay = this.relay;
    this.relay = null;
    relay?.close('closed');
    this.rejectPending();
    const watchers = [...this.closeWatchers];
    this.closeWatchers.clear();
    for (const watcher of watchers) watcher();
    if (this.reportedConnected) {
      this.reportedConnected = false;
      this.onConnectionChange?.(false);
    }
  }

  private rejectPending(): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new RemoteProtocolError(isRead(request.method) ? 'HOST_OFFLINE' : 'UNKNOWN_OUTCOME', 'remote connection closed'));
    }
    this.pending.clear();
  }

  private async connectOnce(epoch: number): Promise<void> {
    const environment = this.environment;
    const verifier = new HttpRemoteServerAuthClient(environment.server_origin, this.identity, this.fetchImpl);
    const server = await verifier.challenge(environment.host_id);
    this.assertEpoch(epoch);
    if (server.server_identity_fingerprint !== environment.server_identity_fingerprint
      || await identityFingerprint(server.server_identity.public_key) !== environment.server_identity_fingerprint
      || server.expires_at <= Date.now()) throw new RemoteProtocolError('AUTH_REQUIRED', 'Server identity changed');
    const signatureOk = await verifyBytes(await importP256PublicKey(server.server_identity.public_key, 'verify'),
      new TextEncoder().encode(serverChallengePayload({ host_id: environment.host_id, challenge_id: server.challenge_id,
        challenge: server.challenge, expires_at: server.expires_at, fingerprint: environment.server_identity_fingerprint })),
      base64UrlToBytes(server.server_identity_signature));
    if (!signatureOk) throw new RemoteProtocolError('AUTH_REQUIRED', 'Server signature invalid');
    if (Date.now() >= this.admittedUntil) await this.migrateControllerAdmission();
    this.assertEpoch(epoch);
    const challenge = parseClosed(deviceChallengeResultSchema, await this.post('/api/v1/sessions/device-challenge', {
      browser_installation_id: environment.browser_id, host_id: environment.host_id,
    }));
    this.assertEpoch(epoch);
    const loginSentAt = Date.now();
    const login = parseClosed(deviceLoginResultSchema, await this.post('/api/v1/sessions/device-login', {
      browser_installation_id: environment.browser_id, host_id: environment.host_id, challenge_id: challenge.challenge_id,
      signature: await this.sign(new TextEncoder().encode(challenge.challenge_id)),
    }));
    this.assertEpoch(epoch);
    if (environment.host_public_key_json
      && await identityFingerprint(JSON.parse(environment.host_public_key_json)) !== await identityFingerprint(login.host_public_key)) {
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Host key changed');
    }
    this.assertEpoch(epoch);
    const publicKey = environment.device_public_key_json
      ? JSON.parse(environment.device_public_key_json) as { kty: 'EC'; crv: 'P-256'; x: string; y: string }
      : (await this.identity.ensureControllerIdentity?.(environment.browser_id))?.public_key;
    if (!publicKey) throw new RemoteProtocolError('AUTH_REQUIRED', 'secure controller identity unavailable');
    this.assertEpoch(epoch);
    environment.device_id = login.device_id;
    environment.device_public_key_json = JSON.stringify(publicKey);
    environment.crypto_connection_id = login.crypto_connection_id;
    environment.host_public_key_json = JSON.stringify(login.host_public_key);
    environment.pairing_id = null;
    this.save(environment);
    const access: DeviceAccess = { key: accessKey(environment), token: login.access_token,
      renewAt: loginSentAt + ACCESS_TOKEN_TTL_MS - ACCESS_RENEW_MARGIN_MS, deviceId: login.device_id,
      cryptoConnectionId: login.crypto_connection_id, hostPublicKey: login.host_public_key };
    // Kept before the ticket: a refused or failed ticket must not cost the next attempt a login.
    this.access = access;
    const ticket = parseClosed(wsTicketResultSchema, await this.post('/api/v1/ws-tickets', { host_id: environment.host_id }, login.access_token));
    this.assertEpoch(epoch);
    await this.openRelay(epoch, access, ticket.ticket);
  }

  /** Open the relay with a ws ticket and complete the end-to-end handshake. */
  private async openRelay(epoch: number, access: DeviceAccess, ticket: string): Promise<void> {
    const environment = this.environment;
    const publicKey = JSON.parse(environment.device_public_key_json!) as { kty: 'EC'; crv: 'P-256'; x: string; y: string };
    const relay = this.createRelay({
      wsUrl: environment.server_origin.replace(/^https:/, 'wss:') + '/ws', ticket,
      hostId: environment.host_id, deviceId: access.deviceId, cryptoConnectionId: access.cryptoConnectionId,
      hostPublicKey: access.hostPublicKey, application: 'gian-native', requireNegotiated: true, requireExecution: true,
      // Only this controller asks for change hints and item detail; Hosts
      // that predate them answer without the features, keep being polled and
      // send bare history items.
      hello: { executionHintsV1: true, executionDetailV1: true },
      identity: { hostId: environment.host_id, publicJwk: publicKey, sign: bytes => this.sign(bytes) },
      handlers: {
        onNotice: notice => {
          if (this.epoch !== epoch || this.relay !== relay || notice.host_id !== environment.host_id) return;
          if (notice.type === 'host.offline' || notice.type === 'host.online'
            || (notice.type === 'device.revoked' && notice.device_id === environment.device_id)) {
            // Presence changes invalidate the handshake even if the relay
            // socket survives; uncertain mutations are rejected, never
            // replayed here. host.online means the Host is back on a new
            // relay, so the handshake is redone at once (a reused token
            // keeps that to one request).
            this.drop({ immediate: notice.type === 'host.online' });
          }
        },
        onControl: async message => {
          if (this.epoch !== epoch || this.relay !== relay) return;
          this.lastInboundAt = Date.now();
          if (message.type === 'command.result') {
            const result = parseClosed(commandResultSchema, message);
            const pending = this.pending.get(result.command_id);
            if (pending) {
              clearTimeout(pending.timer); this.pending.delete(result.command_id);
              if (result.ok) {
                try {
                  const parsed = REMOTE_METHOD_RESULTS[pending.method].safeParse(result.data);
                  if (!parsed.success) throw new Error('invalid result');
                  pending.resolve(parsed.data);
                }
                catch { pending.reject(new RemoteProtocolError('INVALID_FRAME', 'invalid remote command result')); }
              } else pending.reject(new RemoteProtocolError(result.error?.code ?? 'UNKNOWN_OUTCOME', result.error?.message ?? 'remote command failed'));
            }
          }
          for (const listener of this.controls) await listener(message);
        },
        // A close during the handshake fails relay.connect() below instead.
        onClose: () => { if (this.relay === relay && this.reportedConnected) this.drop(); },
      },
    });
    this.relay = relay;
    try {
      await relay.connect();
      this.assertEpoch(epoch);
      if (!relay.isOpen) throw new RemoteProtocolError('HOST_OFFLINE', 'remote connection closed during the handshake');
    } catch (error) { if (this.epoch === epoch) this.reset(); else relay.close('superseded'); throw error; }
    // The completed handshake is the first proof that this channel is alive.
    this.lastInboundAt = Date.now();
    if (!this.reportedConnected) {
      this.reportedConnected = true;
      this.onConnectionChange?.(true);
    }
  }

  private async migrateControllerAdmission(): Promise<void> {
    const environment = this.environment;
    if (!environment.device_id || !environment.device_public_key_json) return;
    const verifier = new HttpRemoteServerAuthClient(environment.server_origin, this.identity, this.fetchImpl);
    const sentAt = Date.now();
    const login = async () => {
      await verifier.controllerLogin(environment.browser_id, bytes => this.sign(bytes));
      // The controller token itself is never needed again: only that it was issued.
      this.admittedUntil = sentAt + ACCESS_TOKEN_TTL_MS - ACCESS_RENEW_MARGIN_MS;
    };
    try {
      await login();
      return;
    } catch (error) {
      if (error instanceof RemoteProtocolError && error.code === 'CONTROLLER_REVOKED') throw error;
      if (!(error instanceof RemoteProtocolError) || error.code !== 'CONTROLLER_NOT_ADMITTED') return;
    }
    let challenge;
    try {
      challenge = parseClosed(controllerChallengeResultSchema, await this.post('/api/v1/controller-migrations/challenge', {
        browser_installation_id: environment.browser_id,
        host_id: environment.host_id,
        device_public_key: JSON.parse(environment.device_public_key_json),
      }));
    } catch (error) {
      if (error instanceof RemoteProtocolError && error.code === 'CONTROLLER_ALREADY_ADMITTED') return;
      if (error instanceof RemoteProtocolError && ['INVALID_FRAME', 'AUTH_REQUIRED'].includes(error.code)) return;
      throw error;
    }
    try {
      await this.post('/api/v1/controller-migrations/login', {
        browser_installation_id: environment.browser_id,
        host_id: environment.host_id,
        challenge_id: challenge.challenge_id,
        signature: await this.sign(new TextEncoder().encode(challenge.challenge_id)),
      });
    } catch (error) {
      if (error instanceof RemoteProtocolError && error.code === 'CONTROLLER_ALREADY_ADMITTED') return;
      try { await login(); }
      catch { throw error; }
    }
  }

  private assertEpoch(epoch: number): void {
    if (epoch !== this.epoch) throw new RemoteProtocolError('HOST_OFFLINE', 'remote connection superseded');
  }

  private async post(path: string, body: Record<string, unknown>, accessToken?: string): Promise<unknown> {
    const response = await this.fetchImpl(new URL(path, this.environment.server_origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', origin: this.environment.server_origin,
        ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL, ...body }),
    });
    const json = await response.json() as Record<string, unknown> & { error?: { code?: string } };
    if (!response.ok) {
      const code = json.error?.code;
      const retryAfterSeconds = Number(response.headers.get('retry-after'));
      if (code === 'RATE_LIMITED') {
        throw new RemoteProtocolError(code, 'Remote Server rate limited this Mac',
          Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? { retryAfterSeconds } : undefined);
      }
      if (code && isRemoteErrorCode(code)) throw new RemoteProtocolError(code, 'Remote login or pairing required');
      throw new RemoteProtocolError('AUTH_REQUIRED', 'Remote login or pairing required');
    }
    return json;
  }

  private async sign(bytes: Uint8Array): Promise<string> {
    if (this.environment.device_public_key_json) {
      let paired: { kty?: string; crv?: string; x?: string; y?: string };
      try { paired = JSON.parse(this.environment.device_public_key_json) as typeof paired; }
      catch { throw new RemoteProtocolError('AUTH_REQUIRED', 'stored controller identity is invalid'); }
      const host = await this.identity.ensurePublic();
      if (paired.kty === host.public_key.kty && paired.crv === host.public_key.crv
        && paired.x === host.public_key.x && paired.y === host.public_key.y) {
        return this.identity.sign(bytes);
      }
    }
    if (!this.identity.signControllerIdentity) throw new RemoteProtocolError('AUTH_REQUIRED', 'secure controller signer unavailable');
    return this.identity.signControllerIdentity(this.environment.browser_id, bytes);
  }
}

/** Node's codes for a connection that failed or broke; undici adds its own UND_ERR_*. */
const NETWORK_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'ETIMEDOUT', 'EPIPE']);
/** How a DeviceRelayClient fails when its socket never comes up. */
const RELAY_CONNECT_FAILURES = new Set(['device relay socket error', 'device relay auth timed out', 'socket_closed', 'server_shutdown']);

/** Whether `error` is the network failing (fetch, a timeout, the relay
 *  socket not coming up) rather than a refusal or a programming error. */
export function isNetworkFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || error instanceof RemoteProtocolError) return false;
  const { name, message, code, cause } = error as { name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown } | null };
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  if (error instanceof TypeError && message === 'fetch failed') return true;
  if ([code, cause?.code].some(value => typeof value === 'string'
    && (NETWORK_ERROR_CODES.has(value) || value.startsWith('UND_ERR_')))) return true;
  return error instanceof Error && typeof message === 'string' && RELAY_CONNECT_FAILURES.has(message);
}

/** How a failed connection attempt reads to its callers. The network failing
 *  is an unreachable Server, not fetch's own words. A relay closed because the
 *  Host is offline (after an outage the Server can be back before the Host
 *  is) rejects the crypto handshake with a bare Error('HOST_OFFLINE'); that is
 *  an offline Host. Both stay transient, so a user's action keeps waiting. */
export function connectionFailure(error: unknown): unknown {
  if (isNetworkFailure(error)) return new RemoteProtocolError('HOST_OFFLINE', 'Cannot reach the Remote Server');
  if (error instanceof Error && !(error instanceof RemoteProtocolError) && error.message === 'HOST_OFFLINE') {
    return new RemoteProtocolError('HOST_OFFLINE', 'The remote Host is offline');
  }
  return error;
}

/** The Server's refusals of this Mac's pairing, as a user's action reports them. */
const PAIRING_REFUSALS: Partial<Record<RemoteProtocolError['code'], string>> = {
  DEVICE_REVOKED: 'This Mac is no longer paired with the remote Host. Pair it again in Settings › Remote.',
  DEVICE_NOT_PAIRED: 'This Mac is no longer paired with the remote Host. Pair it again in Settings › Remote.',
  CONTROLLER_REVOKED: 'The Remote Server no longer lets this Mac control other Gian installs.',
  CONTROLLER_NOT_ADMITTED: 'The Remote Server no longer admits this Mac to control other Gian installs. Pair it again in Settings › Remote.',
};

/** A failure a user's action may wait out: the Server unreachable or rate limiting. */
function transientFailure(error: unknown): boolean {
  return error instanceof RemoteProtocolError && (error.code === 'HOST_OFFLINE' || error.code === 'RATE_LIMITED');
}

/** The pinned Server, Host and device key a device token was issued for. */
function accessKey(environment: RemoteControllerEnvironment): string {
  return canonicalJson([environment.server_origin, environment.server_identity_fingerprint, environment.host_id,
    environment.browser_id, environment.device_public_key_json ?? null, environment.host_public_key_json]);
}

function isRead(method: RemoteMethod): boolean {
  return ['execution.list', 'execution.sync', 'catalog.read', 'catalog.agent', 'state.refresh', 'session.page',
    'proxy.logo', 'file.preview', 'file.resolve', 'file.tree', 'file.list', 'git.read', 'command.status'].includes(method);
}
function timestampOf(commandId: string): number { return Number.parseInt(commandId.replaceAll('-', '').slice(0, 12), 16); }
