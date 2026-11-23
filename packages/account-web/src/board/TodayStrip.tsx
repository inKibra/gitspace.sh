import { StatTile } from '@gitspace/ui';
import { ChevronDown, ChevronRight } from '@untitledui/icons';
import { useState } from 'react';
import type { BoardProject } from './columns.js';

/** A project as the Today strip reads it: its open workspaces, its failed operations and its automation proposals
 * waiting for approval. */
export interface TodayProject extends BoardProject { failedOperations: number; proposals: number }

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Today at a glance, for the projects the Project filter shows (`narrowed`: some are picked, named in the heading), from
 * what the page already holds: agents working (the status rows' running agents), workspaces waiting on the person,
 * automation proposals to approve, problems (failed workspaces and failed project operations) and the account's machines
 * online. Folds to one line.
 */
export function TodayStrip({ projects, narrowed, machines, defaultOpen }: { projects: readonly TodayProject[]; narrowed: boolean; machines: { online: number; total: number } | null; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const items = projects.flatMap((project) => project.items);
  const working = items.reduce((total, item) => total + (item.summary?.status?.agents.green ?? 0), 0);
  const waiting = items.filter((item) => item.state === 'needs-you');
  const waitingProjects = new Set(waiting.map((item) => item.workspace.projectId)).size;
  const proposals = projects.reduce((total, project) => total + project.proposals, 0);
  const failedWorkspaces = items.filter((item) => item.state === 'failed').length;
  const failedOperations = projects.reduce((total, project) => total + project.failedOperations, 0);
  const problems = failedWorkspaces + failedOperations;
  const machinesShort = machines ? machines.online < machines.total : false;
  const line = [`${counted(working, 'agent', 'agents')} working`, `${waiting.length} waiting on you`, counted(problems, 'problem', 'problems'), machines ? `${machines.online} of ${machines.total} machines` : null].filter(Boolean).join(' · ');
  return <section aria-label="Today" className="mx-2 mb-2 flex flex-col gap-2 rounded-2xl border border-border px-3 py-2">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-w-0 items-center gap-2 text-left text-[12px] text-muted-foreground hover:text-foreground">
      {open ? <ChevronDown width={14} height={14} className="shrink-0" /> : <ChevronRight width={14} height={14} className="shrink-0" />}
      <span className="shrink-0 font-medium text-foreground/80">Today</span>
      {narrowed ? <span className="truncate text-foreground/70">· {projects.map((project) => project.name).join(', ')}</span> : null}
      {open ? null : <span className="truncate tabular-nums">{line}</span>}
    </button>
    {open ? <div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-2">
      <StatTile label="Agents working" value={working} detail={`across ${counted(projects.length, 'project', 'projects')}`} tone="good" />
      <StatTile label="Waiting on you" value={waiting.length} detail={waiting.length ? `in ${counted(waitingProjects, 'project', 'projects')}` : 'none'} />
      <StatTile label="Open approvals" value={proposals} detail="automation proposals" />
      <StatTile label="Problems" value={problems} detail={`${counted(failedOperations, 'failed operation', 'failed operations')}`} tone={problems ? 'bad' : 'good'} />
      {machines ? <StatTile label="Machines online" value={`${machines.online} of ${machines.total}`} detail={machinesShort ? `${machines.total - machines.online} offline` : 'all up'} tone={machinesShort ? 'bad' : 'good'} /> : null}
    </div> : null}
  </section>;
}
