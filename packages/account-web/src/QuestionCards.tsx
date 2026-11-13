import { createContext, type ReactNode } from 'react';
import type { RuntimeAnswerInput, RuntimeQuestion, RuntimeQuestionClosed, RuntimeTakeoverQuestion } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';

/** What a transcript needs to show the question cards agents post (ask and propose_plan cards, ask_takeover, an
 * `environment` run's lifecycle approval, and the approvals above the composer): the workspace's questions (each card
 * finds its own and shows its state), the conversation's session commands (an ask's answer, Dismiss, the take-over
 * actions), an approval's or lifecycle approval's answer, and the Watch dialog for a cloud tab. */
export interface QuestionCards {
  questions: readonly RuntimeQuestion[];
  request(command: RuntimeSessionCommand): Promise<RuntimeSessionResult>;
  /** Answers an approval (`{ approved, note }`) or a lifecycle approval as the person; approving a lifecycle approval
   * needs their lifecycle control. */
  answer(questionId: string, answer: RuntimeAnswerInput['answer']): Promise<void>;
  /** The Watch dialog on the card's cloud tab, until `onClose`. */
  watch(card: RuntimeTakeoverQuestion, onClose: () => void): ReactNode;
}
/** Absent outside a cloud workspace's transcript: ask_takeover and environment calls then show as plain tool calls,
 * and ask cards answer through the transcript's `onAnswer`. */
export const QuestionCardsContext = createContext<QuestionCards | null>(null);

/** What a card that closed unanswered says about why. */
export const CLOSED_REASON: Readonly<Record<RuntimeQuestionClosed['reason'], string>> = {
  dismissed: 'Dismissed',
  stopped: 'Closed: the conversation was stopped or reset',
  expired: 'Expired',
};
