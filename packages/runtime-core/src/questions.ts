import { AssistantEntry, type ConversationId, type Cursor, type Harness, type Storage, type ToolExecutionResult, type Tx } from '@earendil-works/pi-durable';
import type { JsonValue } from '@earendil-works/chord/json';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { RuntimeApprovalAnswerSchema, RuntimeLifecycleApprovalAnswerSchema, RuntimeTakeoverQuestionSchema, TAKEOVER_ANSWERS, askAnswerParts, questionState, type RuntimeQuestionClosed } from '@gitspace/protocol-runtime';
import { openerAt, piMessageRowId, type AskAnswerer } from '@gitspace/blocks';
import { blockAskQuestionId, requiredBlockAsks } from '@gitspace/protocol/gitspace-ui';
import { BlockAsksDoc, QuestionsDoc, type Question } from './documents.js';
import { turnOpeners } from './transcript-rows.js';
import { withdrawPlan } from './plan.js';
import type { ConversationEvent } from './conversation-lifecycle.js';

/**
 * Questions outlive the calls that ask them (docs/SIMPLIFICATION.md, Questions end the turn). An asking call records its
 * question (`postQuestion`) and ends the agent's turn (`questionPosted`); no call waits on a person, so no restart of the
 * workspace object can cut a waiting call off. The question closes when it is answered or dismissed (`settleQuestion`,
 * which also gives the event the asking conversation hears as its next input), when the person writes to its
 * conversation instead (`closeRepliedQuestions`), or when a person stops or resets its conversation
 * (`closeConversationQuestions`). Only an open question waits on a person and takes an answer.
 */

/** How an open question closes: answered (by a person, or by the project agent for one), or dismissed by the person.
 * `text` replaces what the asking conversation hears (the project agent's batch reports each answer's outcome there). */
export type QuestionClosure = { answer: JsonValue; answeredBy?: AskAnswerer; text?: string } | { dismissed: true };

/** Characters of a question's prompt the event about its answer repeats. */
const PROMPT_SHOWN = 600;
const CLOSED_BECAUSE: Record<RuntimeQuestionClosed['reason'], string> = {
  dismissed: 'the person dismissed it',
  stopped: 'a person stopped or reset the conversation that asked it',
  expired: 'the call that asked it ended before it was answered',
  replied: 'the person wrote in the chat instead of answering it',
};
/** The takeover fields kept; older cards also stored when their call stopped waiting. */
const TakeoverQuestionFields = z.object(RuntimeTakeoverQuestionSchema.shape);

/** Why `question`, which is not open, takes no answer. */
export function questionRefusal(question: Pick<Question, 'id' | 'answeredBy' | 'closed'>): string {
  if (question.closed) return `Question ${question.id} is closed (${CLOSED_BECAUSE[question.closed.reason]}), so it can no longer be answered.`;
  return `Question ${question.id} is already answered${question.answeredBy ? ' (by the project agent)' : ''}; it takes no other answer.`;
}

/** Records the question a call asks, once: a rerun of the call finds it, and one asked before questions recorded when
 * they were asked gets `askedAt` now (`expireLegacyQuestions` then leaves it open). */
export async function postQuestion(tx: Tx, question: Omit<Question, 'askedAt' | 'answer'>): Promise<void> {
  const doc = await tx.doc(QuestionsDoc);
  const existing = doc.items.find(item => item.id === question.id);
  const askedAt = new Date().toISOString();
  if (existing) existing.askedAt ??= askedAt;
  else doc.items.push({ ...question, answer: null, askedAt });
}

/** What an asking call returns: the question is posted, and the round ends the agent's turn (`terminate`). */
export function questionPosted(id: string, what: string): ToolExecutionResult {
  return {
    output: [{ type: 'text', text: `Posted ${what} to the user as question ${id}. Your turn ends here: do not wait or poll for it. The answer arrives as your next message, an event naming question ${id}; if the user dismisses it instead, that message says so. If they write in the chat instead, the question closes unanswered (nothing is approved) and their message is your next input.` }],
    details: { questionId: id },
    control: { terminate: true },
  };
}

/** What a reply ends its turn on asking: the prompt of its first required block ask, or null when it asks nothing. A
 * reply that asks stops its turn for the person, as an asking call does. */
