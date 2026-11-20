import type { UserAgent } from '@gian/shared';
import type { OfficialQuotaBinding } from './official-quota.js';
import { usageKey } from '../usage/recorder.js';

/** Explicit qualification, not a guess based on CLI brand. Until a Proxy
 * provides a stable official auth generation, it must remain unavailable. */
export interface QualifiedQuotaAdapter {
  inspect(agent: UserAgent): Promise<{
    firstParty: boolean;
    authRevision: string;
    eligibility: OfficialQuotaBinding['eligibility'];
  }>;
  read(agent: UserAgent, signal: AbortSignal): ReturnType<NonNullable<OfficialQuotaBinding['read']>>;
}

export async function menubarQuotaBindings(options: {
  agents: UserAgent[];
  installed: ReadonlySet<string>;
  /** Trusted first-party packages, never the entire installable Catalog. */
  firstPartyPackages: ReadonlySet<string>;
  adapters?: ReadonlyMap<string, QualifiedQuotaAdapter>;
  /** Exact, controlled inspection RPC. No invocation occurs during listing. */
  query?: (agent: UserAgent, signal: AbortSignal) => ReturnType<NonNullable<OfficialQuotaBinding['read']>>;
  queryablePlugins?: ReadonlySet<string>;
  cliAccountPlugins?: ReadonlySet<string>;
  packageRevision?: (pluginId: string) => unknown;
}): Promise<OfficialQuotaBinding[]> {
  const bindings: OfficialQuotaBinding[] = [];
  for (const agent of options.agents) {
    if (!options.installed.has(agent.pluginId) || !options.firstPartyPackages.has(agent.pluginId)) continue;
    if (options.query) {
      const snapshot = structuredClone(agent);
      const implemented = !options.queryablePlugins || options.queryablePlugins.has(agent.pluginId);
      bindings.push({ agentId: agent.id, pluginId: agent.pluginId, label: agent.name,
        ...(options.cliAccountPlugins?.has(agent.pluginId) ? { source: 'cli' as const } : {}),
        scopeKey: usageKey('official-quota-query-v1', agent.id, agent.pluginId, agent.home ?? null,
          agent.runtime ?? null, agent.cliPath, agent.defaults, options.packageRevision?.(agent.pluginId) ?? null),
        installed: true, firstParty: null, eligibility: implemented ? 'unverified' : 'not_implemented',
        ...(implemented ? { read: (signal: AbortSignal) => options.query!(snapshot, signal) } : {}),
      });
      continue;
    }
    // Custom runtimes/configurations cannot inherit official-account status
    // from their Proxy's brand. Qualification must positively identify them.
    const adapter = options.adapters?.get(agent.pluginId);
    const identity = adapter ? await adapter.inspect(agent) : null;
    // Even a managed HOME can contain a third-party provider configuration.
    // Missing qualification must not fabricate first-party eligibility.
    if (!identity?.firstParty) continue;
    const scopeKey = usageKey('official-quota-v1', agent.id, agent.pluginId, agent.home ?? null,
      agent.runtime ?? null, identity?.authRevision ?? 'unqualified');
    bindings.push({ agentId: agent.id, pluginId: agent.pluginId, label: agent.name,
      scopeKey, installed: true, firstParty: true,
      eligibility: identity.authRevision ? identity.eligibility : 'unsupported',
      ...(adapter && identity?.authRevision && identity.eligibility === 'eligible'
        ? { read: (signal: AbortSignal) => adapter.read(agent, signal) } : {}),
    });
  }
  return bindings;
}
