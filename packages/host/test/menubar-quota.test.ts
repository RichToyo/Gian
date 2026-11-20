import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isOfficialQuotaSnapshot, parseProxyPluginId } from '@gian/shared';
import { OFFICIAL_QUOTA_INTERVAL_MS, OfficialQuotaService, QuotaReadError, type OfficialQuotaBinding } from '../src/agents/official-quota.js';
import { menubarQuotaBindings } from '../src/agents/menubar-quota-bindings.js';
import { createOfficialQuotaService, OfficialQuotaReader } from '../src/agents/official-quota-reader.js';
import { inspectionProfileMatches, type InspectionHostOptions, type ProxyManager } from '../src/proxy/manager.js';
import { prepareInspectionLaunch } from '../src/proxy/inspection-launch.js';
import { SessionBindingPlanner } from '../src/session/binding-planner.js';
import type { RuntimeResolver } from '../src/runtime/resolver.js';
import type { RuntimeLease } from '../src/runtime/types.js';
import { CatalogService } from '../src/catalog/service.js';
import type { TrustedLaunch } from '../src/runtime/trusted-launch.js';
import type { ManagedRuntimeGeneration, OpenRuntimeProfile, ProxyCatalogItem, UserAgent, UserAgentStatus } from '@gian/shared';

const data = { windows: [{ id: 'actual-window', label: '5h', usedRatio: 1, resetAt: 10_000, windowDurationMinutes: 300 }], balances: [] };
const binding = (read: OfficialQuotaBinding['read'], extra: Partial<OfficialQuotaBinding> = {}): OfficialQuotaBinding => ({
  agentId: 'a1', pluginId: 'codex', label: 'Codex', scopeKey: 'scope-1', installed: true, firstParty: true, eligibility: 'eligible', read, ...extra,
});

