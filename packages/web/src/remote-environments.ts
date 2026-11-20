import type { ConfigOption, ConfigValue, ProxyCatalog, RemoteEnvironmentStatus, Session, UserAgentStatus, Workspace } from '@gian/shared';
import { loadRemoteEnvironmentResponse } from './api.js';

/** A session that runs on another Gian (mirrored here). Fork, Side Chat,
 *  the terminal, Git writes and worktrees need this Mac to run it, so they
 *  are not offered for it; read-only Git, diffs and file previews work. */
export function isMirroredSession(session: Pick<Session, 'remote_execution'> | null | undefined): boolean {
  return !!session?.remote_execution;
}

/** Tooltip for an action a mirrored session does not offer. */
export const MIRRORED_SESSION_UNAVAILABLE = 'remote.unavailableOnMirrored';

/** One paired environment as the Host lists and pushes it. */
export type RemoteEnvironment = RemoteEnvironmentStatus;

/** Environments offered for new sessions and take over: a removed one is
 *  only listed in Settings, under Removed. */
export function pickableRemoteEnvironments(environments: RemoteEnvironment[]): RemoteEnvironment[] {
  return environments.filter(environment => environment.status !== 'removed');
}
export interface RemoteEnvironmentCatalog {
  catalog_revision: string;
  workspaces: Array<{ id: string; name: string }>;
  agents: Array<{ id: string; name: string; proxy: string; readiness: 'ready' | 'unavailable';
    defaults?: { model?: string; thinking?: string; mode?: string; options?: Record<string, ConfigValue> };
    models?: Array<{ id: string; label: string; is_default: boolean; supported_thinking: string[] }> }>;
}
export interface RemoteSessionChoice {
  id: string; name: string | null; workspace_id: string; agent: { id: string; name: string; proxy: string };
}
export interface RemoteAgentCatalog extends Omit<ProxyCatalog, 'slashCommands'> {
  resolveSupported: boolean;
  resolvedDefaults?: { sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue> };
}

export class RemoteRequestError extends Error {
  constructor(readonly status: number) {
    super('Remote request failed (' + status + ')');
  }
}

/** The Remote Server identity differs from the one a paired environment
 *  pinned. The Host pairs only after the user confirms `fingerprint`. */
export class RemoteServerIdentityChangedError extends Error {
  constructor(readonly previousFingerprints: string[], readonly fingerprint: string) {
    super('Remote Server identity changed');
  }
}

/** The Host could not pair: the Remote Server refused the pairing
 *  (`rejected`, with the Server's code), could not be reached, or is rate
 *  limiting this Mac (`rateLimited`, for `retryAfterSeconds`). */
export class RemotePairingError extends Error {
  constructor(readonly reason: 'rejected' | 'unreachable' | 'rateLimited', readonly code?: string,
    readonly retryAfterSeconds?: number) {
    super(reason === 'rejected' ? 'Remote Server refused the pairing'
      : reason === 'unreachable' ? 'Remote Server unreachable' : 'Remote Server rate limited the pairing');
  }
}

/** What a failed pairing tells the user: why, when the Host said so, or
 *  the generic advice. */
export function pairingFailureMessage(t: (key: string) => string, cause: unknown): string {
  if (!(cause instanceof RemotePairingError)) return t('settings.remote.env.failed');
  if (cause.reason !== 'rateLimited') return t(`settings.remote.env.${cause.reason}`);
  return t('settings.remote.env.rateLimited').replace('{seconds}', String(cause.retryAfterSeconds ?? 60));
}

export function remoteRequest<T>(path: string, body?: unknown): Promise<T> {
  return loadRemoteEnvironmentResponse(path, body);
}

export function remoteAgentIdentity(agentId?: string | null): { environmentId: string; agentId: string } | null {
  const match = agentId?.match(/^remote:([0-9a-f-]{36}):([0-9a-f-]{36})$/);
  return match ? { environmentId: match[1]!, agentId: match[2]! } : null;
}

export async function loadRemoteAgentCatalog(agentId: string, input?: {
  catalogRevision: string; sessionConfig: Record<string, ConfigValue>; turnConfig: Record<string, ConfigValue>;
}): Promise<RemoteAgentCatalog> {
  const identity = remoteAgentIdentity(agentId);
  if (!identity) throw new Error('Invalid remote Agent');
  return remoteRequest(`/environments/${identity.environmentId}/agents/${identity.agentId}/catalog`, input);
}

export function remotePickerAgents(environmentId: string, catalog: RemoteEnvironmentCatalog): UserAgentStatus[] {
  return catalog.agents.map(agent => {
    const defaults = { model: agent.defaults?.model ?? '', thinking: agent.defaults?.thinking ?? '',
      mode: agent.defaults?.mode ?? '', options: agent.defaults?.options ?? {} };
    const state = agent.readiness === 'ready' ? 'ready' as const : 'missing' as const;
    return { id: `remote:${environmentId}:${agent.id}`, name: agent.name,
      // The remote Agent projection now carries the live pluginId in the
      // wire `proxy` field; the legacy cast would mislabel pure-plugin rows.
      pluginId: agent.proxy as UserAgentStatus['pluginId'],
      proxy: null, cliPath: null, defaults, proxyName: agent.proxy,
      ready: agent.readiness === 'ready', cli: { state, path: null, version: null, source: null },
      plugin: { state, path: null, version: null, source: null, defaults }, runtimeProfile: null, officialInstallUrl: '' };
  });
}

export function remotePickerWorkspaces(catalog: RemoteEnvironmentCatalog): Workspace[] {
  return catalog.workspaces.map(workspace => ({ ...workspace, path: '', created_at: '', updated_at: '' } as Workspace));
}

export function optionModels(options: ConfigOption[]) {
  const model = options.find(option => option.role === 'model');
  const effort = options.find(option => option.role === 'effort');
  const efforts = (effort?.choices ?? []).map(choice => String(choice.value));
  return (model?.choices ?? []).map(choice => ({ id: String(choice.value), model: String(choice.value),
    displayName: choice.displayName, description: choice.description ?? '', hidden: false,
    isDefault: choice.value === model?.defaultValue, defaultEffort: null, defaultThinking: null,
    supportedEfforts: efforts, supportedThinking: efforts }));
}
