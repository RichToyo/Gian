import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { remoteStableUuid } from '../src/remote/projection.js';
import { command, HARNESS_AGENT, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

const hooks = { wireFeatures: ['wire.session_directory_v1'] };

test('negotiated taskless create preserves catalog/Task validation and one durable session identity across retries', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const params = { catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id), name: 'Taskless conversation' };
    const request = command('session.create', params);
    const created = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(created.ok, true, created.error?.message);
    const id = (created.data as { id: string; task_id: string | null }).id;
    assert.equal((created.data as { task_id: string | null }).task_id, null);
    const repeat = await h.runtime.commands.execute(device, { ...request, attempt_id: randomUUID() }, hooks);
    assert.equal(repeat.ok, true);
    assert.equal((repeat.data as { id: string }).id, id);
    assert.equal(h.sessions.listSessions().length, 1);
    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal((status.data as { state: string }).state, 'succeeded');
    assert.equal((status.data as { result: { id: string } }).result.id, id);
    const changed = await h.runtime.commands.execute(device, { ...request, attempt_id: randomUUID(), params: { ...params, name: 'different input' } }, hooks);
    assert.equal(changed.error?.code, 'IDEMPOTENCY_CONFLICT');
    const afterConflict = await h.runtime.commands.execute(device, request, hooks);
    assert.equal((afterConflict.data as { id: string }).id, id, 'conflict must not overwrite the immutable receipt');
    const unnegotiated = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }));
    assert.equal(unnegotiated.error?.code, 'REMOTE_CAPABILITY_DENIED');
    assert.equal((await h.runtime.commands.execute(device, command('session.create', { ...params, catalog_revision: 'stale' }), hooks)).ok, false);
    const done = h.tasks.createTask({ name: 'Done task' });
    h.tasks.updateTask(done.id, { status: 'done' });
    assert.equal((await h.runtime.commands.execute(device, command('session.create', { ...params,
      catalog_revision: h.runtime.projector.catalogRevision(), task_id: done.id }), hooks)).ok, false);
    const associated = await h.runtime.commands.execute(device, command('session.create', { ...params,
      catalog_revision: h.runtime.projector.catalogRevision(), task_id: h.taskId }), hooks);
    assert.equal(associated.ok, true, associated.error?.message);
    assert.equal((associated.data as { task_id: string }).task_id, h.taskId);
    h.db.prepare('UPDATE workspaces SET hidden = 1 WHERE id = ?').run(h.workspaceId);
    assert.equal((await h.runtime.commands.execute(device, command('session.create', { ...params,
      catalog_revision: h.runtime.projector.catalogRevision() }), hooks)).error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(h); }
});

test('first Send has an independent recoverable identity and duplicate attempts do not create or dispatch twice', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const create = command('session.create', { catalog_revision: h.runtime.projector.catalogRevision(),
      workspace_id: h.workspaceId, agent_id: remoteStableUuid('agent', HARNESS_AGENT.id) });
    const created = await h.runtime.commands.execute(device, create, hooks);
    assert.equal(created.ok, true, created.error?.message);
    const id = (created.data as { id: string }).id;
    const send = command('session.send', { session_id: id, text: 'synthetic first send', busy: 'fail' });
    assert.notEqual(send.command_id, create.command_id);
    const sent = await h.runtime.commands.execute(device, send, hooks);
    assert.equal(sent.ok, true, sent.error?.message);
    const repeated = await h.runtime.commands.execute(device, { ...send, attempt_id: randomUUID() }, hooks);
    assert.equal(repeated.ok, true, repeated.error?.message);
    assert.equal(h.proxy.client.startTurnCalls.length, 1);
    assert.equal(h.sessions.listSessions().length, 1);
    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: send.command_id }), hooks);
    assert.equal((status.data as { state: string }).state, 'succeeded');
  } finally { teardownRemoteHarness(h); }
});

test('taskless create still enters canonical Agent readiness/config validation, never a Remote-only creation path', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    let calls = 0;
    t.mock.method(h.access, 'call', async (actor, call) => {
      calls += 1;
      assert.ok(actor.grants.includes('session.create'));
      assert.equal(call.method, 'session.create');
      assert.equal(Object.hasOwn(call.params, 'task_id'), false);
      return { ok: false, request_id: call.request_id,
        error: { code: 'AGENT_NOT_READY', message: 'Synthetic Agent readiness rejection', retryable: false } };
    });
    const result = await h.runtime.commands.execute(device, command('session.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    }), hooks);
    assert.equal(result.ok, false);
    assert.equal(calls, 1);
    assert.equal(h.sessions.listSessions().length, 0);
  } finally { teardownRemoteHarness(h); }
});

