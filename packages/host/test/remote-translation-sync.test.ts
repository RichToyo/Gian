import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { generateCanonicalId, generateP256KeyPair, parseRelayFrame, createRemoteHello, redactRemoteConversationText, type RelayFrame } from '@gian/remote-protocol';
import { PeerCryptoSession } from '../src/remote/crypto-session.js';
import { MemoryDuplexTransport } from '../src/remote/connector.js';
import { projectRemoteTranslation } from '../src/remote/projection.js';
import {
  command,
  createHarnessTranslationModel,
  seedDevice,
  setupRemoteHarness,
  teardownRemoteHarness,
  HARNESS_TRANSLATION_PREFERENCES,
} from './fixtures/remote-harness.js';
import { saveConfig } from '../src/storage/config.js';
import type { RemoteMethod } from '@gian/remote-protocol';

const FEATURE = 'wire.conversation_translation';
const ALL_FEATURES = [FEATURE];

type Harness = ReturnType<typeof setupRemoteHarness>;
type Device = ReturnType<typeof seedDevice>;

async function pairCrypto() {
  const host = await generateP256KeyPair();
  const device = await generateP256KeyPair();
  const binding = {
    hostGeneration: generateCanonicalId(),
    hostId: generateCanonicalId(),
    deviceId: generateCanonicalId(),
    routeId: generateCanonicalId(),
    connectionId: generateCanonicalId(),
  };
  const transcript = {
    host_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'a', y: 'b' },
    device_identity: { kty: 'EC' as const, crv: 'P-256' as const, x: 'c', y: 'd' },
    host_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'e', y: 'f' },
    device_ephemeral: { kty: 'EC' as const, crv: 'P-256' as const, x: 'g', y: 'h' },
    connection_id: binding.connectionId,
  };
  return {
    host: await PeerCryptoSession.fromHandshake({
      localPrivate: host.privateKey, remotePublic: device.publicKey, transcript,
      sendDirection: 'host_to_device', binding,
    }),
    device: await PeerCryptoSession.fromHandshake({
      localPrivate: device.privateKey, remotePublic: host.publicKey, transcript,
      sendDirection: 'device_to_host', binding,
    }),
    binding,
  };
}

