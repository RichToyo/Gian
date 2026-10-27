import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Hono } from 'hono';
import test from 'node:test';
import type { ProxyCatalog, UserAgentStatus } from '@gian/shared';
import { AgentManager } from '../src/agents/manager.js';
import type { CatalogService } from '../src/catalog/service.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';
import { developmentEntries, testResolver } from './runtime-test-harness.js';

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

/** A dsh-like catalog: role-bearing model option plus a role-less provider
 *  select whose resolved model choices depend on the provider value. */
const DSH_LIKE_CATALOG: ProxyCatalog = {
  catalogRevision: 'dsh-test',
  input: [{ type: 'text' }],
  configOptions: [
    {
      id: 'provider',
      displayName: 'Provider',
      binding: 'turn',
      control: 'select',
      required: false,
      defaultValue: 'deepseek-official',
      choices: [
        { value: 'deepseek-official', displayName: 'DeepSeek' },
        { value: 'vendor-b', displayName: 'Vendor B' },
      ],
    },
    {
      id: 'model',
      displayName: 'Model',
      binding: 'turn',
      role: 'model',
      control: 'select',
      required: true,
      defaultValue: 'deepseek-chat',
      choices: [
        { value: 'deepseek-chat', displayName: 'DeepSeek Chat' },
        { value: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner' },
      ],
    },
  ],
  slashCommands: [],
};

async function makeApp(
  t: test.TestContext,
  environmentCliPaths?: Record<string, string>,
  pickHome?: () => Promise<
    | { kind: 'ok'; path: string }
    | { kind: 'canceled' }
    | { kind: 'error'; error: string }
  >,
  catalog: ProxyCatalog = {
    catalogRevision: 'test',
    input: [{ type: 'text' }],
    configOptions: [],
    slashCommands: [],
  },
  inspectCatalog?: () => Promise<ProxyCatalog>,
  hasRunningSessionsForAgent?: (agentId: string) => number,
  seedAgents?: Array<Record<string, unknown>>,
  pickRuntime?: () => Promise<
    | { kind: 'ok'; path: string }
    | { kind: 'canceled' }
    | { kind: 'error'; error: string }
  >,
  managedProxies = false,
) {
  const root = await mkdtemp(join(tmpdir(), 'gian-agents-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (seedAgents && seedAgents.length > 0) {
    const dataDir = join(root, 'data');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'agents.json'), `${JSON.stringify({
      schemaVersion: 4,
      agents: seedAgents,
    }, null, 2)}\n`);
  }
  const bins = {
    claude: join(root, 'bin', 'claude'),
    codex: join(root, 'bin', 'codex'),
    kimi: join(root, 'bin', 'kimi'),
    dsh: join(root, 'bin', 'dsh'),
  };
  await executable(bins.claude, 'claude 2.1.159');
  await executable(bins.codex, 'codex 0.146.0');
  await executable(bins.kimi, 'kimi 0.38.0');
  await executable(bins.dsh, 'dsh 0.1.1-rc.2');
  const agents = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies,
    developmentProxyEntries: await developmentEntries(root),
    runtimeResolver: testResolver(root),
    ...(environmentCliPaths ? { environmentCliPaths } : {}),
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    closeProxy: async () => undefined,
    capabilities: inspectCatalog ?? (async () => catalog),
    ...(pickHome ? { pickHome } : {}),
    ...(pickRuntime ? { pickRuntime } : {}),
    ...(hasRunningSessionsForAgent ? { hasRunningSessionsForAgent } : {}),
  });
  return { app, agents, root, bins };
}

