import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateCanonicalId, executionSyncResultSchema, identityFingerprint, type ExecutionSession } from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';
import { RemoteExecutionBindings } from '../src/remote/execution-bindings.js';
import { RemoteExecutionJournal, RemoteExecutionReplicas } from '../src/remote/execution-journal.js';
import { remoteHistoryEvent } from '../src/remote/controller-hub.js';
import { remoteInteractionResourceId, remoteStableUuid } from '../src/remote/projection.js';
import { command, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

test('exported executions belong to Repos, not remote Tasks, and another same-account device can resume history', async () => {
  const f = setupRemoteHarness();
  try {
    const creator = seedDevice(f);
    f.runtime.devices.bindAccount(creator.id, '42');
    const device = f.runtime.devices.get(creator.id)!;
    const create = command('execution.create', {
      catalog_revision: f.runtime.projector.catalogRevision(), workspace_id: f.workspaceId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'), name: 'Remote execution',
    });
    const result = await f.runtime.commands.execute(device, create);
    assert.equal(result.ok, true, result.error?.message);
    const session = result.data as ExecutionSession;
    assert.equal(session.task_id, null);
    assert.equal(session.workspace_id, f.workspaceId);
    assert.equal(f.tasks.listTasks().length, 1);
    const repeated = await f.runtime.commands.execute(device, { ...create, attempt_id: generateCanonicalId() });
    assert.equal((repeated.data as ExecutionSession).id, session.id);

    const next = seedDevice(f, 'Second Gian');
    f.runtime.devices.bindAccount(next.id, '42');
    const controller = f.runtime.devices.get(next.id)!;
    f.runtime.devices.revoke(device.id);
    assert.equal(f.runtime.executions.list(controller).sessions[0]?.id, session.id);
    assert.throws(() => f.runtime.executions.list({ ...controller, accountId: null }), /verified account/);
    assert.throws(() => f.runtime.executions.sync({ ...controller, accountId: '99' }, { session_id: session.id, after: 0 }), /not available/);

    const marker = 'REMOTE_AB_' + generateCanonicalId();
    const fullText = ('remote result ' + marker + '\n').repeat(700);
    f.runtime.executions.append({ session_id: session.id, turn: 1, call_id: 'user', ts: Date.now(),
      event: 'user_message', data: { text: marker } });
    f.runtime.executions.append({ session_id: session.id, turn: 1, call_id: 'answer', ts: Date.now(),
      event: 'content.completed', data: {}, display: { type: 'message', data: { itemId: 'answer', text: fullText, delta: false } } });
    const page = f.runtime.executions.sync(controller, { session_id: session.id, after: 0 });
    const user = page.events.find(entry => 'item' in entry && entry.item.kind === 'user');
    assert.ok(user && 'item' in user && user.item.kind === 'user');
    assert.equal(user.item.text, marker);
    const text = page.events.flatMap(entry => 'item' in entry && entry.item.kind === 'assistant' ? [entry.item.text] : []).join('');
    assert.equal(text, fullText);
    assert.ok(page.events.length > 1);
    assert.equal(page.has_more, false);
    assert.equal(f.runtime.executions.sync(controller, { session_id: session.id, after: page.cursor, stream_id: page.stream_id }).events.length, 0);
  } finally { teardownRemoteHarness(f); }
});

test('an accountless paired device creates, catalogs, lists and resumes only its own executions', async () => {
  const f = setupRemoteHarness();
  try {
    const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
    const hostId = generateCanonicalId();
    await f.runtime.enrollment.recordClaim({
      hostId, serverUrl: 'https://remote.example', hostName: 'Execution Host', refreshSecret: 'fixture-refresh',
      serverIdentity: { public_key: serverKey, fingerprint: await identityFingerprint(serverKey) },
    });
    const device = f.runtime.devices.create({
      publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }),
      name: 'Accountless Desktop', platform: 'desktop', cryptoConnectionId: generateCanonicalId(),
    });
    assert.equal(device.accountId, null);
    const create = command('execution.create', {
      catalog_revision: f.runtime.projector.catalogRevision(), workspace_id: f.workspaceId,
      agent_id: remoteStableUuid('agent', 'agent-claude-review'), name: 'Device execution',
    });
    const created = await f.runtime.commands.execute(device, create);
    assert.equal(created.ok, true, created.error?.message);
    const remote = created.data as ExecutionSession;
    const catalog = await f.runtime.commands.execute(device, command('catalog.agent', {
      agent_id: remoteStableUuid('agent', 'agent-claude-review'),
    }));
    assert.equal(catalog.ok, true, catalog.error?.message);
    assert.equal(f.runtime.executions.list(device).sessions[0]?.id, remote.id);
    assert.equal(f.runtime.executions.sync(device, { session_id: remote.id, after: 0 }).session.id, remote.id);
    const exported = f.db.prepare('SELECT account_id, execution_principal FROM remote_execution_exports WHERE session_id = ?')
      .get(remote.id) as { account_id: string | null; execution_principal: string };
    assert.equal(exported.account_id, null);
    assert.match(exported.execution_principal, /device_revision/);
    assert.match(exported.execution_principal, /server_identity_fingerprint/);

    const other = f.runtime.devices.create({
      publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'E'.repeat(43), y: 'F'.repeat(43) }),
      name: 'Other Desktop', platform: 'desktop', cryptoConnectionId: generateCanonicalId(),
    });
    assert.equal(f.runtime.executions.list(other).sessions.length, 0);
    assert.throws(() => f.runtime.executions.sync(other, { session_id: remote.id, after: 0 }), /not available to this device/);
    f.runtime.devices.revoke(device.id);
    assert.throws(() => f.runtime.executions.sync(f.runtime.devices.get(device.id)!, { session_id: remote.id, after: 0 }), /revoked/);
  } finally { teardownRemoteHarness(f); }
});

