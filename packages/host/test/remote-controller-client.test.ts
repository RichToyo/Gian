import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { bytesToBase64Url, createRemoteHello, exportPublicJwk, generateCanonicalId, generateP256SigningKeyPair, identityFingerprint, signBytes,
  RemoteProtocolError, type DeviceRelayClientOptions } from '@gian/remote-protocol';
import { enrollHost, makeRemoteTestApp, pairDevice } from '../../remote-server/test/fixture.js';
import { RECONNECT_BACKOFF_MS, RemoteControllerClient, connectionFailure, isNetworkFailure, type RemoteConnectionHooks,
  type RemoteControllerEnvironment } from '../src/remote/controller-client.js';
import { RemoteControllerContent } from '../src/remote/controller-content.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';

class Relay {
  isOpen = false;
  closed = false;
  negotiatedCapabilities: readonly string[] | null = null;
  hostGeneration = generateCanonicalId();
  sent: Array<{ command_id: string; method: string; expected: { host_generation: string } }> = [];
  constructor(readonly options: DeviceRelayClientOptions) {}
  async connect() { this.isOpen = true; }
  async sendControl(message: object) { this.sent.push(message as typeof this.sent[number]); }
  async sendContent() {}
  close(reason?: string) { this.closed = true; this.isOpen = false; this.options.handlers.onClose?.(reason ?? 'closed'); }
  notice(type: 'host.offline' | 'host.online', hostId = this.options.hostId) {
    this.options.handlers.onNotice?.({ protocol: 'gian.relay/1', type, host_id: hostId, sent_at: Date.now() });
  }
  reply(commandId: string, data: unknown) {
    return this.options.handlers.onControl({ type: 'command.result', command_id: commandId, attempt_id: generateCanonicalId(), ok: true, data });
  }
}

test('controller reports only capabilities negotiated by its connected relay', async () => {
  const f = await fixture();
  try {
    const feature = 'wire.device_execution_target';
    assert.equal(f.client.supports(feature), false, 'a disconnected client has no capabilities');

    await f.client.connect();
    const relay = f.relays[0]!;
    assert.equal(f.client.supports(feature), false, 'an unnegotiated capability is denied');
    const offer = createRemoteHello(relay.options.deviceId, relay.options.application ?? 'remote-web', relay.options.hello);
    assert.ok(offer.capabilities.includes('wire.execution_hints_v1'), 'the desktop controller asks for change hints');
    assert.ok(offer.capabilities.includes('wire.execution_detail_v1'), 'and for history item detail');
    assert.ok(!offer.capabilities.includes('wire.session_directory_v1'));

    relay.negotiatedCapabilities = [feature];
    assert.equal(f.client.supports(feature), true);
    assert.equal(f.client.supports('wire.unknown_feature'), false);

    relay.negotiatedCapabilities = [];
    assert.equal(f.client.supports(feature), false, 'a missing capability is denied');
    relay.negotiatedCapabilities = [feature];
    f.client.close();
    assert.equal(f.client.supports(feature), false, 'closing the relay removes its capabilities');
  } finally { f.close(); }
});

async function until(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function fixture(onConnectionChange?: (connected: boolean) => void, identityGate?: Promise<void>,
  callTimeoutMs?: number, hooks?: RemoteConnectionHooks) {
  const server = await makeRemoteTestApp();
  const host = await enrollHost(server.fetch);
  const device = await pairDevice(server.fetch, host.accessToken, host.hostId);
  const identity = new MemoryRemoteIdentity();
  const public_key = await exportPublicJwk(device.keys.publicKey);
  identity.ensureControllerIdentity = async () => ({ public_key, fingerprint: await identityFingerprint(public_key) });
  identity.signControllerIdentity = async (_scope, bytes) => signBytes(device.keys.privateKey, bytes);
  const origin = 'https://remote.test';
  const fingerprint = server.handle.services.identity.fingerprint;
  await identity.setAccountSession(origin, { role: 'controller', serverOrigin: origin, serverFingerprint: fingerprint,
    installationId: device.accountPeerId, accountId: '42', accountLogin: 'test-account', token: device.accountToken,
    expiresAt: Date.now() + 60_000 }, 'controller');
  const relays: Relay[] = [];
  let identityRequests = 0;
  /** Every Server request path, in order. */
  const paths: string[] = [];
  /** Answers a request instead of the Server; throwing fails it like a network error. */
  let intercept: ((path: string) => Response | undefined) | null = null;
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === '/api/v1/server-identity') {
      identityRequests += 1;
      await identityGate;
    }
    return intercept?.(path) ?? server.fetch(path, init);
  };
  const make = (environment: RemoteControllerEnvironment) => new RemoteControllerClient(environment, identity, () => {}, fetchImpl,
    options => { const relay = new Relay(options); relays.push(relay); return relay; }, onConnectionChange, callTimeoutMs, hooks);
  const client = make({ id: generateCanonicalId(), name: 'test', server_origin: origin,
    server_identity_fingerprint: fingerprint, host_id: host.hostId, browser_id: device.browserId,
    device_id: device.deviceId, device_public_key_json: JSON.stringify(public_key), crypto_connection_id: device.cryptoConnectionId,
    host_public_key_json: null, pairing_id: null, created_at: Date.now() });
  return { client, relays, identityRequests: () => identityRequests, paths, server, device,
    /** A new client for the same environment, as pairing it again gives it. */
    pairAgain: () => make(client.environment),
    intercept(next: ((path: string) => Response | undefined) | null) { intercept = next; },
    controller: () => server.handle.services.repos.getController(device.browserId),
    close() { client.close(); server.handle.shutdown(); } };
}

