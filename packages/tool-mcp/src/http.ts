import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MCP_MAX_REQUEST_BYTES, McpInputLimitError, readBoundedMcpJson, type GianToolMethod } from '@gian/shared';
import type { GianMcpRpcCall } from './adapter.js';
import { createGianToolMcpServer } from './server.js';

/** Serve one stateless Streamable HTTP MCP request. Authentication and actor
 * projection happen in the Host before this boundary; this layer only binds
 * the already-authorized caller and method catalog to the canonical adapter. */
export async function handleGianToolMcpHttpRequest(options: {
  request: Request;
  dataDir: string;
  callerId: string;
  allowedMethods: readonly GianToolMethod[];
  call: GianMcpRpcCall;
}): Promise<Response> {
  let parsedBody: unknown;
  if (options.request.method === 'POST' && options.request.body) {
    try {
      parsedBody = await readBoundedMcpJson(requestChunks(options.request.body));
    } catch (error) {
      return Response.json({
        error: error instanceof McpInputLimitError ? 'mcp_request_too_large' : 'invalid_mcp_json',
      }, { status: error instanceof McpInputLimitError ? 413 : 400 });
    }
  }
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
    maxRequestBodySize: MCP_MAX_REQUEST_BYTES,
  });
  const server = createGianToolMcpServer({
    dataDir: options.dataDir,
    callerId: options.callerId,
    allowedMethods: options.allowedMethods,
    call: options.call,
  });
  await server.connect(transport);
  return transport.handleRequest(options.request, { parsedBody });
}

async function* requestChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  let complete = false;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) {
        complete = true;
        return;
      }
      yield result.value;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
