// Small pieces the Inbox mock draws (gitspace.sh inbox-mock identity.tsx, items.tsx), redrawn here on the same
// classes: the workspace tile, the goal line, a cleared row with Undo, the mock's pills; plus a Chatter volume source
// the real indicator reads.
import { ChatterVolumesContext, type ChatterVolumesValue } from '../chatter/ChatterVolume.js';
import { StatusDot } from '../GitSpaceShell.js';
import { PhaseTag, PrChip } from '../sidebar/parts.js';
import type { ChatterVolumes } from '@gitspace/protocol/chatter-contract';
import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
import { badgeColors, Button } from '@gitspace/ui';
import { Check, CheckDone01, GitBranch01 } from '@untitledui/icons';
import { useMemo, useState, type ReactNode } from 'react';
import { PROJECTS, tileColor, VIEWER, WORKSPACES, type MockWorkspace, type Phase } from './data.js';

/** The workspace's tile: the goal's emoji or the name's initial, in the workspace's own colour, with its status dot. */
export function IdentityTile({ workspace, color, small = false }: { workspace: MockWorkspace; color: WorkspaceStatusColor; small?: boolean }) {
  const tone = tileColor(`${workspace.projectId}/${workspace.name}`);
  const emoji = workspace.goal.emoji !== null;
  return <span title={`${workspace.name} · ${workspace.goal.title}`}
    className={`relative flex shrink-0 items-center justify-center font-semibold ${small ? 'size-5 rounded-md text-[10px]' : 'size-8 rounded-lg text-[13px]'}`}
    style={{ color: `color-mix(in oklab, ${tone} 80%, var(--foreground))`, background: `color-mix(in oklab, ${tone} 18%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 30%, transparent)`, fontSize: emoji ? (small ? 11 : 15) : undefined }}>
    {workspace.goal.emoji ?? workspace.name.charAt(0).toUpperCase()}
    <span className="absolute -bottom-0.5 -right-0.5 flex rounded-full" style={{ background: 'var(--background)', padding: 2 }}><StatusDot color={color} pulse={color === 'green'} /></span>
  </span>;
}

/** Under the goal: the workspace, its phase, pull request, requirements met and plan step. `compact` (a narrow card)
 * gives the workspace its own line and the rest one line, the step without its title. */
export function IdentityLine({ workspace, phase, showProject, compact = false }: { workspace: MockWorkspace; phase: Phase; showProject: boolean; compact?: boolean }) {
  const goal = workspace.goal;
  const step = goal.current === null ? null : goal.steps[goal.current - 1];
  const project = PROJECTS.find((candidate) => candidate.id === workspace.projectId)?.name;
  const name = <span className="inline-flex min-w-0 items-center gap-1 truncate">
    {showProject ? <span className="text-foreground/70">{project} ›</span> : null}
    <GitBranch01 width={11} height={11} strokeWidth={1.75} className="shrink-0" /><span className="truncate">{workspace.name}</span>
  </span>;
  const requirements = <span className="inline-flex shrink-0 items-center gap-1 tabular-nums" title="Requirements accepted"><CheckDone01 width={11} height={11} strokeWidth={1.75} />{goal.requirements.met} of {goal.requirements.total}</span>;
  if (compact) return <div className="flex min-w-0 flex-col gap-0.5 text-[12px] text-muted-foreground">
    {name}
    <span className="flex min-w-0 items-center gap-2 overflow-hidden">
      <PhaseTag phase={phase} />
      {workspace.pulls.map((pull) => <PrChip key={pull.number} pr={pull} />)}
      {requirements}
      <span className="shrink-0 tabular-nums" title={step ?? 'Plan waiting for approval'}>{step ? `step ${goal.current} of ${goal.steps.length}` : 'plan waiting'}</span>
    </span>
  </div>;
  return <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
    {name}
    <PhaseTag phase={phase} />
    {workspace.pulls.map((pull) => <PrChip key={pull.number} pr={pull} />)}
    {requirements}
    <span className="inline-flex min-w-0 items-center gap-1 truncate">
      {step ? <>Step {goal.current} of {goal.steps.length}<span className="truncate text-foreground/80">“{step}”</span></> : <span>Plan waiting for approval · {goal.steps.length} steps</span>}
    </span>
  </div>;
}

/** A cleared row, kept one line high for six seconds so the answer can be taken back. */
export function ResolvedRow({ label, about, secondsLeft, onUndo }: { label: string; about: string; secondsLeft: number; onUndo(): void }) {
  return <div className="flex min-h-9 items-center gap-3 rounded-xl px-1 py-1.5 text-[13px]" data-resolved="">
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full" style={{ color: badgeColors.green, background: `color-mix(in oklab, ${badgeColors.green} 14%, transparent)` }}><Check width={13} height={13} strokeWidth={2} /></span>
    <span className="min-w-0 flex-1 truncate"><span className="font-medium text-foreground">{label}</span><span className="text-muted-foreground"> · {about}</span></span>
    <Button variant="ghost" size="compact" onClick={onUndo}>Undo <span className="tabular-nums text-muted-foreground">{secondsLeft}s</span></Button>
  </div>;
}

/** The Inbox mock's pill: a filter or a switch, with an optional dot and count. */
export function Pill({ pressed, onClick, children, tone, count }: { pressed: boolean; onClick(): void; children: ReactNode; tone?: string; count?: number }) {
  return <button type="button" aria-pressed={pressed} onClick={onClick}
    className={`inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors duration-150 ${pressed ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>
    {tone ? <span className="size-1.5 rounded-full" style={{ background: tone }} /> : null}
    {children}
    {count === undefined ? null : <span className={`min-w-4 rounded-full px-1 text-center text-[10.5px] leading-4 tabular-nums ${pressed ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground'}`}>{count}</span>}
  </button>;
}

const LOADED = Date.now();

/** Chatter volumes for the mock's projects, held in the page: the real indicators and their popovers read and set them. */
export function MockChatter({ children }: { children: ReactNode }) {
  const [volumes, setVolumes] = useState<ReadonlyMap<string, ChatterVolumes>>(() => new Map(PROJECTS.map((project) => {
    const mine = WORKSPACES.filter((workspace) => workspace.projectId === project.id);
    return [project.id, {
      strips: mine.flatMap((workspace) => workspace.volume ? [{ strip: workspace.id, level: workspace.volume, muted: false, by: VIEWER, at: new Date(LOADED - 3_600_000) }] : []),
      projectMuted: null,
      recent: mine.flatMap((workspace) => workspace.posted ? [{ strip: workspace.id, at: new Date(LOADED) }] : []),
    }];
  })));
  const value = useMemo((): ChatterVolumesValue => ({
    volumes,
    setVolume: (projectId, strip, change) => setVolumes((current) => {
      const project = current.get(projectId);
      if (!project) return current;
      const was = project.strips.find((entry) => entry.strip === strip);
      const next = { strip, level: change.level ?? was?.level ?? null, muted: change.muted ?? was?.muted ?? false, by: VIEWER, at: new Date() };
      return new Map(current).set(projectId, { ...project, strips: [...project.strips.filter((entry) => entry.strip !== strip), next] });
    }),
    setProjectMute: (projectId, on) => setVolumes((current) => {
      const project = current.get(projectId);
      return project ? new Map(current).set(projectId, { ...project, projectMuted: { on, by: VIEWER, at: new Date() } }) : current;
    }),
  }), [volumes]);
  return <ChatterVolumesContext.Provider value={value}>{children}</ChatterVolumesContext.Provider>;
}
