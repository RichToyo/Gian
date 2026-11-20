import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  EXECUTION_DETAIL_INPUT_BYTES, EXECUTION_DETAIL_MAX_BYTES, EXECUTION_DETAIL_OUTPUT_BYTES, EXECUTION_DETAIL_TEXT_BYTES,
  EXECUTION_HINT_COALESCE_MS, EXECUTION_HINT_HISTORY_COALESCE_MS, MAX_RELAY_FRAME_BYTES, acceptRemoteHello, canonicalJson, createRemoteHello,
  generateCanonicalId, executionSyncResultSchema, identityFingerprint, type ExecutionSession, type ExecutionSyncResult,
} from '@gian/remote-protocol';
import type { EventEnvelope } from '@gian/shared';
import type { RemoteConnector } from '../src/remote/connector.js';
import type { ReplayEnvelope } from '../src/remote/replay-buffer.js';
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
    assert.deepEqual(JSON.parse(exported.execution_principal), { version: 3, server_origin: 'https://remote.example',
      host_id: hostId, device_public_key: JSON.parse(device.publicKey) });

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
    assert.deepEqual(JSON.parse(migrated.execution_principal).device_public_key, JSON.parse(first.publicKey));

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

async function enrollExecutionHost(f: ReturnType<typeof setupRemoteHarness>) {
  const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
  const hostId = generateCanonicalId();
  const serverFingerprint = await identityFingerprint(serverKey);
  await f.runtime.enrollment.recordClaim({ hostId, serverUrl: 'https://remote.example', hostName: 'Execution Host',
    refreshSecret: 'fixture-refresh', serverIdentity: { public_key: serverKey, fingerprint: serverFingerprint } });
  return { hostId, serverOrigin: 'https://remote.example', serverFingerprint };
}

function pairedKey(f: ReturnType<typeof setupRemoteHarness>, x: string, name = 'Controller') {
  return f.runtime.devices.createGeneration({
    id: generateCanonicalId(), publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: x.repeat(43), y: 'Q'.repeat(43) }),
    name, platform: 'desktop', cryptoConnectionId: generateCanonicalId(),
  });
}

test('device executions follow the paired key through a re-pair, never another key or a revoked record', async () => {
  const f = setupRemoteHarness();
  try {
    await enrollExecutionHost(f);
    const original = pairedKey(f, 'K');
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, original);
    assert.equal(f.runtime.executions.sync(original, { session_id: remote.id, after: 0 }).session.id, remote.id);

    const stranger = pairedKey(f, 'S', 'Stranger');
    assert.equal(f.runtime.executions.list(stranger).sessions.length, 0);
    assert.throws(() => f.runtime.executions.authorize(remote.id, stranger), /not available to this device/);
    assert.throws(() => f.runtime.executions.authorize(remote.id, { ...stranger, publicKey: original.publicKey }),
      /device key changed/, 'a record cannot borrow another key');

    f.runtime.devices.revoke(original.id);
    const revoked = f.runtime.devices.get(original.id)!;
    assert.throws(() => f.runtime.executions.authorize(remote.id, revoked), /revoked/);
    assert.throws(() => f.runtime.executions.authorize(remote.id, { ...revoked, revokedAt: null }), /revoked/,
      'a stale unrevoked copy of a removed record is still refused');
    assert.throws(() => f.runtime.executions.authorize(remote.id, { ...original, id: generateCanonicalId() }), /not paired/,
      'the key alone is not enough without a paired record');

    const repaired = f.runtime.devices.createGeneration({ id: generateCanonicalId(), publicKey: original.publicKey,
      name: 'Controller', platform: 'desktop', cryptoConnectionId: generateCanonicalId() });
    assert.notEqual(repaired.id, original.id);
    assert.notEqual(repaired.cryptoConnectionId, original.cryptoConnectionId);
    assert.deepEqual(f.runtime.executions.list(repaired).sessions.map(item => item.id), [remote.id]);
    assert.equal(f.runtime.executions.sync(repaired, { session_id: remote.id, after: 0 }).session.id, remote.id);
    assert.throws(() => f.runtime.executions.authorize(remote.id, f.runtime.devices.get(original.id)!), /revoked/,
      'the removed record stays revoked after its key pairs again');
    assert.throws(() => f.runtime.executions.authorize(remote.id, stranger), /not available to this device/);
  } finally { teardownRemoteHarness(f); }
});

