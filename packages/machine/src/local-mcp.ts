import { isAbsolute, relative, resolve } from 'node:path';
import { type as schema } from '@oh-my-pi/omptype';
import type { CustomTool } from '@oh-my-pi/pi-coding-agent';
import {
  MCPManager,
  type MCPServerConfig,
  type MCPToolDefinition,
} from '@oh-my-pi/pi-coding-agent/mcp';
import {
  mcpConnectionDraftSchema,
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

const mcpCodeSchema = schema({
  code: schema('string').describe('JavaScript async-function body. Return the final value. Use integrations.use(connectionId), search(), describe(), call(), tools, or ALL_TOOLS.'),
  'timeout_ms?': schema('1000 <= number <= 120000').describe('Execution deadline in milliseconds. Defaults to 60000.'),
  'max_output_chars?': schema('1000 <= number <= 100000').describe('Maximum serialized output returned to the model. Defaults to 50000.'),
});

interface McpCodeCallMessage {
  type: 'call';
  id: number;
  name: string;
  args: Record<string, unknown>;
}

interface McpCodeResultMessage {
  type: 'result';
  value: unknown;
}

interface McpCodeErrorMessage {
  type: 'error';
  error: string;
}

type McpCodeWorkerMessage = McpCodeCallMessage | McpCodeResultMessage | McpCodeErrorMessage;

function codeModeDescription(tools: readonly DiscoveredMcpTool[]): string {
  const catalog = tools.slice(0, 80).map((tool) => {
    const effect = tool.destructive ? 'destructive' : tool.readOnly ? 'read-only' : 'write-capable';
    return `- ${tool.connectionId}.${tool.name} (${effect})\\n  ${tool.description ?? 'No description supplied.'}\\n  input: ${JSON.stringify(tool.inputSchema)}`;
  }).join('\\n');
  return `Execute JavaScript that discovers, composes, filters, and aggregates the MCP tools enabled for this project session.

The code is an async-function body and must return its final value.

Available APIs:
- integrations.use(connectionId).searchTools(query, { limit? })
- integrations.use(connectionId).describeTool(name)
- integrations.use(connectionId).tool(name, args)
- search(query, { limit? }) / integrations.search(...)
- describe(name) / integrations.describe(...)
- call(name, args) / integrations.call(...)
- tools[ompToolName](args)
- ALL_TOOLS

Direct network credentials are never provided. Nested calls use the same grant-scoped OMP MCP tools. The outer mcp_code call is classified as executable code and may require approval.

Current live catalog:
${catalog || '- No MCP tools are currently connected.'}`;
}

function boundedCodeResult(value: unknown, maxChars: number): { text: string; truncated: boolean } {
  let text: string;
  try {
    const serialized = JSON.stringify(value, null, 2);
    text = serialized === undefined ? String(value) : serialized;
  } catch (error) {
    text = error instanceof Error ? `Unable to serialize result: ${error.message}` : 'Unable to serialize result';
  }
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\\n--- TRUNCATED ---`, truncated: true };
}

interface McpCodeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: { result: unknown; truncated: boolean; calls: number };
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
      if (connected) connected.config = ompVisibleConfig(projected.connection, this.workspacePath);
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
      const projected: ProjectedConnection = { connection, serverName: name, secrets: [] };
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
        const names = secretNames(connection);
        const values = names.length === 0 ? {} : await this.coordinator.authority.materializeProjectSecrets(this.projectId, names);
        projected.secrets = Object.values(values);
        configs[name] = ompConfig(connection, this.workspacePath, values);
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
    const tools: CustomTool[] = [...this.manager.getTools()];
    const descriptors = this.descriptors();
    if (descriptors.length > 0) tools.push(this.codeModeTool(descriptors));
    return tools;
  }

  private codeModeTool(descriptors: DiscoveredMcpTool[]): CustomTool<typeof mcpCodeSchema> {
    return {
      name: 'mcp_code',
      label: 'MCP Code',
      description: codeModeDescription(descriptors),
      parameters: mcpCodeSchema,
      strict: true,
      loadMode: 'discoverable',
      approval: { tier: 'exec', reason: 'Executes code that may compose enabled MCP tools.' },
      formatApprovalDetails: (args) => {
        if (!args || typeof args !== 'object' || !('code' in args) || typeof args.code !== 'string') return undefined;
        const firstLine = args.code.trim().split('\\n', 1)[0] ?? '';
        return [`Code: ${firstLine.slice(0, 160) || '(empty)'}`, `Enabled MCP tools: ${descriptors.length}`];
      },
      execute: (toolCallId, params, _onUpdate, ctx, signal) => this.executeMcpCode(toolCallId, params, ctx, descriptors, signal),
    };
  }

  private executeMcpCode(
    toolCallId: string,
    params: typeof mcpCodeSchema.infer,
    ctx: Parameters<CustomTool<typeof mcpCodeSchema>['execute']>[3],
    descriptors: DiscoveredMcpTool[],
    signal?: AbortSignal,
  ): Promise<McpCodeToolResult> {
    const timeoutMs = params.timeout_ms ?? 60_000;
    const maxOutputChars = params.max_output_chars ?? 50_000;
    const toolByName = new Map<string, CustomTool>();
    for (const tool of this.manager.getTools()) {
      toolByName.set(tool.name, tool);
      if (tool.mcpToolName) {
        toolByName.set(tool.mcpToolName, tool);
        if (tool.mcpServerName) {
          const projected = this.projected.get(tool.mcpServerName);
          if (projected) toolByName.set(`${projected.connection.id}.${tool.mcpToolName}`, tool);
        }
      }
    }

    const deferred = Promise.withResolvers<McpCodeToolResult>();
    const resolvePromise = deferred.resolve;
    const rejectPromise = deferred.reject;
    const worker = new Worker(new URL('./mcp-code-worker.ts', import.meta.url).href, { type: 'module' });
      let calls = 0;
      let settled = false;
      const finish = () => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.terminate();
        return true;
      };
      const abort = () => {
        if (!finish()) return;
        rejectPromise(new Error('MCP code execution aborted'));
      };
      const timer = setTimeout(() => {
        if (!finish()) return;
        rejectPromise(new Error(`MCP code execution exceeded ${timeoutMs}ms`));
      }, timeoutMs);

      worker.onerror = (event) => {
        if (!finish()) return;
        rejectPromise(new Error(event.message || 'MCP code worker failed'));
      };
      worker.onmessage = (event: MessageEvent<McpCodeWorkerMessage>) => {
        const message = event.data;
        if (message.type === 'call') {
          const tool = toolByName.get(message.name);
          if (!tool) {
            worker.postMessage({ type: 'call-result', id: message.id, error: `MCP tool ${message.name} is unavailable in this project session.` });
            return;
          }
          calls += 1;
          this.recordToolEvent({ type: 'tool_execution_start', toolName: tool.name });
          void tool.execute(`${toolCallId}:${message.id}`, message.args, undefined, ctx, signal)
            .then((value) => {
              this.recordToolEvent({ type: 'tool_execution_end', toolName: tool.name, result: value });
              worker.postMessage({ type: 'call-result', id: message.id, value });
            })
            .catch((error) => {
              this.recordToolEvent({ type: 'tool_execution_end', toolName: tool.name, error, isError: true });
              const projected = tool.mcpServerName ? this.projected.get(tool.mcpServerName) : null;
              worker.postMessage({ type: 'call-result', id: message.id, error: redact(error, projected?.secrets ?? []) ?? 'MCP tool call failed' });
            });
          return;
        }
        if (message.type === 'error') {
          if (!finish()) return;
          rejectPromise(new Error(message.error));
          return;
        }
        if (!finish()) return;
        const output = boundedCodeResult(message.value, maxOutputChars);
        resolvePromise({
          content: [{ type: 'text', text: output.text }],
          details: { result: message.value, truncated: output.truncated, calls },
        });
      };

      if (signal?.aborted) {
        abort();
        return deferred.promise;
      }
      signal?.addEventListener('abort', abort, { once: true });
      worker.postMessage({ type: 'execute', code: params.code, tools: descriptors });
    return deferred.promise;
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
