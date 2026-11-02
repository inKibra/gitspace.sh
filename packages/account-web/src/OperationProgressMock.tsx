// Throwaway design mock: long project and workspace operations run in the background. A request returns once the
// operation is recorded; the project's own object runs it, and every surface follows the recorded steps: the setting it
// changes (Project settings), the project's row in the sidebar, the project page's top bar, and the workspace cards.
// A failure stays on its step with Retry and Dismiss. The buttons drive a simulation: steps advance on a timer, and the
// corner switch decides whether the next operation fails. "Today" shows the request held open until it times out.
import {
  Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, InputField, InputGroup, MenuItem, ShapeProvider, Sidebar, SidebarContent,
  SidebarFooter, SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarProvider, SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider, ThinkingIndicator, Tooltip, TooltipProvider, untitledIcons, useShape,
  WorkspaceTile, type IconComponent,
} from '@gitspace/ui';
import { Activity, Archive, Columns03, FolderClosed, GitBranch01, Key01, PuzzlePiece01, RefreshCcw01, Settings01, Stars01, Trash01, XClose, Zap } from '@untitledui/icons';
import { StrictMode, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader, StatusDot } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';

type View = 'settings' | 'project' | 'today';
type Outcome = 'succeed' | 'fail';
type Kind = 'switch' | 'update' | 'archive' | 'restore' | 'delete';
type StepState = 'queued' | 'running' | 'succeeded' | 'failed';

/** What each operation does, step by step, with how long the simulation spends on each (seconds). */
const PLANS: Record<Kind, { title: string; failedTitle: string; steps: readonly { label: string; seconds: number }[]; error: string }> = {
  switch: { title: 'Switching the base branch', failedTitle: 'Base branch switch failed', error: 'Git push rejected: push is 86.5 MiB, limit is 64.0 MiB.',
    steps: [{ label: 'Copy develop from GitHub', seconds: 6 }, { label: 'Switch the base checkout', seconds: 3 }, { label: 'Record the new base branch', seconds: 1 }] },
  update: { title: 'Updating the base', failedTitle: 'Update base failed', error: 'Base workspace has uncommitted changes; commit or discard them before moving it forward.',
    steps: [{ label: 'Fast-forward the base branch from origin', seconds: 3 }, { label: 'Move the base checkout', seconds: 3 }] },
  archive: { title: 'Archiving', failedTitle: 'Archive failed', error: 'Stop workspace runtime: the machine did not answer.',
    steps: [{ label: 'Stop its runtime', seconds: 3 }, { label: 'Archive the workspace', seconds: 1 }] },
  restore: { title: 'Restoring', failedTitle: 'Restore failed', error: 'Restore workspace: An internal error occurred.',
    steps: [{ label: 'Restore the workspace', seconds: 3 }] },
  delete: { title: 'Deleting', failedTitle: 'Delete failed', error: 'Delete workspace repository: An internal error occurred.',
    steps: [{ label: 'Erase its runtime', seconds: 2 }, { label: 'Delete its repository', seconds: 2 }, { label: 'Delete its records', seconds: 1 }] },
};

interface Operation {
  kind: Kind;
  /** `project`, or the workspace it acts on. */
  target: string;
  summary: string;
  startedAt: number;
  /** The step that fails, or null when it succeeds. */
  failAt: number | null;
}

/** Where an operation stands: each step's state, how it ends, and its seconds so far (stopped once it ended). */
interface Progress { state: 'running' | 'failed' | 'succeeded'; steps: { label: string; state: StepState }[]; seconds: number }

function progress(operation: Operation, now: number): Progress {
  const elapsed = (now - operation.startedAt) / 1000;
  let spent = 0;
  let state: Progress['state'] = 'succeeded';
  const steps: Progress['steps'] = [];
  for (const [index, step] of PLANS[operation.kind].steps.entries()) {
    if (state !== 'succeeded') steps.push({ label: step.label, state: 'queued' });
    else if (elapsed - spent < step.seconds) { state = 'running'; steps.push({ label: step.label, state: 'running' }); }
    else if (operation.failAt === index) { state = 'failed'; spent += step.seconds; steps.push({ label: step.label, state: 'failed' }); }
    else { spent += step.seconds; steps.push({ label: step.label, state: 'succeeded' }); }
  }
  return { state, steps, seconds: Math.floor(state === 'running' ? elapsed : spent) };
}