test('status recovers a committed Tool domain after create acknowledgement loss without reentering creation or stale catalog rejection', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const request = command('session.create', { catalog_revision: h.runtime.projector.catalogRevision(),
      workspace_id: h.workspaceId, agent_id: remoteStableUuid('agent', HARNESS_AGENT.id) });
    const result = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(result.ok, true, result.error?.message);
    const id = (result.data as { id: string }).id;
    // Reproduce the durable boundary: Tool domain committed, Remote terminal
    // result/ack absent. No fabricated session identity or second create.
    h.db.prepare(`UPDATE remote_command_ledger SET state = 'accepted', tool_result_json = ? WHERE device_id = ? AND command_id = ?`)
      .run(JSON.stringify({ directory_create_v1: 1, scope: h.runtime.executions.scope(device), params: request.params }), device.id, request.command_id);
    h.tasks.createTask({ name: 'Catalog advanced' });
    t.mock.method(h.access, 'call', async () => { throw new Error('must not reenter canonical creation'); });
    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal(status.ok, true, status.error?.message);
    assert.equal((status.data as { state: string; result: { id: string } }).state, 'succeeded');
    assert.equal((status.data as { result: { id: string } }).result.id, id);
    const retry = await h.runtime.commands.execute(device, { ...request, attempt_id: randomUUID() }, hooks);
    assert.equal((retry.data as { id: string }).id, id);
    assert.equal(h.sessions.listSessions().length, 1);
    h.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(id);
    assert.equal((await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks)).ok, false);
  } finally { teardownRemoteHarness(h); }
});

test('uncertain create without a domain remains unknown, and changed permission cannot replay a saved create', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const request = command('session.create', { catalog_revision: h.runtime.projector.catalogRevision(),
      workspace_id: h.workspaceId, agent_id: remoteStableUuid('agent', HARNESS_AGENT.id) });
    h.db.prepare(`INSERT INTO remote_command_ledger
      (command_id, device_id, method, attempt_id, state, tool_result_json, error_json, created_at, updated_at)
      VALUES (?, ?, 'session.create', ?, 'unknown_outcome', ?, NULL, ?, ?)`)
      .run(request.command_id, device.id, request.attempt_id, JSON.stringify({ directory_create_v1: 1, scope: h.runtime.executions.scope(device), params: request.params }), Date.now(), Date.now());
    t.mock.method(h.access, 'call', async () => { throw new Error('unknown create must not be replayed'); });
    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal((status.data as { state: string }).state, 'unknown_outcome');
    assert.equal((await h.runtime.commands.execute(device, request, hooks)).error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(h.sessions.listSessions().length, 0);
    h.db.prepare('UPDATE remote_devices SET grants_json = ? WHERE id = ?').run(JSON.stringify(device.grants.filter(g => g !== 'session.create')), device.id);
    assert.equal((await h.runtime.commands.execute(device, request, hooks)).error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(h); }
});

test('create success followed by archive is unknown to the caller, preserved as success, and recovered by original ID', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const params = { catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id) };
    const request = command('session.create', params);
    const originalCall = h.access.call.bind(h.access);
    let calls = 0;
    t.mock.method(h.access, 'call', async (actor, call) => {
      calls += 1;
      const result = await originalCall(actor, call);
      const sessionId = (result.data as { session: { id: string } }).session.id;
      h.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(sessionId);
      return result;
    });
    const result = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.data, undefined);
    const row = h.db.prepare('SELECT state, tool_result_json FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, request.command_id) as { state: string; tool_result_json: string };
    assert.equal(row.state, 'succeeded');
    assert.equal(JSON.parse(row.tool_result_json).directory_create_v1, 1);

    const sessionId = JSON.parse(row.tool_result_json).session_id as string;
    const blocked = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.error?.code, 'REMOTE_CAPABILITY_DENIED');
    assert.equal(blocked.data, undefined);
    h.db.prepare('UPDATE sessions SET archived = 0 WHERE id = ?').run(sessionId);
    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal(status.ok, true, status.error?.message);
    assert.equal((status.data as { state: string }).state, 'succeeded');
    assert.equal((status.data as { result: { id: string } }).result.id, sessionId);
    assert.equal(calls, 1);
  } finally { teardownRemoteHarness(h); }
});

