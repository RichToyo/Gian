import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isProxyOfficialQuotaData, isProxyOfficialQuotaReadResult, officialQuotaReadParamsSchema, resultSchemas } from '../src/index.js';

test('candidate official quota allowlist excludes Provider credentials and unsafe amounts', () => {
  const safe = { windows: [{ id: 'real-window', label: 'Primary', usedRatio: 1, resetAt: null, windowDurationMinutes: null }],
    balances: [{ currency: 'USD', total: '1000000000000000.123456', granted: null, toppedUp: null }] };
  assert.equal(isProxyOfficialQuotaData(safe), true);
  assert.equal(isProxyOfficialQuotaData({ ...safe, token: 'private' }), false);
  assert.equal(isProxyOfficialQuotaData({ ...safe, windows: [{ ...safe.windows[0], usedRatio: NaN }] }), false);
  assert.equal(isProxyOfficialQuotaData({ windows: [], balances: [{ ...safe.balances[0], total: 1.25 }] }), false);
});

test('official quota RPC is bounded and rejects caller supplied URLs, homes and credentials', () => {
  const params = { model: null, provider: null, identityNonce: 'c'.repeat(64) };
  assert.equal(officialQuotaReadParamsSchema.safeParse(params).success, true);
  for (const field of ['url', 'configHome', 'token', 'apiKey']) {
    assert.equal(officialQuotaReadParamsSchema.safeParse({ ...params, [field]: 'private' }).success, false);
  }
  const empty = { status: 'auth_required', authRevision: null, error: null, windows: [], balances: [] };
  assert.equal(isProxyOfficialQuotaReadResult(empty), true);
  assert.equal(isProxyOfficialQuotaReadResult({ ...empty, token: 'secret' }), false);
  assert.equal(isProxyOfficialQuotaReadResult({ ...empty, status: 'ready', authRevision: 'a'.repeat(64) }), false);
  const ready = { ...empty, status: 'ready', authRevision: 'a'.repeat(64),
    windows: [{ id: '5h', label: '5h', usedRatio: 1, resetAt: null, windowDurationMinutes: 300 }] };
  assert.equal(resultSchemas['account.quota.read'].safeParse(ready).success, true);
  assert.equal(isProxyOfficialQuotaReadResult({ ...ready, status: 'excluded' }), false);
  assert.equal(isProxyOfficialQuotaReadResult({ ...ready, authRevision: null }), false);
  assert.equal(isProxyOfficialQuotaReadResult({ ...ready, authRevision: null, source: 'cli' }), true);
  assert.equal(isProxyOfficialQuotaReadResult({ ...ready, source: 'cli' }), false);
  assert.equal(isProxyOfficialQuotaReadResult({ ...ready, authRevision: null, source: 'arbitrary' }), false);
});
