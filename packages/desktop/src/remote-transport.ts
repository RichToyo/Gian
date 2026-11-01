import { randomUUID } from 'node:crypto';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_FRAME_BYTES = 512 * 1024;
const ALLOWED_HEADERS = new Set(['authorization', 'content-type', 'cookie', 'x-gian-account-token', 'x-gian-csrf']);
const POST_PATHS = new Set([
  '/api/v1/server-identity',
  '/api/v1/account/start',
  '/api/v1/account/poll',
  '/api/v1/account/logout',
  '/api/v1/pairings/claim',
  '/api/v1/sessions/device-challenge',
  '/api/v1/sessions/device-login',
  '/api/v1/sessions/refresh',
  '/api/v1/sessions/logout',
  '/api/v1/ws-tickets',
]);

export interface RemoteNativeRequest {
  id: string;
  origin: string;
  method: 'GET' | 'POST' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  body?: string;
}

export interface RemoteNativeResponse {
  status: number;
  headers: Array<[string, string]>;
  body: string;
}

export interface RemoteNativeSocketEvent {
  id: string;
  type: 'open' | 'message' | 'error' | 'close';
  data?: string;
  reason?: string;
}

export class DesktopRemoteTransport {
  private readonly requests = new Map<string, AbortController>();
  private readonly sockets = new Map<string, WebSocket>();
  private closed = false;

  constructor(
    private readonly emit: (event: RemoteNativeSocketEvent) => void,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly socketFactory: (url: URL) => WebSocket = url => new WebSocket(url),
  ) {}

  async request(input: RemoteNativeRequest): Promise<RemoteNativeResponse> {
    if (this.closed || this.requests.has(input.id) || !/^[A-Za-z0-9-]{16,64}$/.test(input.id)) {
      throw new Error('invalid remote request');
    }
    const origin = remoteOrigin(input.origin);
    if (!remotePathAllowed(input.method, input.path)) throw new Error('remote path denied');
    if (input.body && Buffer.byteLength(input.body) > MAX_BODY_BYTES) throw new Error('remote request too large');
    const headers = new Headers();
    for (const [name, value] of Object.entries(input.headers)) {
      const lower = name.toLowerCase();
      if (lower === 'origin') {
        if (remoteOrigin(value) !== origin) throw new Error('remote origin mismatch');
        continue;
      }
      if (!ALLOWED_HEADERS.has(lower) || /[\r\n]/.test(value)) throw new Error('remote header denied');
      headers.set(lower, value);
    }
    // This is the native Remote client, not the local Electron document.
    headers.set('origin', origin);
    const abort = new AbortController();
    this.requests.set(input.id, abort);
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await this.fetchImpl(new URL(input.path, origin), {
        method: input.method,
        headers,
        body: input.body,
        redirect: 'error',
        signal: abort.signal,
      });
      const body = await response.text();
      if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) throw new Error('remote response too large');
      const responseHeaders = [...response.headers.entries()]
        .filter(([name]) => name.toLowerCase() !== 'set-cookie') as Array<[string, string]>;
      for (const cookie of response.headers.getSetCookie()) responseHeaders.push(['set-cookie', cookie]);
      return { status: response.status, headers: responseHeaders, body };
    } finally {
      clearTimeout(timeout);
      this.requests.delete(input.id);
    }
  }

  cancelRequest(id: string): boolean {
    const request = this.requests.get(id);
    if (!request) return false;
    request.abort();
    return true;
  }

  async openSocket(origin: string): Promise<string> {
    if (this.closed) throw new Error('remote transport closed');
    const url = new URL('/ws', remoteOrigin(origin));
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const id = randomUUID();
    const socket = this.socketFactory(url);
    this.sockets.set(id, socket);
    const timeout = setTimeout(() => socket.close(), 10_000);
    socket.addEventListener('message', event => {
      const data = String(event.data);
      if (Buffer.byteLength(data) > MAX_FRAME_BYTES) {
        socket.close(1009, 'frame_too_large');
        return;
      }
      this.emit({ id, type: 'message', data });
    });
    socket.addEventListener('error', () => this.emit({ id, type: 'error', reason: 'socket_error' }));
    socket.addEventListener('close', event => {
      clearTimeout(timeout);
      this.sockets.delete(id);
      this.emit({ id, type: 'close', reason: event.reason || 'socket_closed' });
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => {
          clearTimeout(timeout);
          this.emit({ id, type: 'open' });
          resolve();
        }, { once: true });
        socket.addEventListener('error', () => reject(new Error('remote socket failed')), { once: true });
        socket.addEventListener('close', () => reject(new Error('remote socket closed')), { once: true });
      });
      return id;
    } catch (error) {
      this.sockets.delete(id);
      socket.close();
      throw error;
    }
  }

  sendSocket(id: string, data: string): boolean {
    const socket = this.sockets.get(id);
    if (!socket || socket.readyState !== WebSocket.OPEN || Buffer.byteLength(data) > MAX_FRAME_BYTES) return false;
    socket.send(data);
    return true;
  }

  closeSocket(id: string): boolean {
    const socket = this.sockets.get(id);
    if (!socket) return false;
    this.sockets.delete(id);
    socket.close();
    return true;
  }

  close(): void {
    this.closed = true;
    for (const abort of this.requests.values()) abort.abort();
    this.requests.clear();
    for (const id of [...this.sockets.keys()]) this.closeSocket(id);
  }
}

export function remoteOrigin(value: string): string {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password) throw new Error('invalid remote origin');
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return url.origin;
  throw new Error('invalid remote origin');
}

function remotePathAllowed(method: string, path: string): boolean {
  if (method === 'GET') return path === '/api/v1/me';
  if (method === 'POST') return POST_PATHS.has(path);
  return method === 'DELETE' && /^\/api\/v1\/hosts\/[0-9a-f-]{36}\/pairing$/.test(path);
}
