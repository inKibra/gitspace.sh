import { RuntimeExecutionObservationSchema } from './scheduling.js';
import { z } from 'zod';
import { RuntimeBrowserAuthorizationSchema } from './browser.js';
import { GitLfsRestoredSchema } from '@gitspace/protocol-workspace';
import { RuntimeGitCheckpointSchema } from './git-checkpoint.js';
import { RuntimeTakeoverQuestionSchema } from './browser-takeover.js';
import { RuntimeLifecycleApprovalQuestionSchema } from './lifecycle-approval.js';

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
/** A process control's failure code when the process's machine has no attachment left in its workspace: the control
 * cannot reach the process, which may still run there. */
export const PROCESS_MACHINE_DETACHED = 'machine_detached';
export const RuntimeCheckoutSchema = z.object({ kind: z.literal('shared'), branch: z.string().min(1) });
export const RuntimeCacheObservationSchema = z.object({
  state: z.enum(['setup', 'live']),
  platform: z.string().nullable(),
  lastSyncAt: z.iso.datetime().nullable(),
  setup: z.array(z.object({ phase: z.enum(['machine/prepare', 'checks', 'workspace/materialize']), state: z.enum(['pending', 'waiting-for-approval', 'running', 'succeeded', 'failed']), runId: z.string().nullable(), error: z.string().max(2000).nullable().default(null) })),
  /** Local changes the machine has not sent yet; `null` until the machine reports it. */
  unsent: z.number().int().nonnegative().nullable().default(null),
  syncProblem: z.string().max(2000).nullable().default(null),
});
export type RuntimeCacheObservation = z.infer<typeof RuntimeCacheObservationSchema>;
/** The last failure of a machine-side operation, recorded on the attachment it affected. */
export const RuntimeAttachmentFailureSchema = z.object({ operation: z.enum(['setup', 'materialize', 'sync', 'publish']), message: z.string().max(2000), at: z.iso.datetime() });
export type RuntimeAttachmentFailure = z.infer<typeof RuntimeAttachmentFailureSchema>;
export const RuntimeAttachmentSchema = z.object({ ...identity, attachmentId: z.string().min(1), machineId: RuntimeMachineIdSchema, generation: z.number().int().nonnegative(), checkout: RuntimeCheckoutSchema, state: z.enum(['attaching', 'ready', 'detached']), capabilities: z.array(z.string()), updatedAt: z.iso.datetime(), /** The machine holds a live relay connection; relay presence, never a report, sets it. */ online: z.boolean().default(false), failure: RuntimeAttachmentFailureSchema.nullable().default(null), cache: RuntimeCacheObservationSchema.optional(), executionObservation: RuntimeExecutionObservationSchema.optional(), lfsRestored: z.array(GitLfsRestoredSchema).optional() });
export const RuntimeMessageSchema = z.object({ id: z.string(), role: z.enum(['user', 'assistant', 'tool', 'system']), content: z.array(RuntimeContentSchema), createdAt: z.iso.datetime() });
export const RuntimeConversationSchema = z.object({ id: z.string(), parentId: z.string().nullable(), title: z.string(), status: z.enum(['idle', 'running', 'waiting', 'failed']), error: z.string().optional(), messages: z.array(RuntimeMessageSchema) });
export const RuntimeTaskSchema = z.object({ id: z.string(), kind: z.string(), conversationId: z.string().nullable(), parentId: z.string().nullable(), background: z.boolean(), state: z.enum(['pending', 'running', 'waiting', 'completed', 'failed', 'interrupted']), machineId: RuntimeMachineIdSchema.nullable(), result: RuntimeJsonSchema.nullable() });
/** A machine-attach approval names the machine it attaches; a `takeover` question is an ask_takeover card; a
 * `lifecycle-approval` question is the card an agent's `environment` run waits on. */