test('send success followed by revocation is not a definitive failure or a second dispatch', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const created = await h.runtime.commands.execute(device, command('session.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    }), hooks);
    assert.equal(created.ok, true, created.error?.message);
    const sessionId = (created.data as { id: string }).id;
    const send = command('session.send', { session_id: sessionId, text: 'dispatch once', busy: 'fail' });
    const originalCall = h.access.call.bind(h.access);
    t.mock.method(h.access, 'call', async (actor, call) => {
      const result = await originalCall(actor, call);
      h.runtime.devices.revoke(device.id);
      return result;
    });
    const result = await h.runtime.commands.execute(device, send, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.data, undefined);
    assert.equal(h.proxy.client.startTurnCalls.length, 1);
    const row = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, send.command_id) as { state: string };
    assert.equal(row.state, 'succeeded');

    const blocked = await h.runtime.commands.execute(device, command('command.status', { command_id: send.command_id }), hooks);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.data, undefined);
    const retained = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, send.command_id) as { state: string };
    assert.equal(retained.state, 'succeeded');
    assert.equal(h.proxy.client.startTurnCalls.length, 1);
  } finally { teardownRemoteHarness(h); }
});

test('create Tool success followed by projection failure recovers the original command without a second create', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const request = command('session.create', { catalog_revision: h.runtime.projector.catalogRevision(),
      workspace_id: h.workspaceId, agent_id: remoteStableUuid('agent', HARNESS_AGENT.id) });
    const originalCall = h.access.call.bind(h.access);
    let calls = 0;
    t.mock.method(h.access, 'call', async (actor, call) => {
      calls += 1;
      return originalCall(actor, call);
    });
    const originalProject = h.runtime.projector.projectSession.bind(h.runtime.projector);
    let failProjection = true;
    t.mock.method(h.runtime.projector, 'projectSession', (session, deviceId) => {
      if (failProjection) {
        failProjection = false;
        throw Object.assign(new Error('synthetic create projection failure'), { code: 'INVALID_FRAME' });
      }
      return originalProject(session, deviceId);
    });
    const result = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.data, undefined);
    assert.equal(h.tool.lookupRequest(`remote:${device.id}`, request.command_id)?.status, 'succeeded');
    const row = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, request.command_id) as { state: string };
    assert.equal(row.state, 'unknown_outcome');
    assert.equal(h.sessions.listSessions().length, 1);

    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal(status.ok, true, status.error?.message);
    assert.equal((status.data as { state: string }).state, 'succeeded');
    const sessionId = (status.data as { result: { id: string } }).result.id;
    const retry = await h.runtime.commands.execute(device, { ...request, attempt_id: randomUUID() }, hooks);
    assert.equal(retry.ok, true, retry.error?.message);
    assert.equal((retry.data as { id: string }).id, sessionId);
    assert.equal(calls, 1);
    assert.equal(h.sessions.listSessions().length, 1);
  } finally { teardownRemoteHarness(h); }
});

test('send Tool success followed by projection failure stays recoverable without a second delivery', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const created = await h.runtime.commands.execute(device, command('session.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    }), hooks);
    assert.equal(created.ok, true, created.error?.message);
    const sessionId = (created.data as { id: string }).id;
    const request = command('session.send', { session_id: sessionId, text: 'synthetic projected send', busy: 'fail' });
    const originalCall = h.access.call.bind(h.access);
    let calls = 0;
    t.mock.method(h.access, 'call', async (actor, call) => {
      calls += 1;
      return originalCall(actor, call);
    });
    const originalProject = h.runtime.projector.projectSession.bind(h.runtime.projector);
    let failProjection = true;
    t.mock.method(h.runtime.projector, 'projectSession', (session, deviceId) => {
      if (failProjection) {
        failProjection = false;
        throw Object.assign(new Error('synthetic send projection denial'), { code: 'REMOTE_CAPABILITY_DENIED' });
      }
      return originalProject(session, deviceId);
    });
    const result = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.data, undefined);
    assert.equal(h.tool.lookupRequest(`remote:${device.id}`, request.command_id)?.status, 'succeeded');
    const row = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, request.command_id) as { state: string };
    assert.equal(row.state, 'unknown_outcome');

    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: request.command_id }), hooks);
    assert.equal(status.ok, true, status.error?.message);
    assert.equal((status.data as { state: string }).state, 'unknown_outcome');
    assert.equal((status.data as { result?: unknown }).result, undefined);
    const retry = await h.runtime.commands.execute(device, { ...request, attempt_id: randomUUID() }, hooks);
    assert.equal(retry.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(calls, 1);
    assert.equal(h.proxy.client.startTurnCalls.length, 1);
  } finally { teardownRemoteHarness(h); }
});

