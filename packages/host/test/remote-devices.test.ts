import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AUTH_SIGNED_AT_SKEW_MS, generateCanonicalId, identityFingerprint } from '@gian/remote-protocol';
import { DEFAULT_REMOTE_DEVICE_GRANTS } from '../src/remote/grants.js';
import {
  describeRemoteDevice,
  normalizeRemoteDeviceName,
  remoteDeviceDisplayName,
} from '../src/remote/device-label.js';
import { seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('Remote device labels use conservative platform hints and preserve explicit safe names', () => {
  const cases = [
    ['iPhone', 'Mozilla/5.0 CriOS/140.0 Mobile', 'iPhone · Chrome'],
    ['iPad', 'Mozilla/5.0 Version/17.0 Mobile Safari/605.1.15', 'iPad · Safari'],
    ['macOS', 'Mozilla/5.0 GianDev/0.6.10 Chrome/140.0.0.0', 'macOS · Gian'],
    ['Win32', 'Mozilla/5.0 Chrome/140.0.0.0 Edg/140.0.0.0', 'Windows · Edge'],
    ['Android', 'Mozilla/5.0 Chrome/140.0.0.0 Mobile', 'Android · Chrome'],
    ['X11', 'Mozilla/5.0 Firefox/143.0', 'Linux · Firefox'],
    ['iOS', 'Version/17.0 Mobile Safari/605.1.15', 'iOS · Safari'],
    [null, null, 'Remote device'],
  ] as const;
  for (const [platform, userAgent, expected] of cases) {
    assert.equal(describeRemoteDevice(platform, userAgent), expected);
  }
  assert.equal(remoteDeviceDisplayName({ name: '  My phone  ', platform: 'macOS' }), 'My phone');
  assert.equal(remoteDeviceDisplayName({ name: 'Remote device', platform: 'macOS', userAgent: 'Safari/605' }), 'macOS · Safari');
  for (const name of ['', ' ', 'x'.repeat(257), 'bad\nname', 'bad\u202Ename']) {
    const label = remoteDeviceDisplayName({ name, platform: null, userAgent: '<script>alert(1)</script>' });
    assert.equal(label, 'Remote device');
    assert.ok(!/[<>\n\u202E]/.test(label));
  }
  assert.equal(describeRemoteDevice('macOS', 'Safari/605\nInjected'), 'macOS');
  assert.equal(describeRemoteDevice('macOS', 'x'.repeat(16_385)), 'macOS');
  assert.equal(describeRemoteDevice('x'.repeat(257), 'Safari/605'), 'Browser · Safari');
  assert.equal(normalizeRemoteDeviceName('  Kitchen iPad  '), 'Kitchen iPad');
  for (const name of ['', ' ', 'x'.repeat(257), 'bad\u0000name', 'bad\u202Ename']) {
    assert.throws(() => normalizeRemoteDeviceName(name), /invalid_device_name/);
  }
});

test('Remote devices persist exact V1 grants and reject extras', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    assert.deepEqual(device.grants, [...DEFAULT_REMOTE_DEVICE_GRANTS]);
    assert.equal(device.role, 'admin');
    assert.equal(device.revokedAt, null);
    assert.throws(
      () => context.runtime.devices.create({
        publicKey: '{"kty":"EC","crv":"P-256","x":"extra","y":"grant"}',
        name: 'Bad',
        platform: 'ios',
        grants: [...DEFAULT_REMOTE_DEVICE_GRANTS, 'task.create'] as never,
      }),
      /cannot receive task.create|must match/,
    );
  } finally {
    teardownRemoteHarness(context);
  }
});

