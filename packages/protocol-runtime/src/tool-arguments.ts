import { z } from 'zod';
import { RuntimeContentSchema, RuntimeJsonSchema } from './base.js';
import { RuntimeJobHandleSchema } from './execution-contracts.js';
import { RuntimeDispatchSelectionSchema } from './scheduling.js';
import { LifecycleRunRequestSchema, LifecycleMutationSchema } from '@gitspace/protocol-environment';
import { DaemonStartSpecSchema } from '@gitspace/supervisor/protocol';

const path = z.string().min(1);
export const RuntimeReadArgumentsSchema = z.object({ path, offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() });
export const RuntimeWriteArgumentsSchema = z.object({ path, content: z.string() });
export const RuntimeEditArgumentsSchema = z.object({ path, edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1) });
export const ApplyPatchArgumentsSchema = z.object({ patch: z.string().min(1) });
export const RuntimeBashCommandArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ command: path, cwd: path.optional(), background: z.boolean().optional() }).strict();
export const RuntimeBashControlArgumentsSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list') }),
  z.strictObject({ op: z.enum(['status', 'cancel']), job: RuntimeJobHandleSchema }),
  z.strictObject({ op: z.literal('wait'), job: RuntimeJobHandleSchema, timeoutMs: z.number().int().positive().max(300_000).default(30_000) }),
  z.strictObject({ op: z.literal('logs'), job: RuntimeJobHandleSchema, lines: z.number().int().positive().max(10_000).optional(), head: z.boolean().optional(), cursor: z.number().int().nonnegative().optional() }),
]);
export const RuntimeBashArgumentsSchema = z.union([RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema]);
export const RuntimeFindArgumentsSchema = z.object({ pattern: z.string(), path: z.string().default('.') }).strict();
export const RuntimeGrepArgumentsSchema = RuntimeFindArgumentsSchema.extend({ ...RuntimeDispatchSelectionSchema.shape, glob: z.string().optional() });
export const RuntimeAstGrepArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ pattern: z.string().min(1), path: z.string().default('.'), language: z.string().optional() });
export const RuntimeAstEditArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ ops: z.array(z.object({ pat: z.string().min(1), out: z.string() })).min(1), paths: z.array(path).min(1), language: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u) });
export const RuntimeAstResolveArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ proposalId: path, action: z.enum(['apply', 'reject']) });
export const RuntimeCodemodeArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ code: z.string() });
const processName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,159}$/u);
const processTimeout = z.number().int().positive().max(300_000);
const processSelection = RuntimeDispatchSelectionSchema.shape;
export const RuntimeProcArgumentsSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('start'), ...processSelection, spec: DaemonStartSpecSchema.omit({ visibility: true, inheritEnv: true }).extend({ cwd: path.optional(), args: z.array(z.string()).default([]), env: z.record(z.string(), z.string()).default({}), pty: z.boolean().default(true), restart: z.enum(['no', 'on-failure', 'always']).default('no'), persist: z.boolean().default(true), detached: z.boolean().default(false) }).strict() }),
  z.strictObject({ op: z.literal('list'), ...processSelection }),
  z.strictObject({ op: z.literal('status'), name: processName, instanceId: z.string().uuid().optional(), restartCount: z.number().int().nonnegative().optional(), ...processSelection }),
  z.strictObject({ op: z.literal('describe'), name: processName, instanceId: z.string().uuid().optional(), restartCount: z.number().int().nonnegative().optional(), ...processSelection }),
  z.strictObject({ op: z.literal('stop'), name: processName, instanceId: z.string().uuid().optional(), restartCount: z.number().int().nonnegative().optional(), timeoutMs: processTimeout.optional(), ...processSelection }),
  z.strictObject({ op: z.literal('restart'), name: processName, timeoutMs: processTimeout.optional(), ...processSelection }),
  z.strictObject({ op: z.literal('send'), name: processName, text: z.string().optional(), enter: z.boolean().default(true), keys: z.array(z.enum(['ENTER', 'TAB', 'ESCAPE', 'CTRL_C', 'CTRL_D', 'UP', 'DOWN', 'LEFT', 'RIGHT'])).optional(), signal: z.enum(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGKILL']).optional(), cols: z.number().int().positive().optional(), rows: z.number().int().positive().optional(), ...processSelection }),
  z.strictObject({ op: z.literal('wait'), name: processName, for: z.enum(['ready', 'exit']).optional(), pattern: path.optional(), timeoutMs: processTimeout.optional(), ...processSelection }),
  z.strictObject({ op: z.literal('logs'), name: processName, lines: z.number().int().positive().max(10_000).optional(), head: z.boolean().optional(), grep: path.optional(), follow: z.boolean().optional(), cursor: z.number().int().nonnegative().optional(), timeoutMs: processTimeout.optional(), ...processSelection }),
]);
const agentMessagingOptions = [
  z.strictObject({ op: z.literal('send'), to: path, message: path }),
  z.strictObject({ op: z.literal('wait'), timeoutMs: z.number().int().min(1).max(300_000).default(30_000) }),
  z.strictObject({ op: z.enum(['list', 'status']), id: path.optional() }),
] as const;
export const RuntimeChildAgentsArgumentsSchema = z.discriminatedUnion('op', agentMessagingOptions);
export const RuntimeAgentsArgumentsSchema = z.union([
  z.strictObject({ op: z.literal('spawn'), task: path, name: path.optional(), agent: path, background: z.boolean().default(false) }),
  z.strictObject({ op: z.literal('spawn'), task: path, name: path.optional(), role: path, background: z.boolean().default(false) }),
  z.strictObject({ op: z.literal('stop'), id: path }),
  RuntimeChildAgentsArgumentsSchema,
]);
export function runtimeOperationIsReadOnly(name: string, args: z.infer<typeof RuntimeJsonSchema>): boolean {
  if (['read', 'grep', 'find', 'web_search', 'history_search', 'history_read', 'ast_grep', 'mcp_discover'].includes(name)) return true;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (['machines', 'agents', 'bash', 'proc'].includes(name)) return ['list', 'status', 'describe', 'logs', 'wait'].includes(String(args.op));
  if (name.startsWith('space_') || name === 'environment') return ['get', 'current', 'list', 'operations', 'describe', 'read', 'readCode', 'listScopes', 'listPromotions', 'runLog', 'log'].includes(String(args.method));
  return false;
}
export const RuntimeMachinesArgumentsSchema = z.union([z.object({ op: z.literal('list').default('list') }), z.object({ op: z.literal('detach'), attachmentId: path, generation: z.number().int().nonnegative() }), z.object({ op: z.literal('setDefault'), machineId: path.nullable() })]);
export const RuntimeHistoryReadArgumentsSchema = z.object({ conversationId: path, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) });
export const RuntimeHistorySearchArgumentsSchema = z.object({ query: path, scope: z.enum(['workspace', 'project']).default('workspace') });
export const RuntimeWebSearchArgumentsSchema = z.object({ query: z.string().min(1).max(2048) });
export const RuntimeReportIssueArgumentsSchema = z.object({ message: z.string().min(1).max(16384), tool: z.string().max(160).optional(), model: z.string().max(256).optional(), reference: z.string().max(2048).optional() });
export const RuntimeCheckpointArgumentsSchema = z.object({ goal: z.string() });
export const RuntimeRewindArgumentsSchema = z.object({ checkpoint: z.string(), report: z.string() });
export const RuntimeDelegateExportArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ commit: z.string().regex(/^[a-f0-9]{40,64}$/u) });
export const RuntimeMcpInvokeArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ connectionId: path, name: path, arguments: z.record(z.string(), RuntimeJsonSchema).optional() }).strict();
export const RuntimeMcpDiscoverArgumentsSchema = z.union([z.object({}).strict(), RuntimeDispatchSelectionSchema.extend({ connectionId: path }).strict()]);
export const RuntimeGenerateImageArgumentsSchema = z.object({ prompt: path, model: path.optional(), images: z.array(RuntimeContentSchema.options[1]).optional() }).strict();
export const RuntimeSpacePhaseArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ phase: z.enum(['plan', 'code', 'review', 'ship']) });
export const RuntimeSpaceArtifactsArgumentsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.enum(['list', 'listScopes', 'listPromotions']) }),
  z.object({ method: z.literal('read'), url: path }),
  z.object({ method: z.literal('readCode'), path, commit: z.string().regex(/^[a-f0-9]{40,64}$/u) }),
]);
export const RuntimeAgentLifecycleRunArgumentsSchema = LifecycleRunRequestSchema.omit({ interactive: true }).extend({ ...RuntimeDispatchSelectionSchema.shape, phase: LifecycleRunRequestSchema.shape.phase.exclude(['cloud/destroy']) });
export const RuntimeEnvironmentArgumentsSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('get') }),
  z.object({ method: z.enum(['runLog', 'log']), runId: path, offset: z.number().int().nonnegative().optional() }),
  RuntimeAgentLifecycleRunArgumentsSchema.omit({ phase: true }).extend({ method: z.literal('runChecks') }),
  RuntimeAgentLifecycleRunArgumentsSchema.extend({ method: z.literal('runPhase') }),
  LifecycleMutationSchema.options[1].omit({ op: true }).extend({ method: z.literal('setProfile') }),
  LifecycleMutationSchema.options[2].omit({ op: true }).extend({ method: z.literal('putValue'), scope: z.enum(['project', 'workspace']), value: z.string().max(16_384) }),
  LifecycleMutationSchema.options[2].omit({ op: true, value: true }).extend({ method: z.literal('deleteValue'), scope: z.enum(['project', 'workspace']) }),
  z.object({ method: z.literal('cancelRun'), runId: path }),
]);
