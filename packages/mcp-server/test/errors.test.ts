import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { deviceProtocolBase64, encodeApiKey } from '@gitspace/protocol/device-grant';
import { createGitSpaceMcpHandler } from '../src/index.js';

const key = encodeApiKey({
  version: 2,
  userId: 'mcp-errors',
  deviceId: crypto.randomUUID(),
  signingPrivateKey: deviceProtocolBase64.encode(new Uint8Array(32).fill(9)),
  rpcUrl: 'https://account.test/rpc',
  enrollUrl: 'https://account.test/v1/devices/enroll',
});

async function toolError(backend: () => Response): Promise<unknown> {
  const handler = createGitSpaceMcpHandler({ key, capabilities: ['rpc.read'], scope: { kind: 'user' }, fetch: async () => backend() });
  const client = new Client({ name: 'gitspace-mcp-errors', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL('https://account.test/mcp'), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  }));
  try {
    const result = await client.callTool({ name: 'gitspace_configuration_values_get', arguments: {} });
    expect(result.isError).toBe(true);
    const [content] = Array.isArray(result.content) ? result.content : [];
    return JSON.parse(content?.type === 'text' ? content.text : 'null');
  } finally { await client.close(); }
}

describe('MCP tool failure detail', () => {
  test('reports the HTTP status and server error body of a rejected call as not retryable', async () => {
    const error = await toolError(() => Response.json({ error: { code: 'RPC_FORBIDDEN', message: `Device ${key} lacks rpc.write` } }, { status: 403 }));
    expect(error).toMatchObject({ error: 'client/http-failure', status: 403, code: 'RPC_FORBIDDEN', message: 'Device [REDACTED] lacks rpc.write', retryable: false, automaticRetry: false });
  });

  test('marks an unavailable backend as retryable and reports a plain-text body', async () => {
    const error = await toolError(() => new Response('GitSpace environment is replacing', { status: 503 }));
    expect(error).toMatchObject({ error: 'client/http-failure', status: 503, message: 'GitSpace environment is replacing', retryable: true, automaticRetry: false });
    expect(error).not.toHaveProperty('code');
  });

  test('marks a network failure as retryable without inventing a status', async () => {
    const error = await toolError(() => { throw new TypeError('fetch failed'); });
    expect(error).toMatchObject({ error: 'client/network-failure', retryable: true, automaticRetry: false });
    expect(error).not.toHaveProperty('status');
  });
});
