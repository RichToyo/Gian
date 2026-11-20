import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/** A separate encrypted credential, independent of Remote sign-in and logout. */
export class TranslationKeyStore {
  constructor(private readonly options: {
    path: string;
    encryptionAvailable(): boolean;
    encrypt(value: string): Buffer;
    decrypt(value: Buffer): string;
  }) {}

  async get(): Promise<string | null> {
    if (!this.options.encryptionAvailable()) throw new Error('secure storage unavailable');
    let contents: string;
    try { contents = await readFile(this.options.path, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const payload = JSON.parse(contents) as { version?: number; encrypted?: unknown };
    if (payload.version !== 1 || typeof payload.encrypted !== 'string') throw new Error('invalid credential store');
    return this.options.decrypt(Buffer.from(payload.encrypted, 'base64'));
  }

  async set(key: string | null): Promise<void> {
    if (!this.options.encryptionAvailable()) throw new Error('secure storage unavailable');
    if (key === null) {
      try { await unlink(this.options.path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      return;
    }
    const encrypted = this.options.encrypt(key).toString('base64');
    await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.options.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, encrypted }), { mode: 0o600, flag: 'wx' });
      await chmod(temporary, 0o600);
      await rename(temporary, this.options.path);
    } finally {
      try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
