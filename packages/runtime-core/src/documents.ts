import type { RuntimeLifecycleApprovalQuestion, RuntimePlanStep, RuntimeQuestionClosed, RuntimeQuestionTool, RuntimeTakeoverQuestion, RuntimeTodoItem } from '@gitspace/protocol-runtime';
import { defineDoc, type CheckpointInfo } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord/json';
import type { RuntimeAttachment } from '@gitspace/protocol-runtime';
import type { AskAnswerer } from '@gitspace/blocks';
import type { CommentAnchor, StagedComment } from '@gitspace/protocol-runtime/comments';
/** A document stores a complete base after 32 deltas, so a load replays at most 32 changes; with no base, a load
 * replays every change the document ever had. Older revisions stay stored either way. */
export function boundedReplay(_value: unknown, _ops: unknown, info: CheckpointInfo): boolean {
  return info.deltasSinceBase >= 31;
}
export const WorkspaceDoc = defineDoc<{ phase: 'plan' | 'code' | 'review' | 'ship'; instructions: string; goal: string }>({ kind: 'gitspace.workspace', version: 1, scope: 'session', initial: () => ({ phase: 'code', instructions: '', goal: '' }), checkpointWhen: boundedReplay });
export const MachinesDoc = defineDoc<{ attachments: RuntimeAttachment[] }>({ kind: 'gitspace.machines', version: 1, scope: 'session', initial: () => ({ attachments: [] }), checkpointWhen: boundedReplay });
export const TodosDoc = defineDoc<{ items: RuntimeTodoItem[] }>({ kind: 'gitspace.todos', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf', initial: () => ({ items: [] }), checkpointWhen: boundedReplay });
/** A conversation's plan. `text`, `steps`, `status` and `questionId` are its latest proposal's; once that is approved
 * they are the plan in effect, and `revision` counts approvals. While a later proposal waits or after it is rejected,
 * `approved` holds the plan in effect. Records from before plans had steps have no `steps`, `revision` or `approved`. */
export const PlanDoc = defineDoc<{ text: string; status: 'draft' | 'proposed' | 'approved' | 'rejected'; questionId: string | null; steps?: RuntimePlanStep[]; revision?: number; approved?: { text: string; steps: RuntimePlanStep[] } | null }>({ kind: 'gitspace.plan', version: 1, scope: 'conversation', history: 'rewindable', fork: 'asOf', initial: () => ({ text: '', status: 'draft', questionId: null, steps: [], revision: 0, approved: null }), checkpointWhen: boundedReplay });
/** Questions for the user: the agent's `ask`, plan and machine approvals, the project agent's batch of answers
 * (`tool.name` `space_workspace`), ask_takeover cards (`takeover`), and the lifecycle approval cards an `environment`
 * run posts (`lifecycle-approval`). No call waits on one: asking ends the agent's turn, and answering or closing it
 * delivers the conversation's next input (`questions.ts`). `answeredBy`: the project agent answered a plain ask in the
 * person's place; absent, a person answered. `closed`: it closed unanswered and takes no answer. */
export type Question = { id: string; conversationId: string; kind: 'ask' | 'approval' | 'takeover' | 'lifecycle-approval'; prompt: string; choices: string[]; answer: JsonValue | null; askedAt?: string; answeredAt?: string; answeredBy?: AskAnswerer; closed?: RuntimeQuestionClosed; tool?: RuntimeQuestionTool; takeover?: RuntimeTakeoverQuestion; lifecycle?: RuntimeLifecycleApprovalQuestion };
export const QuestionsDoc = defineDoc<{ items: Question[] }>({ kind: 'gitspace.questions', version: 1, scope: 'session', initial: () => ({ items: [] }), checkpointWhen: boundedReplay });
/** The newest entry whose replies' required block asks are posted as questions (`repairBlockAsks`), session-wide; null
 * until the workspace's first open sets it to its newest entry. */
export const BlockAsksDoc = defineDoc<{ through: number | null }>({ kind: 'gitspace.block-asks', version: 1, scope: 'session', initial: () => ({ through: null }), checkpointWhen: boundedReplay });
/** The comments people staged for their next message, oldest first (comments.ts). */
export const StagedCommentsDoc = defineDoc<{ items: StagedComment[] }>({ kind: 'gitspace.staged-comments', version: 1, scope: 'session', initial: () => ({ items: [] }), checkpointWhen: boundedReplay });
/**
 * The comment lookup, derived from the transcript and written only by `repairCommentLookup`: each sent comment's anchor
 * and the person's message row carrying it, and each agent message row with Reply blocks and the comments they answer.
 * `through`: the newest entry read; null until the first scan, which reads every entry. `revision` moves when a
 * comment or a reply joins.
 */
export const CommentLookupDoc = defineDoc<{ through: number | null; revision: number; comments: Record<string, { conversationId: string; message: string; anchor: CommentAnchor }>; replies: Record<string, string[]> }>({ kind: 'gitspace.comment-lookup', version: 1, scope: 'session', initial: () => ({ through: null, revision: 0, comments: {}, replies: {} }), checkpointWhen: boundedReplay });
export const EnvironmentDoc = defineDoc<{ profile: string | null; runs: JsonValue[] }>({ kind: 'gitspace.environment', version: 1, scope: 'session', initial: () => ({ profile: null, runs: [] }), checkpointWhen: boundedReplay });
export const JobsDoc = defineDoc<{ jobs: JsonValue[]; processes: JsonValue[] }>({ kind: 'gitspace.jobs', version: 1, scope: 'session', initial: () => ({ jobs: [], processes: [] }), checkpointWhen: boundedReplay });
export const QaDoc = defineDoc<{ items: JsonValue[] }>({ kind: 'gitspace.qa', version: 1, scope: 'session', initial: () => ({ items: [] }), checkpointWhen: boundedReplay });
export const InferencePinsDoc = defineDoc<{ profileId: string | null; pins: Record<string, JsonValue> }>({ kind: 'gitspace.inference', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ profileId: null, pins: {} }), checkpointWhen: boundedReplay });
/** Automation runs' instructions to this workspace, by request id: each is submitted once and can be withdrawn until it is placed. */
export const AutomationRequestsDoc = defineDoc<{ withdrawnRequests?: string[]; requests: Record<string, { conversationId: string; text: string; withdrawn?: boolean }> }>({ kind: 'gitspace.automation-requests', version: 1, scope: 'session', initial: () => ({ requests: {} }), checkpointWhen: boundedReplay });