describe('inspection launch identity domains (real binding planner, synthetic Runtime)', () => {
  function fixture(id = 'codex', managedGeneration = false) {
    const pluginId = parseProxyPluginId(id);
    const agent: UserAgent = { id: 'saved-agent', name: 'Fixture', pluginId, proxy: null,
      cliPath: null, home: { kind: 'custom', path: '/fixture/account' },
      defaults: { model: '', thinking: '', mode: '', options: {} } };
    const profile: OpenRuntimeProfile = { id: 'installation-profile', agentId: agent.id, pluginId,
      runtimeId: id, path: '/fixture/runtime', version: '1.0.0', configHome: agent.home!.path,
      contentFingerprint: 'archive-digest', verifiedVersions: ['1.0.0'], verification: 'verified' };
    const launch: TrustedLaunch = { pluginId, pluginVersion: '0.1.0-Dev', manifestSha256: 'a'.repeat(64),
      protocolRange: '>=2.2 <3.0', entryPath: '/fixture/proxy.mjs', processScope: 'shared', schemaVersion: 4,
      source: managedGeneration ? 'official-managed' : 'official-development',
      runtime: { kind: 'external', id, verifiedVersions: ['1.0.0'] } };
    const status: UserAgentStatus = { ...agent, proxyName: 'Fixture', ready: true,
      cli: { state: 'ready', path: profile.path, version: profile.version, source: 'managed' },
      plugin: { state: 'ready', version: launch.pluginVersion, path: launch.entryPath,
        source: managedGeneration ? 'github-release' : 'development', defaults: agent.defaults },
      runtimeProfile: profile, officialInstallUrl: '' };
    const resolved: OpenRuntimeProfile = { ...profile, id: 'resolved-profile',
      contentFingerprint: 'live-content-digest', configHome: '/fixture/default-home' };
    const generation: ManagedRuntimeGeneration = { schemaVersion: 1, generationId: 'active-generation', pluginId,
      platform: 'darwin-arm64', state: 'active', installedAt: '2026-10-25T00:00:00Z', activatedAt: '2026-10-25T00:00:00Z',
      proxy: { ...launch, artifactSha256: 'b'.repeat(64) },
      runtime: { runtimeId: id, version: '1.0.0', artifactSha256: profile.contentFingerprint!,
        entryPath: profile.path!, ownership: 'managed' },
      companions: [], certificate: { id: 'fixture-certificate', sha256: 'c'.repeat(64) } };
    let released = 0;
    let resolutions = 0;
    let duringResolve = () => {};
    let statusReads = 0;
    let afterStatus = (_read: number) => {};
    const planner = new SessionBindingPlanner({
      resolveCurrent: async () => launch,
      resolveExact: async () => launch,
      resolveActiveGeneration: async () => managedGeneration ? generation : null,
      runtimeResolver: { resolve: async () => {
        resolutions++;
        duringResolve();
        const lease: RuntimeLease = { binaryPath: resolved.path!, version: resolved.version!, source: 'managed',
          env: {}, release: async () => { released++; } };
        return { profile: structuredClone(resolved), lease };
      } } as unknown as RuntimeResolver,
    });
    const agents = {
      getAgent: () => agent,
      agentStatus: async () => { afterStatus(++statusReads); return status; },
    };
    const options = { agentId: agent.id, proxyVersion: launch.pluginVersion, runtimeProfileId: profile.id,
      cliPath: profile.path, configHome: profile.configHome, cliFingerprint: profile.contentFingerprint };
    return { agent, profile, status, resolved, launch, options, planner, agents,
      prepare: () => prepareInspectionLaunch(pluginId, options, { agents, planner }),
      duringResolve: (fn: () => void) => { duringResolve = fn; },
      afterStatus: (fn: (read: number) => void) => { afterStatus = fn; },
      counts: () => ({ released, resolutions }) };
  }

  for (const pluginId of ['codex', 'kimi', 'ai.deepseek.harness', 'grok', 'claude', 'io.gian.antigravity']) {
    for (const managed of [false, true]) {
      it(`${pluginId}: ${managed ? 'active generation' : 'GianDev installation'} reaches quota RPC despite different identity hashes`, async () => {
        const f = fixture(pluginId, managed);
        let calls = 0;
        const reader = new OfficialQuotaReader({ resolveAgent: async () => f.status,
          manager: { acquireInspectionHost: async (plugin: string, options: InspectionHostOptions = {}) => {
            // Exercise the same resolver as createApp instead of bypassing it.
            const prepared = await prepareInspectionLaunch(plugin, options, f);
            assert.notEqual(prepared.binding.runtimeProfile?.identity, f.profile.id);
            const lease = await prepared.acquireLease();
            assert.ok(lease);
            assert.ok(Object.values(lease.env).includes(f.agent.home!.path));
            return { shared: true, release: () => lease.release(), host: {
              initialize: async () => ({ capabilities: { 'account.quota.read': 1 } }),
              request: async (method: string) => {
                assert.equal(method, 'account.quota.read');
                calls++;
                return { ...data, status: 'ready', error: null,
                  authRevision: pluginId === 'io.gian.antigravity' ? null : 'a'.repeat(64),
                  ...(pluginId === 'io.gian.antigravity' ? { source: 'cli' } : {}) };
              },
            } };
          } } as unknown as Pick<ProxyManager, 'acquireInspectionHost'>,
        });
        assert.equal((await reader.read(f.agent, new AbortController().signal)).status, 'ready');
        assert.equal(calls, 1);
        assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
      });
    }
  }

  it('rejects stale installation identity before preparing a launch', async () => {
    const f = fixture();
    f.profile.id = 'new-installation';
    await assert.rejects(f.prepare(), /binding changed/);
    assert.deepEqual(f.counts(), { resolutions: 0, released: 0 });
  });

  it('rejects a profile belonging to another Agent before preparing a launch', async () => {
    const f = fixture();
    f.profile.agentId = 'another-agent';
    await assert.rejects(f.prepare(), /binding changed/);
    assert.deepEqual(f.counts(), { resolutions: 0, released: 0 });
  });

  it('rejects a status HOME that does not match the actual Agent HOME', async () => {
    const f = fixture();
    f.profile.configHome = f.options.configHome = '/fixture/other-account';
    await assert.rejects(f.prepare(), /binding changed/);
    assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
  });

  for (const change of ['home', 'runtime', 'plugin', 'defaults', 'profile', 'digest', 'proxy'] as const) {
    it(`rejects a ${change} change during preparation and releases its unused lease`, async () => {
      const f = fixture();
      f.duringResolve(() => {
        if (change === 'home') f.agent.home!.path = '/fixture/another-account';
        if (change === 'runtime') f.agent.runtime = { kind: 'custom', path: '/fixture/other-runtime' };
        if (change === 'plugin') f.agent.pluginId = parseProxyPluginId('kimi');
        if (change === 'defaults') f.agent.defaults.options.provider = 'other-provider';
        if (change === 'profile') f.profile.id = 'new-installation';
        if (change === 'digest') f.profile.contentFingerprint = 'other-archive';
        if (change === 'proxy') f.status.plugin.version = '0.2.0';
      });
      await assert.rejects(f.prepare(), /binding changed/);
      assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
    });
  }

  it('rechecks Agent selection after the final asynchronous status read', async () => {
    const f = fixture();
    f.afterStatus(read => { if (read === 2) f.agent.home!.path = '/fixture/another-account'; });
    await assert.rejects(f.prepare(), /binding changed/);
    assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
  });

  it('releases the lease when the Agent is deleted during resolution', async () => {
    const f = fixture();
    f.duringResolve(() => { f.agents.getAgent = () => { throw new Error('agent not found'); }; });
    await assert.rejects(f.prepare(), /agent not found/);
    assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
  });

  for (const change of ['path', 'version', 'runtimeId', 'verification', 'proxyVersion'] as const) {
    it(`still rejects a resolved ${change} mismatch`, async () => {
      const f = fixture();
      if (change === 'path') f.resolved.path = '/fixture/other-runtime';
      if (change === 'version') f.resolved.version = '2.0.0';
      if (change === 'runtimeId') f.resolved.runtimeId = 'other-runtime';
      if (change === 'verification') f.resolved.verification = 'incompatible';
      if (change === 'proxyVersion') f.launch.pluginVersion = '0.2.0';
      await assert.rejects(f.prepare(), /binding changed|path drifted|incompatible/);
      assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
    });
  }

  it('preserves live-content fingerprint checks for custom/probed Runtimes', async () => {
    const f = fixture();
    f.status.cli.source = 'override';
    f.agent.runtime = { kind: 'custom', path: f.profile.path! };
    await assert.rejects(f.prepare(), /binding changed/);
    assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
  });

  it('allows a matching custom Runtime after the planner scopes its profile ID to HOME', async () => {
    const f = fixture();
    f.status.cli.source = 'override';
    f.agent.runtime = { kind: 'custom', path: f.profile.path! };
    f.resolved.contentFingerprint = f.profile.contentFingerprint;
    const prepared = await f.prepare();
    await prepared.releaseUnusedLease();
    assert.deepEqual(f.counts(), { resolutions: 1, released: 1 });
  });
});

