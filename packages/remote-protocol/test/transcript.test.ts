import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  EXECUTION_DETAIL_MAX_BYTES,
  EXECUTION_DETAIL_OUTPUT_BYTES,
  REMOTE_METHOD_RESULTS,
  executionHistoryEntrySchema,
  generateCanonicalId,
  transcriptItemSchema,
} from '../src/index.js';

function base() {
  return {
    id: generateCanonicalId(),
    turn_id: generateCanonicalId(),
    turn: 7,
    ts: Date.now(),
  };
}

test('Remote transcript items preserve real turn identity and streaming semantics', () => {
  const item = transcriptItemSchema.parse({
    ...base(),
    kind: 'assistant',
    text: 'hello',
    delta: true,
  });
  assert.equal(item.kind, 'assistant');
  assert.equal(item.turn, 7);
  assert.equal(item.delta, true);
});

test('Remote user messages carry only opaque attachment handles and safe metadata', () => {
  const attachmentId = generateCanonicalId();
  const item = transcriptItemSchema.parse({
    ...base(),
    kind: 'user',
    text: 'see attachment',
    attachments: [{
      id: attachmentId,
      session_id: generateCanonicalId(),
      name: 'screen.png',
      mime: 'image/png',
      size: 128,
      revision: 'event:0',
      previewable: true,
      downloadable: true,
      expires_at: new Date().toISOString(),
    }],
  });
  assert.equal(item.kind, 'user');
  assert.equal(item.attachments?.[0]?.id, attachmentId);
  assert.equal(JSON.stringify(item).includes('/Users/'), false);
});

test('Remote transcript contract rejects legacy category rows and sensitive activity payloads', () => {
  assert.throws(() => transcriptItemSchema.parse({
    ...base(),
    category: 'notice',
    text: 'notice',
  }));
  assert.throws(() => transcriptItemSchema.parse({
    ...base(),
    kind: 'command',
    status: 'success',
    command: 'curl --token secret',
    stdout: '/Users/example/private.txt',
  }));
});

test('session.page requires explicit pagination state', () => {
  const sessionId = generateCanonicalId();
  const page = {
    session_id: sessionId,
    has_more: false,
    items: [{ ...base(), kind: 'file-read' }],
  };
  assert.doesNotThrow(() => REMOTE_METHOD_RESULTS['session.page'].parse(page));
  assert.throws(() => REMOTE_METHOD_RESULTS['session.page'].parse({
    session_id: sessionId,
    items: page.items,
  }));
});

test('catalog model choices stay closed and presentation-only', () => {
  const model = {
    catalog_revision: 'revision',
    workspaces: [],
    agents: [{
      id: generateCanonicalId(),
      name: 'Codex',
      proxy: 'codex',
      readiness: 'ready',
      models: [{
        id: 'gpt-5.3-codex',
        label: 'GPT-5.3 Codex',
        is_default: true,
        supported_thinking: ['medium', 'high'],
      }],
    }],
    tasks: [],
  };
  assert.doesNotThrow(() => REMOTE_METHOD_RESULTS['catalog.read'].parse(model));
  assert.throws(() => REMOTE_METHOD_RESULTS['catalog.read'].parse({
    ...model,
    agents: [{ ...model.agents[0], models: [{ ...model.agents[0]!.models[0], cli_path: '/private/bin' }] }],
  }));
});

test('execution detail rides only beside a history item, closed, capped and matched to its kind', () => {
  const command = { ...base(), kind: 'command' as const, status: 'error' as const, exit_code: 2 };
  const entry = { sequence: 3, item: command, detail: { command: 'pnpm test', output: { text: 'FAIL x', delta: false, truncated: true } } };
  assert.deepEqual(executionHistoryEntrySchema.parse(entry), entry);
  // A Host without the feature sends the item alone, exactly as before.
  assert.deepEqual(executionHistoryEntrySchema.parse({ sequence: 3, item: command }), { sequence: 3, item: command });
  const files = { sequence: 4, item: { ...base(), kind: 'file-change' as const, file_count: 1 },
    detail: { files: [{ reference: 'src/a.ts', change: 'update', added: 1, removed: 0 }], diff: 'diff --git a/src/a.ts b/src/a.ts' } };
  assert.doesNotThrow(() => executionHistoryEntrySchema.parse(files));
  assert.doesNotThrow(() => executionHistoryEntrySchema.parse({ sequence: 5, item: { ...base(), kind: 'tool', name: 'Read', status: 'success' },
    detail: { input: '{"file":"a"}', output: { text: 'ok', delta: false, truncated: false } } }));
  assert.doesNotThrow(() => executionHistoryEntrySchema.parse({ sequence: 6, item: { ...base(), kind: 'error' }, detail: { message: 'quota exceeded' } }));

  for (const detail of [
    { stdout: 'raw' }, { command: 'ls', cwd: '/Users/example' }, { output: { text: 'x', delta: false, truncated: false, stderr: 'y' } },
    { files: [{ reference: 'a', change: 'rename' }] }, { files: [{ path: 'a', change: 'update' }] }, { files: [] },
    { output: { text: 'x'.repeat(EXECUTION_DETAIL_OUTPUT_BYTES + 1), delta: false, truncated: true } },
    { message: 'wrong kind' }, { files: [{ reference: 'a', change: 'update' }] },
  ]) {
    assert.equal(executionHistoryEntrySchema.safeParse({ ...entry, detail }).success, false, JSON.stringify(detail).slice(0, 80));
  }
  const crowded = Array.from({ length: 64 }, (_, index) => ({ reference: String(index).padEnd(1024, 'x'), change: 'update' }));
  assert.equal(executionHistoryEntrySchema.safeParse({ ...files, detail: { files: crowded } }).success, false,
    'fields within their own caps still exceed the per-item bound together');
  assert.equal(executionHistoryEntrySchema.safeParse({ ...files, detail: { files: crowded.slice(0, 32) } }).success, true);
  // Kinds without detail fields carry none.
  assert.equal(executionHistoryEntrySchema.safeParse({ sequence: 7, item: { ...base(), kind: 'assistant', text: 'hi', delta: false },
    detail: {} }).success, true, 'an empty detail is harmless');
  assert.equal(executionHistoryEntrySchema.safeParse({ sequence: 7, item: { ...base(), kind: 'assistant', text: 'hi', delta: false },
    detail: { message: 'no' } }).success, false);
  // Every field at its cap still fits; JSON escaping cannot push one entry past the per-item bound.
  const quoted = '"'.repeat(EXECUTION_DETAIL_OUTPUT_BYTES);
  assert.equal(executionHistoryEntrySchema.safeParse({ ...entry, detail: { command: '\\'.repeat(2048),
    output: { text: quoted, delta: false, truncated: true } } }).success, true);
  assert.ok(JSON.stringify({ command: '\\'.repeat(2048), output: { text: quoted } }).length < EXECUTION_DETAIL_MAX_BYTES);

  // The transcript contract Remote Web reads is unchanged.
  assert.equal(transcriptItemSchema.safeParse({ ...command, detail: entry.detail }).success, false);
  assert.equal(transcriptItemSchema.safeParse({ ...command, command: 'pnpm test' }).success, false);
  assert.throws(() => REMOTE_METHOD_RESULTS['session.page'].parse({ session_id: generateCanonicalId(), has_more: false,
    items: [{ ...command, detail: entry.detail }] }));
});
