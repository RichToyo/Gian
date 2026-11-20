import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MAX_ATTACHMENT_BYTES, canonicalIdSchema } from '@gian/remote-protocol';

/** Bytes kept across all environments before the least recently used
 *  attachments are evicted. */
export const ATTACHMENT_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** One attachment's cap: the largest download a Host serves. */
export const ATTACHMENT_CACHE_MAX_FILE_BYTES = MAX_ATTACHMENT_BYTES;

/** A remote message attachment never changes for one reference in one
 *  remote session, so this identifies its bytes for good. */
export interface RemoteAttachmentKey {
  environmentId: string;
  localSessionId: string;
  remoteSessionId: string;
  reference: string;
}

export interface CachedRemoteAttachment {
  bytes: Uint8Array;
  name: string;
  /** The type the Host declared; served as the response's content type. */
  mime: string;
  /** Hex SHA-256 of the bytes, also the HTTP entity tag. */
  sha256: string;
}

interface Meta {
  version: 1;
  remote_session_id: string;
  reference: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

interface Entry { environmentId: string; localSessionId: string; base: string; size: number }

/**
 * Remote message attachments on this Mac's disk, so a transcript that
 * scrolls back or reopens shows them without the relay — even for a removed
 * environment's history. Laid out as `<root>/<environment>/<local session>/
 * <digest>.bin` plus a `.json` record (type, name, size, digest) written
 * last: an entry without both, with a size or digest that does not match,
 * or for a session that no longer exists is dropped, so partial bytes are
 * never served. Least recently used entries go past the total cap.
 */
export class RemoteAttachmentCache {
  /** Least recently used first: a hit moves its entry to the end. */
  private readonly entries = new Map<string, Entry>();
  private total = 0;
  private loading: Promise<void> | null = null;
  /** Deleted sessions: a download that finishes after the delete is not kept. */
  private readonly forgotten = new Set<string>();

  constructor(
    private readonly root: () => string,
    /** Whether a cached session still exists here (in that environment). */
    private readonly live: (environmentId: string, localSessionId: string) => boolean,
    private readonly limits = { totalBytes: ATTACHMENT_CACHE_MAX_BYTES, fileBytes: ATTACHMENT_CACHE_MAX_FILE_BYTES },
  ) {}

  async get(key: RemoteAttachmentKey): Promise<CachedRemoteAttachment | null> {
    const base = this.base(key);
    if (!base) return null;
    await this.load();
    const entry = this.entries.get(base);
    if (!entry) return null;
    try {
      const meta = JSON.parse(await readFile(base + '.json', 'utf8')) as Meta;
      const bytes = new Uint8Array(await readFile(base + '.bin'));
      if (meta.remote_session_id !== key.remoteSessionId || meta.reference !== key.reference
        || bytes.byteLength !== meta.size || sha256(bytes) !== meta.sha256) throw new Error('cache entry is damaged');
      this.entries.delete(base);
      this.entries.set(base, entry);
      await utimes(base + '.bin', new Date(), new Date()).catch(() => undefined);
      return { bytes, name: meta.name, mime: meta.mime, sha256: meta.sha256 };
    } catch {
      await this.drop(base);
      return null;
    }
  }

  /** Keep one complete, verified download. Best effort: a failed write
   *  leaves no entry behind. */
  async put(key: RemoteAttachmentKey, value: CachedRemoteAttachment): Promise<void> {
    const base = this.base(key);
    const size = value.bytes.byteLength;
    if (!base || size > this.limits.fileBytes || size > this.limits.totalBytes
      || this.forgotten.has(key.localSessionId) || sha256(value.bytes) !== value.sha256) return;
    await this.load();
    if (this.entries.has(base)) return;
    const meta: Meta = { version: 1, remote_session_id: key.remoteSessionId, reference: key.reference,
      name: value.name, mime: value.mime, size, sha256: value.sha256 };
    const temporary = `${base}.${randomUUID()}.tmp`;
    try {
      await mkdir(join(this.root(), key.environmentId, key.localSessionId), { recursive: true, mode: 0o700 });
      await writeFile(temporary, value.bytes, { mode: 0o600 });
      await rename(temporary, base + '.bin');
      await writeFile(temporary, JSON.stringify(meta), { mode: 0o600 });
      await rename(temporary, base + '.json');
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      await this.drop(base);
      return;
    }
    if (this.forgotten.has(key.localSessionId)) { await this.drop(base); return; }
    if (this.entries.has(base)) return;
    this.entries.set(base, { environmentId: key.environmentId, localSessionId: key.localSessionId, base, size });
    this.total += size;
    await this.trim();
  }

