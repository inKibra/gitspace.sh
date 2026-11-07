import { z } from 'zod';
import { LifecyclePhaseSchema, LifecycleRunPhaseSchema } from '@gitspace/protocol-environment';

/** How a person answers a lifecycle approval card: approve the scripts for every workspace of the project, for this
 * workspace only, or not now. */
export const RuntimeLifecycleApprovalAnswerSchema = z.enum(['project', 'workspace', 'not-now']);
export type RuntimeLifecycleApprovalAnswer = z.infer<typeof RuntimeLifecycleApprovalAnswerSchema>;
/** The card's buttons, by the answer each gives. */
export const LIFECYCLE_APPROVAL_CHOICES: Readonly<Record<RuntimeLifecycleApprovalAnswer, string>> = { project: 'Approve for the project', workspace: 'Only this workspace', 'not-now': 'Not now' };
/** One execution a run needs that no approval names: a script file of a phase (`phase`, `fileName`) or an environment
 * check (`fileName` null). `previous` is the newest earlier version of the same file that is approved, with who
 * approved it, when one was found. */
export const RuntimeLifecycleApprovalScriptSchema = z.strictObject({
  hash: z.string().regex(/^sha256:[a-f0-9]{64}$/u), kind: z.enum(['check', 'script']), label: z.string().max(256),
  phase: LifecyclePhaseSchema.nullable(), fileName: z.string().max(512).nullable(), content: z.string().max(131_072),
  previous: z.strictObject({ content: z.string().max(131_072), approvedBy: z.string() }).nullable(),
});
export type RuntimeLifecycleApprovalScript = z.infer<typeof RuntimeLifecycleApprovalScriptSchema>;
/** What an agent's `environment` run waits on: the phase it runs and the executions in it awaiting approval. */
export const RuntimeLifecycleApprovalRequestSchema = z.strictObject({ phase: LifecycleRunPhaseSchema, scripts: z.array(RuntimeLifecycleApprovalScriptSchema).min(1) });
export type RuntimeLifecycleApprovalRequest = z.infer<typeof RuntimeLifecycleApprovalRequestSchema>;
/** A `lifecycle-approval` question: the card on the agent's `environment` call `callId`. Its answer is a
 * `RuntimeLifecycleApprovalAnswer`. */
export const RuntimeLifecycleApprovalQuestionSchema = RuntimeLifecycleApprovalRequestSchema.extend({ callId: z.string().min(1) });
export type RuntimeLifecycleApprovalQuestion = z.infer<typeof RuntimeLifecycleApprovalQuestionSchema>;
