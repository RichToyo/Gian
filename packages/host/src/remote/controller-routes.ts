import type { Hono } from 'hono';
import { canonicalIdSchema, parseClosed, proxyLogoResultSchema, sha256Hex, RemoteProtocolError } from '@gian/remote-protocol';
import { RemoteServerIdentityChangedError, type RemoteControllerHub } from './controller-hub.js';
import { isNetworkFailure } from './controller-client.js';
import type { WsBroadcaster } from '../web/ws-broadcast.js';
import { buildRawPreviewHeaders } from '../workspace/preview-headers.js';
import { isLikelyBinary } from '../workspace/bounded-file.js';
import type { Context } from 'hono';
import { RemoteAccountRetryError } from './server-client.js';

/** A message attachment never changes for its URL: the browser keeps it
 *  instead of asking again whenever a thumbnail remounts. */
export const REMOTE_ATTACHMENT_CACHE_CONTROL = 'private, max-age=604800, immutable';

export function registerRemoteControllerRoutes(app: Hono, hub: RemoteControllerHub, broadcaster: WsBroadcaster): void {
  // Message attachments (a transcript thumbnail's URL, or an `attachment:`
  // reference opened in the file panel) come from the hub's cache; worktree
  // files are read fresh every time.
  const preview = (c: Context, localId: string, reference: string, raw: boolean,
    attachment = reference.startsWith('attachment:')) => remoteFileResponse(c, async () => {
    const id = parseClosed(canonicalIdSchema, localId);
    const file = attachment ? await hub.readAttachment(id, reference) : await hub.readFile(id, reference);
    const bytes = Buffer.from(file.bytes);
    if (!raw) {
      if (bytes.length > 1024 * 1024) return c.json({ error: 'file too large' }, 413);
      if (isLikelyBinary(bytes)) return c.json({ error: 'binary file' }, 415);
      return c.json({ content: bytes.toString('utf8'), size: bytes.length });
    }
    const { headers } = buildRawPreviewHeaders({ rel: file.name, size: bytes.length });
    if (headers['Content-Type'] === 'application/octet-stream' && file.mime.startsWith('text/')) headers['Content-Type'] = file.mime;
    headers['Cache-Control'] = 'no-store';
    if ('sha256' in file) {
      const etag = `"${file.sha256}"`;
      headers['Cache-Control'] = REMOTE_ATTACHMENT_CACHE_CONTROL;
      headers.ETag = etag;
      c.header('Cache-Control', REMOTE_ATTACHMENT_CACHE_CONTROL);
      const known = (c.req.header('if-none-match') ?? '').split(',').map(tag => tag.trim().replace(/^W\//, ''));
      if (known.includes(etag) || known.includes('*')) {
        return new Response(null, { status: 304, headers: { 'Cache-Control': REMOTE_ATTACHMENT_CACHE_CONTROL, ETag: etag } });
      }
    }
    return new Response(new Uint8Array(bytes), { headers });
  });
  app.get('/api/remote/working-trees', c => c.json(hub.workingTrees()));
  app.get('/api/remote/sessions/:id/status', c => c.json(hub.status(parseClosed(canonicalIdSchema, c.req.param('id')))));
  app.get('/api/remote/sessions/:id/files/:handle', c => preview(c, c.req.param('id'), c.req.param('handle'), true, true));
  app.get('/api/remote/sessions/:id/raw', c => preview(c, c.req.param('id'), c.req.query('reference') ?? '', true));
  app.use('/api/working_trees/*', async (c, next) => {
    const parts = new URL(c.req.url).pathname.split('/');
    let tree: string;
    try { tree = decodeURIComponent(parts[3] ?? ''); } catch { return c.json({ error: 'invalid tree' }, 400); }
    if (!tree.startsWith('remote:')) return next();
    return remoteFileResponse(c, async () => {
      const localId = parseClosed(canonicalIdSchema, tree.slice(7));
      if (c.req.method !== 'GET') return c.json({ error: 'remote write operation unavailable' }, 403);
      const reference = c.req.query('path') ?? '';
      if (parts[4] === 'file' || parts[4] === 'raw') return preview(c, localId, reference, parts[4] === 'raw');
      if (parts[4] === 'files') return c.json({ files: await hub.files(localId) });
      if (parts[4] === 'tree') {
        const entries = await hub.directory(localId, reference);
        return c.json(entries.map(entry => ({ name: entry.name, path: entry.reference, type: entry.kind === 'directory' ? 'dir' : 'file' })));
      }
      const operation = parts[4] === 'history' ? (parts[6] === 'diff' ? 'history_diff'
        : parts[6] === 'reachability' ? 'history_reachability' : parts[5] ? 'history_commit' : 'history')
        : ['changed', 'diff', 'branches', 'commits'].includes(parts[4] ?? '') ? parts[4] : null;
      if (operation) {
        const query = c.req.query();
        const result = await hub.command(localId, 'git.read', { operation,
          ...(query.path ? { reference: query.path } : {}), ...(query.scope ? { scope: query.scope } : {}),
          ...(query.sha || parts[5] ? { sha: query.sha ?? parts[5] } : {}),
          ...(query.base ? { base: query.base } : {}), ...(query.turn ? { turn: Number(query.turn) } : {}),
          ...(query.root ? { root: query.root } : {}), ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.q ? { query: query.q } : {}), ...(query.author ? { author: query.author } : {}),
          ...(query.ref ? { ref: query.ref } : {}), ...(query.limit ? { limit: Number(query.limit) } : {}),
        }) as { result_json: string };
        return c.json(JSON.parse(result.result_json));
      }
      return c.json({ error: 'remote resource unavailable' }, 404);
    });
  });
  app.get('/api/remote/environments', c => c.json({ environments: hub.listEnvironments() }));
  app.get('/api/remote/environments/:id/logos/:proxy/:variant', async c => {
    const variant = c.req.param('variant');
    if (variant !== 'light' && variant !== 'dark') return c.json({ error: 'invalid variant' }, 400);
    const logo = parseClosed(proxyLogoResultSchema, await hub.client(parseClosed(canonicalIdSchema, c.req.param('id')))
      .request('proxy.logo', { proxy: c.req.param('proxy'), variant }));
    const bytes = Buffer.from(logo.data_base64, 'base64');
    if (await sha256Hex(bytes) !== logo.sha256) return c.json({ error: 'invalid logo' }, 502);
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': logo.media_type,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  });
  const accountResponse = async (c: Context, action: () => ReturnType<RemoteControllerHub['startLogin']>) => {
    try { return c.json({ account: await action() }); }
    catch (error) {
      if (error instanceof RemoteAccountRetryError
        || (error instanceof RemoteProtocolError && ['HOST_OFFLINE', 'RATE_LIMITED'].includes(error.code))) {
        c.header('Retry-After', String(error instanceof RemoteAccountRetryError ? error.retryAfterSeconds : 5));
        return c.json({ error: 'remote_account_unavailable' }, 503);
      }
      return c.json({ error: 'remote_account_required' }, 401);
    }
  };
  app.post('/api/remote/controller/account/start', async c => {
    const body = await c.req.json<{ server_url: string }>();
    return accountResponse(c, () => hub.startLogin(body.server_url));
  });
  app.post('/api/remote/controller/account/poll', async c => {
    const body = await c.req.json<{ server_url: string }>();
    return accountResponse(c, () => hub.pollLogin(body.server_url));
  });
  app.post('/api/remote/environments', async c => {
    const body = await c.req.json<{ server_url?: string; code?: string; name?: string; confirm_server_identity?: string }>();
    if (typeof body.server_url !== 'string' || typeof body.code !== 'string' || typeof body.name !== 'string'
      || body.name.length < 1 || body.name.length > 256
      || (body.confirm_server_identity !== undefined && typeof body.confirm_server_identity !== 'string')) {
      return c.json({ error: 'invalid_environment' }, 400);
    }
    try {
      return c.json({ environment: await hub.pair({ origin: body.server_url, code: body.code, name: body.name,
        ...(body.confirm_server_identity ? { confirm_server_identity: body.confirm_server_identity } : {}) }) });
    } catch (error) {
      if (error instanceof RemoteServerIdentityChangedError) {
        // Settings asks the user; the pairing code has not been spent.
        return c.json({ error: 'server_identity_changed', server_url: error.serverOrigin,
          previous_fingerprints: error.previousFingerprints, fingerprint: error.fingerprint }, 409);
      }
      if (isNetworkFailure(error) || (error instanceof RemoteProtocolError && error.code === 'HOST_OFFLINE')) {
        return c.json({ error: 'pairing_unreachable' }, 502);
      }
      // The Server is rate limiting this address (its identity proof, the
      // admission or the claim): not a refusal; the code stays usable once
      // it lets this Mac in again. Without its Retry-After, a full window.
      if (error instanceof RemoteProtocolError && error.code === 'RATE_LIMITED') {
        const after = Number(error.details?.retryAfterSeconds);
        const seconds = Number.isFinite(after) && after > 0 ? Math.ceil(after) : 60;
        c.header('Retry-After', String(seconds));
        return c.json({ error: 'pairing_rate_limited', retry_after_seconds: seconds }, 429);
      }
      // The Server refused the claim or this Mac's admission (a used or
      // expired code, a Host this key is already paired with).
      if (error instanceof RemoteProtocolError) {
        return c.json({ error: 'pairing_rejected', code: error.code }, 409);
      }
      throw error;
    }
  });
  // Both answer with the full list, so Settings shows the outcome at once.
  app.delete('/api/remote/environments/:id', c => {
    if (!hub.removeEnvironment(parseClosed(canonicalIdSchema, c.req.param('id')))) {
      return c.json({ error: 'environment_not_found' }, 404);
    }
    return c.json({ ok: true, environments: hub.listEnvironments() });
  });
  app.post('/api/remote/environments/:id/restore', c => {
    if (!hub.restoreEnvironment(parseClosed(canonicalIdSchema, c.req.param('id')))) {
      return c.json({ error: 'environment_not_found' }, 404);
    }
    return c.json({ ok: true, environments: hub.listEnvironments() });
  });
  app.get('/api/remote/environments/:id/catalog', async c => c.json(await hub.catalog(parseClosed(canonicalIdSchema, c.req.param('id')))));
  app.get('/api/remote/environments/:id/agents/:agentId/catalog', async c => c.json(await hub.agentCatalog(
    parseClosed(canonicalIdSchema, c.req.param('id')), parseClosed(canonicalIdSchema, c.req.param('agentId')))));
  app.post('/api/remote/environments/:id/agents/:agentId/catalog', async c => {
    const input = await c.req.json<Parameters<RemoteControllerHub['agentCatalog']>[2]>();
    return c.json(await hub.agentCatalog(parseClosed(canonicalIdSchema, c.req.param('id')),
      parseClosed(canonicalIdSchema, c.req.param('agentId')), input));
  });
  app.get('/api/remote/environments/:id/sessions', async c => {
    const after = c.req.query('after');
    return c.json(await hub.listExecutions(parseClosed(canonicalIdSchema, c.req.param('id')),
      after ? parseClosed(canonicalIdSchema, after) : undefined));
  });
  app.post('/api/remote/environments/:id/sessions/:sessionId/takeover', async c => {
    const body = await c.req.json<{ task_id?: string }>().catch(() => ({} as { task_id?: string }));
    const session = await hub.takeOver(parseClosed(canonicalIdSchema, c.req.param('id')),
      parseClosed(canonicalIdSchema, c.req.param('sessionId')),
      body.task_id ? parseClosed(canonicalIdSchema, body.task_id) : undefined);
    broadcaster.broadcast({ type: 'session:created', session, origin: 'interactive-create' });
    return c.json({ session });
  });
}

const FILE_ERRORS: Record<string, { status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 429 | 503; message: string }> = {
  INVALID_FRAME: { status: 400, message: 'Invalid remote file request' },
  AUTH_REQUIRED: { status: 401, message: 'Remote account authorization required' },
  DEVICE_REVOKED: { status: 403, message: 'Remote device authorization revoked' },
  REMOTE_CAPABILITY_DENIED: { status: 403, message: 'Remote file access denied' },
  RESOURCE_NOT_FOUND: { status: 404, message: 'Remote resource not found' },
  ATTACHMENT_NOT_FOUND: { status: 404, message: 'Remote attachment not found' },
  FILE_REFERENCE_EXPIRED: { status: 410, message: 'Remote file reference expired; resolve it again' },
  FILE_TOO_LARGE: { status: 413, message: 'Remote file exceeds the size limit' },
  FRAME_TOO_LARGE: { status: 413, message: 'Remote response exceeds the size limit' },
  TRANSFER_CONFLICT: { status: 409, message: 'Remote file transfer conflict' },
  PRECONDITION_FAILED: { status: 409, message: 'Remote resource changed; refresh and retry' },
  RATE_LIMITED: { status: 429, message: 'Remote request rate limited' },
  HOST_OFFLINE: { status: 503, message: 'Remote execution Host is unavailable' },
};

async function remoteFileResponse(c: Context, action: () => Promise<Response>): Promise<Response> {
  c.header('Cache-Control', 'no-store');
  try { return await action(); }
  catch (error) {
    const code = error instanceof RemoteProtocolError ? error.code : 'INTERNAL_ERROR';
    const mapped = FILE_ERRORS[code];
    // Do not return the peer's raw exception, path, stack or credentials.
    return c.json({ code, error: mapped?.message ?? 'Remote file request failed' }, mapped?.status ?? 500);
  }
}