const STEP_BADGE: Record<StepState, { label: string; color: 'gray' | 'amber' | 'green' | 'red' }> = {
  queued: { label: 'Waiting', color: 'gray' }, running: { label: 'Running', color: 'amber' }, succeeded: { label: 'Done', color: 'green' }, failed: { label: 'Failed', color: 'red' },
};

/** An operation where the change it makes shows: what it does, its steps, how long, and on failure the reason with
 * Retry and Dismiss. It runs on with the page closed. */
function OperationProgress({ operation, now, onRetry, onDismiss }: { operation: Operation; now: number; onRetry(): void; onDismiss(): void }): ReactElement {
  const shape = useShape();
  const plan = PLANS[operation.kind];
  const { state, steps, seconds } = progress(operation, now);
  const failed = state === 'failed';
  return <section aria-label={failed ? plan.failedTitle : plan.title} className={`flex flex-col gap-2 bg-surface-2 p-3 ${shape.container} [overflow-wrap:anywhere]`}>
    <div className="flex items-center gap-2">
      {failed ? null : <ThinkingIndicator size="compact" className="shrink-0 p-0 [&>span[aria-hidden]]:hidden" />}
      <span className={`text-body font-medium ${failed ? 'text-destructive' : 'text-foreground'}`}>{failed ? plan.failedTitle : plan.title}</span>
      <span className="ml-auto text-caption text-muted-foreground">{seconds} s</span>
    </div>
    <span className="font-mono text-caption text-muted-foreground">{operation.summary}</span>
    <ol aria-label="Steps" className="flex flex-col gap-1">
      {steps.map(step => <li key={step.label} className="flex min-w-0 items-center justify-between gap-3 text-caption text-foreground">
        <span className="min-w-0 truncate">{step.label}</span>
        <Badge variant="dot" size="compact" color={STEP_BADGE[step.state].color}>{STEP_BADGE[step.state].label}</Badge>
      </li>)}
    </ol>
    {failed
      ? <>
          <p role="alert" className="text-caption text-destructive">{plan.error}</p>
          <div className="flex gap-2">
            <Button variant="secondary" size="compact" leadingIcon={glyph(RefreshCcw01)} onClick={onRetry}>Retry</Button>
            <Button variant="ghost" size="compact" leadingIcon={glyph(XClose)} onClick={onDismiss}>Dismiss</Button>
          </div>
        </>
      : <span className="text-caption text-muted-foreground">Runs in the background: you can close this.</span>}
  </section>;
}

/** Project settings' layout: name, value, actions. */
function SettingRow({ label, value, note, actions }: { label: string; value: ReactNode; note?: ReactNode; actions?: ReactNode }): ReactElement {
  return <div className="grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-start gap-x-4 border-b border-border py-3 last:border-b-0">
    <span className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</span>
    <div className="flex min-w-0 flex-col gap-2 text-body">{value}{note ? <span className="text-caption text-muted-foreground">{note}</span> : null}</div>
    <div className="flex items-center gap-1">{actions}</div>
  </div>;
}

interface Workspace { name: string; archived: boolean }
interface MockState {
  baseBranch: string;
  /** The branch it was switched from, while the change is recent. */
  switchedFrom: string | null;
  behind: boolean;
  workspaces: readonly Workspace[];
  /** The project's operation, one at a time. */
  project: Operation | null;
  /** Each workspace's own operation. */
  workspace: Readonly<Record<string, Operation>>;
}

const INITIAL: MockState = {
  baseBranch: 'feat/agent-session-environments', switchedFrom: null, behind: true,
  workspaces: [{ name: 'native-shell-audit', archived: false }, { name: 'tauri-plugin-alarm-kit', archived: false }, { name: 'ux-review-zerbly', archived: false }, { name: 'sign-in-with-apple', archived: true }],
  project: null, workspace: {},
};

