import { useState } from 'react';
import { questionState, RuntimeSecureInputAnswerSchema, SECURE_INPUT_CHOICES, type RuntimeQuestion, type RuntimeSecureInputKind, type RuntimeSecureInputQuestion } from '@gitspace/protocol-runtime';
import { Badge, Button, useShape } from '@gitspace/ui';
import { Cloud01, Lock01, Monitor01 } from '@untitledui/icons';
import { shortTime } from './chat/time.js';
import { CLOSED_REASON, type QuestionCards } from './QuestionCards.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** What a secure-input request asks for, as its card and page name it. */
export const SECURE_INPUT_KIND_LABEL: Readonly<Record<RuntimeSecureInputKind, string>> = { password: 'Password', otp: 'One-time code', text: 'Text' };

/** How an ended secure-input question reads: its answer's outcome, or why it closed. Never the value. */
function outcome(question: RuntimeQuestion): string {
  if (question.answer === null) return question.closed ? CLOSED_REASON[question.closed.reason] : '';
  const answer = RuntimeSecureInputAnswerSchema.safeParse(question.answer);
  if (!answer.success) return 'Answered';
  return answer.data.outcome === 'provided' ? 'Provided and filled' : answer.data.outcome === 'declined' ? `Declined: ${answer.data.reason}` : 'Expired';
}

/**
 * An ask_secure_input card (docs/APERTURE-DESIGN.md §10.1): what the secret is for, the exact origin it is filled into,
 * what it asks for, the browser and tab, the workspace and when the request expires. The value is never typed here:
 * Enter securely opens the request's secure-input page, and Decline answers the question without one. An ended card is
 * read-only and says how it ended.
 */
export function SecureInputCard({ question, card, cards }: { question: RuntimeQuestion; card: RuntimeSecureInputQuestion; cards: QuestionCards }) {
  const shape = useShape();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = questionState(question);
  const open = state === 'open';
  async function decline() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await cards.request({ type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: [SECURE_INPUT_CHOICES.decline], customInput: null }] });
    } catch (failure) { setError(rpcErrorMessage(failure, SECURE_INPUT_CHOICES.decline)); }
    finally { setBusy(false); }
  }
  return <section aria-label={`Secure input · ${card.origin}`} data-secure-input={state} className={`relative w-full max-w-[520px] overflow-hidden border border-border bg-card ${shape.container}`}>
    <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5 text-[12px] text-muted-foreground sm:px-5 sm:pt-4">
      <span className="inline-flex items-center gap-1.5"><Lock01 width={12} height={12} strokeWidth={1.5} aria-hidden />The agent asks for a secret</span>
      {open ? <Badge variant="dot" color="orange">Waiting for you</Badge> : null}
    </div>
    <div className={`flex flex-col gap-2 px-4 sm:px-5 ${open ? 'pb-1' : 'pb-3'}`}>
      <p className="text-[14px] leading-relaxed text-foreground [overflow-wrap:anywhere]">{card.purpose}</p>
      <p className="break-all font-mono text-[15px] font-semibold text-foreground" data-secure-input-origin>{card.origin}</p>
      <p className="text-caption text-muted-foreground">{SECURE_INPUT_KIND_LABEL[card.kind]} · {card.workspace} · {open ? 'expires' : 'expired'} {shortTime(new Date(card.expiresAt))}</p>
      <p className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground" title={card.title}>
        {card.source === 'chrome' ? <Monitor01 className="shrink-0" width={13} height={13} /> : <Cloud01 className="shrink-0" width={13} height={13} />}
        <span className="shrink-0 text-foreground">{card.browser}</span>
        <span className="min-w-0 truncate">· {card.title}</span>
      </p>
      {open ? null : <p className="text-caption text-foreground [overflow-wrap:anywhere]" data-secure-input-outcome>{outcome(question)}</p>}
      {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
    </div>
    {open ? <div className="px-4 pb-2 pt-1 sm:px-5">
      <div className="-mx-2 flex items-center justify-end gap-2 sm:-mx-3">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void decline()}>{SECURE_INPUT_CHOICES.decline}</Button>
        <Button variant="primary" size="sm" asChild><a href={card.url} target="_blank" rel="noopener">Enter securely</a></Button>
      </div>
    </div> : null}
  </section>;
}