export function replyQuestion(text: string): string | null {
  return requiredBlockAsks(text)[0]?.prompt ?? null;
}

/** Entries one scan for block asks reads. */
const SCAN_ENTRIES = 64;

/**
 * Posts the questions the required asks (`requiredBlockAsks`) of stored replies make, for every reply stored after
 * `BlockAsksDoc.through`, and moves `through` to the newest entry it read, in one commit. A reply is stored in pi's own
 * commit, so this runs after it (from the harness's commit observer) and again when the workspace opens: a reset
 * between the two commits is repaired on the next open. Each question is posted once per message row and element id
 * (`blockAskQuestionId`), under the ID the transcript reader gives that row (`piMessageRowId`), and posting again
 * finds it (`postQuestion`). A failed or aborted reply, and a reply before its conversation's first input (whose row ID
 * depends on the page it is read in), post nothing. The workspace's first open sets `through` to its newest entry.
 */
export async function repairBlockAsks(harness: Harness, storage: Storage): Promise<void> {
  const through = (await harness.snapshot(BlockAsksDoc, BACKGROUND_CONTEXT))?.through ?? 0;
  let newest = through;
  const posts: { entryId: number; question: Omit<Question, 'askedAt' | 'answer'> }[] = [];
  let conversations: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, SCAN_ENTRIES, conversations, BACKGROUND_CONTEXT);
    for (const conversation of page.items) {
      const conversationId = String(conversation.id);
      let openers: readonly number[] | undefined;
      let cursor: Cursor | undefined;
      scan: do {
        const entries = await storage.scanEntries({ conversationId: conversation.id }, SCAN_ENTRIES, cursor, BACKGROUND_CONTEXT);
        for (const entry of entries.items) {
          const entryId = Number(entry.id);
          // Newest first: an entry at or below the last scan ends this conversation's scan.
          if (entryId <= through) break scan;
          newest = Math.max(newest, entryId);
          if (String(entry.conversationId) !== conversationId || !AssistantEntry.is(entry)) continue;
          for (const [index, message] of (entry.model ?? []).entries()) {
            if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') continue;
            for (const [part, content] of message.content.entries()) {
              if (content.type !== 'text') continue;
              const asks = requiredBlockAsks(content.text);
              if (asks.length === 0) continue;
              openers ??= await turnOpeners(storage, conversation.id, BACKGROUND_CONTEXT);
              const opener = openerAt(openers, entryId);
              if (opener === undefined) continue;
              const row = piMessageRowId(conversationId, opener, entryId, index, part);
              for (const ask of asks) posts.push({ entryId, question: { id: blockAskQuestionId(row, ask.id), conversationId, kind: 'ask', prompt: ask.prompt, choices: ask.choices } });
            }
          }
        }
        cursor = entries.next;
      } while (cursor);
    }
    conversations = page.next;
  } while (conversations);
  if (newest === through) return;
  // The posts and the check whether the person wrote after each reply share one commit: a reply the person already
  // wrote after (`BlockAsksDoc.replied`) posts its question closed as replied, never open.
  await harness.commit(async tx => {
    const doc = await tx.doc(BlockAsksDoc);
    const at = new Date().toISOString();
    for (const { entryId, question } of posts) {
      const replied = doc.replied?.[question.conversationId];
      await postQuestion(tx, replied !== undefined && entryId <= replied ? { ...question, closed: { reason: 'replied', at } } : question);
    }
    doc.through = Math.max(doc.through ?? 0, newest);
  }, BACKGROUND_CONTEXT);
}

function shownPrompt(prompt: string): string {
  const flat = prompt.trim();
  return flat.length <= PROMPT_SHOWN ? flat : `${flat.slice(0, PROMPT_SHOWN)}… (${flat.length - PROMPT_SHOWN} more characters)`;
}

/** The scripts and phase a lifecycle approval card names, as its events say them. */
function lifecycleSubject(question: Question): { names: string; phase: string } {
  const card = question.lifecycle;
  if (!card) return { names: 'the scripts', phase: 'the run' };
  return { names: card.scripts.map(script => script.fileName ?? script.label).join(', '), phase: card.phase === 'checks' ? 'the environment checks' : card.phase };
}