test('a different Host key is refused even when the Server proves its identity, until the environment is paired again', async () => {
  const f = await fixture();
  let repaired: RemoteControllerClient | null = null;
  try {
    await f.client.connect();
    const pinned = f.client.environment.host_public_key_json;
    assert.ok(pinned, 'the first connection pins the Host key');
    f.client.close();
    f.client.environment.host_public_key_json = JSON.stringify(await exportPublicJwk((await generateP256SigningKeyPair()).publicKey));
    await assert.rejects(f.client.connect(), /Host key changed/);
    assert.equal(f.relays.length, 1, 'no relay is opened for an unexpected Host key');
    f.client.environment.host_public_key_json = pinned;
    // A fresh login met it, so no caller tries again, not even a user's action.
    const requests = f.paths.length;
    await assert.rejects(f.client.connect(), /Host key changed/);
    await assert.rejects(f.client.connect({ user: true }), /Host key changed/);
    assert.equal(f.paths.length, requests);
    assert.equal(f.client.refused, true);
    // Pairing the environment again gives it a new client, which connects.
    repaired = f.pairAgain();
    await repaired.connect({ user: true });
    assert.equal(repaired.connected, true);
  } finally { repaired?.close(); f.close(); }
});

test('controller shares connection setup, reuses a live relay, and verifies the pin again after close', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 8 }, () => f.client.connect()));
    assert.equal(f.identityRequests(), 1, 'concurrent callers share one identity proof');
    assert.equal(f.relays.length, 1);
    await Promise.all(Array.from({ length: 20 }, () => f.client.connect()));
    assert.equal(f.identityRequests(), 1, 'an established relay does not re-fetch identity');
    f.client.close();
    f.client.environment.server_identity_fingerprint = 'b'.repeat(64);
    await assert.rejects(() => f.client.connect(), { code: 'AUTH_REQUIRED', message: 'server identity changed' });
    assert.equal(f.identityRequests(), 2, 'a new relay still verifies the pinned identity');
    assert.equal(f.relays.length, 1, 'a changed pin never opens a relay');
  } finally { f.close(); }
});

test('closing during identity verification fences the in-flight connection', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(undefined, gate);
  try {
    const attempt = f.client.connect();
    const rejected = assert.rejects(attempt, { code: 'HOST_OFFLINE', message: 'remote connection superseded' });
    await until(() => f.identityRequests() === 1);
    f.client.close();
    release();
    await rejected;
    assert.equal(f.relays.length, 0, 'a closed generation cannot open a relay');
  } finally { release(); f.close(); }
});

test('Host offline invalidates live relay crypto, rejects uncertain writes, and the next request negotiates anew', async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    assert.equal(f.controller()?.revoked_at, null, 'confirmed pairing key migrates Server admission');
    const old = f.relays[0]!;
    assert.equal(f.client.connected, true);
    old.notice('host.offline', generateCanonicalId());
    assert.equal(f.client.connected, true, 'another Host cannot invalidate this environment');
    const read = assert.rejects(f.client.request('catalog.read', {}), { code: 'HOST_OFFLINE' });
    const write = assert.rejects(f.client.request('session.stop', { session_id: generateCanonicalId(), session_revision: '1' }), { code: 'UNKNOWN_OUTCOME' });
    await until(() => old.sent.length === 2);
    old.notice('host.offline');
    assert.equal(f.client.connected, false, 'relay availability is not Host availability');
    assert.equal(old.closed, true);
    await Promise.all([read, write]);
    assert.equal(f.relays.length, 1, 'uncertain writes must not be replayed');

    const resumed = f.client.request('catalog.read', {});
    await until(() => f.relays[1]?.sent.length === 1);
    const fresh = f.relays[1]!;
    assert.notEqual(fresh.hostGeneration, old.hostGeneration);
    assert.equal(fresh.sent[0]!.expected.host_generation, fresh.hostGeneration);
    assert.equal(fresh.options.requireExecution, true);
    old.notice('host.online');
    old.options.handlers.onClose?.('late old socket close');
    assert.equal(f.client.connected, true, 'late old callbacks cannot close the new generation');
    await old.reply(fresh.sent[0]!.command_id, { invalid: 'old generation' });
    const catalog = { catalog_revision: 'new-generation', workspaces: [], agents: [], tasks: [] };
    await fresh.reply(fresh.sent[0]!.command_id, catalog);
    assert.deepEqual(await resumed, catalog);
    assert.deepEqual(fresh.sent.map(item => item.method), ['catalog.read']);
  } finally { f.close(); }
});

test('an unanswered call fails alone while the Host is heard from, and silence closes the channel', async () => {
  const f = await fixture(undefined, undefined, 150);
  try {
    await f.client.connect();
    const relay = f.relays[0]!;
    const sessionId = generateCanonicalId();
    const read = f.client.request('git.read', { session_id: sessionId, operation: 'changed' });
    const write = f.client.request('session.stop', { session_id: sessionId, session_revision: '1' });
    const readFailed = assert.rejects(read, (error: RemoteProtocolError) => {
      assert.equal(error.code, 'HOST_OFFLINE');
      assert.equal(error.details?.reason, 'timeout');
      return true;
    });
    const writeFailed = assert.rejects(write, (error: RemoteProtocolError) => {
      assert.equal(error.code, 'UNKNOWN_OUTCOME', 'a timed-out mutation may still have run');
      assert.equal(error.details?.reason, 'timeout');
      return true;
    });
    await until(() => relay.sent.length === 2);
    await new Promise(resolve => setTimeout(resolve, 20));
    // Any frame from the Host proves the E2EE channel is alive.
    await relay.options.handlers.onControl({ type: 'snapshot.required', reason: 'crypto_resumed' });
    await Promise.all([readFailed, writeFailed]);
    assert.equal(relay.closed, false, 'one slow call does not drop the connection');
    assert.equal(f.client.connected, true);

    // Nothing at all for a whole window: the channel is presumed dead and
    // every outstanding call fails with it.
    const first = assert.rejects(f.client.request('catalog.read', {}), { code: 'HOST_OFFLINE', message: 'remote connection closed' });
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = assert.rejects(f.client.request('session.stop', { session_id: sessionId, session_revision: '2' }),
      { code: 'UNKNOWN_OUTCOME', message: 'remote connection closed' });
    await Promise.all([first, second]);
    assert.equal(relay.closed, true);
    assert.equal(f.client.connected, false);
  } finally { f.close(); }
});