test('POST /api/agents/pick-home supports a draft before an Agent id exists', async t => {
  const { app } = await makeApp(t, undefined, async () => ({
    kind: 'ok',
    path: '/Users/test/custom-home',
  }));
  const response = await app.request('/api/agents/pick-home', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/Users/test/custom-home' });
});

test('GET /api/proxies returns static catalog metadata only', async t => {
  const { app } = await makeApp(t);
  const response = await app.request('/api/proxies');
  assert.equal(response.status, 200);
  const body = await response.json() as {
    proxies: Array<{ id: string; name: string; logo: { light: string; dark: string } }>;
  };
  assert.deepEqual(body.proxies.map(entry => [entry.id, entry.name, entry.logo]), [
    ['claude', 'Claude Code', { light: '/api/proxies/claude/logo/light', dark: '/api/proxies/claude/logo/dark' }],
    ['codex', 'Codex', { light: '/api/proxies/codex/logo/light', dark: '/api/proxies/codex/logo/dark' }],
    ['kimi', 'Kimi Code', { light: '/api/proxies/kimi/logo/light', dark: '/api/proxies/kimi/logo/dark' }],
    ['dsh', 'DeepSeek Harness', { light: '/api/proxies/dsh/logo/light', dark: '/api/proxies/dsh/logo/dark' }],
    ['zcode', 'ZCode', { light: '/api/proxies/zcode/logo/light', dark: '/api/proxies/zcode/logo/dark' }],
  ]);
});

test('GET /api/proxies/:id/logo/:variant serves validated Proxy-owned bytes', async t => {
  const { app, agents } = await makeApp(t);
  agents.proxyLogo = async (id, variant) => id === 'kimi' && variant === 'light'
    ? { bytes: Buffer.from('official-kimi-logo'), mediaType: 'image/png', sha256: 'a'.repeat(64) }
    : null;

  const response = await app.request('/api/proxies/kimi/logo/light');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('etag'), `"${'a'.repeat(64)}"`);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString('utf8'), 'official-kimi-logo');
  assert.equal((await app.request('/api/proxies/kimi/logo/dark')).status, 404);
  assert.equal((await app.request('/api/proxies/grok/logo/light')).status, 404);
});

test('GET /api/proxies/:id/logo/:variant prefers the signed Catalog over an installed legacy Proxy logo', async t => {
  const { agents } = await makeApp(t);
  let legacyReads = 0;
  agents.proxyLogo = async () => {
    legacyReads += 1;
    return { bytes: Buffer.from('old-zcode-logo'), mediaType: 'image/png', sha256: 'a'.repeat(64) };
  };
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    closeProxy: async () => undefined,
    capabilities: async () => DSH_LIKE_CATALOG,
    catalogService: {
      logo: async (pluginId: string, variant: string) => pluginId === 'com.zhipu.zcode' && variant === 'light'
        ? { bytes: Buffer.from('new-zcode-logo'), mediaType: 'image/png', sha256: 'b'.repeat(64) }
        : null,
    } as unknown as CatalogService,
  });

  const response = await app.request('/api/proxies/com.zhipu.zcode/logo/light');
  assert.equal(response.status, 200);
  assert.equal(Buffer.from(await response.arrayBuffer()).toString(), 'new-zcode-logo');
  assert.equal(legacyReads, 0);

  const fallback = await app.request('/api/proxies/com.zhipu.zcode/logo/dark');
  assert.equal(fallback.status, 200);
  assert.equal(Buffer.from(await fallback.arrayBuffer()).toString(), 'old-zcode-logo');
  assert.equal(legacyReads, 1);
});

test('GET /api/agents returns saved Agents only, never unsaved catalog kinds', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app } = await makeApp(t, { claude });

  const initial = await app.request('/api/agents');
  const initialBody = await initial.json() as { agents: UserAgentStatus[] };
  // The environment CLI migrated exactly one Agent; codex/kimi/dsh catalog
  // kinds are NOT listed even though their development proxies exist.
  assert.deepEqual(initialBody.agents.map(agent => [agent.name, agent.proxy]), [
    ['Claude Code', 'claude'],
  ]);
  assert.equal(initialBody.agents[0]!.ready, true);
});

test('POST /api/agents creates a draft into a saved Agent; duplicate names 409', async t => {
  const { app, bins } = await makeApp(t);

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'My Codex', proxy: 'codex', cliPath: bins.codex }),
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json() as { agent: UserAgentStatus };
  assert.equal(createdBody.agent.name, 'My Codex');
  assert.equal('color' in createdBody.agent, false);
  assert.equal(createdBody.agent.proxy, 'codex');
  // (No readiness assertion: a path-less Agent auto-resolves official install
  // locations, which differ per machine.)

  const duplicate = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'my codex', proxy: 'kimi', cliPath: bins.kimi }),
  });
  assert.equal(duplicate.status, 409);
  assert.equal(
    (await duplicate.json() as { code?: string }).code,
    'AGENT_NAME_TAKEN',
  );

  const empty = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '   ', proxy: 'kimi' }),
  });
  assert.equal(empty.status, 400);

  const grok = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Grok', proxy: 'grok' }),
  });
  assert.equal(grok.status, 400, 'Grok stays out of the legacy product fallback');

});