test('version 2 principals migrate idempotently to their own device key and legacy account rows keep their account', async () => {
  const f = setupRemoteHarness();
  try {
    const { hostId, serverOrigin, serverFingerprint } = await enrollExecutionHost(f);
    const identity = () => ({ server_origin: serverOrigin, server_identity_fingerprint: serverFingerprint, host_id: hostId });
    const insert = f.db.prepare(`INSERT INTO remote_execution_exports(session_id, account_id, execution_principal, stream_id, created_at)
      VALUES (?, ?, ?, ?, 1)`);
    const exported = async (accountId: string | null, principal: string | null) => {
      const session = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
      insert.run(session.id, accountId, principal, generateCanonicalId());
      return session.id;
    };
    const v2 = (key: string, host = hostId) => canonicalJson({ version: 2, server_origin: serverOrigin,
      server_identity_fingerprint: 'f'.repeat(64), host_id: host, device_id: generateCanonicalId(),
      device_public_key: JSON.parse(key), device_revision: 3, crypto_connection_id: generateCanonicalId() });
    const mine = pairedKey(f, 'M');
    const theirs = pairedKey(f, 'T', 'Other controller');
    const mineKey = mine.publicKey;
    f.runtime.devices.revoke(mine.id);
    const owned = await exported(null, v2(mineKey));
    const foreign = await exported(null, v2(theirs.publicKey));
    const otherHost = await exported(null, v2(mineKey, generateCanonicalId()));
    const legacy = await exported('42', null);
    const malformed = await exported(null, '{"version":2,"device_public_key":"not a key"}');
    const principals = () => Object.fromEntries((f.db.prepare('SELECT session_id, execution_principal FROM remote_execution_exports')
      .all() as Array<{ session_id: string; execution_principal: string | null }>).map(row => [row.session_id, row.execution_principal]));

    new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector, identity);
    const once = principals();
    assert.deepEqual(JSON.parse(once[owned]!), { version: 3, server_origin: serverOrigin, host_id: hostId,
      device_public_key: JSON.parse(mineKey) });
    assert.deepEqual(JSON.parse(once[foreign]!).device_public_key, JSON.parse(theirs.publicKey));
    assert.notEqual(JSON.parse(once[otherHost]!).host_id, hostId, 'an export pinned to another Host stays there');
    assert.equal(once[legacy], null);
    assert.equal(once[malformed], '{"version":2,"device_public_key":"not a key"}');
    new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector, identity);
    new RemoteExecutionJournal(f.db, f.sessions, f.runtime.projector);
    assert.deepEqual(principals(), once, 'migration is idempotent');

    const repaired = f.runtime.devices.createGeneration({ id: generateCanonicalId(), publicKey: mineKey,
      name: 'Controller', platform: 'desktop', cryptoConnectionId: generateCanonicalId() });
    f.runtime.executions.authorize(owned, repaired);
    for (const id of [foreign, otherHost, malformed]) {
      assert.throws(() => f.runtime.executions.authorize(id, repaired), /not available to this device/);
    }
    assert.deepEqual(f.runtime.executions.list(repaired).sessions.map(item => item.id), [owned]);
    assert.deepEqual(f.runtime.executions.list(theirs).sessions.map(item => item.id), [foreign]);

    f.runtime.devices.bindAccount(repaired.id, '42');
    f.runtime.executions.authorize(legacy, f.runtime.devices.get(repaired.id)!);
    f.runtime.devices.bindAccount(theirs.id, '99');
    assert.throws(() => f.runtime.executions.authorize(legacy, f.runtime.devices.get(theirs.id)!), /legacy account/);
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

test('a card the Host drops without a Provider event closes exactly once, and local-only approvals stay on this Host', async () => {
  const f = setupRemoteHarness();
  try {
    const device = seedDevice(f);
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, device);
    const event = (turn: number, callId: string, name: string, display: EventEnvelope['display']): EventEnvelope =>
      ({ session_id: remote.id, turn, call_id: callId, ts: Date.now(), event: name, data: {}, display });
    const broadcast = (envelope: EventEnvelope) => f.broadcaster.broadcast({ type: 'event', ...envelope });
    const ask = (turn: number, approvalId: string, register = true) => {
      f.db.prepare('INSERT OR IGNORE INTO turns (id, session_id, turn_number) VALUES (?, ?, ?)').run(`host-turn-${turn}`, remote.id, turn);
      broadcast(event(turn, approvalId, 'interaction.requested', { type: 'interaction.approval', data: {
        approvalId, title: 'Run', category: 'command', description: 'run a command', risk: 'high', scopeOptions: ['once'] } }));
      if (register) void f.approvals.request({ sessionId: remote.id, turnId: `host-turn-${turn}`, turnNumber: turn,
        category: 'command', risk: 'high', description: 'run a command', payload: { approvalId } }).catch(() => undefined);
    };
    const turnEnd = (turn: number) => broadcast(event(turn, `gian:turn-completed:host-turn-${turn}`, 'gian.turn.completed',
      { type: 'state.turn-completed', data: { turnId: `host-turn-${turn}`, status: 'stopped' } }));
    const history = () => f.runtime.executions.sync(device, { session_id: remote.id, after: 0 });
    const closes = (approvalId: string, turn: number) => {
      const card = remoteInteractionResourceId(remote.id, `host-turn-${turn}`, approvalId);
      return history().events.flatMap(entry => 'resolution' in entry && entry.resolution.interaction_id === card
        ? [entry.resolution] : []);
    };

    // Turn end (completeTurn) and Stop recovery release through the manager.
    ask(1, 'released');
    f.approvals.releaseHostTurn(remote.id, 'host-turn-1');
    turnEnd(1);
    // A Provider resolution that arrives after the release is not a second close.
    broadcast(event(1, 'released', 'interaction.resolved', { type: 'interaction.resolved',
      data: { approvalId: 'released', decision: 'allow_once', auto: false } }));
    assert.deepEqual(closes('released', 1).map(close => [close.decision, close.auto, close.turn]), [['decline', true, 1]]);

    // A Proxy exit or fault clears the whole session.
    ask(2, 'cleared');
    f.approvals.clearSession(remote.id);
    assert.deepEqual(closes('cleared', 2).map(close => [close.decision, close.auto]), [['decline', true]]);

    // A Host restart lost the waiter: the turn end closes the card before it.
    ask(3, 'restarted', false);
    turnEnd(3);
    assert.equal(closes('restarted', 3).length, 1);
    const order = history().events.slice(-2).map(entry => 'resolution' in entry ? 'close' : 'item' in entry ? entry.item.kind : 'card');
    assert.deepEqual(order, ['close', 'turn-end']);

    // Orphaned turns end before their release: a card still pending is left
    // to its own release and still closes exactly once.
    ask(4, 'orphaned');
    turnEnd(4);
    assert.equal(closes('orphaned', 4).length, 0, 'never closed while still pending on this Host');
    assert.equal(history().interactions.length, 1);
    f.approvals.releaseHostTurn(remote.id, 'host-turn-4');
    assert.equal(closes('orphaned', 4).length, 1);
    assert.equal(history().interactions.length, 0);

    // A Browser capture approval is answered only in this Host's Desktop.
    void f.approvals.request({ sessionId: remote.id, turnId: 'host-turn-4', turnNumber: 4, category: 'browser_capture',
      risk: 'high', description: 'capture', payload: { localOnly: true } }).catch(() => undefined);
    assert.equal(f.sessions.listPendingApprovals().length, 1);
    const synced = history();
    assert.deepEqual(synced.interactions, []);
    assert.equal(synced.events.filter(entry => 'interaction' in entry).length, 4, 'no request entry is journaled for it');
    assert.equal(executionSyncResultSchema.safeParse(synced).success, true);
    f.approvals.clearSession(remote.id);
  } finally { teardownRemoteHarness(f); }
});