/** The mock's project and what its buttons do. */
interface Simulation {
  state: MockState;
  now: number;
  switchBase(branch: string): void;
  updateBase(): void;
  retryProject(): void;
  dismissProject(): void;
  runWorkspace(kind: Kind, name: string): void;
  dismissWorkspace(name: string): void;
  reset(): void;
}

function useSimulation(outcome: Outcome): Simulation {
  const [state, setState] = useState<MockState>(INITIAL);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(timer); }, []);
  // A failing operation fails on its second step, or its only one.
  const start = (kind: Kind, target: string, summary: string): Operation => ({ kind, target, summary, startedAt: Date.now(), failAt: outcome === 'fail' ? Math.min(1, PLANS[kind].steps.length - 1) : null });
  // An operation that finished changes what it acts on, once.
  const applied = useRef(new Set<Operation>());
  useEffect(() => {
    const finished = [state.project, ...Object.values(state.workspace)].filter((operation): operation is Operation => operation !== null && !applied.current.has(operation) && progress(operation, now).state === 'succeeded');
    if (!finished.length) return;
    for (const operation of finished) applied.current.add(operation);
    setState(current => {
      let next = current;
      for (const operation of finished) {
        if (operation.kind === 'switch') next = { ...next, baseBranch: 'develop', switchedFrom: next.baseBranch, behind: false, project: null };
        else if (operation.kind === 'update') next = { ...next, behind: false, project: null };
        else {
          const workspace = { ...next.workspace };
          delete workspace[operation.target];
          const workspaces = operation.kind === 'delete' ? next.workspaces.filter(item => item.name !== operation.target)
            : next.workspaces.map(item => item.name === operation.target ? { ...item, archived: operation.kind === 'archive' } : item);
          next = { ...next, workspaces, workspace };
        }
      }
      return next;
    });
  }, [now, state.project, state.workspace]);
  return {
    state, now,
    switchBase: (branch: string) => setState(current => ({ ...current, switchedFrom: null, project: start('switch', 'project', `${current.baseBranch} → ${branch}`) })),
    updateBase: () => setState(current => ({ ...current, project: start('update', 'project', `${current.baseBranch} → origin/${current.baseBranch} (12 commits)`) })),
    retryProject: () => setState(current => current.project ? { ...current, project: start(current.project.kind, 'project', current.project.summary) } : current),
    dismissProject: () => setState(current => ({ ...current, project: null })),
    runWorkspace: (kind: Kind, name: string) => setState(current => ({ ...current, workspace: { ...current.workspace, [name]: start(kind, name, name) } })),
    dismissWorkspace: (name: string) => setState(current => { const workspace = { ...current.workspace }; delete workspace[name]; return { ...current, workspace }; }),
    reset: () => { applied.current.clear(); setState(INITIAL); },
  };
}

/** The base branch setting: Change opens its field; Save starts the switch, which shows here until it ends. */
function BaseBranchRow({ sim }: { sim: Simulation }): ReactElement {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('develop');
  const operation = sim.state.project;
  const switching = operation?.kind === 'switch';
  return <SettingRow label="Base branch"
    value={editing
      ? <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (value.trim() && value.trim() !== sim.state.baseBranch) { sim.switchBase(value.trim()); setEditing(false); } }}>
          <InputGroup><InputField index={0} label="New base branch" placeholder={sim.state.baseBranch} value={value} onChange={setValue} autoFocus /></InputGroup>
          <p className="text-caption text-muted-foreground">Existing workspaces keep their branches. The switch runs in the background; you can close this dialog.</p>
          <div className="flex gap-2"><Button type="submit" variant="secondary" size="compact" disabled={!value.trim() || value.trim() === sim.state.baseBranch}>Save</Button><Button type="button" variant="ghost" size="compact" onClick={() => setEditing(false)}>Cancel</Button></div>
        </form>
      : <>
          <span className="font-mono text-caption">{sim.state.baseBranch}</span>
          {switching && operation ? <OperationProgress operation={operation} now={sim.now} onRetry={sim.retryProject} onDismiss={sim.dismissProject} /> : null}
        </>}
    note={!editing && !switching && sim.state.switchedFrom ? `Switched from ${sim.state.switchedFrom} just now.` : undefined}
    actions={editing || operation ? null : <Button variant="ghost" size="compact" onClick={() => setEditing(true)}>Change</Button>} />;
}

