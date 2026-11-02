import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUTH_PROTOCOL,
  RemoteProtocolError,
  SERVER_IDENTITY_PROOF_TTL_MS,
  discoverServerIdentity,
  exportPublicJwk,
  generateP256SigningKeyPair,
  identityFingerprint,
  serverIdentityProofPayload,
  serverIdentityProofRequestSchema,
  signBytes,
  verifyServerIdentityProof,
} from '../src/index.js';

const nonce = 'abcdefghijklmnopqrstuvwx';

async function signedProof(expiresAt: number, fingerprintOverride?: string) {
  const keys = await generateP256SigningKeyPair();
  const publicKey = await exportPublicJwk(keys.publicKey);
  const fingerprint = fingerprintOverride ?? await identityFingerprint(publicKey);
  const payload = serverIdentityProofPayload({ nonce, fingerprint, expires_at: expiresAt });
  const signature = await signBytes(keys.privateKey, new TextEncoder().encode(payload));
  return {
    keys,
    fingerprint: await identityFingerprint(publicKey),
    payload,
    proof: {
      protocol: AUTH_PROTOCOL,
      server_identity: { algorithm: 'P-256' as const, public_key: publicKey, fingerprint },
      expires_at: expiresAt,
      signature,
    },
  };
}

test('server identity proof uses sorted canonical bytes and rejects replacement', async () => {
  const expiresAt = 1_700_000_000_000;
  const signed = await signedProof(expiresAt);
  assert.equal(signed.payload, JSON.stringify({
    expires_at: expiresAt,
    fingerprint: signed.fingerprint,
    nonce,
    type: 'gian.remote.server_identity/1',
  }));
  assert.equal(serverIdentityProofRequestSchema.safeParse({
    protocol: AUTH_PROTOCOL, nonce, extra: true,
  }).success, false);
  const verified = await verifyServerIdentityProof({
    nonce, proof: signed.proof, now: expiresAt - 1_000,
  });
  assert.equal(verified.firstUse, true);
  assert.equal(verified.fingerprint, signed.fingerprint);
  let pin = verified.fingerprint;
  const again = await verifyServerIdentityProof({
    nonce, proof: signed.proof, now: expiresAt - 1_000, pinnedFingerprint: pin,
  });
  assert.equal(again.firstUse, false);
  await assert.rejects(
    () => verifyServerIdentityProof({
      nonce, proof: signed.proof, now: expiresAt - 1_000, pinnedFingerprint: 'b'.repeat(64),
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.message === 'server identity changed',
  );
  assert.equal(pin, signed.fingerprint);
  await assert.rejects(
    () => verifyServerIdentityProof({
      nonce: `${nonce}zz`, proof: signed.proof, now: expiresAt - 1_000, pinnedFingerprint: pin,
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.code === 'AUTH_REQUIRED',
  );
  assert.equal(pin, signed.fingerprint);
  const mismatched = { ...signed.proof, server_identity: { ...signed.proof.server_identity, fingerprint: 'c'.repeat(64) } };
  await assert.rejects(
    () => verifyServerIdentityProof({ nonce, proof: mismatched, now: expiresAt - 1_000 }),
    (error: unknown) => error instanceof RemoteProtocolError
      && error.message === 'server identity fingerprint does not match the public key',
  );
  await assert.rejects(
    () => verifyServerIdentityProof({ nonce, proof: signed.proof, now: expiresAt }),
    (error: unknown) => error instanceof RemoteProtocolError && error.message === 'server identity proof expired',
  );
  await assert.rejects(
    () => verifyServerIdentityProof({
      nonce, proof: signed.proof, now: expiresAt - SERVER_IDENTITY_PROOF_TTL_MS - 5_001,
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.message === 'server identity proof expired',
  );
  const other = await signedProof(expiresAt);
  await assert.rejects(
    () => verifyServerIdentityProof({
      nonce, proof: { ...signed.proof, signature: other.proof.signature }, now: expiresAt - 1_000,
    }),
    (error: unknown) => error instanceof RemoteProtocolError && error.message === 'server identity proof signature is invalid',
  );
});

test('identity rate limits back off per origin and do not become authentication failures', async () => {
  let now = 1_700_000_000_000;
  let calls = 0;
  const fetchFn: typeof fetch = async () => {
    calls += 1;
    return new Response(null, { status: calls === 3 ? 503 : 429, headers: { 'retry-after': '15' } });
  };
  const discover = (origin: string) => discoverServerIdentity({ origin, fetchFn, now: () => now });
  await assert.rejects(() => discover('https://one.example'), { code: 'RATE_LIMITED' });
  await assert.rejects(() => discover('https://one.example'), { code: 'RATE_LIMITED' });
  assert.equal(calls, 1, 'the same origin is blocked locally during the cooldown');
  await assert.rejects(() => discover('https://two.example'), { code: 'RATE_LIMITED' });
  assert.equal(calls, 2, 'another origin has an independent cooldown');
  now += 15_000;
  await assert.rejects(() => discover('https://one.example'), { code: 'HOST_OFFLINE' });
  assert.equal(calls, 3, 'the request resumes after cooldown');
});