  /** A deleted session's attachments go with it. */
  async evictSession(localSessionId: string): Promise<void> {
    if (!canonicalIdSchema.safeParse(localSessionId).success) return;
    this.forgotten.add(localSessionId);
    await this.load();
    for (const entry of [...this.entries.values()]) if (entry.localSessionId === localSessionId) this.forget(entry);
    for (const environment of await readdir(this.root()).catch(() => [] as string[])) {
      await rm(join(this.root(), environment, localSessionId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Bytes currently kept (tests and diagnostics). */
  get size(): number { return this.total; }

  private base(key: RemoteAttachmentKey): string | null {
    if (!canonicalIdSchema.safeParse(key.environmentId).success || !canonicalIdSchema.safeParse(key.localSessionId).success) return null;
    const digest = createHash('sha256').update(key.remoteSessionId).update('\n').update(key.reference).digest('hex');
    return join(this.root(), key.environmentId, key.localSessionId, digest);
  }

  private load(): Promise<void> {
    this.loading ??= this.scan();
    return this.loading;
  }

  /** Index what an earlier run kept, oldest use first (the bytes' mtime);
   *  sweep leftovers and orphans. */
  private async scan(): Promise<void> {
    const root = this.root();
    const found: Array<{ entry: Entry; usedAt: number }> = [];
    for (const environmentId of await readdir(root).catch(() => [] as string[])) {
      if (!canonicalIdSchema.safeParse(environmentId).success) {
        await rm(join(root, environmentId), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      for (const localSessionId of await readdir(join(root, environmentId)).catch(() => [] as string[])) {
        const directory = join(root, environmentId, localSessionId);
        if (!canonicalIdSchema.safeParse(localSessionId).success || !this.live(environmentId, localSessionId)) {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
        const names = new Set(await readdir(directory).catch(() => [] as string[]));
        for (const name of names) {
          if (!name.endsWith('.json') || !names.has(name.slice(0, -5) + '.bin')) {
            // An interrupted write: a temporary file, or bytes without a record.
            if (!name.endsWith('.bin') || !names.has(name.slice(0, -4) + '.json')) {
              await rm(join(directory, name), { force: true }).catch(() => undefined);
            }
            continue;
          }
          const base = join(directory, name.slice(0, -5));
          try {
            const meta = JSON.parse(await readFile(base + '.json', 'utf8')) as Meta;
            const info = await stat(base + '.bin');
            if (meta.version !== 1 || info.size !== meta.size) throw new Error('cache entry is damaged');
            found.push({ entry: { environmentId, localSessionId, base, size: info.size }, usedAt: info.mtimeMs });
          } catch { await this.drop(base); }
        }
      }
    }
    for (const { entry } of found.sort((a, b) => a.usedAt - b.usedAt)) {
      this.entries.set(entry.base, entry);
      this.total += entry.size;
    }
    await this.trim();
  }

  private async trim(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      if (this.total <= this.limits.totalBytes) break;
      this.forget(entry);
      await this.remove(entry.base);
    }
  }

  private forget(entry: Entry): void {
    if (this.entries.get(entry.base) !== entry) return;
    this.entries.delete(entry.base);
    this.total -= entry.size;
  }

  private async drop(base: string): Promise<void> {
    const entry = this.entries.get(base);
    if (entry) this.forget(entry);
    await this.remove(base);
  }

  private async remove(base: string): Promise<void> {
    await rm(base + '.json', { force: true }).catch(() => undefined);
    await rm(base + '.bin', { force: true }).catch(() => undefined);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
