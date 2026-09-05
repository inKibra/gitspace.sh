import { describe, expect, it } from 'bun:test';
import {
  mcpConnectionDraftSchema,
  mcpConnectionSchema,
  projectMcpGrantSchema,
} from '../src/mcp-contract.js';

const timestamp = '2026-08-31T00:00:00.000Z';

describe('MCP protocol records', () => {
  it('requires pinned bunx and npx package arguments', () => {
    const base = {
      id: 'stdio',
      label: 'Pinned stdio',
      enabled: true,
      target: { kind: 'machine' as const, machineId: 'machine-a' },
      timeoutMs: 30_000,
    };
    expect(mcpConnectionDraftSchema.safeParse({
      ...base,
      transport: { type: 'stdio', command: 'bunx', args: ['@modelcontextprotocol/server-filesystem@1.2.3'], cwd: null, environment: [] },
    }).success).toBe(true);
    expect(mcpConnectionDraftSchema.safeParse({
      ...base,
      transport: { type: 'stdio', command: 'npx', args: ['--yes', '@modelcontextprotocol/server-filesystem@latest'], cwd: null, environment: [] },
    }).success).toBe(false);
  });

  it('requires loopback HTTP and SSE endpoints to be machine-pinned', () => {
    expect(mcpConnectionDraftSchema.safeParse({
      id: 'paper',
      label: 'Paper Desktop',
      enabled: true,
      target: { kind: 'workspace' },
      transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] },
      timeoutMs: 5_000,
    }).success).toBe(false);
    expect(mcpConnectionDraftSchema.safeParse({
      id: 'paper',
      label: 'Paper Desktop',
      enabled: true,
      target: { kind: 'machine', machineId: 'macbook-a' },
      transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] },
      timeoutMs: 5_000,
    }).success).toBe(true);
  });

  it('accepts Composio only as an authority-created canonical connection', () => {
    const composio = {
      principalId: 'principal-a',
      id: 'composio-github-a',
      label: 'Work GitHub',
      enabled: true,
      target: { kind: 'cloud' },
      transport: { type: 'composio', toolkit: 'github', connectedAccountId: 'ca_test', allowedTools: ['GITHUB_SEARCH_ISSUES'] },
      timeoutMs: 30_000,
      status: 'ready',
      statusMessage: null,
      statusCheckedAt: timestamp,
      serverFingerprint: null,
      serverVersion: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    expect(mcpConnectionSchema.safeParse(composio).success).toBe(true);
    expect(mcpConnectionDraftSchema.safeParse(composio).success).toBe(false);
  });

  it('round-trips canonical connection and independent grant records', () => {
    const record = mcpConnectionSchema.parse({
      principalId: 'principal-a',
      id: 'remote-http',
      label: 'Remote HTTP',
      enabled: true,
      target: { kind: 'workspace' },
      transport: {
        type: 'http',
        url: 'https://mcp.example.test/mcp',
        headers: [{ name: 'Authorization', secret: { source: 'project', name: 'MCP_REMOTE_TOKEN' } }],
      },
      timeoutMs: 30_000,
      status: 'ready',
      statusMessage: null,
      statusCheckedAt: timestamp,
      serverFingerprint: 'sha256:abc',
      serverVersion: '1.0.0',
      revision: 3,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const grant = projectMcpGrantSchema.parse({
      projectId: 'project-a',
      connectionId: record.id,
      enabled: false,
      projectSpaceEnabled: false,
      workspacesEnabled: false,
      revision: 2,
      createdBy: 'machine-a',
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(record.transport).toEqual({
      type: 'http',
      url: 'https://mcp.example.test/mcp',
      headers: [{ name: 'Authorization', secret: { source: 'project', name: 'MCP_REMOTE_TOKEN' } }],
    });
    expect(grant.enabled).toBe(false);
  });
});
