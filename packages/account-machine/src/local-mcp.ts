import { isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { executeMcpStdio } from '@gitspace/supervisor';
import type { McpAuditEvent, McpConnection, McpConnectionStatus, ProjectMcpGrant } from '@gitspace/protocol';

export interface MachineMcpAuthority {
  getMcpConnectionStatus(connectionId: string): Promise<McpConnection | null>;
  recordMcpConnectionStatus(input: {
    connectionId: string;
    observedRevision: number;
    status: McpConnectionStatus;
    message?: string | null;
    serverFingerprint?: string | null;
    serverVersion?: string | null;
  }): Promise<McpConnection>;
  listProjectMcpGrants(projectId: string): Promise<ProjectMcpGrant[]>;
  materializeProjectSecrets(projectId: string, names: string[], workspaceId: string | null): Promise<Record<string, string>>;
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
