import { z } from 'zod';
import { RuntimeContentSchema, RuntimeJsonSchema } from './base.js';
import { RuntimeJobHandleSchema } from './execution-contracts.js';
import { RuntimeDispatchSelectionSchema, RuntimeMachineNeedsSchema } from './scheduling.js';
import { LifecycleRunRequestSchema, LifecycleMutationSchema } from '@gitspace/protocol-environment';
import { DaemonStartSpecSchema } from '@gitspace/supervisor/protocol';

const path = z.string().min(1);
export const RuntimeReadArgumentsSchema = z.object({ path, offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() });
/** One line describing the change; it becomes the message of the change's edit-history commit. */
const message = z.string().trim().min(1).max(500).optional();
export const RuntimeWriteArgumentsSchema = z.object({ path, content: z.string(), message });
export const RuntimeEditArgumentsSchema = z.object({ path, edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1), message });
export const ApplyPatchArgumentsSchema = z.object({ patch: z.string().min(1), message });
export const RuntimeBashCommandArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ command: path, cwd: path.optional(), background: z.boolean().optional() }).strict();
export const RuntimeBashControlArgumentsSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('list') }),
  z.strictObject({ op: z.enum(['status', 'cancel']), job: RuntimeJobHandleSchema }),
  z.strictObject({ op: z.literal('wait'), job: RuntimeJobHandleSchema, timeoutMs: z.number().int().positive().max(300_000).default(30_000) }),
  z.strictObject({ op: z.literal('logs'), job: RuntimeJobHandleSchema, lines: z.number().int().positive().max(10_000).optional(), head: z.boolean().optional(), cursor: z.number().int().nonnegative().optional() }),
]);
export const RuntimeBashArgumentsSchema = z.union([RuntimeBashCommandArgumentsSchema, RuntimeBashControlArgumentsSchema]);
export const RuntimeFindArgumentsSchema = z.object({ pattern: z.string(), path: z.string().default('.') }).strict();
/** The cloud index answers grep's pattern, path, visibility and paging contract; it never selects a machine. */
export const RuntimeCodeSearchArgumentsSchema = RuntimeFindArgumentsSchema.extend({
  glob: z.string().optional(),
  hidden: z.boolean().default(false), gitignore: z.boolean().default(true),
  multiline: z.boolean().default(false), caseSensitive: z.boolean().default(true),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().positive().max(10000).default(1000),
});
export const RuntimeGrepArgumentsSchema = RuntimeCodeSearchArgumentsSchema.extend(RuntimeDispatchSelectionSchema.shape);
export const RuntimeAstGrepArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ pattern: z.string().min(1), path: z.string().default('.'), language: z.string().optional() });
export const RuntimeAstEditArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ ops: z.array(z.object({ pat: z.string().min(1), out: z.string() })).min(1), paths: z.array(path).min(1), language: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u) });
export const RuntimeAstResolveArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ proposalId: path, action: z.enum(['apply', 'reject']) });
export const RuntimeCodemodeArgumentsSchema = z.object({ code: z.string().max(262144), timeoutMs: z.number().int().positive().max(30000).default(30000) }).strict();
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
  if (['read', 'grep', 'code_search', 'find', 'web_search', 'history_search', 'history_read', 'ast_grep', 'mcp_discover', 'workspace_status'].includes(name)) return true;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (['machines', 'agents', 'bash', 'proc', 'sync_machine'].includes(name)) return ['list', 'status', 'describe', 'logs', 'wait', 'diff'].includes(String(args.op));
  if (name === 'sync') return ['status', 'diff', 'backups'].includes(String(args.method));
  if (name === 'service') return args.op === 'list' || args.op === 'logs';
  if (name.startsWith('space_') || name === 'environment') return ['get', 'current', 'list', 'operations', 'describe', 'read', 'readCode', 'listScopes', 'listPromotions', 'runLog', 'log'].includes(String(args.method));
  return false;
}
export const RuntimeWorkspaceStatusArgumentsSchema = z.object({}).strict();
export const RuntimeMachinesArgumentsSchema = z.union([
  z.object({ op: z.literal('list').default('list') }),
  z.object({ op: z.literal('detach'), attachmentId: path, generation: z.number().int().nonnegative() }),
  /** `machine` is an id or label; omitted, the account default machine, else any online machine offering `needs`. */
  z.object({ op: z.literal('attach'), machine: z.string().min(1).optional(), needs: RuntimeMachineNeedsSchema.optional() }).strict(),
]);
/** Agent-facing sync control. `on` selects the machine; omitted, the single ready machine is used. */
export const RuntimeSyncArgumentsSchema = z.discriminatedUnion('method', [
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('status') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('now') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('diff'), path: path.optional() }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('discard'), reason: z.string().trim().min(1).max(500).optional() }),
  z.object({ method: z.literal('backups') }),
  RuntimeDispatchSelectionSchema.pick({ on: true }).extend({ method: z.literal('restore'), ref: path }),
  z.object({ method: z.literal('resolve'), path, keep: z.enum(['cloud', 'machine']) }),
]);
const commitId = z.string().regex(/^[0-9a-f]{40}$/u);
/** The machine half of `sync`: what only the machine holding the checkout can do. */
export const RuntimeSyncMachineArgumentsSchema = z.discriminatedUnion('op', [
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('status') }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('capture') }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('diff'), path: path.optional() }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('discard') }),
  RuntimeDispatchSelectionSchema.extend({ op: z.literal('restore'), checkpointRef: path, commit: commitId, baseRef: path, base: commitId }),
]);
export const RuntimeSyncChangeSchema = z.object({ status: z.string().min(1), path });
export const RuntimeSyncMachineStatusSchema = z.object({
  base: commitId.nullable(), pending: z.boolean(), unsent: z.array(RuntimeSyncChangeSchema), unsentTruncated: z.boolean(),
  lastSyncAt: z.iso.datetime().nullable(), problem: z.string().nullable(),
});
export const RuntimeSyncMachineDiffSchema = z.object({ base: commitId.nullable(), unsent: z.array(RuntimeSyncChangeSchema), unsentTruncated: z.boolean(), patch: z.string().nullable() });
/** A backup holds `commit`; restoring re-applies its changes since `base` onto the current files. */
export const RuntimeSyncBackupSchema = z.object({ checkpointRef: path, commit: commitId, base: commitId });
export const RuntimeSyncMachineDiscardSchema = z.object({ discarded: z.array(RuntimeSyncChangeSchema), backup: RuntimeSyncBackupSchema.nullable(), machineId: path, error: z.string().optional() });
export const RuntimeSyncMachineCaptureSchema = z.object({ version: commitId.nullable(), conflicts: z.array(path) });
export const RuntimeSyncMachineRestoreSchema = RuntimeSyncMachineCaptureSchema.extend({ restored: z.array(RuntimeSyncChangeSchema), mergeConflicts: z.array(path) });
export const RuntimeHistoryReadArgumentsSchema = z.union([
  z.object({ mode: z.literal('page').default('page'), workspaceId: path.optional(), conversationId: path, offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(200).default(50) }),
  z.object({ mode: z.literal('content'), workspaceId: path.optional(), conversationId: path, ordinal: z.number().int().nonnegative(), contentOffset: z.number().int().nonnegative().default(0), contentLimit: z.number().int().min(1).max(65_536).default(16_384) }),
]);
export type RuntimeHistoryReadArguments = z.infer<typeof RuntimeHistoryReadArgumentsSchema>;
export const RuntimeHistorySearchArgumentsSchema = z.object({ query: path, scope: z.enum(['workspace', 'project']).default('workspace'), cursor: z.string().max(512).optional() });
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
/** A lifecycle run as its cache machine receives it. Agents enter through the narrower schema above; a human run,
 * authorized by the account before dispatch, may also run interactively or destroy cloud resources. */
export const RuntimeLifecycleDispatchArgumentsSchema = LifecycleRunRequestSchema.extend(RuntimeDispatchSelectionSchema.shape);
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
