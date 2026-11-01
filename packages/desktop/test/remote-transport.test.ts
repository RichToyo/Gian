import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DesktopRemoteTransport,
  type RemoteNativeSocketEvent,
} from '../src/remote-transport.js';

const request = {
  id: 'request-12345678',
  origin: 'https://remote.example',
  method: 'POST' as const,
  path: '/api/v1/server-identity',
  headers: { 'content-type': 'application/json', origin: 'https://remote.example' },
  body: '{"protocol":"gian.remote.auth/1"}',
};

test('native Remote HTTP uses the native Server origin without CORS preflight and preserves refresh cookies', async () => {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const transport = new DesktopRemoteTransport(() => {}, async (url, init) => {
    calls.push({ url: new URL(url), init });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'gian_remote_refresh=family.secret; Secure; SameSite=Strict' },
    });
  });
  try {
    const response = await transport.request(request);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init?.method, 'POST');
    assert.equal(new Headers(calls[0]!.init?.headers).get('origin'), 'https://remote.example');
    assert.ok(response.headers.some(([name, value]) => name === 'set-cookie' && value.includes('SameSite=Strict')));
    await assert.rejects(transport.request({ ...request, path: '/api/v1/admin/host-enrollments' }), /remote path denied/);
    await assert.rejects(transport.request({ ...request, headers: { origin: 'https://other.example' } }), /remote origin mismatch/);
    await assert.rejects(transport.request({ ...request, headers: { origin: 'http://local.host' } }), /invalid remote origin/);
    assert.equal(calls.length, 1);
  } finally { transport.close(); }
});

test('native Remote request ids reject malformed and duplicate values without network access', async () => {
  let calls = 0;
  const transport = new DesktopRemoteTransport(() => {}, (_url, init) => {
    calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  await assert.rejects(transport.request({ ...request, id: 'short' }), /invalid remote request/);
  assert.equal(calls, 0);
  const first = transport.request(request);
  await assert.rejects(transport.request(request), /invalid remote request/);
  assert.equal(calls, 1);
  transport.close();
  await assert.rejects(first, /aborted/);
});

test('native Remote request cancellation aborts only the matching request', async () => {
  let signal: AbortSignal | undefined;
  const transport = new DesktopRemoteTransport(() => {}, (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  const pending = transport.request(request);
  assert.equal(transport.cancelRequest('missing'), false);
  assert.equal(transport.cancelRequest(request.id), true);
  await assert.rejects(pending, /aborted/);
  assert.equal(transport.cancelRequest(request.id), false);
  transport.close();
});

test('native Remote WebSocket is fixed to /ws and cleans up messages and close', async () => {
  class FakeSocket extends EventTarget {
    readyState = 0;
    readonly sent: string[] = [];
    constructor(readonly url: URL) { super(); }
    open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
    send(data: string) { this.sent.push(data); }
    close() { this.readyState = 3; this.dispatchEvent(new CloseEvent('close', { reason: 'closed' })); }
  }
  const events: RemoteNativeSocketEvent[] = [];
  let socket: FakeSocket | undefined;
  const transport = new DesktopRemoteTransport(event => events.push(event), fetch, url => {
    socket = new FakeSocket(url);
    queueMicrotask(() => socket!.open());
    return socket as unknown as WebSocket;
  });
  const id = await transport.openSocket('https://remote.example');
  assert.equal(socket!.url.toString(), 'wss://remote.example/ws');
  assert.equal(transport.sendSocket(id, '{"type":"ws.auth"}'), true);
  assert.deepEqual(socket!.sent, ['{"type":"ws.auth"}']);
  socket!.dispatchEvent(new MessageEvent('message', { data: '{"type":"ws.bound"}' }));
  assert.ok(events.some(event => event.type === 'message' && event.data === '{"type":"ws.bound"}'));
  assert.equal(transport.closeSocket(id), true);
  assert.equal(transport.closeSocket(id), false);
  transport.close();
});