test('Host online replacement also invalidates the prior handshake without requiring an offline notice', async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    f.relays[0]!.notice('host.online');
    assert.equal(f.client.connected, false);
    await f.client.connect();
    assert.equal(f.relays.length, 2);
    assert.equal(f.client.connected, true);
  } finally { f.close(); }
});

test('onConnectionChange reports each connectivity transition exactly once', async () => {
  const events: boolean[] = [];
  const f = await fixture(connected => events.push(connected));
  try {
    // Closing a never-connected client is not a transition.
    f.client.close();
    assert.deepEqual(events, []);

    await f.client.connect();
    assert.deepEqual(events, [true]);

    // A connected close reports the loss…
    f.relays[0]!.close();
    assert.deepEqual(events, [true, false]);

    // …and reconnecting reports the recovery.
    await f.client.connect();
    assert.deepEqual(events, [true, false, true]);
  } finally { f.close(); }
});

test('a download fails at once when its connection closes mid-transfer, and the next one reconnects', async () => {
  const f = await fixture();
  try {
    const bytes = new TextEncoder().encode('remote attachment bytes');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const content = new RemoteControllerContent(f.client);
    const handle = generateCanonicalId();
    const requested = (relay: Relay | undefined) => (relay?.sent as unknown as Array<{ type?: string; transfer_id?: string }> | undefined)
      ?.find(message => message.type === 'download.request')?.transfer_id;
    const metadata = (transfer_id: string) => ({ type: 'download.metadata', transfer_id, name: 'shot.png', mime: 'image/png',
      size: bytes.length, sha256, disposition: 'inline', preview: true });
    const chunk = (transfer_id: string, from: number, to: number, transfer_sequence: number) => ({ type: 'attachment.chunk',
      transfer_id, transfer_sequence, offset: from, bytes: bytesToBase64Url(bytes.subarray(from, to)) });

    const started = Date.now();
    const first = content.download(handle);
    await until(() => requested(f.relays[0]) !== undefined);
    const relay = f.relays[0]!;
    const transfer = requested(relay)!;
    await relay.options.handlers.onControl(metadata(transfer));
    await relay.options.handlers.onControl(chunk(transfer, 0, 8, 0));
    relay.close();
    await assert.rejects(first, (error: RemoteProtocolError) => {
      assert.equal(error.code, 'HOST_OFFLINE');
      assert.match(error.message, /closed during the file download/);
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'the closed relay fails the transfer at once, not after its timeout');

    const second = content.download(handle);
    await until(() => requested(f.relays[1]) !== undefined);
    const next = f.relays[1]!;
    const retried = requested(next)!;
    await next.options.handlers.onControl(metadata(retried));
    await next.options.handlers.onControl(chunk(retried, 0, 8, 0));
    await next.options.handlers.onControl(chunk(retried, 8, bytes.length, 1));
    await next.options.handlers.onControl({ type: 'download.complete', transfer_id: retried, size: bytes.length, sha256 });
    const read = await second;
    assert.deepEqual([...read.bytes], [...bytes]);
    assert.equal(read.mime, 'image/png');
  } finally { f.close(); }
});

test('a download keeps the Host\'s reason for refusing it', async () => {
  const f = await fixture();
  try {
    const content = new RemoteControllerContent(f.client);
    for (const code of ['RATE_LIMITED', 'ATTACHMENT_NOT_FOUND'] as const) {
      const pending = content.download(generateCanonicalId());
      const sent = () => (f.relays[0]?.sent as unknown as Array<{ type?: string; transfer_id?: string }> | undefined)
        ?.filter(message => message.type === 'download.request') ?? [];
      const count = sent().length;
      await until(() => sent().length === count + 1);
      await f.relays[0]!.options.handlers.onControl({ type: 'transfer.error', transfer_id: sent().at(-1)!.transfer_id!,
        code, message: 'refused' });
      await assert.rejects(pending, { code });
    }
  } finally { f.close(); }
});

test('native pairing reuses the admitted Host key and never creates a second controller identity', async () => {
  const server = await makeRemoteTestApp();
  const host = await enrollHost(server.fetch);
  const identity = new MemoryRemoteIdentity();
  const hostPublicKey = await exportPublicJwk(host.keys.publicKey);
  identity.ensurePublic = async () => ({ public_key: hostPublicKey, fingerprint: await identityFingerprint(hostPublicKey) });
  identity.sign = async bytes => signBytes(host.keys.privateKey, bytes);
  identity.ensureControllerIdentity = async () => { throw new Error('a second controller identity must not be created'); };
  const fetchImpl: typeof fetch = async (url, init) => server.fetch(new URL(String(url)).pathname, init);
  let client: RemoteControllerClient | null = null;
  try {
    const challenge = await (await server.fetch('/api/v1/sessions/controller-challenge', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'gian.remote.auth/1', browser_installation_id: host.hostId }),
    })).json() as { challenge_id: string };
    const admission = await (await server.fetch('/api/v1/sessions/controller-login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'gian.remote.auth/1', browser_installation_id: host.hostId,
        challenge_id: challenge.challenge_id,
        signature: await signBytes(host.keys.privateKey, new TextEncoder().encode(challenge.challenge_id)) }),
    })).json() as { controller_access_token: string };
    const grant = await (await server.fetch('/api/v1/host/pairings', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${host.accessToken}` },
      body: JSON.stringify({ protocol: 'gian.remote.auth/1' }),
    })).json() as { code: string };
    const environment = await RemoteControllerClient.pair({ origin: 'https://remote.test', code: grant.code, name: 'Same Mac' },
      identity, { installationId: host.hostId, accessToken: admission.controller_access_token,
        serverIdentityFingerprint: server.handle.services.identity.fingerprint, hostIdentity: true }, fetchImpl);
    assert.equal(environment.browser_id, host.hostId);
    assert.deepEqual(JSON.parse(environment.device_public_key_json!), hostPublicKey);
    const pairing = server.handle.services.repos.getPairingByBrowserHost(host.hostId, host.hostId);
    assert.equal(pairing?.public_key_jwk, JSON.stringify(hostPublicKey));
    await server.fetch(`/api/v1/pairings/${environment.pairing_id}/confirm`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${host.accessToken}` },
      body: JSON.stringify({ protocol: 'gian.remote.auth/1', pairing_id: environment.pairing_id, decision: 'confirm' }),
    });
    const relays: Relay[] = [];
    client = new RemoteControllerClient(environment, identity, () => {}, fetchImpl,
      options => { const relay = new Relay(options); relays.push(relay); return relay; });
    await client.connect();
    assert.equal(client.connected, true);
    assert.deepEqual(relays[0]!.options.identity.publicJwk, hostPublicKey);
  } finally { client?.close(); server.handle.shutdown(); }
});

