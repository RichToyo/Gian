import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { RemoteIdentityBrokerClient, RemoteIdentityUnavailableError } from '../src/remote/identity-broker.js';

async function withStubBroker(
  handler: (body: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>,
  run: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gian-broker-client-'));
  const socketPath = join(dir, 'broker.sock');
  const server: Server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      const result = await handler(body);
      response.statusCode = 200;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(result));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'stub' }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  try {
    await run(socketPath);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}

test('broker client waits out a slow Desktop main loop within the raised default timeout', async () => {
  await withStubBroker(
    async () => {
      await new Promise(resolve => setTimeout(resolve, 3_000));
      return { refresh_secret: 'kept' };
    },
    async (socketPath) => {
      const client = new RemoteIdentityBrokerClient(socketPath);
      assert.equal(await client.getRefreshSecret(), 'kept');
    },
  );
});

test('broker client still fails fast when its own timeout is exceeded', async () => {
  await withStubBroker(
    async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return { refresh_secret: null };
    },
    async (socketPath) => {
      const client = new RemoteIdentityBrokerClient(socketPath, 50);
      await assert.rejects(() => client.getRefreshSecret(),
        error => error instanceof RemoteIdentityUnavailableError && /timed out/.test(error.message));
    },
  );
});

test('a superseded translation key lookup aborts its broker request', async () => {
  let release!: () => void;
  let arrived!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const requested = new Promise<void>(resolve => { arrived = resolve; });
  await withStubBroker(
    async () => { arrived(); await waiting; return { key: 'fake-key' }; },
    async socketPath => {
      const controller = new AbortController();
      const request = new RemoteIdentityBrokerClient(socketPath).getTranslationKey(controller.signal);
      await requested;
      controller.abort();
      try { await assert.rejects(request, error => (error as Error).name === 'AbortError'); }
      finally { release(); }
    },
  );
});

test('every broker failure is a RemoteIdentityUnavailableError that keeps its cause', async () => {
  // Desktop's broker is not listening: its socket is missing.
  const dir = await mkdtemp(join(tmpdir(), 'gian-broker-missing-'));
  try {
    const missing = new RemoteIdentityBrokerClient(join(dir, 'broker.sock'));
    await assert.rejects(() => missing.ensurePublic(), (error: unknown) => {
      assert.ok(error instanceof RemoteIdentityUnavailableError);
      assert.equal((error.cause as { code?: unknown }).code, 'ENOENT');
      return true;
    });
  } finally { await rm(dir, { recursive: true, force: true }); }

  // The broker answers with an error, such as after GitHub sign-out.
  await withStubBroker(
    () => { throw new Error('signed_out'); },
    async socketPath => {
      await assert.rejects(() => new RemoteIdentityBrokerClient(socketPath).sign(new Uint8Array([1])),
        (error: unknown) => error instanceof RemoteIdentityUnavailableError && error.message === 'signed_out');
    },
  );

  // An answer without the identity it was asked for.
  await withStubBroker(
    () => ({ public_key: null, fingerprint: '' }),
    async socketPath => {
      await assert.rejects(() => new RemoteIdentityBrokerClient(socketPath).ensurePublic(),
        (error: unknown) => error instanceof RemoteIdentityUnavailableError);
    },
  );
});
