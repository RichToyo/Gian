import { EventEmitter } from 'node:events';
import {
  CIPHERTEXT_PACE_BYTES_PER_SECOND,
  CIPHERTEXT_PACE_WINDOW_MS,
  RELAY_PROTOCOL,
  createRelayFrameTokenBucket,
  generateCanonicalId,
  parseRelayHandshake,
  utf8ByteLength,
  type CryptoOffer,
  type RelayFrame,
  type RelayHandshake,
  type RelayNotice,
} from '@gian/remote-protocol';
import type { RemotePeerTransport } from './connector.js';

/** Poll interval while the byte budget is spent. */
const PACE_RETRY_MS = 15;

/** Ciphertext bytes sent within the last window. The Server counts bytes per
 *  WebSocket, so all device routes of the Host socket share one budget. */
export function createCiphertextBudget(
  limit = CIPHERTEXT_PACE_BYTES_PER_SECOND,
  windowMs = CIPHERTEXT_PACE_WINDOW_MS,
) {
  const sent: { at: number; bytes: number }[] = [];
  let used = 0;
  return {
    /** Whether `bytes` fit now. A lone frame always fits an empty window. */
    fits(bytes: number): boolean {
      const cutoff = Date.now() - windowMs;
      while (sent.length && sent[0]!.at <= cutoff) used -= sent.shift()!.bytes;
      return used === 0 || used + bytes <= limit;
    },
    note(bytes: number): void {
      sent.push({ at: Date.now(), bytes });
      used += bytes;
    },
  };
}

interface QueuedFrame {
  frame: unknown;
  stillCurrent: () => boolean;
  bytes: number;
  control: boolean;
}

export class DeviceRouteTransport implements RemotePeerTransport {
  readonly events = new EventEmitter();
  closed = false;

  constructor(
    private readonly sendFrame: (frame: unknown) => void,
    private readonly onDispose: () => void,
  ) {}

  send(frame: unknown): void {
    if (this.closed) return;
    this.sendFrame(frame);
  }

  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.events.emit('close', reason);
    this.onDispose();
  }

  onMessage(handler: (frame: unknown) => void): () => void {
    this.events.on('message', handler);
    return () => this.events.off('message', handler);
  }

  onClose(handler: () => void): () => void {
    this.events.on('close', handler);
    return () => this.events.off('close', handler);
  }
}

export class HostRelaySocket {
  connectionId = generateCanonicalId();
  private readonly routes = new Map<string, DeviceRouteTransport>();
  private readonly noticeHandlers = new Set<(notice: RelayNotice) => void>();
  private readonly handshakeHandlers = new Set<(offer: CryptoOffer) => void>();
  private readonly queuedNotices: RelayNotice[] = [];
  private readonly boundHandlers = new Set<() => void>();
  private readonly closeHandlers = new Set<(reason: string) => void>();
  /** Sealed frames waiting to send, one FIFO lane per device route. */
  private readonly lanes = new Map<string, QueuedFrame[]>();
  /** Lanes that sent a frame in the current round. */
  private readonly served = new Set<string>();
  private draining = false;
  private closed = false;
  bound = false;

  private constructor(
    private readonly socket: WebSocket,
    private readonly frameLimiter = createRelayFrameTokenBucket(),
    private readonly byteBudget = createCiphertextBudget(),
  ) {}