test('a rate-limited pairing claim keeps the Server\'s Retry-After', async () => {
  const server = await makeRemoteTestApp();
  try {
    const fetchImpl: typeof fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === '/api/v1/pairings/claim') {
        return Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'retry-after': '27' } });
      }
      return server.fetch(path, init);
    };
    await assert.rejects(RemoteControllerClient.pair({ origin: 'https://remote.test', code: 'ABCD-EFGH', name: 'Studio Mac' },
      new MemoryRemoteIdentity(), { installationId: generateCanonicalId(), accessToken: 'fixture-only',
        serverIdentityFingerprint: server.handle.services.identity.fingerprint, hostIdentity: true }, fetchImpl),
    (error: RemoteProtocolError) => {
      assert.equal(error.code, 'RATE_LIMITED');
      assert.equal(error.details?.retryAfterSeconds, 27);
      return true;
    });
  } finally { server.handle.shutdown(); }
});

const FULL_LOGIN = ['/api/v1/server-identity', '/api/v1/host/connector-challenge', '/api/v1/sessions/controller-challenge',
  '/api/v1/sessions/controller-login', '/api/v1/sessions/device-challenge', '/api/v1/sessions/device-login', '/api/v1/ws-tickets'];

test('a reconnect reuses the device token it holds, and a token the Server dropped falls back to one full login', async () => {
  const f = await fixture();
  try {
    await f.client.connect();
    // The first connection also migrates this paired key to controller admission.
    assert.deepEqual([f.paths[0], f.paths.at(-2), f.paths.at(-1)],
      ['/api/v1/server-identity', '/api/v1/sessions/device-login', '/api/v1/ws-tickets']);
    f.paths.splice(0);
    f.relays[0]!.close();
    await f.client.connect();
    assert.deepEqual(f.paths.splice(0), ['/api/v1/ws-tickets'], 'only a fresh ws ticket while the token is valid');
    assert.equal(f.client.connected, true);
    assert.equal(f.relays[1]!.options.deviceId, f.relays[0]!.options.deviceId);

    // The Server forgot the token (a restart, a revoked session family).
    f.server.handle.services.tokens.revokeDevice(f.device.deviceId);
    f.relays[1]!.close();
    await f.client.connect();
    assert.deepEqual(f.paths.splice(0), ['/api/v1/ws-tickets', ...FULL_LOGIN],
      'AUTH_REQUIRED falls back to one full login, controller admission included');
    assert.equal(f.client.connected, true);

    // Near its expiry the token is not reused either.
    (f.client as unknown as { access: { renewAt: number } }).access.renewAt = Date.now();
    f.relays[2]!.close();
    await f.client.connect();
    assert.deepEqual(f.paths.splice(0), FULL_LOGIN.filter(path => !path.includes('/controller-')),
      'controller admission proven minutes ago is not proven again');
  } finally { f.close(); }
});

test('an expired device token logs in afresh and is no refusal; an AUTH_REQUIRED that fresh login meets holds every caller', async () => {
  const failed: unknown[] = [];
  const f = await fixture(undefined, undefined, undefined, { onAttemptFailed: error => failed.push(error) });
  try {
    await f.client.connect();
    // The Server no longer takes the token held (it expired there, or the Server restarted).
    f.server.handle.services.tokens.revokeDevice(f.device.deviceId);
    f.relays[0]!.close();
    f.paths.splice(0);
    await f.client.connect();
    assert.deepEqual(f.paths.splice(0), ['/api/v1/ws-tickets', ...FULL_LOGIN], 'the refused token is followed by one full login');
    assert.equal(f.client.connected, true);
    assert.equal(f.client.refused, false);
    assert.deepEqual(failed, []);

    // Now the Server refuses the full login itself.
    f.server.handle.services.tokens.revokeDevice(f.device.deviceId);
    f.intercept(path => path === '/api/v1/sessions/device-login'
      ? Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 }) : undefined);
    f.relays[1]!.close();
    await assert.rejects(f.client.connect(), { code: 'AUTH_REQUIRED' });
    assert.deepEqual(f.paths.splice(0), ['/api/v1/ws-tickets', ...FULL_LOGIN.slice(0, -1)]);
    assert.equal(f.client.refused, true);
    f.client.reconnectNow();
    await assert.rejects(f.client.connect(), { code: 'AUTH_REQUIRED' });
    await assert.rejects(f.client.connect({ user: true }), { code: 'AUTH_REQUIRED' });
    assert.deepEqual(f.paths, [], 'no caller reaches the Server again');
    assert.equal(failed.length, 1);
  } finally { f.close(); }
});

