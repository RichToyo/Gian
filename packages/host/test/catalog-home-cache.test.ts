import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProxyCatalog, ServerToClientMessage } from '@gian/shared';
import { openDatabase } from '../src/storage/db.js';
import { SessionManager } from '../src/session/manager.js';
import type { ProxyManager } from '../src/proxy/manager.js';
import type { ProxyClient, NotificationHandler } from '../src/proxy/types.js';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { ApprovalManager } from '../src/approval/index.js';
import { QueueManager } from '../src/queue/index.js';

const CLI = '/bin/claude';
const HOME_A = '/tmp/gian-catalog-home-a';
const HOME_B = '/tmp/gian-catalog-home-b';

function modelCatalog(modelId: string): ProxyCatalog {
  return {
    catalogRevision: modelId,
    input: [{ type: 'text' }],
    configOptions: [{
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: false,
      defaultValue: modelId,
      choices: [{ value: modelId, displayName: modelId }],
    }],
    slashCommands: [],
  };
}

function makeClient(executor: 'claude' | 'codex', modelId: string, empty = false): ProxyClient & { callCount: number } {
  const client = {
    executor,
    callCount: 0,
    isExited() { return false; },
    async initialize() {
      return {
        protocol: { name: 'gian.proxy', version: '2.0' },
        plugin: { id: executor, name: executor, version: '0.2.0' },
        process: { scope: 'session' as const },
        capabilities: { 'catalog.resolve': 1 },
      };
    },
    async catalog() {
      client.callCount += 1;
      return empty ? { ...modelCatalog(modelId), configOptions: [] } : modelCatalog(modelId);
    },
    async resolveCatalog(params: { catalogRevision: string }) {
      assert.equal(params.catalogRevision, modelId);
      return { ...modelCatalog(modelId), resolvedDefaults: { sessionConfig: {}, turnConfig: {} } };
    },
    async createSession(params: { cwd: string; nativeSessionId?: string }) {
      const id = params.nativeSessionId ?? `proxy_${randomUUID()}`;
      return {
        session: {
          id,
          cwd: params.cwd,
          state: 'idle' as const,
          createdAt: '2026-05-17T00:00:00.000Z',
          updatedAt: '2026-05-17T00:00:00.000Z',
          lastError: null,
        },
        nativeSessionId: id,
      };
    },
    async interruptTurn() {},
    async respondInteraction() {},
    async startTurn() {
      return {
        session: {
          id: 'p',
          cwd: '/tmp',
          state: 'running' as const,
          createdAt: '2026-05-17T00:00:00.000Z',
          updatedAt: '2026-05-17T00:00:00.000Z',
          lastError: null,
        },
        turn: { id: 't' },
      };
    },
    async closeSession() {},
    async shutdown() {},
    forceKill() {},
    onNotification(_handler: NotificationHandler) { return () => {}; },
    onExit() { return () => {}; },
  };
  return client;
}

interface ProbeCall {
  key: string;
  cliPath?: string | null;
  env?: Readonly<Record<string, string>>;
}

class HomeKeyedProxy {
  readonly calls: ProbeCall[] = [];
  readonly disposedKeys: string[] = [];
  emptyNext = false;
  failNextDispose = false;
  private readonly clients = new Map<string, ReturnType<typeof makeClient>>();

  constructor(private readonly dataDir: string) {}

  async getOrCreate(
    key: string,
    executor: 'claude' | 'codex',
    options?: { cliPath?: string | null; env?: Readonly<Record<string, string>> },
  ): Promise<ProxyClient> {
    // The real session-scoped ProxyManager uses this identifier as a mkdir
    // component. Exercise that boundary rather than accepting NUL/path keys.
    assert.match(key, /^__caps__[A-Za-z0-9._-]+$/);
    mkdirSync(join(this.dataDir, 'proxy', key), { recursive: true });
    this.calls.push({ key, cliPath: options?.cliPath, ...(options?.env ? { env: options.env } : {}) });
    let client = this.clients.get(key);
    if (!client) {
      const home = options?.env?.CLAUDE_CONFIG_DIR ?? 'default';
      client = makeClient(executor, `model-${home}`, this.emptyNext);
      this.emptyNext = false;
      this.clients.set(key, client);
    }
    return client;
  }

  get(): undefined { return undefined; }
  async closeAll(): Promise<void> {}
  async dispose(key: string): Promise<void> {
    this.disposedKeys.push(key);
    if (this.failNextDispose) {
      this.failNextDispose = false;
      throw new Error('fixture disposal failed');
    }
    this.clients.delete(key);
  }
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'gian-catalog-home-'));
  const db = openDatabase(dir);
  const proxy = new HomeKeyedProxy(dir);
  const broadcaster = {
    add() {},
    remove() {},
    send() {},
    broadcast(_message: ServerToClientMessage) {},
    get size() { return 0; },
  };
  const sessions = new SessionManager(
    db,
    proxy as unknown as ProxyManager,
    broadcaster as unknown as WsBroadcaster,
    new ApprovalManager(broadcaster as unknown as WsBroadcaster),
    new QueueManager(db),
    dir,
  );
  return { dir, db, sessions, proxy };
}