function SettingsDialog({ sim, open, onClose }: { sim: Simulation; open: boolean; onClose(): void }): ReactElement {
  const operation = sim.state.project;
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}><DialogContent className="max-w-2xl max-h-[90dvh] overflow-y-auto">
    <DialogHeader><DialogTitle>GitSpace settings</DialogTitle><DialogDescription>Settings shared by every workspace in this project.</DialogDescription></DialogHeader>
    <div className="flex flex-col">
      <SettingRow label="Repository" value={<span className="truncate font-mono text-caption">https://github.com/inKibra/gitspace.sh.git</span>} actions={operation ? null : <Button variant="ghost" size="compact">Change</Button>} />
      <BaseBranchRow sim={sim} />
      <SettingRow label="Origin"
        value={<>
          <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            {sim.state.behind ? <Badge size="compact" color="amber">Behind origin</Badge> : null}
            <span>origin/{sim.state.baseBranch} checked just now</span>
          </div>
          {operation?.kind === 'update' ? <OperationProgress operation={operation} now={sim.now} onRetry={sim.retryProject} onDismiss={sim.dismissProject} /> : null}
        </>}
        actions={operation ? null : <>{sim.state.behind ? <Button variant="secondary" size="compact" onClick={sim.updateBase}>Update base</Button> : null}<Button variant="ghost" size="compact" leadingIcon={glyph(RefreshCcw01)}>Check origin</Button></>} />
    </div>
    <DialogFooter><Button variant="secondary" onClick={onClose}>Done</Button></DialogFooter>
  </DialogContent></Dialog>;
}