test('POST /api/agents reuses an explicit GianDev runtime path without exposing a path field', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app } = await makeApp(t, { claude });
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Claude second', pluginId: 'claude', home: { kind: 'managed' } }),
  });
  assert.equal(created.status, 201);
  const body = await created.json() as { agent: UserAgentStatus };
  assert.equal(body.agent.cliPath, claude);
  assert.equal(body.agent.home?.kind, 'managed');
});

test('PATCH /api/agents/:id toggles enabled and rejects a non-boolean value', async t => {
  const { app, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Toggle Codex', proxy: 'codex', cliPath: bins.codex }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };
  assert.equal(agent.enabled, undefined);

  const bad = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: 'no' }),
  });
  assert.equal(bad.status, 400);

  const disabled = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json() as { agent: UserAgentStatus }).agent.enabled, false);

  const enabled = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json() as { agent: UserAgentStatus }).agent.enabled, true);
});

test('PATCH /api/agents/:id refuses to disable an Agent with sessions in progress', async t => {
  const { app, bins } = await makeApp(t, undefined, undefined, undefined, undefined, () => 2);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Busy Codex', proxy: 'codex', cliPath: bins.codex }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const blocked = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  });
  assert.equal(blocked.status, 409);
  const blockedBody = await blocked.json() as {
    error: string;
    code?: string;
    runningSessions?: number;
  };
  assert.equal(blockedBody.code, 'AGENT_HAS_RUNNING_SESSIONS');
  assert.equal(blockedBody.runningSessions, 2);

  // The failed disable left the Agent untouched.
  const after = await app.request(`/api/agents/${agent.id}`);
  assert.equal((await after.json() as UserAgentStatus).enabled, undefined);

  // Enabling never trips the running-session guard.
  const enabled = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json() as { agent: UserAgentStatus }).agent.enabled, true);
});

test('PATCH /api/agents/:id renames; DELETE removes; 404 for unknown ids', async t => {
  const { app, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'One', proxy: 'kimi', cliPath: bins.kimi }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const renamed = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Two' }),
  });
  assert.equal(renamed.status, 200);
  const renamedBody = await renamed.json() as { agent: UserAgentStatus };
  assert.equal(renamedBody.agent.name, 'Two');
  assert.equal('color' in renamedBody.agent, false);

  const missing = await app.request('/api/agents/nope', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Three' }),
  });
  assert.equal(missing.status, 404);
  // Kind literals are not Agent ids.
  const kindLiteral = await app.request('/api/agents/kimi', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Three' }),
  });
  assert.equal(kindLiteral.status, 404);

  const deleted = await app.request(`/api/agents/${agent.id}`, { method: 'DELETE' });
  assert.equal(deleted.status, 200);
  const after = await app.request('/api/agents');
  assert.deepEqual((await after.json() as { agents: unknown[] }).agents, []);
});