/** What the asking conversation hears when `question` is answered with `answer`. */
function answerText(question: Question, answer: JsonValue, answeredBy: AskAnswerer | undefined): string {
  const asked = `Question: ${shownPrompt(question.prompt)}`;
  if (question.kind === 'ask') {
    const parts = askAnswerParts(answer).map(part => [...part.selectedOptions, ...part.customInput?.trim() ? [part.customInput.trim()] : []].join('; ')).filter(Boolean);
    const who = answeredBy ? `The project agent answered your question (question ${question.id}) for ${answeredBy.for ?? 'the user'}, who approved its answer; the user did not write it themself.` : `The user answered your question (question ${question.id}).`;
    return `${who}\n${asked}\nAnswer: ${parts.length > 0 ? parts.join('\n') : JSON.stringify(answer)}`;
  }
  if (question.kind === 'lifecycle-approval') {
    const { names, phase } = lifecycleSubject(question);
    const choice = RuntimeLifecycleApprovalAnswerSchema.safeParse(answer);
    if (choice.success && choice.data !== 'not-now') return `The user approved ${names} for ${choice.data === 'project' ? 'every workspace of the project' : 'this workspace'} (question ${question.id}). Call environment again to run ${phase}.`;
    return `The user did not approve ${names} (Not now) (question ${question.id}), so ${phase} did not run. Continue without it, or tell the user what still needs their approval.`;
  }
  if (question.kind === 'takeover') {
    const tab = question.takeover ? `tab ${question.takeover.targetId} (${question.takeover.title || question.takeover.url}) in ${question.takeover.browser}` : 'the tab';
    if (answer === TAKEOVER_ANSWERS.declined) return `The user declined to take over ${tab} (Not now) (question ${question.id}). Continue without that tab, or tell the user what still needs them.`;
    return `The user handed ${tab} back (question ${question.id}). Observe it again before acting.`;
  }
  const decision = RuntimeApprovalAnswerSchema.safeParse(answer);
  const approved = decision.success && decision.data.approved;
  const note = decision.success && decision.data.note ? `\n${approved ? 'Note' : 'Why'}: ${decision.data.note}` : '';
  // An approval that names no tool is a proposed plan.
  if (!question.tool) return approved
    ? `The user approved your plan (question ${question.id}). It is the plan in effect now.${note}`
    : `The user rejected your plan (question ${question.id}). The plan in effect stays as it was.${note}`;
  return `The user ${approved ? 'approved' : 'rejected'} your request (question ${question.id}).\n${asked}${note}`;
}

/** What the asking conversation hears when the person dismisses `question`. */
function dismissalText(question: Question): string {
  const after = question.kind === 'approval' && !question.tool ? '\nYour proposed plan is withdrawn; the plan in effect stays as it was.'
    : question.kind === 'lifecycle-approval' ? `\n${lifecycleSubject(question).phase} did not run.` : '';
  return `The user dismissed your question (question ${question.id}) without answering it.\nQuestion: ${shownPrompt(question.prompt)}${after}`;
}

/** Closes `question`, which is open, as `closure` in `tx`, and returns the event its conversation (`conversationId`)
 * hears next. A dismissed proposal is withdrawn (`withdrawPlan`); an answered one's plan is the caller's (`answerPlan`). */
export async function settleQuestion(tx: Tx, conversationId: ConversationId, question: Question, closure: QuestionClosure): Promise<ConversationEvent> {
  const at = new Date().toISOString();
  let text: string;
  if ('dismissed' in closure) {
    question.closed = { reason: 'dismissed', at };
    if (question.kind === 'approval') await withdrawPlan(tx, conversationId, question.id);
    text = dismissalText(question);
  } else {
    question.answer = closure.answer;
    question.answeredAt = at;
    if (closure.answeredBy) question.answeredBy = closure.answeredBy;
    text = closure.text ?? answerText(question, closure.answer, closure.answeredBy);
  }
  const sender = question.answeredBy ? { id: 'project-agent', name: `Project agent for ${question.answeredBy.for ?? 'the user'}` } : { id: 'user', name: 'The user' };
  return { conversationId: question.conversationId, requestId: `question-closed:${question.id}`, kind: 'question', sender, text,
    payload: { questionId: question.id, kind: question.kind, state: questionState(question), answer: question.answer, ...(question.answeredBy ? { answeredBy: question.answeredBy } : {}), ...(question.closed ? { closed: question.closed } : {}) } };
}

