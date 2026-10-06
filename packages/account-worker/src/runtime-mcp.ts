import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker-provider.js';
import { z } from 'zod';
import { RuntimeMcpDiscoverArgumentsSchema, RuntimeMcpInvokeArgumentsSchema, RuntimeJsonSchema } from '@gitspace/protocol-runtime';
import type { UserMcpConnectionsDO } from './local-mcp.js';
import type { ProjectSecretsDO } from './project-secrets.js';
import type { CredentialVaultDO } from './application.js';
import { ComposioPluginGateway } from './composio-plugins.js';
import type { RuntimeIdentity } from './runtime-services.js';
type RuntimeJson = z.infer<typeof RuntimeJsonSchema>;

const request = z.union([RuntimeMcpInvokeArgumentsSchema, RuntimeMcpDiscoverArgumentsSchema.options[1]]);
function redacted(value: unknown, secrets: string[]): RuntimeJson {
  const text = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child !== 'string') return child;
    for (const secret of secrets) if (secret) child = (child as string).replaceAll(secret, '[redacted]');
    return (child as string).replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]').replace(/([?&](?:access_token|api_key|token|secret)=)[^&#\s]*/giu, '$1[redacted]');
  });
  return RuntimeJsonSchema.parse(JSON.parse(text));
}

/** All credentials are resolved inside the account Worker; none enter tool arguments. */
export function createCloudRuntimeMcp(env: Env, identity: RuntimeIdentity) {
  const connections = (env.USER_MCP_CONNECTIONS as DurableObjectNamespace<UserMcpConnectionsDO>).getByName(env.ACCOUNT_ID);
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  async function admitted(connectionId: string) {
    const [connection, grant, workspace] = await Promise.all([connections.get(env.ACCOUNT_ID, connectionId), authority.getMcpGrant(connectionId), authority.listWorkspaces().then(workspaces => workspaces.find(workspace => workspace.id === identity.workspaceId))]);
    if (!workspace) throw new Error('MCP workspace is unavailable');
    const scope = workspace.kind === 'base' ? null : identity.workspaceId;
    if (!connection?.enabled || !grant?.enabled || (scope === null ? !grant.projectSpaceEnabled : !grant.workspacesEnabled)) throw new Error('MCP connection is not granted to this workspace');
    return { connection, scope };
  }
  async function execute(raw: RuntimeJson, invoke: boolean, signal?: AbortSignal): Promise<RuntimeJson> {
    const invocation = invoke ? RuntimeMcpInvokeArgumentsSchema.parse(raw) : null;
    const args = invocation ?? RuntimeMcpDiscoverArgumentsSchema.options[1].parse(raw);
    const { connection, scope } = await admitted(args.connectionId);
    if (connection.transport.type === 'stdio') throw new Error('Stdio MCP requires an assigned machine effect');
    let headers: Record<string, string>;
    let url: string;
    let type: 'http' | 'sse';
    let timeout = connection.timeoutMs;
    if (connection.transport.type === 'composio') {
      if (connection.status !== 'ready') throw new Error('Composio connection is not ready');
      const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(env.ACCOUNT_ID);
      const gateway = new ComposioPluginGateway(env, await vault.getProviderSecret('composio'));
      const materialized = await gateway.materialize(env.ACCOUNT_ID, connection.transport);
      ({ headers, url, type } = materialized);
      timeout = materialized.timeoutMs;
    } else {
      const transport = connection.transport;
      const secrets = (env.PROJECT_SECRETS as DurableObjectNamespace<ProjectSecretsDO>).getByName(env.ACCOUNT_ID);
      const values = await secrets.materialize(identity.projectId, transport.headers.map(binding => binding.secret.name), scope);
      headers = Object.fromEntries(transport.headers.map(binding => {
        const value = values[binding.secret.name];
        if (value === undefined) throw new Error(`MCP secret ${binding.secret.name} is unavailable`);
        return [binding.name, value];
      }));
      ({ url, type } = transport);
    }
    const secrets = Object.values(headers);
    const client = new Client({ name: 'gitspace-cloud', version: '1.0.0' }, { capabilities: {}, jsonSchemaValidator: new CfWorkerJsonSchemaValidator() });
    const transport = type === 'http' ? new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }) : new SSEClientTransport(new URL(url), { requestInit: { headers }, eventSourceInit: { fetch: (input, init) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), ...headers } }) } });
    const audit = async (outcome: 'started' | 'succeeded' | 'failed' | 'canceled') => {
      await connections.appendAudit({ principalId: env.ACCOUNT_ID, projectId: identity.projectId, connectionId: connection.id, machineId: null, type: 'tool-invocation', toolName: invocation?.name ?? null, outcome, message: null });
    };
    let observedRevision = connection.revision;
    const observe = async (status: 'ready' | 'failed', message: string | null) => {
      try {
        const updated = await connections.recordStatus({ principalId: env.ACCOUNT_ID, connectionId: connection.id, observedRevision, status, message });
        observedRevision = updated.revision;
      } catch {
        // A concurrent configuration revision wins over this transport observation.
      }
    };
    try {
      signal?.throwIfAborted();
      await client.connect(transport, { timeout, signal });
      const tools = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {}, { timeout, signal });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      await observe('ready', null);
      if (invocation === null) return redacted(tools.map(tool => ({ ...tool, connectionId: connection.id, connectionLabel: connection.label })), secrets);
      if (!tools.some(tool => tool.name === invocation.name)) throw new Error('MCP tool is not exposed by the granted connection');
      const latest = await admitted(connection.id);
      if (JSON.stringify(latest.connection.transport) !== JSON.stringify(connection.transport)) throw new Error('MCP configuration changed before invocation');
      await audit('started');
      const result = await client.callTool({ name: invocation.name, arguments: invocation.arguments ?? {} }, undefined, { timeout, signal });
      await audit(result.isError ? 'failed' : 'succeeded');
      return redacted(result, secrets);
    } catch (error) {
      if (invoke) await audit(signal?.aborted ? 'canceled' : 'failed');
      const message = String(redacted(error instanceof Error ? error.message : String(error), secrets));
      await observe('failed', message.slice(0, 1024));
      throw new Error(message);
    } finally { await client.close(); }
  }
  return {
    async isStdio(raw: RuntimeJson): Promise<boolean> { return (await admitted(request.parse(raw).connectionId)).connection.transport.type === 'stdio'; },
    async discover(args: RuntimeJson, signal?: AbortSignal): Promise<RuntimeJson> {
      const parsed = RuntimeMcpDiscoverArgumentsSchema.parse(args);
      if ('connectionId' in parsed) return execute(parsed, false, signal);
      const [all, grants, workspace] = await Promise.all([connections.list(env.ACCOUNT_ID), authority.listMcpGrants(), authority.listWorkspaces().then(workspaces => workspaces.find(workspace => workspace.id === identity.workspaceId))]);
      if (!workspace) throw new Error('MCP workspace is unavailable');
      return RuntimeJsonSchema.parse(all.filter(connection => connection.enabled && grants.some(grant => grant.connectionId === connection.id && grant.enabled && (workspace.kind === 'base' ? grant.projectSpaceEnabled : grant.workspacesEnabled))).map(connection => ({ connectionId: connection.id, label: connection.label, transport: connection.transport.type, machineId: connection.target.kind === 'machine' ? connection.target.machineId : null })));
    },
    invoke: (args: RuntimeJson, signal?: AbortSignal) => execute(args, true, signal),
  };
}