test('a failed attempt backs off with bounded jitter, honours Retry-After, and holds background callers', async () => {
  const draws = [0, 0.999999];
  const f = await fixture(undefined, undefined, undefined, { random: () => draws.shift() ?? 0.5 });
  try {
    f.intercept(() => { throw new TypeError('fetch failed'); });
    let started = Date.now();
    await assert.rejects(f.client.connect(), { code: 'HOST_OFFLINE' });
    let wait = f.client.retryAt - started;
    assert.ok(wait >= RECONNECT_BACKOFF_MS.first / 2 && wait <= RECONNECT_BACKOFF_MS.first / 2 + 50, `lowest draw waits half: ${wait}`);
    const requests = f.paths.length;
    await assert.rejects(f.client.connect(), { code: 'HOST_OFFLINE' });
    assert.equal(f.paths.length, requests, 'a background caller does not try again during the backoff');
    assert.equal(f.client.backingOff, true);

    // The wait is over: the next failure doubles the step.
    (f.client as unknown as { nextAttemptAt: number }).nextAttemptAt = 0;
    started = Date.now();
    await assert.rejects(f.client.connect(), { code: 'HOST_OFFLINE' });
    wait = f.client.retryAt - started;
    const second = RECONNECT_BACKOFF_MS.first * 2;
    assert.ok(f.paths.length > requests);
    assert.ok(wait >= second * 0.99 && wait <= second + 50, `highest draw waits all of the doubled step: ${wait}`);

    // The Server rate limits this Mac: its Retry-After decides.
    f.intercept(path => path === '/api/v1/server-identity' ? undefined : path === '/api/v1/host/connector-challenge'
      ? Response.json({ error: { code: 'RATE_LIMITED' } }, { status: 429, headers: { 'retry-after': '7' } }) : undefined);
    (f.client as unknown as { nextAttemptAt: number }).nextAttemptAt = 0;
    started = Date.now();
    await assert.rejects(f.client.connect(), { code: 'RATE_LIMITED' });
    wait = f.client.retryAt - started;
    assert.ok(wait >= 7000 && wait <= 7050, `Retry-After 7 s: ${wait}`);
  } finally { f.close(); }
});

test('only the network failing counts as a network failure', () => {
  const cause = (code: string) => Object.assign(new Error(code), { code });
  for (const error of [new TypeError('fetch failed'), new TypeError('fetch failed', { cause: cause('UND_ERR_CONNECT_TIMEOUT') }),
    cause('ECONNREFUSED'), new Error('socket hang up', { cause: cause('ECONNRESET') }), cause('ENOTFOUND'), cause('EHOSTUNREACH'),
    cause('ETIMEDOUT'), cause('EPIPE'), new DOMException('timed out', 'TimeoutError'), new DOMException('aborted', 'AbortError'),
    new Error('device relay socket error'), new Error('device relay auth timed out')]) {
    assert.equal(isNetworkFailure(error), true, String(error));
  }
  for (const error of [new TypeError('Invalid URL'), new TypeError('Cannot read properties of undefined'), new Error('auth_required'),
    new RemoteProtocolError('HOST_OFFLINE', 'fetch failed'), new RemoteProtocolError('AUTH_REQUIRED', 'pairing rejected'),
    'fetch failed', null]) {
    assert.equal(isNetworkFailure(error), false, String(error));
  }
});

test('a failed attempt reads as an unreachable Server or an offline Host, and both stay transient', () => {
  const unreachable = connectionFailure(new TypeError('fetch failed'));
  assert.ok(unreachable instanceof RemoteProtocolError);
  assert.equal(unreachable.code, 'HOST_OFFLINE');
  assert.equal(unreachable.message, 'Cannot reach the Remote Server');
  // Live: after an outage the Server was back before the Host, and the relay
  // client rejected its crypto handshake with a bare Error('HOST_OFFLINE').
  const offline = connectionFailure(new Error('HOST_OFFLINE'));
  assert.ok(offline instanceof RemoteProtocolError);
  assert.equal(offline.code, 'HOST_OFFLINE');
  assert.equal(offline.message, 'The remote Host is offline');
  const refused = new RemoteProtocolError('AUTH_REQUIRED', 'pairing rejected');
  assert.equal(connectionFailure(refused), refused);
  const bug = new TypeError('Cannot read properties of undefined');
  assert.equal(connectionFailure(bug), bug);
});

test('an attempt the network fails reads as an unreachable Server, and other failures are kept as they are', async () => {
  const failed: unknown[] = [];
  const f = await fixture(undefined, undefined, undefined, { onAttemptFailed: error => failed.push(error) });
  try {
    await f.client.connect();
    f.relays[0]!.close();
    // As live: the held device token asks for a ws ticket from a Server that is down.
    f.intercept(path => { if (path === '/api/v1/ws-tickets') throw new TypeError('fetch failed'); return undefined; });
    await assert.rejects(f.client.connect(), { code: 'HOST_OFFLINE', message: 'Cannot reach the Remote Server' });
    assert.equal(f.paths.at(-1), '/api/v1/ws-tickets');
    assert.ok(failed[0] instanceof RemoteProtocolError && failed[0].message === 'Cannot reach the Remote Server');
    await assert.rejects(f.client.connect(), (error: RemoteProtocolError) => {
      assert.equal(error.code, 'HOST_OFFLINE');
      assert.equal(error.message, 'Cannot reach the Remote Server', 'the backoff error says so too');
      assert.ok(Number(error.details?.retryAfterSeconds) >= 1);
      return true;
    });

    const bug = new TypeError('Invalid URL');
    f.intercept(path => { if (path === '/api/v1/sessions/device-challenge') throw bug; return undefined; });
    (f.client as unknown as { nextAttemptAt: number }).nextAttemptAt = 0;
    await assert.rejects(f.client.connect(), error => error === bug);
    assert.equal(failed.at(-1), bug);
  } finally { f.close(); }
});