export const RuntimeQuestionToolSchema = z.object({ name: z.string(), args: RuntimeJsonSchema });
export type RuntimeQuestionTool = z.infer<typeof RuntimeQuestionToolSchema>;
export const RuntimeQuestionSchema = z.object({ id: z.string(), conversationId: z.string(), kind: z.enum(['ask', 'approval', 'takeover', 'lifecycle-approval']), prompt: z.string(), choices: z.array(z.string()), answer: RuntimeJsonSchema.nullable(), tool: RuntimeQuestionToolSchema.optional(), takeover: RuntimeTakeoverQuestionSchema.optional(), lifecycle: RuntimeLifecycleApprovalQuestionSchema.optional() });
export type RuntimeQuestion = z.infer<typeof RuntimeQuestionSchema>;
export const RuntimeSnapshotSchema = z.object({ version: z.literal(1), ...identity, cursor: z.number().int().nonnegative(), conversations: z.array(RuntimeConversationSchema), tasks: z.array(RuntimeTaskSchema), attachments: z.array(RuntimeAttachmentSchema), questions: z.array(RuntimeQuestionSchema), documents: z.record(z.string(), RuntimeJsonSchema) });
export const RuntimeSnapshotInputSchema = RuntimeIdentitySchema;
/** `whenBusy` while a turn runs: `followUp` (the default) waits for it to end; `steer` joins it at its next tool boundary. */
export const RuntimeSubmitInputSchema = z.object({ ...identity, conversationId: z.string().optional(), requestId: z.string().min(1), text: z.string().min(1), whenBusy: z.enum(['steer', 'followUp']).optional(), draftRevision: z.number().int().nonnegative().optional(), draftText: z.string().optional() });
export const RuntimeCancelInputSchema = z.object({ ...identity, conversationId: z.string() });
export const RuntimeAnswerInputSchema = z.object({ ...identity, questionId: z.string(), answer: RuntimeJsonSchema });
/** The answer to an `approval` question (a proposed plan, a machine-attach request): the decision, and what the person
 * added to it or why they rejected it. */
