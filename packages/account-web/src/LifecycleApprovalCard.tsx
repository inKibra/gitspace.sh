import { useState } from 'react';
import { LIFECYCLE_APPROVAL_CHOICES, questionState, RuntimeLifecycleApprovalAnswerSchema, type RuntimeLifecycleApprovalAnswer, type RuntimeLifecycleApprovalQuestion, type RuntimeLifecycleApprovalScript, type RuntimeQuestion } from '@gitspace/protocol-runtime';
import { Badge, Button, useShape } from '@gitspace/ui';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { CLOSED_REASON, type QuestionCards } from './QuestionCards.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** What an answered card says was chosen. */
const ANSWERED: Readonly<Record<RuntimeLifecycleApprovalAnswer, string>> = { project: 'Approved for the project', workspace: 'Approved for this workspace', 'not-now': 'Not now' };
/** The most lines × lines a diff compares; beyond it the changed region shows as all removed, then all added. */
const DIFF_CELLS = 1_000_000;

type DiffLine = { kind: 'same' | 'added' | 'removed'; text: string };
/** `after`'s lines against `before`'s: a longest-common-subsequence diff of the lines between their common prefix and suffix. */
function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.replace(/\n$/u, '').split('\n'), b = after.replace(/\n$/u, '').split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end), y = b.slice(start, b.length - end);
  const middle: DiffLine[] = [];
  if (x.length * y.length > DIFF_CELLS) {
    middle.push(...x.map((text): DiffLine => ({ kind: 'removed', text })), ...y.map((text): DiffLine => ({ kind: 'added', text })));
  } else {
    // common[i * width + j]: the longest common subsequence of x from i and y from j.
    const width = y.length + 1;
    const common = new Uint32Array((x.length + 1) * width);
    for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) {
      common[i * width + j] = x[i] === y[j] ? common[(i + 1) * width + j + 1]! + 1 : Math.max(common[(i + 1) * width + j]!, common[i * width + j + 1]!);
    }
    let i = 0, j = 0;
    while (i < x.length || j < y.length) {
      if (i < x.length && j < y.length && x[i] === y[j]) { middle.push({ kind: 'same', text: x[i]! }); i++; j++; }
      else if (i < x.length && (j === y.length || common[(i + 1) * width + j]! >= common[i * width + j + 1]!)) { middle.push({ kind: 'removed', text: x[i]! }); i++; }
      else { middle.push({ kind: 'added', text: y[j]! }); j++; }
    }
  }
  return [...a.slice(0, start).map((text): DiffLine => ({ kind: 'same', text })), ...middle, ...a.slice(a.length - end).map((text): DiffLine => ({ kind: 'same', text }))];
}

/** One script on the card: its content, or its change since the last approved version of its file. */
function ScriptContent({ script }: { script: RuntimeLifecycleApprovalScript }) {
  const shape = useShape();
  const name = script.fileName ?? script.label;
  const lines = script.previous ? lineDiff(script.previous.content, script.content) : null;
  return <div className="flex min-w-0 flex-col gap-1">
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-caption">
      <span className="font-mono text-foreground [overflow-wrap:anywhere]">{name}</span>
      <span className="text-muted-foreground">{script.previous ? `· changed since approved by ${script.previous.approvedBy}` : script.kind === 'check' ? '· environment check' : '· no approved version'}</span>
    </p>
    <pre aria-label={lines ? `Changes to ${name}` : `Content of ${name}`} className={`max-h-72 overflow-auto bg-surface-2 px-3 py-2 font-mono text-caption leading-relaxed ${shape.item}`}>
      {lines
        ? lines.map((line, index) => <span key={index} data-diff={line.kind} className={`block whitespace-pre-wrap break-words ${line.kind === 'added' ? 'text-success' : line.kind === 'removed' ? 'bg-destructive-light text-destructive' : 'text-muted-foreground'}`}>{line.kind === 'added' ? '+ ' : line.kind === 'removed' ? '- ' : '  '}{line.text}</span>)
        : <span className="block whitespace-pre-wrap break-words text-foreground">{script.content}</span>}
    </pre>
  </div>;
}

/**
 * The card an agent's `environment` run waits on while its scripts need approval: each script's content, or its diff
 * against the last approved version of its file, and Approve for the project (the default), Only this workspace, Not
 * now, or Dismiss. Approving needs lifecycle control; a refusal says why on the card. An answered card is read-only and
 * says what was chosen; one closed unanswered says why it closed.
 */
export function LifecycleApprovalCard({ question, card, cards }: { question: RuntimeQuestion; card: RuntimeLifecycleApprovalQuestion; cards: QuestionCards }) {
  const shape = useShape();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answered = RuntimeLifecycleApprovalAnswerSchema.safeParse(question.answer);
  const state = questionState(question);
  const open = state === 'open';
  async function act(label: string, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); }
    catch (failure) { setError(rpcErrorMessage(failure, label)); }
    finally { setBusy(false); }
  }
  const choose = (choice: RuntimeLifecycleApprovalAnswer) => act(LIFECYCLE_APPROVAL_CHOICES[choice], () => cards.answer(question.id, choice));
  return <section aria-label={`Lifecycle approval · ${card.phase}`} data-answer={answered.success ? answered.data : undefined} className={`relative w-full max-w-[640px] overflow-hidden border border-border bg-card ${shape.container}`}>
    <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5 text-[12px] text-muted-foreground sm:px-5 sm:pt-4">
      <span>The agent asks to run {card.phase === 'checks' ? 'the environment checks' : card.phase}</span>
      {answered.success ? <Badge variant="dot" color={answered.data === 'not-now' ? 'gray' : 'green'}>{ANSWERED[answered.data]}</Badge>
        : state === 'closed' && question.closed ? <Badge variant="dot" color="gray">{CLOSED_REASON[question.closed.reason]}</Badge> : null}
    </div>
    <div className={`flex flex-col gap-3 px-4 sm:px-5 ${open ? 'pb-1' : 'pb-3'}`}>
      <div className="text-[14px] leading-relaxed text-foreground"><GitSpaceMarkdown>{question.prompt}</GitSpaceMarkdown></div>
      {card.scripts.map(script => <ScriptContent key={script.hash} script={script} />)}
      {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
    </div>
    {open ? <div className="px-4 pb-2 pt-1 sm:px-5">
      <div className="-mx-2 flex flex-wrap items-center justify-end gap-2 sm:-mx-3">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void act('Dismiss', () => cards.request({ type: 'dismissQuestion', id: question.id }))}>Dismiss</Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => void choose('not-now')}>{LIFECYCLE_APPROVAL_CHOICES['not-now']}</Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => void choose('workspace')}>{LIFECYCLE_APPROVAL_CHOICES.workspace}</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void choose('project')}>{LIFECYCLE_APPROVAL_CHOICES.project}</Button>
      </div>
    </div> : null}
  </section>;
}