test('change hints reach only negotiated controllers that may sync the session, coalesced and content-free', async () => {
  const f = setupRemoteHarness();
  try {
    const serverKey = { kty: 'EC' as const, crv: 'P-256' as const, x: 'A'.repeat(43), y: 'B'.repeat(43) };
    await f.runtime.enrollment.recordClaim({
      hostId: generateCanonicalId(), serverUrl: 'https://remote.example', hostName: 'Execution Host', refreshSecret: 'fixture-refresh',
      serverIdentity: { public_key: serverKey, fingerprint: await identityFingerprint(serverKey) },
    });
    const desktop = (name: string, x: string, y: string) => f.runtime.devices.create({
      publicKey: JSON.stringify({ kty: 'EC', crv: 'P-256', x: x.repeat(43), y: y.repeat(43) }),
      name, platform: 'desktop', cryptoConnectionId: generateCanonicalId(),
    });
    const owner = desktop('Controller', 'C', 'D');
    const stranger = desktop('Another controller', 'E', 'F');
    const older = desktop('Controller before hints', 'G', 'H');
    const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(remote.id, owner);
    const olderRemote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
    f.runtime.executions.register(olderRemote.id, older);
    const local = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });

    const connectors = (f.runtime as unknown as { connectors: Map<string, RemoteConnector> }).connectors;
    const connect = (deviceId: string, features: string[]) => {
      const sent: Array<Record<string, unknown>> = [];
      connectors.set(deviceId, { supportsFeature: (feature: string) => features.includes(feature),
        sendControl: async (message: Record<string, unknown>) => { sent.push(message); },
        sendTranscript: (message: Record<string, unknown>) => { sent.push(message); }, close() {} } as unknown as RemoteConnector);
      return () => sent.filter(message => message.type === 'execution.changed');
    };
    const hinted = ['wire.execution_v1', 'wire.device_execution_target', 'wire.execution_hints_v1'];
    const ownerHints = connect(owner.id, hinted);
    const strangerHints = connect(stranger.id, hinted);
    const olderHints = connect(older.id, ['wire.execution_v1', 'wire.device_execution_target']);
    const sequence = (sessionId: string) => (f.db.prepare('SELECT sequence FROM remote_execution_exports WHERE session_id = ?')
      .get(sessionId) as { sequence: number }).sequence;
    const delta = (sessionId: string, index: number) => f.broadcaster.broadcast({ type: 'event', session_id: sessionId, turn: 1,
      call_id: `delta-${index}`, ts: Date.now(), event: 'content.delta', data: {},
      display: { type: 'message', data: { itemId: 'reply', text: 'x', delta: true } } });
    const settle = () => new Promise(resolve => setImmediate(resolve));
    const windowEnds = () => new Promise(resolve => setTimeout(resolve, EXECUTION_HINT_COALESCE_MS + 60));
    const historyWindowEnds = () => new Promise(resolve => setTimeout(resolve, EXECUTION_HINT_HISTORY_COALESCE_MS + 60));

    // A streaming burst, a status change and a queue change in one tick are one hint.
    for (let index = 0; index < 30; index += 1) delta(remote.id, index);
    f.broadcaster.broadcast({ type: 'session:updated', session: { id: remote.id, status: 'running' } });
    f.broadcaster.broadcast({ type: 'queue:updated', session_id: remote.id, queue: [] });
    await settle();
    assert.deepEqual(ownerHints(), [{ type: 'execution.changed', version: 1, host_generation: f.runtime.generation,
      session_id: remote.id, sequence: sequence(remote.id) }], 'only the session id and its history sequence');
    // Changes inside the window coalesce into one trailing hint.
    for (let index = 30; index < 60; index += 1) delta(remote.id, index);
    await settle();
    assert.equal(ownerHints().length, 1);
    await historyWindowEnds();
    assert.equal(ownerHints().length, 2);
    assert.equal(ownerHints()[1]!.sequence, sequence(remote.id));
    // A quiet window closes; the next change is sent at once again.
    await historyWindowEnds();
    assert.equal(ownerHints().length, 2);

    // A streaming Turn's appends alone wait out the longer history window...
    delta(remote.id, 60);
    await settle();
    assert.equal(ownerHints().length, 3);
    delta(remote.id, 61);
    await windowEnds();
    assert.equal(ownerHints().length, 3, 'history alone keeps the history window');
    // ...but a state change pulls the trailing hint forward.
    f.broadcaster.broadcast({ type: 'session:updated', session: { id: remote.id, status: 'pending' } });
    await windowEnds();
    assert.equal(ownerHints().length, 4);
    assert.equal(ownerHints()[3]!.sequence, sequence(remote.id));
    await historyWindowEnds();

    // A pending approval appearing or closing is a change without a history append.
    const before = sequence(remote.id);
    f.db.prepare('INSERT OR IGNORE INTO turns (id, session_id, turn_number) VALUES (?, ?, ?)').run('host-turn-1', remote.id, 1);
    void f.approvals.request({ sessionId: remote.id, turnId: 'host-turn-1', turnNumber: 1, category: 'command', risk: 'high',
      description: 'run a command', payload: { approvalId: 'ask' } }).catch(() => undefined);
    await settle();
    assert.equal(ownerHints().length, 5);
    assert.equal(ownerHints()[4]!.sequence, before);
    await historyWindowEnds();
    f.approvals.clearSession(remote.id);
    await settle();
    assert.equal(ownerHints().length, 6);
    await historyWindowEnds();

    // Never a local session, and never another device's session.
    f.broadcaster.broadcast({ type: 'session:updated', session: { id: local.id, name: 'Local only' } });
    for (let index = 0; index < 3; index += 1) delta(olderRemote.id, index);
    await settle();
    assert.equal(ownerHints().length, 6);
    assert.deepEqual(strangerHints(), [], 'a negotiated device that may not sync the session learns nothing');
    assert.deepEqual(olderHints(), [], 'a controller that did not negotiate hints never receives one');
    assert.ok((f.runtime.replay as unknown as { frames: ReplayEnvelope[] }).frames
      .every(frame => (frame.message.type as string) !== 'execution.changed'), 'hints are live-only, never replayed');

    // A revoked controller stops receiving hints.
    f.runtime.devices.revoke(owner.id);
    delta(remote.id, 99);
    await settle();
    assert.equal(ownerHints().length, 6);
  } finally { teardownRemoteHarness(f); }
});