test('a revoked key pairs again only as a new record, never a second active one, and audit stays redacted and bounded', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context, 'Watch');
    const publicKey = device.publicKey;
    for (const create of [context.runtime.devices.create, context.runtime.devices.createGeneration]) {
      assert.throws(() => create.call(context.runtime.devices, { publicKey, name: 'Watch twice', platform: 'ios' }),
        /already paired/);
    }
    const revoked = context.runtime.devices.revoke(device.id);
    assert.ok(revoked.revokedAt);
    assert.equal(revoked.revision, 1);
    const repaired = context.runtime.devices.createGeneration({
      publicKey,
      name: 'Watch again',
      platform: 'ios',
      cryptoConnectionId: '44444444-4444-4444-8444-444444444444',
    });
    assert.notEqual(repaired.id, device.id);
    assert.equal(repaired.revokedAt, null);
    assert.equal(repaired.revision, 0);
    assert.deepEqual(context.runtime.devices.get(device.id), revoked, 'the removed record stays revoked');
    assert.equal(context.runtime.devices.getActive(device.id), null);
    assert.equal(context.runtime.devices.findByPublicKey(publicKey)?.id, repaired.id);
    assert.throws(() => context.runtime.devices.create({ publicKey, name: 'Watch thrice', platform: 'ios' }),
      /already paired/);
    assert.throws(() => context.db.prepare(`INSERT INTO remote_devices
      (id, public_key, name, platform, role, grants_json, created_at) VALUES ('raw', ?, 'Raw', 'ios', 'admin', '[]', 'now')`)
      .run(publicKey), /UNIQUE/, 'the store itself refuses a second active record for one key');
    context.runtime.devices.revoke(repaired.id);
    assert.equal(context.runtime.devices.findByPublicKey(publicKey)?.id, repaired.id, 'the newest revoked record answers');
    const next = context.runtime.devices.createGeneration({
      publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: `${'a'.repeat(43)}=`, y: `${'b'.repeat(43)}=` }),
      name: 'Watch again',
      platform: 'ios',
      cryptoConnectionId: '33333333-3333-4333-8333-333333333333',
    });
    assert.notEqual(next.id, device.id);
    assert.equal(next.revokedAt, null);
    assert.equal(next.cryptoConnectionId, '33333333-3333-4333-8333-333333333333');

    for (let index = 0; index < 12; index += 1) {
      context.runtime.audit.write({
        deviceId: device.id,
        method: 'session.send',
        commandId: `00000000-0000-7000-8000-0000000000${String(index).padStart(2, '0')}`,
        resultCategory: 'succeeded',
      });
    }
    const entries = context.runtime.audit.list(device.id);
    assert.equal(entries.length, 12);
    for (const entry of entries) {
      const serialized = JSON.stringify(entry);
      assert.equal(serialized.includes('prompt'), false);
      assert.equal(serialized.includes('params'), false);
      assert.ok(entry.resultCategory);
      assert.ok(entry.commandId);
    }
  } finally {
    teardownRemoteHarness(context);
  }
});

