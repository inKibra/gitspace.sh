import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import type {
  DiscoveredMcpTool,
  McpAuditEvent,
  McpConnection,
  McpConnectionDraft,
  McpConnectionStatus,
  ProjectMcpGrant,
} from '@gitspace/protocol';
import { MachineMcpCoordinator, type MachineMcpAuthority } from '../src/local-mcp.js';

function connection(input: Partial<McpConnection> & Pick<McpConnection, 'id' | 'label' | 'target' | 'transport'>): McpConnection {
  return {
    principalId: 'principal-a',
    enabled: true,
    timeoutMs: 2_000,
    status: 'offline',
    statusMessage: null,
    statusCheckedAt: null,
    serverFingerprint: null,
    serverVersion: null,
    revision: 1,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
    ...input,
  };
}

function grant(connectionId: string, enabled = true): ProjectMcpGrant {
  return {
    projectId: 'project-a',
    connectionId,
    enabled,
    projectSpaceEnabled: enabled,
    workspacesEnabled: enabled,
    revision: 1,
    createdBy: 'machine-a',
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  };
}

class FakeMcpAuthority implements MachineMcpAuthority {
  connections: McpConnection[] = [];
  grants: ProjectMcpGrant[] = [];
  readonly audit: Array<Omit<McpAuditEvent, 'principalId' | 'machineId'>> = [];
  readonly secretValues: Record<string, string> = {};

  async listMcpConnections(): Promise<McpConnection[]> { return structuredClone(this.connections); }
  async createMcpConnection(draft: McpConnectionDraft): Promise<McpConnection> {
    const created = connection({ ...draft, status: draft.enabled ? 'offline' : 'disabled' });
    this.connections.push(created);
    return structuredClone(created);
  }
  async updateMcpConnection(connectionId: string, expectedRevision: number, draft: McpConnectionDraft): Promise<McpConnection> {
    const index = this.connections.findIndex((candidate) => candidate.id === connectionId && candidate.revision === expectedRevision);
    if (index < 0) throw new Error('revision conflict');
    const updated = connection({ ...draft, revision: expectedRevision + 1 });
    this.connections[index] = updated;
    return structuredClone(updated);
  }
  async deleteMcpConnection(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    const before = this.connections.length;
    this.connections = this.connections.filter((candidate) => candidate.id !== connectionId || candidate.revision !== expectedRevision);
    return { connectionId, deleted: before !== this.connections.length };
  }
  async getMcpConnectionStatus(connectionId: string): Promise<McpConnection | null> {
    return structuredClone(this.connections.find((candidate) => candidate.id === connectionId) ?? null);
  }
  async recordMcpConnectionStatus(input: {
    connectionId: string;
    observedRevision: number;
    status: McpConnectionStatus;
    message?: string | null;
    serverFingerprint?: string | null;
    serverVersion?: string | null;
  }): Promise<McpConnection> {
    const current = this.connections.find((candidate) => candidate.id === input.connectionId);
    if (!current || current.revision !== input.observedRevision) throw new Error('revision conflict');
    Object.assign(current, {
      status: input.status,
      statusMessage: input.message ?? null,
      serverFingerprint: input.serverFingerprint ?? null,
      serverVersion: input.serverVersion ?? null,
      statusCheckedAt: new Date().toISOString(),
      revision: current.revision + 1,
    });
    return structuredClone(current);
  }
  async listProjectMcpGrants(projectId: string): Promise<ProjectMcpGrant[]> {
    return structuredClone(this.grants.filter((candidate) => candidate.projectId === projectId));
  }
  async putProjectMcpGrant(projectId: string, connectionId: string, enabled: boolean, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<ProjectMcpGrant> {
    const current = this.grants.find((candidate) => candidate.projectId === projectId && candidate.connectionId === connectionId);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('revision conflict');
    const updated = { ...(current ?? grant(connectionId)), projectId, enabled, projectSpaceEnabled, workspacesEnabled, revision: expectedRevision + 1, updatedAt: new Date().toISOString() };
    this.grants = this.grants.filter((candidate) => candidate.projectId !== projectId || candidate.connectionId !== connectionId);
    this.grants.push(updated);
    return structuredClone(updated);
  }
  async deleteProjectMcpGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }> {
    const before = this.grants.length;
    this.grants = this.grants.filter((candidate) => candidate.projectId !== projectId || candidate.connectionId !== connectionId || candidate.revision !== expectedRevision);
    return { projectId, connectionId, deleted: before !== this.grants.length };
  }
  async materializeProjectSecrets(_projectId: string, names: string[]): Promise<Record<string, string>> {
    return Object.fromEntries(names.map((name) => [name, this.secretValues[name]!]).filter((entry) => entry[1] !== undefined));
  }
  async appendMcpAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<McpAuditEvent> {
    const stored = { ...event, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.audit.push(stored);
    return { ...stored, principalId: 'principal-a', machineId: 'machine-a' };
  }
}

const servers: Array<{ stop(closeActiveConnections?: boolean): void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function startHttpServer(requiredAuthorization?: string) {
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === 'GET') return new Response(null, { status: 405 });
      if (requiredAuthorization && request.headers.get('authorization') !== requiredAuthorization) {
        return new Response('Unauthorized', { status: 401 });
      }
      if (request.method === 'DELETE') return new Response(null, { status: 200 });
      const message = await request.json() as { id?: string | number; method?: string; params?: Record<string, unknown> };
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'gitspace-fake-http', version: '1.0.0' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'paper_echo', description: 'Echo over HTTP', inputSchema: { type: 'object', properties: { value: { type: 'string' } } }, annotations: { readOnlyHint: true, destructiveHint: false } }] }
          : message.method === 'tools/call'
            ? { content: [{ type: 'text', text: requiredAuthorization ?? String((message.params?.arguments as Record<string, unknown> | undefined)?.value ?? '') }] }
            : {};
      return Response.json({ jsonrpc: '2.0', id: message.id, result }, {
        headers: { 'mcp-session-id': 'test-session' },
      });
    },
  });
  servers.push(server);
  return server;
}

