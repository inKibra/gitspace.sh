import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { McpConnectionDraft } from '@gitspace/protocol';
import {
  McpConnectionRevisionConflictError,
  UserMcpConnectionsDO,
} from '../src/local-mcp.js';
import {
  ProjectAuthorityDO,
  ProjectMcpGrantRevisionConflictError,
} from '../src/project-authority.js';

const mcpEnv = env as typeof env & {
  USER_MCP_CONNECTIONS: DurableObjectNamespace<UserMcpConnectionsDO>;
  PROJECT_AUTHORITY: DurableObjectNamespace<ProjectAuthorityDO>;
};

const stdioDraft: McpConnectionDraft = {
  id: 'local-stdio',
  label: 'Local stdio',
  enabled: true,
  target: { kind: 'workspace' },
  transport: {
    type: 'stdio',
    command: '/opt/gitspace/bin/fake-mcp',
    args: ['--stdio'],
    cwd: null,
    environment: [{ name: 'FAKE_TOKEN', secret: { source: 'project', name: 'MCP_FAKE_TOKEN' } }],
  },
  timeoutMs: 5_000,
};

function remoteDraft(type: 'http' | 'sse'): McpConnectionDraft {
  return {
    id: `local-${type}`,
    label: `Local ${type.toUpperCase()}`,
    enabled: true,
    target: { kind: 'workspace' },
    transport: {
      type,
      url: `https://mcp.example.test/${type}`,
      headers: [{ name: 'Authorization', secret: { source: 'project', name: 'MCP_HTTP_TOKEN' } }],
    },
    timeoutMs: 10_000,
  };
}

describe('UserMcpConnectionsDO', () => {
  it('round-trips stdio, Streamable HTTP, and SSE records with references but no secret values', async () => {
    const stub = mcpEnv.USER_MCP_CONNECTIONS.getByName('mcp-roundtrip');
    const records = await runInDurableObject(stub, (authority: UserMcpConnectionsDO) => [
      authority.create('principal-a', stdioDraft),
      authority.create('principal-a', remoteDraft('http')),
      authority.create('principal-a', remoteDraft('sse')),
    ]);

    expect(records.map((record) => record.transport.type)).toEqual(['stdio', 'http', 'sse']);
    expect(JSON.stringify(records)).toContain('MCP_FAKE_TOKEN');
    expect(JSON.stringify(records)).not.toContain('super-secret-value');
    expect(records.every((record) => record.revision === 1)).toBe(true);
  });

  it('enforces optimistic revisions and redacts status and audit credentials', async () => {
    const stub = mcpEnv.USER_MCP_CONNECTIONS.getByName('mcp-revisions');
    const created = await runInDurableObject(stub, (authority: UserMcpConnectionsDO) => authority.create('principal-a', stdioDraft));
    await expect(runInDurableObject(stub, (authority: UserMcpConnectionsDO) => authority.update(
      'principal-a',
      created.id,
      created.revision + 1,
      { ...stdioDraft, label: 'Changed' },
    ))).rejects.toBeInstanceOf(McpConnectionRevisionConflictError);

    const status = await runInDurableObject(stub, (authority: UserMcpConnectionsDO) => authority.recordStatus({
      principalId: 'principal-a',
      connectionId: created.id,
      observedRevision: created.revision,
      status: 'failed',
      message: 'Authorization: super-secret-value',
    }));
    const audit = await runInDurableObject(stub, (authority: UserMcpConnectionsDO) => authority.appendAudit({
      principalId: 'principal-a',
      projectId: 'project-a',
      connectionId: created.id,
      machineId: 'machine-a',
      type: 'connection-failure',
      toolName: null,
      outcome: 'failed',
      message: 'Bearer super-secret-value',
    }));
    expect(status.statusMessage).not.toContain('super-secret-value');
    expect(audit.message).not.toContain('super-secret-value');
  });

  it('stores Paper Desktop as machine-pinned direct Streamable HTTP', async () => {
    const stub = mcpEnv.USER_MCP_CONNECTIONS.getByName('mcp-paper');
    const paper = await runInDurableObject(stub, (authority: UserMcpConnectionsDO) => authority.create('principal-a', {
      id: 'paper',
      label: 'Paper Desktop',
      enabled: true,
      target: { kind: 'machine', machineId: 'macbook-a' },
      transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] },
      timeoutMs: 5_000,
    }));
    expect(paper.target).toEqual({ kind: 'machine', machineId: 'macbook-a' });
    expect(paper.transport).toEqual({ type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] });
  });
});

describe('ProjectAuthorityDO MCP grants', () => {
  it('keeps project grants independent and disables without deleting', async () => {
    const stub = mcpEnv.PROJECT_AUTHORITY.getByName('mcp-project-grants');
    await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.bootstrap({
      id: 'project-a', name: 'Project A', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a',
    }));
    const enabled = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putMcpGrant({
      connectionId: 'local-stdio', enabled: true, projectSpaceEnabled: true, workspacesEnabled: false, expectedRevision: 0, createdBy: 'machine-a',
    }));
    expect(enabled).toMatchObject({ projectSpaceEnabled: true, workspacesEnabled: false });
    const disabled = await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.putMcpGrant({
      connectionId: 'local-stdio', enabled: false, projectSpaceEnabled: false, workspacesEnabled: false, expectedRevision: enabled.revision, createdBy: 'machine-b',
    }));
    expect(disabled.enabled).toBe(false);
    expect(await runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.listMcpGrants())).toHaveLength(1);
    await expect(runInDurableObject(stub, (authority: ProjectAuthorityDO) => authority.deleteMcpGrant(
      'local-stdio',
      enabled.revision,
    ))).rejects.toBeInstanceOf(ProjectMcpGrantRevisionConflictError);
  });
});
