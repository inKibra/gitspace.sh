import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { executeMcpStdio } from '@gitspace/supervisor';
import { mcpConnectionDraftSchema, type ComposioMcpMaterialization, type ComposioPluginAuthorization, type ComposioPluginCatalog, type ComposioPluginTool, type ComposioToolPolicy, type ComposioSetup, type EffectiveSecretMetadata, type McpAuditEvent, type McpConnection, type McpConnectionDraft, type McpConnectionStatus, type ProjectMcpGrant } from '@gitspace/protocol';

export interface MachineMcpAuthority {
  listMcpConnections(): Promise<McpConnection[]>;
  createMcpConnection(connection: McpConnectionDraft): Promise<McpConnection>;
  updateMcpConnection(connectionId: string, expectedRevision: number, connection: McpConnectionDraft): Promise<McpConnection>;
  deleteMcpConnection(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }>;
  getMcpConnectionStatus(connectionId: string): Promise<McpConnection | null>;
  recordMcpConnectionStatus(input: {
    connectionId: string;
    observedRevision: number;
    status: McpConnectionStatus;
    message?: string | null;
    serverFingerprint?: string | null;
    serverVersion?: string | null;
  }): Promise<McpConnection>;
  getComposioSetup(): Promise<ComposioSetup>;
  putComposioSetup(apiKey: string): Promise<ComposioSetup>;
  deleteComposioSetup(): Promise<ComposioSetup>;
  listComposioPluginCatalog(): Promise<ComposioPluginCatalog>;
  authorizeComposioPlugin(toolkit: string, label: string): Promise<ComposioPluginAuthorization>;
  refreshComposioPlugin(connectionId: string): Promise<McpConnection>;
  listComposioPluginTools(connectionId: string): Promise<ComposioPluginTool[]>;
  updateComposioPluginTools(connectionId: string, expectedRevision: number, toolPolicy: ComposioToolPolicy): Promise<McpConnection>;
  disconnectComposioPlugin(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }>;
  materializeComposioPlugin(projectId: string, workspaceId: string | null, connectionId: string): Promise<ComposioMcpMaterialization>;
  listProjectMcpGrants(projectId: string): Promise<ProjectMcpGrant[]>;
  putProjectMcpGrant(projectId: string, connectionId: string, enabled: boolean, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<ProjectMcpGrant>;
  deleteProjectMcpGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }>;
  materializeProjectSecrets(projectId: string, names: string[], workspaceId: string | null): Promise<Record<string, string>>;
  listEffectiveSecrets(projectId: string, workspaceId: string | null): Promise<EffectiveSecretMetadata[]>;
  appendMcpAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<McpAuditEvent>;
}


const requestSchema = z.object({ connectionId: z.string().min(1), name: z.string().min(1).optional(), arguments: z.record(z.string(), z.unknown()).optional() }).strict();
export class MachineMcpCoordinator {
  private readonly statusRevision = new Map<string, number>();
  private readonly statusQueue = new Map<string, Promise<void>>();
  constructor(readonly authority: MachineMcpAuthority, readonly machineId: string) {}

  async execute(input: { projectId: string; workspaceId: string | null; workspacePath: string; operation: 'discover' | 'invoke'; args: unknown; signal?: AbortSignal }): Promise<unknown> {
    const args = requestSchema.parse(input.args);
    const authorize = async () => {
      const [connection, grants] = await Promise.all([this.authority.getMcpConnectionStatus(args.connectionId), this.authority.listProjectMcpGrants(input.projectId)]);
      const grant = grants.find(grant => grant.connectionId === args.connectionId);
      if (!connection?.enabled || !grant?.enabled || (input.workspaceId === null ? !grant.projectSpaceEnabled : !grant.workspacesEnabled)) throw new Error('MCP connection is not granted to this workspace');
      if (connection.transport.type !== 'stdio') throw new Error('Network MCP executes only in the cloud');
      if (connection.target.kind === 'machine' && connection.target.machineId !== this.machineId) throw new Error('MCP connection belongs to another machine');
      return connection;
    };
    const connection = await authorize();
    if (connection.transport.type !== 'stdio') throw new Error('MCP requires stdio transport');
    const transport = connection.transport;
    const configured = transport.cwd ?? '.';
    if (connection.target.kind !== 'machine' && isAbsolute(configured)) throw new Error('Workspace MCP cwd must be relative');
    const cwd = resolve(input.workspacePath, configured);
    const relativeCwd = relative(input.workspacePath, cwd);
    if (connection.target.kind !== 'machine' && (relativeCwd === '..' || relativeCwd.startsWith('../') || isAbsolute(relativeCwd))) throw new Error('MCP cwd escapes its assigned checkout');
    const values = await this.authority.materializeProjectSecrets(input.projectId, transport.environment.map(binding => binding.secret.name), input.workspaceId);
    const env = Object.fromEntries(transport.environment.map(binding => {
      const value = values[binding.secret.name];
      if (value === undefined) throw new Error('MCP project secret is unavailable');
      return [binding.name, value];
    }));
    const redact = (value: unknown) => {
      let text = JSON.stringify(value);
      for (const secret of Object.values(values)) if (secret) text = text.replaceAll(JSON.stringify(secret).slice(1, -1), '[redacted]');
      return JSON.parse(text) as unknown;
    };
    const event = { projectId: input.projectId, connectionId: connection.id, type: 'tool-invocation' as const, toolName: args.name ?? null, message: null };
    try {
      if (input.operation === 'invoke') await this.appendAudit({ ...event, outcome: 'started' });
      const result = await executeMcpStdio({ command: transport.command, args: transport.args, cwd, env, timeoutMs: connection.timeoutMs, operation: input.operation, name: args.name, arguments: args.arguments, signal: input.signal, authorize: async () => {
        const current = await authorize();
        if (JSON.stringify(current.transport) !== JSON.stringify(transport)) throw new Error('MCP configuration changed before invocation');
      } });
      this.queueStatus(connection, 'ready', null);
      if (input.operation === 'invoke') await this.appendAudit({ ...event, outcome: result && typeof result === 'object' && 'isError' in result && result.isError ? 'failed' : 'succeeded' });
      return redact(result);
    } catch (error) {
      const message = String(redact(error instanceof Error ? error.message : String(error)));
      if (input.operation === 'invoke') await this.appendAudit({ ...event, outcome: input.signal?.aborted ? 'canceled' : 'failed', message });
      await this.recordFailure(connection, input.projectId, message);
      throw new Error(message);
    }
  }

