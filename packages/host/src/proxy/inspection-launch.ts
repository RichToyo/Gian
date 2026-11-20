import { isDeepStrictEqual } from 'node:util';
import { sessionRuntimeCliPath, type UserAgent, type UserAgentStatus } from '@gian/shared';
import type { SessionBindingPlanner } from '../session/binding-planner.js';
import { inspectionProfileMatches, type InspectionHostOptions } from './manager.js';

interface InspectionLaunchDependencies {
  agents: {
    getAgent(id: string): UserAgent;
    agentStatus(id: string, refresh?: boolean): Promise<UserAgentStatus>;
  };
  planner: Pick<SessionBindingPlanner, 'prepareCurrent'>;
}

const bindingChanged = () => new Error('Inspection Runtime binding changed; retry with the current Agent.');

/** Installation snapshots and resolved launch profiles have different identity
 * namespaces. Fence each against its own source, not against the other's hash. */
export async function prepareInspectionLaunch(
  pluginId: string,
  options: InspectionHostOptions,
  { agents, planner }: InspectionLaunchDependencies,
) {
  if (!options.agentId) throw new Error('Inspection requires a saved Agent.');
  const agent = structuredClone(agents.getAgent(options.agentId));
  if (agent.pluginId !== pluginId) {
    throw new Error('Inspection Agent does not match the requested pluginId.');
  }
  const status = structuredClone(await agents.agentStatus(agent.id, false));
  if (!isDeepStrictEqual(agent, agents.getAgent(agent.id))
    || status.id !== agent.id || status.pluginId !== pluginId
    || (status.runtimeProfile && (status.runtimeProfile.agentId !== agent.id
      || status.runtimeProfile.pluginId !== pluginId))
    || !inspectionProfileMatches(options, status.runtimeProfile)
    || (options.proxyVersion && options.proxyVersion !== status.plugin.version)) {
    throw bindingChanged();
  }
  const selectedPath = status.runtimeProfile?.path ?? status.cli.path ?? agent.cliPath;
  const prepared = await planner.prepareCurrent({ agent, selectedPath, runtimeProfile: status.runtimeProfile });
  try {
    // Agent edits invalidate its status cache. Re-read after the asynchronous
    // preparation, and discard the unused lease if the selection has changed.
    const current = await agents.agentStatus(agent.id, false);
    if (!isDeepStrictEqual(agent, agents.getAgent(agent.id))
      || current.id !== status.id || current.pluginId !== status.pluginId
      || !isDeepStrictEqual(status.runtimeProfile, current.runtimeProfile)
      || status.plugin.version !== current.plugin.version
      || status.plugin.path !== current.plugin.path
      || status.cli.source !== current.cli.source
      || selectedPath !== (current.runtimeProfile?.path ?? current.cli.path ?? agent.cliPath)) {
      throw bindingChanged();
    }

    const resolved = prepared.sessionBinding.runtimeProfile;
    const expected = status.runtimeProfile;
    if (prepared.sessionBinding.pluginId !== pluginId
      || (status.plugin.version && prepared.sessionBinding.pluginVersion !== status.plugin.version)
      || !resolved || resolved.agentId !== agent.id || resolved.pluginId !== pluginId
      || sessionRuntimeCliPath(resolved) !== selectedPath
      || resolved.configHome !== (agent.home?.path ?? expected?.configHome ?? null)
      || (expected && (resolved.configHome !== expected.configHome
        || ('version' in resolved ? resolved.version : resolved.cliVersion) !== expected.version
        || ('runtimeId' in resolved && resolved.runtimeId !== expected.runtimeId)))) {
      throw bindingChanged();
    }
    // Managed status carries the archive digest, not the live content digest.
    // Probed/custom profiles do use live content and must still match it.
    if (expected && status.cli.source !== 'managed'
      && expected.contentFingerprint !== ('contentFingerprint' in resolved
        ? resolved.contentFingerprint : resolved.cliFingerprint)) {
      throw bindingChanged();
    }
    return {
      binding: prepared.launchBinding,
      acquireLease: prepared.acquireLease,
      releaseUnusedLease: prepared.releaseUnusedLease,
    };
  } catch (error) {
    await prepared.releaseUnusedLease();
    throw error;
  }
}
