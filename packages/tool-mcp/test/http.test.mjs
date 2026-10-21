import assert from 'node:assert/strict';
import test from 'node:test';
import { MCP_MAX_INPUT_ELEMENTS, MCP_MAX_REQUEST_BYTES } from '@gian/shared';
import { handleGianToolMcpHttpRequest } from '../dist/http.js';

test('HTTP MCP rejects bounded-size shape bombs and oversized streamed bodies before dispatch', async () => {
  let calls = 0;
  for (const body of [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'gian_call', arguments: { params: { values: Array(MCP_MAX_INPUT_ELEMENTS).fill(0) } },
    } }),
    JSON.stringify({ text: 'x'.repeat(MCP_MAX_REQUEST_BYTES) }),
  ]) {
    const bytes = new TextEncoder().encode(body);
    let offset = 0;
    const stream = new ReadableStream({
      pull(controller) {
        if (offset >= bytes.length) return controller.close();
        controller.enqueue(bytes.subarray(offset, offset + 4096));
        offset += 4096;
      },
    });
    const request = new Request('http://localhost/internal/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: stream, duplex: 'half',
    });
    const response = await handleGianToolMcpHttpRequest({
      request, dataDir: '/unused', callerId: 'test', allowedMethods: ['task.list'],
      call: async () => { calls++; throw new Error('must not dispatch'); },
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'mcp_request_too_large' });
  }
  assert.equal(calls, 0);
});

test('HTTP MCP still negotiates valid input and does not echo malformed input', async () => {
  for (const [body, status] of [
    [JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1.0.0' },
    } }), 200],
    ['{"private-input":', 400],
  ]) {
    const response = await handleGianToolMcpHttpRequest({
      request: new Request('http://localhost/internal/mcp', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body,
      }),
      dataDir: '/unused', callerId: 'test', allowedMethods: ['task.list'],
      call: async () => { throw new Error('must not dispatch'); },
    });
    assert.equal(response.status, status);
    const text = await response.text();
    assert.doesNotMatch(text, /private-input/);
    if (status === 200) assert.equal(JSON.parse(text).result.serverInfo.name, 'gian-tool');
  }
});
