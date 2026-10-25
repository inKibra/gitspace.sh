import type { Harness, Tx } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { z } from 'zod';
import { TAKEOVER_ANSWERS } from '@gitspace/protocol-runtime';
import { QuestionsDoc } from './documents.js';
import type { ConversationEvent } from './conversation-lifecycle.js';

/** The tab a `browser-taken` or `browser-handback` event names (its payload carries more). */
const TakeoverEventTarget = z.object({ groupId: z.string(), targetId: z.string() });
/** True while an ask_takeover card no one has answered names this tab of this group: its take and handback then reach
 * the main conversation even when the agent was not acting there. */
export async function takeoverAsked(harness: Pick<Harness, 'snapshot'>, target: { groupId: string; targetId: string }): Promise<boolean> {
  const questions = await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT);
  return questions?.items.some(item => item.kind === 'takeover' && item.answer === null && item.takeover?.groupId === target.groupId && item.takeover.targetId === target.targetId) ?? false;
}
/** The ask_takeover cards still open on the tab an event names follow it, in the transaction that delivers the event:
 * `browser-taken` makes you their holder, `browser-handback` answers them as handed back. */
export async function noteTakeoverEvent(tx: Tx, event: ConversationEvent): Promise<void> {
  if (event.kind !== 'browser-taken' && event.kind !== 'browser-handback') return;
  const target = TakeoverEventTarget.safeParse(event.payload);
  if (!target.success) return;
  const questions = await tx.doc(QuestionsDoc);
  for (const question of questions.items) {
    const card = question.takeover;
    if (question.kind !== 'takeover' || question.answer !== null || card?.groupId !== target.data.groupId || card.targetId !== target.data.targetId) continue;
    if (event.kind === 'browser-taken') { card.holder = 'you'; continue; }
    card.holder = 'agent';
    question.answer = TAKEOVER_ANSWERS.handedBack;
  }
}
/** Whether an event is the take or handback of this tab. */
export function isTakeoverEvent(event: ConversationEvent, target: { groupId: string; targetId: string }): boolean {
  if (event.kind !== 'browser-taken' && event.kind !== 'browser-handback') return false;
  const named = TakeoverEventTarget.safeParse(event.payload);
  return named.success && named.data.groupId === target.groupId && named.data.targetId === target.targetId;
}
