import { afterEach, describe, expect, it } from 'vitest';
import { AUTH_PROTOCOL } from '@gian/remote-protocol';
import { createRemoteHttpClient } from '@gian/remote-web/src/transport/http.js';
import { DesktopRemoteTransport, type RemoteNativeRequest } from '../../desktop/src/remote-transport.js';
import { createDesktopRemoteTransport } from '../src/remote-native.js';

const origin = 'https://remote.example';
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  delete window.gianDesktop;
});

describe('production Remote HTTP -> Desktop adapter -> native request', () => {
  it('closes the production origin, cookie, rejection, cancellation and cleanup chain', async () => {
    const calls: Array<{ url: URL; init?: RequestInit }> = [];
    const native = new DesktopRemoteTransport(() => {}, async (url, init) => {
      calls.push({ url: new URL(url), init });
      const path = new URL(url).pathname;
      if (path === '/api/v1/sessions/refresh' && calls.some(call => call.init?.method === 'GET')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return Response.json({ ok: true, path }, {
        headers: path === '/api/v1/pairings/claim'
          ? { 'set-cookie': 'gian_remote_refresh=family.secret; Secure; SameSite=Strict' }
          : {},
      });
    });
    window.gianDesktop = { remoteTransport: {
      request: (input: RemoteNativeRequest) => native.request(input),
      cancel: async id => native.cancelRequest(id),
      openSocket: async () => { throw new Error('unused'); },
      sendSocket: async () => false,
      closeSocket: async () => true,
      onSocketEvent: () => () => {},
    } };
    const transport = createDesktopRemoteTransport(origin);
    cleanup = () => { transport.close(); native.close(); };
    const client = createRemoteHttpClient({ baseUrl: origin, origin, fetchFn: transport.fetchFn, timeoutMs: 20 });

    await client.request('/api/v1/pairings/claim', { protocol: AUTH_PROTOCOL, code: 'PAIR-CODE' });
    await client.request('/api/v1/sessions/device-challenge', { protocol: AUTH_PROTOCOL });
    await client.request('/api/v1/sessions/device-login', { protocol: AUTH_PROTOCOL });
    await client.request('/api/v1/sessions/refresh', { protocol: AUTH_PROTOCOL });
    await client.get('/api/v1/me');

    expect(calls.map(call => new URL(call.url).pathname)).toEqual([
      '/api/v1/pairings/claim',
      '/api/v1/sessions/device-challenge',
      '/api/v1/sessions/device-login',
      '/api/v1/sessions/refresh',
      '/api/v1/me',
    ]);
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get('origin')).toBe(origin);
    }
    for (const call of calls.slice(1)) {
      expect(new Headers(call.init?.headers).get('cookie')).toBe('gian_remote_refresh=family.secret');
    }

    const count = calls.length;
    await expect(transport.fetchFn(`${origin}/api/v1/me`, {
      headers: { origin: 'https://attacker.example' },
    })).rejects.toThrow('remote origin mismatch');
    await expect(transport.fetchFn(`${origin}/api/v1/me`, {
      headers: { 'x-not-allowed': 'value' },
    })).rejects.toThrow('remote header denied');
    expect(calls.length).toBe(count);

    const slow = createRemoteHttpClient({ baseUrl: origin, origin, fetchFn: transport.fetchFn, timeoutMs: 5 });
    await slow.get('/api/v1/me');
    await expect(slow.request('/api/v1/sessions/refresh', { protocol: AUTH_PROTOCOL }))
      .rejects.toMatchObject({ code: 'HOST_OFFLINE' });
    expect(calls.at(-1)?.init?.signal?.aborted).toBe(true);
  });
});
