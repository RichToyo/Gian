import {
  CONTENT_WINDOW_CHUNKS, MAX_CONCURRENT_TRANSFERS_PER_DEVICE, RemoteProtocolError, TransferAckGate,
  applyDownloadChunk, applyDownloadMetadata, completeDownload, generateCanonicalId,
  parseClosed, transferAckSchema, transferErrorSchema, attachmentResultSchema, uploadRemoteAttachment,
  type DownloadTransfer, type AttachmentUploadResult,
} from '@gian/remote-protocol';
import type { RemoteControllerClient } from './controller-client.js';

/** Waits before the first and second retry of a transfer that failed transiently. */
export const TRANSFER_RETRY_DELAYS_MS: readonly number[] = [500, 2000];

/** A dropped relay, an offline Host or a rate limit (the Host's per-device
 *  transfer limit included) may pass on its own; a missing file, a denial
 *  or a transfer that already waited out its timeout will not. */
export function isTransientTransferError(error: unknown): boolean {
  return error instanceof RemoteProtocolError && (error.code === 'RATE_LIMITED'
    || (error.code === 'HOST_OFFLINE' && error.details?.reason !== 'timeout'));
}

/** Run one transfer, retrying a transient failure after each delay in turn. */
export async function retryTransientTransfer<T>(run: () => Promise<T>,
  delays: readonly number[] = TRANSFER_RETRY_DELAYS_MS): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await run(); }
    catch (error) {
      if (attempt >= delays.length || !isTransientTransferError(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** First come, first served slots for one environment's downloads, so no
 *  more run at once than its Host serves per device; the rest wait their
 *  turn instead of being refused. */
export class RemoteTransferSlots {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit = MAX_CONCURRENT_TRANSFERS_PER_DEVICE) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) this.active += 1;
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try { return await task(); }
    finally {
      // A finished transfer hands its slot straight to the next in line.
      const next = this.waiting.shift();
      if (next) next(); else this.active -= 1;
    }
  }
}

export class RemoteControllerContent {
  constructor(private readonly client: RemoteControllerClient) {}

  /** Download one Host-issued file handle. Only a complete transfer whose
   *  size and digest match resolves; a transfer whose connection closes
   *  fails at once (HOST_OFFLINE), so a retry can reconnect. Someone is
   *  looking at the file, so a reconnect backoff is waited out (bounded). */
  async download(handleId: string): Promise<{ bytes: Uint8Array; name: string; mime: string }> {
    const transferId = generateCanonicalId();
    let current: DownloadTransfer | undefined;
    let done = false;
    let resolve!: (value: { bytes: Uint8Array; name: string; mime: string }) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<{ bytes: Uint8Array; name: string; mime: string }>((yes, no) => { resolve = yes; reject = no; });
    const timer = setTimeout(() => reject(new RemoteProtocolError('HOST_OFFLINE', 'file download timed out', { reason: 'timeout' })), 120_000);
    timer.unref();
    let unwatch = () => {};
    const unsubscribe = this.client.onControl(async message => {
      if (message.transfer_id !== transferId || done) return;
      try {
        if (message.type === 'download.metadata') {
          current = applyDownloadMetadata(current, message, this.client.environment.host_id);
        } else if (message.type === 'attachment.chunk') {
          if (!current) throw new RemoteProtocolError('INVALID_FRAME', 'file metadata missing');
          current = applyDownloadChunk(current, message, transferId);
          await this.client.sendControl({ type: 'transfer.ack', transfer_id: transferId,
            contiguous_offset: current.nextOffset, window_chunks: CONTENT_WINDOW_CHUNKS });
        } else if (message.type === 'download.complete') {
          if (!current) throw new RemoteProtocolError('INVALID_FRAME', 'file metadata missing');
          const bytes = await completeDownload(current, message);
          done = true;
          resolve({ bytes, name: current.name, mime: current.mime });
        } else if (message.type === 'transfer.error') {
          // The Host's own reason decides between a retry and a final answer.
          const failure = transferErrorSchema.safeParse(message);
          throw new RemoteProtocolError(failure.success ? failure.data.code : 'FILE_REFERENCE_EXPIRED', 'file transfer failed');
        } else if (message.type === 'transfer.cancel') {
          throw new RemoteProtocolError('FILE_REFERENCE_EXPIRED', 'file transfer failed');
        }
      } catch (error) { reject(error instanceof Error ? error : new Error('file transfer failed')); }
    });
    try {
      await this.client.connect({ user: true });
      unwatch = this.client.onClose(() => reject(new RemoteProtocolError('HOST_OFFLINE',
        'the connection to the remote Host closed during the file download')));
      const sending = this.client.sendControl({ type: 'download.request', transfer_id: transferId,
        kind: 'file', handle_id: handleId }).catch(error => { reject(error); });
      const [read] = await Promise.all([result, sending]);
      return read;
    } finally {
      done = true; clearTimeout(timer); unsubscribe(); unwatch();
    }
  }

  upload(sessionId: string, name: string, mime: string, bytes: Uint8Array) {
    return uploadRemoteAttachment({ sessionId, name, mime, bytes,
      sendControl: message => this.client.sendControl(message), sendContent: message => this.client.sendContent(message),
      registerWaiters: transferId => {
        const acks = new TransferAckGate();
        let resolve!: (value: AttachmentUploadResult) => void;
        let reject!: (error: Error) => void;
        const result = new Promise<AttachmentUploadResult>((yes, no) => { resolve = yes; reject = no; });
        const fail = (error: Error) => { acks.abort(error); reject(error); };
        const timer = setTimeout(() => fail(new RemoteProtocolError('HOST_OFFLINE', 'attachment upload timed out')), 120_000);
        timer.unref();
        const unsubscribe = this.client.onControl(message => {
          if (message.transfer_id !== transferId) return;
          try {
            if (message.type === 'transfer.ack') acks.push(parseClosed(transferAckSchema, message));
            else if (message.type === 'attachment.result') resolve(parseClosed(attachmentResultSchema, message));
            else if (message.type === 'transfer.error' || message.type === 'transfer.cancel') fail(new RemoteProtocolError('TRANSFER_CONFLICT', 'attachment upload failed'));
          } catch { fail(new RemoteProtocolError('INVALID_FRAME', 'invalid attachment receipt')); }
        });
        return { result, acks, cleanup: () => { clearTimeout(timer); unsubscribe(); } };
      },
    });
  }
}
