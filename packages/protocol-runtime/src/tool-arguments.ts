import { z } from 'zod';
import { RuntimeContentSchema, RuntimeJsonSchema } from './base.js';
import { RuntimeJobHandleSchema } from './execution-contracts.js';
import { RuntimeDispatchSelectionSchema } from './scheduling.js';
import { LifecycleRunRequestSchema, LifecycleMutationSchema } from '@gitspace/protocol-environment';
import { DaemonRequestSchema } from '@gitspace/supervisor/protocol';

const path = z.string().min(1);
export const RuntimeReadArgumentsSchema = z.object({ path, offset: z.number().int().positive().optional(), limit: z.number().int().positive().optional() });
export const RuntimeWriteArgumentsSchema = z.object({ path, content: z.string() });
export const RuntimeEditArgumentsSchema = z.object({ path, edits: z.array(z.object({ oldText: z.string().min(1), newText: z.string() })).min(1) });
export const ApplyPatchArgumentsSchema = z.object({ patch: z.string().min(1) });
export const RuntimeBashArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ command: z.string().min(1), cwd: z.string().optional() });
export const RuntimeFindArgumentsSchema = z.object({ pattern: z.string(), path: z.string().default('.') }).strict();
export const RuntimeGrepArgumentsSchema = RuntimeFindArgumentsSchema.extend({ ...RuntimeDispatchSelectionSchema.shape, glob: z.string().optional() });
export const RuntimeAstGrepArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ pattern: z.string().min(1), path: z.string().default('.'), language: z.string().optional() });
export const RuntimeAstEditArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ ops: z.array(z.object({ pat: z.string().min(1), out: z.string() })).min(1), paths: z.array(path).min(1), language: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/u) });
export const RuntimeAstResolveArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ proposalId: path, action: z.enum(['apply', 'reject']) });
export const RuntimeCodemodeArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ code: z.string() });
export const RuntimeProcArgumentsSchema = z.intersection(z.union(DaemonRequestSchema.options.slice(0, -1)), RuntimeDispatchSelectionSchema);
export const RuntimeAgentsArgumentsSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('spawn'), task: z.string().min(1), name: z.string().optional(), agent: z.string().optional(), background: z.boolean().default(false) }),
  z.object({ op: z.literal('send'), id: path, message: z.string().min(1) }),
  z.object({ op: z.literal('stop'), id: path }),
  z.object({ op: z.enum(['list', 'status']), id: z.string().optional() }),
]);
export const RuntimeJobRunArgumentsSchema = RuntimeDispatchSelectionSchema.extend({ op: z.literal('run'), application: path, args: z.array(z.string()), cwd: z.string().optional(), deadlineAt: z.iso.datetime().optional() }).strict();
export const RuntimeJobControlArgumentsSchema = z.discriminatedUnion('op', [z.object({ op: z.literal('list') }).strict(), z.object({ op: z.enum(['status', 'wait', 'logs', 'cancel']), job: RuntimeJobHandleSchema }).strict()]);
export const RuntimeJobsArgumentsSchema = z.union([RuntimeJobRunArgumentsSchema, RuntimeJobControlArgumentsSchema]);
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