export const RuntimeApprovalAnswerSchema = z.strictObject({ approved: z.boolean(), note: z.string().min(1).nullable() });
const RuntimeWorkStatusSchema = z.enum(['pending', 'active', 'completed']);
/** A step of a conversation's plan. Its `status` changes only through a todo item that names it (`planStep`). */
export const RuntimePlanStepSchema = z.object({
  id: z.string().trim().min(1).max(64).describe('The step\'s id, unique in the plan, at most 64 characters; a revised plan keeps completed steps by id.'), title: z.string().trim().min(1).max(512).describe('What the step does, in one line.'), detail: z.string().max(32_768).describe('How, in Markdown; a gitspace-ui, svg or mermaid block in it must be valid.'),
  where: z.array(z.string().min(1).max(1024)).max(64).describe('Files or areas the step touches.'), requirementIds: z.array(z.string().min(1).max(128)).max(64).describe('Goal requirements the step advances.'), status: RuntimeWorkStatusSchema.describe('pending, active or completed; set by a todo item naming the step.'),
});
export type RuntimePlanStep = z.infer<typeof RuntimePlanStepSchema>;
/** `propose_plan`: `prompt` is the plan's Markdown summary on the approval card; `steps` become the plan once approved. */
export const RuntimeProposePlanArgumentsSchema = z.object({
  prompt: z.string().describe('The plan\'s summary in Markdown, shown on the approval card.'), choices: z.array(z.string()).describe('The card\'s buttons, such as Approve and Reject.'),
  steps: z.array(RuntimePlanStepSchema.omit({ status: true }).extend({ where: RuntimePlanStepSchema.shape.where.default([]), requirementIds: RuntimePlanStepSchema.shape.requirementIds.default([]) })).min(1).max(64)
    .superRefine((steps, issues) => {
      const seen = new Set<string>();
      for (const [index, step] of steps.entries()) {
        if (seen.has(step.id)) issues.addIssue({ code: 'custom', path: [index, 'id'], message: `Step id ${step.id} is used by an earlier step` });
        seen.add(step.id);
      }
    }).describe('The plan\'s steps, at most 64; once approved they load into the todo list.'),
});
/** One item of a conversation's todo list; `planStep` names the plan step the item's status sets. */
export const RuntimeTodoItemSchema = z.object({ id: z.string().describe('The item\'s id, unique in the list.'), text: z.string().describe('What to do.'), status: RuntimeWorkStatusSchema.describe('pending, active or completed.'), planStep: z.string().min(1).optional().describe('The approved plan step this item tracks: its status becomes the step\'s.') });
export type RuntimeTodoItem = z.infer<typeof RuntimeTodoItemSchema>;
/** `todo`: `items` replaces the list; `from: 'plan'` loads the approved plan's steps. */
export const RuntimeTodoArgumentsSchema = z.union([z.strictObject({ items: z.array(RuntimeTodoItemSchema).describe('The whole new list; it replaces the old one.') }), z.strictObject({ from: z.literal('plan').describe('Load the approved plan\'s steps as the list.') })]);
export const RuntimeWatchInputSchema = z.object({ ...identity, after: z.number().int().nonnegative().nullable() });
const segment = z.union([z.string().refine(value => !['__proto__', 'prototype', 'constructor'].includes(value)), z.number().int().nonnegative()]);
const path = z.array(segment);
const nonemptyPath = z.tuple([segment]).rest(segment);
export const RuntimeDeltaOpSchema = z.union([z.tuple([z.literal('r'), RuntimeJsonSchema]), z.tuple([z.literal('s'), nonemptyPath, RuntimeJsonSchema]), z.tuple([z.literal('d'), nonemptyPath]), z.tuple([z.literal('a'), nonemptyPath, z.string()]), z.tuple([z.literal('t'), nonemptyPath, z.number().int().nonnegative()]), z.tuple([z.literal('p'), path, z.number().int().nonnegative(), z.number().int().nonnegative(), z.array(RuntimeJsonSchema)]), z.tuple([z.literal('m'), path, z.array(z.number().int().nonnegative())])]);
export const RuntimeWatchEventSchema = z.discriminatedUnion('type', [z.object({ type: z.literal('snapshot'), snapshot: RuntimeSnapshotSchema }), z.object({ type: z.literal('reset'), snapshot: RuntimeSnapshotSchema, reason: z.enum(['cursor-expired', 'cursor-ahead']) }), z.object({ type: z.literal('delta'), baseCursor: z.number().int().nonnegative(), cursor: z.number().int().positive(), ops: z.array(RuntimeDeltaOpSchema) })]);
/** Most deltas one `runtime.watch` read returns; a reader further behind receives a reset instead. */
export const RUNTIME_WATCH_EVENT_LIMIT = 256;
/** The events newer than a reader's cursor: a snapshot, a reset, or the contiguous deltas after it, oldest first. */
export const RuntimeWatchEventsSchema = z.array(RuntimeWatchEventSchema).max(RUNTIME_WATCH_EVENT_LIMIT);
export const RuntimeActionResultSchema = z.object({ accepted: z.literal(true), cursor: z.number().int().nonnegative(), conversationId: z.string().optional() });
export const RuntimeAttachInputSchema = z.object({ ...identity, machineId: RuntimeMachineIdSchema, generation: z.number().int().nonnegative(), checkout: RuntimeCheckoutSchema, capabilities: z.array(z.string()) });
export const RuntimeAttachResultSchema = z.object({ attachment: RuntimeAttachmentSchema, executionSecret: z.string().min(1) });
export type RuntimeToolDispatch = z.infer<typeof RuntimeToolDispatchSchema>;
export type RuntimeToolResult = z.infer<typeof RuntimeToolResultSchema>;
export type RuntimeAttachment = z.infer<typeof RuntimeAttachmentSchema>;
export type RuntimeSnapshot = z.infer<typeof RuntimeSnapshotSchema>;
export type RuntimeWatchEvent = z.infer<typeof RuntimeWatchEventSchema>;
export type RuntimeSubmitInput = z.infer<typeof RuntimeSubmitInputSchema>;
export type RuntimeCancelInput = z.infer<typeof RuntimeCancelInputSchema>;
export type RuntimeAnswerInput = z.infer<typeof RuntimeAnswerInputSchema>;
export type RuntimeApprovalAnswer = z.infer<typeof RuntimeApprovalAnswerSchema>;
export type RuntimeWatchInput = z.infer<typeof RuntimeWatchInputSchema>;
export type RuntimeAttachInput = z.infer<typeof RuntimeAttachInputSchema>;
