import type { UserAgent, UserAgentStatus } from '@gian/shared';
import { OFFICIAL_QUOTA_REFRESH_TIMEOUT_MS } from '@gian/shared';
import { randomBytes } from 'node:crypto';
import { isProxyOfficialQuotaReadResult, type ProxyOfficialQuotaReadResult } from '@gian/proxy-protocol';
import type { ProxyManager } from '../proxy/manager.js';
import { OfficialQuotaService, QuotaReadError } from './official-quota.js';
import { menubarQuotaBindings } from './menubar-quota-bindings.js';
import type { LocalProxyInstallation } from '../catalog/service.js';

const QUERYABLE_PLUGINS = new Set(['codex', 'kimi', 'ai.deepseek.harness', 'grok', 'claude', 'io.gian.antigravity']);
const CLI_ACCOUNT_PLUGINS = new Set(['io.gian.antigravity']);

const unsupported = (): ProxyOfficialQuotaReadResult => ({
  status: 'unsupported', authRevision: null, error: null, windows: [], balances: [],
});

/** Production composition, also exercised by the end-to-end fake RPC test. */
export function createOfficialQuotaService(options: {
  manager: Pick<ProxyManager, 'acquireInspectionHost'>;
  agents: { listAgents(): UserAgent[]; agentStatus(id: string, refresh?: boolean): Promise<UserAgentStatus> } | null;
  catalog: () => Promise<LocalProxyInstallation[]>;
}) {
  const reader = options.agents ? new OfficialQuotaReader({ manager: options.manager,
    resolveAgent: id => options.agents!.agentStatus(id, false) }) : null;
  return new OfficialQuotaService(async () => {
    const installed = (await options.catalog()).filter(item => item.installation.state === 'installed');
    return menubarQuotaBindings({ agents: options.agents?.listAgents() ?? [],
      installed: new Set(installed.map(item => item.pluginId)),
      firstPartyPackages: new Set(installed.filter(item => ['gian-official', 'giandev'].includes(item.installation.source ?? '')).map(item => item.pluginId)),
      packageRevision: id => {
        const item = installed.find(item => item.pluginId === id);
        return [item?.installation.installedVersion, item?.installation.source, item?.revision];
      },
      ...(reader ? { query: (agent: UserAgent, signal: AbortSignal) => reader.read(agent, signal),
        queryablePlugins: QUERYABLE_PLUGINS, cliAccountPlugins: CLI_ACCOUNT_PLUGINS } : {}),
    });
  }, Date.now, OFFICIAL_QUOTA_REFRESH_TIMEOUT_MS);
}

/** The Host never discovers credentials or calls a Provider URL. */
export class OfficialQuotaReader {
  private readonly identityNonce = randomBytes(32).toString('hex');
  constructor(private readonly options: {
    manager: Pick<ProxyManager, 'acquireInspectionHost'>;
    resolveAgent: (id: string) => Promise<UserAgentStatus>;
  }) {}

  async read(agent: UserAgent, signal: AbortSignal): Promise<ProxyOfficialQuotaReadResult> {
    signal.throwIfAborted();
    // Do not start an unrelated Runtime just to discover that its quota
    // reader is absent. Expand this matrix only with an implemented reader.
    if (!QUERYABLE_PLUGINS.has(agent.pluginId)) return unsupported();
    const status = await this.options.resolveAgent(agent.id);
    signal.throwIfAborted();
    const profile = status.runtimeProfile;
    const unavailable = () => ({ ...unsupported(), ...(CLI_ACCOUNT_PLUGINS.has(agent.pluginId) ? { source: 'cli' as const } : {}) });
    if (!status.ready || status.pluginId !== agent.pluginId || !profile?.configHome
      || !profile.path || !profile.version || !profile.contentFingerprint
      || profile.verification !== 'verified' || !status.plugin.version) return unavailable();
    const handle = await this.options.manager.acquireInspectionHost(agent.pluginId, {
      agentId: agent.id, cliPath: profile.path, proxyVersion: status.plugin.version,
      runtimeProfileId: profile.id, configHome: profile.configHome,
      cliFingerprint: profile.contentFingerprint,
    });
    try {
      signal.throwIfAborted();
      const init = await handle.host.initialize();
      signal.throwIfAborted();
      if (init.capabilities['account.quota.read'] !== 1) return unavailable();
      const value = await handle.host.request('account.quota.read', {
        model: agent.defaults.model || null,
        provider: typeof agent.defaults.options.provider === 'string' ? agent.defaults.options.provider : null,
        identityNonce: this.identityNonce,
      }, { timeoutMs: 28_000 });
      signal.throwIfAborted();
      if (!isProxyOfficialQuotaReadResult(value)) throw new QuotaReadError('invalid_response');
      return value;
    } finally {
      await handle.release();
    }
  }
}