describe('production quota wiring with an installed saved Agent (no Provider)', () => {
  it('lists installed candidates through the real Catalog without touching Runtime integrity or account reads', async () => {
    const pluginIds = ['codex', 'kimi', 'io.gian.antigravity'];
    const launches: TrustedLaunch[] = pluginIds.map(pluginId => ({ pluginId, pluginVersion: '0.1.0-Dev',
      manifestSha256: 'a'.repeat(64), protocolRange: '>=2.2 <3.0', entryPath: `/fixture/${pluginId}/proxy.mjs`,
      processScope: 'shared', schemaVersion: 4, source: 'official-development', runtime: { kind: 'external', id: pluginId } }));
    let runtimeReads = 0;
    const catalog = new CatalogService({
      developmentProxies: async () => launches,
      developmentRuntime: async () => { runtimeReads++; throw new Error('Runtime tree inspection must not block listing'); },
      store: { snapshot: () => ({ index: null, files: null }) },
    } as unknown as ConstructorParameters<typeof CatalogService>[0]);
    const agents = pluginIds.map(pluginId => ({ id: `saved-${pluginId}`, pluginId, name: pluginId,
      cliPath: null, defaults: { model: '', thinking: '', mode: '', options: {} } } as UserAgent));
    const service = createOfficialQuotaService({
      manager: { acquireInspectionHost: async () => { throw new Error('must not launch'); } },
      agents: { listAgents: () => agents, agentStatus: async () => { throw new Error('must not inspect account'); } },
      catalog: async () => (await catalog.listLocal()).items,
    });
    const snapshot = await service.snapshot();
    assert.equal(isOfficialQuotaSnapshot(snapshot), true);
    assert.deepEqual(snapshot.accounts.map(item => item.pluginId), pluginIds);
    assert.equal(snapshot.accounts.every(item => item.status === 'unverified'), true);
    assert.equal(runtimeReads, 0);
    const key = snapshot.accounts[0]!.accountKey;
    launches[0]!.manifestSha256 = 'b'.repeat(64);
    assert.notEqual((await service.snapshot()).accounts[0]!.accountKey, key);
  });

  it('local installation metadata does not turn quarantined packages into trusted official candidates', async () => {
    const catalog = new CatalogService({
      store: { snapshot: () => ({ index: null }) },
      plugins: { listInstalled: async () => [
        { pluginId: 'codex', currentVersion: '2', currentPointer: 'valid', versions: [
          { version: '1', state: 'valid', receipt: { sourceId: 'gian-official' } },
          { version: '2', state: 'valid', receipt: { sourceId: 'custom', manifestSha256: 'a'.repeat(64) } },
        ] },
        { pluginId: 'kimi', currentVersion: '1', currentPointer: 'unmanaged', versions: [
          { version: '1', state: 'valid', receipt: { sourceId: 'gian-official' } },
        ] },
      ] },
      managedRuntimeStatus: async () => { throw new Error('must not inspect Runtime'); },
    } as unknown as ConstructorParameters<typeof CatalogService>[0]);
    const local = await catalog.listLocal();
    assert.equal(local.items[0]?.installation.source, 'custom');
    assert.equal(local.items[1]?.installation.state, 'quarantined');
  });
  const liveData = { ...data, windows: data.windows.map(window => ({ ...window, resetAt: null })) };
  it('rejects a changed Runtime/HOME before an inspection process can be borrowed', () => {
    const profile = { id: 'profile-a', path: '/isolated/bin/codex', configHome: '/isolated/home-a', contentFingerprint: 'fingerprint-a' } as OpenRuntimeProfile;
    const expected = { runtimeProfileId: profile.id, cliPath: profile.path, configHome: profile.configHome, cliFingerprint: profile.contentFingerprint };
    assert.equal(inspectionProfileMatches(expected, profile), true);
    assert.equal(inspectionProfileMatches(expected, { ...profile, configHome: '/isolated/home-b' }), false);
    assert.equal(inspectionProfileMatches(expected, { ...profile, id: 'profile-b' }), false);
    assert.equal(inspectionProfileMatches(expected, { ...profile, contentFingerprint: 'changed' }), false);
  });
  function fixture(capability = true, pluginId = 'codex') {
    const agent = { id: 'saved-codex', name: 'My Agent', pluginId, proxy: pluginId, cliPath: null,
      home: { kind: 'custom', path: '/isolated/codex' }, defaults: { model: '', thinking: '', mode: '', options: {} } } as UserAgent;
    const status = { ...agent, ready: true, plugin: { version: '0.3.8-Dev' },
      runtimeProfile: { id: 'profile', path: '/isolated/bin/codex', configHome: '/isolated/codex',
        version: '0.163.0', contentFingerprint: 'c'.repeat(64), verification: 'verified' } } as UserAgentStatus;
    const item = { pluginId, installation: { state: 'installed', source: 'giandev', installedVersion: '0.3.8-Dev' },
      runtime: { path: '/isolated/bin/codex', version: 'fixture' } } as ProxyCatalogItem;
    let acquired = 0;
    let released = 0;
    const calls: Array<{ method: string; params: unknown }> = [];
    let result: unknown = { status: 'ready', authRevision: pluginId === 'io.gian.antigravity' ? null : 'a'.repeat(64),
      ...(pluginId === 'io.gian.antigravity' ? { source: 'cli' } : {}), error: null, ...liveData };
    const manager = { acquireInspectionHost: async (plugin: string, options: unknown) => {
      acquired++;
      assert.equal(plugin, pluginId);
      assert.equal((options as { configHome: string }).configHome, '/isolated/codex');
      return { shared: true, release: async () => { released++; }, host: {
        initialize: async () => ({ protocol: { version: '2.3' }, capabilities: capability ? { 'account.quota.read': 1 } : {} }),
        request: async (method: string, params: unknown) => { calls.push({ method, params }); return result; },
      } };
    } } as unknown as Pick<ProxyManager, 'acquireInspectionHost'>;
    const service = createOfficialQuotaService({ manager,
      agents: { listAgents: () => [agent], agentStatus: async () => status }, catalog: async () => [item],
    });
    return { service, calls, counters: () => [acquired, released], setResult: (next: unknown) => { result = next; } };
  }
  it('lists an unverified candidate without spawning, then reaches the actual account RPC on refresh', async () => {
    const f = fixture();
    const local = await f.service.snapshot();
    assert.equal(local.accounts[0]?.status, 'unverified');
    assert.deepEqual(f.counters(), [0, 0]);
    const refreshed = await f.service.refresh('saved-codex');
    assert.equal(refreshed.accounts[0]?.status, 'ready');
    assert.equal(refreshed.accounts[0]?.windows[0]?.usedRatio, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.method, 'account.quota.read');
    const params = f.calls[0]?.params as { model: null; provider: null; identityNonce: string };
    assert.equal(params.model, null);
    assert.equal(params.provider, null);
    assert.match(params.identityNonce, /^[a-f0-9]{64}$/u);
    assert.deepEqual(f.counters(), [1, 1]);
    assert.equal(JSON.stringify(refreshed).includes('/isolated'), false);
  });
  it('shows unsupported capability explicitly and never sends an unadvertised RPC', async () => {
    const f = fixture(false);
    assert.equal((await f.service.refresh('saved-codex')).accounts[0]?.status, 'unsupported');
    assert.equal(f.calls.length, 0);
    assert.deepEqual(f.counters(), [1, 1]);
  });
  it('production composition routes all six implemented readers through the exact inspection binding', async () => {
    for (const pluginId of ['codex', 'kimi', 'ai.deepseek.harness', 'grok', 'claude', 'io.gian.antigravity']) {
      const f = fixture(true, pluginId);
      const result = await f.service.refresh('saved-codex');
      assert.equal(result.accounts[0]?.pluginId, pluginId);
      assert.equal(result.accounts[0]?.status, 'ready');
      assert.equal(result.accounts[0]?.source, pluginId === 'io.gian.antigravity' ? 'cli' : undefined);
      assert.equal(f.calls[0]?.method, 'account.quota.read');
      assert.deepEqual(f.counters(), [1, 1]);
    }
  });
  it('does not start Runtimes whose account reader is not implemented', async () => {
    const reader = new OfficialQuotaReader({
      manager: { acquireInspectionHost: async () => { throw Error('must not start'); } },
      resolveAgent: async () => { throw Error('must not probe'); },
    });
    for (const pluginId of ['com.zhipu.zcode']) {
      const result = await reader.read({ pluginId } as UserAgent, new AbortController().signal);
      assert.equal(result.status, 'unsupported');
    }
  });
  it('labels CLI snapshots before querying and never retains an unidentifiable prior CLI account on failure', async () => {
    const f = fixture(true, 'io.gian.antigravity');
    assert.equal((await f.service.snapshot()).accounts[0]?.source, 'cli');
    assert.equal((await f.service.refresh('saved-codex')).accounts[0]?.status, 'ready');
    f.setResult({ status: 'error', source: 'cli', authRevision: null, error: 'unavailable', windows: [], balances: [] });
    const result = (await f.service.refresh('saved-codex')).accounts[0];
    assert.equal(result?.status, 'error');
    assert.deepEqual(result?.windows, []);
    assert.equal(result?.fetchedAt, null);
    assert.equal(result?.source, 'cli');
  });
  it('does not let a Runtime reader bypass identity qualification by claiming CLI data', async () => {
    const f = fixture();
    f.setResult({ status: 'ready', source: 'cli', authRevision: null, error: null, ...liveData });
    const result = (await f.service.refresh('saved-codex')).accounts[0];
    assert.equal(result?.error, 'invalid_response');
    assert.deepEqual(result?.windows, []);
  });
  it('distinguishes missing Gian implementation from a native unsupported capability', async () => {
    const agent = { id: 'zcode', pluginId: 'com.zhipu.zcode', name: 'ZCode', defaults: {} } as UserAgent;
    const service = createOfficialQuotaService({
      manager: { acquireInspectionHost: async () => { throw Error('must not start'); } },
      agents: { listAgents: () => [agent], agentStatus: async () => { throw Error('must not probe'); } },
      catalog: async () => [{ pluginId: agent.pluginId, installation: { state: 'installed', source: 'giandev' }, runtime: {} } as ProxyCatalogItem],
    });
    const before = await service.snapshot();
    assert.equal(before.accounts[0]?.status, 'not_implemented');
    assert.equal(isOfficialQuotaSnapshot(before), true);
    assert.deepEqual((await service.refresh(agent.id)).accounts, before.accounts);
  });
  it('excludes proven third-party configuration rather than rendering an official balance', async () => {
    const f = fixture();
    f.setResult({ status: 'excluded', authRevision: null, error: null, windows: [], balances: [] });
    assert.deepEqual((await f.service.refresh('saved-codex')).accounts, []);
  });
  it('can retry after native login and drops old data when a different account fails', async () => {
    const f = fixture();
    f.setResult({ status: 'auth_required', authRevision: null, error: null, windows: [], balances: [] });
    assert.equal((await f.service.refresh('saved-codex')).accounts[0]?.status, 'auth_required');
    f.setResult({ status: 'ready', authRevision: 'a'.repeat(64), error: null, ...liveData });
    assert.equal((await f.service.refresh('saved-codex')).accounts[0]?.status, 'ready');
    f.setResult({ status: 'error', authRevision: 'b'.repeat(64), error: 'unavailable', windows: [], balances: [] });
    const changed = await f.service.refresh('saved-codex');
    assert.deepEqual(changed.accounts[0]?.windows, []);
    assert.equal(changed.accounts[0]?.status, 'error');
    assert.deepEqual(f.counters(), [3, 3]);
  });
});

