import type { AskBlock } from './model.js';

/**
 * An approval as its card asks it: the decision (Approve or Reject, never a written answer), then an optional note
 * that adds to what was approved or says why it was rejected. The answer is `{ approved, note }`
 * (`RuntimeApprovalAnswerSchema`).
 */
export const APPROVAL_DECISION = 'decision';
export const APPROVAL_NOTE = 'note';
export const APPROVE = 'Approve';
export const REJECT = 'Reject';

/** A `propose_plan` call's card: the plan, in Markdown, is the decision's question. */
export function planQuestions(plan: string): AskBlock['questions'] {
  return [
    { id: APPROVAL_DECISION, prompt: plan, written: false, options: [
      { id: APPROVE, title: APPROVE, description: 'The workspace moves to Code and the agent implements the plan.' },
      { id: REJECT, title: REJECT, description: 'The workspace stays in Plan and the agent revises it.' },
    ] },
    { id: APPROVAL_NOTE, prompt: 'Anything to add?', optional: true },
  ];
}
