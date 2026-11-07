import { APPROVAL_DECISION, APPROVE, REJECT, type AskBlock, type ToolCallBlock } from '@gitspace/blocks';
import { AskUserQuestions, Badge, useShape, type AskUserAnswer } from '@gitspace/ui';
import { Check, Lock01 } from '@untitledui/icons';
import { useContext, useState } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { TakeoverCard, TakeoverCardsContext } from '../TakeoverCard.js';
import { ToolCall } from './ToolCall.js';
import type { ItemInteractionProps, TranscriptItemState } from './TranscriptItemView.js';
import type { TurnTranscriptProps } from './TurnTranscript.js';

function ChosenMark() {
  const shape = useShape();
  return <span role="img" aria-label="Chosen" className="inline-flex size-7 shrink-0 items-center justify-center">
    <span className={`inline-flex size-5 items-center justify-center bg-foreground text-background ${shape.bg}`}><Check width={12} height={12} strokeWidth={2} aria-hidden /></span>
  </span>;
}

/**
 * An answered (or dismissed) ask, kept in the conversation as the question card it was, read only: every question,
 * the options picked marked and the rest struck through, written answers in the written row. A plan's card shows
 * its decision.
 */
function AnsweredAsk({ item }: { item: AskBlock }) {
  const shape = useShape();
  const answered = item.status === 'answered';
  const title = item.kind === 'plan' ? 'Plan approval' : item.questions.length > 1 ? 'Questions' : 'Question';
  const decision = item.kind === 'plan' ? item.questions.find((question) => question.id === APPROVAL_DECISION)?.answer : undefined;
  return <section aria-label={`${title}, ${item.status}`} className={`relative w-full max-w-[520px] overflow-hidden border border-border bg-card ${shape.container}`}>
    <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5 text-[12px] text-muted-foreground sm:px-5 sm:pt-4">
      <span className="inline-flex items-center gap-1.5"><Lock01 width={12} height={12} strokeWidth={1.5} />{title} · {item.status}</span>
      {decision === APPROVE ? <Badge variant="dot" size="compact" color="green">Approved</Badge> : decision === REJECT ? <Badge variant="dot" size="compact" color="red">Rejected</Badge> : null}
    </div>
    <div className="flex flex-col gap-4 px-4 pb-3 sm:px-5">
      {item.questions.map((question, index) => {
        const given = question.answer === undefined ? [] : Array.isArray(question.answer) ? question.answer : [question.answer];
        const options = question.options ?? [];
        const written = given.filter((answer) => !options.some((option) => option.id === answer));
        if (question.optional && !given.length) return null;
        return <div key={question.id} className="flex flex-col gap-2">
          {item.questions.length > 1 ? <span className="text-[12px] text-muted-foreground">Question {index + 1} of {item.questions.length}</span> : null}
          <div className="max-h-64 w-full overflow-y-auto text-[14px] leading-relaxed text-foreground"><GitSpaceMarkdown>{question.prompt}</GitSpaceMarkdown></div>
          <ul className="-mx-3 flex flex-col">
            {options.map((option, optionIndex) => {
              const chosen = given.includes(option.id);
              return <li key={option.id} className={`flex min-h-10 items-center gap-3 py-1.5 pl-3 pr-1.5 ${shape.item} ${chosen ? 'bg-card ring-1 ring-inset ring-border' : ''}`}>
                <span className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 leading-snug">
                  <span className={`text-[14px] ${chosen ? 'text-foreground' : answered ? 'text-muted-foreground line-through decoration-border' : 'text-muted-foreground'}`}>{option.title}</span>
                  {option.description ?? option.preview ? <span className="text-[12px] text-muted-foreground">{option.description ?? option.preview}</span> : null}
                </span>
                {chosen ? <ChosenMark /> : <span className="inline-flex size-7 shrink-0 items-center justify-center text-[11px] text-muted-foreground">{optionIndex + 1}</span>}
              </li>;
            })}
            {written.map((answer) => <li key={answer} className={`flex min-h-10 items-center gap-3 bg-active py-1.5 pl-3 pr-1.5 ${shape.item}`}>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] leading-snug text-foreground [overflow-wrap:anywhere]">{answer}</span>
              <ChosenMark />
            </li>)}
            {answered && !given.length ? <li className="px-3 py-1.5 text-[14px] text-muted-foreground">Skipped</li> : null}
          </ul>
        </div>;
      })}
    </div>
  </section>;
}

export function AskBlockView({ item, onAnswer, state, onStateChange }: { item: AskBlock; onAnswer?: TurnTranscriptProps['onAnswer'] } & ItemInteractionProps) {
  const [local, setLocal] = useState<TranscriptItemState>({});
  const interaction = state ?? local;
  const { submitting = false, error = null } = interaction;
  const update = (patch: Partial<TranscriptItemState>): void => {
    if (onStateChange) onStateChange(patch);
    else setLocal((previous) => ({ ...previous, ...patch }));
  };
  if (item.status !== 'pending') return <AnsweredAsk item={item} />;
  const complete = (answers: Record<string, AskUserAnswer>): void => {
    if (!onAnswer || submitting) return;
    update({ submitting: true, error: null });
    void onAnswer(item.questions.map((question) => ({
      id: question.id,
      selectedOptions: answers[question.id]?.selectedIds ?? [],
      customInput: answers[question.id]?.otherText ?? null,
    }))).catch((failure) => {
      update({ submitting: false, error: rpcErrorMessage(failure, 'Answer agent questions') });
    });
  };
  return <div className={submitting ? 'pointer-events-none opacity-60' : undefined} aria-busy={submitting || undefined}>
    <AskUserQuestions
      questions={item.questions.map((question) => ({ id: question.id, title: question.prompt, options: (question.options ?? []).map((option) => ({ id: option.id, title: option.title, description: option.description ?? option.preview })), multiSelect: question.multiple, allowOther: question.written !== false, skippable: question.written === false ? question.optional === true : question.optional, freeText: !(question.options?.length), layout: question.options?.some((option) => option.description || option.preview) ? 'stacked' : 'inline' }))}
      defaultAnswers={Object.fromEntries(item.questions.flatMap((question) => question.answer === undefined ? [] : [[question.id, { questionId: question.id, selectedIds: Array.isArray(question.answer) ? question.answer : [question.answer] }]]))}
      answers={interaction.answers}
      onAnswersChange={(answers) => update({ answers })}
      currentIndex={interaction.questionIndex}
      onCurrentIndexChange={(questionIndex) => update({ questionIndex })}
      onComplete={onAnswer ? complete : undefined}
      renderTitle={(prompt) => <div className="max-h-80 overflow-y-auto"><GitSpaceMarkdown>{prompt}</GitSpaceMarkdown></div>}
    />
    {error ? <p role="alert" className="mt-2 text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

/** An ask_takeover call shows as its card while the workspace has the card's question; otherwise (a refusal, another
 * surface) as the tool call it is. */
export function AskTakeoverCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const cards = useContext(TakeoverCardsContext);
  const question = cards?.questions.find(item => item.kind === 'takeover' && item.takeover?.callId === block.toolCallId);
  return cards && question?.takeover ? <TakeoverCard question={question} card={question.takeover} cards={cards} /> : <ToolCall block={block} state={state} onStateChange={onStateChange} />;
}