/** A person stopped or reset these conversations (`String(id)` to id): their open questions close as `stopped`, and a
 * proposal among them is withdrawn. The conversation hears nothing: it is stopped. */
export async function closeConversationQuestions(tx: Tx, conversations: ReadonlyMap<string, ConversationId>): Promise<void> {
  const at = new Date().toISOString();
  for (const question of (await tx.doc(QuestionsDoc)).items) {
    const id = conversations.get(question.conversationId);
    if (id === undefined || questionState(question) !== 'open') continue;
    question.closed = { reason: 'stopped', at };
    if (question.kind === 'approval') await withdrawPlan(tx, id, question.id);
  }
}

/**
 * The person's own input to conversation `conversationId` (their message, or their answer to question `answered`) is
 * their reply to everything it asked: its other open questions close as `replied` in `tx`, the commit that takes the
 * input. The conversation hears that input, not an event per question. Closing approves and runs nothing: a proposed
 * plan stays proposed and unapproved for the agent to revise or propose again, and a lifecycle approval or take-over
 * card is declined. A take-over card whose tab the person holds stays open: their handback ends it. The conversation's
 * newest entry is recorded (`BlockAsksDoc.replied`): a block ask in a reply up to it whose question is not posted yet
 * is posted closed (`repairBlockAsks`). Reads before it writes, so it runs before the input is admitted in `tx`.
 */
export async function closeRepliedQuestions(tx: Tx, conversationId: ConversationId, answered?: string): Promise<void> {
  const latest = await tx.latestEntryId(conversationId);
  const asks = await tx.doc(BlockAsksDoc);
  const at = new Date().toISOString();
  for (const question of (await tx.doc(QuestionsDoc)).items) {
    if (question.conversationId !== String(conversationId) || question.id === answered || questionState(question) !== 'open' || question.takeover?.holder === 'you') continue;
    question.closed = { reason: 'replied', at };
  }
  if (latest !== undefined) asks.replied = { ...asks.replied, [String(conversationId)]: Number(latest) };
}

/**
 * LEGACY: before questions outlived their calls, an asking call held its tool call open until a person answered, and a
 * restart of the workspace object cut it off; cut off restartLimit times, it ended while its question stayed open, and
 * the workspace showed it waiting on a person forever. Such questions have no `askedAt`. Each open one whose asking
 * call (`question:<taskId>`) no longer runs closes as expired; one whose call still runs gets `askedAt` when that call
 * runs again and posts it. Their take-over cards lose the fields that said how long the call waited. Remove once every
 * workspace has opened.
 */
export async function expireLegacyQuestions(harness: Harness): Promise<void> {
  const legacy = (question: Question) => question.askedAt === undefined && ((questionState(question) === 'open' && question.id.startsWith('question:')) || (question.takeover !== undefined && ('until' in question.takeover || 'waiting' in question.takeover)));
  if (!(await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.some(legacy)) return;
  const { tasks } = await harness.inspect(BACKGROUND_CONTEXT);
  const asking = new Set(tasks.flatMap(task => task.state.kind === 'completing' ? [] : [`question:${String(task.record.id)}`]));
  await harness.commit(async tx => {
    const conversations = new Map<string, ConversationId>();
    let cursor: Cursor | undefined;
    do { const page = await tx.scanConversations({}, 128, cursor); for (const record of page.items) conversations.set(String(record.id), record.id); cursor = page.next; } while (cursor);
    const at = new Date().toISOString();
    for (const question of (await tx.doc(QuestionsDoc)).items) {
      if (!legacy(question)) continue;
      if (question.takeover) question.takeover = TakeoverQuestionFields.parse(question.takeover);
      if (questionState(question) !== 'open' || !question.id.startsWith('question:') || asking.has(question.id)) continue;
      question.closed = { reason: 'expired', at };
      const id = conversations.get(question.conversationId);
      if (question.kind === 'approval' && id !== undefined) await withdrawPlan(tx, id, question.id);
    }
  }, BACKGROUND_CONTEXT);
}
