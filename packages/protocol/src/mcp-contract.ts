import { z } from 'zod';
import { wire, type InputOf } from 'result-rpc';

const identifierSchema = z.string().min(1).max(160);
const labelSchema = z.string().trim().min(1).max(120);
const secretNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u, 'Secret names must be uppercase environment-style names');
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u, 'Environment names must be exact variable names');
const headerNameSchema = z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u, 'Header names must be exact HTTP field names');
const absoluteCommandSchema = z.string().refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value), 'Executable path must be absolute');
const exactPackageSchema = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@(?:v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?|[0-9a-f]{7,40})$/u;

export const mcpSecretReferenceSchema = z.object({
  source: z.literal('project'),
  name: secretNameSchema,
});
export type McpSecretReference = z.infer<typeof mcpSecretReferenceSchema>;

export const mcpEnvironmentBindingSchema = z.object({
  name: environmentNameSchema,
  secret: mcpSecretReferenceSchema,
});
export type McpEnvironmentBinding = z.infer<typeof mcpEnvironmentBindingSchema>;

export const mcpHeaderBindingSchema = z.object({
  name: headerNameSchema,
  secret: mcpSecretReferenceSchema,
});
export type McpHeaderBinding = z.infer<typeof mcpHeaderBindingSchema>;

export const mcpExecutionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace') }),
  z.object({ kind: z.literal('machine'), machineId: identifierSchema }),
]);
export type McpExecutionTarget = z.infer<typeof mcpExecutionTargetSchema>;

export const mcpStdioTransportSchema = z.object({
  type: z.literal('stdio'),
  command: z.string().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(256),
  cwd: z.string().min(1).max(4_096).nullable(),
  environment: z.array(mcpEnvironmentBindingSchema).max(128),
});
export type McpStdioTransport = z.infer<typeof mcpStdioTransportSchema>;

export const mcpHttpTransportSchema = z.object({
  type: z.literal('http'),
  url: z.string().url().max(8_192),
  headers: z.array(mcpHeaderBindingSchema).max(128),
});
export type McpHttpTransport = z.infer<typeof mcpHttpTransportSchema>;

export const mcpSseTransportSchema = z.object({
  type: z.literal('sse'),
  url: z.string().url().max(8_192),
  headers: z.array(mcpHeaderBindingSchema).max(128),
});
export type McpSseTransport = z.infer<typeof mcpSseTransportSchema>;

export const mcpTransportSchema = z.discriminatedUnion('type', [
  mcpStdioTransportSchema,
  mcpHttpTransportSchema,
  mcpSseTransportSchema,
]);
export type McpTransport = z.infer<typeof mcpTransportSchema>;

export const mcpConnectionStatusSchema = z.enum(['disabled', 'connecting', 'ready', 'offline', 'failed']);
export type McpConnectionStatus = z.infer<typeof mcpConnectionStatusSchema>;

export const mcpConnectionDraftSchema = z.object({
  id: identifierSchema,
  label: labelSchema,
  enabled: z.boolean(),
  target: mcpExecutionTargetSchema,
  transport: mcpTransportSchema,
  timeoutMs: z.number().int().min(0).max(10 * 60_000),
}).superRefine((draft, context) => {
  if (draft.transport.type === 'stdio') {
    if (draft.target.kind !== 'machine' && draft.transport.cwd && absoluteCommandSchema.safeParse(draft.transport.cwd).success) {
      context.addIssue({ code: 'custom', path: ['transport', 'cwd'], message: 'Workspace-targeted stdio cwd must be relative to the workspace root' });
    }
    if (draft.target.kind === 'machine' && draft.transport.cwd && !absoluteCommandSchema.safeParse(draft.transport.cwd).success) {
      context.addIssue({ code: 'custom', path: ['transport', 'cwd'], message: 'Machine-targeted stdio cwd must be an absolute path' });
    }
    const command = draft.transport.command;
    const executable = command.replaceAll('\\', '/').split('/').at(-1)?.replace(/\.cmd$/iu, '');
    if (executable === 'bunx' || executable === 'npx') {
      const allowedFlag = executable === 'bunx' ? '--bun' : '--yes';
      const packageIndex = draft.transport.args[0] === allowedFlag ? 1 : 0;
      const packageArg = draft.transport.args[packageIndex];
      if (!packageArg || !exactPackageSchema.test(packageArg)) {
        context.addIssue({ code: 'custom', path: ['transport', 'args'], message: `${executable} requires an exact package version or commit as its package argument` });
      }
    } else if (!absoluteCommandSchema.safeParse(command).success) {
      context.addIssue({ code: 'custom', path: ['transport', 'command'], message: 'stdio command must be bunx, npx, or an absolute executable path' });
    }
  } else {
    const url = new URL(draft.transport.url);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      context.addIssue({ code: 'custom', path: ['transport', 'url'], message: 'HTTP and SSE MCP URLs must use http or https' });
    }
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '[::1]') {
      if (draft.target.kind !== 'machine') {
        context.addIssue({ code: 'custom', path: ['target'], message: 'Loopback MCP URLs must be pinned to a machine' });
      }
    }
  }
  const names = draft.transport.type === 'stdio'
    ? draft.transport.environment.map((entry) => entry.name)
    : draft.transport.headers.map((entry) => entry.name.toLowerCase());
  if (new Set(names).size !== names.length) {
    context.addIssue({ code: 'custom', path: ['transport'], message: 'MCP secret bindings must have unique destination names' });
  }
});
export type McpConnectionDraft = z.infer<typeof mcpConnectionDraftSchema>;