/** A client on mocked timers whose attempts `attempt` scripts: it throws to
 *  fail one, as fetch or the Server would. Unless `hooks` say otherwise, it
 *  is wanted and jitter sits at the top of its range, so each wait is the
 *  whole step: 1 s, 2 s, 4 s, 8 s, then 10 s. */
function scripted(t: TestContext, attempt: () => void, hooks: RemoteConnectionHooks = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
  const startedAt = Date.now();
  /** When each attempt started, in ms since the client was made. */
  const attempts: number[] = [];
  const relays: Relay[] = [];
  const hostPublicKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'E'.repeat(43), y: 'F'.repeat(43) };
  const environment = { id: generateCanonicalId(), name: 'test', server_origin: 'https://remote.test',
    server_identity_fingerprint: 'a'.repeat(64), host_id: generateCanonicalId(), browser_id: generateCanonicalId(),
    device_id: generateCanonicalId(), device_public_key_json: JSON.stringify(hostPublicKey), crypto_connection_id: generateCanonicalId(),
    host_public_key_json: null, pairing_id: null, created_at: Date.now() };
  const client = new RemoteControllerClient(environment, new MemoryRemoteIdentity(), () => {}, undefined,
    options => { const relay = new Relay(options); relays.push(relay); return relay; }, undefined, undefined,
    { wanted: () => true, random: () => 1, ...hooks });
  const internals = client as unknown as { openRelay(epoch: number, access: object, ticket: string): Promise<void> };
  (t.mock.method as unknown as (target: object, key: string, fn: unknown) => void)(client, 'connectVerified', async (epoch: number) => {
    attempts.push(Date.now() - startedAt);
    attempt();
    await internals.openRelay(epoch, { key: '', token: 'fixture-only', renewAt: 0, hostPublicKey,
      deviceId: environment.device_id, cryptoConnectionId: environment.crypto_connection_id }, 'fixture-ticket');
  });
  /** How a user action ended, once it has. */
  const outcome = (promise: Promise<void>) => {
    const state: { done: boolean; error?: unknown } = { done: false };
    void promise.then(() => { state.done = true; }, error => { state.done = true; state.error = error; });
    return state;
  };
  return { client, attempts, relays, outcome, async tick(ms: number) { t.mock.timers.tick(ms); await settle(); } };
}

async function settle() {
  for (let index = 0; index < 10; index += 1) await new Promise(resolve => setImmediate(resolve));
}

test('a user action during a short outage waits on the scheduled attempts and goes on once the Server is back', async t => {
  let down = false;
  const f = scripted(t, () => { if (down) throw new TypeError('fetch failed'); });
  try {
    await f.client.connect();
    down = true;
    f.relays[0]!.close();
    assert.equal(f.client.reconnecting, true);
    await f.tick(1000);
    assert.deepEqual(f.attempts, [0, 1000], 'the environment retries on its own after 1 s');

    await f.tick(500);
    const send = f.outcome(f.client.connect({ user: true }));
    await settle();
    assert.deepEqual(f.attempts, [0, 1000, 1500], 'a user action tries once at once');
    assert.equal(f.client.retryAt - Date.now(), 2000, 'its failure doubles the step');
    await f.tick(1999);
    assert.equal(send.done, false, 'then waits instead of failing');
    await f.tick(1);
    assert.deepEqual(f.attempts, [0, 1000, 1500, 3500], 'for the scheduled attempt, which it shares');
    assert.equal(send.done, false, 'and keeps waiting while the Server stays unreachable');

    down = false;
    await f.tick(3999);
    assert.equal(send.done, false);
    await f.tick(1);
    assert.deepEqual(send, { done: true }, 'the next scheduled attempt connects it');
    assert.deepEqual(f.attempts, [0, 1000, 1500, 3500, 7500], 'without any attempt beyond the schedule');
    assert.equal(f.client.connected, true);
  } finally { f.client.close(); }
});

test('a user action fails as an unreachable Server, not "fetch failed", once the outage outlasts its window', async t => {
  let down = false;
  const f = scripted(t, () => { if (down) throw new TypeError('fetch failed'); });
  try {
    await f.client.connect();
    down = true;
    f.relays[0]!.close();
    await f.tick(1000);
    await f.tick(500);
    const send = f.outcome(f.client.connect({ user: true }));
    await settle();
    // Its window ends at 16.5 s; the attempt at 15.5 s is the last one inside it.
    for (const step of [2000, 4000, 7999]) await f.tick(step);
    assert.equal(send.done, false);
    await f.tick(1);
    assert.deepEqual(f.attempts, [0, 1000, 1500, 3500, 7500, 15_500]);
    assert.equal(send.done, true, 'the next one, 10 s later, is past the window: it fails now');
    const error = send.error as RemoteProtocolError;
    assert.equal(error.code, 'HOST_OFFLINE');
    assert.equal(error.message, 'Cannot reach the Remote Server');
    assert.equal(error.details?.retryAfterSeconds, 10);
    await f.tick(16_000);
    assert.equal(f.attempts.length, 7, 'the environment keeps retrying on its own');
  } finally { f.client.close(); }
});

test('a permanent refusal ends a user action\'s wait at once', async t => {
  let failure: Error | null = null;
  const f = scripted(t, () => { if (failure) throw failure; });
  try {
    await f.client.connect();
    failure = new TypeError('fetch failed');
    f.relays[0]!.close();
    await f.tick(1000);
    await f.tick(500);
    const send = f.outcome(f.client.connect({ user: true }));
    await settle();
    assert.deepEqual(f.attempts, [0, 1000, 1500]);
    failure = new RemoteProtocolError('DEVICE_REVOKED', 'Remote login or pairing required');
    await f.tick(1999);
    assert.equal(send.done, false);
    await f.tick(1);
    assert.deepEqual(f.attempts, [0, 1000, 1500, 3500]);
    assert.equal(send.done, true, 'the scheduled attempt was refused: the wait ends there');
    assert.equal((send.error as RemoteProtocolError).code, 'DEVICE_REVOKED');
  } finally { f.client.close(); }
});

