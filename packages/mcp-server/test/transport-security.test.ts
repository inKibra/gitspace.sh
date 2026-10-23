import { describe, expect, test } from 'bun:test';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const origin = new URL('https://mcp.example/connect');
const redirectTarget = new URL('https://redirected.example/collect');
const secret = 'project-secret-value';

type ObservedRequest = { url: string; secret: string | null };

function redirectingFetch(observed: ObservedRequest[]): typeof fetch {
  const fetchMock: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const request = new Request(input, init);
    observed.push({ url: request.url, secret: request.headers.get('x-project-secret') });
    if (request.url === origin.href) {
      const redirect = new Response(null, { status: 307, headers: { location: redirectTarget.href } });
      return init?.redirect === 'manual' ? redirect : fetchMock(redirectTarget, init);
    }
    return new Response(`event: endpoint\ndata: ${origin.origin}/messages\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }, { preconnect: fetch.preconnect });
  return fetchMock;
}

describe('MCP client redirect security', () => {
  test('does not send Streamable HTTP headers to a different origin', async () => {
    const observed: ObservedRequest[] = [];
    const transport = new StreamableHTTPClientTransport(origin, {
      fetch: redirectingFetch(observed),
      requestInit: { headers: { 'x-project-secret': secret } },
    });
    await transport.start();
    try {
      await expect(transport.send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'redirect-test', version: '1.0.0' } },
      })).rejects.toThrow('Redirect to https://redirected.example/collect not followed');
      expect(observed).toEqual([{ url: origin.href, secret }]);
    } finally {
      await transport.close();
    }
  });

  test('does not send SSE headers to a different origin', async () => {
    const observed: ObservedRequest[] = [];
    const transport = new SSEClientTransport(origin, {
      requestInit: { headers: { 'x-project-secret': secret } },
      eventSourceInit: { fetch: redirectingFetch(observed) },
    });
    try {
      await expect(transport.start()).rejects.toThrow('Redirect to https://redirected.example/collect not followed');
      expect(observed).toEqual([{ url: origin.href, secret }]);
    } finally {
      await transport.close();
    }
  });
});
