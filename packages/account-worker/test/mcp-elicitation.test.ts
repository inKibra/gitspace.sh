import { describe, expect, it } from 'vitest';
import { createMcpHandler, inputRequired, inputResponse, McpServer, WebStandardStreamableHTTPServerTransport, type CallToolResult, type InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { RuntimeMcpElicit, RuntimeMcpElicitationRequest } from '@gitspace/protocol-runtime';
import { callMcpTool, connectMcp } from '../src/mcp-client.js';

const FORM = { type: 'object', properties: { region: { type: 'string', title: 'Region', enum: ['eu', 'us'] }, seats: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['region'] } as const;

/** A server whose `deploy` asks for a form (or, `link: true`, a link) and answers with what it received. Every answer the
 * server receives is recorded in `received`. Served on both revisions: 2026-07-28 returns `input_required`; on a 2025
 * session the SDK's legacy shim pushes `elicitation/create`. */
function deployServer(received: unknown[]) {
  const server = new McpServer({ name: 'deployer', version: '1.0.0' });
  server.registerTool('deploy', { description: 'Deploy after asking', inputSchema: z.object({ link: z.boolean().optional() }) }, async ({ link }, ctx): Promise<CallToolResult | InputRequiredResult> => {
    const view = inputResponse(ctx.mcpReq.inputResponses, 'confirm');
    if (view.kind === 'missing') return inputRequired({ inputRequests: { confirm: link ? inputRequired.elicitUrl({ message: 'Approve the deploy', url: 'https://deploys.example.com/approve/1' }) : inputRequired.elicit({ message: 'Where to deploy?', requestedSchema: FORM }) } });
    received.push(view.kind === 'elicit' ? { action: view.action, ...view.content ? { content: view.content } : {} } : view);
    return { content: [{ type: 'text', text: `deploy ${JSON.stringify(view.kind === 'elicit' ? view.content ?? view.action : view.kind)}` }] };
  });
  return server;
}

/** A connection to an in-process server: 2026-07-28 (stateless), or a 2025 session (stateful, so the server can push). */
async function connect(era: 'modern' | 'legacy', received: unknown[]) {
  if (era === 'modern') {
    const handler = createMcpHandler(() => deployServer(received));
    return connectMcp({ type: 'http', url: 'https://modern.test/mcp', timeout: 5_000, fetch: (input, init) => handler.fetch(new Request(input, init)) });
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
  await deployServer(received).connect(transport);
  return connectMcp({ type: 'http', url: 'https://legacy.test/mcp', timeout: 5_000, fetch: async (input, init) => {
    const request = new Request(input, init);
    // The legacy server knows no `server/discover`.
    if (request.method === 'POST' && (await request.clone().json()).method === 'server/discover') return Response.json({ jsonrpc: '2.0', id: (await request.clone().json()).id, error: { code: -32601, message: 'Method not found' } });
    return transport.handleRequest(request);
  } });
}

const source = { connection: 'Deployer', server: 'deployer 1.0.0', workspace: 'Workspace' };

describe('GitSpace\'s MCP client relays a server\'s requests for input (ext-tasks)', () => {
  for (const era of ['legacy', 'modern'] as const) {
    it(`${era}: a form request reaches the workspace, and only its answer reaches the server`, async () => {
      const received: unknown[] = [];
      const asked: { request: RuntimeMcpElicitationRequest; scope: string }[] = [];
      const elicit: RuntimeMcpElicit = async input => { asked.push({ request: input.request, scope: input.scope }); return { action: 'accept', content: { region: 'eu', seats: 3 } }; };
      const connection = await connect(era, received);
      try {
        const outcome = await callMcpTool(connection, { endpoint: { connectionId: 'deployer', url: 'https://x.test' }, name: 'deploy', arguments: {}, task: null, timeout: 5_000, source, elicit });
        expect(asked).toEqual([{ request: { mode: 'form', message: 'Where to deploy?', requestedSchema: FORM }, scope: 'request' }]);
        expect(received).toEqual([{ action: 'accept', content: { region: 'eu', seats: 3 } }]);
        expect(outcome).toMatchObject({ kind: 'result', result: { content: [{ type: 'text', text: 'deploy {"region":"eu","seats":3}' }] } });
      } finally { await connection.client.close(); }
    });

    it(`${era}: unanswered in time, a request-scoped request is answered cancel`, async () => {
      const received: unknown[] = [];
      const connection = await connect(era, received);
      try {
        const outcome = await callMcpTool(connection, { endpoint: { connectionId: 'deployer', url: 'https://x.test' }, name: 'deploy', arguments: {}, task: null, timeout: 5_000, source, elicit: async () => null });
        expect(received).toEqual([{ action: 'cancel' }]);
        expect(outcome).toMatchObject({ kind: 'result', result: { content: [{ text: 'deploy "cancel"' }] } });
      } finally { await connection.client.close(); }
    });
  }

  it('a link request reaches the workspace as a URL request, and decline is what the server gets', async () => {
    const received: unknown[] = [];
    const asked: RuntimeMcpElicitationRequest[] = [];
    const connection = await connect('modern', received);
    try {
      await callMcpTool(connection, { endpoint: { connectionId: 'deployer', url: 'https://x.test' }, name: 'deploy', arguments: { link: true }, task: null, timeout: 5_000, source, elicit: async input => { asked.push(input.request); return { action: 'decline' }; } });
      expect(asked).toEqual([{ mode: 'url', message: 'Approve the deploy', url: 'https://deploys.example.com/approve/1' }]);
      expect(received).toEqual([{ action: 'decline' }]);
    } finally { await connection.client.close(); }
  });
});
