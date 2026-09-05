import { isAbsolute, relative, resolve } from 'node:path';
import type { CustomTool } from '@oh-my-pi/pi-coding-agent';
import { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp/manager';
import type { MCPServerConfig, MCPToolDefinition } from '@oh-my-pi/pi-coding-agent/mcp/types';
import {
  mcpConnectionDraftSchema,
  type ComposioMcpMaterialization,
  type ComposioPluginAuthorization,
  type ComposioPluginCatalog,
  type ComposioPluginTool,
  type ComposioSetup,
  type DiscoveredMcpTool,
  type McpAuditEvent,
  type McpConnection,
  type McpConnectionDraft,
  type McpConnectionStatus,
  type ProjectMcpGrant,
} from '@gitspace/protocol';

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
  updateComposioPluginTools(connectionId: string, expectedRevision: number, allowedTools: string[]): Promise<McpConnection>;
  disconnectComposioPlugin(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }>;
  materializeComposioPlugin(projectId: string, workspaceId: string | null, connectionId: string): Promise<ComposioMcpMaterialization>;
  listProjectMcpGrants(projectId: string): Promise<ProjectMcpGrant[]>;
  putProjectMcpGrant(projectId: string, connectionId: string, enabled: boolean, projectSpaceEnabled: boolean, workspacesEnabled: boolean, expectedRevision: number): Promise<ProjectMcpGrant>;
  deleteProjectMcpGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }>;
  materializeProjectSecrets(projectId: string, names: string[]): Promise<Record<string, string>>;
  appendMcpAudit(event: Omit<McpAuditEvent, 'id' | 'principalId' | 'machineId' | 'createdAt'>): Promise<McpAuditEvent>;
}

export interface OmpMcpToolEvent {
  type: string;
  toolName?: unknown;
  error?: unknown;
  isError?: unknown;
  result?: unknown;
}

interface ProjectedConnection {
  connection: McpConnection;
  serverName: string;
  secrets: string[];
  visibleConfig: MCPServerConfig | null;
}

interface SessionRefreshTarget {
  refresh(tools: CustomTool[]): Promise<void>;
}

function serverName(connectionId: string): string {
  return `gitspace-${connectionId}`;
}

