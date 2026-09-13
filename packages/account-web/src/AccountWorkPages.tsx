import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Select, SelectContent, SelectItem, SelectTrigger, TabsSubtle, TabsSubtleItem, Tooltip } from '@gitspace/ui';
import { Archive, Plus, RefreshCcw01, Trash01, XClose } from '@untitledui/icons';
import { useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AccountSidebarContext, type SidebarSpaceSummary } from './AppSidebar.js';
import { CreateProjectDialog, CreateWorkspaceDialog, EmptyState, PageCanvas, PageHeader, PHASE_LABEL, PHASES, StatusDot, spaceHolderLabel, workspacePhaseLabel, workspaceStatusLabel, type GitSpaceShellProps, type ProjectLifecycleView, type SpaceHolderView, type WorkspaceView } from './GitSpaceShell.js';
import { WorkspaceGraph, type WorkspaceGraphItem } from './WorkspaceGraph.js';
import type { Directory } from './useAccountDirectory.js';
import { glyph } from './glyph.js';
import { navigateProductUrl, setProductRoute } from './routes.js';

export interface AccountWorkPagesProps {
  view: 'kanban' | 'projects' | 'inbox';
  projects: readonly ProjectLifecycleView[];
  directory: Directory;
  loading: boolean;
  onRefresh(): void;
  onOpenWorkspace(projectId: string, workspaceId: string): void;
  onOpenProject(projectId: string): void;
  actions: Pick<GitSpaceShellProps, 'onCreateProject' | 'onCreateWorkspace' | 'onCloseSpace' | 'onReopenSpace' | 'onArchiveWorkspace' | 'onClaimWorkspace' | 'onArchiveProject' | 'onRestoreProject' | 'onDeleteProject' | 'onDeleteWorkspace' | 'onSetWorkspaceRelations'>;
}

interface AccountWorkspace extends WorkspaceGraphItem {
  holder: SpaceHolderView;
  statusLabel: string;
  freshness: 'fresh' | 'stale' | 'unknown';
}

function selectOptions(options: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}

function summaryFreshness(summary: SidebarSpaceSummary | undefined): 'fresh' | 'stale' | 'unknown' {
  return summary?.freshness ?? (summary?.status ? 'fresh' : 'unknown');
}

function summaryStatusLabel(summary: SidebarSpaceSummary | undefined): string {
  if (!summary) return 'Status unknown';
  const freshness = summaryFreshness(summary);
  const label = summary.status?.primaryColor === 'dim' ? 'No activity recorded' : workspaceStatusLabel(summary);
  return freshness === 'stale' ? `Last recorded: ${label}` : freshness === 'unknown' ? 'Status unknown' : label;
}

function accountWorkspaces(projects: readonly ProjectLifecycleView[], directory: Directory): AccountWorkspace[] {
  return projects.flatMap((project) => (directory[project.id]?.workspaces ?? []).map((workspace) => ({
    id: workspace.id,
    projectId: project.id,
    projectName: project.name,
    name: workspace.name,
    branch: workspace.branch,
    closedAt: workspace.closedAt,
    // A saved null is deliberately unassigned; absent metadata is unknown.
    phase: workspace.definition ? workspace.definition.phase : workspace.runtime?.phase,
    holder: workspace.summary?.holder ?? { kind: 'unknown' as const },
    status: workspace.summary?.status,
    statusLabel: summaryStatusLabel(workspace.summary),
    freshness: summaryFreshness(workspace.summary),
    relations: workspace.runtime?.relations,
    stack: workspace.runtime?.stack,
  })));
}

function WorkspaceStatus({ workspace }: { workspace: AccountWorkspace }) {
  return <span className="flex items-center gap-2 text-caption text-muted-foreground" data-freshness={workspace.freshness}>
    <StatusDot color={workspace.status?.primaryColor ?? 'dim'} pulse={workspace.status?.primaryColor === 'green' && workspace.freshness === 'fresh'} />
    {workspace.statusLabel}
    {spaceHolderLabel(workspace) ? <span className="truncate text-muted-foreground/70">· {spaceHolderLabel(workspace)}</span> : null}
  </span>;
}