test('GET /api/agents/:id serves kind status for drafts and Agent status for saved Agents', async t => {
  const { app, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Solo', proxy: 'codex', cliPath: bins.codex }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const kindStatus = await app.request('/api/agents/codex');
  assert.equal(kindStatus.status, 200);
  const kindBody = await kindStatus.json() as { id: string; name: string };
  assert.equal(kindBody.id, 'codex');
  assert.equal(kindBody.name, 'Codex');

  const agentStatus = await app.request(`/api/agents/${agent.id}`);
  assert.equal(agentStatus.status, 200);
  const agentBody = await agentStatus.json() as UserAgentStatus;
  assert.equal(agentBody.id, agent.id);
  assert.equal(agentBody.proxyName, 'Codex');

  const unknown = await app.request('/api/agents/not-an-agent');
  assert.equal(unknown.status, 404);
});

test('GET /api/proxies/:id/draft-defaults numbers names and exposes HOME plus read-only active path', async t => {
  const claude = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-bin2-')), 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');
  const { app, root } = await makeApp(t, { claude });

  const second = await app.request('/api/proxies/claude/draft-defaults');
  assert.deepEqual(await second.json(), {
    name: 'Claude Code 2',
    home: { kind: 'default', path: join(root, 'home', '.claude') },
    cliPath: claude,
  });
  const dsh = await app.request('/api/proxies/dsh/draft-defaults');
  assert.deepEqual(await dsh.json(), {
    name: 'DeepSeek Harness',
    home: { kind: 'default', path: join(root, 'home', '.dsh') },
    cliPath: null,
  });
  const zcode = await app.request('/api/proxies/zcode/draft-defaults');
  assert.equal(zcode.status, 200);
  assert.deepEqual((await zcode.json() as { home: unknown }).home, {
    kind: 'default', path: join(root, 'home', '.zcode'),
  });

  // Official-user / PATH locations are not Host-scanned. A draft without a
  // saved Agent or readiness snapshot stays pathless until Runtime discover.
  const kimiBin = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-home-')), '.kimi-code', 'bin', 'kimi');
  await executable(kimiBin, 'kimi 0.31.1');
  const proxy2 = join(await mkdtemp(join(tmpdir(), 'gian-agents-route-p2-')), 'proxy.mjs');
  await writeFile(proxy2, 'export {};\n');
  const homeDir = dirname(dirname(dirname(kimiBin)));
  const agents2 = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(await mkdtemp(join(tmpdir(), 'gian-agents-route-data-')), 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { kimi: proxy2 },
    homeDir,
    kimiCodeHome: join(homeDir, '.kimi'),
    pathEnv: '',
  });
  const app2 = new Hono();
  registerAgentRoutes(app2, {
    agents: agents2,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'test',
      input: [{ type: 'text' }],
      configOptions: [],
      slashCommands: [],
    }),
  });
  const kimi = await app2.request('/api/proxies/kimi/draft-defaults');
  assert.deepEqual(await kimi.json(), {
    name: 'Kimi Code',
    home: { kind: 'default', path: join(homeDir, '.kimi') },
    cliPath: null,
  });

  const grok = await app.request('/api/proxies/grok/draft-defaults');
  assert.equal(grok.status, 200);
  assert.deepEqual(await grok.json(), {
    name: 'Grok Build',
    home: { kind: 'default', path: join(root, 'home', '.grok') },
    cliPath: null,
  });
  const unknown = await app.request('/api/proxies/io.acme.unknown/draft-defaults');
  assert.equal(unknown.status, 404);
});

test('Grok default HOME creation and subsequent drafts use pluginId without a product alias', async t => {
  const { app, root } = await makeApp(t);
  const grok = join(root, 'bin', 'grok');
  await executable(grok, 'grok 1.0.4');
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Grok Build', pluginId: 'grok', cliPath: grok }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };
  assert.equal(agent.proxy, null);
  assert.deepEqual(agent.home, {
    kind: 'custom', path: await realpath(join(root, 'home', '.grok')),
  });
  const draft = await app.request('/api/proxies/grok/draft-defaults');
  assert.equal(draft.status, 200);
  assert.deepEqual(await draft.json(), {
    name: 'Grok Build 2',
    home: { kind: 'default', path: join(root, 'home', '.grok') },
    cliPath: grok,
  });
});

test('explicit default HOME creates a builtin directory and cannot be patched or reused', async t => {
  const { app, agents, root, bins } = await makeApp(t);
  const claudeHome = join(root, 'home', '.claude');
  await assert.rejects(access(claudeHome));

  const kindOnly = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Code', pluginId: 'claude', cliPath: bins.claude, home: { kind: 'default' },
    }),
  });
  assert.equal(kindOnly.status, 400);
  assert.match((await kindOnly.json() as { error: string }).error, /default home requires kind and expectedPath/);
  await assert.rejects(access(claudeHome));
  assert.equal(agents.listAgents().length, 0);

  const withPath = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Code', pluginId: 'claude', cliPath: bins.claude,
      home: { kind: 'default', path: claudeHome },
    }),
  });
  assert.equal(withPath.status, 400);
  assert.match((await withPath.json() as { error: string }).error, /default home requires kind and expectedPath/);
  await assert.rejects(access(claudeHome));
  assert.equal(agents.listAgents().length, 0);

  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Code', pluginId: 'claude', cliPath: bins.claude,
      home: { kind: 'default', expectedPath: claudeHome },
    }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };
  assert.equal(agent.proxy, 'claude');
  assert.deepEqual(agent.home, { kind: 'custom', path: await realpath(claudeHome) });

  const beforeOccupied = await readFile(join(root, 'data', 'agents.json'), 'utf8');
  const occupied = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Code 2', pluginId: 'claude', cliPath: bins.claude,
      home: { kind: 'default', expectedPath: claudeHome },
    }),
  });
  assert.equal(occupied.status, 409);
  assert.equal((await occupied.json() as { code?: string }).code, 'AGENT_HOME_IN_USE');
  assert.equal(agents.listAgents().length, 1);
  assert.equal(await readFile(join(root, 'data', 'agents.json'), 'utf8'), beforeOccupied);

  const extra = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Claude Code 3', pluginId: 'claude', cliPath: bins.claude,
      home: { kind: 'default', expectedPath: claudeHome, path: claudeHome },
    }),
  });
  assert.equal(extra.status, 400);
  assert.match((await extra.json() as { error: string }).error, /default home requires kind and expectedPath/);
  assert.equal(agents.listAgents().length, 1);

  const before = await readFile(join(root, 'data', 'agents.json'), 'utf8');
  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ home: { kind: 'default', expectedPath: claudeHome } }),
  });
  assert.equal(patched.status, 400);
  assert.match((await patched.json() as { error: string }).error, /managed or custom/);
  assert.equal(await readFile(join(root, 'data', 'agents.json'), 'utf8'), before);

  const grokBin = join(root, 'bin', 'grok');
  await executable(grokBin, 'grok 1.0.4');
  const grokHome = join(root, 'home', '.grok');
  await assert.rejects(access(grokHome));
  const grok = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Grok Build', pluginId: 'grok', cliPath: grokBin,
      home: { kind: 'default', expectedPath: grokHome },
    }),
  });
  assert.equal(grok.status, 201);
  const grokAgent = (await grok.json() as { agent: UserAgentStatus }).agent;
  assert.equal(grokAgent.proxy, null);
  assert.deepEqual(grokAgent.home, { kind: 'custom', path: await realpath(grokHome) });
});

