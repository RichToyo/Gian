import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  generateCanonicalId,
  parseRemoteMethodParams,
  remoteTranslationSchema,
  remoteTranslationStateSchema,
  canonicalEventSchema,
  transcriptPageSchema,
  REMOTE_METHOD_RESULTS,
  sessionSendParamsSchema,
} from '../src/index.js';

const recordId = generateCanonicalId();
const sessionId = generateCanonicalId();

function translationDto(overrides: Record<string, unknown> = {}) {
  return {
    id: recordId,
    session_id: sessionId,
    purpose: 'read',
    source_id: 'turn:3',
    target_language: 'zh-CN',
    text: String.fromCodePoint(0x8bd1, 0x6587),
    text_length: 2,
    text_sha256: 'b'.repeat(64),
    source_sha256: 'a'.repeat(64),
    ...overrides,
  };
}

test('translation DTO is closed, full-fidelity, and carries no Host configuration', () => {
  assert.doesNotThrow(() => remoteTranslationSchema.parse(translationDto()));
  assert.doesNotThrow(() => remoteTranslationSchema.parse(translationDto({ purpose: 'send', source_id: undefined })));
  // Descriptor-only form: no inline text, but a complete-text descriptor the
  // client pages via translation.result_text — never a silent prefix.
  const descriptor = translationDto();
  delete (descriptor as { text?: string }).text;
  assert.doesNotThrow(() => remoteTranslationSchema.parse(descriptor));
  // Agent/model credentials, Composer documents, paths and provider payloads
  // are rejected by the closed schema — they must never cross the relay.
  for (const leak of ['agent', 'agentId', 'model', 'sourceDocument', 'translatedDocument', 'path', 'token']) {
    assert.equal(remoteTranslationSchema.safeParse(translationDto({ [leak]: 'x' })).success, false, leak);
  }
  assert.equal(remoteTranslationSchema.safeParse(translationDto({ source_sha256: 'not-hex' })).success, false);
  assert.equal(remoteTranslationSchema.safeParse(translationDto({ id: 'not-a-uuid' })).success, false);
  assert.equal(remoteTranslationSchema.safeParse(translationDto({ text_length: undefined })).success, false);
});

test('translation session state is closed, bounded and revisioned', () => {
  const state = {
    enabled: true,
    configured: true,
    sending_language: 'en',
    reading_language: 'zh-CN',
    revision: 7,
    config_revision: 3,
    automatic_revision: 4,
    automatic_epoch: 'boot-1',
    automatic: [{ source_id: 'turn:1', pending: true }],
  };
  assert.doesNotThrow(() => remoteTranslationStateSchema.parse(state));
  assert.equal(remoteTranslationStateSchema.safeParse({ ...state, agent_id: 'secret' }).success, false);
  assert.equal(remoteTranslationStateSchema.safeParse({ ...state, revision: undefined }).success, false);
  assert.equal(remoteTranslationStateSchema.safeParse({ ...state, config_revision: undefined }).success, false);
  assert.equal(remoteTranslationStateSchema.safeParse({ ...state, automatic_revision: undefined }).success, false);
  assert.equal(remoteTranslationStateSchema.safeParse({ ...state, automatic_epoch: undefined }).success, false);
  assert.equal(remoteTranslationStateSchema.safeParse({ ...state, automatic: [{ source_id: 'turn:1' }] }).success, false);
});