/** The project's workspaces, each with its own operation while one runs or after one failed. */
function WorkspaceCards({ sim }: { sim: Simulation }): ReactElement {
  return <CardGroup orientation="inline" border="outlined" separated>
    {sim.state.workspaces.map((workspace, index) => {
      const operation = sim.state.workspace[workspace.name];
      const status = operation ? progress(operation, sim.now) : null;
      const failed = status?.state === 'failed';
      const running = status?.state === 'running' ? status.steps.find(step => step.state === 'running')?.label : undefined;
      const description = operation && status
        ? failed
          ? <span className="inline-flex items-center gap-1.5 text-destructive"><StatusDot color="red" />{PLANS[operation.kind].failedTitle}: {PLANS[operation.kind].error}</span>
          : <span className="inline-flex items-center gap-1.5"><StatusDot color="blue" pulse />{PLANS[operation.kind].title} · {running?.toLowerCase()}</span>
        : workspace.archived ? 'Archived' : <span className="inline-flex items-center gap-1.5"><StatusDot color="green" />Waiting</span>;
      return <Card key={workspace.name} index={index} size="compact" label={`Open ${workspace.name}`}>
        <CardHeader>
          <CardTitle>{workspace.archived ? <span className="flex items-center gap-2 text-muted-foreground"><Archive width={14} height={14} strokeWidth={1.5} />{workspace.name}</span> : workspace.name}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardFooter>
          {operation && failed
            ? <>
                <Tooltip content={`Retry ${operation.kind}`} side="top"><Button variant="ghost" size="icon-compact" aria-label={`Retry ${operation.kind}`} onClick={() => sim.runWorkspace(operation.kind, workspace.name)}><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
                <Tooltip content="Dismiss" side="top"><Button variant="ghost" size="icon-compact" aria-label="Dismiss" onClick={() => sim.dismissWorkspace(workspace.name)}><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
              </>
            : operation ? null
            : <>
                {workspace.archived
                  ? <Tooltip content="Restore workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Restore ${workspace.name}`} onClick={() => sim.runWorkspace('restore', workspace.name)}><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
                  : <Tooltip content="Archive workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Archive ${workspace.name}`} onClick={() => sim.runWorkspace('archive', workspace.name)}><Archive width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>}
                <Tooltip content="Delete workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Delete ${workspace.name}`} onClick={() => { if (window.confirm(`Delete ${workspace.name}? Its conversations, files and cloud records are removed. This cannot be undone.`)) sim.runWorkspace('delete', workspace.name); }}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip>
              </>}
        </CardFooter>
      </Card>;
    })}
  </CardGroup>;
}

function ProjectsPage({ sim, onOpenSettings }: { sim: Simulation; onOpenSettings(): void }): ReactElement {
  return <>
    <SidebarInsetTopbar><span className="text-body font-medium">Projects</span></SidebarInsetTopbar>
    <PageCanvas>
      <PageHeader title="Projects" description="Each project's workspaces, and the operations running on them." />
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-subtitle font-semibold text-foreground">GitSpace</h2>
          <Button variant="ghost" size="compact" leadingIcon={glyph(Settings01)} onClick={onOpenSettings}>Project settings</Button>
        </div>
        <WorkspaceCards sim={sim} />
      </section>
    </PageCanvas>
  </>;
}

/** The project page's top bar says what runs on the project, and opens its settings to the operation. */
function ProjectPage({ sim, onOpenSettings }: { sim: Simulation; onOpenSettings(): void }): ReactElement {
  const operation = sim.state.project;
  const status = operation ? progress(operation, sim.now) : null;
  const failed = status?.state === 'failed';
  return <>
    <SidebarInsetTopbar>
      <span className="inline-flex min-w-0 flex-1 items-center gap-2 truncate text-body">
        <span className="font-medium">GitSpace</span>
        <span className="inline-flex items-center gap-1 font-mono text-caption text-muted-foreground"><GitBranch01 width={12} height={12} strokeWidth={1.5} />{sim.state.baseBranch}</span>
      </span>
      {operation && status
        ? <Button variant="ghost" size="compact" onClick={onOpenSettings}><span className={`flex items-center gap-2 text-caption ${failed ? 'text-destructive' : 'text-muted-foreground'}`}><StatusDot color={failed ? 'red' : 'blue'} pulse={!failed} />{failed ? `${PLANS[operation.kind].failedTitle} · Details` : `${PLANS[operation.kind].title} · ${status.steps.find(step => step.state === 'running')?.label ?? ''}`}</span></Button>
        : <span className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color="green" />Ready</span>}
    </SidebarInsetTopbar>
    <div className="flex min-h-0 flex-1 flex-col items-center gap-3 overflow-y-auto px-6 pt-10">
      <p className="max-w-xl text-caption text-muted-foreground">The project agent's conversation shows here as it does today. The agent keeps working while the operation runs; it learns the outcome from the operation's record.</p>
      <Button variant="secondary" size="compact" leadingIcon={glyph(Settings01)} onClick={onOpenSettings}>Project settings</Button>
    </div>
  </>;
}

/** Today: Save holds the request open until the browser gives up, and the outcome is unknown. */
function TodayPage(): ReactElement {
  const [phase, setPhase] = useState<'idle' | 'saving' | 'timed-out'>('idle');
  useEffect(() => {
    if (phase !== 'saving') return;
    const timer = setTimeout(() => setPhase('timed-out'), 6000);
    return () => clearTimeout(timer);
  }, [phase]);
  return <>
    <SidebarInsetTopbar><span className="text-body font-medium">Projects</span></SidebarInsetTopbar>
    <PageCanvas>
      <PageHeader title="Today" description="Save holds the request open for the whole switch; the browser gives up after 5 minutes (6 s here)." />
      <Dialog open><DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>GitSpace settings</DialogTitle><DialogDescription>Settings shared by every workspace in this project.</DialogDescription></DialogHeader>
        <SettingRow label="Base branch" value={<form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); setPhase('saving'); }}>
          <InputGroup><InputField index={0} label="New base branch" placeholder="feat/agent-session-environments" value="develop" onChange={() => undefined} disabled={phase === 'saving'} /></InputGroup>
          <p className="text-caption text-muted-foreground">Existing workspaces keep their branches; stack status will compare against the new base. The project’s base space must be open and have no uncommitted changes.</p>
          {phase === 'timed-out' ? <p role="alert" className="text-caption text-destructive">Change base branch: The request timed out. Its outcome may be unknown; refresh before trying again.</p> : null}
          <div className="flex gap-2"><Button type="submit" variant="secondary" size="compact" loading={phase === 'saving'}>Save</Button><Button type="button" variant="ghost" size="compact" disabled={phase === 'saving'} onClick={() => setPhase('idle')}>Cancel</Button></div>
        </form>} />
      </DialogContent></Dialog>
    </PageCanvas>
  </>;
}