test('POST /api/agents rejects an uninstalled reverse-domain pluginId', async t => {
  const { app, root } = await makeApp(t);
  const response = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fixture', pluginId: 'io.gian.fixture' }),
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { code?: string };
  assert.equal(body.code, 'PLUGIN_NOT_FOUND');
  const persisted = JSON.parse(await readFile(join(root, 'data', 'agents.json'), 'utf8')) as {
    agents: unknown[];
  };
  assert.equal(persisted.agents.length, 0);
});

test('PATCH defaults is local on cold managed, custom, and source Agent status', async t => {
  for (const [managed, runtime] of [
    [true, undefined], [true, { kind: 'custom', path: '/missing/custom-cli' }], [false, undefined],
  ] as const) {
    const { agents, root } = await makeApp(t, undefined, undefined, DSH_LIKE_CATALOG,
      undefined, undefined, [{
        id: 'offline-agent', name: 'Offline', pluginId: 'io.acme.fixture', proxy: null,
        cliPath: null, runtime, home: null,
        defaults: { model: 'old-model', thinking: 'old-effort', mode: 'old-mode', options: {} },
      }], undefined, managed);
    let probes = 0;
    agents.agentStatus = async () => { probes += 1; throw new Error('Runtime unavailable'); };
    agents.trustedLaunch = async () => { probes += 1; throw new Error('Proxy unavailable'); };
    const app = new Hono();
    registerAgentRoutes(app, {
      agents, closeProxy: async () => { probes += 1; },
      capabilities: async () => { probes += 1; throw new Error('Provider offline'); },
    });
    const response = await app.request('/api/agents/offline-agent', {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaults: { options: { provider: 'future-provider' } } }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { agent: UserAgentStatus };
    assert.equal(body.agent.ready, false, 'a cold response must not invent readiness');
    assert.equal(body.agent.cli.readinessIssue?.code, 'RUNTIME_STATUS_NOT_CHECKED');
    assert.equal(body.agent.defaults.model, 'old-model');
    assert.deepEqual(body.agent.defaults.options, { provider: 'future-provider' });
    assert.deepEqual(body.agent.runtime ?? null, runtime ?? null);
    const disk = JSON.parse(await readFile(join(root, 'data', 'agents.json'), 'utf8'));
    assert.equal(disk.agents[0].defaults.model, 'old-model');
    assert.deepEqual(disk.agents[0].defaults.options, { provider: 'future-provider' });
    assert.equal(probes, 0, 'save and response must not inspect Proxy or Runtime');
  }
});

test('consecutive preference saves retain observed facts, but HOME changes invalidate them', async t => {
  const { app, agents, bins } = await makeApp(t);
  const saved = await agents.createAgent({ name: 'Writer', proxy: 'claude', cliPath: bins.claude });
  const observed = await agents.agentStatus(saved.id);
  assert.equal(observed.ready, true);
  agents.agentStatus = async () => { throw new Error('save must not re-probe status'); };
  for (const defaults of [{ model: 'future-model' }, { thinking: 'future-effort' }]) {
    const response = await app.request(`/api/agents/${saved.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaults }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { agent: UserAgentStatus };
    assert.equal(body.agent.ready, observed.ready);
    assert.deepEqual(body.agent.cli, observed.cli);
    assert.equal(body.agent.plugin.version, observed.plugin.version);
    assert.deepEqual(body.agent.plugin.defaults, body.agent.defaults);
  }
  assert.equal(agents.getAgent(saved.id).defaults.model, 'future-model');
  await agents.updateAgent(saved.id, { home: { kind: 'managed' } });
  assert.equal(agents.agentStatusSnapshot(saved.id).ready, false);
});

test('PATCH /api/agents/:id accepts role-less option defaults, deletes on null', async t => {
  const { app, agents, bins } = await makeApp(t, undefined, undefined, DSH_LIKE_CATALOG);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'DSH', proxy: 'dsh', cliPath: bins.dsh }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { options: { provider: 'vendor-b' } } }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(agents.getAgent(agent.id).defaults.options, { provider: 'vendor-b' });

  const deleted = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { options: { provider: null } } }),
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(agents.getAgent(agent.id).defaults.options, {});
});

for (const intervening of ['invalidation', 'newer-observation'] as const) {
  test(`preference commit does not revive stale Runtime facts after ${intervening}`, async t => {
    const { agents, bins } = await makeApp(t);
    const saved = await agents.createAgent({ name: 'Writer', proxy: 'claude', cliPath: bins.claude });
    const observed = await agents.agentStatus(saved.id);
    const internals = agents as unknown as {
      saveConfig: (...args: unknown[]) => Promise<void>;
      invalidateAgentStatus: (id: string) => void;
      agentStatusCache: Map<string, { value: UserAgentStatus; expiresAt: number }>;
    };
    const save = internals.saveConfig.bind(agents);
    let started!: () => void;
    let release!: () => void;
    const writing = new Promise<void>(resolve => { started = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    t.mock.method(internals, 'saveConfig', async (...args: unknown[]) => {
      started();
      await blocked;
      await save(...args);
    });
    const update = agents.updateAgent(saved.id, { defaults: { model: 'new-preference' } });
    await writing;
    if (intervening === 'invalidation') internals.invalidateAgentStatus(saved.id);
    else internals.agentStatusCache.set(saved.id, {
      value: { ...observed, cli: { ...observed.cli, version: 'new-observation' } },
      expiresAt: 123,
    });
    release();
    await update;
    const status = agents.agentStatusSnapshot(saved.id);
    if (intervening === 'invalidation') {
      assert.equal(status.ready, false);
      assert.equal(status.cli.readinessIssue?.code, 'RUNTIME_STATUS_NOT_CHECKED');
    } else {
      assert.equal(status.cli.version, 'new-observation');
      assert.equal(internals.agentStatusCache.get(saved.id)?.expiresAt, 123, 'freshness must not be extended');
    }
    assert.equal(status.defaults.model, 'new-preference');
  });
}

test('defaults-only writes skip Codex reconciliation but HOME changes preserve it', async t => {
  const { agents, bins } = await makeApp(t);
  const saved = await agents.createAgent({ name: 'Codex', proxy: 'codex', cliPath: bins.codex });
  let reconciles = 0;
  agents.reconcileManagedSkills = async () => { reconciles += 1; return []; };
  await agents.updateAgent(saved.id, { defaults: { model: 'future-model' } });
  assert.equal(reconciles, 0);
  await agents.updateAgent(saved.id, { home: { kind: 'managed' } });
  assert.equal(reconciles, 1);
});

test('a failed local defaults commit preserves in-memory and disk preferences', async t => {
  const { app, agents, bins, root } = await makeApp(t);
  const saved = await agents.createAgent({ name: 'Writer', proxy: 'claude', cliPath: bins.claude });
  const before = await readFile(join(root, 'data', 'agents.json'), 'utf8');
  const preferences = structuredClone(saved.defaults);
  t.mock.method(agents as unknown as { saveConfig: () => Promise<void> }, 'saveConfig',
    async () => { throw new Error('disk unavailable'); });
  const response = await app.request(`/api/agents/${saved.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { model: 'future-model' } }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(agents.getAgent(saved.id).defaults, preferences);
  assert.equal(await readFile(join(root, 'data', 'agents.json'), 'utf8'), before);
});

test('PATCH /api/agents/:id rejects malformed and unbounded defaults atomically', async t => {
  const { app, agents, bins } = await makeApp(t, undefined, undefined, DSH_LIKE_CATALOG);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'DSH', proxy: 'dsh', cliPath: bins.dsh }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };
  const patch = (defaults: unknown) => app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults }),
  });

  assert.equal((await patch({ options: ['provider'] })).status, 400);
  assert.equal((await patch({ options: { provider: { nested: true } } })).status, 400);
  assert.equal((await patch({ options: { 'bad key': 'x' } })).status, 400);
  assert.equal((await patch({ model: 7 })).status, 400);
  assert.equal((await patch({ model: 'x'.repeat(4097) })).status, 400);
  assert.equal((await patch({ unknown: true })).status, 400);
  assert.equal((await patch({ options: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, true])) })).status, 400);
  assert.equal((await patch({ options: { provider: 'x'.repeat(4097) } })).status, 400);
  const overflow = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' },
    body: '{"defaults":{"options":{"number":1e999}}}',
  });
  assert.equal(overflow.status, 400);
  assert.deepEqual(agents.getAgent(agent.id).defaults.options, {});
  assert.equal((await patch({
    options: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, true])),
  })).status, 200);
  const before = structuredClone(agents.getAgent(agent.id).defaults);
  assert.equal((await patch({ model: 'must-not-commit', options: { extra: true } })).status, 400);
  assert.deepEqual(agents.getAgent(agent.id).defaults, before);
});

