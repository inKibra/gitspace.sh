import { APPROVAL_DECISION, APPROVE, REJECT, type AskBlock, type ToolCallBlock } from '@gitspace/blocks';
import { AskUserQuestions, Badge, badgeColors, useShape, type AskUserAnswer } from '@gitspace/ui';
import { Check, Lock01, MessageQuestionCircle } from '@untitledui/icons';
import { useContext, useState } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { LifecycleApprovalCard } from '../LifecycleApprovalCard.js';
import { TakeoverCard, TakeoverCardsContext } from '../TakeoverCard.js';
import { ToolGroup } from './ToolGroup.js';
import type { ItemInteractionProps, TranscriptItemState } from './TranscriptItemView.js';
import type { TurnTranscriptProps } from './TurnTranscript.js';

function ChosenMark() {
  const shape = useShape();
  return <span role="img" aria-label="Chosen" className="inline-flex size-7 shrink-0 items-center justify-center">
    <span className={`inline-flex size-5 items-center justify-center bg-foreground text-background ${shape.bg}`}><Check width={12} height={12} strokeWidth={2} aria-hidden /></span>
  </span>;
}

/** What the card asks and of whom, above it: a pending one waits for the person. */
function AskOrigin({ item }: { item: AskBlock }) {
  return <p className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted-foreground" data-ask-origin>
    <span className="flex size-5 items-center justify-center rounded-full" style={{ color: badgeColors.orange, background: `color-mix(in oklab, ${badgeColors.orange} 14%, transparent)` }}><MessageQuestionCircle width={12} height={12} strokeWidth={1.75} aria-hidden /></span>
    <span className="text-foreground">{item.kind === 'plan' ? 'Plan approval' : item.questions.length > 1 ? 'Questions' : 'Question'}</span>
    <span>asked by the workspace agent</span>
    {item.status === 'pending' ? <Badge size="compact" variant="dot" color="orange">Waiting for you</Badge> : <span>· {item.status}</span>}
  </p>;
}

/** A plan's prompt: its leading Markdown heading is the card's title, at the display size; the rest is the plan. */
function PlanPrompt({ prompt }: { prompt: string }) {
  const heading = /^\s*#{1,6}[ \t]+(.+?)[ \t#]*(?:\n|$)/u.exec(prompt);
  return <>
    {heading ? <h2 className="mb-2 text-display font-semibold tracking-tight text-foreground [overflow-wrap:anywhere]">{heading[1]}</h2> : null}
    <GitSpaceMarkdown>{heading ? prompt.slice(heading[0].length) : prompt}</GitSpaceMarkdown>
  </>;
}

/** The steps a plan proposes, numbered, each with where it works; a step's detail opens on request. */
function ProposedSteps({ steps }: { steps: NonNullable<AskBlock['steps']> }) {
  const [open, setOpen] = useState<string | null>(null);
  return <section aria-label="Proposed steps" className="mt-3 flex flex-col gap-1">
    <span className="text-[12px] text-muted-foreground">Proposed steps · {steps.length}</span>
    <ol className="flex flex-col">
      {steps.map((step, index) => <li key={step.id} className="flex flex-col border-b border-border py-1.5 last:border-b-0">
        <button type="button" aria-expanded={step.detail ? open === step.id : undefined} disabled={!step.detail} onClick={() => setOpen(open === step.id ? null : step.id)} className="flex min-w-0 items-start gap-2 text-left disabled:cursor-default">
          <span className="w-5 shrink-0 pt-px text-right text-[12px] tabular-nums text-muted-foreground">{index + 1}.</span>
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] leading-snug text-foreground [overflow-wrap:anywhere]">{step.title}</span>
            {step.where?.length ? <span className="flex flex-wrap gap-1 pt-0.5">{step.where.map((where) => <code key={where} className="rounded-[5px] bg-surface-2 px-1 font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{where}</code>)}</span> : null}
          </span>
        </button>
        {open === step.id && step.detail ? <div className="pl-7 pt-1 text-[13px] text-muted-foreground"><GitSpaceMarkdown>{step.detail}</GitSpaceMarkdown></div> : null}
      </li>)}
    </ol>
  </section>;
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
          <div className="max-h-64 w-full overflow-y-auto text-[14px] leading-relaxed text-foreground">{item.kind === 'plan' && question.id === APPROVAL_DECISION ? <PlanPrompt prompt={question.prompt} /> : <GitSpaceMarkdown>{question.prompt}</GitSpaceMarkdown>}</div>
          {item.kind === 'plan' && question.id === APPROVAL_DECISION && item.steps?.length ? <ProposedSteps steps={item.steps} /> : null}
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
  if (item.status !== 'pending') return <div className="flex min-w-0 flex-col gap-1.5"><AskOrigin item={item} /><AnsweredAsk item={item} /></div>;
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
  const decisionPrompt = item.kind === 'plan' ? item.questions.find((question) => question.id === APPROVAL_DECISION)?.prompt : undefined;
  return <div className={`flex min-w-0 flex-col gap-1.5 ${submitting ? 'pointer-events-none opacity-60' : ''}`} aria-busy={submitting || undefined}>
    <AskOrigin item={item} />
    <AskUserQuestions
      questions={item.questions.map((question) => ({ id: question.id, title: question.prompt, options: (question.options ?? []).map((option) => ({ id: option.id, title: option.title, description: option.description ?? option.preview })), multiSelect: question.multiple, allowOther: question.written !== false, skippable: question.written === false ? question.optional === true : question.optional, freeText: !(question.options?.length), layout: question.options?.some((option) => option.description || option.preview) ? 'stacked' : 'inline' }))}
      defaultAnswers={Object.fromEntries(item.questions.flatMap((question) => question.answer === undefined ? [] : [[question.id, { questionId: question.id, selectedIds: Array.isArray(question.answer) ? question.answer : [question.answer] }]]))}
      answers={interaction.answers}
      onAnswersChange={(answers) => update({ answers })}
      currentIndex={interaction.questionIndex}
      onCurrentIndexChange={(questionIndex) => update({ questionIndex })}
      onComplete={onAnswer ? complete : undefined}
      renderTitle={(prompt) => <div className="max-h-80 overflow-y-auto">{prompt === decisionPrompt ? <><PlanPrompt prompt={prompt} />{item.steps?.length ? <ProposedSteps steps={item.steps} /> : null}</> : <GitSpaceMarkdown>{prompt}</GitSpaceMarkdown>}</div>}
    />
    {error ? <p role="alert" className="mt-2 text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

/** An ask_takeover call shows as its card while the workspace has the card's question; otherwise (a refusal, another
 * surface) as the tool call it is. */
export function AskTakeoverCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const cards = useContext(TakeoverCardsContext);
  const question = cards?.questions.find(item => item.kind === 'takeover' && item.takeover?.callId === block.toolCallId);
  return cards && question?.takeover ? <TakeoverCard question={question} card={question.takeover} cards={cards} /> : <ToolGroup calls={[{ block, complete: true }]} state={state} onStateChange={onStateChange} />;
}

/** An `environment` call that waits, or waited, on a lifecycle approval card shows the card above the call. */
export function EnvironmentCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const cards = useContext(TakeoverCardsContext);
  const question = cards?.questions.find(item => item.kind === 'lifecycle-approval' && item.lifecycle?.callId === block.toolCallId);
  const call = <ToolGroup calls={[{ block, complete: true }]} state={state} onStateChange={onStateChange} />;
  return cards && question?.lifecycle ? <div className="flex min-w-0 flex-col gap-2"><LifecycleApprovalCard question={question} card={question.lifecycle} cards={cards} />{call}</div> : call;
}
