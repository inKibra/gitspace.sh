import type { Harness } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { questionState, type RuntimeSecureInputAnswer } from '@gitspace/protocol-runtime';
import { QuestionsDoc } from './documents.js';
import type { ConversationLifecycle } from './conversation-lifecycle.js';

/**
 * ask_secure_input's requests end here (docs/APERTURE-DESIGN.md §10.1): the account answers one once its page filled the
 * value or refused (`settleSecureInput`), and the workspace's wake closes those nobody answered in time
 * (`expireSecureInputs`). Either way the asking conversation hears the outcome as its next input, never the value.
 */

/** Answers the open secure-input question `questionId` whose request is `requestId` with `answer`. Throws when it is not
 * open (answered, declined on its card, closed) or names another request. */
export async function settleSecureInput(lifecycle: Pick<ConversationLifecycle, 'closeQuestion'>, questionId: string, requestId: string, answer: RuntimeSecureInputAnswer): Promise<void> {
  await lifecycle.closeQuestion(questionId, async question => {
    if (question.kind !== 'secure-input' || question.secureInput?.requestId !== requestId) throw new Error(`Question ${questionId} is not that secure-input request`);
    return { closure: { answer }, value: undefined };
  });
}

/** Whether the open secure-input question `questionId` still waits for request `requestId`: a page fills a value only
 * while it does. */
export async function secureInputOpen(harness: Pick<Harness, 'snapshot'>, questionId: string, requestId: string): Promise<boolean> {
  const question = (await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items.find(item => item.id === questionId);
  return question?.kind === 'secure-input' && question.secureInput?.requestId === requestId && questionState(question) === 'open';
}

/** Closes each open secure-input question whose request expired by `now` as `expired`; answers when the next open one
 * expires, or null when none is open. One answered meanwhile refuses the expiry, which is only logged. */
export async function expireSecureInputs(harness: Pick<Harness, 'snapshot'>, lifecycle: Pick<ConversationLifecycle, 'closeQuestion'>, now: number): Promise<number | null> {
  let next: number | null = null;
  for (const question of (await harness.snapshot(QuestionsDoc, BACKGROUND_CONTEXT))?.items ?? []) {
    const request = question.secureInput;
    if (question.kind !== 'secure-input' || !request || questionState(question) !== 'open') continue;
    const expiresAt = Date.parse(request.expiresAt);
    if (expiresAt > now) { next = next === null ? expiresAt : Math.min(next, expiresAt); continue; }
    await settleSecureInput(lifecycle, question.id, request.requestId, { outcome: 'expired' })
      .catch((error: unknown) => console.warn(JSON.stringify({ event: 'secure_input_expiry_skipped', questionId: question.id, error: error instanceof Error ? error.message : String(error) })));
  }
  return next;
}
