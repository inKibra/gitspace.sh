import { Badge, Button, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gitspace/ui';
import { CheckCircle, MinusCircle, XCircle } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { type AutomationCheck, type AutomationRunState, type AutomationRunView, type AutomationTestResult } from '@gitspace/protocol/automations-contract';
import { formatRelativeTime } from '../relative-time.js';
import { type AutomationsProject } from './AutomationsPage.js';
import { RUN_STATE_COLOR, UTC_CLOCK, formatUtc, subjectTitle, workspaceLabel } from './automation-formatters.js';

export function RunBadge({ state }: { state: AutomationRunState }): ReactElement {
  return <Badge variant="dot" size="compact" color={RUN_STATE_COLOR[state]}>{state}</Badge>;
}

export function TestResults({ results }: { results: readonly AutomationTestResult[] }): ReactElement {
  return <ul className="flex flex-col gap-1">{results.map((test, index) => <li key={`${index}:${test.label}`} className="flex items-start gap-2 text-body">
    {test.runs ? <CheckCircle className="mt-0.5 shrink-0 text-success" width={16} height={16} strokeWidth={1.5} /> : <MinusCircle className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
    <span className="min-w-0 [overflow-wrap:anywhere]">{test.label}<span className="text-muted-foreground"> · {test.result}</span></span>
  </li>)}</ul>;
}

export function CheckList({ checks }: { checks: readonly AutomationCheck[] }): ReactElement {
  return <ul aria-label="Checks" className="flex flex-col gap-1.5">{checks.map((check, index) => <li key={`${index}:${check.label}`} className="flex items-start gap-2 text-body">
    {check.passed === true ? <CheckCircle aria-label="Passed" className="mt-0.5 shrink-0 text-success" width={16} height={16} strokeWidth={1.5} />
      : check.passed === false ? <XCircle aria-label="Failed" className="mt-0.5 shrink-0 text-destructive" width={16} height={16} strokeWidth={1.5} />
        : <MinusCircle aria-label="Not checked" className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
    <span className={`min-w-0 [overflow-wrap:anywhere] ${check.passed === null ? 'text-muted-foreground' : 'text-foreground'}`}>{check.label}{check.passed === null ? ' (not checked)' : ''}</span>
  </li>)}</ul>;
}

export function RunsTable({ runs, projects, showProject, now, onOpen }: { runs: readonly AutomationRunView[]; projects: readonly AutomationsProject[]; showProject: boolean; now: number; onOpen(run: AutomationRunView): void }): ReactElement {
  const project = (run: AutomationRunView) => projects.find(entry => entry.id === run.projectId);
  return <>
    <ul aria-label="Runs" className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
      {runs.map(run => <li key={run.id}><button type="button" className="flex w-full min-w-0 flex-col gap-0.5 py-3 text-left" onClick={() => onOpen(run)}>
        <span className="flex items-center justify-between gap-2"><RunBadge state={run.state} /><span className="text-caption tabular-nums text-muted-foreground">{formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, now)}</span></span>
        <span className="text-body [overflow-wrap:anywhere]">{showProject ? <span className="text-muted-foreground">{project(run)?.name ?? run.projectId} · </span> : null}{run.subject ? subjectTitle(run.subject) : run.automationName}</span>
        {run.outcome ? <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{run.outcome}</span> : null}
        <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{run.automationName} · <span className="font-mono">{run.event ?? run.trigger}</span></span>
      </button></li>)}
    </ul>
    <div className="hidden sm:block"><Table size="compact">
      <TableHeader><TableRow>
        <TableHead className="w-24">Status</TableHead>
        {showProject ? <TableHead className="w-[14%]">Project</TableHead> : null}
        <TableHead className={showProject ? 'w-[30%]' : 'w-[40%]'}>Subject</TableHead>
        <TableHead>From · event</TableHead>
        <TableHead>Workspace</TableHead>
        <TableHead className="w-24 text-right">When</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {runs.map((run, index) => <TableRow key={run.id} index={index} className="cursor-pointer" onClick={() => onOpen(run)}>
          <TableCell><RunBadge state={run.state} /></TableCell>
          {showProject ? <TableCell className="max-w-0"><span className="block truncate">{project(run)?.name ?? run.projectId}</span></TableCell> : null}
          <TableCell className="max-w-0">
            <button type="button" className="block w-full truncate text-left text-foreground" onClick={(event) => { event.stopPropagation(); onOpen(run); }}>{run.subject ? subjectTitle(run.subject) : run.automationName}</button>
            {run.outcome ? <span className="block truncate text-caption text-muted-foreground">{run.outcome}</span> : null}
          </TableCell>
          <TableCell className="max-w-0">
            <span className="block truncate">{run.automationName}</span>
            <span className="block truncate font-mono text-caption text-muted-foreground">{run.event ?? run.trigger}</span>
          </TableCell>
          <TableCell className="max-w-0">{run.workspaceId === null ? <span className="text-muted-foreground">—</span>
            : <span className={`block truncate text-caption ${run.workspaceId === run.projectId ? '' : 'font-mono underline decoration-dotted underline-offset-2'}`}>{workspaceLabel(project(run), run.projectId, run.workspaceId)}</span>}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, now)}</TableCell>
        </TableRow>)}
      </TableBody>
    </Table></div>
  </>;
}