  async listConnections(): Promise<McpConnection[]> {
    return this.authority.listMcpConnections();
  }

  getComposioSetup(): Promise<ComposioSetup> {
    return this.authority.getComposioSetup();
  }

  putComposioSetup(apiKey: string): Promise<ComposioSetup> {
    return this.authority.putComposioSetup(apiKey);
  }

  deleteComposioSetup(): Promise<ComposioSetup> {
    return this.authority.deleteComposioSetup();
  }

  listComposioCatalog(): Promise<ComposioPluginCatalog> {
    return this.authority.listComposioPluginCatalog();
  }

  async authorizeComposio(toolkit: string, label: string): Promise<ComposioPluginAuthorization> {
    const authorization = await this.authority.authorizeComposioPlugin(toolkit, label);
    return authorization;
  }

  async refreshComposio(connectionId: string): Promise<McpConnection> {
    const connection = await this.authority.refreshComposioPlugin(connectionId);
    return connection;
  }

  listComposioTools(connectionId: string): Promise<ComposioPluginTool[]> {
    return this.authority.listComposioPluginTools(connectionId);
  }

  async updateComposioTools(connectionId: string, expectedRevision: number, toolPolicy: ComposioToolPolicy): Promise<McpConnection> {
    const connection = await this.authority.updateComposioPluginTools(connectionId, expectedRevision, toolPolicy);
    return connection;
  }

  async disconnectComposio(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    const result = await this.authority.disconnectComposioPlugin(connectionId, expectedRevision);
    return result;
  }

  async createConnection(candidate: McpConnectionDraft): Promise<McpConnection> {
    const connection = await this.authority.createMcpConnection(mcpConnectionDraftSchema.parse(candidate));
    return connection;
  }

  async updateConnection(connectionId: string, expectedRevision: number, candidate: McpConnectionDraft): Promise<McpConnection> {
    const connection = await this.authority.updateMcpConnection(connectionId, expectedRevision, mcpConnectionDraftSchema.parse(candidate));
    await Promise.all([...this.statusQueue.values()]);
    const latest = await this.authority.getMcpConnectionStatus(connectionId);
    return latest ?? connection;
  }

  async deleteConnection(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    const result = await this.authority.deleteMcpConnection(connectionId, expectedRevision);
    return result;
  }

  async connectionStatus(connectionId: string): Promise<McpConnection | null> {
    await Promise.all([...this.statusQueue.values()]);
    return this.authority.getMcpConnectionStatus(connectionId);
  }

  async listGrants(projectId: string): Promise<ProjectMcpGrant[]> {
    return this.authority.listProjectMcpGrants(projectId);
  }

  async putGrant(projectId: string, connectionId: string, enabled: boolean, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<ProjectMcpGrant> {
    const grant = await this.authority.putProjectMcpGrant(projectId, connectionId, enabled, projectSpaceEnabled, workspacesEnabled, expectedRevision);
    return grant;
  }

  async deleteGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }> {
    const result = await this.authority.deleteProjectMcpGrant(projectId, connectionId, expectedRevision);
    return result;
  }



  queueStatus(
    connection: McpConnection,
    status: McpConnectionStatus,
    message: string | null,
    serverFingerprintValue: string | null = null,
    serverVersion: string | null = null,
  ): void {
    if (!this.statusRevision.has(connection.id)) this.statusRevision.set(connection.id, connection.revision);
    const previous = this.statusQueue.get(connection.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      const observedRevision = this.statusRevision.get(connection.id) ?? connection.revision;
      try {
        const updated = await this.authority.recordMcpConnectionStatus({
          connectionId: connection.id,
          observedRevision,
          status,
          message,
          serverFingerprint: serverFingerprintValue,
          serverVersion,
        });
        this.statusRevision.set(connection.id, updated.revision);
      } catch {
        this.statusRevision.delete(connection.id);
      }
    });
    const settled = next.finally(() => {
      if (this.statusQueue.get(connection.id) === settled) this.statusQueue.delete(connection.id);
    });
    this.statusQueue.set(connection.id, settled);
  }

  async appendAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<void> {
    try {
      await this.authority.appendMcpAudit(event);
    } catch {
      // Audit transport failure must not make an already-authorized MCP lifecycle fail closed.
    }
  }

  async recordUnavailable(connection: McpConnection, projectId: string, message: string): Promise<void> {
    this.queueStatus(connection, 'offline', message);
    await this.appendAudit({
      projectId,
      connectionId: connection.id,
      type: 'connection-offline',
      toolName: null,
      outcome: 'failed',
      message,
    });
  }

  async recordFailure(connection: McpConnection, projectId: string, message: string): Promise<void> {
    this.queueStatus(connection, 'failed', message);
    await this.appendAudit({
      projectId,
      connectionId: connection.id,
      type: 'connection-failure',
      toolName: null,
      outcome: 'failed',
      message,
    });
  }
}
