import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DIRECTORY_RECENT_MS, directoryListResultSchema, generateCanonicalId, identityFingerprint,
  type DirectoryListParams, type DirectoryListResult, type RemoteDirectoryEntry, type RemoteMethod,
} from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';
import type { RemoteConnector } from '../src/remote/connector.js';
import { RemoteDirectory } from '../src/remote/directory.js';
import { remoteStableUuid } from '../src/remote/projection.js';
import { command, HARNESS_AGENT, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

type Harness = ReturnType<typeof setupRemoteHarness>;
type Device = ReturnType<typeof seedDevice>;
const FEATURES = ['wire.session_directory_v1', 'wire.conversation_translation'];

function execute(h: Harness, device: Device, method: RemoteMethod, params: unknown, features: string[] = FEATURES) {
  return h.runtime.commands.execute(device, command(method, params), { wireFeatures: features });
}
async function page(h: Harness, device: Device, params: DirectoryListParams): Promise<DirectoryListResult> {
  const result = await execute(h, device, 'directory.list', params);
  assert.equal(result.ok, true, result.error?.message);
  return directoryListResultSchema.parse(result.data);
}
async function collect(h: Harness, device: Device, params: DirectoryListParams): Promise<RemoteDirectoryEntry[]> {
  const entries: RemoteDirectoryEntry[] = [];
  let cursor: string | undefined;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const result = await page(h, device, { ...params, ...(cursor ? { cursor } : {}) });
    assert.notEqual(result.state, 'cursor_invalid');
    entries.push(...result.entries);
    if (result.state === 'complete') return entries;
    assert.equal(result.state, 'incomplete');
    assert.ok(result.next_cursor);
    cursor = result.next_cursor;
  }
  throw new Error('directory continuation did not terminate');
}
function seedSession(h: Harness, options: {
  id?: string; name?: string; taskId?: string; status?: string; completedAt?: string; archived?: number; hidden?: number;
} = {}) {
  const id = options.id ?? randomUUID();
  h.db.prepare(`INSERT INTO sessions
    (id, name, workspace_id, executor, proxy_plugin_id, agent_id, type, status, task_id, completed_at, archived, hidden, native_session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, options.name ?? 'Conversation', h.workspaceId,
    'claude', HARNESS_AGENT.pluginId, HARNESS_AGENT.id, options.taskId ? 'subtask' : 'coding',
    options.status ?? 'done', options.taskId ?? null, options.completedAt ?? null, options.archived ?? 0, options.hidden ?? 0,
    `fixture-native-${id}`);
  return id;
}
function seedTurn(h: Harness, sessionId: string, timestamp: number, number = 1, text?: string) {
  const id = randomUUID();
  h.db.prepare(`INSERT INTO turns (id, session_id, turn_number, status, created_at, completed_at)
    VALUES (?, ?, ?, 'completed', ?, ?)`).run(id, sessionId, number, new Date(timestamp).toISOString(), new Date(timestamp).toISOString());
  if (text !== undefined) h.db.prepare(`INSERT INTO events (id, session_id, turn_id, call_id, type, data, created_at)
    VALUES (?, ?, ?, ?, 'user_message', ?, ?)`).run(randomUUID(), sessionId, id, `fixture-user-${number}`,
    JSON.stringify({ text }), new Date(timestamp).toISOString());
  return id;
}
async function accountlessDevice(h: Harness, name = 'Accountless phone') {
  const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
  if (!h.runtime.enrollment.current()) await h.runtime.enrollment.recordClaim({
    hostId: generateCanonicalId(), serverUrl: 'https://remote.example', hostName: 'Directory Host',
    refreshSecret: 'fixture-refresh', serverIdentity: { public_key: serverKey, fingerprint: await identityFingerprint(serverKey) },
  });
  const key = name.startsWith('Other')
    ? { kty: 'EC', crv: 'P-256', x: 'E'.repeat(43), y: 'F'.repeat(43) }
    : { kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) };
  return h.runtime.devices.create({
    publicKey: JSON.stringify(key),
    name, platform: 'ios', cryptoConnectionId: generateCanonicalId(),
  });
}

test('legacy clients stay narrow while negotiated directory expands Tasks/Repos and subscriptions', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const active = seedSession(h, { taskId: h.taskId });
    const standalone = seedSession(h);
    seedTurn(h, active, h.clock.nowMs);
    seedTurn(h, standalone, h.clock.nowMs);
    const legacy = await execute(h, device, 'state.refresh', {}, []);
    const native = await execute(h, device, 'state.refresh', {});
    assert.equal(legacy.ok, true, legacy.error?.message);
    assert.equal(native.ok, true, native.error?.message);
    const { snapshot_id: legacySnapshotId, ...legacyBody } = legacy.data as Record<string, unknown>;
    const { snapshot_id: nativeSnapshotId, ...nativeBody } = native.data as Record<string, unknown>;
    assert.equal(typeof legacySnapshotId, 'string');
    assert.equal(typeof nativeSnapshotId, 'string');
    assert.deepEqual(nativeBody, legacyBody, 'directory negotiation must not broaden legacy snapshots');
    assert.equal((await execute(h, device, 'directory.list', { view: 'repos' }, [])).error?.code, 'REMOTE_CAPABILITY_DENIED');
    assert.deepEqual((await collect(h, device, { view: 'tasks' })).map(row => row.id), [active]);
    assert.deepEqual(new Set((await collect(h, device, { view: 'repos' })).map(row => row.id)), new Set([active, standalone]));
    const subscribed = await execute(h, device, 'session.subscribe', { session_id: standalone });
    assert.equal(subscribed.ok, true, subscribed.error?.message);
    assert.deepEqual((subscribed.data as { interactions: unknown[] }).interactions, []);
    const oldSubscribe = await execute(h, device, 'session.subscribe', { session_id: active }, []);
    assert.equal(Object.hasOwn(oldSubscribe.data as object, 'interactions'), false);
    const noTask = await execute(h, device, 'session.create', { catalog_revision: h.runtime.projector.catalogRevision(),
      workspace_id: h.workspaceId, agent_id: remoteStableUuid('agent', HARNESS_AGENT.id) }, []);
    assert.equal(noTask.error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(h); }
});

test('pagination and old-body search preserve truthfulness, stable identity and exact activity boundary', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const expected = new Set<string>();
    for (let i = 0; i < 271; i += 1) expected.add(seedSession(h, { taskId: h.taskId }));
    seedSession(h, { taskId: h.taskId, archived: 1 });
    seedSession(h, { taskId: h.taskId, hidden: 1 });
    const rows = await collect(h, device, { view: 'tasks', limit: 7 });
    assert.equal(rows.length, expected.size);
    assert.deepEqual(new Set(rows.map(row => row.id)), expected);
    assert.deepEqual(rows.map(row => row.id), rows.map(row => row.id).sort());

    const id = seedSession(h, { id: '00000000-0000-4000-8000-000000000001' });
    const old = h.clock.nowMs - 60 * DIRECTORY_RECENT_MS;
    for (let n = 1; n <= 20; n += 1) seedTurn(h, id, old + n, n, n === 1 ? 'deep history needle' : 'ordinary text');
    const first = await page(h, device, { view: 'search', query: 'deep history needle' });
    assert.equal(first.state, 'incomplete');
    assert.deepEqual(first.entries, []);
    assert.ok(first.next_cursor);
    const matches = await collect(h, device, { view: 'search', query: 'deep history needle', cursor: first.next_cursor });
    assert.deepEqual(matches.map(row => row.id), [id]);

    const cutoff = h.clock.nowMs - DIRECTORY_RECENT_MS;
    const boundary = seedSession(h);
    const expired = seedSession(h, { status: 'error' });
    seedTurn(h, boundary, cutoff, 1, 'at cutoff');
    seedTurn(h, expired, cutoff - 1, 1, 'old failure');
    const recent = await collect(h, device, { view: 'repos' });
    assert.equal(recent.some(row => row.id === boundary), true);
    assert.equal(recent.some(row => row.id === expired), false);
  } finally { teardownRemoteHarness(h); }
});

test('cursors bind principal, query, grants, generation and expiry instead of silently resetting', async () => {
  const h = setupRemoteHarness();
  try {
    const device = await accountlessDevice(h);
    seedSession(h, { taskId: h.taskId }); seedSession(h, { taskId: h.taskId });
    const first = await page(h, device, { view: 'tasks', limit: 1 });
    assert.equal(first.state, 'incomplete');
    const cursor = first.next_cursor!;
    for (const params of [{ view: 'repos' as const, limit: 1, cursor }, { view: 'tasks' as const, limit: 2, cursor },
      { view: 'tasks' as const, limit: 1, cursor: cursor + 'x' }]) {
      assert.equal((await page(h, device, params)).state, 'cursor_invalid');
    }
    const other = await accountlessDevice(h, 'Other accountless phone');
    assert.notEqual(h.runtime.executions.scope(other), h.runtime.executions.scope(device));
    assert.equal((await page(h, other, { view: 'tasks', limit: 1, cursor })).state, 'cursor_invalid');
    const restarted = new RemoteDirectory({ db: h.db, sessions: h.sessions, devices: h.runtime.devices,
      executions: h.runtime.executions, hostGeneration: randomUUID(), now: () => h.clock.nowMs, negotiated: () => true });
    assert.equal(restarted.list(device, { view: 'tasks', limit: 1, cursor }, FEATURES).state, 'cursor_invalid');
    h.db.prepare('UPDATE remote_devices SET grants_json = ? WHERE id = ?').run(JSON.stringify(device.grants.filter(g => g !== 'session.create')), device.id);
    assert.equal((await page(h, h.runtime.devices.get(device.id)!, { view: 'tasks', limit: 1, cursor })).state, 'cursor_invalid');
    h.db.prepare('UPDATE remote_devices SET grants_json = ? WHERE id = ?').run(JSON.stringify(device.grants), device.id);
    h.runtime.directory.invalidate();
    assert.equal((await page(h, device, { view: 'tasks', limit: 1, cursor })).state, 'cursor_invalid');
    const fresh = await page(h, device, { view: 'tasks', limit: 1 });
    h.clock.nowMs += 5 * 60 * 1000;
    assert.equal((await page(h, device, { view: 'tasks', limit: 1, cursor: fresh.next_cursor })).state, 'cursor_invalid');
  } finally { teardownRemoteHarness(h); }
});

test('storage failure, grants, key changes and revocation never produce a falsely complete directory', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const id = seedSession(h, { taskId: h.taskId });
    seedTurn(h, id, h.clock.nowMs);
    t.mock.method(h.runtime.directory, 'assertAccess', () => { throw new Error('synthetic storage unavailable'); });
    const failed = await execute(h, device, 'directory.list', { view: 'tasks' });
    assert.equal(failed.ok, false);
    assert.equal(failed.data, undefined);
    t.mock.restoreAll();
    h.db.prepare('UPDATE remote_devices SET grants_json = ? WHERE id = ?').run('[]', device.id);
    assert.equal((await execute(h, device, 'directory.list', { view: 'tasks' })).error?.code, 'REMOTE_CAPABILITY_DENIED');
    h.db.prepare('UPDATE remote_devices SET grants_json = ?, public_key = ? WHERE id = ?').run(JSON.stringify(device.grants), 'rotated-fixture-key', device.id);
    assert.equal((await execute(h, device, 'directory.list', { view: 'tasks' })).error?.code, 'DEVICE_NOT_PAIRED');
    h.db.prepare('UPDATE remote_devices SET public_key = ?, revoked_at = ? WHERE id = ?').run(device.publicKey, new Date().toISOString(), device.id);
    assert.equal((await execute(h, device, 'directory.list', { view: 'tasks' })).error?.code, 'DEVICE_REVOKED');
  } finally { teardownRemoteHarness(h); }
});

test('concurrent opted-in and legacy commands do not share expanded policy', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const id = seedSession(h);
    const results = await Promise.all([FEATURES, []].map(features => h.runtime.directory.run(device.id, features, async () => {
      await Promise.resolve();
      return h.runtime.directory.negotiated(device.id);
    })));
    assert.deepEqual(results, [true, false]);
    const [native, legacy] = await Promise.all([
      execute(h, device, 'translation.state', { session_id: id }),
      execute(h, device, 'translation.state', { session_id: id }, ['wire.conversation_translation']),
    ]);
    assert.equal(native.ok, true);
    assert.equal(legacy.ok, false);
  } finally { teardownRemoteHarness(h); }
});

test('accountless device principal scopes directory, export ownership and live hints without GitHub', async () => {
  const h = setupRemoteHarness();
  try {
    const native = await accountlessDevice(h);
    const other = await accountlessDevice(h, 'Other accountless phone');
    const id = seedSession(h, { id: '00000000-0000-4000-8000-000000000002', taskId: h.taskId });
    seedSession(h, { taskId: h.taskId });
    seedTurn(h, id, h.clock.nowMs);
    const first = await page(h, native, { view: 'tasks', limit: 1 });
    assert.equal(first.entries[0]?.id, id);
    assert.equal(first.state, 'incomplete');
    assert.ok(first.next_cursor);
    assert.equal((await page(h, other, { view: 'tasks', limit: 1, cursor: first.next_cursor })).state, 'cursor_invalid');

    const created = await execute(h, native, 'execution.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    });
    assert.equal(created.ok, true, created.error?.message);
    const execution = created.data as { id: string };
    const nativeExports = await execute(h, native, 'execution.list', {});
    const otherExports = await execute(h, other, 'execution.list', {});
    assert.equal(nativeExports.ok, true, nativeExports.error?.message);
    assert.equal(otherExports.ok, true, otherExports.error?.message);
    assert.equal((nativeExports.data as { sessions: Array<{ id: string }> }).sessions.some(row => row.id === execution.id), true);
    assert.equal((otherExports.data as { sessions: Array<{ id: string }> }).sessions.some(row => row.id === execution.id), false);
    assert.equal((await execute(h, other, 'session.page', { session_id: execution.id })).ok, false);

    const nativeMessages: object[] = [];
    const oldMessages: object[] = [];
    const connectors = (h.runtime as unknown as { connectors: Map<string, RemoteConnector> }).connectors;
    const fake = (messages: object[], features: string[]) => ({
      supportsFeature: (feature: string) => features.includes(feature),
      sendControl: async (message: object) => { messages.push(message); },
      sendTranscript: (message: object) => { messages.push(message); }, close() {},
    }) as unknown as RemoteConnector;
    connectors.set(native.id, fake(nativeMessages, FEATURES));
    connectors.set(other.id, fake(oldMessages, []));
    await execute(h, native, 'session.subscribe', { session_id: id });
    const sequence = h.runtime.replay.eventSequence;
    const event: EventEnvelope = { session_id: id, turn: 1, call_id: 'fixture-message', ts: h.clock.nowMs,
      provider: 'claude', event: 'user_message', data: { text: 'same text is not an identity' } };
    h.runtime.observeHostBroadcast({ type: 'event', ...event });
    await Promise.resolve();
    assert.equal(h.runtime.replay.eventSequence, sequence);
    assert.ok(nativeMessages.some(message => (message as { type: string }).type === 'directory.changed'));
    assert.ok(nativeMessages.some(message => (message as { event?: { kind: string } }).event?.kind === 'transcript.item'));
    assert.equal(oldMessages.length, 0);
    assert.ok(nativeMessages.every(message => (message as { type: string }).type !== 'directory.changed' || !Object.hasOwn(message, 'event_sequence')));
    h.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id);
    nativeMessages.length = 0;
    h.runtime.observeHostBroadcast({ type: 'event', ...event });
    await Promise.resolve();
    assert.equal(nativeMessages.some(message => (message as { event?: { kind: string } }).event?.kind === 'transcript.item'), false);
  } finally { teardownRemoteHarness(h); }
});

test('legacy foreign exports remain closed even after a directory feature is negotiated', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const id = seedSession(h, { taskId: h.taskId });
    seedTurn(h, id, h.clock.nowMs);
    h.db.prepare('INSERT INTO remote_execution_exports (session_id, account_id, stream_id, created_at) VALUES (?, ?, ?, ?)')
      .run(id, 'different-account', randomUUID(), 0);
    assert.equal((await collect(h, device, { view: 'tasks' })).length, 0);
    for (const method of ['session.subscribe', 'session.page', 'translation.state'] as const) {
      assert.equal((await execute(h, device, method, { session_id: id })).ok, false);
    }
    h.db.prepare('UPDATE remote_execution_exports SET account_id = ? WHERE session_id = ?').run(device.accountId, id);
    assert.equal((await execute(h, device, 'session.page', { session_id: id })).ok, true);
    assert.equal((await execute(h, device, 'translation.state', { session_id: id })).error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(h); }
});
