import { createHmac } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { ProxyOfficialQuotaReadResult } from './official-quota.js';

/** Host-lifetime HMAC: comparable after inspection-process restart, not globally. */
export function quotaIdentity(parts: readonly unknown[], identityNonce: string): string {
  return createHmac('sha256', Buffer.from(identityNonce, 'hex')).update(JSON.stringify(parts)).digest('hex');
}

export function hasBoundQuotaHome(env: NodeJS.ProcessEnv, providerHome: string): boolean {
  const home = env[providerHome];
  return typeof home === 'string' && isAbsolute(home) && home === env.GIAN_AGENT_HOME
    && typeof env.GIAN_RUNTIME_BIN === 'string' && isAbsolute(env.GIAN_RUNTIME_BIN);
}

export function quotaState(status: 'auth_required' | 'unsupported' | 'excluded', authRevision: string | null = null): ProxyOfficialQuotaReadResult {
  return { status, authRevision, error: null, windows: [], balances: [] };
}

export function quotaFailure(error: unknown, authRevision: string | null): ProxyOfficialQuotaReadResult {
  const value = error as { message?: unknown; status?: unknown; httpStatus?: unknown; name?: unknown } | null;
  const status = value?.httpStatus ?? value?.status;
  if (status === 401 || value?.message === 'auth_required') return quotaState('auth_required', authRevision);
  const code = status === 429 || value?.message === 'rate_limited' ? 'rate_limited'
    : value?.name === 'TimeoutError' || value?.name === 'AbortError' || value?.message === 'timeout' ? 'timeout'
      : value?.message === 'invalid_response' ? 'invalid_response' : 'unavailable';
  return { status: 'error', authRevision, error: code, windows: [], balances: [] };
}