test('a confirmed re-pair of a still-paired key supersedes its record, revoked and synced, leaving one active record', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context, 'Desk');
    const input = { publicKey: device.publicKey, name: 'Desk', platform: 'ios' };
    const { device: next, superseded } = context.runtime.devices.replaceGeneration({
      ...input,
      id: generateCanonicalId(),
      cryptoConnectionId: generateCanonicalId(),
    });
    assert.equal(superseded?.id, device.id);
    assert.ok(superseded?.revokedAt);
    assert.equal(superseded?.revision, device.revision + 1);
    assert.equal(context.runtime.devices.revocationSynced(device.id), true, 'the Server already replaced that pairing');
    assert.equal(next.revokedAt, null);
    assert.deepEqual(context.runtime.devices.list().filter(entry => !entry.revokedAt).map(entry => entry.id), [next.id]);

    context.runtime.devices.revoke(next.id);
    const again = context.runtime.devices.replaceGeneration({ ...input, id: generateCanonicalId() });
    assert.equal(again.superseded, null, 'a removed key supersedes nothing');
    assert.equal(context.runtime.devices.revocationSynced(next.id), false, 'an Owner removal still syncs to the Server');
    assert.throws(() => context.runtime.devices.replaceGeneration({ ...input, id: again.device.id }), /already paired/,
      'a record never supersedes itself');
    assert.equal(context.runtime.devices.getActive(again.device.id)?.id, again.device.id);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('local device rename persists safely without changing authentication or revocation', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context, 'Remote device');
    const renamed = context.runtime.renameDevice(device.id, '  Kitchen iPad  ');
    assert.equal(renamed.name, 'Kitchen iPad');
    assert.equal(renamed.nameCustomized, true);
    assert.equal(context.runtime.devices.get(device.id)!.name, 'Kitchen iPad');
    assert.equal(renamed.id, device.id);
    assert.equal(renamed.publicKey, device.publicKey);
    assert.deepEqual(renamed.grants, device.grants);
    assert.equal(renamed.revision, device.revision);
    assert.equal(renamed.revokedAt, null);
    for (const name of [' ', 'x'.repeat(257), 'bad\u0000name', 'bad\u202Ename']) {
      assert.throws(() => context.runtime.renameDevice(device.id, name), /invalid_device_name/);
    }
    assert.equal(context.runtime.devices.get(device.id)!.name, 'Kitchen iPad');

    const revoked = context.runtime.devices.revoke(device.id);
    assert.equal(revoked.revision, device.revision + 1);
    assert.equal(context.runtime.devices.getActive(device.id), null);
    const renamedAfterRevoke = context.runtime.renameDevice(device.id, 'Still revoked');
    assert.equal(renamedAfterRevoke.revokedAt, revoked.revokedAt);
    assert.equal(renamedAfterRevoke.revision, revoked.revision);
    assert.equal(context.runtime.devices.getActive(device.id), null);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('historical generic labels use saved pairing metadata without rewriting records or custom names', async () => {
  const context = setupRemoteHarness();
  try {
    const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
    await context.runtime.enrollment.recordClaim({
      hostId: generateCanonicalId(),
      serverUrl: 'https://remote.example',
      hostName: 'Test Host',
      refreshSecret: 'fixture-refresh',
      serverIdentity: { public_key: serverKey, fingerprint: await identityFingerprint(serverKey) },
    });
    const grant = context.runtime.pairings.recordServerGrant({
      grantId: generateCanonicalId(),
      code: 'K7DM-F2Q9',
      grantNonce: generateCanonicalId(),
      expiresAt: Date.now() + 60_000,
    });
    const claim = context.runtime.pairings.applyServerClaim({
      grantId: grant.grantId,
      pairingId: generateCanonicalId(),
      publicKey: serverKey,
      platform: 'macOS',
      userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/605.1.15',
    });
    const device = context.runtime.devices.createGeneration({
      id: generateCanonicalId(),
      publicKey: JSON.stringify(serverKey),
      name: 'Remote device',
      platform: 'macOS',
    });
    context.runtime.pairings.confirm(claim.id, device.id);

    let snapshot = context.runtime.settingsState();
    assert.equal(snapshot.devices[0]!.name, 'macOS · Chrome');
    assert.equal(context.runtime.devices.get(device.id)!.name, 'Remote device');

    context.runtime.renameDevice(device.id, 'Remote device');
    snapshot = context.runtime.settingsState();
    assert.equal(snapshot.devices[0]!.name, 'Remote device');
    context.runtime.renameDevice(device.id, 'My Studio');
    assert.equal(context.runtime.settingsState().devices[0]!.name, 'My Studio');

    context.runtime.devices.revoke(device.id);
    snapshot = context.runtime.settingsState();
    assert.equal(snapshot.devices[0]!.name, 'My Studio');
    assert.equal(snapshot.devices[0]!.revoke_status, 'pending-reconciliation');
    assert.equal(context.runtime.devices.getActive(device.id), null);
  } finally {
    teardownRemoteHarness(context);
  }
});

test('handshake receipts prune rows older than the signed_at freshness window', () => {
  const context = setupRemoteHarness();
  try {
    const device = seedDevice(context);
    const staleNonce = generateCanonicalId();
    const liveNonce = generateCanonicalId();
    context.db.prepare(
      `INSERT INTO remote_handshake_receipts (handshake_nonce, device_id, signed_at) VALUES (?, ?, ?)`,
    ).run(staleNonce, device.id, context.clock.nowMs - AUTH_SIGNED_AT_SKEW_MS - 1);
    assert.equal(
      context.runtime.pairings.consumeHandshakeNonce({
        handshakeNonce: liveNonce,
        deviceId: device.id,
        signedAt: context.clock.nowMs,
      }),
      true,
    );
    const stale = context.db.prepare(
      `SELECT handshake_nonce FROM remote_handshake_receipts WHERE handshake_nonce = ?`,
    ).get(staleNonce);
    const live = context.db.prepare(
      `SELECT handshake_nonce FROM remote_handshake_receipts WHERE handshake_nonce = ?`,
    ).get(liveNonce);
    assert.equal(stale, undefined);
    assert.ok(live);
  } finally {
    teardownRemoteHarness(context);
  }
});