describe('MachineMcpCoordinator', () => {
  it('projects granted stdio tools through OMP, executes by canonical name, and removes them on grant disable', async () => {
    const authority = new FakeMcpAuthority();
    const fixture = join(import.meta.dir, 'fixtures', 'fake-mcp-stdio.ts');
    authority.connections = [connection({
      id: 'stdio',
      label: 'Fake stdio',
      target: { kind: 'workspace' },
      transport: { type: 'stdio', command: process.execPath, args: [fixture], cwd: null, environment: [] },
    })];
    authority.grants = [grant('stdio')];
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    const projected = await coordinator.createSession({ projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir });
    try {
      const descriptor = projected.descriptors().find((tool) => tool.name === 'echo');
      expect(descriptor?.ompToolName).toStartWith('mcp__');
      expect(descriptor?.readOnly).toBe(true);
      const tool = projected.manager.getTools().find((candidate) => candidate.name === descriptor?.ompToolName);
      const result = await tool!.execute('call-a', { value: 'hello' }, undefined, {} as never);
      expect(JSON.stringify(result)).toContain('hello');

      authority.grants = [{ ...authority.grants[0]!, enabled: false, revision: 2 }];
      await projected.reload();
      expect(projected.descriptors()).toEqual([]);
      expect(projected.manager.getTools()).toEqual([]);
    } finally {
      await projected.dispose();
    }
  });

  it('exposes grant-scoped MCP discovery and calls through the eval namespace', async () => {
    const authority = new FakeMcpAuthority();
    const fixture = join(import.meta.dir, 'fixtures', 'fake-mcp-stdio.ts');
    authority.connections = [connection({
      id: 'stdio',
      label: 'Fake stdio',
      target: { kind: 'workspace' },
      transport: { type: 'stdio', command: process.execPath, args: [fixture], cwd: null, environment: [] },
    })];
    authority.grants = [grant('stdio')];
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    const projected = await coordinator.createSession({ projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir });
    try {
      expect(projected.tools().some((tool) => tool.name === 'mcp_code')).toBe(false);
      const namespace = projected.evalNamespace();
      const matches = await namespace.call('search', { query: 'echo' }) as DiscoveredMcpTool[];
      expect(matches.map((tool) => tool.name)).toEqual(['echo']);
      expect(await namespace.call('describe', { name: 'stdio.echo' })).toMatchObject({ connectionId: 'stdio', name: 'echo' });
      const result = await namespace.call('call', { name: 'stdio.echo', args: { value: 'hello from eval' } });
      expect(JSON.stringify(result)).toContain('hello from eval');
      expect(authority.audit.filter((event) => event.type === 'tool-invocation')).toHaveLength(2);

      authority.grants = [{ ...authority.grants[0]!, enabled: false, revision: 2 }];
      await projected.reload();
      expect(await namespace.call('list', {})).toEqual([]);
    } finally {
      await projected.dispose();
    }
  });

  it('discovers Streamable HTTP metadata while resolving headers only at the machine boundary', async () => {
    const secret = 'header-secret-value';
    const server = startHttpServer(`Bearer ${secret}`);
    const authority = new FakeMcpAuthority();
    authority.secretValues.MCP_HTTP_TOKEN = `Bearer ${secret}`;
    authority.connections = [connection({
      id: 'http',
      label: 'Fake HTTP',
      target: { kind: 'machine', machineId: 'machine-a' },
      transport: { type: 'http', url: server.url.href, headers: [{ name: 'Authorization', secret: { source: 'project', name: 'MCP_HTTP_TOKEN' } }] },
    })];
    authority.grants = [grant('http')];
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    const projected = await coordinator.createSession({ projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir });
    try {
      const tools = projected.descriptors();
      expect(tools.map((tool) => tool.name)).toEqual(['paper_echo']);
      expect(JSON.stringify(tools)).not.toContain(secret);
      expect(JSON.stringify(projected.manager.getServerConfig('gitspace-http'))).not.toContain(secret);
      expect(JSON.stringify(authority.audit)).not.toContain(secret);
      const tool = projected.manager.getTools().find((candidate) => candidate.mcpToolName === 'paper_echo')!;
      const result = await tool.execute('call-http', { value: 'hello' }, undefined, {} as never);
      expect(JSON.stringify(result)).not.toContain(secret);
      expect((await coordinator.connectionStatus('http'))?.status).toBe('ready');
    } finally {
      await projected.dispose();
    }
  });

  it('reports a machine-pinned connection offline without attempting to expose its localhost endpoint', async () => {
    const authority = new FakeMcpAuthority();
    authority.connections = [connection({
      id: 'paper',
      label: 'Paper Desktop',
      target: { kind: 'machine', machineId: 'macbook-a' },
      transport: { type: 'http', url: 'http://127.0.0.1:29979/mcp', headers: [] },
    })];
    authority.grants = [grant('paper')];
    const coordinator = new MachineMcpCoordinator(authority, 'machine-b');
    const projected = await coordinator.createSession({ projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir });
    try {
      expect(projected.descriptors()).toEqual([]);
      expect(authority.audit.some((event) => event.type === 'connection-offline')).toBe(true);
      expect(JSON.stringify(authority.audit)).not.toContain('29979');
    } finally {
      await projected.dispose();
    }
  });

  it('reports a reachable-machine localhost server offline when the direct endpoint cannot connect', async () => {
    const authority = new FakeMcpAuthority();
    authority.connections = [connection({
      id: 'paper-unreachable',
      label: 'Paper Desktop',
      target: { kind: 'machine', machineId: 'machine-a' },
      transport: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: [] },
      timeoutMs: 250,
    })];
    authority.grants = [grant('paper-unreachable')];
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    const projected = await coordinator.createSession({ projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir });
    try {
      expect((await coordinator.connectionStatus('paper-unreachable'))?.status).toBe('offline');
      expect(projected.descriptors()).toEqual([]);
    } finally {
      await projected.dispose();
    }
  });

  it('cancels an in-flight stdio tool and closes the child lifecycle', async () => {
    const authority = new FakeMcpAuthority();
    const fixture = join(import.meta.dir, 'fixtures', 'fake-mcp-stdio.ts');
    authority.connections = [connection({
      id: 'cancel',
      label: 'Cancelable stdio',
      target: { kind: 'workspace' },
      transport: { type: 'stdio', command: process.execPath, args: [fixture], cwd: null, environment: [] },
    })];
    authority.grants = [grant('cancel')];
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    const projected = await coordinator.createSession({ projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir });
    const tool = projected.manager.getTools().find((candidate) => candidate.mcpToolName === 'wait')!;
    const abort = new AbortController();
    const execution = tool.execute('call-wait', {}, undefined, {} as never, abort.signal);
    abort.abort(new Error('test cancellation'));
    await expect(execution).rejects.toThrow(/Operation aborted|test cancellation/u);
    await projected.dispose();
    expect(projected.manager.getConnectedServers()).toEqual([]);
  });
});