test('a Retry-After past the window fails a user action at once and is never tried inside', async t => {
  let failure: Error | null = null;
  const f = scripted(t, () => { if (failure) throw failure; });
  try {
    await f.client.connect();
    failure = new RemoteProtocolError('RATE_LIMITED', 'Remote Server rate limited this Mac', { retryAfterSeconds: 60 });
    f.relays[0]!.close();
    await f.tick(1000);
    assert.deepEqual(f.attempts, [0, 1000]);
    const limited = f.outcome(f.client.connect({ user: true }));
    await settle();
    assert.equal(limited.done, true, 'a Retry-After the window cannot reach fails at once');
    assert.equal((limited.error as RemoteProtocolError).code, 'RATE_LIMITED');
    assert.equal(f.attempts.length, 2, 'and never tries inside it');
    await f.tick(60_000);
    assert.deepEqual(f.attempts, [0, 1000, 61_000], 'a rate limit stays transient: the environment tries once it ends');
  } finally { f.client.close(); }
});

test('once the Host removed this Mac nothing tries again: not the schedule, the Server-back signal or a background sync', async t => {
  let failure: Error | null = null;
  const failed: unknown[] = [];
  const f = scripted(t, () => { if (failure) throw failure; }, { onAttemptFailed: error => failed.push(error) });
  try {
    await f.client.connect();
    // Live: the Host's owner removed this Mac; the Server says so and refuses its pairing from then on.
    failure = new RemoteProtocolError('DEVICE_REVOKED', 'Remote login or pairing required');
    const relay = f.relays[0]!;
    relay.options.handlers.onNotice?.({ protocol: 'gian.relay/1', type: 'device.revoked', host_id: relay.options.hostId,
      device_id: relay.options.deviceId, sent_at: Date.now() } as never);
    assert.equal(f.client.connected, false);
    await f.tick(1000);
    assert.deepEqual(f.attempts, [0, 1000], 'one attempt finds out why');
    assert.equal(f.client.refused, true);
    assert.equal(f.client.reconnecting, false, 'nothing is being restored');
    const readable = 'This Mac is no longer paired with the remote Host. Pair it again in Settings › Remote.';
    assert.deepEqual(failed.map(error => [(error as RemoteProtocolError).code, (error as RemoteProtocolError).message]),
      [['DEVICE_REVOKED', readable]], 'reported once, in words the user can act on');

    // Ten minutes of backoff schedule, Server-back signals, and the syncs a hint or the poller would start.
    for (let minute = 0; minute < 10; minute += 1) {
      f.client.reconnectNow();
      await assert.rejects(f.client.connect(), { code: 'DEVICE_REVOKED', message: readable });
      await f.tick(60_000);
    }
    assert.deepEqual(f.attempts, [0, 1000], 'no attempt after the refusal');
    assert.equal(f.relays.length, 1, 'no relay, so no keepalive either');
    assert.equal(failed.length, 1);

    // A user's send fails at once with the same refusal, without trying or waiting out its window.
    const send = f.outcome(f.client.connect({ user: true }));
    await settle();
    assert.equal(send.done, true);
    assert.equal((send.error as RemoteProtocolError).code, 'DEVICE_REVOKED');
    assert.equal((send.error as RemoteProtocolError).message, readable);
    assert.deepEqual(f.attempts, [0, 1000]);
  } finally { f.client.close(); }
});

test('a pairing the Host owner has not confirmed yet is retried; the other refusals of a pairing are not', async t => {
  let failure: Error | null = null;
  const f = scripted(t, () => { if (failure) throw failure; });
  try {
    f.client.environment.pairing_id = generateCanonicalId();
    failure = new RemoteProtocolError('DEVICE_NOT_PAIRED', 'Remote login or pairing required');
    await assert.rejects(f.client.connect(), { code: 'DEVICE_NOT_PAIRED' });
    await f.tick(1000);
    assert.deepEqual(f.attempts, [0, 1000], 'waiting for the owner\'s confirmation keeps the backoff');
    assert.equal(f.client.refused, false);
    failure = null;
    await f.tick(2000);
    assert.equal(f.client.connected, true);
  } finally { f.client.close(); t.mock.timers.reset(); }
  for (const code of ['DEVICE_NOT_PAIRED', 'CONTROLLER_REVOKED', 'CONTROLLER_NOT_ADMITTED'] as const) {
    const g = scripted(t, () => { throw new RemoteProtocolError(code, 'Remote login or pairing required'); });
    try {
      await assert.rejects(g.client.connect(), { code });
      await g.tick(60_000);
      assert.deepEqual(g.attempts, [0], code);
      assert.equal(g.client.refused, true, code);
    } finally { g.client.close(); t.mock.timers.reset(); }
  }
});

test('the reconnect backoff stops growing at 10 s, each wait drawn between half and all of it', async t => {
  const draws = [1, 1, 1, 1, 1, 0, 0.5, 0.999999];
  const f = scripted(t, () => { throw new TypeError('fetch failed'); }, { random: () => draws.shift() ?? 1 });
  try {
    await assert.rejects(f.client.connect(), { code: 'HOST_OFFLINE' });
    const waits = [f.client.retryAt - Date.now()];
    for (let index = 0; index < 7; index += 1) {
      await f.tick(waits.at(-1)!);
      waits.push(f.client.retryAt - Date.now());
    }
    assert.equal(RECONNECT_BACKOFF_MS.max, 10_000);
    assert.deepEqual(waits.slice(0, 7), [1000, 2000, 4000, 8000, 10_000, 5000, 7500],
      'the step doubles to the cap; the lowest draw waits half of it');
    assert.ok(waits[7]! > 9990 && waits[7]! < 10_000, `the highest draw stays under the cap: ${waits[7]}`);
    assert.deepEqual(f.attempts, [0, 1000, 3000, 7000, 15_000, 25_000, 30_000, 37_500]);
  } finally { f.client.close(); }
});

