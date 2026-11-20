import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_PROTOCOL,
  PRESENCE_LEASE_MS,
  RemoteProtocolError,
  generateCanonicalId,
  generateP256KeyPair,
} from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { PeerCryptoSession } from '../src/remote/crypto-session.js';
import { CONNECTOR_TOKEN_RENEW_MARGIN_MS, type HttpRemoteServerAuthClient } from '../src/remote/server-client.js';
import { seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';
import { authenticatedRemoteFixture } from './fixtures/remote-account.js';

type Harness = ReturnType<typeof setupRemoteHarness>;

/** Enroll the harness runtime with a real Server and bind its relay. */
async function enrollAndStart(context: Harness) {
  const { handle, fetch: unauthenticated, clock } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  const fetch = await authenticatedRemoteFixture(unauthenticated, context.identity, listened.url);
  const identity = await context.identity.ensurePublic();
  const created = await (await fetch('/api/v1/admin/host-enrollments', {
    method: 'POST',
    headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  const claimed = await (await fetch('/api/v1/host-enrollments/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL, enrollment_token: created.enrollment_token,
      host_name: 'Office Mac', host_version: '0.5.3', host_public_key: identity.public_key }),
  })).json() as {
    host_id: string;
    connector_refresh_secret: string;
    server_identity: { public_key: { kty: 'EC'; crv: 'P-256'; x: string; y: string }; fingerprint: string };
  };
  await context.runtime.enrollment.recordClaim({ hostId: claimed.host_id, serverUrl: listened.url,
    serverIdentity: claimed.server_identity, hostName: 'Office Mac', refreshSecret: claimed.connector_refresh_secret });
  await context.runtime.start();
  assert.equal(context.runtime.relaySocket?.bound, true);
  return { handle, clock, listened, hostId: claimed.host_id };
}

/** A device session on the runtime's live relay route, as a handshake leaves it. */
async function attachDevice(context: Harness, hostId: string) {
  const device = seedDevice(context);
  const local = await generateP256KeyPair();
  const remote = await generateP256KeyPair();
  const jwk = { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' };
  const crypto = await PeerCryptoSession.fromHandshake({
    localPrivate: local.privateKey,
    remotePublic: remote.publicKey,
    transcript: { host_identity: jwk, device_identity: jwk, host_ephemeral: jwk, device_ephemeral: jwk,
      connection_id: generateCanonicalId() },
    sendDirection: 'host_to_device',
    binding: { hostGeneration: context.runtime.generation, hostId, deviceId: device.id, routeId: device.id,
      connectionId: generateCanonicalId() },
  });
  return { deviceId: device.id, connector: context.runtime.connectDevice(device, crypto) };
}

function connectorAuth(context: Harness): HttpRemoteServerAuthClient {
  return (context.runtime as unknown as { authClient: HttpRemoteServerAuthClient }).authClient;
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    assert.ok(Date.now() < deadline, 'condition timed out');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('the Host renews its connector token before it expires, keeping the relay and every device session', async t => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const relay = context.runtime.relaySocket!;
    const { deviceId, connector } = await attachDevice(context, enrolled.hostId);
    const auth = connectorAuth(context);
    const logins = t.mock.method(auth, 'login');
    const heartbeats = t.mock.method(auth, 'heartbeat');
    const before = auth.currentAccessToken();

    await context.runtime.maintainPresence();
    assert.equal(logins.mock.callCount(), 0, 'a fresh token is reused');

    // Close to expiry by this Mac's clock: the heartbeat logs in first.
    context.clock.nowMs += ACCESS_TOKEN_TTL_MS - CONNECTOR_TOKEN_RENEW_MARGIN_MS + 1000;
    await context.runtime.maintainPresence();
    assert.equal(logins.mock.callCount(), 1);
    assert.equal(heartbeats.mock.callCount(), 2, 'the heartbeat itself is sent once, with the new token');
    assert.notEqual(auth.currentAccessToken(), before);
    assert.equal(context.runtime.relaySocket, relay, 'the relay socket is not replaced');
    assert.equal(relay.bound, true);
    assert.equal(context.runtime.connectorFor(deviceId), connector);
    assert.equal(connector.connected, true, 'device sessions are not closed');
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), true);
    assert.equal(context.runtime.settingsState().connection, 'online');
  } finally {
    context.runtime.close(); enrolled.listened.close(); teardownRemoteHarness(context);
  }
});