test('legacy exports migrate only with one exact creation/device receipt and keep account evidence', async () => {
  const f = setupRemoteHarness();
  try {
    const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
    const hostId = generateCanonicalId();
    const serverOrigin = 'https://remote.example';
    const serverFingerprint = await identityFingerprint(serverKey);
    await f.runtime.enrollment.recordClaim({ hostId, serverUrl: serverOrigin, hostName: 'Execution Host',
      refreshSecret: 'fixture-refresh', serverIdentity: { public_key: serverKey, fingerprint: serverFingerprint } });
    const identity = () => ({ server_origin: serverOrigin, server_identity_fingerprint: serverFingerprint, host_id: hostId });
    const first = f.runtime.devices.create({ publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'C'.repeat(43), y: 'D'.repeat(43) }),
      name: 'Original', platform: 'desktop', cryptoConnectionId: generateCanonicalId() });
    f.runtime.devices.bindAccount(first.id, '42');
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.db.prepare(`INSERT INTO remote_execution_exports(session_id, account_id, execution_principal, stream_id, created_at)
      VALUES (?, '42', NULL, ?, 1)`).run(remote.id, generateCanonicalId());
    f.db.prepare(`INSERT INTO remote_command_ledger(
      device_id, command_id, method, attempt_id, state, tool_result_json, created_at, updated_at
    ) VALUES (?, ?, 'execution.create', ?, 'succeeded', ?, 'now', 'now')`)
      .run(first.id, generateCanonicalId(), generateCanonicalId(), JSON.stringify({ id: remote.id }));
    new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector, identity);
    const migrated = f.db.prepare('SELECT account_id, execution_principal FROM remote_execution_exports WHERE session_id = ?')
      .get(remote.id) as { account_id: string; execution_principal: string };
    assert.equal(migrated.account_id, '42');
    assert.match(migrated.execution_principal, new RegExp(first.id));

    const ambiguous = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.db.prepare(`INSERT INTO remote_execution_exports(session_id, account_id, execution_principal, stream_id, created_at)
      VALUES (?, '42', NULL, ?, 1)`).run(ambiguous.id, generateCanonicalId());
    const second = f.runtime.devices.create({ publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'E'.repeat(43), y: 'F'.repeat(43) }),
      name: 'Same old account', platform: 'desktop', cryptoConnectionId: generateCanonicalId() });
    f.runtime.devices.bindAccount(second.id, '42');
    const ledger = f.db.prepare(`INSERT INTO remote_command_ledger(
      device_id, command_id, method, attempt_id, state, tool_result_json, created_at, updated_at
    ) VALUES (?, ?, 'execution.create', ?, 'succeeded', ?, 'now', 'now')`);
    for (const device of [first, second]) ledger.run(device.id, generateCanonicalId(), generateCanonicalId(), JSON.stringify({ id: ambiguous.id }));
    new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector, identity);
    new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector, identity);
    assert.equal((f.db.prepare('SELECT execution_principal FROM remote_execution_exports WHERE session_id = ?')
      .get(ambiguous.id) as { execution_principal: null }).execution_principal, null);
  } finally { teardownRemoteHarness(f); }
});