/** A legacy-account controller with one exported session and its sync over
 *  the real command adapter, negotiated as `features`. */
async function detailFixture(f: ReturnType<typeof setupRemoteHarness>) {
  const seeded = seedDevice(f, 'Controller');
  f.runtime.devices.bindAccount(seeded.id, '42');
  const device = f.runtime.devices.get(seeded.id)!;
  const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review' });
  f.runtime.executions.register(remote.id, device);
  const append = (callId: string, display: EventEnvelope['display'], turn = 1) => f.runtime.executions.append({
    session_id: remote.id, turn, call_id: callId, ts: Date.now(), event: 'native.event', data: {}, display });
  const sync = async (features: readonly string[], after = 0) => {
    const result = await f.runtime.commands.execute(device, command('execution.sync', { session_id: remote.id, after }), { wireFeatures: features });
    assert.equal(result.ok, true, result.error?.message);
    return result.data as ExecutionSyncResult;
  };
  return { device, remote, append, sync };
}

const DETAIL = ['wire.execution_v1', 'wire.execution_hints_v1', 'wire.execution_detail_v1'];

test('execution detail reaches only controllers that negotiated it, redacted, relative and capped', async () => {
  const f = setupRemoteHarness();
  try {
    const { device, remote, append, sync } = await detailFixture(f);
    const root = f.dir;
    const secret = 'ghp_' + 'a'.repeat(36);
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'running', cwd: `${root}/packages/host`,
      command: `cd ${root} && GITHUB_TOKEN=${secret} AWS_SECRET_ACCESS_KEY=abc123 pnpm test` } });
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'running', command: '', stdoutDelta: 'first line\n' } });
    const longOutput = Array.from({ length: 4000 }, (_, index) => `\u001b[32mline ${index}\u001b[0m ok`).join('\n')
      + `\nAuthorization: Bearer ${secret}\nDB_PASSWORD=hunter2 FAIL`;
    append('cmd', { type: 'activity.command', data: { itemId: 'cmd', status: 'error', exitCode: 1, command: 'pnpm test', stdout: longOutput } });
    append('edit', { type: 'activity.file-change', data: { cwd: root, files: [
      { path: `${root}/src/a.ts`, kind: 'update', added: 2, removed: 1 }, { path: 'docs/new.md', kind: 'create' },
      { path: '/etc/hosts', kind: 'delete' }, { path: '', kind: 'update' },
    ], diff: `diff --git a/${root}/src/a.ts b/${root}/src/a.ts\n--- a/${root}/src/a.ts\n+++ b/${root}/src/a.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+API_KEY=${secret}\n` } });
    append('huge', { type: 'activity.file-change', data: { files: [{ path: 'big.txt', kind: 'update', added: 6000 }],
      diff: 'diff --git a/big.txt b/big.txt\n--- a/big.txt\n+++ b/big.txt\n@@ -0,0 +1,6000 @@\n' + '+x\n'.repeat(6000) } });
    append('tool', { type: 'activity.tool', data: { itemId: 'tool', title: 'mcp.deploy', status: 'success',
      input: { target: 'prod', api_key: 'sk-live-123', content: 'y'.repeat(10_000) }, output: { deployed: true } } });
    append('fail', { type: 'state.error', data: { retryable: false,
      message: `Request failed: token=${secret}\n    at fetch (${root}/node_modules/x.js:1:1)\n    at run (${root}/src/run.ts:9:9)` } });
    append('answer', { type: 'message', data: { itemId: 'answer', text: 'Done.', delta: false } });

    // Remote Web's default hello, and every controller that did not opt in,
    // gets exactly what execution.sync sent before the feature existed.
    const identity = { deviceId: device.id, connectionId: generateCanonicalId(), hostGeneration: f.runtime.generation, hostVersion: 'test' };
    const remoteWeb = acceptRemoteHello(createRemoteHello(device.id, 'remote-web'), identity).negotiated_capabilities;
    const hintsOnly = acceptRemoteHello(createRemoteHello(device.id, 'gian-native', { executionHintsV1: true }), identity).negotiated_capabilities;
    const plain = f.runtime.executions.sync(device, { session_id: remote.id, after: 0 });
    for (const features of [[], remoteWeb, hintsOnly, ['wire.execution_v1', 'wire.execution_hints_v1']]) {
      const synced = await sync(features);
      assert.equal(canonicalJson(synced.events), canonicalJson(plain.events));
      for (const entry of synced.events) {
        if ('item' in entry) assert.deepEqual(Object.keys(entry).sort(), ['item', 'sequence'], 'an older controller parses this closed');
      }
    }

    const detailed = await sync(DETAIL);
    assert.equal(executionSyncResultSchema.safeParse(detailed).success, true);
    assert.deepEqual(detailed.events.map(entry => 'item' in entry ? entry.item : entry), plain.events.map(entry => 'item' in entry ? entry.item : entry),
      'items are unchanged; detail rides beside them');
    const details = detailed.events.flatMap(entry => 'item' in entry ? [[entry.item.kind, entry.detail] as const] : []);
    const [started, delta, finished, edit, huge, tool, failure, answer] = details.map(([, detail]) => detail);
    assert.deepEqual(details.map(([kind]) => kind), ['command', 'command', 'command', 'file-change', 'file-change', 'tool', 'error', 'assistant']);
    assert.equal(answer, undefined, 'a kind without detail carries none');

    assert.equal(started?.command, `cd ${root} && GITHUB_TOKEN=[REDACTED] AWS_SECRET_ACCESS_KEY=[REDACTED] pnpm test`);
    assert.equal(started?.output, undefined);
    assert.deepEqual(delta, { output: { text: 'first line\n', delta: true, truncated: false } }, 'an empty command line is left off');
    assert.equal(finished?.command, 'pnpm test');
    const output = finished!.output!;
    assert.equal(output.delta, false);
    assert.equal(output.truncated, true);
    assert.ok(Buffer.byteLength(output.text) <= EXECUTION_DETAIL_OUTPUT_BYTES);
    assert.match(output.text, /^line \d+ ok\n/, 'the tail starts on a whole line, without terminal escapes');
    assert.ok(output.text.endsWith('Authorization: Bearer [REDACTED]\nDB_PASSWORD=[REDACTED] FAIL'));

    assert.deepEqual(edit?.files, [
      { reference: 'src/a.ts', change: 'update', added: 2, removed: 1 }, { reference: 'docs/new.md', change: 'create' },
      { reference: '/etc/hosts', change: 'delete' },
    ]);
    assert.equal(edit?.diff, 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,1 +1,2 @@\n-old\n+new\n+API_KEY=[REDACTED]\n');
    assert.deepEqual(huge, { files: [{ reference: 'big.txt', change: 'update', added: 6000 }] }, 'a diff over its cap is never cut, only left off');

    assert.equal(tool?.output?.text, '{\n  "deployed": true\n}');
    assert.ok(Buffer.byteLength(tool!.input!) <= EXECUTION_DETAIL_INPUT_BYTES);
    assert.match(tool!.input!, /^\{"target":"prod","api_key":"\[REDACTED\]","content":"y+…$/);

    assert.equal(failure?.message, 'Request failed: token=[REDACTED]', 'no stack frames or Host paths');

    const wire = JSON.stringify(detailed.events);
    assert.equal(wire.includes(secret), false);
    assert.equal(wire.includes('hunter2') || wire.includes('sk-live-123') || wire.includes('abc123'), false);
    assert.equal(wire.includes(`${root}/src`) || wire.includes('node_modules') || wire.includes('packages/host'), false,
      'file references and messages carry no Host worktree paths or cwd');
  } finally { teardownRemoteHarness(f); }
});

