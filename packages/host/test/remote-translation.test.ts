import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { generateCanonicalId, type RemoteMethod, RemoteProtocolError } from '@gian/remote-protocol';
import type { EventEnvelope, ServerToClientMessage, TranslationPreferences } from '@gian/shared';
import type { WsBroadcaster } from '../src/web/ws-broadcast.js';
import type { RemoteControllerClient, RemoteControllerEnvironment } from '../src/remote/controller-client.js';
import { RemoteControllerHub } from '../src/remote/controller-hub.js';
import { TranslationService } from '../src/translation/service.js';
import { saveConfig } from '../src/storage/config.js';
import { command, seedDevice, setupRemoteHarness, teardownRemoteHarness } from './fixtures/remote-harness.js';

const prefs: TranslationPreferences = { agent_id: 'local-translator', model: 'luna', sending_language: 'en', reading_language: 'zh-CN' };

async function setup(t: TestContext) {
  const f = setupRemoteHarness();
  const broadcasts: ServerToClientMessage[] = [];
  const hub = new RemoteControllerHub(f.db, { broadcast(message: ServerToClientMessage) { broadcasts.push(message); } } as unknown as WsBroadcaster, f.identity);
  const device = seedDevice(f);
  const remote = await f.sessions.createSession({ workspace_id: f.workspaceId, agent_id: 'agent-claude-review', name: 'Execution' });
  f.runtime.executions.register(remote.id, device);
  const environment: RemoteControllerEnvironment = {
    id: generateCanonicalId(), name: 'Remote', server_origin: 'https://remote.test', server_identity_fingerprint: 'a'.repeat(64),
    host_id: generateCanonicalId(), browser_id: generateCanonicalId(), device_id: device.id,
    crypto_connection_id: generateCanonicalId(), host_public_key_json: null, pairing_id: null, created_at: Date.now(),
  };
  f.db.prepare(`INSERT INTO remote_controller_environments
    (id, name, server_origin, server_identity_fingerprint, host_id, browser_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(environment.id, environment.name, environment.server_origin, environment.server_identity_fingerprint,
      environment.host_id, environment.browser_id, environment.created_at);
  const localId = generateCanonicalId();
  f.db.prepare(`INSERT INTO sessions (id, executor, native_session_id, remote_environment_id, remote_repository_id, remote_repository_name)
    VALUES (?, 'claude', ?, ?, ?, 'Remote')`).run(localId, generateCanonicalId(), environment.id, f.workspaceId);
  hub.bindings.bind({ local_session_id: localId, target: { server_origin: environment.server_origin,
    server_identity_fingerprint: environment.server_identity_fingerprint, account_id: '42', host_id: environment.host_id, remote_session_id: remote.id } });
  await f.identity.setAccountSession(environment.server_origin, { role: 'controller', serverOrigin: environment.server_origin,
    serverFingerprint: environment.server_identity_fingerprint, installationId: generateCanonicalId(), accountId: '42',
    accountLogin: 'owner', token: 'fixture-only', expiresAt: Date.now() + 60_000 }, 'controller');
  const calls: Array<{ preferences: TranslationPreferences; prompt: string }> = [];
  const controls = { loseSendReply: false, failTranslation: false, duplicatePage: false, holdNextSync: null as Promise<void> | null };
  const translation = new TranslationService(f.db, async (preferences, prompt) => {
    calls.push({ preferences, prompt });
    if (controls.failTranslation) throw new Error('local model unavailable');
    const { sources } = JSON.parse(prompt.split('\n').at(-1)!) as { sources: string[] };
    return JSON.stringify({ translations: sources.map(() => prompt.includes('into zh-CN') ? 'translated-reading' : 'Hello in English') });
  });
  saveConfig(f.db, { translation: prefs });
  f.sessions.setTranslationService(translation);
  f.sessions.setRemoteController(hub);
  const requests: Array<{ method: RemoteMethod; params: Record<string, unknown>; commandId?: string }> = [];
  t.mock.method(hub, 'client', () => ({ environment, connected: true,
    async request(method: RemoteMethod, params: Record<string, unknown>, commandId?: string) {
      requests.push({ method, params, commandId });
      if (method === 'execution.sync') {
        // Snapshot BEFORE any hold, so a held response predates later journaling.
        const snapshot = f.runtime.executions.sync(device, {
          session_id: remote.id, after: controls.duplicatePage ? 0 : Number(params.after ?? 0), stream_id: params.stream_id as string | undefined,
        });
        const hold = controls.holdNextSync;
        controls.holdNextSync = null;
        if (hold) await hold;
        return snapshot;
      }
      const result = await f.runtime.commands.execute(device, command(method, params, commandId));
      if (!result.ok) throw new Error(result.error?.message ?? 'remote request failed');
      if (method === 'session.send' && controls.loseSendReply) {
        controls.loseSendReply = false;
        throw new RemoteProtocolError('HOST_OFFLINE', 'lost send reply');
      }
      return result.data;
    },
  }) as unknown as RemoteControllerClient);
  await hub.sync(localId);
  translation.setEnabled(localId, true);
  // A preference on the execution machine must not translate controller input a second time.
  translation.setEnabled(remote.id, true);
  const send = (text: string, extras: Record<string, string> = {}) => hub.handleMessage({
    type: 'message:send', session_id: localId, text, request_id: generateCanonicalId(), ...extras,
  });
  const append = (event: Omit<EventEnvelope, 'session_id'>) => f.runtime.executions.append({ ...event, session_id: remote.id });
  const cleanup = async () => { hub.close(); await translation.shutdown(); teardownRemoteHarness(f); };
  return { ...f, hub, localId, remote, environment, calls, controls, translation, requests, broadcasts, send, append, cleanup };
}

test('remote execution receives English only; local live and reloaded history retain the source text', async t => {
  const f = await setup(t);
  try {
    await f.send('hello-please-review-the-code');
    const send = f.requests.find(request => request.method === 'session.send')!;
    assert.equal(send.params.text, 'Hello in English');
    assert.doesNotMatch(JSON.stringify(send.params), /hello-please-review-the-code|local-translator|luna|translation_id|sourceText/);
    assert.equal(f.calls.length, 1, 'execution machine must not start another translator');
    assert.equal(f.calls[0]?.preferences.agent_id, 'local-translator');
    assert.equal(f.proxy.client.startTurnCalls.length, 1);
    assert.doesNotMatch(JSON.stringify(f.proxy.client.startTurnCalls[0]?.input), /hello-please-review-the-code/);
    const local = f.hub.historyPage(f.localId, null).events.find(event => event.event === 'user_message')!;
    assert.equal(local.data.text, 'hello-please-review-the-code');
    assert.equal((local.data.translation as { text: string }).text, send.params.text);
    assert.ok(f.broadcasts.some(message => message.type === 'event' && message.event === 'user_message' && message.data.text === 'hello-please-review-the-code'));
    const raw = f.hub.replicas.items(f.localId).find(entry => 'item' in entry && entry.item.kind === 'user');
    assert.ok(raw && 'item' in raw && raw.item.kind === 'user');
    assert.equal(raw.item.text, send.params.text, 'replicated remote history stays immutable English');
    const reopened = new RemoteControllerHub(f.db, { broadcast() {} } as unknown as WsBroadcaster, f.identity);
    reopened.setTranslationService(f.translation, () => {});
    assert.equal(reopened.historyEvents(f.localId).find(event => event.event === 'user_message')?.data.text, 'hello-please-review-the-code');
    reopened.close();
  } finally { await f.cleanup(); }
});

test('lost remote send reply recovers the local original by command receipt without sending or translating again', async t => {
  const f = await setup(t);
  try {
    f.controls.loseSendReply = true;
    const sendId = generateCanonicalId();
    await assert.rejects(f.send('original-source-alpha', { send_id: sendId }), /lost send reply/);
    await f.hub.sync(f.localId);
    assert.ok(f.requests.some(request => request.method === 'command.status'));
    assert.equal(f.hub.historyPage(f.localId, null).events.find(event => event.event === 'user_message')?.data.text, 'original-source-alpha');
    saveConfig(f.db, { translation: { ...prefs, sending_language: 'ja', model: 'another-model' } });
    await f.send('original-source-alpha', { send_id: sendId });
    assert.equal(f.requests.filter(request => request.method === 'session.send').length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.hub.historyEvents(f.localId).filter(event => event.event === 'user_message').length, 1);
    await assert.rejects(f.send('different-source-beta', { send_id: sendId }), /request changed/);
  } finally { await f.cleanup(); }
});

test('remote terminal Result is translated locally once, including repeated history pages, without another send', async t => {
  const f = await setup(t);
  try {
    await f.send('source-question');
    f.append({ turn: 1, call_id: 'process', ts: Date.now(), event: 'content.completed', data: {},
      display: { type: 'message', data: { itemId: 'process', text: 'PROCESS ONLY', delta: false } } });
    f.append({ turn: 1, call_id: 'result', ts: Date.now(), event: 'content.completed', data: {},
      display: { type: 'message', data: { itemId: 'result', text: 'FINAL ENGLISH RESULT', delta: false } } });
    f.append({ turn: 1, call_id: 'end', ts: Date.now(), event: 'turn_completed', data: {},
      display: { type: 'state.turn-completed', data: { turnId: 'turn-1', status: 'completed' } } });
    await f.hub.sync(f.localId);
    for (let attempt = 0; attempt < 20 && !f.translation.list(f.localId).some(record => record.purpose === 'read'); attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const reading = f.translation.list(f.localId).find(record => record.purpose === 'read')!;
    assert.equal(reading.sourceText, 'FINAL ENGLISH RESULT');
    assert.equal(reading.text, 'translated-reading');
    assert.equal(reading.sourceId, 'turn:1');
    assert.doesNotMatch(f.calls[1]!.prompt, /PROCESS ONLY/);
    f.controls.duplicatePage = true;
    await f.hub.sync(f.localId);
    assert.equal(f.calls.length, 2);
    assert.equal(f.requests.filter(request => request.method === 'session.send').length, 1);
  } finally { await f.cleanup(); }
});

test('enabling remote automatic translation does not backfill stored results', async t => {
  const f = await setup(t);
  try {
    f.translation.setEnabled(f.localId, false);
    f.append({ turn: 1, call_id: 'old', ts: Date.now(), event: 'content.completed', data: {},
      display: { type: 'message', data: { itemId: 'old', text: 'HISTORICAL RESULT', delta: false } } });
    f.append({ turn: 1, call_id: 'old-end', ts: Date.now(), event: 'turn_completed', data: {},
      display: { type: 'state.turn-completed', data: { turnId: 'old-turn', status: 'completed' } } });
    await f.hub.sync(f.localId);
    f.translation.setEnabled(f.localId, true);
    f.controls.duplicatePage = true;
    await f.hub.sync(f.localId);
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('translated remote queue insertion and editing keep the original local and send only prepared English', async t => {
  const f = await setup(t);
  try {
    await f.send('first-question');
    await f.send('queued-source');
    assert.equal(f.hub.queue(f.localId)[0]?.text, 'queued-source');
    const queueId = f.hub.queue(f.localId)[0]!.id;
    await f.hub.handleMessage({ type: 'queue:update', session_id: f.localId, queue_id: queueId, text: 'edited-source' });
    assert.equal(f.hub.queue(f.localId)[0]?.text, 'edited-source');
    const update = f.requests.find(request => request.method === 'queue.update')!;
    assert.doesNotMatch(JSON.stringify(update.params), /edited-source|luna|sourceText/);
    assert.equal(String(update.params.text), 'Hello in English');
    assert.equal(f.calls.length, 3);
  } finally { await f.cleanup(); }
});

test('local translation failure never falls back to sending the source text to the remote executor', async t => {
  const f = await setup(t);
  try {
    f.controls.failTranslation = true;
    await assert.rejects(f.send('must-not-leak-this-source'), /local model unavailable/);
    assert.equal(f.requests.filter(request => request.method === 'session.send').length, 0);
    assert.equal(f.proxy.client.startTurnCalls.length, 0);
    await f.send('send-source-explicitly', { translation_id: 'original' });
    assert.equal(f.calls.length, 1);
    assert.equal(f.requests.find(request => request.method === 'session.send')?.params.text, 'send-source-explicitly');
  } finally { await f.cleanup(); }
});

test('remote sends translate document text while keeping local source references out of the wire payload', async t => {
  const f = await setup(t);
  try {
    const document = { version: 1 as const, segments: [
      { type: 'text' as const, text: 'check-this-part' },
      { type: 'reference' as const, id: 'ref', referenceType: 'context' as const, label: 'Reference' },
      { type: 'text' as const, text: 'thanks' },
    ] };
    const contexts = [{ type: 'pastedText' as const, id: 'ref', text: 'REFERENCE DATA', byteSize: 14, lineCount: 1 }];
    await f.hub.handleMessage({ type: 'message:send', session_id: f.localId, request_id: generateCanonicalId(),
      text: 'check-this-partthanks', composer_document: document, context_items: contexts });
    const sent = f.requests.find(request => request.method === 'session.send')!;
    assert.doesNotMatch(JSON.stringify(sent.params), /check-this-part|thanks|sourceDocument|translation_id/);
    assert.match(JSON.stringify(sent.params), /REFERENCE DATA/);
    const local = f.hub.historyEvents(f.localId).find(event => event.event === 'user_message')!;
    assert.deepEqual(local.data.composer_document, document);
    assert.deepEqual(local.data.context_items, contexts);
  } finally { await f.cleanup(); }
});

test('ambiguous legacy turn-level delivery identities never invent a source-language association', async t => {
  const f = await setup(t);
  try {
    await f.send('first-source-line');
    const raw = f.hub.replicas.items(f.localId).find(entry => 'item' in entry && entry.item.kind === 'user')!;
    assert.ok('item' in raw && raw.item.kind === 'user' && raw.item.delivery_id);
    const duplicate = { sequence: raw.sequence + 100, item: { ...raw.item, id: generateCanonicalId() } };
    f.db.prepare('INSERT INTO remote_execution_replica_events (local_session_id, sequence, item_json) VALUES (?, ?, ?)')
      .run(f.localId, duplicate.sequence, JSON.stringify(duplicate));
    const projected = f.hub.historyEvent(f.localId, duplicate);
    assert.equal(projected.data.text, raw.item.text);
    assert.equal(projected.data.translation, undefined);
  } finally { await f.cleanup(); }
});

test('the canonical translated user_message broadcasts before the send result when a poller sync is in flight', async t => {
  const f = await setup(t);
  try {
    const sendId = generateCanonicalId();
    let release!: () => void;
    f.controls.holdNextSync = new Promise<void>(resolve => { release = resolve; });
    const poller = f.hub.sync(f.localId);
    // The in-flight sync holds a snapshot captured before the send journals.
    for (let attempt = 0; attempt < 100 && !f.requests.some(request => request.method === 'execution.sync'); attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    const sending = f.send(String.fromCodePoint(0x8fdf, 0x5230, 0x7684, 0x4e2d, 0x6587), { send_id: sendId });
    // The relay round-trips while the in-flight sync response is still stale.
    for (let attempt = 0; attempt < 100 && !f.requests.some(request => request.method === 'session.send'); attempt++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    release();
    await sending;
    await poller;
    const canonical = f.broadcasts.filter(message => message.type === 'event' && message.event === 'user_message');
    assert.ok(canonical.length > 0, 'the canonical user_message broadcast precedes the send result');
    assert.equal(canonical[0]!.data.send_id, sendId);
    assert.equal(canonical[0]!.data.text, String.fromCodePoint(0x8fdf, 0x5230, 0x7684, 0x4e2d, 0x6587));
    assert.ok(canonical[0]!.data.translation);
  } finally { await f.cleanup(); }
});

test('a send whose delivery journals only after the first post-send sync still broadcasts before its result', async t => {
  const f = await setup(t);
  try {
    const sendId = generateCanonicalId();
    const held: EventEnvelope[] = [];
    let holding = true;
    const original = f.runtime.executions.append.bind(f.runtime.executions);
    t.mock.method(f.runtime.executions, 'append', (event: EventEnvelope) => {
      if (holding && event.event === 'user_message') { held.push(event); return; }
      original(event);
    });
    setTimeout(() => {
      holding = false;
      for (const event of held) original(event);
    }, 100).unref();
    await f.send(String.fromCodePoint(0x7a0d, 0x540e, 0x7684, 0x4e2d, 0x6587), { send_id: sendId });
    const canonical = f.broadcasts.filter(message => message.type === 'event' && message.event === 'user_message');
    assert.ok(canonical.length > 0, 'the canonical user_message broadcast precedes the send result');
    assert.equal(canonical[0]!.data.send_id, sendId);
    assert.equal(canonical[0]!.data.text, String.fromCodePoint(0x7a0d, 0x540e, 0x7684, 0x4e2d, 0x6587));
    const sendIndex = f.requests.findIndex(request => request.method === 'session.send');
    const postSendSyncs = f.requests.slice(sendIndex + 1).filter(request => request.method === 'execution.sync').length;
    assert.ok(postSendSyncs >= 2, 'the post-send sync retries until the delivery is journaled');
  } finally { await f.cleanup(); }
});
