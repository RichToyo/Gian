import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { generateCanonicalId, RemoteProtocolError, type RemoteErrorCode } from '@gian/remote-protocol';
import { registerRemoteControllerRoutes } from '../src/remote/controller-routes.js';
import { RemoteServerIdentityChangedError, type RemoteControllerHub } from '../src/remote/controller-hub.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';

test('remote preview and tree errors have stable HTTP semantics and never echo peer secrets or paths', async () => {
  const session = generateCanonicalId();
  const cases: Array<[RemoteErrorCode, number]> = [
    ['REMOTE_CAPABILITY_DENIED', 403], ['AUTH_REQUIRED', 401], ['DEVICE_REVOKED', 403],
    ['RESOURCE_NOT_FOUND', 404], ['ATTACHMENT_NOT_FOUND', 404], ['FILE_REFERENCE_EXPIRED', 410],
    ['FILE_TOO_LARGE', 413], ['HOST_OFFLINE', 503], ['INVALID_FRAME', 400], ['RATE_LIMITED', 429],
  ];
  for (const [code, status] of cases) {
    const reject = async () => { throw new RemoteProtocolError(code, '/private/secret token=do-not-expose'); };
    const hub = { readFile: reject, readAttachment: reject, directory: reject, files: reject, command: reject } as unknown as RemoteControllerHub;
    const app = new Hono();
    registerRemoteControllerRoutes(app, hub, {} as WsBroadcaster);
    for (const path of [
      `/api/remote/sessions/${session}/raw?reference=outside`,
      `/api/remote/sessions/${session}/files/attachment`,
      `/api/remote/sessions/${session}/raw?reference=attachment:shot.png`,
      `/api/working_trees/remote:${session}/file?path=outside`,
      `/api/working_trees/remote:${session}/tree?path=..`,
      `/api/working_trees/remote:${session}/files`,
      `/api/working_trees/remote:${session}/changed`,
    ]) {
      const response = await app.request(path);
      assert.equal(response.status, status, `${code}: ${path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json() as { code: string; error: string };
      assert.equal(body.code, code);
      assert.doesNotMatch(JSON.stringify(body), /private|do-not-expose/);
    }
  }
});

test('the remote file adapter does not intercept local trees and hides unexpected exceptions', async () => {
  const app = new Hono();
  registerRemoteControllerRoutes(app, { readFile: async () => { throw new Error('sensitive stack'); } } as unknown as RemoteControllerHub,
    {} as WsBroadcaster);
  app.get('/api/working_trees/:id/file', c => c.json({ content: 'local' }));
  assert.deepEqual(await (await app.request('/api/working_trees/ws:local/file')).json(), { content: 'local' });
  const response = await app.request(`/api/remote/sessions/${generateCanonicalId()}/raw?reference=x`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { code: 'INTERNAL_ERROR', error: 'Remote file request failed' });
});

test('attachments are served for the browser to keep and revalidate, worktree files are never cached', async () => {
  const session = generateCanonicalId();
  const bytes = new TextEncoder().encode('png bytes');
  const sha256 = 'c'.repeat(64);
  const calls: string[] = [];
  const hub = {
    readAttachment: async (id: string, reference: string) => { calls.push(`attachment ${id} ${reference}`);
      return { bytes, name: 'shot.png', mime: 'image/png', sha256 }; },
    readFile: async (id: string, reference: string) => { calls.push(`file ${id} ${reference}`);
      return { bytes, name: 'notes.svg', mime: 'image/svg+xml', file: {} }; },
  } as unknown as RemoteControllerHub;
  const app = new Hono();
  registerRemoteControllerRoutes(app, hub, {} as WsBroadcaster);

  for (const path of [`/api/remote/sessions/${session}/files/${encodeURIComponent('attachment:shot.png')}`,
    `/api/remote/sessions/${session}/raw?reference=${encodeURIComponent('attachment:shot.png')}`]) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('cache-control'), 'private, max-age=604800, immutable');
    assert.equal(response.headers.get('etag'), `"${sha256}"`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    for (const tag of [`"${sha256}"`, `W/"${sha256}"`, `"other", "${sha256}"`]) {
      const revalidated = await app.request(path, { headers: { 'if-none-match': tag } });
      assert.equal(revalidated.status, 304, tag);
      assert.equal(revalidated.headers.get('etag'), `"${sha256}"`);
      assert.equal(revalidated.headers.get('cache-control'), 'private, max-age=604800, immutable');
    }
    assert.equal((await app.request(path, { headers: { 'if-none-match': '"other"' } })).status, 200);
  }
  // A file id in the thumbnail URL (a Host that sent no reference) is an attachment too.
  const handle = generateCanonicalId();
  assert.equal((await app.request(`/api/remote/sessions/${session}/files/${handle}`)).headers.get('etag'), `"${sha256}"`);

  const file = await app.request(`/api/remote/sessions/${session}/raw?reference=docs/notes.svg`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('cache-control'), 'no-store');
  assert.equal(file.headers.get('etag'), null);
  assert.match(file.headers.get('content-security-policy') ?? '', /script-src 'none'/);
  assert.equal(calls[0], `attachment ${session} attachment:shot.png`);
  assert.equal(calls.at(-2), `attachment ${session} ${handle}`);
  assert.equal(calls.at(-1), `file ${session} docs/notes.svg`);
  assert.ok(calls.slice(0, -1).every(call => call.startsWith('attachment ')));
});

test('a changed Server identity is returned for an explicit decision and only an echoed fingerprint is forwarded', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const hub = { pair: async (input: Record<string, unknown>) => {
    calls.push(input);
    if (input.confirm_server_identity !== 'b'.repeat(64)) {
      throw new RemoteServerIdentityChangedError('https://remote.example', ['a'.repeat(64)], 'b'.repeat(64));
    }
    return { id: 'environment' };
  } } as unknown as RemoteControllerHub;
  const app = new Hono();
  registerRemoteControllerRoutes(app, hub, {} as WsBroadcaster);
  const post = (body: unknown) => app.request('/api/remote/environments', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const input = { server_url: 'https://remote.example', code: 'ABCD-EFGH', name: 'Studio Mac' };
  const changed = await post(input);
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: 'server_identity_changed', server_url: 'https://remote.example',
    previous_fingerprints: ['a'.repeat(64)], fingerprint: 'b'.repeat(64) });
  assert.equal((await post({ ...input, confirm_server_identity: 42 })).status, 400);
  const confirmed = await post({ ...input, confirm_server_identity: 'b'.repeat(64) });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(calls, [{ origin: input.server_url, code: input.code, name: input.name },
    { origin: input.server_url, code: input.code, name: input.name, confirm_server_identity: 'b'.repeat(64) }]);
});

test('a refused pairing answers 409 with the Server\'s code, an unreachable Server 502 and a rate limit 429, never a bare 500', async () => {
  let failure: unknown;
  const hub = { pair: async () => { throw failure; } } as unknown as RemoteControllerHub;
  const app = new Hono();
  registerRemoteControllerRoutes(app, hub, {} as WsBroadcaster);
  app.onError((_error, c) => c.json({ error: 'internal' }, 500));
  const post = () => app.request('/api/remote/environments', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ server_url: 'https://remote.example', code: 'ABCD-EFGH', name: 'Studio Mac' }) });

  // The live case: this Mac's key is already paired with that Host, so the Server refuses the claim.
  for (const code of ['AUTH_REQUIRED', 'CONTROLLER_NOT_ADMITTED', 'DEVICE_NOT_PAIRED', 'ENROLLMENT_CONSUMED', 'ENROLLMENT_EXPIRED'] as const) {
    failure = new RemoteProtocolError(code, 'pairing rejected');
    const response = await post();
    assert.equal(response.status, 409, code);
    assert.deepEqual(await response.json(), { error: 'pairing_rejected', code });
  }
  for (const error of [new RemoteProtocolError('HOST_OFFLINE', 'server identity request failed'), new TypeError('fetch failed'),
    new DOMException('The operation was aborted due to timeout', 'TimeoutError')]) {
    failure = error;
    const response = await post();
    assert.equal(response.status, 502, String(error));
    assert.deepEqual(await response.json(), { error: 'pairing_unreachable' });
  }
  // Live: retries elsewhere had used up the Server's server-identity bucket
  // for this address. A rate limit is no refusal: it says when to try again.
  for (const [details, seconds] of [[{ retryAfterSeconds: 27 }, 27], [{ retryAfterSeconds: 4.2 }, 5], [undefined, 60]] as const) {
    failure = new RemoteProtocolError('RATE_LIMITED', 'server identity temporarily rate limited', details);
    const response = await post();
    assert.equal(response.status, 429, String(seconds));
    assert.equal(response.headers.get('retry-after'), String(seconds));
    assert.deepEqual(await response.json(), { error: 'pairing_rate_limited', retry_after_seconds: seconds });
  }
  // Anything else stays an internal failure.
  failure = new Error('unexpected');
  assert.equal((await post()).status, 500);
});

test('remove and restore answer with the full environment list, and an unknown environment is a 404', async () => {
  const known = generateCanonicalId();
  const calls: string[] = [];
  const hub = {
    removeEnvironment: (id: string) => { calls.push('remove ' + id); return id === known; },
    restoreEnvironment: (id: string) => { calls.push('restore ' + id); return id === known; },
    listEnvironments: () => [{ id: known, status: 'removed' }],
  } as unknown as RemoteControllerHub;
  const app = new Hono();
  registerRemoteControllerRoutes(app, hub, {} as WsBroadcaster);
  const removed = await app.request(`/api/remote/environments/${known}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, environments: [{ id: known, status: 'removed' }] });
  const restored = await app.request(`/api/remote/environments/${known}/restore`, { method: 'POST' });
  assert.equal(restored.status, 200);
  const unknown = generateCanonicalId();
  assert.equal((await app.request(`/api/remote/environments/${unknown}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual(await (await app.request(`/api/remote/environments/${unknown}/restore`, { method: 'POST' })).json(),
    { error: 'environment_not_found' });
  assert.deepEqual(calls, [`remove ${known}`, `restore ${known}`, `remove ${unknown}`, `restore ${unknown}`]);
});