function MockSidebar({ sim, view, onView }: { sim: Simulation; view: View; onView(view: View): void }): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets & values', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  const operations = [sim.state.project, ...Object.values(sim.state.workspace)].filter((operation): operation is Operation => operation !== null).map(operation => ({ operation, status: progress(operation, sim.now) }));
  const failed = operations.filter(item => item.status.state === 'failed');
  const running = operations.filter(item => item.status.state === 'running');
  const summary = [running.length ? `${running.length} running` : null, failed.length ? `${failed.length} failed` : null].filter(Boolean).join(', ');
  const GitSpaceDot: IconComponent = function GitSpaceDot() { return <StatusDot color={failed.length ? 'red' : 'blue'} pulse={!failed.length && running.length > 0} />; };
  const IdleDot: IconComponent = function IdleDot() { return <StatusDot color="blue" />; };
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible><SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon} isActive={view === 'settings' && item.label === 'Projects'} onClick={item.label === 'Projects' ? () => onView('settings') : undefined}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup collapsible><SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem>
            <Tooltip content={summary ? `GitSpace: operations ${summary}` : 'GitSpace'} side="right">
              <SidebarMenuButton icon={GitSpaceDot} isActive={view === 'project'} onClick={() => onView('project')}>GitSpace</SidebarMenuButton>
            </Tooltip>
          </SidebarMenuItem>
          {['Golconda IDF Data Vault', 'Golconda PPVA Enrollment', 'Landscaping Portal', 'inkibra core'].map(name => <SidebarMenuItem key={name}><SidebarMenuButton icon={IdleDot}>{name}</SidebarMenuButton></SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>} menu={<MenuItem index={0} label="Settings" onSelect={() => undefined} />} /></SidebarFooter>
  </Sidebar>;
}

const VIEWS: readonly { id: View; label: string }[] = [{ id: 'settings', label: 'Projects page' }, { id: 'project', label: 'Project page' }, { id: 'today', label: 'Today: the request held open' }];

function OperationProgressMock(): ReactElement {
  const params = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>(VIEWS.find(item => item.id === params.get('view'))?.id ?? 'settings');
  const [outcome, setOutcome] = useState<Outcome>(params.get('outcome') === 'fail' ? 'fail' : 'succeed');
  const [settingsOpen, setSettingsOpen] = useState(view === 'settings');
  const sim = useSimulation(outcome);
  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <MockSidebar sim={sim} view={view} onView={setView} />
      <SidebarInset className="min-w-0">
        {view === 'settings' ? <ProjectsPage sim={sim} onOpenSettings={() => setSettingsOpen(true)} />
          : view === 'project' ? <ProjectPage sim={sim} onOpenSettings={() => setSettingsOpen(true)} />
          : <TodayPage />}
      </SidebarInset>
    </SidebarProvider>
    {view === 'today' ? null : <SettingsDialog sim={sim} open={settingsOpen} onClose={() => setSettingsOpen(false)} />}
    <div className="fixed bottom-4 right-4 z-[60] flex gap-2">
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{VIEWS.find(item => item.id === view)?.label} (mock)</Button>} />
        <DropdownContent align="end" className="w-[240px] min-w-[240px]">
          {VIEWS.map((item, index) => <MenuItem key={item.id} index={index} label={item.label} onSelect={() => setView(item.id)} />)}
        </DropdownContent>
      </DropdownMenu>
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">Next operation {outcome === 'fail' ? 'fails' : 'succeeds'} (mock)</Button>} />
        <DropdownContent align="end" className="w-[240px] min-w-[240px]">
          <MenuItem index={0} label="Next operation succeeds" onSelect={() => setOutcome('succeed')} />
          <MenuItem index={1} label="Next operation fails" onSelect={() => setOutcome('fail')} />
        </DropdownContent>
      </DropdownMenu>
      <Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1" onClick={sim.reset}>Reset (mock)</Button>
    </div>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <OperationProgressMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
