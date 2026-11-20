import type { Context } from '@earendil-works/chord/context';
import type { Conversation, EntryId, Harness, Storage, SubmissionRecord } from '@earendil-works/pi-durable';
import { openerAt, piSessionId, providerErrorText, turnRowId, PI_ENTRY_ORDINALS } from '@gitspace/blocks';
import { questionState } from '@gitspace/protocol-runtime';
import type { RuntimeRun } from '@gitspace/protocol-runtime/session-controls';
import { QuestionsDoc, type Question } from './documents.js';
import { transcriptInputs } from './transcript-rows.js';

/** Why an input ended without an answer, by pi's reason, as the chat says it; a reason missing here is said as it is. */
export const UNANSWERED_INPUT: Record<string, string> = { aborted: 'it was stopped before it finished', reset: 'its context was reset before it answered', no_model: 'no model was available', withdrawn: 'it was withdrawn before it started' };
/** pi's reasons for an input a person stopped while it ran (Stop) or took back before it ran. */
const STOPPED: Record<string, true> = { aborted: true, withdrawn: true };

/** The text parts of an entry's assistant messages, joined. */
async function replyText(storage: Storage, conversation: Conversation, entry: EntryId, context: Context): Promise<string> {
  const record = (await storage.entry(conversation.id, entry, context))?.entry;
  return (record?.model ?? []).flatMap(message => message.role === 'assistant' ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n').trim();
}

/** When the input the conversation took with `requestId` was written (its first message's timestamp, ms); undefined
 * for an input without a request id, or one not placed. */
async function inputTime(storage: Storage, conversation: Conversation, requestId: string | undefined, context: Context): Promise<number | undefined> {
  const record = requestId === undefined ? undefined : await storage.submissionByRequest(conversation.id, requestId, context);
  const message = record?.type === 'input' && record.entry !== undefined ? (await storage.entry(conversation.id, record.entry, context))?.entry.model?.[0] : undefined;
  return message && 'timestamp' in message ? message.timestamp : undefined;
}

/**
 * What became of the input `target` took with `requestId` (`RuntimeRun`). Questions end the turn that asks them, and an
 * answered or dismissed question's event is its conversation's next input (`question-closed:<id>`, `settleQuestion`), so
 * a run goes on through the turns that the answers to its turns' questions start. A turn's questions are the block asks
 * of its replies (their ids name the turn, `blockAskQuestionId`) and the questions its tools posted, asked between its
 * input and the conversation's next one.
 */
export async function runOf(harness: Harness, storage: Storage, target: Conversation, requestId: string, context: Context): Promise<RuntimeRun> {
  const conversationId = String(target.id);
  const questions = ((await harness.snapshot(QuestionsDoc, context))?.items ?? []).filter(question => question.conversationId === conversationId);
  const blockAsks = `block-ask:${piSessionId(conversationId)}:turn:`;
  let inputs: { openers: number[]; requests: Record<string, string> } | undefined;
  /** Questions the run's turns asked that are still open, newest last. */
  const waiting: Question[] = [];
  let current = requestId;
  // Each step follows the event of a distinct closed question, so the walk ends.
  for (let step = 0; step <= questions.length; step++) {
    const record: SubmissionRecord | undefined = await storage.submissionByRequest(target.id, current, context);
    const run = { conversationId, requestId: current, text: null, question: null };
    if (record?.type !== 'input') return { ...run, state: step === 0 ? 'missing' : 'queued' };
    if (record.status === 'queued') return { ...run, state: 'queued' };
    if (record.status === 'placed') return { ...run, state: 'running' };
    if (record.status === 'unanswered') {
      const why = typeof record.detail === 'string' ? providerErrorText(record.detail) : UNANSWERED_INPUT[record.reason] ?? record.reason;
      return { ...run, state: STOPPED[record.reason] ? 'stopped' : 'failed', text: why };
    }
    inputs ??= await transcriptInputs(storage, target.id, context);
    const opener = openerAt(inputs.openers, Number(record.entry)) ?? Number(record.entry);
    const next = inputs.openers.find(entry => entry > opener);
    const turn = `${turnRowId(piSessionId(conversationId), opener * PI_ENTRY_ORDINALS)}:`;
    const [from, until] = await Promise.all([inputTime(storage, target, inputs.requests[String(opener)], context), next === undefined ? undefined : inputTime(storage, target, inputs.requests[String(next)], context)]);
    const asked = questions.filter(question => question.id.startsWith(blockAsks)
      ? question.id.startsWith(`block-ask:${turn}`)
      : question.askedAt !== undefined && from !== undefined && Date.parse(question.askedAt) >= from && (until === undefined || Date.parse(question.askedAt) < until));
    for (const question of asked) if (questionState(question) === 'open' && !waiting.includes(question)) waiting.push(question);
    // The latest turn an answer started: placed furthest on, or not placed yet.
    let continued: { requestId: string; at: number } | undefined;
    for (const question of asked) {
      if (questionState(question) === 'open') continue;
      const event = `question-closed:${question.id}`;
      const answered = await storage.submissionByRequest(target.id, event, context);
      if (answered?.type !== 'input') continue;
      const at = answered.entry === undefined ? Number.POSITIVE_INFINITY : Number(answered.entry);
      if (at > Number(record.entry) && (continued === undefined || at > continued.at)) continued = { requestId: event, at };
    }
    if (continued) { current = continued.requestId; continue; }
    const open = waiting.at(-1);
    return { ...run, state: open ? 'waiting' : 'finished', text: await replyText(storage, target, record.answer, context) || null, question: open ?? null };
  }
  throw new Error(`Run ${requestId} follows more answered questions than the conversation has`);
}