test('pre-dispatch authorization rejection remains a definitive failure with no side effects', async () => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const created = await h.runtime.commands.execute(device, command('session.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    }), hooks);
    assert.equal(created.ok, true, created.error?.message);
    const sessionId = (created.data as { id: string }).id;
    h.db.prepare('UPDATE remote_devices SET grants_json = ? WHERE id = ?').run('[]', device.id);
    const send = command('session.send', { session_id: sessionId, text: 'must not dispatch', busy: 'fail' });
    const result = await h.runtime.commands.execute(device, send, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'REMOTE_CAPABILITY_DENIED');
    assert.equal(h.proxy.client.startTurnCalls.length, 0);
    const row = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, send.command_id) as { state: string } | undefined;
    assert.equal(row, undefined);
  } finally { teardownRemoteHarness(h); }
});

test('dispatch UNKNOWN_OUTCOME stays unknown and is queried only by the original command ID', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const created = await h.runtime.commands.execute(device, command('session.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    }), hooks);
    assert.equal(created.ok, true, created.error?.message);
    const sessionId = (created.data as { id: string }).id;
    const send = command('session.send', { session_id: sessionId, text: 'uncertain acknowledgement', busy: 'fail' });
    let calls = 0;
    t.mock.method(h.access, 'call', async () => {
      calls += 1;
      throw Object.assign(new Error('acknowledgement lost'), { code: 'UNKNOWN_OUTCOME' });
    });
    const result = await h.runtime.commands.execute(device, send, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(result.data, undefined);
    const row = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, send.command_id) as { state: string };
    assert.equal(row.state, 'unknown_outcome');
    const status = await h.runtime.commands.execute(device, command('command.status', { command_id: send.command_id }), hooks);
    assert.equal(status.ok, true, status.error?.message);
    assert.equal((status.data as { state: string }).state, 'unknown_outcome');
    const repeated = await h.runtime.commands.execute(device, send, hooks);
    assert.equal(repeated.error?.code, 'UNKNOWN_OUTCOME');
    assert.equal(calls, 1);
  } finally { teardownRemoteHarness(h); }
});

test('read-only subscribe after post-dispatch archive returns a definite denial without result data', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const created = await h.runtime.commands.execute(device, command('session.create', {
      catalog_revision: h.runtime.projector.catalogRevision(), workspace_id: h.workspaceId,
      agent_id: remoteStableUuid('agent', HARNESS_AGENT.id),
    }), hooks);
    assert.equal(created.ok, true, created.error?.message);
    const sessionId = (created.data as { id: string }).id;
    const originalProject = h.runtime.projector.projectSession.bind(h.runtime.projector);
    t.mock.method(h.runtime.projector, 'projectSession', (session, deviceId) => {
      h.db.prepare('UPDATE sessions SET archived = 1 WHERE id = ?').run(sessionId);
      return originalProject(session, deviceId);
    });
    const request = command('session.subscribe', { session_id: sessionId });
    const result = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'REMOTE_CAPABILITY_DENIED');
    assert.equal(result.data, undefined);
    assert.equal(h.proxy.client.startTurnCalls.length, 0);
  } finally { teardownRemoteHarness(h); }
});

test('read-only directory list after post-dispatch revocation returns DEVICE_REVOKED without result data', async t => {
  const h = setupRemoteHarness();
  try {
    const device = seedDevice(h);
    const originalList = h.runtime.directory.list.bind(h.runtime.directory);
    t.mock.method(h.runtime.directory, 'list', (current, params, features) => {
      const result = originalList(current, params, features);
      h.runtime.devices.revoke(device.id);
      return result;
    });
    const request = command('directory.list', { view: 'tasks' });
    const result = await h.runtime.commands.execute(device, request, hooks);
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'DEVICE_REVOKED');
    assert.equal(result.data, undefined);
    const row = h.db.prepare('SELECT state FROM remote_command_ledger WHERE device_id = ? AND command_id = ?')
      .get(device.id, request.command_id) as { state: string } | undefined;
    assert.equal(row, undefined);
    assert.equal(h.proxy.client.startTurnCalls.length, 0);
  } finally { teardownRemoteHarness(h); }
});
