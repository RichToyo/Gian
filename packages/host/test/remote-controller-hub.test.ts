import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, generateCanonicalId, identityFingerprint, RemoteProtocolError, type DeviceRelayClientOptions,
  type RemoteMethod } from '@gian/remote-protocol';
import type { ApprovalRequestedData, AttentionMessage, EventEnvelope, RemoteEnvironmentStatus, ServerToClientMessage } from '@gian/shared';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import { RemoteControllerClient, type RemoteConnectionHooks, type RemoteControllerEnvironment } from '../src/remote/controller-client.js';
import { RemoteControllerHub, RemoteEnvironmentRemovedError, RemoteServerIdentityChangedError, localInteractionId,
  remoteHistoryEvent } from '../src/remote/controller-hub.js';
import { localRemoteTurnId } from '../src/remote/execution-journal.js';
import { remoteActionId, remoteInteractionResourceId } from '../src/remote/projection.js';
import { InboxService } from '../src/inbox/service.js';
import { SessionInboxAdapter } from '../src/inbox/session-adapter.js';
import { publishFreshSessionAttention } from '../src/session/attention.js';
import { applyEnvelope } from '../../web/src/transcript/apply.js';
import type { TranscriptItem } from '../../web/src/types.js';
import { command, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('background synchronization backs off for a full rate-limit window', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const id = generateCanonicalId();
    f.db.prepare('INSERT INTO sessions (id, executor, native_session_id) VALUES (?, ?, ?)')
      .run(id, 'codex', generateCanonicalId());
    hub.bindings.bind({ local_session_id: id, target: {
      server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      account_id: '42', host_id: generateCanonicalId(), remote_session_id: generateCanonicalId(),
    } });
    let calls = 0;
    t.mock.method(hub, 'sync', async () => { calls += 1; throw new RemoteProtocolError('RATE_LIMITED', 'limited'); });
    hub.start();
    const deadline = Date.now() + 5_000;
    const schedule = (hub as unknown as { scheduled: Map<string, { next: number }> }).scheduled;
    while (!schedule.has(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    const next = schedule.get(id)?.next ?? 0;
    assert.ok(next - Date.now() > 58_000, 'rate-limited synchronization backs off for one minute');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('Remote ownership probes let local Side Chat sends through without weakening binding validation', async () => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const sidechatId = `sc_${generateCanonicalId()}`;
    assert.equal(hub.owns(sidechatId), false);
    assert.equal(hub.owns('local-session'), false);
    assert.equal(hub.owns(generateCanonicalId()), false);
    assert.equal(await hub.handleMessage({ type: 'message:send', session_id: sidechatId, text: 'Side Chat' }), false);
    assert.equal(await hub.handleMessage({ type: 'session:stop', session_id: sidechatId }), false);
    assert.equal(await hub.handleMessage({ type: 'queue:send_now', session_id: sidechatId }), false);
    assert.throws(() => hub.bindings.get(sidechatId), /closed schema validation/);

    const localId = generateCanonicalId();
    f.db.prepare('INSERT INTO sessions (id, executor, native_session_id) VALUES (?, ?, ?)')
      .run(localId, 'codex', generateCanonicalId());
    hub.bindings.bind({ local_session_id: localId, target: {
      server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      account_id: '42', host_id: generateCanonicalId(), remote_session_id: generateCanonicalId(),
    } });
    assert.equal(hub.owns(localId), true);
    f.db.prepare('UPDATE remote_execution_bindings SET host_id = ? WHERE local_session_id = ?').run('invalid', localId);
    assert.throws(() => hub.owns(localId), /closed schema validation/);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('native send retries reuse a durable command and never execute twice after a lost sync response', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const seeded = seedDevice(f);
    f.runtime.devices.bindAccount(seeded.id, '42');
    const device = f.runtime.devices.get(seeded.id)!;
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, device);
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Remote test', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: device.id,
      device_public_key_json: device.publicKey,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.created_at);
    const localId = generateCanonicalId();
    f.db.prepare(`INSERT INTO sessions
      (id, executor, native_session_id, task_id, remote_environment_id, remote_repository_id, remote_repository_name)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(localId, 'claude', generateCanonicalId(), f.taskId, environment.id, f.workspaceId, 'Remote test');
    hub.bindings.bind({ local_session_id: localId, target: {
      target_version: 2, server_origin: environment.server_origin,
      server_identity_fingerprint: environment.server_identity_fingerprint,
      host_id: environment.host_id, remote_session_id: remote.id,
      device_id: device.id, device_public_key: JSON.parse(device.publicKey),
      crypto_connection_id: environment.crypto_connection_id!,
    } });
    t.mock.method(f.identity, 'getAccountSession', async () => {
      throw new Error('GitHub must not be consulted for a device execution');
    });
    let sends = 0;
    let loseSync = false;
    const commands: string[] = [];
    t.mock.method(hub, 'client', () => ({ environment, connected: true,
      async connect() {},
      supports(feature: string) { return feature === 'wire.device_execution_target'; },
      async request(method: string, params: { after?: number; stream_id?: string }, commandId: string) {
        if (method === 'execution.sync') {
          if (loseSync) throw new RemoteProtocolError('HOST_OFFLINE', 'lost response');
          return f.runtime.executions.sync(device, { session_id: remote.id, after: params.after ?? 0, stream_id: params.stream_id });
        }
        assert.equal(method, 'session.send');
        sends += 1; commands.push(commandId);
        loseSync = true;
        return { session: f.runtime.projector.projectSession(remote) };
      },
    }) as unknown as RemoteControllerClient);
    await hub.sync(localId);
    const input = { type: 'message:send' as const, session_id: localId, request_id: generateCanonicalId(), text: 'Run once' };
    await assert.rejects(hub.handleMessage(input), /lost response/);
    assert.equal(sends, 1);
    loseSync = false;
    await hub.handleMessage(input);
    assert.equal(sends, 1);
    assert.match(commands[0]!, /^[0-9a-f-]{36}$/);
    assert.ok(hub.bindings.get(localId)?.execution_started_at);
    await assert.rejects(hub.handleMessage({ ...input, text: 'Different operation' }), /request changed/);
    assert.equal(f.sessions.getSession(localId).task_id, f.taskId);
    assert.equal(f.sessions.getSession(remote.id).task_id, null);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('accountless controller creates, reads, catalogs and takes over through the real Host adapter', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
    const hostId = generateCanonicalId();
    const serverOrigin = 'https://remote.example';
    const serverFingerprint = await identityFingerprint(serverKey);
    await f.runtime.enrollment.recordClaim({ hostId, serverUrl: serverOrigin, hostName: 'Execution Host',
      refreshSecret: 'fixture-refresh', serverIdentity: { public_key: serverKey, fingerprint: serverFingerprint } });
    const device = f.runtime.devices.create({
      publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }),
      name: 'Accountless Desktop', platform: 'desktop', cryptoConnectionId: generateCanonicalId(),
    });
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Device environment', server_origin: serverOrigin,
      server_identity_fingerprint: serverFingerprint, host_id: hostId, browser_id: generateCanonicalId(),
      device_id: device.id, device_public_key_json: device.publicKey,
      crypto_connection_id: device.cryptoConnectionId, host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, device_id,
        device_public_key_json, crypto_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.device_id, environment.device_public_key_json,
        environment.crypto_connection_id, environment.created_at);
    t.mock.method(f.identity, 'getAccountSession', async () => {
      throw new Error('GitHub must not be consulted for device execution');
    });
    t.mock.method(hub, 'client', () => ({ environment, connected: true,
      async connect() {},
      supports(feature: string) { return feature === 'wire.device_execution_target'; },
      async request(method: RemoteMethod, params: unknown, commandId?: string) {
        const result = await f.runtime.commands.execute(device, command(method, params, commandId), {
          wireFeatures: ['wire.device_execution_target'],
        });
        if (!result.ok) throw new RemoteProtocolError(result.error!.code as 'UNKNOWN_OUTCOME', result.error!.message);
        return result.data;
      },
    }) as unknown as RemoteControllerClient);

    const catalog = await hub.catalog(environment.id);
    const workspace = catalog.workspaces.find(item => item.id === f.workspaceId)!;
    const agent = catalog.agents.find(item => item.readiness === 'ready')!;
    const created = await hub.create({ environment_id: environment.id, workspace_id: workspace.id,
      agent_id: agent.id, name: 'Created without GitHub' }, generateCanonicalId());
    const binding = hub.bindings.get(created.id)!;
    assert.equal('target_version' in binding.target && binding.target.target_version, 2);
    assert.equal('account_id' in binding.target, false);
    assert.equal((await hub.listExecutions(environment.id)).sessions[0]?.id, binding.target.remote_session_id);
    assert.ok(await hub.agentCatalog(environment.id, agent.id));
    const sessionCount = (f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count;
    const taken = await hub.takeOver(environment.id, binding.target.remote_session_id);
    assert.equal(taken.id, created.id);
    assert.equal((f.db.prepare('SELECT COUNT(*) AS count FROM sessions').get() as { count: number }).count, sessionCount);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('removeEnvironment retires the client and keeps the row as removed until Restore', async () => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Remote test', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: null,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.created_at);
    assert.equal(hub.listEnvironments()[0]!.status, 'idle', 'no session yet is not reported as offline');
    const client = hub.client(environment.id);

    assert.equal(hub.removeEnvironment(environment.id), true);
    const removedAt = (f.db.prepare('SELECT removed_at FROM remote_controller_environments WHERE id = ?')
      .get(environment.id) as { removed_at: number }).removed_at;
    assert.ok(removedAt > 0);
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, item.removed_at, item.connected]), [['removed', removedAt, false]]);
    await assert.rejects(client.connect(), /remote environment removed/, 'a caller still holding the client cannot reconnect it');
    assert.equal(hub.removeEnvironment(environment.id), true, 'removing again is a no-op');
    assert.equal((f.db.prepare('SELECT removed_at FROM remote_controller_environments WHERE id = ?')
      .get(environment.id) as { removed_at: number }).removed_at, removedAt);
    assert.equal(hub.removeEnvironment(generateCanonicalId()), false);
    assert.equal(hub.restoreEnvironment(generateCanonicalId()), false);

    assert.equal(hub.restoreEnvironment(environment.id), true);
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, item.removed_at]), [['connecting', null]],
      'a restored environment is owed a connection');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('broadcastEnvironments pushes the connectivity snapshot only when it flips', () => {
  const f = setupRemoteHarness();
  const sent: Array<{ type: string; environments: Array<{ id: string; connected: boolean }> }> = [];
  const hub = new RemoteControllerHub(
    f.db,
    { broadcast(message: unknown) { sent.push(message as never); } } as unknown as WsBroadcaster,
    f.identity,
  );
  try {
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Remote test', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: null,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.created_at);

    hub.broadcastEnvironments();
    hub.broadcastEnvironments();
    assert.equal(sent.length, 1, 'an unchanged snapshot is deduped');
    assert.deepEqual(sent[0], { type: 'remote:environments', environments: [{
      id: environment.id, name: environment.name, host_id: environment.host_id,
      server_origin: environment.server_origin, pending: false, connected: false,
      status: 'idle', removed_at: null, last_seen_at: null,
    }] });

    // Connectivity flip → exactly one new push per direction.
    const client = hub.client(environment.id);
    const relaySlot = client as unknown as { relay: { isOpen: boolean; close(): void } | null };
    relaySlot.relay = { isOpen: true, close() { this.isOpen = false; } };
    hub.broadcastEnvironments();
    assert.equal(sent.length, 2);
    assert.equal(sent[1]!.environments[0]!.connected, true);
    relaySlot.relay = null;
    hub.broadcastEnvironments();
    assert.equal(sent.length, 3);
    assert.equal(sent[2]!.environments[0]!.connected, false);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('sync failure path broadcasts the environments snapshot (deduped on repeat)', async t => {
  const f = setupRemoteHarness();
  const sent: Array<{ type: string }> = [];
  const hub = new RemoteControllerHub(
    f.db,
    { broadcast(message: unknown) { sent.push(message as never); } } as unknown as WsBroadcaster,
    f.identity,
  );
  try {
    const environment: RemoteControllerEnvironment = {
      id: generateCanonicalId(), name: 'Remote test', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: null,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
    };
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
        environment.host_id, environment.browser_id, environment.created_at);
    const localId = generateCanonicalId();
    f.db.prepare(`INSERT INTO sessions
      (id, executor, native_session_id, remote_environment_id, remote_repository_id, remote_repository_name)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .run(localId, 'claude', generateCanonicalId(), environment.id, generateCanonicalId(), 'Remote test');
    hub.bindings.bind({ local_session_id: localId, target: { server_origin: environment.server_origin,
      server_identity_fingerprint: environment.server_identity_fingerprint, account_id: '42',
      host_id: environment.host_id, remote_session_id: generateCanonicalId() } });
    await f.identity.setAccountSession(environment.server_origin, { role: 'controller', serverOrigin: environment.server_origin,
      serverFingerprint: environment.server_identity_fingerprint, installationId: generateCanonicalId(), accountId: '42',
      accountLogin: 'owner', token: 'fixture-only', expiresAt: Date.now() + 60_000 }, 'controller');
    t.mock.method(hub, 'client', () => ({ environment, connected: false,
      async connect() {},
      supports() { return false; },
      async request() { throw new RemoteProtocolError('HOST_OFFLINE', 'remote connection lost'); },
    }) as unknown as RemoteControllerClient);

    await assert.rejects(hub.sync(localId), /remote connection lost/);
    const pushes = sent.filter(message => message.type === 'remote:environments');
    assert.equal(pushes.length, 1, 'the sync failure path pushes the connectivity snapshot');
    assert.deepEqual((pushes[0] as unknown as { environments: RemoteEnvironmentStatus[] }).environments
      .map(item => [item.status, item.last_error]), [['offline', { status: 'offline' }]], 'Settings shows why it is offline');

    await assert.rejects(hub.sync(localId), /remote connection lost/);
    assert.equal(sent.filter(message => message.type === 'remote:environments').length, 1,
      'a repeated failure with unchanged connectivity does not re-broadcast');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a new native pairing cannot bypass local Server admission', async () => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    await assert.rejects(hub.pair({ origin: 'https://remote.test', code: 'ABCD-EFGH', name: 'Other Mac' }),
      (error: unknown) => error instanceof RemoteProtocolError && error.code === 'CONTROLLER_NOT_ADMITTED');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

/** A device-target execution: B's real journal behind A's hub, paired by key. */
async function deviceExecution(f: ReturnType<typeof setupRemoteHarness>, hub: RemoteControllerHub) {
  const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const hostId = generateCanonicalId();
  const serverOrigin = 'https://remote.example';
  const serverFingerprint = await identityFingerprint(serverKey);
  await f.runtime.enrollment.recordClaim({ hostId, serverUrl: serverOrigin, hostName: 'Execution Host',
    refreshSecret: 'fixture-refresh', serverIdentity: { public_key: serverKey, fingerprint: serverFingerprint } });
  const device = f.runtime.devices.createGeneration({ id: generateCanonicalId(),
    publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }),
    name: 'Controller', platform: 'desktop', cryptoConnectionId: generateCanonicalId() });
  const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
  f.runtime.executions.register(remote.id, device);
  const environment: RemoteControllerEnvironment = {
    id: generateCanonicalId(), name: 'Studio Mac', server_origin: serverOrigin, server_identity_fingerprint: serverFingerprint,
    host_id: hostId, browser_id: generateCanonicalId(), device_id: device.id, device_public_key_json: device.publicKey,
    crypto_connection_id: device.cryptoConnectionId, host_public_key_json: null, pairing_id: null, created_at: Date.now(),
  };
  f.db.prepare(`INSERT INTO remote_controller_environments
    (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, device_id,
      device_public_key_json, crypto_connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
      environment.host_id, environment.browser_id, environment.device_id, environment.device_public_key_json,
      environment.crypto_connection_id, environment.created_at);
  const localId = generateCanonicalId();
  f.db.prepare(`INSERT INTO sessions
    (id, executor, native_session_id, remote_environment_id, remote_repository_id, remote_repository_name)
    VALUES (?, ?, ?, ?, ?, ?)`).run(localId, 'claude', generateCanonicalId(), environment.id, f.workspaceId, 'Remote test');
  hub.bindings.bind({ local_session_id: localId, target: {
    target_version: 2, server_origin: serverOrigin, server_identity_fingerprint: serverFingerprint, host_id: hostId,
    remote_session_id: remote.id, device_id: device.id, device_public_key: JSON.parse(device.publicKey),
    crypto_connection_id: device.cryptoConnectionId!,
  } });
  return { environment, device, remote, localId };
}

function availability(hub: RemoteControllerHub, localId: string) {
  return (hub as unknown as { availability: Map<string, unknown> }).availability.get(localId);
}

test('re-pairing the same device key re-attaches its sessions and never replays an uncertain send', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, localId } = await deviceExecution(f, hub);
    let current = device;
    let supported = true;
    const methods: string[] = [];
    t.mock.method(hub, 'client', () => ({ environment, connected: true,
      async connect() {},
      supports(feature: string) { return supported && feature === 'wire.device_execution_target'; },
      async request(method: RemoteMethod, params: unknown, commandId?: string) {
        methods.push(method);
        const result = await f.runtime.commands.execute(current, command(method, params, commandId), {
          wireFeatures: ['wire.device_execution_target'],
        });
        if (!result.ok) throw new RemoteProtocolError(result.error!.code as 'UNKNOWN_OUTCOME', result.error!.message);
        return result.data;
      },
    }) as unknown as RemoteControllerClient);
    await hub.sync(localId);
    const before = hub.bindings.get(localId)!;
    hub.bindings.markStarted(localId, before.revision);
    const sendId = generateCanonicalId();
    const submission = { type: 'message:send' as const, session_id: localId, send_id: sendId, text: 'Run once' };
    f.db.prepare(`INSERT INTO remote_execution_send_requests
      (request_id, local_session_id, binding_revision, browser_id, command_id, input_json, params_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`).run(sendId, localId, before.revision, environment.browser_id,
      generateCanonicalId(), canonicalJson({ localId, input: submission, busy: 'queue' }), Date.now());

    // The owner removes this Mac on the Host, so its old pairing is refused.
    f.runtime.devices.revoke(device.id);
    await assert.rejects(hub.sync(localId), /revoked/);
    assert.deepEqual(hub.status(localId), { status: 'auth_required', reason: 'pairing' });

    // A new owner-confirmed pairing of the same key re-attaches the binding.
    current = f.runtime.devices.createGeneration({ id: generateCanonicalId(), publicKey: device.publicKey,
      name: 'Controller', platform: 'desktop', cryptoConnectionId: generateCanonicalId() });
    environment.device_id = current.id;
    environment.crypto_connection_id = current.cryptoConnectionId;
    await hub.sync(localId);
    assert.deepEqual(availability(hub, localId), { status: 'ready' });
    const after = hub.bindings.get(localId)!;
    assert.equal(after.revision, before.revision + 1);
    assert.ok('target_version' in after.target);
    assert.equal(after.target.device_id, current.id);
    assert.equal(after.target.crypto_connection_id, current.cryptoConnectionId);
    assert.deepEqual(after.target.device_public_key, JSON.parse(device.publicKey));
    assert.ok(after.execution_started_at, 'a started execution can still follow its own key');

    // An uncertain send from the old pairing is fenced, not sent again.
    await assert.rejects(hub.handleMessage(submission), /send request changed/);
    assert.equal(methods.includes('session.send'), false);

    // A different controller key is refused and never re-attached.
    environment.device_public_key_json = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'Z'.repeat(43), y: 'D'.repeat(43) });
    await assert.rejects(hub.sync(localId), /paired execution device changed/);
    assert.deepEqual(hub.status(localId), { status: 'auth_required', reason: 'pairing' });
    assert.deepEqual(hub.bindings.get(localId), after);

    // A Host too old for device targets is reported as such, not as a pairing problem.
    environment.device_public_key_json = device.publicKey;
    supported = false;
    await assert.rejects(hub.sync(localId), /did not negotiate/);
    assert.deepEqual(hub.status(localId), { status: 'unavailable', reason: 'unsupported' });
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a restarted Host history rebuilds once from zero, reloads the transcript, and re-links unsettled Tool deliveries', async t => {
  const f = setupRemoteHarness();
  const sent: Array<{ type: string; session_id?: string }> = [];
  const hub = new RemoteControllerHub(f.db,
    { broadcast(message: unknown) { sent.push(message as never); } } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    const append = (turn: number, text: string) => f.runtime.executions.append({ session_id: remote.id, turn,
      call_id: `user-${turn}-${text}`, ts: Date.now(), event: 'user_message', data: { text } } as EventEnvelope);
    const settledDelivery = generateCanonicalId();
    const unsettledDelivery = generateCanonicalId();
    const deliveries = new Map([[1, settledDelivery], [2, unsettledDelivery]]);
    let restarting = false;
    let requests = 0;
    t.mock.method(hub, 'client', () => ({ environment, connected: true,
      async connect() {},
      supports(feature: string) { return feature === 'wire.device_execution_target'; },
      async request(_method: RemoteMethod, params: { session_id: string; after: number; stream_id?: string }) {
        requests += 1;
        if (restarting) throw new RemoteProtocolError('SNAPSHOT_REQUIRED', 'execution history stream changed');
        const page = f.runtime.executions.sync(device, params);
        return { ...page, events: page.events.map(entry => 'item' in entry && entry.item.kind === 'user' && deliveries.has(entry.item.turn)
          ? { ...entry, item: { ...entry.item, delivery_id: deliveries.get(entry.item.turn) } } : entry) };
      },
    }) as unknown as RemoteControllerClient);
    // Two Gian Tool sends: the turn 1 delivery settled, the turn 2 one is still running.
    const toolSend = (state: string, deliveryId: string) => {
      const id = generateCanonicalId();
      f.db.prepare(`INSERT INTO tool_requests (id, caller_id, idempotency_key, method, input_hash, status, created_at, updated_at)
        VALUES (?, 'test', ?, 'session.send', 'hash', 'succeeded', 'now', 'now')`).run(id, id);
      f.db.prepare(`INSERT INTO tool_deliveries (id, request_id, session_id, state, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'now', 'now')`).run(generateCanonicalId(), id, localId, state);
      f.db.prepare(`INSERT INTO remote_execution_send_requests
        (request_id, local_session_id, binding_revision, browser_id, command_id, input_json, params_json, result_json, created_at)
        VALUES (?, ?, 1, ?, ?, '{}', '{}', ?, 1)`).run(id, localId, environment.browser_id, generateCanonicalId(),
        JSON.stringify({ delivery_id: deliveryId }));
      return id;
    };
    const settled = toolSend('completed', settledDelivery);
    const unsettled = toolSend('started', unsettledDelivery);
    f.db.prepare('INSERT INTO session_translation_preferences (session_id, enabled, remote_after_sequence) VALUES (?, 1, 0)')
      .run(localId);
    append(1, 'first'); append(2, 'second');
    await hub.sync(localId);
    const linkOf = (turn: number) => (f.db.prepare('SELECT tool_request_id FROM turns WHERE id = ?')
      .get(localRemoteTurnId(localId, turn)) as { tool_request_id: string | null } | undefined)?.tool_request_id;
    assert.equal(linkOf(1), settled);
    assert.equal(linkOf(2), unsettled);
    for (const [request, turn] of [[settled, 1], [unsettled, 2]] as const) {
      f.db.prepare('UPDATE tool_deliveries SET turn_id = ? WHERE request_id = ?').run(localRemoteTurnId(localId, turn), request);
    }
    const oldStream = hub.replicas.snapshot(localId)!.stream_id;

    // The Host restores an older database: turn 1 survives, turn 2 is new,
    // and the still-running delivery lands in turn 3 of the new stream.
    f.db.prepare('DELETE FROM remote_execution_events WHERE session_id = ?').run(remote.id);
    f.db.prepare('UPDATE remote_execution_exports SET stream_id = ?, sequence = 0 WHERE session_id = ?').run(generateCanonicalId(), remote.id);
    append(1, 'first'); append(2, 'other'); append(3, 'second again');
    deliveries.clear(); deliveries.set(1, settledDelivery); deliveries.set(3, unsettledDelivery);
    sent.length = 0;
    await hub.sync(localId);
    assert.notEqual(hub.replicas.snapshot(localId)!.stream_id, oldStream);
    assert.deepEqual(hub.replicas.items(localId).map(entry => 'item' in entry && entry.item.kind === 'user' ? entry.item.text : null),
      ['first', 'other', 'second again']);
    assert.deepEqual(sent.filter(message => message.type === 'session:history-rebuilt'),
      [{ type: 'session:history-rebuilt', session_id: localId }]);
    assert.equal(sent.filter(message => message.type === 'event').length, 0, 'replayed turns are reloaded, not streamed');
    assert.equal(linkOf(1), settled, 'a settled delivery keeps its turn');
    assert.equal(linkOf(2), null, 'a new turn never inherits the old turn 2 delivery');
    assert.equal(linkOf(3), unsettled, 'the running delivery re-links by its delivery id');
    assert.deepEqual(f.db.prepare('SELECT request_id, turn_id FROM tool_deliveries WHERE session_id = ? ORDER BY state').all(localId),
      [{ request_id: settled, turn_id: localRemoteTurnId(localId, 1) }, { request_id: unsettled, turn_id: null }]);
    assert.deepEqual(f.db.prepare('SELECT remote_after_sequence FROM session_translation_preferences WHERE session_id = ?').get(localId),
      { remote_after_sequence: hub.replicas.snapshot(localId)!.cursor }, 'replayed turns never start automatic translation');
    assert.deepEqual(availability(hub, localId), { status: 'ready' });

    // A Host that keeps restarting its stream is not rebuilt in a hot loop.
    restarting = true;
    const counted = requests;
    await assert.rejects(hub.sync(localId), /keeps changing/);
    assert.equal(requests, counted + 1);
    assert.deepEqual(hub.status(localId), { status: 'history_reset' });
    assert.equal(hub.replicas.items(localId).length, 3, 'a throttled reset keeps the rebuilt history');
    (hub as unknown as { historyResets: Map<string, number> }).historyResets.clear();
    sent.length = 0;
    await assert.rejects(hub.sync(localId), /stream changed/);
    assert.equal(requests, counted + 3, 'one rebuild per pass: the request after a reset fails instead of looping');
    assert.deepEqual(sent.filter(message => message.type === 'session:history-rebuilt'),
      [{ type: 'session:history-rebuilt', session_id: localId }], 'an interrupted rebuild still reloads the open transcript');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a changed Server identity replaces the pin only after the exact new fingerprint is confirmed', async t => {
  const f = setupRemoteHarness();
  const previous = 'a'.repeat(64);
  const next = 'b'.repeat(64);
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity, async () => ({
    installationId: generateCanonicalId(), accessToken: 'fixture-only', serverIdentityFingerprint: next, hostIdentity: true,
  }));
  try {
    const origin = 'https://remote.example';
    const hostKey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'H'.repeat(43), y: 'K'.repeat(43) });
    const deviceKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'C'.repeat(43), y: 'D'.repeat(43) };
    const insert = f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, device_id,
        device_public_key_json, crypto_connection_id, host_public_key_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
    const environment = (name: string) => {
      const row = { id: generateCanonicalId(), hostId: generateCanonicalId(), deviceId: generateCanonicalId(), crypto: generateCanonicalId() };
      insert.run(row.id, name, origin, previous, row.hostId, generateCanonicalId(), row.deviceId, JSON.stringify(deviceKey), row.crypto, hostKey);
      const localId = generateCanonicalId();
      f.db.prepare('INSERT INTO sessions (id, executor, native_session_id, remote_environment_id) VALUES (?, ?, ?, ?)')
        .run(localId, 'claude', generateCanonicalId(), row.id);
      hub.bindings.bind({ local_session_id: localId, target: { target_version: 2, server_origin: origin,
        server_identity_fingerprint: previous, host_id: row.hostId, remote_session_id: generateCanonicalId(),
        device_id: row.deviceId, device_public_key: deviceKey, crypto_connection_id: row.crypto } });
      return { ...row, localId };
    };
    const studio = environment('Studio Mac');
    const other = environment('Other Mac');
    const pairingId = generateCanonicalId();
    const claimed = t.mock.method(RemoteControllerClient, 'pair', async () => ({
      id: generateCanonicalId(), name: 'Studio Mac', server_origin: origin, server_identity_fingerprint: next,
      host_id: studio.hostId, browser_id: generateCanonicalId(), device_id: null, device_public_key_json: JSON.stringify(deviceKey),
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: pairingId, created_at: Date.now(),
    }));
    const input = { origin, code: 'ABCD-EFGH', name: 'Studio Mac' };
    const unchanged = () => f.db.prepare('SELECT * FROM remote_controller_environments ORDER BY id').all();
    const before = unchanged();
    for (const attempt of [input, { ...input, confirm_server_identity: 'c'.repeat(64) }, { ...input, confirm_server_identity: previous }]) {
      await assert.rejects(hub.pair(attempt), (error: unknown) => error instanceof RemoteServerIdentityChangedError
        && error.code === 'AUTH_REQUIRED' && error.fingerprint === next && error.previousFingerprints.join() === previous);
    }
    assert.equal(claimed.mock.callCount(), 0, 'the pairing code is not spent before the user decides');
    assert.deepEqual(unchanged(), before);
    assert.equal(hub.bindings.get(studio.localId)!.target.server_identity_fingerprint, previous);

    await hub.pair({ ...input, confirm_server_identity: next });
    assert.equal(claimed.mock.callCount(), 1);
    const saved = f.db.prepare('SELECT * FROM remote_controller_environments WHERE id = ?').get(studio.id) as RemoteControllerEnvironment;
    assert.equal(saved.server_identity_fingerprint, next);
    assert.equal(saved.host_public_key_json, hostKey, 'the Host key stays pinned across the identity change');
    assert.equal(saved.pairing_id, pairingId);
    const rebased = hub.bindings.get(studio.localId)!;
    assert.equal(rebased.target.server_identity_fingerprint, next);
    assert.equal(rebased.revision, 2);
    assert.ok('target_version' in rebased.target && rebased.target.device_id === studio.deviceId);
    assert.equal(hub.bindings.get(other.localId)!.target.server_identity_fingerprint, previous,
      'another environment keeps its pin until it is re-paired and confirmed');
    assert.equal(hub.bindings.get(other.localId)!.revision, 1);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('pairing the Server and Host of a removed environment restores it instead of adding another', async t => {
  const f = setupRemoteHarness();
  const fingerprint = 'a'.repeat(64);
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity, async () => ({
    installationId: generateCanonicalId(), accessToken: 'fixture-only', serverIdentityFingerprint: fingerprint, hostIdentity: true,
  }));
  try {
    const origin = 'https://remote.example';
    const id = generateCanonicalId();
    const hostId = generateCanonicalId();
    const hostKey = JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'H'.repeat(43), y: 'K'.repeat(43) });
    f.db.prepare(`INSERT INTO remote_controller_environments
      (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, host_public_key_json, created_at)
      VALUES (?, 'Studio Mac', ?, ?, ?, ?, ?, 1)`).run(id, origin, fingerprint, hostId, generateCanonicalId(), hostKey);
    const localId = generateCanonicalId();
    f.db.prepare('INSERT INTO sessions (id, executor, native_session_id, remote_environment_id) VALUES (?, ?, ?, ?)')
      .run(localId, 'claude', generateCanonicalId(), id);
    hub.bindings.bind({ local_session_id: localId, target: { server_origin: origin, server_identity_fingerprint: fingerprint,
      account_id: '42', host_id: hostId, remote_session_id: generateCanonicalId() } });
    hub.removeEnvironment(id);
    assert.deepEqual(hub.status(localId), { status: 'unavailable', reason: 'removed' });

    t.mock.method(RemoteControllerClient, 'pair', async (input: { name: string }) => ({
      id: generateCanonicalId(), name: input.name, server_origin: origin, server_identity_fingerprint: fingerprint,
      host_id: hostId, browser_id: generateCanonicalId(), device_id: null, device_public_key_json: null,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: generateCanonicalId(), created_at: Date.now(),
    }));
    const paired = await hub.pair({ origin, code: 'ABCD-EFGH', name: 'Studio Mac again' });
    assert.equal(paired.id, id, 'the same environment comes back, so its sessions follow it');
    assert.deepEqual(hub.listEnvironments().map(item => [item.id, item.name, item.status, item.removed_at]),
      [[id, 'Studio Mac again', 'pending', null]]);
    assert.equal((f.db.prepare('SELECT host_public_key_json FROM remote_controller_environments WHERE id = ?')
      .get(id) as { host_public_key_json: string }).host_public_key_json, hostKey, 'the Host key stays pinned');
    assert.deepEqual(hub.status(localId), { status: 'connecting' });
  } finally { hub.close(); teardownRemoteHarness(f); }
});

/** Stands in for a relay that completes its handshake and, like a Host that
 *  never saw the command, answers keepalive probes at once. */
class AnsweringRelay {
  isOpen = false;
  negotiatedCapabilities: readonly string[] | null = [];
  hostGeneration = generateCanonicalId();
  constructor(readonly options: DeviceRelayClientOptions) {}
  async connect() { this.isOpen = true; }
  async sendControl(message: { method?: string; command_id?: string; params?: { command_id?: string } }) {
    if (message.method !== 'command.status') return;
    queueMicrotask(() => void this.options.handlers.onControl({ type: 'command.result', command_id: message.command_id,
      attempt_id: generateCanonicalId(), ok: true, data: { command_id: message.params!.command_id, state: 'not_seen' } }));
  }
  async sendContent() {}
  close(reason?: string) { this.isOpen = false; this.options.handlers.onClose?.(reason ?? 'closed'); }
}

/** The hub's own client and connection manager for each environment, with
 *  only the Server login stood in by `login` (it throws to fail an attempt)
 *  and an AnsweringRelay. Jitter is pinned to the top of its range.
 *  `tried` lists the environment of each attempt. */
function managedClients(f: ReturnType<typeof setupRemoteHarness>, hub: RemoteControllerHub,
  t: { mock: { method: (...args: never[]) => unknown } },
  login: (attempt: number, environment: RemoteControllerEnvironment) => Promise<void>) {
  const state = { attempts: 0, relays: [] as AnsweringRelay[], tried: [] as string[] };
  const hostPublicKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'E'.repeat(43), y: 'F'.repeat(43) };
  (t.mock.method as unknown as (target: object, key: string, fn: unknown) => void)(hub, 'createClient',
    (environment: RemoteControllerEnvironment, onConnectionChange: (connected: boolean) => void, hooks: RemoteConnectionHooks) => {
      const client = new RemoteControllerClient(environment, f.identity, () => {}, undefined,
        options => { const relay = new AnsweringRelay(options); state.relays.push(relay); return relay; },
        onConnectionChange, undefined, { ...hooks, random: () => 1 });
      const internals = client as unknown as { openRelay(epoch: number, access: object, ticket: string): Promise<void> };
      (t.mock.method as unknown as (target: object, key: string, fn: unknown) => void)(client, 'connectVerified', async (epoch: number) => {
        state.attempts += 1;
        state.tried.push(environment.id);
        await login(state.attempts, environment);
        environment.device_public_key_json ??= JSON.stringify(hostPublicKey);
        await internals.openRelay(epoch, { key: '', token: 'fixture-only', renewAt: 0, hostPublicKey,
          deviceId: environment.device_id ?? generateCanonicalId(),
          cryptoConnectionId: environment.crypto_connection_id ?? generateCanonicalId() }, 'fixture-ticket');
      });
      return client;
    });
  return state;
}

async function settle() {
  for (let index = 0; index < 5; index += 1) await new Promise(resolve => setImmediate(resolve));
}

test('after pairing, the environment\'s own connection retries with its backoff until the Host owner confirms', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity, async () => ({
    installationId: generateCanonicalId(), accessToken: 'fixture-only', serverIdentityFingerprint: 'a'.repeat(64), hostIdentity: true,
  }));
  try {
    t.mock.method(RemoteControllerClient, 'pair', async () => ({
      id: generateCanonicalId(), name: 'Studio Mac', server_origin: 'https://remote.example', server_identity_fingerprint: 'a'.repeat(64),
      host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: null, device_public_key_json: null,
      crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: generateCanonicalId(), created_at: Date.now(),
    }));
    const paired = await hub.pair({ origin: 'https://remote.example', code: 'ABCD-EFGH', name: 'Studio Mac' });
    assert.equal(paired.status, 'pending');
    // The Host refuses this Mac until its owner confirms the pairing there.
    let confirmed = false;
    const state = managedClients(f, hub, t, async () => {
      if (!confirmed) throw new RemoteProtocolError('DEVICE_NOT_PAIRED', 'Remote login or pairing required');
      f.db.prepare('UPDATE remote_controller_environments SET pairing_id = NULL WHERE id = ?').run(paired.id);
    });
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
    hub.start();
    const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
    await tick(1000);
    assert.equal(state.attempts, 1, 'the first poller tick after pairing connects');
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, item.last_error]),
      [['pending', { status: 'auth_required', reason: 'pairing' }]]);
    await tick(999);
    assert.equal(state.attempts, 1, 'an unconfirmed pairing is retried with backoff');
    await tick(1);
    assert.equal(state.attempts, 2, 'by the environment itself, 1 s after the first failure');
    await tick(1999);
    assert.equal(state.attempts, 2);
    await tick(1);
    assert.equal(state.attempts, 3, 'then 2 s');
    confirmed = true;
    await tick(4000);
    assert.equal(state.attempts, 4, 'then 4 s, which the confirmed pairing passes');
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, item.pending, item.last_error]), [['connected', false, undefined]]);
    await tick(60_000);
    assert.equal(state.attempts, 4, 'nothing more is owed once it connected');
    assert.equal(hub.listEnvironments()[0]!.status, 'connected');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('all sessions of one environment share its one reconnect backoff, and a user action cuts it short only once', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, localId } = await deviceExecution(f, hub);
    const second = generateCanonicalId();
    f.db.prepare(`INSERT INTO sessions
      (id, executor, native_session_id, remote_environment_id, remote_repository_id, remote_repository_name)
      VALUES (?, ?, ?, ?, ?, ?)`).run(second, 'claude', generateCanonicalId(), environment.id, f.workspaceId, 'Remote test');
    hub.bindings.bind({ local_session_id: second,
      target: { ...hub.bindings.get(localId)!.target, remote_session_id: generateCanonicalId() } });
    let reachable = false;
    const state = managedClients(f, hub, t, async attempt => {
      if (attempt === 1) throw new RemoteProtocolError('RATE_LIMITED', 'Remote Server rate limited this Mac', { retryAfterSeconds: 5 });
      if (!reachable) throw new RemoteProtocolError('HOST_OFFLINE', 'remote server connection failed');
    });
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
    hub.start();
    const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
    await tick(1000);
    assert.equal(state.attempts, 1, 'both sessions\' syncs share one attempt');
    const client = hub.client(environment.id);
    assert.equal(client.retryAt - Date.now(), 5000, 'the Server\'s Retry-After outweighs the first backoff step');
    await tick(4000);
    assert.equal(state.attempts, 1, 'four poller ticks wait it out without attempts of their own');
    await assert.rejects(hub.sync(localId), { code: 'RATE_LIMITED' });
    assert.equal(state.attempts, 1, 'a background sync meets the same failure at once');

    // Inside the Server's Retry-After even a user action waits for its end.
    // Once connected, this fixture's Host refuses each action for its own
    // reason: no longer HOST_OFFLINE shows the action went on.
    const outcome = (promise: Promise<unknown>) => promise.then(() => 'ok', (error: RemoteProtocolError) => error.code);
    const read = outcome(hub.command(localId, 'file.resolve', { reference: 'README.md' }));
    await tick(999);
    assert.equal(state.attempts, 1);
    await tick(1);
    assert.equal(state.attempts, 2, 'the waiting action and the schedule share one attempt');

    // While the Server stays unreachable, user actions keep waiting on the schedule.
    const resolve = outcome(hub.command(localId, 'file.resolve', { reference: 'README.md' }));
    await settle();
    assert.equal(state.attempts, 3, 'a user action cuts an ordinary backoff short');
    await assert.rejects(hub.handleMessage({ type: 'events:subscribe', session_id: second }), { code: 'HOST_OFFLINE' });
    const stop = outcome(hub.command(localId, 'session.stop', { session_revision: '1' }));
    await tick(1);
    assert.equal(state.attempts, 3, 'but only once: the next one waits for the scheduled attempt');
    reachable = true;
    await tick(4000);
    assert.equal(state.attempts, 4, 'one attempt serves every waiting action and the schedule');
    assert.equal(client.connected, true);
    assert.deepEqual(await Promise.all([read, resolve, stop]),
      ['PROTOCOL_VERSION_UNSUPPORTED', 'PROTOCOL_VERSION_UNSUPPORTED', 'PROTOCOL_VERSION_UNSUPPORTED']);
    assert.equal(client.backingOff, false, 'success resets the backoff');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a brief drop reads as reconnecting, never hides a pairing problem, and turns offline once it lasts', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, localId } = await deviceExecution(f, hub);
    let failure: RemoteProtocolError | null = null;
    const state = managedClients(f, hub, t, async () => { if (failure) throw failure; });
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
    const client = hub.client(environment.id);
    await client.connect();
    (hub as unknown as { availability: Map<string, unknown> }).availability.set(localId, { status: 'ready' });
    assert.deepEqual(hub.status(localId), { status: 'ready' });

    failure = new RemoteProtocolError('HOST_OFFLINE', 'host is offline');
    state.relays[0]!.options.handlers.onNotice?.({ protocol: 'gian.relay/1', type: 'host.offline',
      host_id: environment.host_id, sent_at: Date.now() });
    assert.deepEqual(hub.status(localId), { status: 'reconnecting' });
    assert.equal(hub.listEnvironments()[0]!.status, 'reconnecting');
    for (let index = 0; index < 3; index += 1) { t.mock.timers.tick(30_000); await settle(); }
    assert.equal(state.attempts, 4, 'it keeps trying on its own');
    assert.deepEqual(hub.status(localId), { status: 'reconnecting' }, 'still within two minutes of the drop');
    t.mock.timers.tick(31_000); await settle();
    assert.deepEqual(hub.status(localId), { status: 'offline' }, 'a link down this long is offline');
    assert.equal(hub.listEnvironments()[0]!.status, 'offline');

    // A Host that refuses this Mac is shown as such at once.
    failure = null;
    await client.connect({ user: true });
    failure = new RemoteProtocolError('DEVICE_NOT_PAIRED', 'Remote login or pairing required');
    state.relays.at(-1)!.close('socket_closed');
    t.mock.timers.tick(1000); await settle();
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, item.last_error]),
      [['offline', { status: 'auth_required', reason: 'pairing' }]]);
    assert.deepEqual(hub.status(localId), { status: 'auth_required', reason: 'pairing' });
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a Host that removed this Mac is tried once: no poll, hint or Server-back signal retries it, a send fails at once, and pairing again connects', async t => {
  const f = setupRemoteHarness();
  let fingerprint = '';
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity, async () => ({
    installationId: generateCanonicalId(), accessToken: 'fixture-only', serverIdentityFingerprint: fingerprint, hostIdentity: true,
  }));
  try {
    const { environment, localId } = await deviceExecution(f, hub);
    fingerprint = environment.server_identity_fingerprint;
    let revoked = false;
    const state = managedClients(f, hub, t, async () => {
      if (revoked) throw new RemoteProtocolError('DEVICE_REVOKED', 'Remote login or pairing required');
    });
    const syncs = t.mock.method(hub, 'sync');
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
    hub.start();
    const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
    const client = hub.client(environment.id);
    await client.connect();
    await tick(1000);
    assert.equal(state.attempts, 1);

    // The Host's owner removes this Mac in Settings › Remote.
    revoked = true;
    state.relays[0]!.options.handlers.onNotice?.({ protocol: 'gian.relay/1', type: 'device.revoked',
      host_id: environment.host_id, device_id: environment.device_id, sent_at: Date.now() } as never);
    await tick(1000);
    assert.equal(state.attempts, 2, 'one attempt learns that the pairing is gone');
    assert.equal(client.refused, true);
    assert.deepEqual(hub.status(localId), { status: 'auth_required', reason: 'pairing' });
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, item.last_error]),
      [['offline', { status: 'auth_required', reason: 'pairing' }]]);

    // Ten minutes of poller ticks and Server-back signals, and the sync a Host hint asks for.
    const polled = syncs.mock.callCount();
    for (let minute = 0; minute < 10; minute += 1) {
      hub.serverReachable(environment.server_origin);
      await tick(60_000);
    }
    assert.equal(syncs.mock.callCount(), polled, 'the poller leaves a refused environment alone');
    (hub as unknown as { requestSync(id: string): void }).requestSync(localId);
    await settle();
    await assert.rejects(hub.sync(localId), { code: 'DEVICE_REVOKED' });
    assert.equal(state.attempts, 2, 'nothing tries the refused pairing again');
    assert.deepEqual(hub.status(localId), { status: 'auth_required', reason: 'pairing' });

    // A user's action fails at once with the reason, without an attempt.
    await assert.rejects(hub.command(localId, 'session.stop', { session_revision: '1' }), {
      code: 'DEVICE_REVOKED', message: 'This Mac is no longer paired with the remote Host. Pair it again in Settings › Remote.' });
    assert.equal(state.attempts, 2);

    // Pairing again (the Host's owner confirms it) gives the environment a new connection.
    revoked = false;
    t.mock.method(RemoteControllerClient, 'pair', async (input: { name: string }) => ({
      id: generateCanonicalId(), name: input.name, server_origin: environment.server_origin, server_identity_fingerprint: fingerprint,
      host_id: environment.host_id, browser_id: environment.browser_id, device_id: null,
      device_public_key_json: environment.device_public_key_json, crypto_connection_id: generateCanonicalId(),
      host_public_key_json: null, pairing_id: generateCanonicalId(), created_at: Date.now(),
    }));
    await hub.pair({ origin: environment.server_origin, code: 'ABCD-EFGH', name: 'Studio Mac' });
    await tick(1000);
    assert.equal(state.attempts, 3, 'the re-paired environment connects again');
    assert.notEqual(hub.client(environment.id), client);
    assert.equal(hub.client(environment.id).connected, true);
    assert.equal(hub.listEnvironments()[0]!.status, 'connected');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

/** An environment on `origin` with one bound session, so its connection is wanted. */
function wantedEnvironment(f: ReturnType<typeof setupRemoteHarness>, hub: RemoteControllerHub, origin: string): string {
  const id = generateCanonicalId();
  const hostId = generateCanonicalId();
  f.db.prepare(`INSERT INTO remote_controller_environments
    (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at)
    VALUES (?, 'Studio Mac', ?, ?, ?, ?, 1)`).run(id, origin, 'a'.repeat(64), hostId, generateCanonicalId());
  const localId = generateCanonicalId();
  f.db.prepare('INSERT INTO sessions (id, executor, native_session_id, remote_environment_id) VALUES (?, ?, ?, ?)')
    .run(localId, 'claude', generateCanonicalId(), id);
  hub.bindings.bind({ local_session_id: localId, target: { server_origin: origin, server_identity_fingerprint: 'a'.repeat(64),
    account_id: '42', host_id: hostId, remote_session_id: generateCanonicalId() } });
  return id;
}

test('this Mac\'s own relay back reconnects the environments on its Server at once, once, and no others', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const near = wantedEnvironment(f, hub, 'https://remote.example');
    const limited = wantedEnvironment(f, hub, 'https://remote.example');
    const removed = wantedEnvironment(f, hub, 'https://remote.example');
    const other = wantedEnvironment(f, hub, 'https://other.example');
    const all = [near, limited, removed, other];
    const back = new Set<string>();
    const state = managedClients(f, hub, t, async (_attempt, environment) => {
      if (environment.id === limited) {
        throw new RemoteProtocolError('RATE_LIMITED', 'Remote Server rate limited this Mac', { retryAfterSeconds: 300 });
      }
      if (!back.has(environment.id)) throw new RemoteProtocolError('HOST_OFFLINE', 'Cannot reach the Remote Server');
    });
    // Only connections are under test: the poller's syncs leave them alone.
    t.mock.method(hub, 'sync', async () => {});
    const signals = t.mock.method(hub, 'serverReachable');
    let relay: object | null = null;
    hub.watchLocalRelay({ current: () => relay, origin: () => 'https://Remote.Example:443/' });
    t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: Date.now() });
    hub.start();
    const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
    const tries = (id: string) => state.tried.filter(item => item === id).length;
    const clients = new Map(all.map(id => [id, hub.client(id)]));
    for (const client of clients.values()) await client.connect().catch(() => undefined);
    for (const step of [1000, 2000, 4000, 8000]) await tick(step);
    assert.deepEqual(all.map(tries), [5, 1, 5, 5]);
    assert.equal(clients.get(near)!.retryAt - Date.now(), 10_000, 'the outage grew the backoff to its cap');
    assert.equal(hub.removeEnvironment(removed), true);
    assert.equal(signals.mock.callCount(), 0, 'no relay yet, no signal');

    // This Mac's own Host relay binds again; the near Host is back as well.
    back.add(near);
    relay = {};
    await tick(1000);
    assert.equal(signals.mock.callCount(), 1);
    assert.deepEqual(all.map(tries), [6, 1, 5, 5], 'only the needed environment on that Server tries, at once');
    assert.equal(clients.get(near)!.connected, true);
    assert.equal(clients.get(near)!.backingOff, false);
    assert.ok(clients.get(limited)!.retryAt - Date.now() > 280_000, 'the Server\'s Retry-After still holds');
    assert.equal(clients.get(other)!.retryAt - Date.now(), 9000, 'another Server\'s environment keeps its schedule');

    for (let index = 0; index < 3; index += 1) await tick(1000);
    assert.equal(signals.mock.callCount(), 1, 'the same relay is no new signal');
    relay = null;
    await tick(1000);
    relay = {};
    await tick(1000);
    assert.equal(signals.mock.callCount(), 2, 'a relay bound anew is');
    assert.deepEqual(all.map(tries), [6, 1, 5, 5], 'and a connected environment stays as it is');

    // Told three times over that other.example is back, while its Host is not yet.
    for (let index = 0; index < 3; index += 1) hub.serverReachable('https://other.example/');
    await settle();
    assert.deepEqual(all.map(tries), [6, 1, 5, 6], 'one attempt, however often it is told');
    assert.equal(clients.get(other)!.retryAt - Date.now(), 1000, 'its failure starts the backoff over');
  } finally { hub.close(); teardownRemoteHarness(f); }
});

/** Route the controller to the real Host adapter in this process. */
function routeToHost(f: ReturnType<typeof setupRemoteHarness>, hub: RemoteControllerHub,
  t: { mock: { method: (...args: never[]) => unknown } }, environment: RemoteControllerEnvironment,
  device: ReturnType<typeof f.runtime.devices.createGeneration>, methods: string[] = []) {
  (t.mock.method as unknown as (target: object, key: string, fn: unknown) => void)(hub, 'client', () => ({ environment, connected: true,
    async connect() {},
    supports(feature: string) { return feature === 'wire.device_execution_target'; },
    async request(method: RemoteMethod, params: unknown, commandId?: string) {
      methods.push(method);
      const result = await f.runtime.commands.execute(device, command(method, params, commandId), {
        wireFeatures: ['wire.device_execution_target'],
      });
      if (!result.ok) throw new RemoteProtocolError(result.error!.code as 'UNKNOWN_OUTCOME', result.error!.message);
      return result.data;
    },
  }) as unknown as RemoteControllerClient);
}

/** What the executing Host's EventCoordinator does for one request: journal it, then register it. */
function hostAsks(f: ReturnType<typeof setupRemoteHarness>, sessionId: string, turn: number, approvalId: string,
  display: Partial<ApprovalRequestedData> = {}) {
  f.db.prepare('INSERT OR IGNORE INTO turns (id, session_id, turn_number) VALUES (?, ?, ?)').run(`host-turn-${turn}`, sessionId, turn);
  const data: ApprovalRequestedData = { approvalId, title: 'Run', category: 'other', description: 'Run the tests',
    subject: 'pnpm test', risk: 'high', scopeOptions: ['once'], nativeOptions: [
      { optionId: 'accept', label: 'Yes', kind: 'allow_once' },
      { optionId: 'decline', label: 'No', kind: 'reject_once' },
    ], ...display };
  f.broadcaster.broadcast({ type: 'event', session_id: sessionId, turn, call_id: approvalId, ts: Date.now(),
    event: 'interaction.requested', data: {}, display: { type: data.category === 'question' ? 'interaction.question' : 'interaction.approval', data } });
  void f.approvals.request({ sessionId, turnId: `host-turn-${turn}`, turnNumber: turn, category: data.category, risk: data.risk,
    description: data.description, subject: data.subject, title: data.title,
    projected: data.category === 'question' ? 'question' : 'approval',
    payload: { approvalId, scopeOptions: data.scopeOptions, ...(data.planActions ? { planActions: data.planActions } : {}),
      ...(data.inputs ? { inputs: data.inputs } : {}) },
    nativeOptions: data.nativeOptions }).catch(() => undefined);
}

function transcript(events: EventEnvelope[]) {
  let items: TranscriptItem[] = [];
  for (const event of events) items = applyEnvelope(items, event, 'claude');
  return items.flatMap(item => item.kind === 'approval' ? [item] : []);
}

function sentEvents(sent: ServerToClientMessage[]): EventEnvelope[] {
  return sent.flatMap(message => message.type === 'event' ? [message] : []);
}

test('a card the Host drops without a close settles neutral live and after a reload, never while still pending', async t => {
  const f = setupRemoteHarness();
  const sent: ServerToClientMessage[] = [];
  const hub = new RemoteControllerHub(f.db, { broadcast(message: ServerToClientMessage) { sent.push(message); } } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    routeToHost(f, hub, t, environment, device);
    const card = (approvalId: string, turn: number) => localInteractionId(localId, remoteInteractionResourceId(remote.id, `host-turn-${turn}`, approvalId));
    hostAsks(f, remote.id, 1, 'dropped');
    hostAsks(f, remote.id, 2, 'kept');
    hostAsks(f, remote.id, 3, 'closed-later');
    await hub.sync(localId);
    assert.deepEqual(transcript(sentEvents(sent)).map(item => item.status), ['pending', 'pending', 'pending']);
    assert.equal(transcript(sentEvents(sent)).find(item => item.approvalId === card('kept', 2))?.turn, 2,
      'a live card sits on the turn its request was recorded on');

    // History grows past one page while an older Host drops one card silently,
    // and a newer Host journals the close of another one on the second page.
    for (let index = 0; index < 140; index += 1) {
      f.broadcaster.broadcast({ type: 'event', session_id: remote.id, turn: 2, call_id: `delta-${index}`, ts: Date.now(),
        event: 'content.delta', data: {}, display: { type: 'message', data: { itemId: 'reply', text: 'x', delta: true } } });
    }
    const silent = t.mock.method(f.runtime.executions, 'closeReleased', () => undefined);
    f.approvals.releaseHostTurn(remote.id, 'host-turn-1');
    silent.mock.restore();
    f.approvals.releaseHostTurn(remote.id, 'host-turn-3');
    const before = sent.length;
    await hub.sync(localId);
    const pass = sentEvents(sent.slice(before));
    const neutral = pass.filter(event => event.event === 'remote.interaction.closed');
    assert.deepEqual(neutral.map(event => event.call_id), [card('dropped', 1)], 'only the card dropped without a close');
    assert.ok(pass.indexOf(neutral[0]!) > pass.findIndex(event => event.display?.type === 'interaction.resolved'
      && event.call_id === card('closed-later', 3)), 'settled only after the page carrying the other close');
    const statuses = (events: EventEnvelope[]) => Object.fromEntries(transcript(events).map(item => [item.approvalId, item.status]));
    const expected = { [card('dropped', 1)]: 'resolved', [card('kept', 2)]: 'pending', [card('closed-later', 3)]: 'declined' };
    assert.deepEqual(statuses(sentEvents(sent)), expected);

    // Repeated syncs settle it once; a reload derives the same close.
    const settled = sent.length;
    await hub.sync(localId);
    assert.equal(sentEvents(sent.slice(settled)).filter(event => event.event === 'remote.interaction.closed').length, 0);
    assert.deepEqual(statuses(hub.historyPage(localId, null, 10).events), expected);

    // A first sync (no saved list) never settles a card from a list it never saw,
    // and the rebuilt history still reads the same.
    hub.replicas.reset(localId);
    const rebuilt = sent.length;
    await hub.sync(localId);
    assert.equal(sentEvents(sent.slice(rebuilt)).filter(event => event.event === 'remote.interaction.closed').length, 0);
    assert.deepEqual(statuses(hub.historyPage(localId, null, 10).events), expected);
    await assert.rejects(hub.handleMessage({ type: 'approval:resolve', session_id: localId, approval_id: card('dropped', 1),
      decision: 'allow_once', native_option_id: generateCanonicalId() }), /remote interaction changed/);
    f.approvals.clearSession(remote.id);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('remote cards get one Inbox row and notification, answer from the Inbox, and close from any side', async t => {
  const f = setupRemoteHarness();
  const sent: ServerToClientMessage[] = [];
  const broadcaster = { broadcast(message: ServerToClientMessage) { sent.push(message); } } as unknown as WsBroadcaster;
  let hub = new RemoteControllerHub(f.db, broadcaster, f.identity);
  const inbox = new InboxService(f.db, { broadcast: message => sent.push(message) });
  const notified: AttentionMessage[] = [];
  const adapter = () => new SessionInboxAdapter(f.db, inbox, undefined, fresh => publishFreshSessionAttention({ db: f.db,
    claim: (id, generation) => inbox.claimNotification(id, generation), broadcast: message => notified.push(message), fresh }));
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    routeToHost(f, hub, t, environment, device);
    f.sessions.setSessionInbox(adapter());
    f.sessions.setRemoteController(hub);
    const card = (approvalId: string, turn: number) => localInteractionId(localId, remoteInteractionResourceId(remote.id, `host-turn-${turn}`, approvalId));
    const rows = () => Object.fromEntries((f.db.prepare(`SELECT id, status, generation, source_kind, read_at, display_json FROM inbox_items`)
      .all() as Array<{ id: string; status: string; generation: number; source_kind: string; read_at: string | null; display_json: string }>)
      .map(row => { const display = JSON.parse(row.display_json) as { interaction_id: string; category?: string };
        return [display.interaction_id, { ...row, category: display.category }]; }));
    hostAsks(f, remote.id, 1, 'approve-me');
    hostAsks(f, remote.id, 1, 'plan-me', { category: 'exit_plan_mode', title: 'Plan ready for review', subject: '# Plan',
      nativeOptions: undefined, planActions: ['accept_with_auto', 'accept_with_ask', 'keep_planning'] });
    hostAsks(f, remote.id, 2, 'ask-me', { category: 'question', title: 'Question', subject: undefined, description: 'Which one?',
      inputs: [{ id: 'pick', type: 'single_select', label: 'Pick one', required: true, choices: [{ value: 'a', displayName: 'A' }] }] });
    hostAsks(f, remote.id, 3, 'allow-me', { category: 'command', nativeOptions: undefined, scopeOptions: ['once', 'session'] });
    await hub.sync(localId);

    const cards = transcript(sentEvents(sent));
    assert.equal(cards.find(item => item.approvalId === card('ask-me', 2))?.category, 'question', 'a native-choice question reads as a question');
    assert.deepEqual(cards.find(item => item.approvalId === card('allow-me', 3))?.actions?.map(action => action.label),
      ['Allow once', 'Allow for this session', 'Decline']);
    assert.deepEqual(cards.find(item => item.approvalId === card('plan-me', 1))?.actions?.map(action => action.label),
      ['Accept, auto-approve edits', 'Accept, ask before edits', 'Keep planning']);
    const opened = rows();
    assert.deepEqual(Object.fromEntries(Object.entries(opened).map(([id, row]) => [id, [row.source_kind, row.category ?? null, row.status]])), {
      [card('approve-me', 1)]: ['session.approval', 'command', 'pending'],
      [card('plan-me', 1)]: ['session.approval', 'plan', 'pending'],
      [card('ask-me', 2)]: ['session.question', null, 'pending'],
      [card('allow-me', 3)]: ['session.approval', 'command', 'pending'],
    });
    assert.deepEqual(notified.map(message => [message.target.interaction_id, message.event, message.turn, Boolean(message.inbox_ref)]), [
      [card('approve-me', 1), 'approval_needed', 1, true],
      [card('plan-me', 1), 'plan_review_needed', 1, true],
      [card('ask-me', 2), 'answer_needed', 2, true],
      [card('allow-me', 3), 'approval_needed', 3, true],
    ]);

    // Repeated syncs, a restart of this Mac and a rebuilt history reuse the rows and stay quiet.
    await hub.sync(localId);
    hub.close();
    hub = new RemoteControllerHub(f.db, broadcaster, f.identity);
    routeToHost(f, hub, t, environment, device);
    f.sessions.setSessionInbox(adapter());
    f.sessions.setRemoteController(hub);
    await hub.sync(localId);
    hub.replicas.reset(localId);
    await hub.sync(localId);
    assert.deepEqual(rows(), opened);
    assert.equal(notified.length, 4);

    // The Inbox plan decision reaches the Host's own plan action for the exact card it saw.
    const answers: Array<[string, string]> = [];
    t.mock.method(f.sessions, 'respondApproval', async (sessionId: string, approvalId: string, decision: string) => {
      answers.push([approvalId, decision]);
      f.broadcaster.broadcast({ type: 'event', session_id: sessionId, turn: 1, call_id: approvalId, ts: Date.now(),
        event: 'interaction.resolved', data: {}, display: { type: 'interaction.resolved',
          data: { approvalId, decision: 'allow_once', auto: false } } });
      f.approvals.resolve(approvalId, 'allow_once', 'tool', sessionId);
    });
    const plan = opened[card('plan-me', 1)]!;
    const seen = { id: plan.id, generation: plan.generation };
    assert.throws(() => f.sessions.assertExpectedInbox(localId, card('plan-me', 1), { ...seen, generation: 2 }), /pending generation/);
    f.sessions.assertExpectedInbox(localId, card('plan-me', 1), seen);
    await hub.handleMessage({ type: 'approval:resolve', session_id: localId, approval_id: card('plan-me', 1),
      decision: 'accept_with_ask', expected_inbox: seen });
    assert.deepEqual(answers, [['plan-me', 'accept_with_ask']]);
    assert.throws(() => f.sessions.assertExpectedInbox(localId, card('plan-me', 1), seen), /pending generation/);

    // Answered on the Host by another device, released by the Host, dropped by an older Host.
    f.broadcaster.broadcast({ type: 'event', session_id: remote.id, turn: 1, call_id: 'approve-me', ts: Date.now(),
      event: 'interaction.resolved', data: {}, display: { type: 'interaction.resolved',
        data: { approvalId: 'approve-me', decision: 'allow_once', auto: false } } });
    f.approvals.resolve('approve-me', 'allow_once', 'tool', remote.id);
    f.approvals.releaseHostTurn(remote.id, 'host-turn-2');
    const silent = t.mock.method(f.runtime.executions, 'closeReleased', () => undefined);
    f.approvals.releaseHostTurn(remote.id, 'host-turn-3');
    silent.mock.restore();
    await hub.sync(localId);
    const closed = rows();
    assert.deepEqual(Object.fromEntries(Object.entries(closed).map(([id, row]) => [id, [row.status, row.read_at !== null]])), {
      [card('plan-me', 1)]: ['resolved', true],
      [card('approve-me', 1)]: ['resolved', false],
      [card('ask-me', 2)]: ['cancelled', false],
      [card('allow-me', 3)]: ['cancelled', false],
    });
    await hub.sync(localId);
    assert.deepEqual(rows(), closed);
    assert.equal(notified.length, 4);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('labels from Hosts before human decision labels are mapped only for their own decision actions', () => {
  const localId = generateCanonicalId();
  const id = generateCanonicalId();
  const entry = { sequence: 1, turn: 1, interaction: { id, revision: '0', session_id: generateCanonicalId(), turn_id: generateCanonicalId(),
    kind: 'approval' as const, created_at: new Date().toISOString(), presentation: { title: 'Run', description: 'Run', risk: 'high' as const,
      actions: [{ id: remoteActionId(id, 'allow_once'), label: 'allow_once', tone: 'default' as const },
        { id: generateCanonicalId(), label: 'decline', tone: 'danger' as const }] } } };
  const event = remoteHistoryEvent(localId, entry);
  assert.ok(event.display?.type === 'interaction.approval');
  assert.deepEqual(event.display.data.actions?.map(action => action.label), ['Allow once', 'decline']);
});

type Hint = Record<string, unknown>;

/** A controller connection to the real Host adapter in this process, built
 *  through the hub's own client wiring so its hint listener and
 *  connectivity callback are the production ones. */
function connectionToHost(f: ReturnType<typeof setupRemoteHarness>, hub: RemoteControllerHub,
  t: { mock: { method: (...args: never[]) => unknown } }, environment: RemoteControllerEnvironment,
  device: ReturnType<typeof f.runtime.devices.createGeneration>, features: string[]) {
  const state = { connected: false, syncs: 0, gate: null as Promise<void> | null,
    listeners: [] as Array<(message: Hint) => unknown> };
  (t.mock.method as unknown as (target: object, key: string, fn: unknown) => void)(hub, 'createClient',
    (_environment: RemoteControllerEnvironment, onConnectionChange: (connected: boolean) => void) => ({
      environment,
      get connected() { return state.connected; },
      async connect() { if (!state.connected) { state.connected = true; onConnectionChange(true); } },
      close() { if (state.connected) { state.connected = false; onConnectionChange(false); } },
      supports(feature: string) { return state.connected && features.includes(feature); },
      onControl(listener: (message: Hint) => unknown) { state.listeners.push(listener); return () => {}; },
      async request(method: RemoteMethod, params: unknown, commandId?: string) {
        if (method === 'execution.sync') { state.syncs += 1; await state.gate; }
        const result = await f.runtime.commands.execute(device, command(method, params, commandId), { wireFeatures: features });
        if (!result.ok) throw new RemoteProtocolError(result.error!.code as 'UNKNOWN_OUTCOME', result.error!.message);
        return result.data;
      },
    }) as unknown as RemoteControllerClient);
  const deliver = async (message: Hint) => { for (const listener of state.listeners) await listener(message); };
  // The Host's side of the same connection: its control frames reach the controller.
  const connectors = (f.runtime as unknown as { connectors: Map<string, unknown> }).connectors;
  connectors.set(device.id, { supportsFeature: (feature: string) => features.includes(feature),
    sendControl: async (message: Hint) => { if (state.connected) await deliver(message); },
    sendTranscript() {}, close() {} });
  return { state, deliver };
}

async function until(check: () => boolean, message = 'condition timed out') {
  const deadline = Date.now() + 3000;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function syncSchedule(hub: RemoteControllerHub, localId: string) {
  return (hub as unknown as { scheduled: Map<string, { next: number; failures: number }> }).scheduled.get(localId);
}

function syncRunning(hub: RemoteControllerHub, localId: string) {
  return (hub as unknown as { syncing: Map<string, unknown> }).syncing.has(localId);
}

const HINTED = ['wire.execution_v1', 'wire.device_execution_target', 'wire.execution_hints_v1'];

test('a Host hint brings a remote approval at once, one more sync follows a busy pass, and polling slows to a fallback', async t => {
  const f = setupRemoteHarness();
  const sent: ServerToClientMessage[] = [];
  const hub = new RemoteControllerHub(f.db, { broadcast(message: ServerToClientMessage) { sent.push(message); } } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    const { state, deliver } = connectionToHost(f, hub, t, environment, device, HINTED);
    await hub.sync(localId);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.syncs, 1, 'the first connect does not repeat the pass that opened it');

    // No poller runs here: only the Host's hint can bring the card.
    hostAsks(f, remote.id, 1, 'approve-me');
    await until(() => transcript(sentEvents(sent)).length === 1, 'the hinted approval reached this Mac');
    // From here on the test delivers each hint itself.
    (f.runtime as unknown as { connectors: Map<string, unknown> }).connectors.delete(device.id);
    await until(() => !syncRunning(hub, localId) && syncSchedule(hub, localId) !== undefined);
    const fallback = hub.replicas.snapshot(localId)?.session.active_turn ? 10_000 : 60_000;
    assert.ok(Math.abs(syncSchedule(hub, localId)!.next - Date.now() - fallback) < 2000, 'a hinted Host keeps only a slow fallback poll');

    // Hints during a running pass ask for exactly one more pass after it.
    let release!: () => void;
    state.gate = new Promise(resolve => { release = resolve; });
    const hint = { type: 'execution.changed', version: 1, host_generation: f.runtime.generation, session_id: remote.id, sequence: 1 };
    const before = state.syncs;
    await deliver(hint);
    await until(() => state.syncs === before + 1);
    for (let index = 0; index < 3; index += 1) await deliver(hint);
    state.gate = null;
    release();
    await until(() => state.syncs === before + 2);
    await until(() => !syncRunning(hub, localId));
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(state.syncs, before + 2);

    // Unknown, malformed or archived targets are ignored, and a failure backoff still holds.
    const idle = state.syncs;
    await deliver({ ...hint, session_id: generateCanonicalId() });
    await deliver({ ...hint, text: 'never content' });
    f.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(localId);
    await deliver(hint);
    f.db.prepare('UPDATE sessions SET archived = 0 WHERE id = ?').run(localId);
    syncSchedule(hub, localId)!.failures = 2;
    await deliver(hint);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(state.syncs, idle);
    syncSchedule(hub, localId)!.failures = 0;

    // Losing the connection returns to the plain cadence; reconnecting syncs once.
    hub.client(environment.id).close();
    assert.ok(syncSchedule(hub, localId)!.next - Date.now() <= 15_000);
    await hub.client(environment.id).connect();
    await until(() => state.syncs === idle + 1, 'a reconnect catches up on hints it missed');
    await until(() => !syncRunning(hub, localId));
    f.approvals.clearSession(remote.id);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a Host without change hints keeps the existing poll cadence and stray hints change nothing', async t => {
  const f = setupRemoteHarness();
  const hub = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    const { state, deliver } = connectionToHost(f, hub, t, environment, device, ['wire.execution_v1', 'wire.device_execution_target']);
    (hub as unknown as { poll(id: string): void }).poll(localId);
    await until(() => syncSchedule(hub, localId) !== undefined);
    const next = syncSchedule(hub, localId)!.next - Date.now();
    assert.ok(next > 13_000 && next <= 15_000, 'an idle session is polled every 15 s as before');

    hostAsks(f, remote.id, 1, 'approve-me');
    await deliver({ type: 'execution.changed', version: 1, host_generation: f.runtime.generation, session_id: remote.id, sequence: 1 });
    hub.client(environment.id).close();
    await hub.client(environment.id).connect();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(state.syncs, 1, 'neither a hint nor a reconnect syncs outside the poll');
    f.approvals.clearSession(remote.id);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

test('a removed environment keeps its sessions as readable history, is never polled, hinted or connected, and Restore brings it back', async t => {
  const f = setupRemoteHarness();
  const sent: ServerToClientMessage[] = [];
  const hub = new RemoteControllerHub(f.db, { broadcast(message: ServerToClientMessage) { sent.push(message); } } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    hostAsks(f, remote.id, 1, 'approve-me');
    const { state, deliver } = connectionToHost(f, hub, t, environment, device, HINTED);
    // The test delivers each hint itself.
    (f.runtime as unknown as { connectors: Map<string, unknown> }).connectors.delete(device.id);
    let retired = false;
    const client = hub.client(environment.id);
    (client as unknown as { retire(): void }).retire = () => { retired = true; client.close(); };
    await hub.sync(localId);
    await until(() => !syncRunning(hub, localId));
    // A dropped link reads Offline with when it was last seen, while a session needs it.
    client.close();
    assert.deepEqual(hub.listEnvironments().map(item => [item.status, typeof item.last_seen_at]), [['offline', 'number']]);
    await client.connect();
    await new Promise(resolve => setImmediate(resolve));
    await until(() => !syncRunning(hub, localId));
    const history = hub.historyEvents(localId);
    assert.ok(history.length > 0);
    // A create request references the environment too.
    f.db.prepare(`INSERT INTO remote_execution_create_requests
      (request_id, environment_id, command_id, input_json, browser_id, repository_name, created_at) VALUES (?, ?, ?, '{}', ?, ?, ?)`)
      .run(generateCanonicalId(), environment.id, generateCanonicalId(), environment.browser_id, 'Remote test', Date.now());

    assert.equal(hub.removeEnvironment(environment.id), true);
    assert.ok(retired && !state.connected, 'the live connection closes for good');
    assert.deepEqual(hub.listEnvironments().map(item => [item.id, item.status, item.connected]), [[environment.id, 'removed', false]]);
    const pushed = sent.filter(message => message.type === 'remote:environments').at(-1) as unknown as { environments: RemoteEnvironmentStatus[] };
    assert.equal(pushed.environments[0]!.status, 'removed', 'Settings learns of the removal live');

    // Its session stays readable, with an honest status, and refuses commands.
    assert.deepEqual(hub.status(localId), { status: 'unavailable', reason: 'removed' });
    assert.deepEqual(hub.historyEvents(localId), history);
    assert.ok(hub.historyPage(localId, null).events.length > 0);
    const syncs = state.syncs;
    assert.equal(await hub.handleMessage({ type: 'events:subscribe', session_id: localId }), true, 'opening it reads the saved replica');
    for (const message of [
      { type: 'message:send' as const, session_id: localId, text: 'Run' },
      { type: 'session:stop' as const, session_id: localId },
      { type: 'queue:clear' as const, session_id: localId },
    ]) await assert.rejects(hub.handleMessage(message), RemoteEnvironmentRemovedError);
    await assert.rejects(hub.command(localId, 'file.tree', { directory: '' }), RemoteEnvironmentRemovedError);
    assert.equal(await hub.handleMessage({ type: 'session:rename', session_id: localId, name: 'Kept' }), false,
      'local actions (rename, archive, delete) stay with the session manager');
    assert.deepEqual(hub.workingTrees(), []);

    // Pickers and take over cannot reach it; hints and the poller leave it alone.
    assert.throws(() => hub.client(environment.id), RemoteEnvironmentRemovedError);
    await assert.rejects(hub.catalog(environment.id), RemoteEnvironmentRemovedError);
    await assert.rejects(hub.listExecutions(environment.id), RemoteEnvironmentRemovedError);
    await assert.rejects(hub.takeOver(environment.id, remote.id), RemoteEnvironmentRemovedError);
    await deliver({ type: 'execution.changed', version: 1, host_generation: f.runtime.generation, session_id: remote.id, sequence: 9 });
    hub.start();
    await new Promise(resolve => setTimeout(resolve, 1300));
    assert.equal(state.syncs, syncs, 'no open, hint or poll reached the Host');
    assert.equal(state.connected, false);

    // Restore connects again and its sessions sync on the next poll.
    assert.equal(hub.restoreEnvironment(environment.id), true);
    await until(() => state.syncs > syncs, 'a restored environment syncs its sessions again');
    await until(() => !syncRunning(hub, localId) && hub.listEnvironments()[0]!.status === 'connected');
    assert.deepEqual(hub.status(localId), { status: 'ready' });
    assert.equal(hub.workingTrees().length, 1);
    f.approvals.clearSession(remote.id);
  } finally { hub.close(); teardownRemoteHarness(f); }
});

/** What a desktop transcript shows for a mirrored session's tool rows: the
 *  live broadcast and a reload of the same history must agree. */
async function mirroredToolRows(t: { mock: { method: (...args: never[]) => unknown } }, features: string[]) {
  const f = setupRemoteHarness();
  const sent: ServerToClientMessage[] = [];
  const hub = new RemoteControllerHub(f.db, { broadcast(message: ServerToClientMessage) { sent.push(message); } } as unknown as WsBroadcaster, f.identity);
  try {
    const { environment, device, remote, localId } = await deviceExecution(f, hub);
    connectionToHost(f, hub, t, environment, device, features);
    const append = (callId: string, display: EventEnvelope['display']) => f.runtime.executions.append({
      session_id: remote.id, turn: 1, call_id: callId, ts: Date.now(), event: 'native.event', data: {}, display });
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'running', command: 'pnpm test', cwd: f.dir } });
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'running', command: '', stdoutDelta: 'one\n' } });
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'running', command: '', stdoutDelta: 'two\n' } });
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'error', exitCode: 1, command: '' } });
    append('edit', { type: 'activity.file-change', data: { cwd: f.dir, files: [{ path: `${f.dir}/src/a.ts`, kind: 'update', added: 1, removed: 1 }],
      diff: `diff --git a/${f.dir}/src/a.ts b/${f.dir}/src/a.ts\n--- a/${f.dir}/src/a.ts\n+++ b/${f.dir}/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n` } });
    append('tool', { type: 'activity.tool', data: { itemId: 'tool', title: 'mcp.deploy', status: 'success',
      input: { target: 'prod' }, output: 'deployed' } });
    append('fail', { type: 'state.error', data: { message: 'quota exceeded', retryable: false } });
    await hub.sync(localId);
    const rows = (events: EventEnvelope[]) => {
      let items: TranscriptItem[] = [];
      for (const event of events) items = applyEnvelope(items, event, 'claude');
      return items.map(item => item.kind === 'command' ? { kind: item.kind, command: item.command, status: item.status, exitCode: item.exitCode, stdout: item.stdout }
        : item.kind === 'diff' ? { kind: item.kind, files: item.files.map(file => [file.path, file.add, file.del, file.hunks.length]) }
        : item.kind === 'tool' ? { kind: item.kind, name: item.name, summary: item.summary, output: item.output, status: item.status }
        : item.kind === 'error' ? { kind: item.kind, text: item.text }
        : item.kind === 'auto-notice' ? { kind: item.kind, title: item.title, message: item.message }
        : { kind: item.kind });
    };
    const live = rows(sentEvents(sent));
    assert.deepEqual(rows(hub.historyPage(localId, null).events), live, 'a reload shows the same rows');
    return live;
  } finally { hub.close(); teardownRemoteHarness(f); }
}

test('a mirrored command, file change, tool and error render as the local rows when the Host sends detail', async t => {
  assert.deepEqual(await mirroredToolRows(t, ['wire.execution_v1', 'wire.device_execution_target', 'wire.execution_detail_v1']), [
    { kind: 'command', command: 'pnpm test', status: 'error', exitCode: 1, stdout: 'one\ntwo\n' },
    { kind: 'diff', files: [['src/a.ts', 1, 1, 1]] },
    { kind: 'tool', name: 'mcp.deploy', summary: '{"target":"prod"}', output: 'deployed', status: 'success' },
    { kind: 'error', text: 'quota exceeded' },
  ]);
});

test('a Host without detail keeps one readable fallback row per item', async t => {
  assert.deepEqual(await mirroredToolRows(t, ['wire.execution_v1', 'wire.device_execution_target']), [
    { kind: 'auto-notice', title: 'Ran a command', message: 'Running' },
    { kind: 'auto-notice', title: 'Ran a command', message: 'Running' },
    { kind: 'auto-notice', title: 'Ran a command', message: 'Running' },
    { kind: 'auto-notice', title: 'Ran a command', message: 'Failed · exit 1' },
    { kind: 'auto-notice', title: 'Changed files', message: '1 file' },
    { kind: 'tool', name: 'mcp.deploy', summary: '', output: undefined, status: 'success' },
    { kind: 'error', text: 'Remote execution failed' },
  ]);
});

test('a cut output tail says so, a streamed row keeps the earlier command line, and other kinds read plainly', () => {
  const localId = generateCanonicalId();
  const item = { id: generateCanonicalId(), turn_id: generateCanonicalId(), turn: 2, ts: Date.now() };
  const replaced = remoteHistoryEvent(localId, { sequence: 1, item: { ...item, kind: 'command', status: 'success', exit_code: 0 },
    detail: { command: 'make', output: { text: 'last line', delta: false, truncated: true } } });
  assert.deepEqual(replaced.display, { type: 'activity.command', data: { command: 'make', status: 'success', itemId: item.id,
    exitCode: 0, stdout: '[earlier output truncated]\nlast line' } });
  const streamed = remoteHistoryEvent(localId, { sequence: 2, item: { ...item, kind: 'command', status: 'running' },
    detail: { output: { text: 'more', delta: true, truncated: false } } });
  assert.deepEqual(streamed.display, { type: 'activity.command', data: { status: 'running', itemId: item.id, stdoutDelta: 'more' } });
  const search = remoteHistoryEvent(localId, { sequence: 3, item: { ...item, kind: 'file-search', search_kind: 'grep', match_count: 3 } });
  assert.deepEqual(search.display, { type: 'activity.notice', data: { severity: 'info', code: '', title: 'Searched file contents', message: '3 matches' } });
});
