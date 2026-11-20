import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bytesToBase64Url, generateCanonicalId, MAX_CONCURRENT_TRANSFERS_PER_DEVICE, RemoteProtocolError,
  type RemoteErrorCode, type RemoteMethod } from '@gian/remote-protocol';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import type { RemoteControllerClient, RemoteControllerEnvironment } from '../src/remote/controller-client.js';
import { RemoteControllerHub } from '../src/remote/controller-hub.js';
import { RemoteAttachmentCache, type RemoteAttachmentKey } from '../src/remote/controller-attachment-cache.js';
import { setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

type Harness = ReturnType<typeof setupRemoteHarness>;
type Mock = { mock: { method: (...args: never[]) => unknown } };
type Message = Record<string, unknown>;
/** How the fake Host answers one download request. */
type Answer = 'complete' | 'hold' | 'bad-digest' | { partial: 'close' | RemoteErrorCode } | { refuse: RemoteErrorCode };

const deviceKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'C'.repeat(43), y: 'D'.repeat(43) };

function hubFor(f: Harness) {
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity, undefined, f.dir);
  // Retries wait milliseconds here, not seconds.
  (hub as unknown as { transferRetryDelays: number[] }).transferRetryDelays = [1, 1];
  return hub;
}

/** A paired environment with mirrored sessions, bound by device key. */
function environmentWithSessions(f: Harness, hub: RemoteControllerHub, count = 1) {
  const environment: RemoteControllerEnvironment = {
    id: generateCanonicalId(), name: 'Studio Mac', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
    host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: generateCanonicalId(),
    device_public_key_json: JSON.stringify(deviceKey), crypto_connection_id: generateCanonicalId(),
    host_public_key_json: null, pairing_id: null, created_at: Date.now(),
  };
  f.db.prepare(`INSERT INTO remote_controller_environments
    (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, device_id,
      device_public_key_json, crypto_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
      environment.host_id, environment.browser_id, environment.device_id, environment.device_public_key_json,
      environment.crypto_connection_id, environment.created_at);
  const sessions = Array.from({ length: count }, () => {
    const localId = generateCanonicalId();
    const remoteId = generateCanonicalId();
    f.db.prepare(`INSERT INTO sessions
      (id, executor, native_session_id, remote_environment_id, remote_repository_id, remote_repository_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(localId, 'claude', generateCanonicalId(), environment.id, f.workspaceId, 'Remote test');
    hub.bindings.bind({ local_session_id: localId, target: {
      target_version: 2, server_origin: environment.server_origin, server_identity_fingerprint: environment.server_identity_fingerprint,
      host_id: environment.host_id, remote_session_id: remoteId, device_id: environment.device_id!,
      device_public_key: deviceKey, crypto_connection_id: environment.crypto_connection_id!,
    } });
    return { localId, remoteId };
  });
  return { environment, sessions };
}

function bytesOf(reference: string): Uint8Array {
  return new TextEncoder().encode(`bytes of ${reference} `.repeat(4));
}

/**
 * The execution Host behind the hub's client for one environment: it
 * resolves `attachment:` references and serves downloads the way the real
 * connector does, refusing more than MAX_CONCURRENT_TRANSFERS_PER_DEVICE at
 * once with RATE_LIMITED. `answers` scripts the next download requests.
 */