function DirectoryCoverage({ projects, directory, loading, onRefresh }: Pick<AccountWorkPagesProps, 'projects' | 'directory' | 'loading' | 'onRefresh'>) {
  const missing = projects.filter((project) => project.lifecycle !== 'cloud-only' && project.lifecycle !== 'deleting' && !directory[project.id]);
  const errors = projects.filter((project) => directory[project.id]?.error);
  return <div className="flex flex-col gap-1 px-8 pt-4 text-caption text-muted-foreground" aria-live="polite">
    <div className="flex items-center justify-between gap-3"><span>{loading ? 'Refreshing account directory…' : 'Account-wide saved workspaces and recorded status. Viewing does not open a workspace.'}</span><Button variant="ghost" size="compact" onClick={onRefresh} leadingIcon={glyph(RefreshCcw01)}>Refresh</Button></div>
    {missing.length ? <p>Workspace coverage unavailable: {missing.map((project) => project.name).join(', ')}.</p> : null}
    {errors.map((project) => <p key={project.id} role="status">{project.name}: {directory[project.id]!.error} Saved entries remain visible; coverage may be incomplete.</p>)}
  </div>;
}

export function AccountWorkPages(props: AccountWorkPagesProps) {
  const { view, projects, directory, loading, onRefresh, onOpenWorkspace, onOpenProject, actions } = props;
  const accountSidebar = useContext(AccountSidebarContext);
  const current = useRef(props);
  current.current = props;
  const workspaces = useMemo(() => accountWorkspaces(projects, directory), [projects, directory]);
  const activeProjects = projects.filter((project) => project.lifecycle !== 'archived' && project.lifecycle !== 'deleting');
  const activeProjectIds = new Set(activeProjects.map((project) => project.id));
  const activeWorkspaces = workspaces.filter((workspace) => !workspace.closedAt && activeProjectIds.has(workspace.projectId));
  const [newWorkspacePhase, setNewWorkspacePhase] = useState<WorkspaceView['phase'] | null>(null);
  const [newWorkspaceProject, setNewWorkspaceProject] = useState<string | null>(null);
  const [newProject, setNewProject] = useState(false);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const clearCreate = () => { setNewWorkspacePhase(null); setNewWorkspaceProject(null); setError(null); };
  const open = (workspace: AccountWorkspace) => onOpenWorkspace(workspace.projectId, workspace.id);
  const canCreateProject = !!actions.onCreateProject;
  const canCreateWorkspace = !!actions.onCreateWorkspace;
  useLayoutEffect(() => {
    accountSidebar?.({
      view, selected: null, machines: [],
      projects: projects.map((project) => ({ id: project.id, name: project.name, lifecycle: project.lifecycle, ...directory[project.id], workspaces: directory[project.id]?.workspaces ?? [] })),
      onView: (next) => navigateProductUrl(setProductRoute(new URL(window.location.href), next)),
      onSelectProject: (id) => current.current.onOpenProject(id),
      onSelectWorkspace: (workspace) => current.current.onOpenWorkspace(workspace.projectId, workspace.id),
      onNewProject: canCreateProject ? () => setNewProject(true) : undefined,
      onNewWorkspace: canCreateWorkspace ? (projectId) => { setNewWorkspacePhase('code'); setNewWorkspaceProject(projectId); } : undefined,
    });
  }, [accountSidebar, view, projects, directory, canCreateProject, canCreateWorkspace]);
  useLayoutEffect(() => () => { accountSidebar?.(null); }, [accountSidebar]);
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    <DirectoryCoverage projects={projects} directory={directory} loading={loading} onRefresh={onRefresh} />
    {view === 'kanban' ? <KanbanView workspaces={activeWorkspaces} onOpen={open} onSetRelations={actions.onSetWorkspaceRelations} onNewWorkspace={actions.onCreateWorkspace ? setNewWorkspacePhase : undefined} />
      : view === 'projects' ? <ProjectsView projects={projects} workspaces={workspaces} directory={directory} onOpen={open} onOpenProject={onOpenProject} {...actions} onRestoreWorkspace={actions.onClaimWorkspace ? (workspaceId) => actions.onClaimWorkspace!(workspaceId, null) : undefined} />
        : <InboxView projects={activeProjects.filter((project) => project.lifecycle !== 'cloud-only')} directory={directory} onOpenWorkspace={onOpenWorkspace} onOpenProject={onOpenProject} />}
    <Dialog open={newWorkspacePhase !== null && newWorkspaceProject === null} onOpenChange={(next) => { if (!next) clearCreate(); }}>
      <DialogContent><DialogHeader><DialogTitle>Choose a project</DialogTitle><DialogDescription>Choose which project the new {newWorkspacePhase ? PHASE_LABEL[newWorkspacePhase].toLowerCase() : ''} workspace belongs to.</DialogDescription></DialogHeader>
        <CardGroup orientation="inline" border="outlined" separated>{activeProjects.filter((project) => project.lifecycle === 'active').map((project, index) => <Card key={project.id} index={index} onClick={() => setNewWorkspaceProject(project.id)} label={`Create workspace in ${project.name}`}><CardHeader><CardTitle>{project.name}</CardTitle><CardDescription>{project.baseBranch}</CardDescription></CardHeader></Card>)}</CardGroup>
        {!activeProjects.some((project) => project.lifecycle === 'active') ? <p className="text-body text-muted-foreground">Open a project from Projects before adding a workspace.</p> : null}
        <DialogFooter><Button variant="secondary" onClick={clearCreate}>Cancel</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    {actions.onCreateWorkspace && newWorkspaceProject ? <CreateWorkspaceDialog key={`${newWorkspaceProject}:${newWorkspacePhase}`} projectId={newWorkspaceProject} workspaces={workspaces} initialPhase={newWorkspacePhase ?? 'code'} pending={pending} error={error} onOpenChange={(next) => { if (!next) clearCreate(); }} onSubmit={async (input) => {
      if (pendingRef.current) return;
      pendingRef.current = true; setPending(true); setError(null);
      try { await actions.onCreateWorkspace!(input); clearCreate(); onRefresh(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { pendingRef.current = false; setPending(false); }
    }} /> : null}
    {actions.onCreateProject ? <CreateProjectDialog open={newProject} onOpenChange={(next) => { setNewProject(next); if (!next) setError(null); }} pending={pending} error={newProject ? error : null} onSubmit={async (input) => {
      if (pendingRef.current) return;
      pendingRef.current = true; setPending(true); setError(null);
      try { await actions.onCreateProject!(input); setNewProject(false); onRefresh(); }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
      finally { pendingRef.current = false; setPending(false); }
    }} /> : null}
  </div>;
}

function InboxView({ projects, directory, onOpenWorkspace, onOpenProject }: Pick<AccountWorkPagesProps, 'projects' | 'directory' | 'onOpenWorkspace' | 'onOpenProject'>) {
  const scopes = projects.flatMap((project) => [
    { key: `base:${project.id}`, name: `${project.name} · Base agent`, summary: directory[project.id]?.baseSummary, open: () => onOpenProject(project.id) },
    ...(directory[project.id]?.workspaces ?? []).filter((workspace) => !workspace.closedAt).map((workspace) => ({ key: workspace.id, name: `${project.name} · ${workspace.name}`, summary: workspace.summary, open: () => onOpenWorkspace(project.id, workspace.id) })),
  ]);
  const attention = scopes.flatMap((scope) => {
    const status = scope.summary?.status;
    if (!status) return [];
    const reasons = [
      status.agents.orange ? `${status.agents.orange} ${status.agents.orange === 1 ? 'agent needs' : 'agents need'} permission` : null,
      status.agents.blue ? `${status.agents.blue} agent${status.agents.blue === 1 ? '' : 's'} waiting` : null,
      status.agents.red ? `${status.agents.red} agent error${status.agents.red === 1 ? '' : 's'}` : null,
      status.services.red ? `${status.services.red} service error${status.services.red === 1 ? '' : 's'}` : null,
      status.terminals.red ? `${status.terminals.red} terminal error${status.terminals.red === 1 ? '' : 's'}` : null,
    ].filter(Boolean);
    return reasons.length ? [{ ...scope, reasons }] : [];
  });
  const incomplete = scopes.filter((scope) => !scope.summary?.status || summaryFreshness(scope.summary) !== 'fresh');
  return <PageCanvas>
    <PageHeader kicker="Attention" title="Inbox" description="Recorded waits and errors across project agents, workspace agents, services, and terminals." actions={<span className="text-caption text-muted-foreground tabular-nums">{attention.length} {attention.length === 1 ? 'space' : 'spaces'} with recorded attention</span>} />
    {attention.length ? <CardGroup orientation="inline" border="outlined" separated>{attention.map((item, index) => <Card key={item.key} index={index} onClick={item.open} label={`Open ${item.name}`}><CardHeader><CardTitle>{item.name}</CardTitle><CardDescription>{item.reasons.join(' · ')}</CardDescription></CardHeader><CardContent><Badge size="compact" color={summaryFreshness(item.summary) === 'fresh' ? 'amber' : 'gray'}>{summaryFreshness(item.summary) === 'fresh' ? 'Recorded attention' : summaryFreshness(item.summary) === 'stale' ? 'Last recorded · stale' : 'Freshness unknown'}</Badge></CardContent></Card>)}</CardGroup>
      : <EmptyState title="No attention recorded" description={incomplete.length || projects.some((project) => !directory[project.id] || directory[project.id]?.error) ? 'Status coverage is incomplete. Unavailable or stale reports cannot establish that nothing needs attention.' : 'The available status summaries contain no recorded waits or errors.'} />}
    {incomplete.length ? <section className="flex flex-col gap-3 pt-8"><h2 className="text-subtitle font-semibold text-foreground">Status coverage</h2><p className="text-body text-muted-foreground">These spaces have unknown or stale reports; their current agents, services, and terminals have not been confirmed.</p><CardGroup orientation="inline" border="outlined" separated>{incomplete.map((scope, index) => <Card key={scope.key} index={index} onClick={scope.open} label={`Inspect ${scope.name}`}><CardHeader><CardTitle>{scope.name}</CardTitle><CardDescription>{summaryFreshness(scope.summary) === 'stale' ? 'Stale status · last recorded only' : 'Status unknown'}{scope.summary?.detail ? ` · ${scope.summary.detail}` : ''}</CardDescription></CardHeader></Card>)}</CardGroup></section> : null}
  </PageCanvas>;
}
function KanbanView({ workspaces, onOpen, onSetRelations, onNewWorkspace }: { workspaces: readonly AccountWorkspace[]; onOpen: (workspace: AccountWorkspace) => void; onSetRelations?: GitSpaceShellProps['onSetWorkspaceRelations']; onNewWorkspace?: (phase: WorkspaceView['phase']) => void }) {
  const [graph, setGraph] = useState(false);
  const blocked = workspaces.filter((workspace) => workspace.stack?.blockedBy.length).length;
  const header = <>
    <PageHeader kicker="Work" title="Kanban" actions={<span className="text-caption text-muted-foreground tabular-nums">{workspaces.length} workspaces{blocked ? ` · ${blocked} blocked` : ''}</span>} />
    <TabsSubtle size="compact" className="mb-4 self-start" selectedIndex={graph ? 1 : 0} onSelect={(index) => setGraph(index === 1)} aria-label="Kanban view"><TabsSubtleItem index={0} label="Board" /><TabsSubtleItem index={1} label="Graph" /></TabsSubtle>
  </>;
  if (graph) {
    return <div className="flex min-h-0 flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-6xl flex-col px-8 pt-8">{header}</div>
      <div className="mx-auto min-h-0 w-full max-w-6xl flex-1 px-8 pb-8"><WorkspaceGraph workspaces={workspaces} onSelect={(id) => { const target = workspaces.find((workspace) => workspace.id === id); if (target) onOpen(target); }} onSetRelations={onSetRelations} height="100%" /></div>
    </div>;
  }
  return <PageCanvas className="flex max-w-6xl flex-col">
    {header}
    <div className="grid grid-cols-4 gap-4 max-md:grid-cols-1">
      {[...PHASES, ...(workspaces.some((workspace) => workspace.phase === null) ? [null] : []), ...(workspaces.some((workspace) => workspace.phase === undefined) ? [undefined] : [])].map((phase) => {
        const items = workspaces.filter((workspace) => workspace.phase === phase);
        return <section key={phase === null ? 'unassigned' : phase ?? 'unknown'} aria-label={workspacePhaseLabel(phase)} className="flex min-w-0 flex-col gap-2">
          <header className="flex items-center justify-between gap-1 px-1"><span className="text-caption font-medium text-muted-foreground">{workspacePhaseLabel(phase)}</span><span className="flex items-center gap-1"><span className="tabular-nums text-caption text-muted-foreground">{items.length}</span>{onNewWorkspace && phase != null ? <Tooltip content={`New ${PHASE_LABEL[phase].toLowerCase()} workspace`} side="top"><Button variant="ghost" size="icon-compact" aria-label={`New workspace in ${PHASE_LABEL[phase]}`} onClick={() => onNewWorkspace(phase)}><Plus width={14} height={14} strokeWidth={1.5} /></Button></Tooltip> : null}</span></header>
          <CardGroup border="outlined">
            {items.map((workspace, index) => <Card key={workspace.id} index={index} onClick={() => onOpen(workspace)} label={`Open ${workspace.name}`}>
              <CardHeader>
                <CardDescription>{workspace.projectName}</CardDescription>
                <CardTitle>{workspace.name}</CardTitle>
              </CardHeader>
              <CardFooter>
                <WorkspaceStatus workspace={workspace} />
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {workspace.relations?.stackedOn ? <Badge variant="dot" size="compact" color="blue" title={`Stacked on ${workspaces.find((candidate) => candidate.id === workspace.relations?.stackedOn)?.name ?? workspace.relations.stackedOn}`}>stacked</Badge> : null}
                  {workspace.stack?.blockedBy.length ? <Badge size="compact" color="amber">blocked · {workspace.stack.blockedBy.length}</Badge> : null}
                </span>
              </CardFooter>
            </Card>)}
          </CardGroup>
        </section>;
      })}
    </div>
    {!workspaces.length ? <EmptyState title="No active workspaces in the available directory" description="Create a workspace in a project, or refresh if project coverage is incomplete." /> : null}
  </PageCanvas>;
}
function ProjectsView({ projects, workspaces, directory, onOpen, onOpenProject, onCloseSpace, onReopenSpace, onArchiveWorkspace, onRestoreWorkspace, onCreateProject, onCreateWorkspace, onArchiveProject, onRestoreProject, onDeleteProject, onDeleteWorkspace }: {
  projects: readonly ProjectLifecycleView[];
  workspaces: readonly AccountWorkspace[];
  directory: Directory;
  onOpen: (workspace: AccountWorkspace) => void;
  onOpenProject?: (projectId: string) => void;
  onCloseSpace?: GitSpaceShellProps['onCloseSpace'];
  onReopenSpace?: GitSpaceShellProps['onReopenSpace'];
  onArchiveWorkspace?: GitSpaceShellProps['onArchiveWorkspace'];
  onRestoreWorkspace?: (workspaceId: string) => void | Promise<void>;
  onCreateProject?: GitSpaceShellProps['onCreateProject'];
  onCreateWorkspace?: GitSpaceShellProps['onCreateWorkspace'];
  onArchiveProject?: GitSpaceShellProps['onArchiveProject'];
  onRestoreProject?: GitSpaceShellProps['onRestoreProject'];
  onDeleteProject?: GitSpaceShellProps['onDeleteProject'];
  onDeleteWorkspace?: GitSpaceShellProps['onDeleteWorkspace'];
}) {
  const [filter, setFilter] = useState<'active' | 'archived' | 'all'>('active');
  const [projectDialog, setProjectDialog] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const visible = projects.filter((project) => filter === 'all' || (filter === 'archived' ? project.lifecycle === 'archived' : project.lifecycle !== 'archived' && project.lifecycle !== 'deleting'));
  const run = async (action: () => void | Promise<void>, close?: () => void): Promise<void> => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    try { await action(); close?.(); } catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); } finally { pendingRef.current = false; setPending(false); }
  };
  return <PageCanvas>
    <PageHeader kicker="Repositories" title="Projects" actions={<>
      <Select value={filter} onValueChange={(value) => setFilter(value as typeof filter)}><SelectTrigger aria-label="Project filter" />{selectOptions([{ value: 'active', label: 'Active' }, { value: 'archived', label: 'Archived' }, { value: 'all', label: 'All' }])}</Select>
      {onCreateProject ? <Button variant="primary" onClick={() => setProjectDialog(true)} leadingIcon={glyph(Plus)}>New project</Button> : null}
    </>} />
    <div className="flex flex-col gap-6">
      {visible.map((project) => {
        const items = workspaces.filter((workspace) => workspace.projectId === project.id);
        const open = items.filter((workspace) => !workspace.closedAt && workspace.holder.kind !== 'released');
        const runtimeClosed = items.filter((workspace) => !workspace.closedAt && workspace.holder.kind === 'released');
        const archived = items.filter((workspace) => !!workspace.closedAt);
        return <section key={project.id} className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <button type="button" className="flex min-h-10 min-w-0 items-center gap-2 text-left" onClick={() => onOpenProject?.(project.id)}>
              <span className="truncate text-title font-semibold text-foreground">{project.name}</span>
              <Badge variant="dot" size="compact" color={project.lifecycle === 'active' ? 'green' : project.lifecycle === 'archived' || project.lifecycle === 'cloud-only' ? 'gray' : 'amber'}>{project.lifecycle === 'cloud-only' ? 'Cloud only' : project.lifecycle}</Badge>
              {project.role === 'gitspace-source' ? <Badge size="compact" color="gray">Built in</Badge> : null}
            </button>
            <div className="flex items-center gap-1">
              {project.lifecycle === 'active' && onCreateWorkspace ? <Button variant="secondary" size="compact" onClick={() => setWorkspaceDialog(project.id)} leadingIcon={glyph(Plus)}>Workspace</Button> : null}
              {project.role !== 'gitspace-source' && project.lifecycle === 'active' && onArchiveProject ? <Button variant="ghost" size="compact" disabled={pending} onClick={() => void run(() => onArchiveProject(project.id, project.revision))} leadingIcon={glyph(Archive)}>Archive</Button> : null}
              {project.lifecycle === 'archived' && onRestoreProject ? <Button variant="ghost" size="compact" disabled={pending} onClick={() => void run(() => onRestoreProject(project.id, project.revision))} leadingIcon={glyph(RefreshCcw01)}>Restore</Button> : null}
              {project.role !== 'gitspace-source' && project.lifecycle === 'archived' && onDeleteProject ? <Button variant="ghost" size="compact" disabled={pending} onClick={() => void run(() => onDeleteProject(project.id, project.revision))} leadingIcon={glyph(Trash01)}>Delete</Button> : null}
            </div>
          </div>
          <CardGroup orientation="inline" border="outlined" separated>
            {open.map((workspace, index) => <Card key={workspace.id} index={index} size="compact" onClick={() => onOpen(workspace)} label={`Open ${workspace.name}`}>
              <CardHeader>
                <CardTitle>{workspace.name}</CardTitle>
                <CardDescription><span className="font-mono">{workspace.branch}</span></CardDescription>
                <WorkspaceStatus workspace={workspace} />
              </CardHeader>
              <CardContent><Badge variant="dot" size="compact" color="gray">{workspacePhaseLabel(workspace.phase)}</Badge></CardContent>
              <CardFooter>
                {onCloseSpace ? <Tooltip content="Close space" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Close ${workspace.name}`} disabled={pending} onClick={() => void run(() => onCloseSpace(workspace.id))}><XClose width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
                {onArchiveWorkspace ? <Tooltip content="Archive workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Archive ${workspace.name}`} disabled={pending} onClick={() => void run(() => onArchiveWorkspace(workspace.id))}><Archive width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
              </CardFooter>
            </Card>)}
            {runtimeClosed.map((workspace, index) => <Card key={workspace.id} index={open.length + index} size="compact" onClick={() => onOpen(workspace)} label={`Open ${workspace.name}`}>
              <CardHeader><CardTitle><span className="flex items-center gap-2 text-muted-foreground"><XClose width={14} height={14} strokeWidth={1.5} />{workspace.name}</span></CardTitle><CardDescription>Closed · released to cloud</CardDescription><WorkspaceStatus workspace={workspace} /></CardHeader>
              <CardContent><Badge variant="dot" size="compact" color="gray">{workspacePhaseLabel(workspace.phase)}</Badge></CardContent>
              <CardFooter>
                {onReopenSpace ? <Tooltip content="Reopen space" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Reopen ${workspace.name}`} disabled={pending} onClick={() => void run(() => onReopenSpace(workspace.id))}><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
                {onArchiveWorkspace ? <Tooltip content="Archive workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Archive ${workspace.name}`} disabled={pending} onClick={() => void run(() => onArchiveWorkspace(workspace.id))}><Archive width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
              </CardFooter>
            </Card>)}
            {archived.map((workspace, index) => <Card key={workspace.id} index={open.length + runtimeClosed.length + index} size="compact" onClick={() => onOpen(workspace)} label={`Open ${workspace.name}`}>
              <CardHeader>
                <CardTitle><span className="flex items-center gap-2 text-muted-foreground"><Archive width={14} height={14} strokeWidth={1.5} />{workspace.name}</span></CardTitle>
                <CardDescription>Archived</CardDescription>
              </CardHeader>
              <CardFooter>
                {onRestoreWorkspace ? <Tooltip content="Restore workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Restore ${workspace.name}`} disabled={pending} onClick={() => void run(() => onRestoreWorkspace(workspace.id))}><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
                {onDeleteWorkspace ? <Tooltip content="Delete workspace" side="top"><Button variant="ghost" size="icon-compact" aria-label={`Delete ${workspace.name}`} disabled={pending} onClick={() => void run(() => onDeleteWorkspace(workspace.id))}><Trash01 width={16} height={16} strokeWidth={1.5} /></Button></Tooltip> : null}
              </CardFooter>
            </Card>)}
          </CardGroup>
          {!items.length ? <p className="text-caption text-muted-foreground">{!directory[project.id] || directory[project.id]?.error ? 'Saved workspaces are unavailable. Refresh to check this project.' : 'No saved workspaces.'}</p> : null}
        </section>;
      })}
      {!visible.length ? <EmptyState title="No projects" description={filter === 'archived' ? 'Nothing is archived.' : 'Create a project or import a repository to start.'} /> : null}
    </div>
    {error && !projectDialog && workspaceDialog === null ? <p role="alert" className="pt-4 text-caption text-destructive">{error}</p> : null}
    {onCreateProject ? <CreateProjectDialog open={projectDialog} onOpenChange={(open) => { setProjectDialog(open); if (!open) setError(null); }} pending={pending} error={projectDialog ? error : null} onSubmit={(input) => run(() => onCreateProject(input), () => setProjectDialog(false))} /> : null}
    {onCreateWorkspace ? <CreateWorkspaceDialog key={workspaceDialog ?? 'closed'} projectId={workspaceDialog} workspaces={workspaces} onOpenChange={(open) => { if (!open) { setWorkspaceDialog(null); setError(null); } }} pending={pending} error={workspaceDialog ? error : null} onSubmit={(input) => run(() => onCreateWorkspace(input), () => setWorkspaceDialog(null))} /> : null}
  </PageCanvas>;
}