  static connect(input: { url: string; ticket: string }): Promise<HostRelaySocket> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(input.url);
      const relay = new HostRelaySocket(socket);
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.removeEventListener('error', onError);
        if (error) reject(error);
        else resolve(relay);
      };
      const timer = setTimeout(() => finish(new Error('host relay auth timed out')), 5_000);
      const onError = (error: Event) => finish(new Error(String(error)));
      socket.addEventListener('error', onError);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          protocol: RELAY_PROTOCOL,
          type: 'ws.auth',
          ticket: input.ticket,
        }));
      }, { once: true });
      socket.addEventListener('message', (event) => {
        relay.#onMessage(typeof event.data === 'string' ? event.data : String(event.data));
        if (relay.bound) finish();
      });
      socket.addEventListener('close', () => {
        if (!relay.bound) finish(new Error('host relay closed before bind'));
        relay.close('socket_closed');
      });
    });
  }

  attachDevice(deviceId: string): DeviceRouteTransport {
    const existing = this.routes.get(deviceId);
    if (existing && !existing.closed) return existing;
    let transport: DeviceRouteTransport;
    transport = new DeviceRouteTransport(
      (frame) => this.sendWhen(frame, () => !transport.closed, deviceId),
      () => {
        this.routes.delete(deviceId);
        this.lanes.delete(deviceId);
      },
    );
    this.routes.set(deviceId, transport);
    return transport;
  }

  /** The relay reported this device route is no longer crypto-bound; drop it
   *  so the next handshake attaches a fresh transport. */
  dropRoute(deviceId: string): void {
    this.routes.get(deviceId)?.close('route_not_bound');
  }

  send(frame: unknown): void {
    const deviceId = frame && typeof frame === 'object' ? (frame as { device_id?: unknown }).device_id : undefined;
    this.sendWhen(frame, () => true, typeof deviceId === 'string' ? deviceId : '');
  }

  private sendWhen(frame: unknown, stillCurrent: () => boolean, lane: string): void {
    if (this.closed) return;
    if (frame && typeof frame === 'object' && 'ciphertext' in frame) {
      const { ciphertext, frame_class: frameClass } = frame as { ciphertext?: unknown; frame_class?: unknown };
      const queue = this.lanes.get(lane) ?? [];
      queue.push({
        frame,
        stillCurrent,
        bytes: typeof ciphertext === 'string' ? utf8ByteLength(ciphertext) : 0,
        control: frameClass !== 'content',
      });
      this.lanes.set(lane, queue);
      void this.drain();
      return;
    }
    if (stillCurrent()) this.sendNow(frame);
  }

  // The Server limits frames and ciphertext bytes per WebSocket, across every
  // device route, so all routes share one frame bucket and one byte budget.
  // Frames are already sealed with contiguous transport sequences: reordering
  // them within a route breaks both Relay sequence guards and peer AEAD
  // sessions. Routes are independent, so they interleave.
  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      let slot = false;
      for (;;) {
        if (this.closed || this.lanes.size === 0) return;
        if (!slot) {
          await this.frameLimiter.wait();
          slot = true;
          // Choose after the wait, so a control frame queued meanwhile goes first.
          continue;
        }
        const next = this.takeNext();
        if (!next) {
          await new Promise((resolve) => setTimeout(resolve, PACE_RETRY_MS));
          continue;
        }
        if (!next.stillCurrent()) continue;
        slot = false;
        this.sendNow(next.frame);
        this.byteBudget.note(next.bytes);
      }
    } finally {
      this.draining = false;
    }
  }

  /** Each route sends at most one frame per round, so one device's download
   *  cannot starve another device. Within a round a route whose next frame is
   *  control (Stop, approvals, hints) goes before bulk content. */
  private takeNext(): QueuedFrame | undefined {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let pick: string | undefined;
      for (const [lane, queue] of this.lanes) {
        if (this.served.has(lane) || !this.byteBudget.fits(queue[0]!.bytes)) continue;
        if (queue[0]!.control) {
          pick = lane;
          break;
        }
        pick ??= lane;
      }
      if (pick !== undefined) {
        const queue = this.lanes.get(pick)!;
        const next = queue.shift()!;
        if (queue.length === 0) this.lanes.delete(pick);
        this.served.add(pick);
        return next;
      }
      // Every route that fits has had its turn: start the next round.
      if (this.served.size === 0) return undefined;
      this.served.clear();
    }
    return undefined;
  }

  private sendNow(frame: unknown): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
      // Dropping a frame silently here would strand the device waiting for
      // it; surface the dead socket through the normal close/reconnect path.
      if (!this.closed) this.close('socket_not_open');
      return;
    }
    if (frame && typeof frame === 'object' && 'connection_id' in frame) {
      this.socket.send(JSON.stringify({ ...frame, connection_id: this.connectionId }));
      return;
    }
    this.socket.send(JSON.stringify(frame));
  }

  sendHandshake(message: RelayHandshake): void {
    if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  onHandshake(handler: (offer: CryptoOffer) => void): () => void {
    this.handshakeHandlers.add(handler);
    return () => this.handshakeHandlers.delete(handler);
  }

  ackRevoked(notice: RelayNotice): void {
    if (!notice.device_id) return;
    this.send({
      protocol: RELAY_PROTOCOL,
      type: 'device.revoked.ack',
      host_id: notice.host_id,
      device_id: notice.device_id,
      sent_at: Date.now(),
    });
  }

  onNotice(handler: (notice: RelayNotice) => void): () => void {
    this.noticeHandlers.add(handler);
    if (this.queuedNotices.length) {
      const queued = this.queuedNotices.splice(0);
      for (const notice of queued) handler(notice);
    }
    return () => this.noticeHandlers.delete(handler);
  }

  onClose(handler: (reason: string) => void): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  close(reason = 'host_closed'): void {
    if (this.closed) return;
    this.closed = true;
    this.bound = false;
    for (const transport of this.routes.values()) transport.close(reason);
    this.routes.clear();
    this.lanes.clear();
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
    for (const handler of this.closeHandlers) handler(reason);
  }

  #onMessage(raw: string): void {
    let parsed: { type?: string; device_id?: string };
    try {
      parsed = JSON.parse(raw) as { type?: string; device_id?: string };
    } catch {
      return;
    }
    if (parsed.type === 'ws.bound') {
      const bound = parsed as { connection_id?: string };
      if (bound.connection_id) this.connectionId = bound.connection_id;
      this.bound = true;
      for (const handler of this.boundHandlers) handler();
      return;
    }
    if (parsed.type === 'crypto.offer') {
      try {
        const offer = parseRelayHandshake(parsed);
        if (offer.type === 'crypto.offer') {
          for (const handler of this.handshakeHandlers) handler(offer);
        }
      } catch {
        return;
      }
      return;
    }
    if (
      parsed.type === 'device.revoked'
      || parsed.type === 'host.offline'
      || parsed.type === 'host.online'
      || parsed.type === 'pairing.claimed'
      || parsed.type === 'route.not_bound'
    ) {
      const notice = parsed as RelayNotice;
      if (this.noticeHandlers.size === 0) {
        this.queuedNotices.push(notice);
        return;
      }
      for (const handler of this.noticeHandlers) handler(notice);
      return;
    }
    const frame = parsed as RelayFrame;
    const route = frame.device_id ? this.routes.get(frame.device_id) : undefined;
    route?.events.emit('message', frame);
  }
}
