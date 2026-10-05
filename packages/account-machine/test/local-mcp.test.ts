import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import type {
  ComposioMcpMaterialization,
  ComposioPluginAuthorization,
  ComposioPluginCatalog,
  ComposioSetup,
  ComposioPluginTool,
  EffectiveSecretMetadata,
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
  composioMaterialization: ComposioMcpMaterialization | null = null;
  secretMetadata: EffectiveSecretMetadata[] | null = null;
  unavailable = false;

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
  async getComposioSetup(): Promise<ComposioSetup> { throw new Error('Setup is not used by execution tests'); }
  async putComposioSetup(): Promise<ComposioSetup> { throw new Error('Setup is not used by execution tests'); }
  async deleteComposioSetup(): Promise<ComposioSetup> { throw new Error('Setup is not used by execution tests'); }
  async listComposioPluginCatalog(): Promise<ComposioPluginCatalog> { return { configured: true, toolkits: [] }; }
  async authorizeComposioPlugin(): Promise<ComposioPluginAuthorization> { throw new Error('not implemented by fake'); }
  async refreshComposioPlugin(connectionId: string): Promise<McpConnection> {
    const current = this.connections.find((candidate) => candidate.id === connectionId);
    if (!current) throw new Error('not found');
    return structuredClone(current);
  }
  async listComposioPluginTools(): Promise<ComposioPluginTool[]> { return []; }
  async updateComposioPluginTools(): Promise<McpConnection> { throw new Error('not implemented by fake'); }
  async disconnectComposioPlugin(connectionId: string): Promise<{ connectionId: string; deleted: boolean }> { return { connectionId, deleted: true }; }
  async materializeComposioPlugin(): Promise<ComposioMcpMaterialization> {
    if (!this.composioMaterialization) throw new Error('Composio materialization is unavailable');
    return structuredClone(this.composioMaterialization);
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
  async listEffectiveSecrets(projectId: string, _workspaceId: string | null): Promise<EffectiveSecretMetadata[]> {
    if (this.unavailable) throw new Error('Cloud configuration unavailable');
    return this.secretMetadata ?? Object.keys(this.secretValues).map((name) => ({
      projectId, name, revision: 1, source: 'project' as const, updatedAt: '2026-08-31T00:00:00.000Z', updatedBy: 'user-a',
    }));
  }
  async materializeProjectSecrets(projectId: string, names: string[], workspaceId: string | null): Promise<Record<string, string>> {
    const authorized = await this.listEffectiveSecrets(projectId, workspaceId);
    if (names.some((name) => !authorized.some((secret) => secret.name === name))) throw new Error('Secret is not authorized');
    return Object.fromEntries(names.map((name) => [name, this.secretValues[name]!]).filter((entry) => entry[1] !== undefined));
  }
  async appendMcpAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<McpAuditEvent> {
    const stored = { ...event, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
    this.audit.push(stored);
    return { ...stored, principalId: 'principal-a', machineId: 'machine-a' };
  }
}

describe('MachineMcpCoordinator', () => {
  function stdioAuthority() {
    const authority = new FakeMcpAuthority();
    authority.connections = [connection({ id: 'stdio', label: 'stdio', target: { kind: 'workspace' }, transport: { type: 'stdio', command: process.execPath, args: [join(import.meta.dir, 'fixtures', 'fake-mcp-stdio.ts')], cwd: null, environment: [] } })];
    authority.grants = [grant('stdio')];
    return authority;
  }
  const scope = { projectId: 'project-a', workspaceId: 'workspace-a', workspacePath: import.meta.dir };
  it('executes granted stdio tools and rejects calls after revocation', async () => {
    const authority = stdioAuthority();
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    const tools = await coordinator.execute({ ...scope, operation: 'discover', args: { connectionId: 'stdio' } });
    expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'echo', annotations: expect.objectContaining({ readOnlyHint: true }) })]));
    const result = await coordinator.execute({ ...scope, operation: 'invoke', args: { connectionId: 'stdio', name: 'echo', arguments: { value: 'hello' } } });
    expect(JSON.stringify(result)).toContain('hello');
    authority.grants = [];
    await expect(coordinator.execute({ ...scope, operation: 'invoke', args: { connectionId: 'stdio', name: 'echo' } })).rejects.toThrow('not granted');
  });
  it('rejects network transports and a different pinned machine before execution', async () => {
    const authority = stdioAuthority();
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    authority.connections[0]!.target = { kind: 'machine', machineId: 'machine-b' };
    await expect(coordinator.execute({ ...scope, operation: 'discover', args: { connectionId: 'stdio' } })).rejects.toThrow('another machine');
    authority.connections[0]!.transport = { type: 'http', url: 'https://example.com/mcp', headers: [] };
    await expect(coordinator.execute({ ...scope, operation: 'discover', args: { connectionId: 'stdio' } })).rejects.toThrow('only in the cloud');
  });
  it('rechecks grants after secret materialization, before spawning', async () => {
    const authority = stdioAuthority();
    authority.materializeProjectSecrets = async () => { authority.grants = []; return {}; };
    const coordinator = new MachineMcpCoordinator(authority, 'machine-a');
    await expect(coordinator.execute({ ...scope, operation: 'invoke', args: { connectionId: 'stdio', name: 'echo' } })).rejects.toThrow('not granted');
  });
});