describe('menubar official quota orchestration (synthetic, no Provider)', () => {
  it('bounds the entire refresh including queued time and never launches an expired waiter', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let reads = 0;
    let hang = true;
    const bindings = Array.from({ length: 5 }, (_, index) => binding(async () => {
      reads++;
      if (hang) return new Promise<never>(() => {});
      return { windows: data.windows.map(window => ({ ...window, resetAt: null })), balances: [] };
    }, { agentId: `agent-${index}`, scopeKey: `scope-${index}` }));
    let now = 0;
    const service = new OfficialQuotaService(async () => bindings, () => now, 100);
    const pending = bindings.map(item => service.refresh(item.agentId));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(reads, 2);
    t.mock.timers.tick(100);
    await new Promise<void>(resolve => setImmediate(resolve));
    const snapshot = await service.snapshot();
    assert.equal(snapshot.accounts.filter(item => item.error === 'timeout').length, 5);
    assert.equal(reads, 2, 'queued requests must not start after their deadline');
    await Promise.all(pending);
    hang = false;
    now = 30_000;
    assert.equal((await service.refresh('agent-4')).accounts[4]?.status, 'ready', 'expired waiters must not leak a query slot');
  });
  it('cache reads and ineligible/uninstalled/third-party rows make zero external calls', async () => {
    let calls = 0;
    const service = new OfficialQuotaService(async () => [binding(async () => { calls++; return data; }),
      binding(undefined, { agentId: 'missing', installed: false }), binding(undefined, { agentId: 'third-party', firstParty: false }),
      binding(undefined, { agentId: 'unsupported', scopeKey: 'u', eligibility: 'unsupported' }),
      binding(undefined, { agentId: 'auth', scopeKey: 'auth', eligibility: 'auth_required' })]);
    assert.equal((await service.snapshot()).accounts.length, 3);
    await service.refresh('unsupported'); await service.refresh('auth'); await service.refresh('missing');
    assert.equal(calls, 0);
  });
  it('single-flights simultaneous requests but manual refresh bypasses a fresh cache', async () => {
    let now = 100;
    let calls = 0;
    let finish!: (value: typeof data) => void;
    const service = new OfficialQuotaService(async () => [binding(() => { calls++; return new Promise(resolve => { finish = resolve; }); })], () => now);
    const first = service.refresh('a1');
    const second = service.refresh('a1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    finish(data);
    await Promise.all([first, second]);
    const ready = await service.snapshot();
    assert.equal(ready.accounts[0]?.status, 'ready');
    assert.equal(ready.accounts[0]?.windows[0]?.usedRatio, 1);
    assert.equal(isOfficialQuotaSnapshot(ready), true);
    await service.snapshot(); assert.equal(calls, 1);
    const manual = service.refresh('a1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 2);
    finish(data);
    await manual;
    now = 10_000;
    assert.equal((await service.snapshot()).accounts[0]?.freshness, 'stale');
  });
  it('preserves stale success, respects rate limits, and permits manual recovery after sign-in', async () => {
    let now = 100;
    let calls = 0;
    let failure: QuotaReadError | null = null;
    let currentData = data;
    const service = new OfficialQuotaService(async () => [binding(async () => { calls++; if (failure) throw failure; return currentData; })], () => now);
    await service.refresh('a1');
    now = 10_000;
    failure = new QuotaReadError('rate_limited', 60_000);
    const stale = await service.refresh('a1');
    assert.equal(stale.accounts[0]?.status, 'stale');
    assert.equal(stale.accounts[0]?.fetchedAt, 100);
    assert.deepEqual(stale.accounts[0]?.windows, data.windows);
    await service.refresh('a1'); assert.equal(calls, 2);
    now = 70_001; failure = new QuotaReadError('auth_required');
    assert.equal((await service.refresh('a1')).accounts[0]?.status, 'auth_required');
    now += OFFICIAL_QUOTA_INTERVAL_MS;
    await service.refreshDue(); assert.equal(calls, 3, 'sign-in failures do not trigger background login attempts');
    failure = null;
    currentData = { ...data, windows: data.windows.map(window => ({
      ...window, usedRatio: 0.25, resetAt: now + window.windowDurationMinutes * 60_000,
    })) };
    const recovered = (await service.refresh('a1')).accounts[0];
    assert.equal(recovered?.status, 'ready');
    assert.equal(recovered?.freshness, 'fresh');
    assert.equal(recovered?.fetchedAt, now);
    assert.deepEqual(recovered?.windows, currentData.windows);
    assert.equal(calls, 4, 'manual refresh rechecks after native sign-in');
  });
  it('never publishes an uninstalled or switched binding late result', async () => {
    let finish!: (value: typeof data) => void;
    let current = binding(() => new Promise(resolve => { finish = resolve; }));
    const service = new OfficialQuotaService(async () => [current]);
    const inflight = service.refresh('a1');
    await new Promise(resolve => setImmediate(resolve));
    current = { ...current, scopeKey: 'new-account', installed: false };
    finish(data);
    assert.equal((await inflight).accounts.length, 0);
    current = { ...current, installed: true };
    const fresh = await service.snapshot();
    assert.equal(fresh.accounts[0]?.accountKey, 'new-account');
    assert.equal(fresh.accounts[0]?.fetchedAt, null);
  });
  it('bounds concurrency at two, rejects secret-bearing results and times out without retries', async () => {
    let active = 0;
    let maximum = 0;
    const finish: Array<() => void> = [];
    const list = ['1', '2', '3', '4'].map(id => binding(async () => {
      active++; maximum = Math.max(maximum, active);
      await new Promise<void>(resolve => finish.push(resolve)); active--; return data;
    }, { agentId: `a${id}`, scopeKey: `scope${id}` }));
    const service = new OfficialQuotaService(async () => list);
    const requests = list.map(item => service.refresh(item.agentId));
    for (let index = 0; index < 4; index++) {
      await new Promise(resolve => setImmediate(resolve));
      finish[index]!();
    }
    await Promise.all(requests);
    assert.equal(maximum, 2);
    const unsafe = new OfficialQuotaService(async () => [binding(async () => ({ ...data, token: 'must-not-leak' }))]);
    const rejected = await unsafe.refresh('a1');
    assert.equal(rejected.accounts[0]?.error, 'invalid_response');
    assert.equal(JSON.stringify(rejected).includes('must-not-leak'), false);
    let calls = 0;
    const timeout = new OfficialQuotaService(async () => [binding(async () => { calls++; return new Promise(() => {}); })], Date.now, 1);
    assert.equal((await timeout.refresh('a1')).accounts[0]?.error, 'timeout');
    await timeout.refreshDue(); assert.equal(calls, 1);
    await timeout.refresh('a1'); assert.equal(calls, 2);
  });
  it('polls each eligible account at most every 30 minutes independently of cache reads', async () => {
    let now = 100;
    let calls = 0;
    const fresh = { windows: data.windows.map(window => ({ ...window, resetAt: null })), balances: [] };
    const service = new OfficialQuotaService(async () => [binding(async () => { calls++; return fresh; })], () => now);
    assert.equal((await service.snapshot()).accounts[0]?.status, 'unverified');
    assert.equal(calls, 0);
    await service.refreshDue(); await service.refreshDue();
    assert.equal(calls, 1);
    now += OFFICIAL_QUOTA_INTERVAL_MS - 1;
    assert.equal((await service.snapshot()).accounts[0]?.freshness, 'fresh');
    await service.refreshDue(); assert.equal(calls, 1);
    now++;
    assert.equal((await service.snapshot()).accounts[0]?.freshness, 'stale');
    await service.refreshDue(); assert.equal(calls, 2);
    await service.refresh('a1'); assert.equal(calls, 3);
    await service.refreshDue(); assert.equal(calls, 3);
    await service.stop();
  });
  it('serializes background accounts and coalesces a manual request with the active account', async () => {
    let calls = 0;
    const finish: Array<() => void> = [];
    const list = ['1', '2', '3'].map(id => binding(async () => {
      calls++;
      await new Promise<void>(resolve => finish.push(resolve));
      return data;
    }, { agentId: id, scopeKey: id }));
    const service = new OfficialQuotaService(async () => list);
    const first = service.refreshDue();
    const second = service.refreshDue();
    await new Promise(resolve => setImmediate(resolve));
    const manual = service.refresh('1');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    for (let i = 0; i < 3; i++) {
      assert.equal(calls, i + 1);
      finish[i]!();
      await new Promise(resolve => setImmediate(resolve));
    }
    await Promise.all([first, second, manual]);
    assert.equal(calls, 3);
    await service.stop();
  });
  it('starts polling only when enabled and stops all future timer work', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let calls = 0;
    const service = new OfficialQuotaService(async () => [binding(async () => { calls++; return data; })]);
    t.mock.timers.tick(60_000);
    assert.equal(calls, 0);
    service.start(); service.start();
    t.mock.timers.tick(14_999);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 0);
    t.mock.timers.tick(1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    await service.stop();
    t.mock.timers.tick(OFFICIAL_QUOTA_INTERVAL_MS);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
  });
  it('aborts in-flight background work on shutdown without publishing an error or starting another account', async () => {
    let calls = 0;
    let cancelled = false;
    const service = new OfficialQuotaService(async () => ['1', '2'].map(id => binding(async signal => {
      calls++;
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => {
        cancelled = true; reject(signal.reason);
      }, { once: true }));
    }, { agentId: id, scopeKey: id })));
    const polling = service.refreshDue();
    await new Promise(resolve => setImmediate(resolve));
    await service.stop(); await polling;
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
    assert.equal((await service.snapshot()).accounts[0]?.error, null);
  });
  it('lists installed qualified configurations only and never invents a default-HOME binding', async () => {
    const base = { id: 'a', pluginId: 'codex', name: 'Codex', proxy: 'codex', cliPath: null,
      home: { kind: 'managed', path: '/isolated/home' }, defaults: { model: '', thinking: '', mode: '', options: {} } } as const;
    const options = { agents: [base], installed: new Set(['codex']), firstPartyPackages: new Set(['codex']) };
    assert.equal((await menubarQuotaBindings(options)).length, 0, 'managed HOME or Proxy brand is not proof of first-party configuration');
    assert.equal((await menubarQuotaBindings({ ...options, installed: new Set() })).length, 0);
    assert.equal((await menubarQuotaBindings({ ...options, agents: [{ ...base, home: { kind: 'custom', path: '/other/home' } }] })).length, 0);
    const adapters = new Map([['codex', { inspect: async () => ({ firstParty: true, authRevision: 'current-auth-epoch', eligibility: 'auth_required' as const }),
      read: async () => { throw new Error('must not query'); } }]]);
    const qualified = await menubarQuotaBindings({ ...options, adapters });
    assert.equal(qualified[0]?.eligibility, 'auth_required');
    assert.equal(qualified[0]?.read, undefined);
  });
});
