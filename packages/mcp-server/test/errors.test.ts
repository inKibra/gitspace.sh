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
  const fetchMock: typeof fetch = Object.assign(async () => backend(), { preconnect: fetch.preconnect });
  const handler = createGitSpaceMcpHandler({ key, capabilities: ['rpc.read'], scope: { kind: 'user' }, fetch: fetchMock });
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
  test('does not expose human authorization or forward it through generic runtime tools', async () => {
    let backendCalls = 0;
    const handler = createGitSpaceMcpHandler({
      key, capabilities: ['rpc.read', 'rpc.write', 'account.admin'], scope: { kind: 'user' },
      fetch: Object.assign(async () => { backendCalls++; return new Response(null, { status: 500 }); }, { preconnect: fetch.preconnect }),
    });
    const client = new Client({ name: 'gitspace-mcp-authorization', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL('https://account.test/mcp'), {
      fetch: (input, init) => handler.fetch(new Request(input, init)),
    }));
    try {
      const { tools } = await client.listTools();
      const names = tools.map(tool => tool.name);
      expect(names).toContain('gitspace_runtime_snapshot');
      expect(names).toContain('gitspace_runtime_watch');
      for (const name of ['gitspace_runtime_answer', 'gitspace_session_set_approval', 'gitspace_session_answer_ask', 'gitspace_terminals_live', 'gitspace_inspector_guide_set_approval']) expect(names).not.toContain(name);
      for (const action of ['status', 'setup', 'start', 'stop', 'test']) {
        const name = `gitspace_browser_relay_${action}`;
        expect(names).not.toContain(name);
        const response = await client.callTool({ name, arguments: {} }).catch(error => error);
        expect(response instanceof Error || response.isError === true).toBe(true);
      }
      for (const [name, payload] of [
        ['gitspace_runtime_session', { command: { type: 'setApproval', approvalMode: 'yolo' } }],
        ['gitspace_runtime_session', { command: { type: 'answerAsk', id: 'q', answers: [] } }],
        ['gitspace_runtime_qa', { itemId: 'q', action: { kind: 'share', target: 'repository', redactedExcerpt: 'secret', confirmed: true } }],
      ] as const) {
        const response = await client.callTool({ name, arguments: { projectId: 'p', workspaceId: 's', ...payload } }).catch(error => error);
        expect(response instanceof Error || response.isError === true).toBe(true);
      }
      expect(backendCalls).toBe(0);
    } finally { await client.close(); }
  });

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