test('replicas persist contiguous history, real interaction resolution, and reject stale or cross-session replies', async () => {
  const f = setupRemoteHarness();
  try {
    const seeded = seedDevice(f);
    f.runtime.devices.bindAccount(seeded.id, '42');
    const device = f.runtime.devices.get(seeded.id)!;
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, device);
    const approvalId = 'interaction_b229_history';
    const wireId = remoteInteractionResourceId(remote.id, 'provider-turn-history', approvalId);
    // History projection resolves a card's turn through the turns table; the
    // row makes the recorded host turn id authoritative here as in production.
    f.db.prepare('INSERT INTO turns (id, session_id, turn_number) VALUES (?, ?, ?)')
      .run('provider-turn-history', remote.id, 1);
    const asking = f.approvals.request({ sessionId: remote.id, turnId: 'provider-turn-history', turnNumber: 1,
      category: 'command', description: 'Write result.txt', risk: 'high', payload: { approvalId } });
    void asking.catch(() => undefined);
    const event: EventEnvelope = { session_id: remote.id, turn: 1, call_id: approvalId, ts: Date.now(),
      event: 'approval_requested', data: {}, display: { type: 'interaction.approval', data: {
        approvalId, title: 'Write file', category: 'command', description: 'Write result.txt', risk: 'low', scopeOptions: ['once'],
      } } };
    f.runtime.executions.append(event);
    const pending = f.runtime.executions.sync(device, { session_id: remote.id, after: 0 });
    assert.equal(pending.interactions[0]?.id, wireId);
    assert.ok('interaction' in pending.events[0]!);
    assert.equal(pending.events[0].interaction.id, wireId);
    f.approvals.resolve(approvalId, 'decline', 'tool');
    await asking;
    f.runtime.executions.append({ ...event, event: 'approval_resolved', display: { type: 'interaction.resolved',
      data: { approvalId, decision: 'decline', auto: false } } });
    // Recreate the journal to prove persisted source ids need no alias cache.
    const data = new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector)
      .sync(device, { session_id: remote.id, after: 0 });
    assert.equal(data.interactions.length, 0);
    assert.ok('interaction' in data.events[0]!);
    assert.ok('resolution' in data.events[1]!);
    assert.equal(data.events[0].interaction.id, wireId);
    assert.equal(data.events[1].resolution.interaction_id, wireId);
    const localId = generateCanonicalId();
    f.db.prepare('INSERT INTO sessions (id, executor, native_session_id, task_id) VALUES (?, ?, ?, ?)')
      .run(localId, 'claude', generateCanonicalId(), f.taskId);
    const bindings = new RemoteExecutionBindings(f.db);
    const binding = bindings.bind({ local_session_id: localId, target: {
      server_origin: 'https://remote.example', server_identity_fingerprint: 'a'.repeat(64), account_id: '42',
      host_id: generateCanonicalId(), remote_session_id: remote.id,
    } });
    const replicas = new RemoteExecutionReplicas(f.db);
    replicas.apply(binding, data);
    replicas.apply(binding, data);
    assert.equal(replicas.items(localId).length, 2);
    assert.equal(replicas.snapshot(localId)?.events.length, 0);
    const history = new RemoteExecutionReplicas(f.db).items(localId).map(entry => remoteHistoryEvent(localId, entry));
    assert.equal(history[0]?.display?.type, 'interaction.approval');
    assert.equal(history[1]?.display?.type, 'interaction.resolved');
    if (history[0]?.display?.type === 'interaction.approval' && history[1]?.display?.type === 'interaction.resolved') {
      assert.equal(history[1].display.data.decision, 'decline');
      assert.equal(history[1].display.data.approvalId, history[0].display.data.approvalId);
    }
    assert.throws(() => replicas.apply(binding, { ...data, session: { ...data.session, id: generateCanonicalId() } }), /cross-session/);
    assert.throws(() => replicas.apply(binding, { ...data, events: [], cursor: 0 }), /stale history/);
    assert.throws(() => replicas.apply(binding, { ...data, stream_id: generateCanonicalId() }), /stream changed/);
    assert.throws(() => replicas.apply(binding, { ...data, events: [], cursor: data.cursor + 1 }), /history cursor/);
    assert.equal(executionSyncResultSchema.safeParse(data).success, true);
    assert.equal(f.sessions.getSession(localId).task_id, f.taskId);
  } finally { teardownRemoteHarness(f); }
});