async function waitUntil<T>(fn: () => T | Promise<T>, timeoutMs = 3_000): Promise<T> {
  const started = Date.now();
  let last: T | undefined;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition: ${String(last)}`);
}

async function sendFrame(transport: MemoryDuplexTransport, crypto: PeerCryptoSession, message: object): Promise<void> {
  const sealed = await crypto.seal(new TextEncoder().encode(JSON.stringify(message)));
  transport.send({
    protocol: 'gian.relay/1',
    frame_id: generateCanonicalId(),
    frame_class: 'control',
    route_id: crypto.routeId,
    host_id: crypto.hostId,
    device_id: crypto.deviceId,
    connection_id: crypto.connectionId,
    transport_sequence: sealed.sequence,
    transport_ack: crypto.inboundAck,
    sent_at: Date.now(),
    ciphertext: sealed.ciphertext,
  });
}

async function openFrames(crypto: PeerCryptoSession, raws: unknown[]): Promise<Array<{ frame: RelayFrame; message: Record<string, unknown> }>> {
  const opened: Array<{ frame: RelayFrame; message: Record<string, unknown> }> = [];
  for (const raw of raws) {
    const frame = parseRelayFrame(raw);
    const plaintext = await crypto.open({
      ciphertext: frame.ciphertext,
      sequence: frame.transport_sequence,
      direction: 'host_to_device',
      routeId: frame.route_id,
      connectionId: crypto.connectionId,
    });
    opened.push({ frame, message: JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown> });
  }
  return opened;
}

function execute(harness: Harness, device: Device, method: RemoteMethod, params: unknown, wireFeatures: readonly string[] = ALL_FEATURES) {
  return harness.runtime.commands.execute(device, command(method, params), { wireFeatures });
}

function createSession(harness: Harness, options: { standalone?: boolean } = {}) {
  return harness.sessions.createSession({
    workspace_id: harness.workspaceId,
    agent_id: 'agent-claude-review',
    ...(options.standalone ? {} : { task_id: harness.taskId, type: 'subtask' as const }),
    name: 'Remote translation sync',
  });
}

test('translation commands require the negotiated feature and a visible session', async () => {
  const harness = setupRemoteHarness();
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);
    const denied = await execute(harness, device, 'translation.state', { session_id: session.id }, []);
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, 'REMOTE_CAPABILITY_DENIED');

    const state = await execute(harness, device, 'translation.state', { session_id: session.id });
    assert.equal(state.ok, true);
    const data = state.data as { enabled: boolean; configured: boolean; reading_language: string; revision: number; config_revision: number };
    assert.equal(data.enabled, false);
    assert.equal(data.configured, true);
    assert.equal(data.reading_language, HARNESS_TRANSLATION_PREFERENCES.reading_language);
    assert.equal(data.revision, 0);
    assert.equal(data.config_revision, 0);

    // Knowing a session id is not enough: a session outside the remote
    // visibility rule stays denied.
    const hidden = await createSession(harness, { standalone: true });
    const invisible = await execute(harness, device, 'translation.state', { session_id: hidden.id });
    assert.equal(invisible.ok, false);
    assert.equal(invisible.error?.code, 'REMOTE_CAPABILITY_DENIED');

    // An exported execution consumes controller-prepared input; translation
    // belongs to the controlling Host and is denied here (ADR-0091).
    harness.db.prepare('INSERT INTO remote_execution_exports (session_id, account_id, stream_id, created_at) VALUES (?, ?, ?, ?)')
      .run(session.id, '42', generateCanonicalId(), 0);
    const exported = await execute(harness, device, 'translation.state', { session_id: session.id });
    assert.equal(exported.ok, false);
    assert.equal(exported.error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(harness); }
});

test('translation.set_auto persists explicitly, honors the precondition, and rejects unconfigured enabling', async () => {
  const harness = setupRemoteHarness();
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);

    const enabled = await execute(harness, device, 'translation.set_auto', { session_id: session.id, enabled: true, expected_enabled: false });
    assert.equal(enabled.ok, true);
    assert.equal((enabled.data as { enabled: boolean }).enabled, true);
    assert.equal(harness.translations.enabled(session.id), true);
    assert.equal((enabled.data as { revision: number }).revision, 1);

    const stale = await execute(harness, device, 'translation.set_auto', { session_id: session.id, enabled: false, expected_enabled: false });
    assert.equal(stale.ok, false);
    assert.equal(stale.error?.code, 'PRECONDITION_FAILED');
    assert.equal(harness.translations.enabled(session.id), true, 'a stale precondition must not flip the persisted switch');

    // The revision precondition is the stronger fence (F6): a write that
    // predates another view's toggle fails even when the boolean happens to
    // match the writer's assumption.
    const staleRevision = await execute(harness, device, 'translation.set_auto', { session_id: session.id, enabled: true, expected_revision: 0 });
    assert.equal(staleRevision.ok, false);
    assert.equal(staleRevision.error?.code, 'PRECONDITION_FAILED');

    const disabled = await execute(harness, device, 'translation.set_auto', { session_id: session.id, enabled: false });
    assert.equal(disabled.ok, true);
    assert.equal(harness.translations.enabled(session.id), false);
    assert.equal((disabled.data as { revision: number }).revision, 2);

    // Mirror of the local 409: enabling without a configured model fails.
    saveConfig(harness.db, { translation: { ...HARNESS_TRANSLATION_PREFERENCES, agent_id: '' } });
    const unconfigured = await execute(harness, device, 'translation.set_auto', { session_id: session.id, enabled: true });
    assert.equal(unconfigured.ok, false);
    assert.equal(unconfigured.error?.code, 'PRECONDITION_FAILED');
    assert.equal(harness.translations.enabled(session.id), false);
  } finally { teardownRemoteHarness(harness); }
});

test('translation.request dedups by command ledger and request id, and persists before settling', async () => {
  const calls: string[] = [];
  const harness = setupRemoteHarness({ translationModel: createHarnessTranslationModel(calls) });
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);
    const params = { session_id: session.id, request_id: 'req-send-1', purpose: 'send', text: String.fromCodePoint(0x4f60, 0x597d) };
    const requestCommand = command('translation.request', params);
    const first = await harness.runtime.commands.execute(device, requestCommand, { wireFeatures: ALL_FEATURES });
    assert.equal(first.ok, true);
    assert.deepEqual(first.data, { request_id: 'req-send-1', status: 'accepted' });
    await waitUntil(() => harness.translations.list(session.id).length === 1);

    // A retried command (same command_id) replays the ledger receipt and
    // never starts a second model call.
    const replayed = await harness.runtime.commands.execute(device, requestCommand, { wireFeatures: ALL_FEATURES });
    assert.deepEqual(replayed.data, { request_id: 'req-send-1', status: 'accepted' });
    // A retried request id (new command id) also coalesces onto the cache.
    const again = await execute(harness, device, 'translation.request', params);
    assert.equal(again.ok, true);
    await waitUntil(() => harness.translations.list(session.id).length === 1);
    assert.equal(calls.length, 1);
    assert.equal(harness.translations.list(session.id)[0]!.text, String.fromCodePoint(0x8bd1, 0x3a, 0x4f60, 0x597d));

    const cancel = await execute(harness, device, 'translation.cancel', { session_id: session.id, request_id: 'req-send-1' });
    assert.equal(cancel.ok, true);
  } finally { teardownRemoteHarness(harness); }
});

test('session.subscribe and session.page carry translation only after negotiation', async () => {
  const harness = setupRemoteHarness();
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);
    // Seed one sent translation + dispatch and one reading translation.
    const sendRecord = await harness.translations.translate(
      { sessionId: session.id, requestId: 'r-send', text: String.fromCodePoint(0x4f60, 0x597d), purpose: 'send' },
      HARNESS_TRANSLATION_PREFERENCES,
    );
    await harness.sessions.sendMessage(session.id, String.fromCodePoint(0x4f60, 0x597d), undefined, undefined, undefined, undefined, undefined, undefined, undefined, sendRecord.id);
    await harness.translations.translate(
      { sessionId: session.id, requestId: 'r-read', text: 'Reply text', purpose: 'read', sourceId: 'turn:1' },
      HARNESS_TRANSLATION_PREFERENCES,
    );

    const negotiated = await execute(harness, device, 'session.subscribe', { session_id: session.id });
    const negotiatedData = negotiated.data as { translation?: { enabled: boolean; configured: boolean } };
    assert.equal(negotiatedData.translation?.enabled, false);
    assert.equal(negotiatedData.translation?.configured, true);

    const plain = await execute(harness, device, 'session.subscribe', { session_id: session.id }, []);
    assert.equal('translation' in (plain.data as object), false, 'a non-negotiated peer parses subscribe closed and gets no translation');

    const page = await execute(harness, device, 'session.page', { session_id: session.id, turns: 3 });
    const pageData = page.data as {
      items: Array<{ kind: string; text?: string; translation?: { text: string; target_language: string } }>;
      translations?: Array<{ purpose: string; source_id?: string; text: string }>;
    };
    const user = pageData.items.find(item => item.kind === 'user');
    assert.equal(user?.translation?.text, String.fromCodePoint(0x8bd1, 0x3a, 0x4f60, 0x597d));
    assert.equal(user?.translation?.target_language, 'en');
    const read = pageData.translations?.find(entry => entry.purpose === 'read' && entry.source_id === 'turn:1');
    assert.equal(read?.text, String.fromCodePoint(0x8bd1, 0x3a, 0x52, 0x65, 0x70, 0x6c, 0x79, 0x20, 0x74, 0x65, 0x78, 0x74));

    const plainPage = await execute(harness, device, 'session.page', { session_id: session.id, turns: 3 }, []);
    const plainData = plainPage.data as { items: Array<{ kind: string; translation?: unknown }>; translations?: unknown };
    assert.equal(plainData.translations, undefined);
    assert.equal(plainData.items.some(item => item.translation !== undefined), false);
  } finally { teardownRemoteHarness(harness); }
});

test('remote session.send revalidates the receipt and dispatches translated text exactly once', async () => {
  const harness = setupRemoteHarness();
  try {
    const device = seedDevice(harness);
    const translated = async (text: string) => {
      const session = await createSession(harness);
      const record = await harness.translations.translate(
        { sessionId: session.id, requestId: generateCanonicalId(), text, purpose: 'send' },
        HARNESS_TRANSLATION_PREFERENCES,
      );
      return { session, record };
    };

    const first = await translated(String.fromCodePoint(0x4f60, 0x597d));
    const sent = await execute(harness, device, 'session.send', { session_id: first.session.id, text: String.fromCodePoint(0x4f60, 0x597d), translation_id: first.record.id });
    assert.equal(sent.ok, true);
    const startInput = harness.proxy.client.startTurnCalls.at(-1)?.input;
    assert.ok(JSON.stringify(startInput).includes(String.fromCodePoint(0x8bd1, 0x3a, 0x4f60, 0x597d)), 'the provider receives the translated text');
    const events = harness.sessions.listEvents(first.session.id);
    const userEvent = events.find(event => (event.event === 'user_message' || event.event === 'user.message'));
    assert.equal(userEvent?.data.text, String.fromCodePoint(0x4f60, 0x597d), 'canonical history keeps the original text');
    assert.equal((userEvent?.data.translation as { text?: string } | undefined)?.text, String.fromCodePoint(0x8bd1, 0x3a, 0x4f60, 0x597d));

    // A receipt never validates against different source text.
    const second = await translated(String.fromCodePoint(0x539f, 0x6587));
    const forged = await execute(harness, device, 'session.send', { session_id: second.session.id, text: String.fromCodePoint(0x522b, 0x7684), translation_id: second.record.id });
    assert.equal(forged.ok, false);

    // 'original' is the explicit untranslated dispatch.
    const third = await translated(String.fromCodePoint(0x76f4, 0x63a5, 0x53d1));
    const original = await execute(harness, device, 'session.send', { session_id: third.session.id, text: String.fromCodePoint(0x76f4, 0x63a5, 0x53d1), translation_id: 'original' });
    assert.equal(original.ok, true);
    const originalInput = harness.proxy.client.startTurnCalls.at(-1)?.input;
    assert.ok(JSON.stringify(originalInput).includes(String.fromCodePoint(0x76f4, 0x63a5, 0x53d1)));

    // A receipt on a non-negotiated connection is rejected, never silently dropped.
    const fourth = await translated(String.fromCodePoint(0x4f60, 0x597d));
    const legacy = await execute(harness, device, 'session.send', { session_id: fourth.session.id, text: String.fromCodePoint(0x4f60, 0x597d), translation_id: fourth.record.id }, []);
    assert.equal(legacy.ok, false);
    assert.equal(legacy.error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(harness); }
});

test('descriptor-only translations page their full REDACTED text with a matching hash', async () => {
  const token = 'sk-ant-abcdefghij1234567890';
  const longText = `${String.fromCodePoint(0x957f).repeat(8_000)} ${token} ${String.fromCodePoint(0x6587).repeat(9_000)}`;
  const harness = setupRemoteHarness({
    translationModel: async () => JSON.stringify({ translations: [longText] }),
  });
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);
    const record = await harness.translations.translate(
      { sessionId: session.id, requestId: 'r-long', text: String.fromCodePoint(0x77ed, 0x539f, 0x6587), purpose: 'read', sourceId: 'turn:1' },
      HARNESS_TRANSLATION_PREFERENCES,
    );
    assert.equal(record.text, longText);

    // The descriptor carries no inline prefix: it describes the COMPLETE
    // redacted text and nothing else.
    const dto = projectRemoteTranslation(record);
    assert.equal(dto.text, undefined, 'an oversized translation is never a silent prefix');
    const expected = redactRemoteConversationText(longText);
    assert.ok(expected.includes('[REDACTED]'));
    assert.ok(!expected.includes(token));
    assert.equal(dto.text_length, expected.length);
    assert.equal(dto.text_sha256, createHash('sha256').update(expected).digest('hex'));

    // Paging returns exactly that same redacted string, in bounded chunks.
    let offset = 0;
    let assembled = '';
    for (let guard = 0; guard < 8; guard += 1) {
      const page = await execute(harness, device, 'translation.result_text', {
        session_id: session.id, record_id: record.id, ...(offset ? { offset } : {}),
      });
      assert.equal(page.ok, true);
      const data = page.data as { text: string; next_offset?: number };
      assert.ok(data.text.length <= 16_000, 'each chunk stays inside the wire text bound');
      assembled += data.text;
      if (data.next_offset === undefined) break;
      assert.ok(data.next_offset > offset, 'paging must advance');
      offset = data.next_offset;
    }
    assert.equal(assembled, expected, 'reassembled chunks equal the descriptor string');
    assert.equal(createHash('sha256').update(assembled).digest('hex'), dto.text_sha256);
    assert.ok(!assembled.includes(token), 'no chunk exposes what inline redaction would hide');

    const missing = await execute(harness, device, 'translation.result_text', {
      session_id: session.id, record_id: generateCanonicalId(),
    });
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, 'RESOURCE_NOT_FOUND');
    const outOfRange = await execute(harness, device, 'translation.result_text', {
      session_id: session.id, record_id: record.id, offset: expected.length + 1,
    });
    assert.equal(outOfRange.ok, false);
    assert.equal(outOfRange.error?.code, 'INVALID_FRAME');
    const unnegotiated = await execute(harness, device, 'translation.result_text', {
      session_id: session.id, record_id: record.id,
    }, []);
    assert.equal(unnegotiated.ok, false);
    assert.equal(unnegotiated.error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(harness); }
});

test('queued entries preserve the explicit send intent through drain (F4)', async () => {
  const calls: string[] = [];
  const harness = setupRemoteHarness({ translationModel: createHarnessTranslationModel(calls) });
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);
    harness.translations.setEnabled(session.id, true);

    // Busy path through the tool layer: the intent lands on the queue entry.
    const first = await execute(harness, device, 'session.send', { session_id: session.id, text: String.fromCodePoint(0x7b2c, 0x4e00, 0x6761), translation_id: 'original' });
    assert.equal(first.ok, true);
    const queuedSend = await execute(harness, device, 'session.send', { session_id: session.id, text: String.fromCodePoint(0x76f4, 0x63a5, 0x53d1, 0x539f, 0x6587), busy: 'queue', translation_id: 'original' });
    assert.equal(queuedSend.ok, true);
    const queued = harness.sessions.getQueue(session.id);
    assert.equal(queued[0]?.translationId, 'original', 'the bypass intent persists on the queued entry');

    // Drain with the switch ON: 'original' drains untranslated (no model call).
    const session2 = await createSession(harness);
    harness.translations.setEnabled(session2.id, true);
    harness.sessions.enqueueMessage(session2.id, String.fromCodePoint(0x76f4, 0x63a5, 0x53d1, 0x539f, 0x6587), undefined, undefined, undefined, undefined, undefined, 'original');
    const drained = await harness.sessions.sendQueuedNow(session2.id);
    assert.equal(drained.mode, 'started');
    const input2 = harness.proxy.client.startTurnCalls.at(-1)?.input;
    assert.ok(JSON.stringify(input2).includes(String.fromCodePoint(0x76f4, 0x63a5, 0x53d1, 0x539f, 0x6587)));
    assert.ok(!JSON.stringify(input2).includes(String.fromCodePoint(0x8bd1, 0x3a)), 'an original-marked entry drains untranslated');
    assert.equal(calls.length, 0);

    // A receipt intent drains the prepared translation WITHOUT a second
    // model call (same cache key).
    const session3 = await createSession(harness);
    harness.translations.setEnabled(session3.id, true);
    const record = await harness.translations.translate(
      { sessionId: session3.id, requestId: 'q1', text: String.fromCodePoint(0x6392, 0x961f, 0x7ffb, 0x8bd1), purpose: 'send' },
      HARNESS_TRANSLATION_PREFERENCES,
    );
    assert.equal(calls.length, 1);
    harness.sessions.enqueueMessage(session3.id, String.fromCodePoint(0x6392, 0x961f, 0x7ffb, 0x8bd1), undefined, undefined, undefined, undefined, undefined, record.id);
    await harness.sessions.sendQueuedNow(session3.id);
    const input3 = harness.proxy.client.startTurnCalls.at(-1)?.input;
    assert.ok(JSON.stringify(input3).includes(String.fromCodePoint(0x8bd1, 0x3a, 0x6392, 0x961f, 0x7ffb, 0x8bd1)));
    assert.equal(calls.length, 1, 'drain reused the receipt — no duplicate model call');

    // Editing the queued text invalidates a stale receipt; 'original' stays.
    const entry = harness.sessions.enqueueMessage(session3.id, String.fromCodePoint(0x6539, 0x5199, 0x524d), undefined, undefined, undefined, undefined, undefined, record.id);
    assert.equal(entry.translationId, record.id);
    const edited = harness.sessions.updateQueueMessage(session3.id, entry.id, String.fromCodePoint(0x6539, 0x5199, 0x540e));
    assert.equal(edited?.translationId, undefined, 'a text edit invalidates the receipt');
    const originalEntry = harness.sessions.enqueueMessage(session3.id, String.fromCodePoint(0x4fdd, 0x6301, 0x539f, 0x6587), undefined, undefined, undefined, undefined, undefined, 'original');
    const editedOriginal = harness.sessions.updateQueueMessage(session3.id, originalEntry.id, String.fromCodePoint(0x4fdd, 0x6301, 0x539f, 0x6587, 0x6539));
    assert.equal(editedOriginal?.translationId, 'original');
  } finally { teardownRemoteHarness(harness); }
});

test('translation.request_status recovers terminal outcomes by request identity (F7)', async () => {
  const harness = setupRemoteHarness();
  try {
    const device = seedDevice(harness);
    const session = await createSession(harness);
    const unknown = await execute(harness, device, 'translation.request_status', { session_id: session.id, request_id: 'never-seen' });
    assert.deepEqual(unknown.data, { state: 'unknown' });

    // Settled success exposes the record DTO.
    await execute(harness, device, 'translation.request', { session_id: session.id, request_id: 'r-ok', purpose: 'read', source_id: 'turn:1', text: String.fromCodePoint(0x6b63, 0x6587) });
    await waitUntil(() => harness.translations.list(session.id).length === 1);
    const succeeded = await execute(harness, device, 'translation.request_status', { session_id: session.id, request_id: 'r-ok' });
    const succeededData = succeeded.data as { state: string; record?: { text?: string; purpose?: string } };
    assert.equal(succeededData.state, 'succeeded');
    assert.equal(succeededData.record?.text, String.fromCodePoint(0x8bd1, 0x3a, 0x6b63, 0x6587));
    assert.equal(succeededData.record?.purpose, 'read');

    // Settled failure exposes a safe error; a running request reads pending.
    const failingHarness = setupRemoteHarness({ translationModel: async () => { throw new Error("provider exploded: api_key: 'sk-live-secret-abcdef'"); } });
    try {
      const failingDevice = seedDevice(failingHarness);
      const failingSession = await failingHarness.sessions.createSession({
        workspace_id: failingHarness.workspaceId, agent_id: 'agent-claude-review',
        task_id: failingHarness.taskId, type: 'subtask', name: 'failing translation',
      });
      await execute(failingHarness, failingDevice, 'translation.request', { session_id: failingSession.id, request_id: 'r-bad', purpose: 'read', source_id: 'turn:1', text: String.fromCodePoint(0x6b63, 0x6587) });
      const failed = await waitUntil(async () => {
        const result = await execute(failingHarness, failingDevice, 'translation.request_status', { session_id: failingSession.id, request_id: 'r-bad' });
        return (result.data as { state?: string }).state === 'failed' ? result : null;
      });
      const failedData = failed.data as { state: string; error?: string };
      assert.ok(failedData.error?.includes('[REDACTED]'), 'provider credentials are redacted from the stored error');
      assert.ok(!failedData.error?.includes('sk-live-secret'), 'the stored error carries no provider secret');
    } finally { teardownRemoteHarness(failingHarness); }

    // Unnegotiated connections cannot probe request status.
    const denied = await execute(harness, device, 'translation.request_status', { session_id: session.id, request_id: 'r-ok' }, []);
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, 'REMOTE_CAPABILITY_DENIED');
  } finally { teardownRemoteHarness(harness); }
});

test('queue.send_now steering preserves the entry intent (F4)', async () => {
  const calls: string[] = [];
  const harness = setupRemoteHarness({ translationModel: createHarnessTranslationModel(calls) });
  try {
    harness.proxy.client.steerAdvertised = true;
    const device = seedDevice(harness);
    const session = await createSession(harness);
    harness.translations.setEnabled(session.id, true);
    const first = await execute(harness, device, 'session.send', { session_id: session.id, text: String.fromCodePoint(0x7b2c, 0x4e00, 0x6761), translation_id: 'original' });
    assert.equal(first.ok, true);

    // Deliberate original bypass queued while busy, then Send now: the steer
    // drains untranslated — no silent re-translation, no model call.
    harness.sessions.enqueueMessage(session.id, String.fromCodePoint(0x4fdd, 0x6301, 0x539f, 0x6587), undefined, undefined, undefined, undefined, undefined, 'original');
    const steered = await harness.sessions.sendQueuedNow(session.id);
    assert.equal(steered.mode, 'steered');
    const steeredInput = harness.proxy.client.steerCalls.at(-1)?.input;
    assert.ok(JSON.stringify(steeredInput).includes(String.fromCodePoint(0x4fdd, 0x6301, 0x539f, 0x6587)));
    assert.ok(!JSON.stringify(steeredInput).includes(String.fromCodePoint(0x8bd1, 0x3a)));
    assert.equal(calls.length, 0);

    // A receipt intent steers the prepared translation, validated exactly
    // like a direct send, reusing the cache instead of re-calling the model.
    const record = await harness.translations.translate(
      { sessionId: session.id, requestId: 'sq', text: String.fromCodePoint(0x8bd1, 0x6211), purpose: 'send' },
      HARNESS_TRANSLATION_PREFERENCES,
    );
    assert.equal(calls.length, 1);
    harness.sessions.enqueueMessage(session.id, String.fromCodePoint(0x8bd1, 0x6211), undefined, undefined, undefined, undefined, undefined, record.id);
    await harness.sessions.sendQueuedNow(session.id);
    assert.ok(JSON.stringify(harness.proxy.client.steerCalls.at(-1)?.input).includes(String.fromCodePoint(0x8bd1, 0x3a, 0x8bd1, 0x6211)));
    assert.equal(calls.length, 1);

    // A stale receipt never dispatches: the entry is restored intact.
    harness.sessions.enqueueMessage(session.id, String.fromCodePoint(0x522b, 0x7684, 0x6587, 0x672c), undefined, undefined, undefined, undefined, undefined, record.id);
    await assert.rejects(harness.sessions.sendQueuedNow(session.id), /does not match/);
    const restored = harness.sessions.getQueue(session.id).at(-1);
    assert.equal(restored?.text, String.fromCodePoint(0x522b, 0x7684, 0x6587, 0x672c));
    assert.equal(restored?.translationId, record.id, 'the rejected entry stays queued with its intent');
  } finally { teardownRemoteHarness(harness); }
});

test('translation.updated events reach only subscribed, negotiated connections', async () => {
  const harness = setupRemoteHarness();
  try {
    const session = await createSession(harness);
    const deviceA = seedDevice(harness, 'Negotiated');
    const deviceB = seedDevice(harness, 'Legacy');
    const cryptoA = await pairCrypto();
    const cryptoB = await pairCrypto();
    const transportsA = MemoryDuplexTransport.pair();
    const transportsB = MemoryDuplexTransport.pair();
    const repliesA: unknown[] = [];
    const repliesB: unknown[] = [];
    transportsA.device.onMessage(frame => repliesA.push(frame));
    transportsB.device.onMessage(frame => repliesB.push(frame));
    const connectorA = harness.runtime.connectDevice(deviceA, cryptoA.host, transportsA.host);
    const connectorB = harness.runtime.connectDevice(deviceB, cryptoB.host, transportsB.host);

    // A negotiates the full feature set; B stays a legacy no-hello client.
    await sendFrame(transportsA.device, cryptoA.device, createRemoteHello(deviceA.id, 'test'));
    const subscribeA = command('session.subscribe', { session_id: session.id });
    await sendFrame(transportsA.device, cryptoA.device, subscribeA);
    const subscribeB = command('session.subscribe', { session_id: session.id });
    await sendFrame(transportsB.device, cryptoB.device, subscribeB);
    await waitUntil(async () => (await openFrames(cryptoA.device, repliesA.splice(0)))
      .some(entry => entry.message.type === 'command.result'));
    await waitUntil(async () => (await openFrames(cryptoB.device, repliesB.splice(0)))
      .some(entry => entry.message.type === 'command.result'));

    // The toggle fans out as a full small-state event to A only.
    harness.translations.setEnabled(session.id, true);
    const toggleEvent = await waitUntil(async () => {
      const opened = await openFrames(cryptoA.device, repliesA.splice(0));
      return opened.find(entry => entry.message.type === 'event'
        && (entry.message.event as { kind?: string }).kind === 'translation.updated') ?? null;
    });
    const togglePayload = toggleEvent.message.event as { session_id?: string; state?: { enabled?: boolean; configured?: boolean } };
    assert.equal(togglePayload.session_id, session.id);
    assert.equal(togglePayload.state?.enabled, true);
    assert.equal(togglePayload.state?.configured, true);

    // Automatic progress deltas carry the same ordered version as the
    // wholesale state, so clients can reject stale snapshots after deltas.
    harness.translations.setAutomaticState(session.id, 'turn:1', { pending: true });
    const automaticEvent = await waitUntil(async () => {
      const opened = await openFrames(cryptoA.device, repliesA.splice(0));
      return opened.find(entry => entry.message.type === 'event'
        && (entry.message.event as { automatic?: unknown }).automatic) ?? null;
    });
    const automaticPayload = automaticEvent.message.event as {
      automatic?: { source_id?: string; pending?: boolean };
      automatic_revision?: number;
      automatic_epoch?: string;
    };
    assert.equal(automaticPayload.automatic?.source_id, 'turn:1');
    assert.equal(automaticPayload.automatic?.pending, true);
    assert.equal(automaticPayload.automatic_revision, 1);
    assert.equal(automaticPayload.automatic_epoch, harness.translations.automaticEpoch);
    harness.translations.setAutomaticState(session.id, 'turn:1', null);

    // A settled request arrives with its request identity and the DTO.
    await sendFrame(transportsA.device, cryptoA.device, command('translation.request', {
      session_id: session.id, request_id: 'req-live', purpose: 'send', text: String.fromCodePoint(0x5b9e, 0x65f6),
    }));
    const settled = await waitUntil(async () => {
      const opened = await openFrames(cryptoA.device, repliesA.splice(0));
      return opened.find(entry => entry.message.type === 'event'
        && (entry.message.event as { request_id?: string }).request_id === 'req-live') ?? null;
    });
    const settledPayload = settled.message.event as { upsert?: { text?: string; purpose?: string } };
    assert.equal(settledPayload.upsert?.text, String.fromCodePoint(0x8bd1, 0x3a, 0x5b9e, 0x65f6));
    assert.equal(settledPayload.upsert?.purpose, 'send');

    // The legacy device received command results but never a translation
    // event (its closed parser would reject the unknown kind).
    const legacyFrames = await openFrames(cryptoB.device, repliesB.splice(0));
    assert.equal(
      legacyFrames.some(entry => entry.message.type === 'event'
        && (entry.message.event as { kind?: string }).kind === 'translation.updated'),
      false,
    );

    // A Settings save republishes the confirmed state to subscribed clients.
    harness.runtime.notifyTranslationPreferencesChanged();
    const republished = await waitUntil(async () => {
      const opened = await openFrames(cryptoA.device, repliesA.splice(0));
      return opened.find(entry => entry.message.type === 'event'
        && (entry.message.event as { kind?: string }).kind === 'translation.updated'
        && (entry.message.event as { state?: unknown }).state) ?? null;
    });
    assert.ok(republished);

    connectorA.close();
    connectorB.close();
  } finally { teardownRemoteHarness(harness); }
});