test('translation command params are closed and validated', () => {
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.state', { session_id: sessionId }));
  assert.throws(() => parseRemoteMethodParams('translation.state', { session_id: sessionId, record_id: recordId }));
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.set_auto', { session_id: sessionId, enabled: true, expected_enabled: false }));
  assert.throws(() => parseRemoteMethodParams('translation.set_auto', { session_id: sessionId }));
  assert.throws(() => parseRemoteMethodParams('translation.set_auto', { session_id: sessionId, toggle: true }));
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.request', {
    session_id: sessionId,
    request_id: 'req-1',
    purpose: 'send',
    text: String.fromCodePoint(0x4f60, 0x597d),
  }));
  assert.throws(() => parseRemoteMethodParams('translation.request', {
    session_id: sessionId,
    request_id: 'req-1',
    purpose: 'send',
    text: 'x'.repeat(120_001),
  }));
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.cancel', { session_id: sessionId, request_id: 'req-1' }));
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.result_text', { session_id: sessionId, record_id: recordId, offset: 16_000 }));
  assert.throws(() => parseRemoteMethodParams('translation.result_text', { session_id: sessionId, record_id: 'nope' }));
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.request_status', { session_id: sessionId, request_id: 'req-1' }));
  // The stronger revision precondition is available alongside the value check.
  assert.doesNotThrow(() => parseRemoteMethodParams('translation.set_auto', {
    session_id: sessionId, enabled: true, expected_enabled: false, expected_revision: 3,
  }));
});

test('session.send accepts a gated translation receipt reference', () => {
  assert.doesNotThrow(() => sessionSendParamsSchema.parse({
    session_id: sessionId,
    text: String.fromCodePoint(0x539f, 0x6587),
    translation_id: recordId,
  }));
  assert.doesNotThrow(() => sessionSendParamsSchema.parse({
    session_id: sessionId,
    text: String.fromCodePoint(0x539f, 0x6587),
    translation_id: 'original',
  }));
  assert.equal(sessionSendParamsSchema.safeParse({
    session_id: sessionId,
    text: String.fromCodePoint(0x539f, 0x6587),
    translation_id: 'forged',
  }).success, false);
});

test('translation.updated events and paged translations parse closed', () => {
  assert.doesNotThrow(() => canonicalEventSchema.parse({
    type: 'event',
    host_generation: generateCanonicalId(),
    event_sequence: 7,
    event: {
      kind: 'translation.updated',
      session_id: sessionId,
      state: {
        enabled: true,
        configured: true,
        sending_language: 'en',
        reading_language: 'zh-CN',
        revision: 3,
        config_revision: 1,
        automatic_revision: 2,
        automatic_epoch: 'boot-1',
        automatic: [],
      },
      automatic: { source_id: 'turn:2', pending: false, error: 'safe message' },
      automatic_revision: 9,
      automatic_epoch: 'boot-1',
      upsert: translationDto(),
      request_id: 'req-1',
    },
  }));
  assert.equal(canonicalEventSchema.safeParse({
    type: 'event',
    host_generation: generateCanonicalId(),
    event_sequence: 7,
    event: {
      kind: 'translation.updated',
      session_id: sessionId,
      upsert: translationDto({ agentId: 'leak' }),
    },
  }).success, false);
  assert.doesNotThrow(() => transcriptPageSchema.parse({
    type: 'transcript.page',
    session_id: sessionId,
    has_more: false,
    items: [],
    translations: [translationDto()],
  }));
  assert.equal(transcriptPageSchema.safeParse({
    type: 'transcript.page',
    session_id: sessionId,
    has_more: false,
    items: [],
    translations: [translationDto({ model: 'leak' })],
  }).success, false);
  assert.doesNotThrow(() => REMOTE_METHOD_RESULTS['session.subscribe'].parse({
    session: {
      id: sessionId,
      revision: '1',
      name: null,
      task_id: generateCanonicalId(),
      workspace_id: generateCanonicalId(),
      agent: { id: generateCanonicalId(), name: 'Agent', proxy: 'claude' },
      status: 'done',
      queue: { revision: '1', entries: [] },
      updated_at: new Date(0).toISOString(),
    },
    cursor: '1',
    translation: {
      enabled: false,
      configured: true,
      sending_language: 'en',
      reading_language: 'zh-CN',
      revision: 0,
      config_revision: 0,
      automatic_revision: 0,
      automatic_epoch: 'boot-0',
      automatic: [],
    },
  }));
});
