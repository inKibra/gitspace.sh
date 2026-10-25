import { createContext, useState, type ReactNode } from 'react';
import { TAKEOVER_ANSWERS, TAKEOVER_CHOICES, type RuntimeQuestion, type RuntimeTakeoverQuestion } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { Badge, Button, useShape } from '@gitspace/ui';
import { Cloud01, Monitor01 } from '@untitledui/icons';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** What a transcript needs to show ask_takeover cards: the workspace's questions (each card finds its own by the agent
 * call it belongs to), the main conversation's session commands, and the Watch dialog for a cloud tab. */
export interface TakeoverCards {
  questions: readonly RuntimeQuestion[];
  request(command: RuntimeSessionCommand): Promise<RuntimeSessionResult>;
  /** The Watch dialog on the card's cloud tab, until `onClose`. */
  watch(card: RuntimeTakeoverQuestion, onClose: () => void): ReactNode;
}
/** Absent outside a cloud workspace's transcript: ask_takeover calls then show as plain tool calls. */
export const TakeoverCardsContext = createContext<TakeoverCards | null>(null);

/**
 * An ask_takeover card (docs/APERTURE-DESIGN.md §7.2), in the look of the agent's questions: why the agent asks, the
 * browser and the tab, and Take over or Not now. Take over makes you the tab's holder, then brings the tab to the front
 * in Chrome or opens the Watch dialog on the cloud browser; while you hold it the card says so and offers Resume agent.
 * A card that ended (handed back, or Not now) is read-only.
 */
export function TakeoverCard({ question, card, cards }: { question: RuntimeQuestion; card: RuntimeTakeoverQuestion; cards: TakeoverCards }) {
  const shape = useShape();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [watching, setWatching] = useState(false);
  const target = { groupId: card.groupId, targetId: card.targetId };
  const chrome = card.source === 'chrome';
  const open = question.answer === null;
  const yours = open && card.holder === 'you';
  const url = URL.parse(card.url);
  async function perform(label: string, commands: RuntimeSessionCommand[], then?: () => void) {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      for (const command of commands) await cards.request(command);
      then?.();
    } catch (failure) { setError(rpcErrorMessage(failure, label)); }
    finally { setBusy(false); }
  }
  const status = question.answer === TAKEOVER_ANSWERS.handedBack ? <Badge variant="dot" color="green">Handed back</Badge>
    : question.answer === TAKEOVER_ANSWERS.declined ? <Badge variant="dot" color="gray">Not now</Badge>
      : yours ? <Badge variant="dot" color="blue">You’re in control</Badge> : null;
  return <section aria-label={`Take over · ${card.browser}`} data-takeover={open ? card.holder : String(question.answer)} className={`relative w-full max-w-[520px] overflow-hidden border border-border bg-card ${shape.container}`}>
    <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5 text-[12px] text-muted-foreground sm:px-5 sm:pt-4">
      <span>The agent asks you to take over</span>
      {status}
    </div>
    <div className={`flex flex-col gap-2 px-4 sm:px-5 ${open ? 'pb-1' : 'pb-3'}`}>
      <div className="text-[14px] leading-relaxed text-foreground"><GitSpaceMarkdown>{question.prompt}</GitSpaceMarkdown></div>
      <p className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground" title={card.title}>
        {chrome ? <Monitor01 className="shrink-0" width={13} height={13} /> : <Cloud01 className="shrink-0" width={13} height={13} />}
        <span className="shrink-0 text-foreground">{card.browser}</span>
        <span className="min-w-0 truncate">· {url ? `${url.host}${url.pathname === '/' ? '' : url.pathname}` : card.url}</span>
      </p>
      {yours ? <p className="text-caption text-muted-foreground">The agent is paused · it sees your changes when it resumes</p>
        : open && !card.waiting ? <p className="text-caption text-muted-foreground">The agent stopped waiting. If you take the tab, it hears when you hand it back.</p> : null}
      {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
    </div>
    {open ? <div className="px-4 pb-2 pt-1 sm:px-5">
      <div className="-mx-2 flex items-center justify-end gap-2 sm:-mx-3">
        {yours
          ? <>
              {chrome ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform('Focus in Chrome', [{ type: 'browserFocusTab', ...target }])}>Focus in Chrome</Button>
                : <Button variant="ghost" size="sm" onClick={() => setWatching(true)}>Watch</Button>}
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void perform('Resume agent', [{ type: 'browserResume', ...target }])}>Resume agent</Button>
            </>
          : <>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void perform(TAKEOVER_CHOICES.notNow, [{ type: 'answerAsk', id: question.id, answers: [{ id: question.id, selectedOptions: [TAKEOVER_CHOICES.notNow], customInput: null }] }])}>{TAKEOVER_CHOICES.notNow}</Button>
              {/* Chrome brings the tab you now hold to the front; the cloud browser has no window of yours, so its Watch dialog opens. */}
              <Button variant="primary" size="sm" disabled={busy} onClick={() => void perform(TAKEOVER_CHOICES.takeOver, chrome ? [{ type: 'browserTakeOver', ...target }, { type: 'browserFocusTab', ...target }] : [{ type: 'browserTakeOver', ...target }], chrome ? undefined : () => setWatching(true))}>{TAKEOVER_CHOICES.takeOver}</Button>
            </>}
      </div>
    </div> : null}
    {watching && open && !chrome ? cards.watch(card, () => setWatching(false)) : null}
  </section>;
}
