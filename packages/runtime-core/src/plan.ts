import type { ConversationId, Tx } from '@earendil-works/pi-durable';
import type { RuntimePlanStep, RuntimeTodoItem } from '@gitspace/protocol-runtime';
import { PlanDoc, TodosDoc } from './documents.js';

/** A plan decision for the workspace journal: the person's approval or rejection of a proposed plan, and their note. */
export type PlanDecision = { conversationId: string; title: string; body: string; decisions: string[] };

/** The todo list a plan loads: each step, linked to it by `planStep`, with the step's status. */
export function planTodos(steps: readonly RuntimePlanStep[]): RuntimeTodoItem[] {
  return steps.map(step => ({ id: step.id, text: step.title, status: step.status, planStep: step.id }));
}

/** Settles the answer to a conversation's plan question. Approval makes the proposal the plan in effect (revision + 1),
 * marks completed each step whose id the previous plan in effect completed, and loads the conversation's todo list
 * from its steps. Rejection leaves the plan in effect as it was. Null when `questionId` is not the plan's latest
 * proposal. */
export async function answerPlan(tx: Tx, conversationId: ConversationId, questionId: string, answer: { approved: boolean; note: string | null }): Promise<PlanDecision | null> {
  const plan = await tx.doc(PlanDoc, conversationId);
  if (plan.questionId !== questionId) return null;
  const body = answer.note ?? '';
  if (!answer.approved) {
    plan.status = 'rejected';
    return { conversationId: String(conversationId), title: 'Rejected the proposed plan', body, decisions: [] };
  }
  const completed = new Set((plan.approved?.steps ?? []).flatMap(step => step.status === 'completed' ? [step.id] : []));
  const steps = plan.steps ?? [];
  for (const step of steps) if (completed.has(step.id)) step.status = 'completed';
  plan.status = 'approved';
  plan.revision = (plan.revision ?? 0) + 1;
  plan.approved = null;
  // A proposal from before plans had steps leaves the todo list as the agent set it.
  if (steps.length > 0) (await tx.doc(TodosDoc, conversationId)).items = planTodos(steps);
  return { conversationId: String(conversationId), title: `Approved plan revision ${plan.revision}`, body, decisions: steps.map(step => step.title) };
}