test('a Server that already dropped the token gets one new login and one retry, still on the same relay', async t => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const relay = context.runtime.relaySocket!;
    const { deviceId, connector } = await attachDevice(context, enrolled.hostId);
    const auth = connectorAuth(context);
    const logins = t.mock.method(auth, 'login');
    const heartbeats = t.mock.method(auth, 'heartbeat');
    const tickets = t.mock.method(auth, 'hostWsTicket');

    // The Server's clock passed the token's lifetime; this Mac's did not.
    enrolled.clock.tick(ACCESS_TOKEN_TTL_MS + 1);
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), false);
    await context.runtime.maintainPresence();
    assert.equal(heartbeats.mock.callCount(), 2, 'the refused heartbeat is retried once');
    assert.equal(logins.mock.callCount(), 1, 'after exactly one new login');
    assert.equal(tickets.mock.callCount(), 0, 'no new relay socket is opened');
    assert.equal(context.runtime.relaySocket, relay);
    assert.equal(relay.bound, true);
    assert.equal(connector.connected, true);
    assert.equal(context.runtime.connectorFor(deviceId), connector);
    assert.equal(enrolled.handle.services.presence.isOnline(enrolled.hostId), true);

    // Other Host→Server calls renew the same way.
    enrolled.clock.tick(ACCESS_TOKEN_TTL_MS + 1);
    await context.runtime.setHostName('Renamed Mac');
    assert.equal(logins.mock.callCount(), 2);
    assert.equal(context.runtime.relaySocket, relay);
    assert.equal(connector.connected, true);
  } finally {
    context.runtime.close(); enrolled.listened.close(); teardownRemoteHarness(context);
  }
});

test('a transient heartbeat failure is retried on the same relay; only a closed relay is rebuilt', async t => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const relay = context.runtime.relaySocket!;
    const { connector } = await attachDevice(context, enrolled.hostId);
    const auth = connectorAuth(context);
    const heartbeat = auth.heartbeat.bind(auth);
    let blips = 1;
    const heartbeats = t.mock.method(auth, 'heartbeat', async (hostId: string) => {
      if (blips-- > 0) throw new RemoteProtocolError('HOST_OFFLINE', 'remote server connection failed');
      return heartbeat(hostId);
    });

    await context.runtime.maintainPresence();
    assert.equal(context.runtime.relaySocket, relay, 'one failed heartbeat does not replace the relay');
    assert.equal(connector.connected, true);
    assert.equal(context.runtime.settingsState().connection, 'reconnecting');
    await waitUntil(() => heartbeats.mock.callCount() === 2 && context.runtime.settingsState().connection === 'online');
    assert.equal(context.runtime.relaySocket, relay, 'the retry succeeds on the same relay');
    assert.equal(connector.connected, true);

    // The socket itself closed: its device sessions end and a new relay binds.
    relay.close('socket_closed');
    assert.equal(connector.connected, false);
    await waitUntil(() => context.runtime.relaySocket !== null && context.runtime.relaySocket !== relay
      && context.runtime.relaySocket.bound);
  } finally {
    context.runtime.close(); enrolled.listened.close(); teardownRemoteHarness(context);
  }
});

test('silence longer than the presence lease rebuilds the relay instead of trusting it', async () => {
  const context = setupRemoteHarness();
  const enrolled = await enrollAndStart(context);
  try {
    const relay = context.runtime.relaySocket!;
    // As after this Mac slept: the Server stopped hearing from it long ago.
    (context.runtime as unknown as { lastPresenceAt: number }).lastPresenceAt = Date.now() - PRESENCE_LEASE_MS - 1;
    await context.runtime.maintainPresence();
    assert.notEqual(context.runtime.relaySocket, relay);
    assert.equal(context.runtime.relaySocket?.bound, true);
    assert.equal(context.runtime.settingsState().connection, 'online');
  } finally {
    context.runtime.close(); enrolled.listened.close(); teardownRemoteHarness(context);
  }
});

test('the relay reconnect backoff doubles from 0.5 s and holds at 10 s, keeping its jitter', t => {
  const context = setupRemoteHarness();
  try {
    const runtime = context.runtime as unknown as {
      scheduleReconnect(): void;
      reconnectTimer: unknown;
      reconnectAttempts: number;
    };
    const delays: number[] = [];
    let random = 0;
    t.mock.method(Math, 'random', () => random);
    t.mock.method(globalThis, 'setTimeout', ((_callback: () => void, delay?: number) => {
      delays.push(delay ?? 0);
      return { unref() { return this; } };
    }) as unknown as typeof setTimeout);
    const backoff = (draw: number) => {
      random = draw;
      runtime.reconnectAttempts = 0;
      const start = delays.length;
      for (let attempt = 0; attempt < 8; attempt += 1) {
        runtime.reconnectTimer = null; // as when the scheduled attempt ran and failed
        runtime.scheduleReconnect();
      }
      return delays.slice(start);
    };
    assert.deepEqual(backoff(0), [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]);
    assert.deepEqual(backoff(0.9999), [699, 1199, 2199, 4199, 8199, 10_199, 10_199, 10_199]);
  } finally {
    context.runtime.close(); teardownRemoteHarness(context);
  }
});
