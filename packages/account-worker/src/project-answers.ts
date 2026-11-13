import { z } from 'zod';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { APPROVE, REJECT } from '@gitspace/blocks';
import { postQuestion } from '@gitspace/runtime-core';
import type { RuntimeApprovalAnswer } from '@gitspace/protocol-runtime';
import { PendingAskAnswerSchema, type PendingAskAnswer } from '@gitspace/protocol-runtime/session-controls';
import type { RuntimeProjectAnswer } from '@gitspace/protocol/inspector-contract';
import type { ProjectAnswerOutcome, ProjectQuestion, WorkspaceRuntime } from '@gitspace/runtime-workspace-do';

/**
 * The project agent answers workspaces' plain questions only with the person's permission, one approval card per batch
 * (`space_workspace answer`). The card is an `approval` question in the project agent's own conversation whose
 * `tool.args` keep the batch; nothing reaches a workspace before the person approves it. Approved, each answer goes to
 * its workspace, answered by the project agent for that person, while its question is still open; the outcome of each
 * is what the project agent hears when the card closes. Rejected, nothing is sent.
 */

/** The batch a card keeps: each answer with the workspace and question it names, as the card showed them. */
const ProjectAnswersCardSchema = z.object({ method: z.literal('answer'), answers: z.array(z.object({ workspaceId: z.string(), workspace: z.string(), questionId: z.string(), question: z.string(), answers: z.array(PendingAskAnswerSchema) })) });
/** Characters of a question the card repeats. */
const QUESTION_SHOWN = 300;

/**
 * Checks each proposed answer against the open questions of its workspace (`workspace` reads them) and posts one approval
 * card listing them in the project agent's conversation. A string that is one of the question's choices selects it,
 * any other string is written as the answer; a list selects several choices. The card's id names the call's attempt,
 * so a retried call posts it once. Nothing is sent to any workspace.
 */
export async function proposeProjectAnswers(input: { runtime: WorkspaceRuntime; conversationId: string; attemptId: string; answers: readonly RuntimeProjectAnswer[]; workspace(id: string): Promise<{ name: string; questions: ProjectQuestion[] }> }): Promise<{ questionId: string; text: string }> {
  const seen = new Set<string>();
  const batch: z.infer<typeof ProjectAnswersCardSchema>['answers'] = [];
  const lines: string[] = [];
  for (const proposed of input.answers) {
    const key = `${proposed.workspaceId}\n${proposed.questionId}`;
    if (seen.has(key)) throw new Error(`Question ${proposed.questionId} of workspace ${proposed.workspaceId} is answered twice in this batch; send one answer per question`);
    seen.add(key);
    const { name, questions } = await input.workspace(proposed.workspaceId);
    const question = questions.find(item => item.id === proposed.questionId);
    if (!question) throw new Error(`Question ${proposed.questionId} is not open in workspace ${name}; space_workspace questions { workspaceId: "${proposed.workspaceId}" } lists the open ones`);
    if (!question.answerable) throw new Error(`Question ${proposed.questionId} in workspace ${name} is a ${question.kind}. ${question.why ?? ''} The project agent answers only plain questions (ask).`);
    let answer: PendingAskAnswer;
    if (typeof proposed.answer === 'string') answer = question.choices.includes(proposed.answer) ? { id: question.id, selectedOptions: [proposed.answer], customInput: null } : { id: question.id, selectedOptions: [], customInput: proposed.answer };
    else {
      const unknown = proposed.answer.filter(choice => !question.choices.includes(choice));
      if (unknown.length > 0) throw new Error(`A list picks choices of question ${question.id} in workspace ${name}, and ${unknown.join(', ')} ${unknown.length === 1 ? 'is not one' : 'are not'}: its choices are ${question.choices.join(', ') || 'none'}. Send your own words as one string instead.`);
      answer = { id: question.id, selectedOptions: [...proposed.answer], customInput: null };
    }
    batch.push({ workspaceId: proposed.workspaceId, workspace: name, questionId: question.id, question: question.prompt, answers: [answer] });
    const asked = question.prompt.trim();
    lines.push(`${batch.length}. ${name}: ${asked.length <= QUESTION_SHOWN ? asked : `${asked.slice(0, QUESTION_SHOWN)}…`}\n   Answer: ${[...answer.selectedOptions, ...answer.customInput ? [answer.customInput] : []].join('; ')}`);
  }
  const prompt = `The project agent asks to answer ${batch.length === 1 ? 'this question' : `these ${batch.length} questions`} for you:\n${lines.join('\n')}\nApprove sends ${batch.length === 1 ? 'this answer' : 'these answers'} in your place; Reject sends nothing.`;
  const id = `project-answers:${input.attemptId}`;
  await input.runtime.harness.commit(tx => postQuestion(tx, { id, conversationId: input.conversationId, kind: 'approval', prompt, choices: [APPROVE, REJECT], tool: { name: 'space_workspace', args: { method: 'answer', answers: batch.map(item => ({ ...item, answers: item.answers.map(part => ({ id: part.id, selectedOptions: [...part.selectedOptions], customInput: part.customInput })) })) } } }), BACKGROUND_CONTEXT);
  return { questionId: id, text: `Posted one approval card listing ${batch.length === 1 ? 'this answer' : `these ${batch.length} answers`} as question ${id}. Nothing is sent until the user approves it, and your turn ends here: do not wait or poll. Your next message is the outcome of each answer (delivered, question already closed, or failed), or that they rejected the card and nothing was sent.` };
}

/**
 * Settles a batch card the person decided (`card` is its question's `tool.args`): approved, each answer goes to its
 * workspace (`deliver`) as the project agent's answer for `person`; rejected, nothing is sent. Returns what the project
 * agent hears as its next input: the outcome of each answer, so it reports a failure instead of claiming success.
 */
export async function settleProjectAnswers(input: { questionId: string; card: unknown; decision: RuntimeApprovalAnswer; person: string; deliver(workspaceId: string, answer: { questionId: string; answers: PendingAskAnswer[]; for: string }): Promise<ProjectAnswerOutcome> }): Promise<string> {
  const note = input.decision.note ? `\nTheir note: ${input.decision.note}` : '';
  if (!input.decision.approved) return `The user rejected your proposed answers (question ${input.questionId}); nothing was sent.${note}`;
  const batch = ProjectAnswersCardSchema.parse(input.card).answers;
  const lines: string[] = [];
  for (const item of batch) {
    const named = `${item.workspace} (${item.workspaceId}), question ${item.questionId}`;
    try {
      const outcome = await input.deliver(item.workspaceId, { questionId: item.questionId, answers: item.answers, for: input.person });
      lines.push(outcome.delivered ? `- ${named}: delivered` : `- ${named}: not delivered, the question had already closed. ${outcome.reason}`);
    } catch (error) {
      lines.push(`- ${named}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return `The user approved your proposed answers (question ${input.questionId}); each went as the project agent's answer for ${input.person}:\n${lines.join('\n')}${note}`;
}