/** Namespace calls use the same admitted tool route as direct Session tools. */
export async function invokeMcpNamespace(
  method: 'list' | 'search' | 'describe' | 'call',
  raw: RuntimeJson,
  execute: (tool: 'mcp_discover' | 'mcp_invoke', args: RuntimeJson) => Promise<RuntimeJson>,
): Promise<RuntimeJson> {
  const args = z.object({ connectionId: z.string().optional(), name: z.string().optional(), query: z.string().optional(), limit: z.number().int().min(1).max(1000).optional(), args: z.record(z.string(), RuntimeJsonSchema).optional() }).strict().parse(raw);
  const connections = args.connectionId ? [{ connectionId: args.connectionId }] : z.array(z.object({ connectionId: z.string() })).parse(await execute('mcp_discover', {}));
  const descriptors: Array<Record<string, RuntimeJson> & { name: string; connectionId: string }> = [];
  for (const connection of connections) {
    const tools = z.array(z.record(z.string(), RuntimeJsonSchema)).parse(await execute('mcp_discover', { connectionId: connection.connectionId }));
    for (const tool of tools) {
      const name = z.string().parse(tool.name);
      descriptors.push({ ...tool, name, connectionId: connection.connectionId, qualifiedName: `${connection.connectionId}.${name}` });
    }
  }
  if (method === 'list') return descriptors;
  if (method === 'search') {
    const query = (args.query ?? '').toLowerCase();
    return descriptors.filter(tool => [tool.connectionId, tool.name, String(tool.description ?? '')].some(value => value.toLowerCase().includes(query))).slice(0, args.limit ?? 50);
  }
  const matches = descriptors.filter(tool => tool.qualifiedName === args.name || tool.name === args.name);
  if (matches.length !== 1) throw new Error(matches.length ? 'MCP tool name is ambiguous; use connectionId.toolName' : 'MCP tool is not available in this workspace');
  const selected = matches[0]!;
  if (method === 'describe') return selected;
  return execute('mcp_invoke', { connectionId: selected.connectionId, name: selected.name, arguments: args.args ?? {} });
}