test('PATCH /api/agents/:id preserves unrelated preferences without resolving dependent metadata', async t => {
  let probes = 0;
  const { app, agents, bins } = await makeApp(
    t,
    undefined,
    undefined,
    DSH_LIKE_CATALOG,
    async () => { probes += 1; throw new Error('Provider unavailable'); },
  );
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'DSH',
      proxy: 'dsh',
      cliPath: bins.dsh,
      defaults: { model: 'deepseek-chat', options: { provider: 'deepseek-official' } },
    }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };
  assert.equal(agents.getAgent(agent.id).defaults.model, 'deepseek-chat');

  // A provider edit must not rewrite the stored model.
  const switched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { options: { provider: 'vendor-b' } } }),
  });
  assert.equal(switched.status, 200);
  const defaults = agents.getAgent(agent.id).defaults;
  assert.deepEqual(defaults.options, { provider: 'vendor-b' });
  assert.equal(defaults.model, 'deepseek-chat');

  // Semantic choices are deliberately deferred to new-session creation.
  const invalid = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { model: 'deepseek-chat' } }),
  });
  assert.equal(invalid.status, 200);
  assert.equal(agents.getAgent(agent.id).defaults.model, 'deepseek-chat');
  assert.equal(probes, 0);
});

test('PATCH /api/agents/:id accepts option defaults shape-only on an empty catalog', async t => {
  const { app, agents, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'DSH', proxy: 'dsh', cliPath: bins.dsh }),
  });
  const { agent } = await created.json() as { agent: UserAgentStatus };
  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { options: { provider: 'offline-value' } } }),
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(agents.getAgent(agent.id).defaults.options, { provider: 'offline-value' });
});

