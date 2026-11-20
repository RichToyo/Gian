import type { Context, Hono } from 'hono';
import { routePath } from 'hono/route';
import { RemoteProtocolError, redactRemoteText } from '@gian/remote-protocol';
import { isNetworkFailure } from './controller-client.js';
import { RemoteIdentityUnavailableError } from './identity-broker.js';
import type { RemoteRuntime } from './runtime.js';
import { RemoteAccountRequiredError, RemoteAccountRetryError } from './server-client.js';

/** Errors the Host raises itself with a code Settings shows as is. */
const SAFE_ERRORS = ['invalid_url', 'already_enrolled', 'not_enrolled', 'identity_changed',
  'pairing_busy', 'connection_cancelled', 'pairing_not_found', 'invalid_host_name',
  'invalid_device_name', 'device_not_found'];

/** Settings is local-Host authenticated. No Remote Server admin token enters the renderer. */
export function registerRemoteSettingsRoutes(app: Hono, remote: RemoteRuntime): void {
  app.use('/api/remote/*', async (context, next) => {
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.get('/api/remote/settings', context => context.json(remote.settingsState()));
  const mutate = <T>(action: (context: Context) => T | Promise<T>, fields?: (result: T) => object) => async (context: Context) => {
    try {
      const result = await action(context);
      return context.json({ ok: true, ...fields?.(result), ...remote.settingsState() });
    } catch (error) {
      // Never echo tokens, credential-bearing URLs, or remote response bodies.
      // A generic category is logged with its underlying error (sanitised).
      const failed = (category: string, status: 400 | 401 | 503) => {
        logActionFailure(routePath(context), category, error);
        return context.json({ error: category }, status);
      };
      if (error instanceof RemoteAccountRequiredError) return failed('remote_auth_required', 401);
      // Before the network: a broker socket error carries a network-like code.
      if (error instanceof RemoteIdentityUnavailableError) return failed('identity_unavailable', 503);
      if (error instanceof RemoteAccountRetryError || isNetworkFailure(error)
        || (error instanceof RemoteProtocolError && ['HOST_OFFLINE', 'RATE_LIMITED'].includes(error.code))) {
        const retryAfter = error instanceof RemoteAccountRetryError ? error.retryAfterSeconds
          : error instanceof RemoteProtocolError && error.code === 'RATE_LIMITED'
            && typeof error.details?.retryAfterSeconds === 'number'
            ? Math.max(1, Math.min(60, error.details.retryAfterSeconds)) : 5;
        context.header('Retry-After', String(retryAfter));
        return failed('remote_unavailable', 503);
      }
      if (context.req.path === '/api/remote/enroll'
        && error instanceof RemoteProtocolError && error.code === 'AUTH_REQUIRED') {
        return failed('enrollment_rejected', 400);
      }
      if (error instanceof RemoteProtocolError && error.code === 'AUTH_REQUIRED') {
        return failed('remote_auth_required', 401);
      }
      if (error instanceof Error && SAFE_ERRORS.includes(error.message)) {
        return context.json({ error: error.message }, 400);
      }
      return failed('remote_action_failed', 400);
    }
  };
  const body = (context: Context) => context.req.json<Record<string, unknown>>()
    .catch(() => ({} as Record<string, unknown>));

  app.post('/api/remote/account/start', mutate(async context => {
    const input = await body(context);
    if (typeof input.server_url !== 'string') throw new Error('invalid_url');
    await remote.startAccountLogin(input.server_url);
  }));
  app.post('/api/remote/account/poll', mutate(() => remote.pollAccountLogin()));

  app.post('/api/remote/enroll', mutate(async context => {
    const input = await body(context);
    if (typeof input.server_url !== 'string' || typeof input.enrollment_token !== 'string'
        || !input.enrollment_token.trim() || input.enrollment_token.length > 4096
        || (input.public_url !== undefined && typeof input.public_url !== 'string')
        || (input.host_name !== undefined
          && (typeof input.host_name !== 'string' || input.host_name.length > 256))) {
      throw new Error('invalid_enrollment');
    }
    await remote.enroll({
      serverUrl: input.server_url, enrollmentToken: input.enrollment_token,
      ...(typeof input.public_url === 'string' && input.public_url ? { publicUrl: input.public_url } : {}),
      ...(typeof input.host_name === 'string' && input.host_name.trim() ? { hostName: input.host_name } : {}),
    });
  }));
  app.post('/api/remote/disconnect', mutate(() => remote.disconnect()));
  app.post('/api/remote/reconnect', mutate(() => remote.reconnect()));
  app.post('/api/remote/disable', mutate(() => remote.disableRemote()));
  app.post('/api/remote/host-name', mutate(async context => {
    const input = await body(context);
    if (typeof input.host_name !== 'string') throw new Error('invalid_host_name');
    await remote.setHostName(input.host_name);
  }));
  app.post('/api/remote/public-url', mutate(async context => {
    const input = await body(context);
    if (typeof input.public_url !== 'string') throw new Error('invalid_url');
    remote.setPublicUrl(input.public_url);
  }));

  app.post('/api/remote/pairings', async context => {
    try { return context.json(await remote.createPairingGrant()); }
    catch { return context.json({ error: 'remote_action_failed' }, 400); }
  });
  app.post('/api/remote/pairings/:id/confirm', mutate(context =>
    remote.confirmPairing(context.req.param('id')!, 'confirm'), result => result));
  app.post('/api/remote/pairings/:id/reject', mutate(context =>
    remote.confirmPairing(context.req.param('id')!, 'reject'), result => result));
  app.post('/api/remote/pairings/:id/cancel', mutate(context =>
    remote.cancelPairing(context.req.param('id')!)));
  app.post('/api/remote/devices/:id/name', mutate(async context => {
    const input = await body(context);
    if (typeof input.name !== 'string') throw new Error('invalid_device_name');
    return remote.renameDevice(context.req.param('id')!, input.name);
  }));
  app.post('/api/remote/devices/:id/revoke', mutate(context =>
    remote.revokeDevice(context.req.param('id')!), device => ({
      id: device.id, revoked_at: device.revokedAt, revision: device.revision,
    })));
  app.get('/api/remote/devices/:id/audit', context =>
    context.json({ entries: remote.audit.list(context.req.param('id')) }));
  app.post('/api/remote/enrollment/confirm-identity', mutate(async context => {
    const input = await body(context);
    if (typeof input.expected_fingerprint !== 'string') throw new Error('identity_changed');
    await remote.confirmServerIdentityChange(input.expected_fingerprint);
  }));
  app.post('/api/remote/enrollment/reject-identity', mutate(() => remote.rejectServerIdentityChange()));
}

/** One Host log line for a Settings action that failed for a reason the
 *  renderer only sees as a category: the route, the error's name and code,
 *  its cause's, and their messages with URLs cut to their origin, secrets
 *  redacted and the length capped. Server response bodies never reach them. */
function logActionFailure(route: string, category: string, error: unknown): void {
  const cause = error instanceof Error && error.cause !== undefined ? ` (cause: ${describeError(error.cause)})` : '';
  console.error(`[remote] ${route} failed as ${category}: ${describeError(error)}${cause}`);
}

function describeError(value: unknown): string {
  if (typeof value !== 'object' || value === null) {
    return typeof value === 'string' ? sanitizeLogText(value) : typeof value;
  }
  const { name, code, message } = value as { name?: unknown; code?: unknown; message?: unknown };
  const label = [typeof name === 'string' && /^\w{1,64}$/.test(name) ? name : 'Error',
    typeof code === 'string' && /^[\w.-]{1,64}$/.test(code) ? code : ''].filter(Boolean).join(' ');
  return typeof message === 'string' && message ? `${label}: ${sanitizeLogText(message)}` : label;
}

function sanitizeLogText(text: string): string {
  const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, value => {
    try {
      const url = new URL(value);
      return url.host ? `${url.protocol}//${url.host}` : '[url]';
    } catch { return '[url]'; }
  });
  return redactRemoteText(withoutUrls.replace(/\s+/g, ' ')).slice(0, 240);
}
