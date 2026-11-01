import { z } from 'zod';
import { githubAccountIdSchema } from './account.js';
import { canonicalIdSchema, p256PublicJwkSchema, sha256HexSchema } from './validation.js';

export const remoteServerOriginSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}, 'Expected a canonical HTTPS origin without credentials, path, query or fragment.');

// Task membership stays local. The current/viewed worktree is a remote
// resource, not part of the immutable execution identity.
// The legacy shape is unchanged. New bindings use an explicit version rather
// than omitting account_id or inventing a stand-in GitHub identity.
export const legacyRemoteExecutionTargetSchema = z.strictObject({
  server_origin: remoteServerOriginSchema,
  server_identity_fingerprint: sha256HexSchema,
  account_id: githubAccountIdSchema,
  host_id: canonicalIdSchema,
  remote_session_id: canonicalIdSchema,
});

export const deviceRemoteExecutionTargetSchema = z.strictObject({
  target_version: z.literal(2),
  server_origin: remoteServerOriginSchema,
  server_identity_fingerprint: sha256HexSchema,
  host_id: canonicalIdSchema,
  remote_session_id: canonicalIdSchema,
  device_id: canonicalIdSchema,
  device_public_key: p256PublicJwkSchema,
  crypto_connection_id: canonicalIdSchema,
});

export const remoteExecutionTargetSchema = z.union([
  legacyRemoteExecutionTargetSchema,
  deviceRemoteExecutionTargetSchema,
]);

export const remoteExecutionBindingInputSchema = z.strictObject({
  local_session_id: canonicalIdSchema,
  target: remoteExecutionTargetSchema,
});

export type RemoteExecutionTarget = z.infer<typeof remoteExecutionTargetSchema>;
export type RemoteExecutionBindingInput = z.infer<typeof remoteExecutionBindingInputSchema>;