test('detail keeps every execution.sync page inside its byte budget and each item inside its own bound', async () => {
  const f = setupRemoteHarness();
  try {
    const { append, sync } = await detailFixture(f);
    const noisy = '"\\'.repeat(60_000);
    for (let index = 0; index < 40; index += 1) {
      append(`cmd-${index}`, { type: 'activity.command', data: { itemId: `cmd-${index}`, status: 'success', exitCode: 0,
        command: `echo ${'"'.repeat(8000)}`, stdout: noisy } });
      append(`files-${index}`, { type: 'activity.file-change', data: { files: Array.from({ length: 200 }, (_, file) => ({
        path: `dir/${String(file).padEnd(900, 'f')}.ts`, kind: 'update' })),
        diff: `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n+${'\\'.repeat(16_000)}\n` } });
    }
    let after = 0;
    let pages = 0;
    for (;;) {
      const page = await sync(DETAIL, after);
      pages += 1;
      assert.ok(page.events.length > 0);
      assert.ok(Buffer.byteLength(JSON.stringify(page.events)) <= 192 * 1024 + 2 * page.events.length, 'the page budget holds with detail');
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < MAX_RELAY_FRAME_BYTES);
      for (const entry of page.events) {
        assert.equal(entry.sequence, ++after, 'pages stay contiguous');
        assert.ok('item' in entry && entry.detail);
        assert.ok(Buffer.byteLength(JSON.stringify(entry.detail)) <= EXECUTION_DETAIL_MAX_BYTES);
        if (entry.item.kind === 'command') {
          assert.ok(Buffer.byteLength(entry.detail.command!) <= EXECUTION_DETAIL_TEXT_BYTES);
          assert.equal(entry.detail.output?.truncated, true);
        } else {
          assert.ok(entry.detail.files!.length < 200, 'a long file list stops at its share of the bound');
          assert.ok(entry.detail.diff, 'a whole diff within its cap still fits beside it');
        }
      }
      assert.equal(page.cursor, after);
      if (!page.has_more) break;
    }
    assert.equal(after, 80);
    assert.ok(pages > 1);
  } finally { teardownRemoteHarness(f); }
});