function teardown(ctx: { dir: string; db: ReturnType<typeof openDatabase> }) {
  ctx.db.close();
  rmSync(ctx.dir, { recursive: true, force: true });
}

function modelId(catalog: ProxyCatalog): string {
  return String(catalog.configOptions[0]?.choices?.[0]?.value);
}

test('warmCapabilities isolates catalogs for the same CLI under different homes', async () => {
  const ctx = setup();
  try {
    const homeA = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);
    const homeB = await ctx.sessions.warmCapabilities('claude', CLI, HOME_B);
    const again = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);

    assert.equal(modelId(homeA), `model-${HOME_A}`);
    assert.equal(modelId(homeB), `model-${HOME_B}`);
    assert.equal(modelId(again), modelId(homeA));
    assert.equal(
      modelId(ctx.sessions.getCapabilities('claude', CLI, HOME_A)!),
      modelId(homeA),
    );
    assert.equal(ctx.sessions.getCapabilities('claude', CLI), null);

    const keys = ctx.proxy.calls.map(call => call.key);
    assert.equal(keys.length, 2);
    assert.ok(keys.every(key => /^__caps__[0-9a-f]{64}$/.test(key)));
    assert.notEqual(keys[0], keys[1]);
    assert.deepEqual(ctx.proxy.calls.map(call => call.cliPath), [CLI, CLI]);
    assert.deepEqual(ctx.proxy.calls[0]?.env, {
      GIAN_AGENT_HOME: HOME_A,
      CLAUDE_CONFIG_DIR: HOME_A,
    });
    assert.deepEqual(ctx.proxy.calls[1]?.env, {
      GIAN_AGENT_HOME: HOME_B,
      CLAUDE_CONFIG_DIR: HOME_B,
    });
  } finally {
    teardown(ctx);
  }
});

test('warmCapabilities without a home keeps the executor probe key and shares one process', async () => {
  const ctx = setup();
  try {
    const first = await ctx.sessions.warmCapabilities('claude');
    const second = await ctx.sessions.warmCapabilities('claude');
    assert.equal(modelId(first), 'model-default');
    assert.equal(modelId(second), 'model-default');
    assert.deepEqual(ctx.proxy.calls, [{ key: '__caps__claude', cliPath: null }]);
  } finally {
    teardown(ctx);
  }
});

test('warm and resolve share a filesystem-safe process identity without sharing Runtime/HOME catalogs', async () => {
  const ctx = setup();
  try {
    const first = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);
    const resolved = await ctx.sessions.resolveCatalog('claude', {
      catalogRevision: first.catalogRevision, sessionConfig: {}, turnConfig: {},
    }, undefined, CLI, HOME_A);
    assert.equal(modelId(resolved), modelId(first));
    assert.equal(ctx.proxy.calls[0]?.key, ctx.proxy.calls[1]?.key);
    assert.deepEqual(ctx.sessions.getProtocolCapabilities('claude', CLI, HOME_A), { 'catalog.resolve': 1 });
    await ctx.sessions.warmCapabilities('claude', `${CLI}-other`, HOME_A);
    await ctx.sessions.warmCapabilities('claude', CLI, HOME_B);
    await ctx.sessions.warmCapabilities('claude', CLI);
    assert.equal(new Set(ctx.proxy.calls.map(call => call.key)).size, 4);

    // Even embedded separators/control characters in logical identities may
    // never become directory traversal or raw NUL process identifiers.
    await ctx.sessions.warmCapabilities('claude', '/tmp/../../runtime\0suffix', '/tmp/home\0tail');
    await ctx.sessions.warmCapabilities('claude', '/tmp/../../runtime', '/tmp/suffix\0home\0tail');
    const keys = ctx.proxy.calls.slice(-2).map(call => call.key);
    assert.notEqual(keys[0], keys[1]);
    assert.ok(keys.every(key => /^__caps__[0-9a-f]{64}$/.test(key)));
  } finally {
    teardown(ctx);
  }
});

test('empty Catalog retry and failed disposal retain the same safe warm/resolve identity', async () => {
  const ctx = setup();
  try {
    ctx.proxy.emptyNext = true;
    const empty = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);
    assert.deepEqual(empty.configOptions, []);
    const key = ctx.proxy.calls[0]!.key;
    ctx.proxy.failNextDispose = true;
    const params = { catalogRevision: `model-${HOME_A}`, sessionConfig: {}, turnConfig: {} };
    await assert.rejects(ctx.sessions.resolveCatalog('claude', params, undefined, CLI, HOME_A), /disposal failed/);
    assert.equal(ctx.proxy.calls.length, 1, 'failed disposal must not reuse the stale process');
    const resolved = await ctx.sessions.resolveCatalog('claude', params, undefined, CLI, HOME_A);
    assert.equal(modelId(resolved), `model-${HOME_A}`);
    const ready = await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);
    assert.equal(modelId(ready), modelId(resolved));
    await ctx.sessions.warmCapabilities('claude', CLI, HOME_A);
    assert.deepEqual(ctx.proxy.disposedKeys, [key, key]);
    assert.ok(ctx.proxy.calls.every(call => call.key === key));
    assert.equal(ctx.proxy.calls.length, 3);
  } finally {
    teardown(ctx);
  }
});
