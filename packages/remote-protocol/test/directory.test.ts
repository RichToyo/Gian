import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  acceptRemoteHello, createRemoteHello, directoryListResultSchema,
  generateCanonicalId, parseRemoteControlMessage, parseRemoteMethodParams,
} from '../src/index.js';

test('directory v1 requires explicit client opt-in and mutual negotiation', () => {
  const identity = { deviceId: generateCanonicalId(), connectionId: generateCanonicalId(), hostGeneration: generateCanonicalId(), hostVersion: 'fixture' };
  const legacy = createRemoteHello(identity.deviceId, 'existing-web');
  assert.equal(legacy.capabilities.includes('wire.session_directory_v1'), false);
  assert.equal(acceptRemoteHello(legacy, identity).negotiated_capabilities.includes('wire.session_directory_v1'), false);
  const native = createRemoteHello(identity.deviceId, 'native', { sessionDirectoryV1: true });
  assert.equal(acceptRemoteHello(native, identity).negotiated_capabilities.includes('wire.session_directory_v1'), true);
});

test('directory params and completeness states are closed and bounded', () => {
  assert.deepEqual(parseRemoteMethodParams('directory.list', { view: 'repos', limit: 64 }), { view: 'repos', limit: 64 });
  for (const params of [{ view: 'search' }, { view: 'repos', query: 'old' }, { view: 'tasks', limit: 65 },
    { view: 'repos', workspace_path: '/private' }, { view: 'search', query: ' ' }]) {
    assert.throws(() => parseRemoteMethodParams('directory.list', params));
  }
  const page = { version: 1, view: 'search', as_of: 123, revision: '1', entries: [] };
  assert.doesNotThrow(() => directoryListResultSchema.parse({ ...page, state: 'complete', next_cursor: null }));
  assert.doesNotThrow(() => directoryListResultSchema.parse({ ...page, state: 'incomplete', next_cursor: 'opaque' }));
  assert.doesNotThrow(() => directoryListResultSchema.parse({ ...page, state: 'cursor_invalid', next_cursor: null }));
  assert.throws(() => directoryListResultSchema.parse({ ...page, state: 'complete', next_cursor: 'more' }));
  assert.throws(() => directoryListResultSchema.parse({ ...page, state: 'incomplete', next_cursor: null }));
  assert.throws(() => directoryListResultSchema.parse({ ...page, state: 'complete', next_cursor: null, total: 999 }));
});

test('directory invalidation is live-only, not a fabricated canonical event', () => {
  const hint = { type: 'directory.changed', version: 1, host_generation: generateCanonicalId(), revision: '2' };
  assert.deepEqual(parseRemoteControlMessage(hint), hint);
  assert.throws(() => parseRemoteControlMessage({ ...hint, event_sequence: 4 }));
});