export const mcpConnectionSchema = z.object({
  principalId: identifierSchema,
  label: labelSchema,
  enabled: z.boolean(),
  target: mcpExecutionTargetSchema,
  transport: mcpTransportSchema,
  timeoutMs: z.number().int().min(0).max(10 * 60_000),
  id: identifierSchema,
  status: mcpConnectionStatusSchema,
  statusMessage: z.string().max(1_024).nullable(),
  statusCheckedAt: z.string().datetime().nullable(),
  serverFingerprint: z.string().max(512).nullable(),
  serverVersion: z.string().max(256).nullable(),
  revision: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type McpConnection = z.infer<typeof mcpConnectionSchema>;

export const projectMcpGrantSchema = z.object({
  projectId: identifierSchema,
  connectionId: identifierSchema,
  enabled: z.boolean(),
  projectSpaceEnabled: z.boolean(),
  workspacesEnabled: z.boolean(),
  revision: z.number().int().positive(),
  createdBy: identifierSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProjectMcpGrant = z.infer<typeof projectMcpGrantSchema>;

const jsonObjectSchema = z.record(z.string(), z.unknown());
export const discoveredMcpToolSchema = z.object({
  connectionId: identifierSchema,
  connectionLabel: labelSchema,
  serverName: identifierSchema,
  name: identifierSchema,
  ompToolName: identifierSchema,
  description: z.string().nullable(),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema.nullable(),
  readOnly: z.boolean().nullable(),
  destructive: z.boolean().nullable(),
  idempotent: z.boolean().nullable(),
  openWorld: z.boolean().nullable(),
});
export type DiscoveredMcpTool = z.infer<typeof discoveredMcpToolSchema>;

export const mcpAuditEventSchema = z.object({
  id: z.string().uuid(),
  principalId: identifierSchema,
  projectId: identifierSchema.nullable(),
  connectionId: identifierSchema,
  machineId: identifierSchema.nullable(),
  type: z.enum(['connection-start', 'connection-ready', 'connection-offline', 'connection-failure', 'tool-invocation']),
  toolName: identifierSchema.nullable(),
  outcome: z.enum(['started', 'succeeded', 'failed', 'canceled']).nullable(),
  message: z.string().max(1_024).nullable(),
  createdAt: z.string().datetime(),
});
export type McpAuditEvent = z.infer<typeof mcpAuditEventSchema>;

const SecretReferenceCodec = wire.object({ source: wire.literal('project'), name: wire.string });
const EnvironmentBindingCodec = wire.object({ name: wire.string, secret: SecretReferenceCodec });
const HeaderBindingCodec = wire.object({ name: wire.string, secret: SecretReferenceCodec });
export const McpExecutionTargetCodec = wire.union([
  wire.object({ kind: wire.literal('workspace') }),
  wire.object({ kind: wire.literal('machine'), machineId: wire.string }),
]);
export const McpTransportCodec = wire.union([
  wire.object({ type: wire.literal('stdio'), command: wire.string, args: wire.array(wire.string), cwd: wire.nullable(wire.string), environment: wire.array(EnvironmentBindingCodec) }),
  wire.object({ type: wire.literal('http'), url: wire.string, headers: wire.array(HeaderBindingCodec) }),
  wire.object({ type: wire.literal('sse'), url: wire.string, headers: wire.array(HeaderBindingCodec) }),
]);
export const McpConnectionDraftCodec = wire.object({
  id: wire.string,
  label: wire.string,
  enabled: wire.boolean,
  target: McpExecutionTargetCodec,
  transport: McpTransportCodec,
  timeoutMs: wire.number,
});
export const McpConnectionViewCodec = wire.object({
  principalId: wire.string,
  id: wire.string,
  label: wire.string,
  enabled: wire.boolean,
  target: McpExecutionTargetCodec,
  transport: McpTransportCodec,
  timeoutMs: wire.number,
  status: wire.enum(['disabled', 'connecting', 'ready', 'offline', 'failed']),
  statusMessage: wire.nullable(wire.string),
  statusCheckedAt: wire.nullable(wire.date),
  serverFingerprint: wire.nullable(wire.string),
  serverVersion: wire.nullable(wire.string),
  revision: wire.number,
  createdAt: wire.date,
  updatedAt: wire.date,
});
export const ProjectMcpGrantViewCodec = wire.object({
  projectId: wire.string,
  connectionId: wire.string,
  enabled: wire.boolean,
  projectSpaceEnabled: wire.boolean,
  workspacesEnabled: wire.boolean,
  revision: wire.number,
  createdBy: wire.string,
  createdAt: wire.date,
  updatedAt: wire.date,
});
const JsonObjectCodec = wire.serializable(
  (value): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value),
  { id: 'gitspace/mcp-json-object/v1' },
);
export const DiscoveredMcpToolViewCodec = wire.object({
  connectionId: wire.string,
  connectionLabel: wire.string,
  serverName: wire.string,
  name: wire.string,
  ompToolName: wire.string,
  description: wire.nullable(wire.string),
  inputSchema: JsonObjectCodec,
  outputSchema: wire.nullable(JsonObjectCodec),
  readOnly: wire.nullable(wire.boolean),
  destructive: wire.nullable(wire.boolean),
  idempotent: wire.nullable(wire.boolean),
  openWorld: wire.nullable(wire.boolean),
});
export type McpConnectionRpcView = InputOf<typeof McpConnectionViewCodec>;
export type ProjectMcpGrantRpcView = InputOf<typeof ProjectMcpGrantViewCodec>;
export type DiscoveredMcpToolRpcView = InputOf<typeof DiscoveredMcpToolViewCodec>;

export type McpConnectionDraftInput = InputOf<typeof McpConnectionDraftCodec>;
