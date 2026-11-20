import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTH_PROTOCOL, RemoteProtocolError } from '@gian/remote-protocol';
import { listenRemoteApp, makeRemoteTestApp } from '../../remote-server/test/fixture.js';
import { makeTestApp } from './fixtures/test-app.js';
import { HttpRemoteServerAuthClient, RemoteAccountRequiredError } from '../src/remote/server-client.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';
import { RemoteIdentityBrokerClient } from '../src/remote/identity-broker.js';

async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 5_000): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition: ${String(last)}`);
}

/** GitHub Device Flow remains for account-scoped APIs. Enrollment claim and
 *  relay reconnect do not require a live GitHub session. The test Server
 *  authorizes the first account poll immediately when a test does sign in. */
async function loginGitHub(hostApp: Awaited<ReturnType<typeof makeTestApp>>, serverUrl: string): Promise<void> {
  const started = await hostApp.fetch('/api/remote/account/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server_url: serverUrl }),
  });
  assert.equal(started.status, 200, JSON.stringify(await started.json()));
  const polled = await hostApp.fetch('/api/remote/account/poll', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(polled.status, 200, JSON.stringify(await polled.json()));
}

test('native client enrollment does not require GitHub authorization', async () => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    const issued = await (await server.fetch('/api/v1/admin/host-enrollments', {
      method: 'POST', headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const enrolled = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_url: listened.url, enrollment_token: issued.enrollment_token, host_name: 'Studio Mac' }),
    });
    assert.equal(enrolled.status, 200, JSON.stringify(await enrolled.json()));
    assert.equal(hostApp.app.remote.settingsState().enrolled, true);
    assert.equal(hostApp.app.remote.settingsState().host_name, 'Studio Mac');
    const admission = server.handle.services.repos.getController(hostApp.app.remote.settingsState().host_id!);
    assert.equal(admission?.revoked_at, null);
    assert.equal(admission?.browser_installation_id, hostApp.app.remote.settingsState().host_id);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('an authorized Host gets a distinct sanitized rejection for an invalid enrollment token', async () => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    await loginGitHub(hostApp, listened.url);
    const result = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_url: listened.url, enrollment_token: 'invalid-private-token' }),
    });
    assert.equal(result.status, 400);
    assert.deepEqual(await result.json(), { error: 'enrollment_rejected' });
    assert.equal(hostApp.app.remote.settingsState().enrolled, false);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('enrollment transport failures are distinct from missing authorization and redact details', async t => {
  const hostApp = await makeTestApp();
  t.mock.method(HttpRemoteServerAuthClient.prototype, 'claimEnrollment', async () => {
    throw new RemoteProtocolError('HOST_OFFLINE', 'private-token and transport details');
  });
  try {
    const result = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ server_url: 'https://remote.test', enrollment_token: 'private-token' }),
    });
    assert.equal(result.status, 503);
    assert.deepEqual(await result.json(), { error: 'remote_unavailable' });
  } finally { hostApp.app.remote.close(); await hostApp.cleanup(); }
});

test('an expired GitHub session does not block an enrollment claim', async t => {
  const identity = new MemoryRemoteIdentity();
  t.mock.method(identity, 'getAccountSession', async () => ({
    role: 'host' as const, serverOrigin: 'https://remote.test', serverFingerprint: 'a'.repeat(64),
    installationId: 'expired', accountId: '1', accountLogin: 'test', token: 'private-token', expiresAt: 0,
  }));
  let requests = 0;
  const client = new HttpRemoteServerAuthClient('https://remote.test', identity, async () => {
    requests += 1;
    return Response.json({ error: { code: 'AUTH_REQUIRED' } }, { status: 401 });
  });
  await assert.rejects(client.claimEnrollment({ enrollmentToken: 'private-enrollment-token', hostName: 'Mac',
    hostVersion: 'test', hostPublicKey: (await identity.ensurePublic()).public_key }), (error: unknown) => {
    assert.ok(error instanceof RemoteProtocolError);
    assert.equal(error instanceof RemoteAccountRequiredError, false);
    return true;
  });
  assert.equal(requests, 1);
});

for (const failure of ['transport', 'rate-limit', 'upstream'] as const) {
  test(`Remote ${failure} failure is unavailable, not an authorization rejection`, async () => {
    const client = new HttpRemoteServerAuthClient('https://remote.test', new MemoryRemoteIdentity(), async () => {
      if (failure === 'transport') throw new Error('private transport detail');
      return new Response('private upstream detail', failure === 'rate-limit'
        ? { status: 429, headers: { 'retry-after': '9' } } : { status: 503 });
    });
    await assert.rejects(client.challenge('test-host'), (error: unknown) => {
      assert.ok(error instanceof RemoteProtocolError);
      // A rate limit keeps its code and the Server's Retry-After for the reconnect backoff.
      assert.equal(error.code, failure === 'rate-limit' ? 'RATE_LIMITED' : 'HOST_OFFLINE');
      assert.deepEqual(error.details, failure === 'rate-limit' ? { retryAfterSeconds: 9 } : undefined);
      assert.doesNotMatch(error.message, /private/);
      return true;
    });
  });
}

test('Host HTTP enrollment claims Server and projector host id follows the claim', async () => {
  const hostApp = await makeTestApp();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
    await loginGitHub(hostApp, listened.url);
    const before = hostApp.app.remote.projector.snapshot({
      capabilities: {} as never,
      attention: [],
    });
    const created = await (await fetch('/api/v1/admin/host-enrollments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const enrolled = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server_url: listened.url,
        enrollment_token: created.enrollment_token,
      }),
    });
    const body = await enrolled.json() as { host_id?: string; enrolled?: boolean; error?: string };
    assert.equal(enrolled.status, 200, JSON.stringify(body));
    assert.equal(body.enrolled, true);
    await waitUntil(() => hostApp.app.remote.relaySocket?.bound ?? null);
    const after = hostApp.app.remote.projector.snapshot({
      capabilities: {} as never,
      attention: [],
    });
    assert.equal(after.host.id, body.host_id);
    assert.notEqual(after.host.id, before.host.id);
    assert.equal(hostApp.app.remote.settingsState().host_id, body.host_id);
  } finally {
    hostApp.app.remote.close();
    listened.close();
    await hostApp.cleanup();
  }
});

test('enroll accepts an optional machine name and stores it as the remote name', async () => {
  const hostApp = await makeTestApp();
  const { handle, fetch } = await makeRemoteTestApp();
  const listened = await listenRemoteApp(handle);
  try {
    await loginGitHub(hostApp, listened.url);
    const created = await (await fetch('/api/v1/admin/host-enrollments', {
      method: 'POST',
      headers: {
        authorization: 'Bearer admin-test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
    })).json() as { enrollment_token: string };
    const enrolled = await hostApp.fetch('/api/remote/enroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        server_url: listened.url,
        enrollment_token: created.enrollment_token,
        host_name: '  Studio Mac  ',
      }),
    });
    const body = await enrolled.json() as { host_id?: string; enrolled?: boolean; error?: string };
    assert.equal(enrolled.status, 200, JSON.stringify(body));
    assert.equal(hostApp.app.remote.settingsState().host_name, 'Studio Mac');
  } finally {
    hostApp.app.remote.close();
    listened.close();
    await hostApp.cleanup();
  }
});

type RemoteTestServer = Awaited<ReturnType<typeof makeRemoteTestApp>>;

async function issueEnrollmentToken(server: RemoteTestServer): Promise<string> {
  const issued = await (await server.fetch('/api/v1/admin/host-enrollments', {
    method: 'POST', headers: { authorization: 'Bearer admin-test-token', 'content-type': 'application/json' },
    body: JSON.stringify({ protocol: AUTH_PROTOCOL }),
  })).json() as { enrollment_token: string };
  return issued.enrollment_token;
}

async function postEnroll(hostApp: Awaited<ReturnType<typeof makeTestApp>>, serverUrl: string, enrollmentToken: string) {
  const response = await hostApp.fetch('/api/remote/enroll', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server_url: serverUrl, enrollment_token: enrollmentToken }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

/** The `[remote] <route> failed as <category>` lines the Host logged. */
function remoteFailureLines(logged: { mock: { calls: Array<{ arguments: unknown[] }> } }): string[] {
  return logged.mock.calls.map(call => call.arguments.map(String).join(' '))
    .filter(line => line.startsWith('[remote] /api/remote/'));
}

test('a retried enrollment with the same Server answers with the current state; another Server is already_enrolled', async t => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    const first = await postEnroll(hostApp, listened.url, await issueEnrollmentToken(server));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const hostId = first.body.host_id;
    const claims = t.mock.method(HttpRemoteServerAuthClient.prototype, 'claimEnrollment');

    // The renderer gave up on a first attempt that went through and retries
    // with the same Server, as written differently: nothing is claimed again.
    const port = new URL(listened.url).port;
    for (const sameServer of [listened.url, `HTTP://127.0.0.1:${port}/`]) {
      const retried = await postEnroll(hostApp, sameServer, 'unused-retry-token');
      assert.equal(retried.status, 200, JSON.stringify(retried.body));
      assert.equal(retried.body.ok, true);
      assert.equal(retried.body.enrolled, true);
      assert.equal(retried.body.host_id, hostId);
      assert.equal(retried.body.server_url, listened.url);
    }
    const other = await postEnroll(hostApp, 'https://other-remote.example', 'other-token');
    assert.equal(other.status, 400);
    assert.deepEqual(other.body, { error: 'already_enrolled' });
    assert.equal(claims.mock.callCount(), 0);
    assert.equal(hostApp.app.remote.enrollment.current()?.hostId, hostId);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('a retry while the first enrollment is still claiming joins it; another Server is already_enrolled', async t => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    const claim = HttpRemoteServerAuthClient.prototype.claimEnrollment;
    let release!: () => void;
    let reached!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const claiming = new Promise<void>(resolve => { reached = resolve; });
    const claims = t.mock.method(HttpRemoteServerAuthClient.prototype, 'claimEnrollment', async function (
      this: HttpRemoteServerAuthClient, input: Parameters<typeof claim>[0],
    ) {
      reached();
      await held;
      return claim.call(this, input);
    });
    const first = postEnroll(hostApp, listened.url, await issueEnrollmentToken(server));
    await claiming;
    const retry = postEnroll(hostApp, `${listened.url}/`, 'unused-retry-token');
    const other = await postEnroll(hostApp, 'https://other-remote.example', 'other-token');
    assert.deepEqual(other.body, { error: 'already_enrolled' });
    release();
    const [answered, retried] = await Promise.all([first, retry]);
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.host_id, answered.body.host_id);
    assert.equal(claims.mock.callCount(), 1);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('enrollment answers once it is stored, without waiting for the relay to connect', async t => {
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  try {
    const ticket = HttpRemoteServerAuthClient.prototype.hostWsTicket;
    let release!: () => void;
    const stalled = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'hostWsTicket', async function (this: HttpRemoteServerAuthClient) {
      await stalled;
      return ticket.call(this);
    });
    const answer = await Promise.race([
      postEnroll(hostApp, listened.url, await issueEnrollmentToken(server)),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('enroll waited for the relay')), 4_000)),
    ]);
    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.enrolled, true);
    assert.equal(answer.body.connection, 'reconnecting');
    assert.equal(hostApp.app.remote.relaySocket, null);
    release();
    await waitUntil(() => hostApp.app.remote.settingsState().connection === 'online');
    assert.equal(hostApp.app.remote.relaySocket?.bound, true);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('network failures during enrollment are remote_unavailable and logged with their code', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const closedPort = (closed.address() as { port: number }).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  try {
    // Nothing listens on the Server's port.
    const refused = await postEnroll(hostApp, `http://127.0.0.1:${closedPort}`, 'private-enrollment-token');
    assert.equal(refused.status, 503);
    assert.deepEqual(refused.body, { error: 'remote_unavailable' });

    // A raw fetch failure that escapes past the Server client.
    const failures = [
      new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:${closedPort}`), { code: 'ECONNREFUSED' }) }),
      new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { name: 'SocketError', code: 'UND_ERR_SOCKET' }) }),
    ];
    let next = 0;
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'claimEnrollment', async () => { throw failures[next++]; });
    for (const code of ['ECONNREFUSED', 'UND_ERR_SOCKET']) {
      const result = await hostApp.fetch('/api/remote/enroll', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ server_url: listened.url, enrollment_token: 'private-enrollment-token' }),
      });
      assert.equal(result.status, 503, code);
      assert.equal(result.headers.get('retry-after'), '5');
      assert.deepEqual(await result.json(), { error: 'remote_unavailable' });
    }
    const lines = remoteFailureLines(logged);
    assert.equal(lines.length, 3);
    assert.match(lines[0]!, /^\[remote\] \/api\/remote\/enroll failed as remote_unavailable: RemoteProtocolError HOST_OFFLINE: /);
    assert.match(lines[1]!, /failed as remote_unavailable: TypeError: fetch failed \(cause: Error ECONNREFUSED: connect ECONNREFUSED 127\.0\.0\.1:\d+\)$/);
    assert.match(lines[2]!, /failed as remote_unavailable: TypeError: terminated \(cause: SocketError UND_ERR_SOCKET: other side closed\)$/);
    assert.ok(lines.every(line => !line.includes('private-enrollment-token')));
    assert.equal(hostApp.app.remote.settingsState().enrolled, false);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});

test('an identity broker failure during enrollment is identity_unavailable, not a network failure', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const hostApp = await makeTestApp();
  const dir = await mkdtemp(join(tmpdir(), 'gian-enroll-broker-'));
  try {
    // As when Desktop's Keychain broker is not listening: ENOENT on its socket.
    const broker = new RemoteIdentityBrokerClient(join(dir, 'missing.sock'));
    t.mock.method(hostApp.remoteIdentity, 'ensurePublic', () => broker.ensurePublic());
    const result = await postEnroll(hostApp, 'https://remote.test', 'private-enrollment-token');
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: 'identity_unavailable' });
    const lines = remoteFailureLines(logged);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /^\[remote\] \/api\/remote\/enroll failed as identity_unavailable: RemoteIdentityUnavailableError: .*\(cause: Error ENOENT: /);
    assert.equal(hostApp.app.remote.settingsState().enrolled, false);
  } finally { hostApp.app.remote.close(); await hostApp.cleanup(); await rm(dir, { recursive: true, force: true }); }
});

test('an unexpected enrollment failure is logged without tokens, secrets or credential-bearing URLs', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const hostApp = await makeTestApp();
  const server = await makeRemoteTestApp();
  const listened = await listenRemoteApp(server.handle);
  const enrollmentToken = 'Zx9_private-enrollment-token-0123456789abcdefghijklmn';
  try {
    t.mock.method(HttpRemoteServerAuthClient.prototype, 'claimEnrollment', async () => {
      throw new Error(`claim failed at https://owner:hunter2@remote.test/api/v1/claim?enrollment_token=${enrollmentToken}`
        + ` with Authorization: Bearer connector-secret-value and refresh_token=${enrollmentToken}\n${'x'.repeat(400)}`);
    });
    const result = await postEnroll(hostApp, listened.url, enrollmentToken);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: 'remote_action_failed' });
    const lines = remoteFailureLines(logged);
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.match(line!, /^\[remote\] \/api\/remote\/enroll failed as remote_action_failed: Error: claim failed at https:\/\/remote\.test with Authorization: Bearer \[REDACTED\]/);
    for (const secret of [enrollmentToken, 'hunter2', 'owner:', 'connector-secret-value', '/api/v1/claim', '\n']) {
      assert.ok(!line!.includes(secret), `log line leaks ${JSON.stringify(secret)}`);
    }
    assert.ok(line!.length < 400, 'the message is capped');
    // A Host-raised code goes back as is and is not logged.
    assert.deepEqual((await postEnroll(hostApp, 'not a url', 'token')).body, { error: 'invalid_url' });
    assert.equal(remoteFailureLines(logged).length, 1);
  } finally { hostApp.app.remote.close(); listened.close(); await hostApp.cleanup(); }
});
