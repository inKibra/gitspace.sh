import type { Harness, Tx } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { TAKEOVER_ANSWERS, questionState } from '@gitspace/protocol-runtime';
import { QuestionsDoc } from './documents.js';
import type { ConversationEvent } from './conversation-lifecycle.js';

/** The tab a `browser-taken` or `browser-handback` event names (its payload carries more). */
const TakeoverEventTarget = z.object({ groupId: z.string(), targetId: z.string() });
/** True while an open ask_takeover card names this tab of this group: its take and handback then reach the main
 * conversation even when the agent was not acting there. */
export async function takeoverAsked(harness: Pick<Harness, 'snapshot'>, target: { groupId: string; targetId: string }): Promise<boolean> {
  const questions = await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT);
  return questions?.items.some(item => item.kind === 'takeover' && questionState(item) === 'open' && item.takeover?.groupId === target.groupId && item.takeover.targetId === target.targetId) ?? false;
}
/** The open ask_takeover cards on the tab an event names follow it, in the transaction that delivers the event:
 * `browser-taken` makes you their holder, `browser-handback` answers them as handed back (the event itself is what the
 * agent hears). */
export async function noteTakeoverEvent(tx: Tx, event: ConversationEvent): Promise<void> {
  if (event.kind !== 'browser-taken' && event.kind !== 'browser-handback') return;
  const target = TakeoverEventTarget.safeParse(event.payload);
  if (!target.success) return;
  const questions = await tx.doc(QuestionsDoc);
  for (const question of questions.items) {
    const card = question.takeover;
    if (question.kind !== 'takeover' || questionState(question) !== 'open' || card?.groupId !== target.data.groupId || card.targetId !== target.data.targetId) continue;
    if (event.kind === 'browser-taken') { card.holder = 'you'; continue; }
    card.holder = 'agent';
    question.answer = TAKEOVER_ANSWERS.handedBack;
    question.answeredAt = new Date().toISOString();
  }
}