// ---------------------------------------------------------------------------
// Agent identity: pluginId is the live key; a null proxy alias never gates
// ---------------------------------------------------------------------------

const FIXTURE_SEED = {
  id: 'agent-fixture-1',
  name: 'Fixture Plugin Agent',
  pluginId: 'io.gian.fixture',
  proxy: null,
  cliPath: null,
  defaults: { model: '', thinking: '', mode: '', options: {} },
};

test('PATCH defaults succeeds for a pure-plugin Agent (null proxy alias)', async t => {
  const { app, agents } = await makeApp(t, undefined, undefined, DSH_LIKE_CATALOG, undefined, undefined, [FIXTURE_SEED]);
  const agent = agents.getAgent('agent-fixture-1');
  assert.equal(agent.pluginId, 'io.gian.fixture');
  assert.equal(agent.proxy, null);

  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { options: { provider: 'vendor-b' } } }),
  });
  assert.equal(patched.status, 200, JSON.stringify(await patched.json()));
  assert.deepEqual(agents.getAgent(agent.id).defaults.options, { provider: 'vendor-b' });
});

/** A provider-native catalog above the `catalog.modeSemantics` gate: the
 *  mode option carries modeKind='provider-native' and is turn-bound — binding
 *  alone must not decide the Gian-preset vs native distinction. */