function serverFingerprint(name: string, version: string): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(`${name}\n${version}`).digest('hex')}`;
}

function secretNames(connection: McpConnection): string[] {
  if (connection.transport.type === 'composio') return [];
  const names = connection.transport.type === 'stdio'
    ? connection.transport.environment.map((entry) => entry.secret.name)
    : connection.transport.headers.map((entry) => entry.secret.name);
  return [...new Set(names)].sort();
}

function redact(value: unknown, secrets: readonly string[]): string | null {
  if (value === null || value === undefined) return null;
  let text = value instanceof Error ? value.message : typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, '[redacted]');
  }
  return text
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/([?&](?:access_token|api_key|token|secret)=)[^&#\s]*/giu, '$1[redacted]')
    .slice(0, 1_024);
}

function redactSecretsInPlace(value: unknown, secrets: readonly string[], seen = new WeakSet<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index];
      if (typeof child === 'string') {
        let redacted = child;
        for (const secret of secrets) if (secret) redacted = redacted.replaceAll(secret, '[redacted]');
        value[index] = redacted;
      } else {
        redactSecretsInPlace(child, secrets, seen);
      }
    }
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === 'string') {
      let redacted = child;
      for (const secret of secrets) if (secret) redacted = redacted.replaceAll(secret, '[redacted]');
      (value as Record<string, unknown>)[key] = redacted;
    } else {
      redactSecretsInPlace(child, secrets, seen);
    }
  }
}

function resolveStdioCwd(connection: McpConnection, workspacePath: string): string {
  if (connection.transport.type !== 'stdio') return workspacePath;
  const configured = connection.transport.cwd;
  if (!configured) return workspacePath;
  if (connection.target.kind === 'machine') return configured;
  if (isAbsolute(configured)) throw new Error('Workspace-targeted stdio cwd cannot be absolute');
  const cwd = resolve(workspacePath, configured);
  const fromWorkspace = relative(workspacePath, cwd);
  if (fromWorkspace === '..' || fromWorkspace.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(fromWorkspace)) {
    throw new Error('Workspace-targeted stdio cwd escapes the workspace root');
  }
  return cwd;
}

function ompConfig(connection: McpConnection, workspacePath: string, secrets: Record<string, string>): MCPServerConfig {
  if (connection.transport.type === 'composio') throw new Error('Composio plugins require hosted MCP materialization');
  if (connection.transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: connection.transport.command,
      args: [...connection.transport.args],
      cwd: resolveStdioCwd(connection, workspacePath),
      env: Object.fromEntries(connection.transport.environment.map((binding) => {
        const value = secrets[binding.secret.name];
        if (value === undefined) throw new Error(`Project secret ${binding.secret.name} is unavailable`);
        return [binding.name, value];
      })),
      timeout: connection.timeoutMs,
    };
  }
  const headers = Object.fromEntries(connection.transport.headers.map((binding) => {
    const value = secrets[binding.secret.name];
    if (value === undefined) throw new Error(`Project secret ${binding.secret.name} is unavailable`);
    return [binding.name, value];
  }));
  return connection.transport.type === 'http'
    ? { type: 'http', url: connection.transport.url, headers, timeout: connection.timeoutMs }
    : { type: 'sse', url: connection.transport.url, headers, timeout: connection.timeoutMs };
}

function ompVisibleConfig(connection: McpConnection, workspacePath: string): MCPServerConfig {
  if (connection.transport.type === 'composio') throw new Error('Composio plugin credentials cannot be projected into visible configuration');
  if (connection.transport.type === 'stdio') {
    return {
      type: 'stdio',
      command: connection.transport.command,
      args: [...connection.transport.args],
      cwd: resolveStdioCwd(connection, workspacePath),
      env: Object.fromEntries(connection.transport.environment.map((binding) => [
        binding.name,
        `<project-secret:${binding.secret.name}>`,
      ])),
      timeout: connection.timeoutMs,
    };
  }
  const headers = Object.fromEntries(connection.transport.headers.map((binding) => [
    binding.name,
    `<project-secret:${binding.secret.name}>`,
  ]));
  return connection.transport.type === 'http'
    ? { type: 'http', url: connection.transport.url, headers, timeout: connection.timeoutMs }
    : { type: 'sse', url: connection.transport.url, headers, timeout: connection.timeoutMs };
}

function toolDescriptor(projected: ProjectedConnection, tool: MCPToolDefinition, ompToolName: string): DiscoveredMcpTool {
  return {
    connectionId: projected.connection.id,
    connectionLabel: projected.connection.label,
    serverName: projected.serverName,
    name: tool.name,
    ompToolName,
    description: tool.description ?? null,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema ?? null,
    readOnly: tool.annotations?.readOnlyHint ?? null,
    destructive: tool.annotations?.destructiveHint ?? null,
    idempotent: tool.annotations?.idempotentHint ?? null,
    openWorld: tool.annotations?.openWorldHint ?? null,
  };
}


function normalizeMcpEvalResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result;
  const record = result as Record<string, unknown>;
  if (record.details !== undefined && record.details !== null) return record.details;
  if (!Array.isArray(record.content)) return result;
  const text = record.content.flatMap((part) => (
    part
    && typeof part === 'object'
    && 'type' in part
    && part.type === 'text'
    && 'text' in part
    && typeof part.text === 'string'
      ? [part.text]
      : []
  )).join('\n');
  if (!text) return result;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
export class ProjectedMcpSession {

  readonly manager: MCPManager;
  private readonly projected = new Map<string, ProjectedConnection>();
  private readonly unsubscribeStatus: () => void;
  private readonly protectedTools = new WeakSet<object>();
  private refreshTarget: SessionRefreshTarget | null = null;
  private disposed = false;

  constructor(
    private readonly coordinator: MachineMcpCoordinator,
    readonly projectId: string,
    readonly workspaceId: string | null,
    readonly workspacePath: string,
  ) {
    this.manager = new MCPManager(workspacePath);
    this.unsubscribeStatus = this.manager.addConnectionStatusListener((event) => {
      if (event.type === 'connecting') return;
      const projected = this.projected.get(event.serverName);
      if (!projected) return;
      if (event.type === 'failed') {
        const message = redact(event.error, projected.secrets) ?? 'MCP connection failed';
        const status = projected.connection.target.kind === 'machine'
          ? this.coordinator.recordUnavailable(projected.connection, this.projectId, message)
          : this.coordinator.recordFailure(projected.connection, this.projectId, message);
        void this.refreshTarget?.refresh(this.tools());
        void status;
        return;
      }
      const connected = this.manager.getConnection(event.serverName);
      const rawVersion = connected?.serverInfo.version ?? null;
      const version = rawVersion ? redact(rawVersion, projected.secrets) : null;
      const fingerprint = connected ? serverFingerprint(connected.serverInfo.name, connected.serverInfo.version) : null;
      if (connected && projected.visibleConfig) connected.config = projected.visibleConfig;
      this.protectToolResults(projected);
      this.coordinator.queueStatus(projected.connection, 'ready', null, fingerprint, version);
      void this.coordinator.appendAudit({
        projectId: this.projectId,
        connectionId: projected.connection.id,
        type: 'connection-ready',
        toolName: null,
        outcome: 'succeeded',
        message: null,
      });
      void this.refreshTarget?.refresh(this.tools());
    });
  }

  async initialize(): Promise<void> {
    await this.reload();
  }

  attach(target: SessionRefreshTarget): void {
    this.refreshTarget = target;
  }

  async reload(): Promise<void> {
    if (this.disposed) return;
    await this.manager.disconnectAll();
    this.projected.clear();
    const connections = await this.coordinator.authority.listMcpConnections();
    const grants = await this.coordinator.authority.listProjectMcpGrants(this.projectId);
    const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
    const configs: Record<string, MCPServerConfig> = {};

    for (const grant of grants) {
      if (!grant.enabled) continue;
      if (this.workspaceId === null ? !grant.projectSpaceEnabled : !grant.workspacesEnabled) continue;
      const connection = connectionById.get(grant.connectionId);
      if (!connection?.enabled) continue;
      const name = serverName(connection.id);
      const projected: ProjectedConnection = { connection, serverName: name, secrets: [], visibleConfig: null };
      this.projected.set(name, projected);
      if (connection.target.kind === 'machine' && connection.target.machineId !== this.coordinator.machineId) {
        await this.coordinator.recordUnavailable(connection, this.projectId, 'Pinned machine is offline or does not own this session');
        continue;
      }
      await this.coordinator.appendAudit({
        projectId: this.projectId,
        connectionId: connection.id,
        type: 'connection-start',
        toolName: null,
        outcome: 'started',
        message: null,
      });
      try {
        if (connection.transport.type === 'composio') {
          const materialized = await this.coordinator.authority.materializeComposioPlugin(this.projectId, this.workspaceId, connection.id);
          projected.secrets = Object.values(materialized.headers);
          configs[name] = materialized.type === 'http'
            ? { type: 'http', url: materialized.url, headers: materialized.headers, timeout: materialized.timeoutMs }
            : { type: 'sse', url: materialized.url, headers: materialized.headers, timeout: materialized.timeoutMs };
          const visibleHeaders = Object.fromEntries(Object.keys(materialized.headers).map((header) => [header, '<managed-by-composio>']));
          projected.visibleConfig = materialized.type === 'http'
            ? { type: 'http', url: materialized.url, headers: visibleHeaders, timeout: materialized.timeoutMs }
            : { type: 'sse', url: materialized.url, headers: visibleHeaders, timeout: materialized.timeoutMs };
        } else {
          const names = secretNames(connection);
          const values = names.length === 0 ? {} : await this.coordinator.authority.materializeProjectSecrets(this.projectId, names);
          projected.secrets = Object.values(values);
          configs[name] = ompConfig(connection, this.workspacePath, values);
          projected.visibleConfig = ompVisibleConfig(connection, this.workspacePath);
        }
        this.coordinator.queueStatus(connection, 'connecting', null);
      } catch (error) {
        const message = redact(error, projected.secrets);
        await this.coordinator.recordFailure(connection, this.projectId, message ?? 'MCP configuration failed');
      }
    }

    await this.manager.connectServers(configs, {});
    for (const projected of this.projected.values()) this.protectToolResults(projected);
    await this.refreshTarget?.refresh(this.tools());
  }


  private protectToolResults(projected: ProjectedConnection): void {
    const connection = this.manager.getConnection(projected.serverName);
    redactSecretsInPlace(connection?.tools, projected.secrets);
    for (const tool of this.manager.getTools()) {
      if (tool.mcpServerName !== projected.serverName || this.protectedTools.has(tool)) continue;
      let description = tool.description;
      for (const secret of projected.secrets) if (secret) description = description.replaceAll(secret, '[redacted]');
      tool.description = description;
      redactSecretsInPlace(tool.parameters, projected.secrets);
      const execute = tool.execute.bind(tool);
      tool.execute = async (...args: Parameters<typeof tool.execute>) => {
        const result = await execute(...args);
        redactSecretsInPlace(result, projected.secrets);
        return result;
      };
      this.protectedTools.add(tool);
    }
  }
  descriptors(): DiscoveredMcpTool[] {
    const ompToolByOrigin = new Map(this.manager.getTools().flatMap((tool) => (
      tool.mcpServerName && tool.mcpToolName
        ? [[`${tool.mcpServerName}\u0000${tool.mcpToolName}`, tool.name] as const]
        : []
    )));
    const descriptors: DiscoveredMcpTool[] = [];
    for (const [name, projected] of this.projected) {
      if (this.manager.getConnectionStatus(name) !== 'connected') continue;
      for (const tool of this.manager.getConnection(name)?.tools ?? []) {
        const ompName = ompToolByOrigin.get(`${name}\u0000${tool.name}`);
        if (ompName) descriptors.push(toolDescriptor(projected, tool, ompName));
      }
    }
    return descriptors.sort((left, right) => left.connectionLabel.localeCompare(right.connectionLabel) || left.name.localeCompare(right.name));
  }

  tools(): CustomTool[] {
    return [...this.manager.getTools()];
  }

  evalNamespace(localProtocolOptions?: unknown): { declaration: string; call(method: string, args: unknown, signal?: AbortSignal): Promise<unknown> } {
    return {
      declaration: `{
  list(): Promise<DiscoveredMcpTool[]>;
  search(input: { query: string; limit?: number }): Promise<DiscoveredMcpTool[]>;
  describe(input: { name: string }): Promise<DiscoveredMcpTool>;
  call(input: { name: string; args?: Record<string, unknown> }): Promise<unknown>;
}`,
      call: (method, args, signal) => this.callEvalNamespace(method, args, localProtocolOptions, signal),
    };
  }

  private async callEvalNamespace(method: string, rawArgs: unknown, localProtocolOptions: unknown, signal?: AbortSignal): Promise<unknown> {
    const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {};
    const descriptors = this.descriptors();
    if (method === 'list') return descriptors;
    if (method === 'search') {
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.trunc(args.limit)) : 50;
      if (!query) return descriptors.slice(0, limit);
      return descriptors.filter((descriptor) => [
        descriptor.connectionId,
        descriptor.connectionLabel,
        descriptor.name,
        descriptor.ompToolName,
        descriptor.description ?? '',
      ].some((value) => value.toLowerCase().includes(query))).slice(0, limit);
    }
    const name = typeof args.name === 'string' ? args.name : '';
    const descriptor = descriptors.find((candidate) => (
      candidate.ompToolName === name
      || candidate.name === name
      || `${candidate.connectionId}.${candidate.name}` === name
    ));
    if (!descriptor) throw new Error(`MCP tool ${name || '(missing name)'} is unavailable in this project session`);
    if (method === 'describe') return descriptor;
    if (method !== 'call') throw new Error(`Unknown mcp namespace method: ${method}`);
    const tool = this.manager.getTools().find((candidate) => candidate.name === descriptor.ompToolName);
    if (!tool) throw new Error(`MCP tool ${name} disconnected before invocation`);
    const callArgs = args.args && typeof args.args === 'object' ? args.args as Record<string, unknown> : {};
    this.recordToolEvent({ type: 'tool_execution_start', toolName: tool.name });
    try {
      const context = { localProtocolOptions } as never;
      const result = await tool.execute(`eval:${crypto.randomUUID()}`, callArgs, undefined, context, signal);
      this.recordToolEvent({ type: 'tool_execution_end', toolName: tool.name, result });
      return normalizeMcpEvalResult(result);
    } catch (error) {
      this.recordToolEvent({ type: 'tool_execution_end', toolName: tool.name, error, isError: true });
      const projected = tool.mcpServerName ? this.projected.get(tool.mcpServerName) : null;
      throw new Error(redact(error, projected?.secrets ?? []) ?? 'MCP tool call failed');
    }
  }

  recordToolEvent(event: OmpMcpToolEvent): void {
    if (typeof event.toolName !== 'string' || !event.toolName.startsWith('mcp__')) return;
    const tool = this.manager.getTools().find((candidate) => candidate.name === event.toolName);
    if (!tool?.mcpServerName || !tool.mcpToolName) return;
    const projected = this.projected.get(tool.mcpServerName);
    if (!projected) return;
    const isStart = event.type === 'tool_execution_start';
    const result = event.result && typeof event.result === 'object' ? event.result as Record<string, unknown> : null;
    const failed = event.isError === true || result?.isError === true || event.error !== undefined;
    const failureMessage = failed ? redact(event.error ?? result, projected.secrets) : null;
    const canceled = failureMessage ? /\b(?:abort(?:ed)?|cancel(?:ed|led)?)\b/iu.test(failureMessage) : false;
    void this.coordinator.appendAudit({
      projectId: this.projectId,
      connectionId: projected.connection.id,
      type: 'tool-invocation',
      toolName: tool.mcpToolName,
      outcome: isStart ? 'started' : canceled ? 'canceled' : failed ? 'failed' : 'succeeded',
      message: failureMessage,
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.refreshTarget = null;
    this.unsubscribeStatus();
    this.coordinator.detach(this);
    await this.manager.disconnectAll();
  }
}

export class MachineMcpCoordinator {
  private readonly sessionsByProject = new Map<string, Set<ProjectedMcpSession>>();
  private readonly statusRevision = new Map<string, number>();
  private readonly statusQueue = new Map<string, Promise<void>>();

  constructor(readonly authority: MachineMcpAuthority, readonly machineId: string) {}

  async createSession(input: { projectId: string; workspaceId: string | null; workspacePath: string }): Promise<ProjectedMcpSession> {
    const session = new ProjectedMcpSession(this, input.projectId, input.workspaceId, input.workspacePath);
    const sessions = this.sessionsByProject.get(input.projectId) ?? new Set<ProjectedMcpSession>();
    sessions.add(session);
    this.sessionsByProject.set(input.projectId, sessions);
    await session.initialize();
    return session;
  }

  detach(session: ProjectedMcpSession): void {
    const sessions = this.sessionsByProject.get(session.projectId);
    sessions?.delete(session);
    if (sessions?.size === 0) this.sessionsByProject.delete(session.projectId);
  }

  async reloadProject(projectId: string): Promise<void> {
    await Promise.all([...this.sessionsByProject.get(projectId) ?? []].map((session) => session.reload()));
  }

  async reloadAll(): Promise<void> {
    await Promise.all([...this.sessionsByProject.values()].flatMap((sessions) => [...sessions].map((session) => session.reload())));
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
    await this.reloadAll();
    return authorization;
  }

  async refreshComposio(connectionId: string): Promise<McpConnection> {
    const connection = await this.authority.refreshComposioPlugin(connectionId);
    await this.reloadAll();
    return connection;
  }

  listComposioTools(connectionId: string): Promise<ComposioPluginTool[]> {
    return this.authority.listComposioPluginTools(connectionId);
  }

  async updateComposioTools(connectionId: string, expectedRevision: number, allowedTools: string[]): Promise<McpConnection> {
    const connection = await this.authority.updateComposioPluginTools(connectionId, expectedRevision, allowedTools);
    await this.reloadAll();
    return connection;
  }

  async disconnectComposio(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    const result = await this.authority.disconnectComposioPlugin(connectionId, expectedRevision);
    await this.reloadAll();
    return result;
  }

  async createConnection(candidate: McpConnectionDraft): Promise<McpConnection> {
    const connection = await this.authority.createMcpConnection(mcpConnectionDraftSchema.parse(candidate));
    await this.reloadAll();
    return connection;
  }

  async updateConnection(connectionId: string, expectedRevision: number, candidate: McpConnectionDraft): Promise<McpConnection> {
    const connection = await this.authority.updateMcpConnection(connectionId, expectedRevision, mcpConnectionDraftSchema.parse(candidate));
    await this.reloadAll();
    await Promise.all([...this.statusQueue.values()]);
    const latest = await this.authority.getMcpConnectionStatus(connectionId);
    return latest ?? connection;
  }

  async deleteConnection(connectionId: string, expectedRevision: number): Promise<{ connectionId: string; deleted: boolean }> {
    const result = await this.authority.deleteMcpConnection(connectionId, expectedRevision);
    await this.reloadAll();
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
    await this.reloadProject(projectId);
    return grant;
  }

  async deleteGrant(projectId: string, connectionId: string, expectedRevision: number): Promise<{ projectId: string; connectionId: string; deleted: boolean }> {
    const result = await this.authority.deleteProjectMcpGrant(projectId, connectionId, expectedRevision);
    await this.reloadProject(projectId);
    return result;
  }

  async discover(projectId: string, workspaceId: string | null, workspacePath: string): Promise<DiscoveredMcpTool[]> {
    const live = this.sessionsByProject.get(projectId)?.values().next().value as ProjectedMcpSession | undefined;
    if (live) {
      await live.reload();
      return live.descriptors();
    }
    const temporary = await this.createSession({ projectId, workspaceId, workspacePath });
    try {
      return temporary.descriptors();
    } finally {
      await temporary.dispose();
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
