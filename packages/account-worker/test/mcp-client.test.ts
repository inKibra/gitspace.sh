import { describe, expect, it } from 'vitest';
import { createMcpHandler, Server, WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/server';
import { connectMcp, mcpServerIdentity } from '../src/mcp-client.js';

/** A server with one `echo` tool, as the person's MCP server would be. */
function echoServer(name: string) {
  const server = new Server({ name, version: '3.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({ tools: [{ name: 'echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] }));
  server.setRequestHandler('tools/call', async request => ({ content: [{ type: 'text', text: `echo: ${String(request.params.arguments?.text)}` }] }));
  return server;
}

/** A 2025-only server: stateless Streamable HTTP with JSON responses, which knows no `server/discover`. */
async function legacyOnly(request: Request): Promise<Response> {
  const server = echoServer('legacy-echo');
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  try { return await transport.handleRequest(request); }
  finally { await server.close(); }
}

describe('GitSpace\'s MCP client against people\'s servers', () => {
  it('falls back to the 2025 handshake with a 2025-only server and calls its tools', async () => {
    const methods: string[] = [];
    const { client } = await connectMcp({ type: 'http', url: 'https://legacy.test/mcp', timeout: 5_000, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') methods.push(String((await request.clone().json()).method));
      return legacyOnly(request);
    } });
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      // The probe, answered "method not found", then the 2025 handshake.
      expect(methods.slice(0, 2)).toEqual(['server/discover', 'initialize']);
      expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toMatchObject({ content: [{ type: 'text', text: 'echo: hi' }] });
      expect(mcpServerIdentity(client)).toBe('legacy-echo 3.1.0 · MCP 2025-11-25 (legacy era)');
    } finally { await client.close(); }
  });

  it('negotiates 2026-07-28 with a server that serves it and calls its tools', async () => {
    const handler = createMcpHandler(() => echoServer('modern-echo'));
    const methods: string[] = [];
    const { client } = await connectMcp({ type: 'http', url: 'https://modern.test/mcp', timeout: 5_000, fetch: async (input, init) => {
      const request = new Request(input, init);
      if (request.method === 'POST') methods.push(String((await request.clone().json()).method));
      return handler.fetch(request);
    } });
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(methods).not.toContain('initialize');
      expect(await client.callTool({ name: 'echo', arguments: { text: 'hi' } })).toMatchObject({ content: [{ type: 'text', text: 'echo: hi' }] });
      expect(mcpServerIdentity(client)).toBe('modern-echo 3.1.0 · MCP 2026-07-28 (modern era)');
    } finally { await client.close(); }
  });
});
