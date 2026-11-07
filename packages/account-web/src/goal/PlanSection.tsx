// The conversation's plan, from the runtime's session-control view: its steps with their status, where the agent's
// todo list is (on a step, or on a detour of its own), and per step its code, requirements, detail and comments.
import { Badge, useShape } from '@gitspace/ui';
import type { GoalRequirement, ReviewThreadView } from '@gitspace/protocol';
import type { SessionControlView } from '@gitspace/protocol-runtime/session-controls';
import { Check, ChevronRight, MessageSquare01 } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { StepComments, type StepCommentHandlers } from './StepComments.js';

type Plan = NonNullable<SessionControlView['plan']>;

/** Where the todo list is: the current task (the one in progress, else the first pending) names a plan step, or it
 * does not (a detour: the agent's own list); null when there is no unfinished task. */
function todoPosition(todos: SessionControlView['todos']): { stepId: string } | { detour: string } | null {
  const tasks = todos.flatMap(list => list.tasks);
  const current = tasks.find(task => task.status === 'in_progress') ?? tasks.find(task => task.status === 'pending');
  if (!current) return null;
  return current.planStep ? { stepId: current.planStep } : { detour: current.content };
}

const STATUS_LABEL: Record<Plan['steps'][number]['status'], string | null> = { completed: 'Done', active: 'In progress', pending: null };

export function PlanSection({ plan, todos, requirements, threads, comments }: {
  plan: Plan | null; todos: SessionControlView['todos']; requirements: readonly GoalRequirement[];
  threads: readonly ReviewThreadView[]; comments: StepCommentHandlers;
}): ReactElement {
  const shape = useShape();
  const [open, setOpen] = useState<string | null>(null);
  if (!plan || !plan.steps.length) return <p className="text-body text-muted-foreground">No plan yet. The agent proposes one with its steps; you approve it on its card in the conversation.</p>;
  const position = todoPosition(todos);
  const done = plan.steps.filter(step => step.status === 'completed').length;
  const onStep = position && 'stepId' in position ? plan.steps.findIndex(step => step.id === position.stepId) : -1;
  return <section aria-label="Plan" className={`${shape.container} flex flex-col overflow-hidden border border-border bg-surface-1`}>
    <header className="flex flex-col gap-1.5 border-b border-border px-4 pb-3 pt-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption text-muted-foreground">Plan · written by the agent{plan.revision ? ` · revision ${plan.revision}` : ''}</span>
        {plan.status === 'proposed' ? <Badge variant="dot" size="compact" color="amber">Awaiting your approval</Badge> : plan.status === 'rejected' ? <Badge variant="dot" size="compact" color="red">Rejected</Badge> : null}
        <span className="ml-auto text-caption tabular-nums text-muted-foreground">{done} of {plan.steps.length} steps done</span>
      </div>
      {plan.summary.trim() ? <GitSpaceMarkdown className="text-body">{plan.summary}</GitSpaceMarkdown> : null}
      {position && 'detour' in position ? <p className="text-caption text-muted-foreground"><Badge size="compact" color="violet">Detour: {position.detour}</Badge> The todo list is the agent’s own, not the plan’s steps.</p>
        : onStep >= 0 ? <p className="text-caption text-muted-foreground">The todo list is on step {onStep + 1}.</p> : null}
    </header>
    <ol className="flex flex-col">
      {plan.steps.map((step, index) => {
        const expanded = open === step.id;
        const stepThreads = threads.filter(thread => thread.anchor.kind === 'plan-step' && thread.anchor.stepId === step.id);
        const unresolved = stepThreads.filter(thread => !thread.resolved).length;
        const linked = step.requirementIds.flatMap(id => requirements.filter(requirement => requirement.id === id));
        const label = STATUS_LABEL[step.status];
        return <li key={step.id} className="border-b border-border last:border-b-0" aria-label={`Step ${index + 1}: ${step.title}`}>
          <button type="button" className="flex w-full items-start gap-3 px-3 py-2.5 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : step.id)}>
            <span aria-hidden className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums ${step.status === 'completed' ? 'bg-foreground text-background' : step.status === 'active' ? 'text-foreground ring-[1.5px] ring-inset ring-[color:var(--focus-ring)]' : 'text-muted-foreground ring-1 ring-inset ring-border'}`}>
              {step.status === 'completed' ? <Check width={12} height={12} strokeWidth={3} /> : index + 1}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className={`text-body ${step.status === 'completed' ? 'text-muted-foreground' : 'text-foreground'}`}>{step.title}</span>
              {label || index === onStep ? <span className="flex flex-wrap items-center gap-1.5 text-caption text-muted-foreground">{label}{label && index === onStep ? ' · ' : null}{index === onStep ? <span className="text-foreground">todo list is here</span> : null}</span> : null}
            </span>
            {stepThreads.length ? <span className="flex items-center gap-1 text-caption tabular-nums text-muted-foreground" aria-label={`${unresolved} open comment${unresolved === 1 ? '' : 's'}`}><MessageSquare01 width={12} height={12} />{stepThreads.length}</span> : null}
            <ChevronRight width={14} height={14} className={`mt-1 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`} />
          </button>
          {expanded ? <div className="flex flex-col gap-3 pb-4 pl-11 pr-3">
            {step.where.length ? <ul className="flex flex-col gap-0.5" aria-label="Where">{step.where.map((where, child) => <li key={where} className="flex gap-2 text-caption"><span className="tabular-nums text-muted-foreground">{index + 1}.{child + 1}</span><code className="font-mono text-[11px] text-muted-foreground [overflow-wrap:anywhere]">{where}</code></li>)}</ul> : null}
            {linked.length ? <span className="flex flex-wrap items-center gap-1 text-caption text-muted-foreground">Requirements {linked.map(requirement => <Badge key={requirement.id} size="compact" color="gray">{requirement.title}</Badge>)}</span> : null}
            {step.detail.trim() ? <GitSpaceMarkdown className="text-body">{step.detail}</GitSpaceMarkdown> : null}
            <StepComments stepId={step.id} stepNumber={index + 1} threads={stepThreads} handlers={comments} />
          </div> : null}
        </li>;
      })}
    </ol>
  </section>;
}
