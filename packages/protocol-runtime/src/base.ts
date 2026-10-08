import { RuntimeExecutionObservationSchema } from './scheduling.js';
import { z } from 'zod';
import { RuntimeBrowserAuthorizationSchema, RuntimeBrowserApprovalCardSchema } from './browser.js';
import { GitLfsRestoredSchema } from '@gitspace/protocol-workspace';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';

export const RuntimeProjectIdSchema = z.string().min(1).brand<'ProjectId'>();
export const RuntimeWorkspaceIdSchema = z.string().min(1).brand<'WorkspaceId'>();
export const RuntimeMachineIdSchema = z.string().min(1).brand<'MachineId'>();
export const RuntimeJsonSchema = z.json();
const identity = { projectId: RuntimeProjectIdSchema, workspaceId: RuntimeWorkspaceIdSchema };
export const RuntimeIdentitySchema = z.object(identity);
export const RuntimeContentSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('text'), text: z.string() }), z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() })]);
export const RuntimeToolDispatchSchema = z.object({ version: z.literal(1), ...identity, machineId: RuntimeMachineIdSchema, attachmentId: z.string().min(1), generation: z.number().int().nonnegative(), conversationId: z.string().min(1), conversationKind: z.enum(['main', 'subagent']), taskId: z.string().min(1), requestId: z.string().min(1), attemptId: z.string().min(1), parentAttemptId: z.string().min(1).optional(), browserAuthorization: RuntimeBrowserAuthorizationSchema.optional(), snapshot: RuntimeGitCheckpointSchema.optional(), tool: z.string().min(1), args: RuntimeJsonSchema, deadlineAt: z.iso.datetime(), replay: z.enum(['safe', 'unsafe']) }).strict();
export const RuntimeBrowserExecutionSchema = z.strictObject({ pairingId: z.string().uuid(), name: z.string().min(1).max(128) });
export type RuntimeBrowserExecution = z.infer<typeof RuntimeBrowserExecutionSchema>;
const result = { requestId: z.string().min(1), attemptId: z.string().min(1), content: z.array(RuntimeContentSchema), browser: RuntimeBrowserExecutionSchema.optional() };
export const RuntimeToolResultSchema = z.discriminatedUnion('status', [z.object({ ...result, status: z.literal('completed') }), z.object({ ...result, status: z.literal('failed'), error: z.object({ code: z.string(), message: z.string() }) }), z.object({ ...result, status: z.literal('interrupted') })]);
export const RuntimeCheckoutSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('shared'), branch: z.string().min(1) }), z.object({ kind: z.literal('snapshot'), commit: z.string().regex(/^[a-f0-9]{40,64}$/) }), z.object({ kind: z.literal('branch'), branch: z.string().min(1), commit: z.string().regex(/^[a-f0-9]{40,64}$/) })]);
export const RuntimeCacheObservationSchema = z.object({
  state: z.enum(['setup', 'live', 'paused', 'reclaimed', 'draining']),
  platform: z.string().nullable(),
  activity: z.array(z.object({ reason: z.enum(['command', 'service', 'watcher', 'proc', 'terminal', 'local-work', 'grace', 'setup', 'sync']), name: z.string() })),
  lastActivityAt: z.iso.datetime(), pausedAt: z.iso.datetime().nullable(), reclaimAt: z.iso.datetime().nullable(), lastSyncAt: z.iso.datetime().nullable(),
  localWorkOptIn: z.boolean(),
  reclaimBlocked: z.string().nullable().default(null),
  setup: z.array(z.object({ phase: z.enum(['machine/prepare', 'checks', 'workspace/materialize']), state: z.enum(['pending', 'waiting-for-approval', 'running', 'succeeded', 'failed']), runId: z.string().nullable() })),
});
export const RuntimeCachePolicySchema = z.object({ idleGraceSeconds: z.number().int().nonnegative().default(900), reclaimSeconds: z.number().int().nonnegative().default(86400) });
export const RuntimeCacheActionSchema = z.object({ requestId: z.string().min(1), action: z.enum(['setup', 'reclaim']), status: z.enum(['requested', 'running', 'completed', 'failed']), error: z.string().nullable(), discardHeldBack: z.boolean().optional() });
export type RuntimeCacheObservation = z.infer<typeof RuntimeCacheObservationSchema>;
export type RuntimeCachePolicy = z.infer<typeof RuntimeCachePolicySchema>;
export type RuntimeCacheAction = z.infer<typeof RuntimeCacheActionSchema>;
export const RuntimeAttachmentSchema = z.object({ ...identity, attachmentId: z.string().min(1), machineId: RuntimeMachineIdSchema, generation: z.number().int().nonnegative(), ownershipGeneration: z.number().int().nonnegative().optional(), role: z.enum(['cache', 'runner', 'delegate']), checkout: RuntimeCheckoutSchema, state: z.enum(['attaching', 'ready', 'draining', 'detached', 'lost']), capabilities: z.array(z.string()), updatedAt: z.iso.datetime(), heartbeatAt: z.iso.datetime().nullable().default(null), cache: RuntimeCacheObservationSchema.optional(), cacheAction: RuntimeCacheActionSchema.optional(), detachRequest: z.object({ discardHeldBack: z.boolean().optional() }).optional(), executionObservation: RuntimeExecutionObservationSchema.optional(), lfsRestored: z.array(GitLfsRestoredSchema).optional() });
export const RuntimeMessageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant', 'tool', 'system']), content: z.array(RuntimeContentSchema), createdAt: z.iso.datetime() });
export const RuntimeConversationSchema = z.object({ id: z.string(), parentId: z.string().nullable(), title: z.string(), status: z.enum(['idle', 'running', 'waiting', 'failed']), error: z.string().optional(), messages: z.array(RuntimeMessageSchema) });
export const RuntimeTaskSchema = z.object({ id: z.string(), kind: z.string(), conversationId: z.string().nullable(), parentId: z.string().nullable(), background: z.boolean(), state: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'interrupted']), machineId: RuntimeMachineIdSchema.nullable(), result: RuntimeJsonSchema.nullable() });
export const RuntimeQuestionSchema = z.object({ id: z.string(), conversationId: z.string(), kind: z.enum(['ask', 'approval']), prompt: z.string(), choices: z.array(z.string()), answer: RuntimeJsonSchema.nullable(), browser: RuntimeBrowserApprovalCardSchema.optional() });
export const RuntimeSnapshotSchema = z.object({ version: z.literal(1), ...identity, cursor: z.number().int().nonnegative(), conversations: z.array(RuntimeConversationSchema), tasks: z.array(RuntimeTaskSchema), attachments: z.array(RuntimeAttachmentSchema), questions: z.array(RuntimeQuestionSchema), documents: z.record(z.string(), RuntimeJsonSchema) });
export const RuntimeSnapshotInputSchema = RuntimeIdentitySchema;
export const RuntimeSubmitInputSchema = z.object({ ...identity, conversationId: z.string().optional(), requestId: z.string().min(1), text: z.string().min(1), draftRevision: z.number().int().nonnegative().optional() });
export const RuntimeCancelInputSchema = z.object({ ...identity, conversationId: z.string() });
export const RuntimeAnswerInputSchema = z.object({ ...identity, questionId: z.string(), answer: RuntimeJsonSchema, expectedBrowserPreparationId: z.string().optional() });
export const RuntimeWatchInputSchema = z.object({ ...identity, after: z.number().int().nonnegative().nullable() });
const segment = z.union([z.string().refine(value => !['__proto__', 'prototype', 'constructor'].includes(value)), z.number().int().nonnegative()]);
const path = z.array(segment);
const nonemptyPath = z.tuple([segment]).rest(segment);
export const RuntimeDeltaOpSchema = z.union([z.tuple([z.literal('r'), RuntimeJsonSchema]), z.tuple([z.literal('s'), nonemptyPath, RuntimeJsonSchema]), z.tuple([z.literal('d'), nonemptyPath]), z.tuple([z.literal('a'), nonemptyPath, z.string()]), z.tuple([z.literal('t'), nonemptyPath, z.number().int().nonnegative()]), z.tuple([z.literal('p'), path, z.number().int().nonnegative(), z.number().int().nonnegative(), z.array(RuntimeJsonSchema)]), z.tuple([z.literal('m'), path, z.array(z.number().int().nonnegative())])]);
export const RuntimeWatchEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('snapshot'), snapshot: RuntimeSnapshotSchema }), z.object({ type: z.literal('reset'), snapshot: RuntimeSnapshotSchema, reason: z.enum(['cursor-expired', 'cursor-ahead', 'slow-consumer']) }), z.object({ type: z.literal('delta'), baseCursor: z.number().int().nonnegative(), cursor: z.number().int().positive(), ops: z.array(RuntimeDeltaOpSchema) })]);
export const RuntimeActionResultSchema = z.object({ accepted: z.literal(true), cursor: z.number().int().nonnegative(), conversationId: z.string().optional() });
export const RuntimeAttachInputSchema = z.object({ ...identity, machineId: RuntimeMachineIdSchema, generation: z.number().int().nonnegative(), ownershipGeneration: z.number().int().nonnegative().optional(), role: RuntimeAttachmentSchema.shape.role, checkout: RuntimeCheckoutSchema, capabilities: z.array(z.string()) });
export const RuntimeAttachResultSchema = z.object({ attachment: RuntimeAttachmentSchema, executionSecret: z.string().min(1) });
export type RuntimeToolDispatch = z.infer<typeof RuntimeToolDispatchSchema>;
export type RuntimeToolResult = z.infer<typeof RuntimeToolResultSchema>;
export type RuntimeAttachment = z.infer<typeof RuntimeAttachmentSchema>;
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
export type RuntimeWatchEvent = z.infer<typeof RuntimeWatchEventSchema>;
export type RuntimeSubmitInput = z.infer<typeof RuntimeSubmitInputSchema>;
export type RuntimeCancelInput = z.infer<typeof RuntimeCancelInputSchema>;
export type RuntimeAnswerInput = z.infer<typeof RuntimeAnswerInputSchema>;
export type RuntimeWatchInput = z.infer<typeof RuntimeWatchInputSchema>;
export type RuntimeAttachInput = z.infer<typeof RuntimeAttachInputSchema>;