export function RunDetail({ run, project, busy, onCancel, onOpenWorkspace }: { run: AutomationRunView; project: AutomationsProject | undefined; busy: boolean; onCancel(run: AutomationRunView): void; onOpenWorkspace(workspaceId: string): void }): ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const { workspaceId } = run;
  const workspace = workspaceId === null ? null : workspaceLabel(project, run.projectId, workspaceId);
  const stopping = run.state === 'running' && confirmStop;
  return <>
    <DialogHeader>
      <DialogTitle><span className="flex flex-wrap items-center gap-2"><span className="[overflow-wrap:anywhere]">{run.subject ? subjectTitle(run.subject) : run.automationName}</span><RunBadge state={run.state} /></span></DialogTitle>
      <DialogDescription>{run.automationName} · <span className="font-mono">{run.event ?? run.trigger}</span> · {formatUtc(run.scheduledFor)}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      {run.outcome ? <p className="text-body [overflow-wrap:anywhere]">{run.outcome}</p> : null}
      {run.checks.length ? <section aria-label="Only if" className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Only if</strong>
        <CheckList checks={run.checks} />
      </section> : null}
      <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Timeline (UTC)</strong>
        {run.timeline.length ? <ol className="flex flex-col gap-1.5">{run.timeline.map((step, index) => <li key={`${index}:${step.label}`} className="flex gap-3 text-body">
          <time dateTime={step.at.toISOString()} className="w-16 shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{UTC_CLOCK.format(step.at)}</time><span className="min-w-0 [overflow-wrap:anywhere]">{step.label}</span>
        </li>)}</ol> : <p className="text-caption text-muted-foreground">Nothing has happened yet.</p>}
      </section>
      {stopping ? <p role="alert" className="text-body">Stopping ends the agent's current turn in {workspace ?? 'its workspace'}, including any other work in that turn.</p> : null}
    </div>
    <DialogFooter>
      {run.state === 'queued' ? <Button variant="secondary" type="button" loading={busy} disabled={busy} onClick={() => onCancel(run)}>Cancel run</Button> : null}
      {run.state === 'running' && !confirmStop ? <Button variant="secondary" type="button" disabled={busy} onClick={() => setConfirmStop(true)}>Stop run</Button> : null}
      {stopping ? <>
        <Button variant="secondary" type="button" onClick={() => setConfirmStop(false)}>Keep running</Button>
        <Button variant="primary" type="button" loading={busy} disabled={busy} onClick={() => onCancel(run)}>Stop the turn</Button>
      </> : null}
      {!stopping && run.subject?.url ? <Button variant="secondary" asChild><a href={run.subject.url} target="_blank" rel="noreferrer">Open on GitHub</a></Button> : null}
      {stopping || workspaceId === null ? null : <Button variant="primary" type="button" onClick={() => onOpenWorkspace(workspaceId)}>{workspaceId === run.projectId ? 'Open the project agent' : `Open ${workspace}`}</Button>}
    </DialogFooter>
  </>;
}
