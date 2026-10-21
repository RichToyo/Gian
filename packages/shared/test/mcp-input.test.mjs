import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_MAX_REQUEST_BYTES, MCP_MAX_INPUT_ELEMENTS, MCP_MAX_INPUT_DEPTH,
  McpInputLimitError, assertBoundedMcpJson, readBoundedMcpJson,
} from '../dist/mcp-input.js';

async function* chunks(...values) {
  for (const value of values) yield value;
}

test('MCP input counts nested array elements and object keys across the envelope', () => {
  assert.doesNotThrow(() => assertBoundedMcpJson(Array(MCP_MAX_INPUT_ELEMENTS).fill(0)));
  assert.throws(() => assertBoundedMcpJson(Array(MCP_MAX_INPUT_ELEMENTS + 1).fill(0)), McpInputLimitError);
  const record = Object.fromEntries(Array.from({ length: MCP_MAX_INPUT_ELEMENTS }, (_, i) => [i, 0]));
  assert.doesNotThrow(() => assertBoundedMcpJson(record));
  assert.throws(() => assertBoundedMcpJson({ arguments: record }), McpInputLimitError);
  assert.throws(() => assertBoundedMcpJson([
    Array(6_000).fill(0), Array(6_000).fill(0),
  ]), McpInputLimitError);
});

test('MCP input rejects excessive nesting without recursive traversal', () => {
  let value = {};
  for (let i = 0; i < MCP_MAX_INPUT_DEPTH; i++) value = { nested: value };
  assert.doesNotThrow(() => assertBoundedMcpJson(value));
  assert.throws(() => assertBoundedMcpJson({ nested: value }), McpInputLimitError);
});

test('MCP input bounds observed bytes and preserves split UTF-8 user content', async () => {
  const content = String.fromCodePoint(0x4e2d, 0x1f600);
  const bytes = new TextEncoder().encode(JSON.stringify({ content }));
  const split = [...bytes].map(byte => Uint8Array.of(byte));
  assert.deepEqual(await readBoundedMcpJson(chunks(...split)), { content });
  const exact = new TextEncoder().encode(JSON.stringify({ text: 'x'.repeat(MCP_MAX_REQUEST_BYTES - 11) }));
  assert.equal(exact.length, MCP_MAX_REQUEST_BYTES);
  assert.equal((await readBoundedMcpJson(chunks(exact))).text.length, MCP_MAX_REQUEST_BYTES - 11);
  await assert.rejects(readBoundedMcpJson(chunks(exact, Uint8Array.of(32))), McpInputLimitError);
  await assert.rejects(readBoundedMcpJson(chunks(Uint8Array.of(255))), TypeError);
  await assert.rejects(readBoundedMcpJson(chunks(new TextEncoder().encode('{'))), SyntaxError);
  await assert.rejects(readBoundedMcpJson(chunks(new TextEncoder().encode('null'))), SyntaxError);
});
