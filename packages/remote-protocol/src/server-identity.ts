import { RemoteProtocolError } from './errors.js';
import {
  SERVER_IDENTITY_PROOF_TTL_MS,
  serverIdentityNonceSchema,
  serverIdentityProofPayload,
  serverIdentityProofResultSchema,
  type ServerIdentityProofResult,
} from './auth.js';
import { identityFingerprint, importP256PublicKey, verifyBytes } from './crypto.js';
import { bytesToBase64Url, base64UrlToBytes } from './serialize.js';
import { parseClosed } from './validation.js';

const PROOF_SKEW_MS = 5_000;

/** Verify a server-identity proof fetched over HTTPS.
 *
 * The signature shows that the key in this response produced the canonical
 * payload. It does not create a trust anchor independent of TLS. The first
 * accepted fingerprint is a TOFU pin; a later fingerprint is rejected. */
export async function verifyServerIdentityProof(input: {
  nonce: string;
  proof: ServerIdentityProofResult;
  now: number;
  pinnedFingerprint?: string | null;
}): Promise<{ fingerprint: string; firstUse: boolean }> {
  const nonce = parseClosed(serverIdentityNonceSchema, input.nonce, 'AUTH_REQUIRED');
  const proof = parseClosed(serverIdentityProofResultSchema, input.proof, 'AUTH_REQUIRED');
  if (proof.expires_at <= input.now || proof.expires_at > input.now + SERVER_IDENTITY_PROOF_TTL_MS + PROOF_SKEW_MS) {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity proof expired');
  }
  const fingerprint = await identityFingerprint(proof.server_identity.public_key);
  if (fingerprint !== proof.server_identity.fingerprint) {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity fingerprint does not match the public key');
  }
  const key = await importP256PublicKey(proof.server_identity.public_key, 'verify');
  const payload = new TextEncoder().encode(serverIdentityProofPayload({
    nonce, fingerprint, expires_at: proof.expires_at,
  }));
  let valid = false;
  try {
    valid = await verifyBytes(key, payload, base64UrlToBytes(proof.signature));
  } catch { valid = false; }
  if (!valid) throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity proof signature is invalid');
  if (input.pinnedFingerprint && input.pinnedFingerprint !== fingerprint) {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity changed');
  }
  return { fingerprint, firstUse: !input.pinnedFingerprint };
}

export async function discoverServerIdentity(input: {
  origin: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  pinnedFingerprint?: string | null;
  timeoutMs?: number;
}): Promise<{ fingerprint: string; proof: ServerIdentityProofResult; firstUse: boolean }> {
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  const now = input.now ?? Date.now;
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = bytesToBase64Url(nonceBytes);
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), input.timeoutMs ?? 10_000);
  let response: Response;
  try {
    response = await fetchFn(new URL('/api/v1/server-identity', input.origin), {
      method: 'POST',
      redirect: 'error',
      // Do not set Origin. A browser still sends the page Origin and the
      // server rejects one outside its allowlist. A Host, including one that
      // reaches the Server through a loopback tunnel, omits Origin. This
      // response is a public proof, not a cookie mutation.
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 'gian.remote.auth/1', nonce }),
      signal: abort.signal,
    });
  } catch {
    throw new RemoteProtocolError('HOST_OFFLINE', 'server identity request failed');
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity proof rejected');
  let body: unknown;
  try { body = await response.json(); } catch {
    throw new RemoteProtocolError('AUTH_REQUIRED', 'server identity proof rejected');
  }
  const proof = parseClosed(serverIdentityProofResultSchema, body, 'AUTH_REQUIRED');
  const verified = await verifyServerIdentityProof({
    nonce, proof, now: now(), pinnedFingerprint: input.pinnedFingerprint,
  });
  return { fingerprint: verified.fingerprint, proof, firstUse: verified.firstUse };
}
