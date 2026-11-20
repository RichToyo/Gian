import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDesktopRemoteTransport } from '../src/remote-native.js';
import type { GianDesktopRemoteTransportApi } from '../src/desktop-bridge.js';

afterEach(() => { delete window.gianDesktop; });

describe('Desktop Remote native transport adapter', () => {
  it('uses the bridge rather than Renderer fetch and preserves native response cookies', async () => {
    const request = vi.fn<GianDesktopRemoteTransportApi['request']>(async () => ({
      status: 200,
      headers: [['content-type', 'application/json'], ['set-cookie', 'refresh=family.secret; Secure; SameSite=Strict']],
      body: '{"ok":true}',
    }));
    window.gianDesktop = { remoteTransport: {
      request,
      cancel: async () => true,
      openSocket: async () => 'socket-id',
      sendSocket: async () => true,
      closeSocket: async () => true,
      onSocketEvent: () => () => {},
    } };
    const transport = createDesktopRemoteTransport('https://remote.example');
    const response = await transport.fetchFn('https://remote.example/api/v1/server-identity', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.getSetCookie()[0]).toContain('SameSite=Strict');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'https://remote.example', method: 'POST', path: '/api/v1/server-identity',
    }));
    await expect(transport.fetchFn('https://other.example/api/v1/server-identity')).rejects.toThrow('origin changed');
    transport.close();
  });

  it('opens the production relay through the native socket bridge and closes it', async () => {
    const openSocket = vi.fn(async () => 'socket-id');
    const closeSocket = vi.fn(async () => true);
    let listener: ((event: { id: string; type: 'close'; reason: string }) => void) | undefined;
    window.gianDesktop = { remoteTransport: {
      request: async () => { throw new Error('unexpected HTTP'); },
      cancel: async () => true,
      openSocket,
      sendSocket: async () => true,
      closeSocket,
      onSocketEvent: next => { listener = next as typeof listener; return () => { listener = undefined; }; },
    } };
    const transport = createDesktopRemoteTransport('https://remote.example');
    const relay = transport.createRelay({
      wsUrl: 'wss://remote.example/ws', ticket: 'ticket',
      hostId: '11111111-1111-4111-8111-111111111111',
      deviceId: '22222222-2222-4222-8222-222222222222', cryptoConnectionId: '33333333-3333-4333-8333-333333333333',
      hostPublicKey: { kty: 'EC', crv: 'P-256', x: 'A'.repeat(43), y: 'B'.repeat(43) },
      identity: { publicJwk: { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }, sign: async () => 'signature' },
      handlers: { onControl() {} },
    });
    const connecting = relay.connect();
    await vi.waitFor(() => { expect(openSocket).toHaveBeenCalledWith('https://remote.example'); });
    transport.close();
    expect(closeSocket).toHaveBeenCalledWith('socket-id');
    listener?.({ id: 'socket-id', type: 'close', reason: 'fixture_close' });
    await expect(connecting).rejects.toThrow();
  });
});