const MODE_KIND_CATALOG: ProxyCatalog = {
  catalogRevision: 'modekind-test',
  input: [{ type: 'text' }],
  configOptions: [
    {
      id: 'collab_mode',
      displayName: 'Collaboration mode',
      binding: 'turn',
      role: 'approval_mode',
      modeKind: 'provider-native',
      control: 'select',
      required: true,
      defaultValue: 'vendor-a',
      choices: [
        { value: 'vendor-a', displayName: 'Vendor A mode' },
        { value: 'vendor-b', displayName: 'Vendor B mode' },
      ],
    },
  ],
  slashCommands: [],
};

test('PATCH mode defaults do not depend on catalog semantics or the proxy alias', async t => {
  const { app, agents } = await makeApp(t, undefined, undefined, MODE_KIND_CATALOG, undefined, undefined, [FIXTURE_SEED]);
  const agent = agents.getAgent('agent-fixture-1');
  // The catalog stamps modeKind='provider-native'; the fixture pluginId is
  // NOT on the legacy native allowlist, but the catalog decides — and the
  // option being turn-bound is irrelevant to that distinction.
  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { mode: 'vendor-a' } }),
  });
  assert.equal(patched.status, 200, JSON.stringify(await patched.json()));
  assert.equal(agents.getAgent(agent.id).defaults.mode, 'vendor-a');

  // Offline preferences may name a future native choice.
  const invalid = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { mode: 'not-advertised' } }),
  });
  assert.equal(invalid.status, 200);
  assert.equal(agents.getAgent(agent.id).defaults.mode, 'not-advertised');
});

test('GET agent status keeps a null proxy alias readable without gating readiness text', async t => {
  const { app, agents } = await makeApp(t, undefined, undefined, DSH_LIKE_CATALOG, undefined, undefined, [FIXTURE_SEED]);
  const agent = agents.getAgent('agent-fixture-1');
  const response = await app.request(`/api/agents/${agent.id}`);
  assert.equal(response.status, 200);
  const status = await response.json() as UserAgentStatus;
  assert.equal(status.pluginId, 'io.gian.fixture');
  assert.equal(status.proxy, null);
  // proxy:null never maps to an "unsupported" product state: the Agent is
  // listed and addressable, with readiness carried by the dedicated field.
  assert.equal(status.ready, false, 'fixture plugin is not installed in this env');
  assert.match(status.proxyName, /io\.gian\.fixture|Fixture/);
});

test('POST /api/agents accepts a custom Runtime binding (ADR-0102)', async t => {
  const { app, bins } = await makeApp(t);
  const response = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Company Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: bins.claude },
    }),
  });
  assert.equal(response.status, 201);
  const body = await response.json() as { agent: UserAgentStatus };
  assert.deepEqual(body.agent.runtime, { kind: 'custom', path: bins.claude });
});

test('POST /api/agents rejects a malformed runtime binding', async t => {
  const { app } = await makeApp(t);
  const response = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Bad Runtime', pluginId: 'claude', runtime: 'nope' }),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /runtime must be an object/);
});

test('POST /api/agents preserves a custom Runtime missing content-root probe failure', async t => {
  const { app, root } = await makeApp(t);
  const response = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'Broken Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: join(root, 'bin', 'missing-runtime') },
    }),
  });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; code?: string };
  assert.equal(body.code, 'RUNTIME_ROOT_MISSING');
});

test('PATCH /api/agents/:id rejects Runtime edits (create-only binding)', async t => {
  const { app, bins } = await makeApp(t);
  const created = await app.request('/api/agents', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Company Claude', pluginId: 'claude', runtime: { kind: 'custom', path: bins.claude } }),
  });
  assert.equal(created.status, 201);
  const { agent } = await created.json() as { agent: UserAgentStatus };

  const patched = await app.request(`/api/agents/${agent.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runtime: { kind: 'managed' } }),
  });
  assert.equal(patched.status, 400);
  assert.equal((await patched.json() as { code?: string }).code, 'RUNTIME_EDIT_UNSUPPORTED');
});

test('POST /api/agents/pick-runtime returns the picked file path', async t => {
  const { app } = await makeApp(t, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => ({ kind: 'ok', path: '/Users/test/bin/claude-company' }));
  const response = await app.request('/api/agents/pick-runtime', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { path: '/Users/test/bin/claude-company' });
});
