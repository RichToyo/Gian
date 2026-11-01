import { DeviceRelayClient, type DeviceRelayFactory, type DeviceRelayLike } from '@gian/remote-web/src/transport/relay-client.js';
import { desktopBridge, type GianDesktopRemoteTransportApi } from './desktop-bridge.js';

export interface DesktopRemoteTransport {
  fetchFn: typeof fetch;
  createRelay: DeviceRelayFactory;
  close(): void;
}

class IpcRemoteSocket {
  readyState = 0;
  private id: string | null = null;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();
  private readonly unsubscribe: () => void;

  constructor(
    origin: string,
    private readonly api: GianDesktopRemoteTransportApi,
    private readonly onClose: (socket: IpcRemoteSocket) => void,
  ) {
    this.unsubscribe = api.onSocketEvent(event => {
      if (event.id !== this.id) return;
      if (event.type === 'open') {
        return;
      } else if (event.type === 'message') {
        this.dispatch('message', new MessageEvent('message', { data: event.data ?? '' }));
      } else if (event.type === 'error') {
        this.dispatch('error', new Event('error'));
      } else {
        this.readyState = 3;
        this.dispatch('close', new CloseEvent('close', { reason: event.reason ?? 'socket_closed' }));
        this.unsubscribe();
        onClose(this);
      }
    });
    void api.openSocket(origin).then(id => {
      if (this.readyState === 3) {
        void api.closeSocket(id);
        return;
      }
      this.id = id;
      this.readyState = 1;
      this.dispatch('open', new Event('open'));
    }).catch(() => {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.dispatch('error', new Event('error'));
      this.dispatch('close', new CloseEvent('close', { reason: 'socket_open_failed' }));
      this.unsubscribe();
      onClose(this);
    });
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string): void {
    if (this.readyState !== 1 || !this.id) throw new Error('socket is not open');
    void this.api.sendSocket(this.id, data).then(sent => {
      if (!sent) this.close(1006, 'socket_send_failed');
    });
  }

  close(_code?: number, reason = 'closed'): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.id) void this.api.closeSocket(this.id);
    this.dispatch('close', new CloseEvent('close', { reason }));
    this.unsubscribe();
    this.onClose(this);
  }

  private dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

export function createDesktopRemoteTransport(origin: string): DesktopRemoteTransport {
  const api = desktopBridge()?.remoteTransport;
  if (!api) throw new Error('Desktop Remote transport is unavailable');
  const sockets = new Set<IpcRemoteSocket>();
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, origin);
    if (url.origin !== origin) throw new Error('Remote request origin changed');
    const headers = Object.fromEntries(new Headers(init?.headers ?? (typeof input === 'object' && !(input instanceof URL) ? input.headers : undefined)).entries());
    const id = crypto.randomUUID();
    const signal = init?.signal ?? (typeof input === 'object' && !(input instanceof URL) ? input.signal : null);
    const abort = () => { void api.cancel(id); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const response = await api.request({
        id,
        origin,
        method: (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE',
        path: url.pathname,
        headers,
        ...(init?.body !== undefined && init.body !== null ? { body: String(init.body) } : {}),
      });
      return new Response(response.body, { status: response.status, headers: response.headers });
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  };
  const createRelay: DeviceRelayFactory = input => new DeviceRelayClient({
    ...input,
    createSocket: () => {
      const socket = new IpcRemoteSocket(origin, api, current => sockets.delete(current));
      sockets.add(socket);
      return socket as unknown as WebSocket;
    },
  }) as DeviceRelayLike;
  return {
    fetchFn,
    createRelay,
    close() { for (const socket of [...sockets]) socket.close(1001, 'transport_closed'); },
  };
}