function fakeHost(hub: RemoteControllerHub, t: Mock, environment: RemoteControllerEnvironment) {
  const state = {
    connected: false, resolves: 0, active: 0, maxActive: 0, refusedBusy: 0,
    downloads: [] as string[], answers: [] as Answer[], held: [] as Array<() => Promise<void>>,
    listeners: new Set<(message: Message) => unknown>(), watchers: new Set<() => void>(),
    missing: new Set<string>(),
  };
  const handles = new Map<string, string>();
  const deliver = async (message: Message) => { for (const listener of [...state.listeners]) await listener(message); };
  const close = () => {
    state.connected = false;
    const watchers = [...state.watchers];
    state.watchers.clear();
    for (const watcher of watchers) watcher();
  };
  const serve = async (transfer_id: string, reference: string, answer: Answer) => {
    const bytes = bytesOf(reference);
    const sha256 = createHash('sha256').update(answer === 'bad-digest' ? new Uint8Array([1]) : bytes).digest('hex');
    const half = Math.floor(bytes.length / 2);
    await deliver({ type: 'download.metadata', transfer_id, name: reference.slice('attachment:'.length), mime: 'image/png',
      size: bytes.length, sha256, disposition: 'inline', preview: true });
    await deliver({ type: 'attachment.chunk', transfer_id, transfer_sequence: 0, offset: 0, bytes: bytesToBase64Url(bytes.subarray(0, half)) });
    if (typeof answer === 'object' && 'partial' in answer) {
      if (answer.partial === 'close') close();
      else await deliver({ type: 'transfer.error', transfer_id, code: answer.partial, message: 'failed part-way' });
      return;
    }
    await deliver({ type: 'attachment.chunk', transfer_id, transfer_sequence: 1, offset: half, bytes: bytesToBase64Url(bytes.subarray(half)) });
    await deliver({ type: 'download.complete', transfer_id, size: bytes.length, sha256 });
  };
  (t.mock.method as unknown as (target: object, key: string, fn: unknown) => void)(hub, 'createClient', () => ({
    environment,
    get connected() { return state.connected; },
    async connect() { state.connected = true; },
    close, retire: close,
    supports: (feature: string) => feature === 'wire.device_execution_target',
    onControl(listener: (message: Message) => unknown) { state.listeners.add(listener); return () => state.listeners.delete(listener); },
    onClose(listener: () => void) {
      if (!state.connected) { queueMicrotask(listener); return () => {}; }
      state.watchers.add(listener);
      return () => state.watchers.delete(listener);
    },
    async request(method: RemoteMethod, params: { reference: string; session_id: string }) {
      assert.equal(method, 'file.resolve');
      state.resolves += 1;
      if (state.missing.has(params.reference)) throw new RemoteProtocolError('RESOURCE_NOT_FOUND', 'file not found');
      const id = generateCanonicalId();
      handles.set(id, params.reference);
      return { id, reference: params.reference, session_id: params.session_id, name: params.reference.slice('attachment:'.length),
        mime: 'image/png', size: bytesOf(params.reference).length, revision: 'r1', previewable: true, downloadable: true,
        expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    },
    async sendControl(message: { type: string; transfer_id: string; handle_id: string }) {
      if (message.type !== 'download.request') return;
      const reference = handles.get(message.handle_id)!;
      setTimeout(() => void (async () => {
        if (state.active >= MAX_CONCURRENT_TRANSFERS_PER_DEVICE) {
          state.refusedBusy += 1;
          await deliver({ type: 'transfer.error', transfer_id: message.transfer_id, code: 'RATE_LIMITED', message: 'busy' });
          return;
        }
        state.downloads.push(reference);
        state.active += 1;
        state.maxActive = Math.max(state.maxActive, state.active);
        const answer = state.answers.shift() ?? 'complete';
        const finish = async () => {
          try {
            if (typeof answer === 'object' && 'refuse' in answer) {
              await deliver({ type: 'transfer.error', transfer_id: message.transfer_id, code: answer.refuse, message: 'refused' });
            } else await serve(message.transfer_id, reference, answer === 'hold' ? 'complete' : answer);
          } finally { state.active -= 1; }
        };
        if (answer === 'hold') state.held.push(finish); else await finish();
      })(), 0);
    },
  }) as unknown as RemoteControllerClient);
  return state;
}

async function until(check: () => boolean, message = 'condition timed out') {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function cachedFiles(f: Harness, environmentId: string, localId: string): string[] {
  const directory = join(f.dir, 'remote-cache', 'attachments', environmentId, localId);
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

test('an attachment downloads once, then comes from disk without the relay, also after removal and a restart', async t => {
  const f = setupRemoteHarness();
  const hub = hubFor(f);
  try {
    const { environment, sessions: [session] } = environmentWithSessions(f, hub);
    const host = fakeHost(hub, t, environment);
    const first = await hub.readAttachment(session!.localId, 'attachment:shot.png');
    assert.deepEqual([...first.bytes], [...bytesOf('attachment:shot.png')]);
    assert.equal(first.mime, 'image/png');
    assert.equal(first.sha256, createHash('sha256').update(first.bytes).digest('hex'));
    assert.deepEqual([host.resolves, host.downloads.length], [1, 1]);
    assert.equal(cachedFiles(f, environment.id, session!.localId).length, 2, 'bytes and their record');

    host.connected = false;
    const again = await hub.readAttachment(session!.localId, 'attachment:shot.png');
    assert.deepEqual([...again.bytes], [...first.bytes]);
    assert.deepEqual([host.resolves, host.downloads.length, host.connected], [1, 1, false], 'a hit never touches the relay');

    // Concurrent requests for one attachment share its download.
    const shared = await Promise.all([1, 2, 3].map(() => hub.readAttachment(session!.localId, 'attachment:other.png')));
    assert.equal(new Set(shared.map(item => item.sha256)).size, 1);
    assert.deepEqual([host.resolves, host.downloads.length], [2, 2]);

    assert.equal(hub.removeEnvironment(environment.id), true);
    assert.deepEqual([...(await hub.readAttachment(session!.localId, 'attachment:shot.png')).bytes], [...first.bytes],
      'a removed environment\'s history keeps its images');
    await assert.rejects(hub.readAttachment(session!.localId, 'attachment:never.png'), { code: 'REMOTE_CAPABILITY_DENIED' });

    // A restarted Host process reads what the earlier one kept.
    const restarted = hubFor(f);
    try {
      assert.deepEqual([...(await restarted.readAttachment(session!.localId, 'attachment:other.png')).bytes],
        [...bytesOf('attachment:other.png')]);
      assert.equal(host.downloads.length, 2);
    } finally { restarted.close(); }
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('downloads past the Host\'s per-device limit wait their turn, first come first served, instead of failing', async t => {
  const f = setupRemoteHarness();
  const hub = hubFor(f);
  try {
    const { environment, sessions: [session] } = environmentWithSessions(f, hub);
    const host = fakeHost(hub, t, environment);
    const count = MAX_CONCURRENT_TRANSFERS_PER_DEVICE + 2;
    host.answers = Array.from({ length: count }, () => 'hold');
    const references = Array.from({ length: count }, (_, index) => `attachment:image-${index}.png`);
    const reads = references.map(reference => hub.readAttachment(session!.localId, reference));
    await until(() => host.downloads.length === MAX_CONCURRENT_TRANSFERS_PER_DEVICE);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(host.downloads.length, MAX_CONCURRENT_TRANSFERS_PER_DEVICE, 'the fifth waits for a slot');
    assert.equal(host.refusedBusy, 0);

    await host.held.shift()!();
    await until(() => host.downloads.length === MAX_CONCURRENT_TRANSFERS_PER_DEVICE + 1);
    assert.equal(host.downloads.at(-1), references[MAX_CONCURRENT_TRANSFERS_PER_DEVICE], 'in request order');
    while (host.downloads.length < count || host.held.length) {
      await until(() => host.held.length > 0);
      await host.held.shift()!();
    }
    const results = await Promise.all(reads);
    results.forEach((result, index) => assert.deepEqual([...result.bytes], [...bytesOf(references[index]!)]));
    assert.deepEqual([host.maxActive, host.refusedBusy], [MAX_CONCURRENT_TRANSFERS_PER_DEVICE, 0]);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a transient failure is retried, a missing or damaged attachment is not, and nothing partial is kept', async t => {
  const f = setupRemoteHarness();
  const hub = hubFor(f);
  try {
    const { environment, sessions: [session] } = environmentWithSessions(f, hub);
    const host = fakeHost(hub, t, environment);
    const id = session!.localId;
    const files = () => cachedFiles(f, environment.id, id);

    // The Host refuses (busy), then the relay drops part-way: both retried.
    host.answers = [{ refuse: 'RATE_LIMITED' }, { partial: 'close' }, 'complete'];
    assert.deepEqual([...(await hub.readAttachment(id, 'attachment:a.png')).bytes], [...bytesOf('attachment:a.png')]);
    assert.equal(host.downloads.length, 3);
    assert.equal(files().length, 2);

    // Not found after part of the bytes: final, and nothing is kept.
    host.answers = [{ partial: 'ATTACHMENT_NOT_FOUND' }];
    await assert.rejects(hub.readAttachment(id, 'attachment:b.png'), { code: 'ATTACHMENT_NOT_FOUND' });
    assert.equal(host.downloads.length, 4, 'not retried');
    host.answers = ['bad-digest'];
    await assert.rejects(hub.readAttachment(id, 'attachment:c.png'), { code: 'INVALID_FRAME' });
    assert.equal(host.downloads.length, 5, 'a digest mismatch is not retried');
    host.answers = [{ refuse: 'REMOTE_CAPABILITY_DENIED' }];
    await assert.rejects(hub.readAttachment(id, 'attachment:d.png'), { code: 'REMOTE_CAPABILITY_DENIED' });
    assert.equal(host.downloads.length, 6, 'a denial is not retried');
    host.missing.add('attachment:e.png');
    await assert.rejects(hub.readAttachment(id, 'attachment:e.png'), { code: 'RESOURCE_NOT_FOUND' });
    assert.equal(host.resolves, 7, 'an unresolvable reference is not retried');
    assert.equal(files().length, 2, 'only the complete download is on disk');
    assert.equal(hub.attachmentCache.size, bytesOf('attachment:a.png').length);

    // Three transient failures in a row give up with the last one.
    host.answers = [{ refuse: 'RATE_LIMITED' }, { refuse: 'RATE_LIMITED' }, { refuse: 'RATE_LIMITED' }];
    await assert.rejects(hub.readAttachment(id, 'attachment:b.png'), { code: 'RATE_LIMITED' });
    assert.equal(host.downloads.length, 9);

    // A later reload downloads what failed before.
    assert.deepEqual([...(await hub.readAttachment(id, 'attachment:b.png')).bytes], [...bytesOf('attachment:b.png')]);
    assert.equal(files().length, 4);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('deleting a mirrored session evicts its cached attachments and leaves other sessions\' alone', async t => {
  const f = setupRemoteHarness();
  const hub = hubFor(f);
  try {
    const { environment, sessions: [deleted, kept] } = environmentWithSessions(f, hub, 2);
    fakeHost(hub, t, environment);
    await hub.readAttachment(deleted!.localId, 'attachment:a.png');
    await hub.readAttachment(kept!.localId, 'attachment:a.png');
    assert.equal(cachedFiles(f, environment.id, deleted!.localId).length, 2);
    f.sessions.setRemoteController(hub);
    await f.sessions.deleteSession(deleted!.localId);
    assert.equal(existsSync(join(f.dir, 'remote-cache', 'attachments', environment.id, deleted!.localId)), false);
    assert.equal(cachedFiles(f, environment.id, kept!.localId).length, 2);
    assert.equal(hub.attachmentCache.size, bytesOf('attachment:a.png').length);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('the cache keeps to its caps least recently used first and sweeps interrupted writes and orphans', async () => {
  const f = setupRemoteHarness();
  try {
    const root = join(f.dir, 'cache');
    const environmentId = generateCanonicalId();
    const live = generateCanonicalId();
    const gone = generateCanonicalId();
    const key = (reference: string, localSessionId = live): RemoteAttachmentKey =>
      ({ environmentId, localSessionId, remoteSessionId: 'remote', reference });
    const value = (size: number) => {
      const bytes = new Uint8Array(size).fill(size);
      return { bytes, name: 'file.png', mime: 'image/png', sha256: createHash('sha256').update(bytes).digest('hex') };
    };
    const cache = new RemoteAttachmentCache(() => root, (_environment, session) => session === live, { totalBytes: 10, fileBytes: 6 });
    await cache.put(key('a'), value(4));
    await cache.put(key('b'), value(4));
    assert.ok(await cache.get(key('a')), 'a is now the most recently used');
    await cache.put(key('c'), value(4));
    assert.equal(await cache.get(key('b')), null, 'the least recently used goes past the total cap');
    assert.ok(await cache.get(key('a')));
    assert.ok(await cache.get(key('c')));
    await cache.put(key('big'), value(7));
    assert.equal(await cache.get(key('big')), null, 'larger than one entry may be');
    await cache.put(key('wrong'), { ...value(2), sha256: 'f'.repeat(64) });
    assert.equal(await cache.get(key('wrong')), null, 'bytes that do not match their digest are not kept');
    assert.equal(cache.size, 8);

    await cache.put(key('orphan', gone), value(2));
    const directory = join(root, environmentId, live);
    writeFileSync(join(directory, 'interrupted.1234.tmp'), 'partial');
    writeFileSync(join(directory, 'f'.repeat(64) + '.bin'), 'bytes without a record');
    mkdirSync(join(root, 'not-an-environment'), { recursive: true });
    const reopened = new RemoteAttachmentCache(() => root, (_environment, session) => session === live, { totalBytes: 10, fileBytes: 6 });
    assert.ok(await reopened.get(key('a')));
    assert.equal(reopened.size, 8);
    assert.equal(readdirSync(directory).length, 4, 'two entries remain, leftovers are swept');
    assert.equal(existsSync(join(root, environmentId, gone)), false, 'a session that no longer exists is swept');
    assert.equal(existsSync(join(root, 'not-an-environment')), false);
  } finally { teardownRemoteHarness(f); }
});
