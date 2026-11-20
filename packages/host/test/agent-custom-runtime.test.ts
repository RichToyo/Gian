import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { parseProxyPluginId, sessionRuntimeCliPath, type ManagedRuntimeGeneration, type SessionProxyBinding } from '@gian/shared';

import { AgentCreateError, AgentManager } from '../src/agents/manager.js';
import type { RuntimeResolver } from '../src/runtime/resolver.js';
import { RuntimeReadinessCache } from '../src/runtime/readiness-cache.js';
import { SessionBindingPlanner } from '../src/session/binding-planner.js';
import { prepareInspectionLaunch } from '../src/proxy/inspection-launch.js';
import { SessionManager } from '../src/session/manager.js';
import { openDatabase } from '../src/storage/db.js';
import { loadConfig } from '../src/storage/config.js';
import { MemoryRemoteIdentity } from '../src/remote/identity.js';
import { createApp } from '../src/web/app.js';
import { fakeOfficialProxy, testResolver } from './runtime-test-harness.js';

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

/** Managed-mode AgentManager whose trusted claude launch is the probing fake
 *  Proxy from the runtime test harness, so a custom Runtime path is really
 *  probed (`path --version`) through the RuntimeResolver. */
async function customHarness(
  t: test.TestContext,
  runtimeKind: 'external' | 'none' = 'external',
  verifiedVersions = ['2.1.159'],
) {
  const root = await mkdtemp(join(tmpdir(), 'gian-custom-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = await fakeOfficialProxy(root, 'claude', 'Claude Code', '0.2.4');
  const pluginStore = {
    currentLaunch: async (pluginId: string) => pluginId === 'claude'
      ? {
        pluginId: parseProxyPluginId('claude'),
        pluginVersion: '0.2.4',
        manifestSha256: 'a'.repeat(64),
        protocolRange: '>=2.2 <3.0',
        entryPath: proxyEntry,
        processScope: 'session' as const,
        schemaVersion: 4 as const,
        runtime: runtimeKind === 'external'
          ? {
            kind: 'external' as const,
            id: 'claude',
            displayName: 'Claude Code',
            verifiedVersions,
          }
          : { kind: 'none' as const },
      }
      : null,
  };
  const options = {
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.6.5',
    managedProxies: true,
    runtimeResolver: testResolver(root),
    pluginStore,
    homeDir: join(root, 'home'),
    pathEnv: '',
  };
  const manager = await AgentManager.create(options as never);
  return { root, manager, options };
}

test('custom version policy agrees across Agent creation, status, catalog inspection, launch and resume', async t => {
  for (const [version, verification] of [
    ['2.1.285', 'unverified'], ['2.1.310', 'verified'], ['2.1.311', 'unverified'],
  ] as const) {
    await t.test(version, async t => {
      const { root, manager, options } = await customHarness(t, 'external', ['2.1.310']);
      const path = join(root, 'bin', 'custom-runtime');
      await executable(path, `claude ${version}`);
      const agent = await manager.createAgent({
        name: 'Custom', pluginId: 'claude', runtime: { kind: 'custom', path }, home: { kind: 'managed' },
      });
      const status = await manager.agentStatus(agent.id, true);
      assert.equal(status.ready, true);
      assert.equal(status.runtimeProfile?.verification, verification);
      assert.deepEqual(status.runtimeProfile?.verifiedVersions, ['2.1.310']);
      assert.equal(status.runtimeProfile?.configHome, agent.home?.path);
      assert.equal(manager.agentStatusSnapshot(agent.id).runtimeProfile?.verification, verification);
      const reloaded = await AgentManager.create(options as never);
      assert.equal((await reloaded.agentStatus(agent.id)).runtimeProfile?.verification, verification);

      const launch = { ...(await options.pluginStore.currentLaunch('claude'))!, source: 'github-release' as const };
      const planner = new SessionBindingPlanner({
        resolveCurrent: async () => launch,
        resolveExact: async () => launch,
        resolveActiveGeneration: async () => { throw new Error('Custom must not adopt a managed generation'); },
        agentHasCustomRuntime: id => manager.getAgent(id).runtime?.kind === 'custom',
        runtimeResolver: options.runtimeResolver,
      });
      const inspection = await prepareInspectionLaunch('claude', {
        agentId: agent.id, cliPath: path, configHome: agent.home?.path,
        runtimeProfileId: status.runtimeProfile?.id,
      }, { agents: manager, planner });
      await inspection.releaseUnusedLease();
      const prepared = await planner.prepareCurrent({ agent, selectedPath: '/not/the/selected/runtime' });
      assert.equal(prepared.sessionBinding.runtimeProfile?.verification, verification);
      assert.equal(sessionRuntimeCliPath(prepared.sessionBinding.runtimeProfile), path);
      await prepared.releaseUnusedLease();
      const resumed = await planner.prepareResume(prepared.sessionBinding);
      assert.equal(resumed.sessionBinding.runtimeProfile?.verification, verification);
      assert.equal(resumed.sessionBinding.runtimeProfile?.configHome, agent.home?.path);
      await resumed.releaseUnusedLease();
      const retained = await planner.prepareExact(prepared.sessionBinding);
      assert.equal(retained.sessionBinding.runtimeProfile?.verification, verification);
      await retained.releaseUnusedLease();
      const captured = await planner.captureLegacyAttach({
        pluginId: 'claude', agentId: agent.id, selectedPath: path,
        runtimeProfile: prepared.sessionBinding.runtimeProfile,
      });
      assert.equal(captured?.sessionBinding.runtimeProfile?.verification, verification);
      assert.equal(captured?.sessionBinding.runtimeProfile?.configHome, agent.home?.path);
      await captured?.releaseUnusedLease();

      // An override path, with no explicit Custom owner, keeps managed policy.
      const managed = new SessionBindingPlanner({
        resolveCurrent: async () => launch, resolveExact: async () => launch,
        agentHasCustomRuntime: () => false, runtimeResolver: options.runtimeResolver,
      });
      if (verification === 'unverified' && version === '2.1.285') {
        await assert.rejects(managed.prepareCurrent({ agent: { ...agent, runtime: null }, selectedPath: path }),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BINDING_RUNTIME_INCOMPATIBLE');
        await assert.rejects(managed.prepareResume(prepared.sessionBinding),
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BINDING_RUNTIME_INCOMPATIBLE');
      }
      await rm(path);
      await assert.rejects(planner.prepareResume(prepared.sessionBinding));
      assert.equal((await manager.agentStatus(agent.id, true)).ready, false);
    });
  }
});

test('custom Agent creation rejects invalid versions, failed probes and non-executable files', async t => {
  for (const failure of ['invalid-version', 'probe-exit', 'not-executable'] as const) {
    await t.test(failure, async t => {
      const { root, manager } = await customHarness(t);
      const path = join(root, 'bin', 'runtime');
      await executable(path, failure === 'invalid-version' ? 'not-a-version' : 'claude 2.1.159');
      if (failure === 'probe-exit') await writeFile(path, '#!/bin/sh\nexit 1\n');
      if (failure === 'not-executable') await chmod(path, 0o644);
      await assert.rejects(manager.createAgent({ name: failure, pluginId: 'claude', runtime: { kind: 'custom', path } }),
        (error: unknown) => error instanceof AgentCreateError);
      assert.equal(manager.listAgents().length, 0);
    });
  }
});

test('a resolver installed after Manager creation does not require an injected readiness cache', async t => {
  const { root, options } = await customHarness(t, 'external', ['2.1.310']);
  const manager = await AgentManager.create({ ...options, runtimeResolver: undefined } as never);
  manager.setRuntimeResolver(options.runtimeResolver);
  const path = join(root, 'bin', 'runtime');
  await executable(path, 'claude 2.1.285');
  const agent = await manager.createAgent({ name: 'Late resolver', pluginId: 'claude', runtime: { kind: 'custom', path } });
  for (const refresh of [false, true]) {
    const status = await manager.agentStatus(agent.id, refresh);
    assert.equal(status.ready, true);
    assert.equal(status.runtimeProfile?.verification, 'unverified');
    assert.equal(status.cli.readinessIssue, undefined);
  }
});

test('source-first custom status uses its own older Runtime and source Proxy', async t => {
  const { root, options } = await customHarness(t);
  const path = join(root, 'bin', 'source-custom');
  await executable(path, 'claude 2.1.100');
  const proxyEntry = (await options.pluginStore.currentLaunch('claude'))!.entryPath;
  const manager = await AgentManager.create({
    ...options, managedProxies: false, developmentProxyEntries: { claude: proxyEntry },
  } as never);
  const agent = await manager.createAgent({ name: 'Source Custom', pluginId: 'claude', runtime: { kind: 'custom', path } });
  const status = await manager.agentStatus(agent.id, true);
  assert.equal(status.ready, true);
  assert.equal(status.plugin.source, 'development');
  assert.equal(status.runtimeProfile?.path, path);
  assert.equal(status.runtimeProfile?.verification, 'unverified');
  assert.equal(manager.agentRuntimePath(agent.id).cliPath, path);
});

test('boot warmup inspects the saved Custom Agent rather than launching a path-only legacy probe', async t => {
  const { root, manager, options } = await customHarness(t, 'external', ['2.1.310']);
  const path = join(root, 'bin', 'runtime');
  await executable(path, 'claude 2.1.285');
  const agent = await manager.createAgent({ name: 'Boot Custom', pluginId: 'claude', runtime: { kind: 'custom', path } });
  const inspected: string[] = [];
  let legacyCalls = 0;
  let finish!: () => void;
  const warmed = new Promise<void>(resolve => { finish = resolve; });
  const catalog = { catalogRevision: 'fixture', input: [{ type: 'text' as const }], configOptions: [], slashCommands: [] };
  t.mock.method(SessionManager.prototype, 'agentCapabilities', async (pluginId: string, agentId: string) => {
    assert.equal(pluginId, 'claude');
    inspected.push(agentId);
    finish();
    return { catalog, capabilities: {} };
  });
  t.mock.method(SessionManager.prototype, 'warmCapabilities', async () => {
    legacyCalls += 1;
    finish();
    return catalog;
  });
  const previous = process.env.GIAN_SKIP_PROXY_WARMUP;
  delete process.env.GIAN_SKIP_PROXY_WARMUP;
  const db = openDatabase(options.dataDir);
  const app = createApp({
    db, config: loadConfig(db), dataDir: options.dataDir, agentManager: manager,
    runtimeResolver: options.runtimeResolver, remoteIdentity: new MemoryRemoteIdentity(),
    resolveLegacyLaunch: async () => { throw new Error('Custom boot must not request a legacy launch'); },
  });
  try {
    await warmed;
    assert.deepEqual(inspected, [agent.id]);
    assert.equal(legacyCalls, 0);
  } finally {
    await app.shutdown();
    db.close();
    if (previous === undefined) delete process.env.GIAN_SKIP_PROXY_WARMUP;
    else process.env.GIAN_SKIP_PROXY_WARMUP = previous;
  }
});

test('custom readiness and explicit incompatibility stay blocking in status, creation, inspection and resume', async t => {
  const { root, manager, options } = await customHarness(t, 'external', ['2.1.310']);
  const path = join(root, 'bin', 'runtime');
  await executable(path, 'claude 2.1.285');
  const agent = await manager.createAgent({ name: 'Custom', pluginId: 'claude', runtime: { kind: 'custom', path } });
  const launch = { ...(await options.pluginStore.currentLaunch('claude'))!, source: 'github-release' as const };
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => launch, resolveExact: async () => launch,
    agentHasCustomRuntime: () => true, runtimeResolver: options.runtimeResolver,
  });
  const prepared = await planner.prepareCurrent({ agent, selectedPath: path });
  await prepared.releaseUnusedLease();
  const resolve = options.runtimeResolver.resolve.bind(options.runtimeResolver);
  options.runtimeResolver.resolve = async input => {
    const resolved = await resolve(input);
    await resolved.lease?.release();
    return { ...resolved, lease: null, readinessIssue: {
      code: 'fixture_not_ready', message: 'Custom runtime needs setup.', repairable: false,
    } };
  };
  const reloaded = await AgentManager.create(options as never);
  const status = await reloaded.agentStatus(agent.id, true);
  assert.equal(status.ready, false);
  assert.equal(status.runtimeProfile?.verification, 'unverified');
  assert.equal(status.cli.readinessIssue?.code, 'fixture_not_ready');
  await assert.rejects(reloaded.createAgent({ name: 'Blocked', pluginId: 'claude', runtime: { kind: 'custom', path } }));
  await assert.rejects(prepareInspectionLaunch('claude', { agentId: agent.id }, { agents: reloaded, planner }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'fixture_not_ready');
  await assert.rejects(planner.prepareResume(prepared.sessionBinding),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'fixture_not_ready');
  options.runtimeResolver.resolve = async input => {
    const resolved = await resolve(input);
    return { ...resolved, profile: { ...resolved.profile, verification: 'incompatible' as const } };
  };
  const incompatible = await AgentManager.create(options as never);
  const blocked = await incompatible.agentStatus(agent.id, true);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.cli.readinessIssue?.code, 'RUNTIME_INCOMPATIBLE');
  await assert.rejects(incompatible.createAgent({ name: 'Incompatible', pluginId: 'claude', runtime: { kind: 'custom', path } }));
  await assert.rejects(prepareInspectionLaunch('claude', { agentId: agent.id }, { agents: incompatible, planner }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BINDING_RUNTIME_INCOMPATIBLE');
  await assert.rejects(planner.prepareResume(prepared.sessionBinding),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'BINDING_RUNTIME_INCOMPATIBLE');
});

test('custom readiness and retained status never cross managed policy, HOME or invalidation', async t => {
  const { root, options } = await customHarness(t, 'external', ['2.1.310']);
  const path = join(root, 'bin', 'runtime');
  await executable(path, 'claude 2.1.285');
  const readinessCache = new RuntimeReadinessCache();
  const manager = await AgentManager.create({ ...options, readinessCache } as never);
  const agent = await manager.createAgent({ name: 'Custom', pluginId: 'claude', runtime: { kind: 'custom', path } });
  const homeA = agent.home!.path;
  const snapshot = readinessCache.get('claude', '0.2.4', path, { configHome: homeA })!;
  assert.equal(snapshot.profile?.verification, 'unverified');
  assert.equal(readinessCache.get('claude', '0.2.4', path), null);
  assert.equal(readinessCache.get('claude', '0.2.4'), null, 'Custom must not become managed Catalog readiness');
  const homeB = join(root, 'other-home');
  await mkdir(homeB);
  await manager.agentStatus(agent.id);
  await manager.updateAgent(agent.id, { home: { kind: 'custom', path: homeB } });
  assert.equal(manager.agentStatusSnapshot(agent.id).ready, false);
  assert.equal(readinessCache.get('claude', '0.2.4', path, { configHome: homeB }), null);
  const afterHomeChange = await manager.agentStatus(agent.id, true);
  assert.equal(afterHomeChange.ready, true);
  assert.equal(afterHomeChange.runtimeProfile?.configHome, homeB);
  assert.notEqual(afterHomeChange.runtimeProfile?.id, snapshot.profile?.id);
  readinessCache.invalidate('claude', '0.2.4', path);
  const invalidated = await manager.agentStatus(agent.id, true);
  assert.equal(invalidated.ready, false);
  assert.equal(invalidated.runtimeProfile, null, 'Retained path-only profiles must not resurrect invalidated readiness');
  assert.equal(invalidated.cli.readinessIssue?.code, 'RUNTIME_MUTATED');
  await executable(path, 'claude 2.1.310');
  const fresh = await AgentManager.create(options as never);
  const refreshed = await fresh.agentStatus(agent.id, true);
  assert.equal(refreshed.runtimeProfile?.verification, 'verified');
});

test('create persists a custom Runtime binding, probes the path, and prefers it over the managed generation', async t => {
  const { root, manager, options } = await customHarness(t);
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const home = join(root, 'custom-home');
  await mkdir(home, { recursive: true });

  const agent = await manager.createAgent({
    name: 'Company Claude',
    pluginId: 'claude',
    home: { kind: 'custom', path: home },
    runtime: { kind: 'custom', path: runtimePath },
  });
  assert.deepEqual(agent.runtime, { kind: 'custom', path: runtimePath });
  assert.equal(manager.agentRuntimePath(agent.id).cliPath, runtimePath);

  const persisted = JSON.parse(await readFile(join(root, 'data', 'agents.json'), 'utf8')) as {
    schemaVersion: number;
    agents: Array<Record<string, unknown>>;
  };
  assert.equal(persisted.schemaVersion, 6);
  assert.deepEqual(persisted.agents[0]!['runtime'], { kind: 'custom', path: runtimePath });

  const status = await manager.agentStatus(agent.id, true);
  assert.equal(status.ready, true);
  assert.equal(status.cli.source, 'override');
  assert.equal(status.cli.path, runtimePath);
  assert.equal(status.cli.version, '2.1.159');

  // A fresh Manager (no probe cache, e.g. after a Host restart) re-probes the
  // stored path instead of falling back to a managed generation.
  const reloaded = await AgentManager.create(options as never);
  assert.deepEqual(reloaded.listAgents()[0]!.runtime, { kind: 'custom', path: runtimePath });
  const reloadedStatus = await reloaded.agentStatus(agent.id, true);
  assert.equal(reloadedStatus.ready, true);
  assert.equal(reloadedStatus.cli.path, runtimePath);
});

test('create with a custom Runtime preserves the missing content-root probe failure', async t => {
  const { root, manager } = await customHarness(t);
  const missing = join(root, 'bin', 'missing-runtime');
  await assert.rejects(
    manager.createAgent({
      name: 'Broken Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: missing },
    }),
    (error: unknown) => error instanceof AgentCreateError
      && error.code === 'RUNTIME_ROOT_MISSING'
      && error.status === 400,
  );
  assert.equal(manager.listAgents().length, 0);
});

test('custom creation needs a trusted compatible Proxy but not a ready managed Runtime', async t => {
  const { root, options } = await customHarness(t);
  const path = join(root, 'bin', 'company-claude');
  await executable(path, 'claude 2.1.159');
  let compatible = true;
  const manager = await AgentManager.create({ ...options, catalogService: {
    get: async () => ({
      compatibility: { state: compatible ? 'compatible' : 'requires_app_update' },
      installation: { state: 'installed' },
      runtime: { state: 'setup_required' },
      availableActions: [],
    }),
  } } as never);
  const agent = await manager.createAgent({ name: 'Company', pluginId: 'claude', runtime: { kind: 'custom', path } });
  assert.equal(manager.agentRuntimePath(agent.id).cliPath, path);
  compatible = false;
  await assert.rejects(manager.createAgent({ name: 'Incompatible', pluginId: 'claude', runtime: { kind: 'custom', path } }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'CATALOG_CREATE_FORBIDDEN');
});

test('create with a custom Runtime rejects a non-absolute path', async t => {
  const { manager } = await customHarness(t);
  await assert.rejects(
    manager.createAgent({
      name: 'Relative Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: 'bin/claude' },
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_INVALID',
  );
});

test('a none-Runtime Proxy cannot bind a custom Runtime path', async t => {
  const { root, manager } = await customHarness(t, 'none');
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  await assert.rejects(
    manager.createAgent({
      name: 'None Claude',
      pluginId: 'claude',
      runtime: { kind: 'custom', path: runtimePath },
    }),
    (error: unknown) => error instanceof AgentCreateError && error.code === 'RUNTIME_NONE_HAS_PATH',
  );
});

test('update rejects Runtime edits (create-only binding, ADR-0102 phase 1)', async t => {
  const { root, manager } = await customHarness(t);
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const agent = await manager.createAgent({
    name: 'Company Claude',
    pluginId: 'claude',
    runtime: { kind: 'custom', path: runtimePath },
  });
  await assert.rejects(
    manager.updateAgent(agent.id, { runtime: { kind: 'managed' } }),
    (error: unknown) => error instanceof AgentCreateError
      && error.code === 'RUNTIME_EDIT_UNSUPPORTED',
  );
});

test('a custom Runtime Agent reports an explicit error when its path disappears', async t => {
  const { root, manager } = await customHarness(t);
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const agent = await manager.createAgent({
    name: 'Company Claude',
    pluginId: 'claude',
    runtime: { kind: 'custom', path: runtimePath },
  });
  assert.equal((await manager.agentStatus(agent.id, true)).ready, true);

  await rm(runtimePath);
  const status = await manager.agentStatus(agent.id, true);
  assert.equal(status.ready, false);
  assert.equal(status.cli.state, 'invalid');
  assert.equal(status.cli.readinessIssue?.code, 'RUNTIME_PATH_MISSING');
});

test('resume of a custom-Runtime Session re-probes the stored path and never adopts the active generation', async () => {
  const pluginId = parseProxyPluginId('io.gian.fixture');
  const storedPath = '/tmp/custom-runtime';
  const generationPath = '/tmp/managed-generation-runtime';
  const digest = '2'.repeat(64);
  const binding: SessionProxyBinding = {
    schemaVersion: 1,
    pluginId,
    pluginVersion: '2.0.0',
    manifestSha256: digest,
    protocolVersion: '2.2',
    processScope: 'session',
    runtimeProfile: {
      id: 'runtime-profile-custom',
      agentId: 'agent-custom',
      pluginId,
      runtimeId: 'fixture-runtime',
      path: storedPath,
      version: '9.9.9',
      configHome: '/tmp/custom-home',
      contentFingerprint: 'fingerprint-custom',
      verifiedVersions: ['9.9.9'],
      verification: 'verified',
    },
  };
  const active: ManagedRuntimeGeneration = {
    schemaVersion: 1,
    generationId: 'current-generation',
    pluginId,
    platform: 'darwin-arm64',
    proxy: {
      pluginVersion: '2.0.0', manifestSha256: digest,
      artifactSha256: '3'.repeat(64), entryPath: '/tmp/current-proxy.mjs',
      processScope: 'session', protocolRange: '>=2.2 <3.0',
    },
    runtime: {
      runtimeId: 'fixture-runtime', version: '2.0.0', artifactSha256: '4'.repeat(64),
      entryPath: generationPath, ownership: 'managed',
    },
    companions: [], certificate: { id: 'certificate', sha256: '5'.repeat(64) },
    state: 'active', installedAt: '2026-09-01T00:00:00.000Z', activatedAt: '2026-09-02T00:00:00.000Z',
  };
  const launch = {
    pluginId,
    pluginVersion: '3.0.0',
    manifestSha256: digest,
    protocolRange: '>=2.2 <3.0',
    entryPath: '/tmp/current-proxy.mjs',
    processScope: 'session' as const,
    schemaVersion: 4 as const,
    source: 'github-release' as const,
    runtime: {
      kind: 'external' as const,
      id: 'fixture-runtime',
      displayName: 'Fixture Runtime',
      verifiedVersions: ['1.0.0'],
    },
  };
  const runtimePaths: Array<string | null> = [];
  const planner = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveActiveGeneration: async () => active,
    resolveExact: async () => { throw new Error('Must not load the managed generation Proxy for a custom Runtime'); },
    agentHasCustomRuntime: agentId => agentId === 'agent-custom',
    runtimeResolver: {
      resolve: async (input: { agentId: string; selectedPath: string | null }) => {
        runtimePaths.push(input.selectedPath);
        return {
          profile: { ...binding.runtimeProfile!, agentId: input.agentId },
          lease: {
            binaryPath: storedPath, version: '9.9.9', source: 'override' as const,
            env: Object.freeze({}), release: async () => {},
          },
        };
      },
    } as unknown as RuntimeResolver,
  });

  const prepared = await planner.prepareResume(binding);
  assert.deepEqual(runtimePaths, [storedPath]);
  assert.equal(prepared.sessionBinding.pluginVersion, '3.0.0');
  const lease = await prepared.acquireLease();
  assert.equal(lease?.binaryPath, storedPath);
  await prepared.releaseUnusedLease();

  // A historical identity repair leaves the saved Runtime owner id intact.
  // The missing owner must keep the same path and current trusted Proxy too.
  const deletedOwner = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveActiveGeneration: async () => active,
    resolveExact: async () => { throw new Error('Deleted owner must not select a managed generation'); },
    agentHasCustomRuntime: () => undefined,
    runtimeResolver: {
      resolve: async (input: { agentId: string; selectedPath: string | null }) => {
        assert.equal(input.selectedPath, storedPath);
        return { profile: binding.runtimeProfile!, lease: {
          binaryPath: storedPath, version: '9.9.9', source: 'override',
          env: Object.freeze({}), release: async () => {},
        } };
      },
    } as unknown as RuntimeResolver,
  });
  const restored = await deletedOwner.prepareResume(binding);
  assert.equal(restored.sessionBinding.pluginVersion, '3.0.0');
  await restored.releaseUnusedLease();

  const managed = new SessionBindingPlanner({
    resolveCurrent: async () => { throw new Error('Managed sessions must use the certified generation'); },
    resolveActiveGeneration: async () => active,
    resolveExact: async () => ({ ...launch, pluginVersion: active.proxy.pluginVersion }),
    agentHasCustomRuntime: () => false,
    runtimeResolver: {
      resolve: async (input: { selectedPath: string | null }) => {
        assert.equal(input.selectedPath, generationPath);
        return { profile: { ...binding.runtimeProfile!, path: generationPath }, lease: {
          binaryPath: generationPath, version: '2.0.0', source: 'managed',
          env: Object.freeze({}), release: async () => {},
        } };
      },
    } as unknown as RuntimeResolver,
  });
  const managedResume = await managed.prepareResume(binding);
  assert.equal(managedResume.sessionBinding.pluginVersion, active.proxy.pluginVersion);
  await managedResume.releaseUnusedLease();

  const failing = new SessionBindingPlanner({
    resolveCurrent: async () => launch,
    resolveActiveGeneration: async () => active,
    resolveExact: async () => launch,
    agentHasCustomRuntime: () => true,
    runtimeResolver: {
      resolve: async () => ({
        profile: binding.runtimeProfile!,
        lease: null,
        readinessIssue: {
          code: 'RUNTIME_PATH_MISSING',
          message: 'The custom Runtime path no longer exists.',
          repairable: false,
        },
      }),
    } as unknown as RuntimeResolver,
  });
  await assert.rejects(
    () => failing.prepareResume(binding),
    (error: unknown) => error instanceof Error && 'code' in error
      && error.code === 'RUNTIME_PATH_MISSING',
  );
});

test('unmanaged catalog status stays ready from the custom Runtime probe and fail-closes invalidation', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-custom-catalog-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = await fakeOfficialProxy(root, 'claude', 'Claude Code', '0.2.4');
  const runtimePath = join(root, 'bin', 'claude-company');
  await executable(runtimePath, 'claude 2.1.159');
  const readinessCache = new RuntimeReadinessCache();
  const resolver = testResolver(root);
  let probes = 0;
  const resolve = resolver.resolve.bind(resolver);
  resolver.resolve = async (input) => {
    probes += 1;
    return resolve(input);
  };
  const manager = await AgentManager.create({
    allowCreateWithoutCatalog: true,
    dataDir: join(root, 'data'),
    releaseVersion: '0.6.5',
    managedProxies: false,
    developmentProxyEntries: { claude: proxyEntry },
    runtimeResolver: resolver,
    readinessCache,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = await manager.createAgent({
    name: 'Catalog Custom',
    pluginId: 'claude',
    home: { kind: 'managed' },
    runtime: { kind: 'custom', path: runtimePath },
  });
  assert.equal(agent.cliPath, null);
  assert.deepEqual(agent.runtime, { kind: 'custom', path: runtimePath });
  const probed = probes;
  assert.ok(probed >= 1);

  const status = await manager.agentStatus(agent.id);
  assert.equal(probes, probed);
  assert.equal(status.ready, true);
  assert.equal(status.cli.path, runtimePath);
  assert.equal(status.cli.source, 'override');
  assert.equal(status.runtimeProfile?.path, runtimePath);
  assert.equal(status.runtimeProfile?.agentId, agent.id);

  const refreshed = await manager.agentStatus(agent.id, true);
  assert.equal(probes, probed);
  assert.equal(refreshed.ready, true);
  assert.equal(refreshed.cli.path, runtimePath);
  assert.equal(refreshed.runtimeProfile?.path, runtimePath);

  readinessCache.invalidate('claude', '0.2.4', runtimePath);
  const invalidated = await manager.agentStatus(agent.id, true);
  assert.equal(probes, probed);
  assert.equal(invalidated.ready, false);
  assert.equal(invalidated.cli.readinessIssue?.code, 'RUNTIME_MUTATED');
  assert.equal(invalidated.cli.path, runtimePath);
});