test('the Server back cuts a grown backoff short with one attempt, and a waiting user action goes on with it', async t => {
  let down = false;
  const failed: unknown[] = [];
  const f = scripted(t, () => { if (down) throw new Error('HOST_OFFLINE'); }, { onAttemptFailed: error => failed.push(error) });
  try {
    await f.client.connect();
    down = true;
    f.relays[0]!.close();
    for (const step of [1000, 1000, 2000, 4000, 8000]) await f.tick(step);
    assert.deepEqual(f.attempts, [0, 1000, 2000, 4000, 8000, 16_000]);
    assert.equal(f.client.retryAt - Date.now(), 10_000, 'the outage grew the backoff to its cap');

    await f.tick(1000);
    const send = f.outcome(f.client.connect({ user: true }));
    await settle();
    assert.deepEqual(f.attempts.slice(6), [17_000], 'the user action tried once at once');
    assert.equal(send.done, false, 'and waits for the attempt 10 s later');

    // This Mac's own relay is back while the execution Host is not yet.
    await f.tick(2000);
    f.client.reconnectNow();
    f.client.reconnectNow();
    await settle();
    assert.deepEqual(f.attempts.slice(6), [17_000, 19_000], 'one attempt at once, however often it is told');
    assert.equal(f.client.retryAt - Date.now(), 1000, 'its failure starts the backoff over');
    assert.equal(send.done, false, 'the user action keeps waiting');
    assert.equal(failed.length, 7);

    await f.tick(500);
    down = false;
    f.client.reconnectNow();
    await settle();
    assert.deepEqual(f.attempts.slice(6), [17_000, 19_000, 19_500]);
    assert.deepEqual(send, { done: true }, 'the user action went on with that attempt, inside its window');
    assert.equal(f.client.connected, true);
    assert.equal(f.client.backingOff, false);
    await f.tick(20_000);
    assert.equal(f.attempts.length, 9, 'nothing scheduled earlier tries again');
    f.client.reconnectNow();
    await settle();
    assert.equal(f.attempts.length, 9, 'a connected environment is left as it is');
  } finally { f.client.close(); }
});

test('the Server back still waits out its rate limit, and starts nothing unneeded or removed', async t => {
  let failure: Error | null = null;
  let wanted = true;
  const f = scripted(t, () => { if (failure) throw failure; }, { wanted: () => wanted });
  try {
    await f.client.connect();
    failure = new RemoteProtocolError('RATE_LIMITED', 'Remote Server rate limited this Mac', { retryAfterSeconds: 30 });
    f.relays[0]!.close();
    await f.tick(1000);
    assert.deepEqual(f.attempts, [0, 1000]);
    f.client.reconnectNow();
    await settle();
    assert.equal(f.attempts.length, 2, 'the Server\'s Retry-After is waited out');
    assert.equal(f.client.retryAt - Date.now(), 30_000);
    failure = new RemoteProtocolError('RATE_LIMITED', 'Remote Server rate limited this Mac');
    await f.tick(30_000);
    assert.deepEqual(f.attempts, [0, 1000, 31_000]);
    f.client.reconnectNow();
    await settle();
    assert.equal(f.attempts.length, 3, 'so is its full window when it gave no Retry-After');
    assert.equal(f.client.retryAt - Date.now(), 60_000);

    failure = new TypeError('fetch failed');
    await f.tick(60_000);
    assert.equal(f.attempts.length, 4);
    wanted = false;
    f.client.reconnectNow();
    await settle();
    assert.equal(f.attempts.length, 4, 'nothing needs this environment: it stays as it is');
    wanted = true;
    f.client.retire();
    f.client.reconnectNow();
    await settle();
    assert.equal(f.attempts.length, 4, 'a removed environment never connects again');
  } finally { f.client.close(); }
});

test('a Host back on a new relay is handshaken again at once with the token held, without reading as offline', async () => {
  const events: boolean[] = [];
  const f = await fixture(connected => events.push(connected), undefined, undefined, { wanted: () => true });
  try {
    await f.client.connect();
    f.paths.splice(0);
    f.relays[0]!.notice('host.online');
    assert.equal(f.client.connected, false, 'the old handshake is gone');
    assert.equal(f.client.reconnecting, true, 'it reads as reconnecting, not offline');
    await until(() => f.client.connected);
    assert.equal(f.relays.length, 2);
    assert.deepEqual(f.paths, ['/api/v1/ws-tickets'], 'one request: the device token is reused');
    assert.deepEqual(events, [true, false, true]);
    assert.equal(f.client.reconnecting, false);
  } finally { f.close(); }
});

test('while sessions need it, a quiet channel is probed; an answer keeps it and silence drops and reconnects it', async () => {
  const f = await fixture(undefined, undefined, undefined, { wanted: () => true, keepalive: { idle: 60, timeout: 60 } });
  try {
    await f.client.connect();
    const first = f.relays[0]!;
    const probes = () => first.sent.filter(message => message.method === 'command.status');
    await until(() => probes().length === 1);
    const probe = probes()[0]! as unknown as { command_id: string; params: { command_id: string } };
    await first.reply(probe.command_id, { command_id: probe.params.command_id, state: 'not_seen' });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(first.closed, false, 'an answered probe keeps the channel');
    assert.equal(f.client.connected, true);

    // The socket stays open but nothing comes back (a half-open link after sleep).
    await until(() => first.closed);
    await until(() => f.client.connected && f.relays.length === 2);
    assert.ok(probes().length >= 2);
  } finally { f.close(); }
});
