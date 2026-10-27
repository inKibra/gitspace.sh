import type { DeploymentStatusView } from '@gitspace/protocol';
import type { CloudWorkspaceDefinition, RemoteBranchState } from '@gitspace/protocol/project-authority';
import type { IconComponentProps } from '@gitspace/ui';
import {
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  MenuItem,
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupActions,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuActions,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarUserFooter,
  SidebarWorkspaceHeader,
  ThinkingIndicator,
  Tooltip,
  WorkspaceTile,
  type IconComponent,
} from '@gitspace/ui';
import { Activity, Archive, ArrowDown, ChevronRight, Columns03, DotsHorizontal, FolderClosed, FolderPlus, Key01, Plus, PuzzlePiece01, RefreshCcw01, Rocket02, Settings01, Square, Stars01, Trash01, Zap } from '@untitledui/icons';
import { createContext, useContext, useState, type Dispatch, type SetStateAction } from 'react';
import { glyph } from './glyph.js';
import { converging, latestLaunchProgress, launchPhaseLabel, machineConvergence, RELEASE_TARGETS, runningLabel, workspaceRelease, type LaunchTrack } from './release.js';
import { PRODUCT_ROUTE_LABELS, type AppView, type ProductRoute } from './routes.js';
import { StatusDot, workspaceStatusColor, workspaceStatusLabel, WorkspaceStatusDot, type AgentScopeView, type ProjectAgentView, type ProjectLifecycleView, type WorkspaceCreationState, type WorkspaceView } from './GitSpaceShell.js';

const NAV: Array<{ view: Exclude<AppView, 'agent'>; icon: IconComponent }> = [
  { view: 'kanban', icon: glyph(Columns03) },
  { view: 'projects', icon: glyph(FolderClosed) },
  { view: 'inference', icon: glyph(Stars01) },
  { view: 'plugins', icon: glyph(PuzzlePiece01) },
  { view: 'skills', icon: glyph(Stars01) },
  { view: 'automations', icon: glyph(Zap) },
  { view: 'secrets', icon: glyph(Key01) },
  { view: 'monitoring', icon: glyph(Activity) },
];


/** Self-development surface for the sidebar: the Source pill, launched-row badges, and launch actions. */
export interface SidebarDeploymentProps {
  status: DeploymentStatusView;
  /** The launch this browser follows (in flight or the last one), or null when none is known. */
  launch: LaunchTrack | null;
  /** Launch actions are offered only inside the GitSpace project itself. */
  isGitSpaceProject: boolean;
  /** Launch every target from the workspace, or from the project's base space by its project id. */
  onLaunch(workspaceId: string): void | Promise<void>;
  /** Check the canonical branch head, then launch every target from that commit. */
  onLaunchCanonical(): void | Promise<void>;
  /** Point the account back at the channel build. */
  onRevert(): void | Promise<void>;
}

export interface SidebarSpaceSummary {
  holder: AgentScopeView['holder'];
  closedAt: Date | null;
  generation?: number;
  status?: AgentScopeView['status'];
  detail?: string | null;
  freshness?: 'fresh' | 'stale' | 'unknown';
  refreshing?: boolean;
  /** Set while the cloud definition is still being created or its creation failed; no placement or runtime applies. */
  creation?: WorkspaceCreationState;
}

function summaryLabel(summary: SidebarSpaceSummary): string {
  const status = workspaceStatusLabel(summary);
  if (summary.closedAt) return status;
  if (summary.status || summary.holder.kind === 'released') return [status, summary.detail].filter(Boolean).join(' · ');
  return summary.detail ?? status;
}

const SpaceSummaryContext = createContext<SidebarSpaceSummary | undefined>(undefined);
const ArchiveGlyph = glyph(Archive);
const DeleteGlyph = glyph(Trash01);
const ReopenGlyph = glyph(RefreshCcw01);
const CloseGlyph = glyph(Square);
const LaunchGlyph = glyph(Rocket02);
const SettingsGlyph = glyph(Settings01);
const ProjectGlyph = glyph(FolderClosed);
const NewWorkspaceGlyph = glyph(Plus);
const AutomationsGlyph = glyph(Zap);

/** Icon slots take component types, so keep this type stable while context updates the accepted status. */
function SpaceStatusGlyph({ className, size, strokeWidth }: IconComponentProps) {
  const summary = useContext(SpaceSummaryContext);
  const freshness = summary?.freshness ?? (summary?.status ? 'fresh' : 'unknown');
  return <span className={`inline-flex items-center justify-center ${className ?? ''}`} style={{ width: size, height: size }} data-freshness={freshness}>
    {summary?.closedAt ? <ArchiveGlyph size={size} strokeWidth={strokeWidth} /> : summary ? <WorkspaceStatusDot space={summary} /> : <StatusDot color="dim" />}
  </span>;
}

export interface SidebarWorkspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  closedAt: Date | null;
  definition?: CloudWorkspaceDefinition;
  summary?: SidebarSpaceSummary;
}

/** The status a workspace row shows: its directory summary. An archived row is archived whatever it says. Pickers
 * offering the same workspace show this too. */
export function sidebarWorkspaceSummary(workspace: SidebarWorkspace): SidebarSpaceSummary | undefined {
  const supplied = workspace.summary;
  return workspace.closedAt ? { ...supplied, closedAt: workspace.closedAt, holder: supplied?.holder ?? { kind: 'unknown' } } : supplied;
}

export interface SidebarProject {
  id: string;
  name: string;
  lifecycle?: ProjectLifecycleView['lifecycle'];
  /** The base branch on the origin; null until first checked. */
  remote?: RemoteBranchState | null;
  base?: ProjectAgentView;
  baseSummary?: SidebarSpaceSummary;
  workspaces: SidebarWorkspace[];
  error?: string | null;
}

/** A running pane contributes runtime controls; the account owns navigation and lifecycle actions. */
export const AccountSidebarContext = createContext<Dispatch<SetStateAction<AppSidebarProps | null>> | null>(null);

export interface AppSidebarProps {
  view: ProductRoute;
  onView(view: AppView): void;
  selected: { projectId: string; workspaceId: string | null } | null;
  /** The open pane's status (the header's exact object); the selected row renders it, so the two cannot disagree. */
  selectedSummary?: SidebarSpaceSummary;
  projects: readonly SidebarProject[];
  machines: Array<{ id: string; label: string }>;
  onSelectProject?(projectId: string): void;
  onSelectWorkspace(workspace: SidebarWorkspace): void;
  onReleaseMachines?(spaceId: string): void | Promise<void>;
  releasePendingSpaceId?: string | null;
  onArchive?(spaceId: string): void | Promise<void>;
  onDelete?(spaceId: string): void | Promise<void>;
  onRestore?(spaceId: string): void | Promise<void>;
  onNewWorkspace?(projectId: string): void;
  onOpenProjectSettings?(projectId: string): void;
  /** Opens Automations with this project chosen. */
  onOpenProjectAutomations?(projectId: string): void;
  /** Automation runs that failed today across every project; the Automations item shows it. */
  failedAutomationRuns?: number;
  onNewProject?(): void;
  /** `section` deep-links a settings tab, e.g. `source` from the pill. */
  onOpenSettings?(section?: 'source'): void;
  /** The signed-in user; the footer identity row. */
  user?: { name: string; handle?: string | null };
  /** Null or absent when this install has no deployment status (not a GitSpace tenant). */
  deployment?: SidebarDeploymentProps | null;
}

/** Whether any account target selects this workspace's newest release. */
function launchedFrom(deployment: SidebarDeploymentProps | null | undefined, workspaceId: string): boolean {
  if (!deployment) return false;
  const release = workspaceRelease(deployment.status, workspaceId);
  return release !== null && RELEASE_TARGETS.some((target) => deployment.status.desired[target] === release.sha);
}

function SpaceMenu({ space, kind, summary, deployment, onReleaseMachines, releasePendingSpaceId, onArchive, onRestore, onDelete, onInspect, onNewWorkspace, onOpenProjectSettings, onOpenAutomations, triggerClassName }: { space: Pick<AgentScopeView, 'id' | 'name'>; kind: AgentScopeView['kind']; summary?: SidebarSpaceSummary; onInspect?: () => void; onNewWorkspace?: () => void; onOpenProjectSettings?: () => void; onOpenAutomations?: () => void; triggerClassName?: string } & Pick<AppSidebarProps, 'deployment' | 'onReleaseMachines' | 'releasePendingSpaceId' | 'onArchive' | 'onRestore' | 'onDelete'>) {
  const archived = !!summary?.closedAt;
  const held = !archived && summary?.holder.kind === 'held';
  const launchable = (held || (!archived && summary?.holder.kind === 'cloud')) && deployment?.isGitSpaceProject === true;
  const canRelease = !archived && !summary?.creation && !!onReleaseMachines;
  const canRestore = kind === 'workspace' && archived && !!onRestore;
  const canArchive = kind === 'workspace' && !archived && !summary?.creation && !!onArchive;
  const canDelete = kind === 'workspace' && !!onDelete;
  if (!onInspect && !onNewWorkspace && !onOpenProjectSettings && !onOpenAutomations && !canRelease && !canRestore && !canArchive && !canDelete && !launchable) return null;
  const launching = deployment?.launch?.status === 'running';
  let index = 0;
  return <DropdownMenu>
    <DropdownTrigger render={<SidebarMenuAction className={triggerClassName} aria-label={`Space actions for ${space.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
    <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
      {onInspect ? <MenuItem index={index++} icon={ProjectGlyph} label="Open project" onSelect={onInspect} /> : null}
      {onNewWorkspace ? <MenuItem index={index++} icon={NewWorkspaceGlyph} label="New workspace" onSelect={onNewWorkspace} /> : null}
      {onOpenProjectSettings ? <MenuItem index={index++} icon={SettingsGlyph} label="Project settings" onSelect={onOpenProjectSettings} /> : null}
      {onOpenAutomations ? <MenuItem index={index++} icon={AutomationsGlyph} label="Automations" onSelect={onOpenAutomations} /> : null}
      {canRelease ? <MenuItem index={index++} icon={CloseGlyph} label={releasePendingSpaceId === space.id ? 'Releasing machine caches…' : 'Release machine caches'} disabled={releasePendingSpaceId !== null && releasePendingSpaceId !== undefined} onSelect={() => void onReleaseMachines?.(space.id)} /> : null}
      {canRestore ? <MenuItem index={index++} icon={ReopenGlyph} label="Restore workspace" onSelect={() => void onRestore?.(space.id)} /> : null}
      {canArchive ? <MenuItem index={index++} icon={ArchiveGlyph} label="Archive workspace" onSelect={() => void onArchive?.(space.id)} /> : null}
      {canDelete ? <MenuItem index={index++} icon={DeleteGlyph} label="Delete workspace" onSelect={() => void onDelete?.(space.id)} /> : null}
      {launchable && deployment ? <MenuItem index={index++} icon={LaunchGlyph} label="Launch GitSpace from here" disabled={launching} onSelect={() => void deployment.onLaunch(space.id)} /> : null}
      {kind === 'project' && deployment?.isGitSpaceProject ? <MenuItem index={index++} icon={LaunchGlyph} label="Launch canonical develop" disabled={launching} onSelect={() => void deployment.onLaunchCanonical()} /> : null}
      {launchable && deployment && launchedFrom(deployment, space.id) ? <MenuItem index={index++} icon={ReopenGlyph} label="Back to stable" disabled={launching} onSelect={() => void deployment.onRevert()} /> : null}
    </DropdownContent>
  </DropdownMenu>;
}

function LaunchedGlyph() {
  return <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" title="GitSpace has a selected release from this workspace" aria-label="GitSpace has a selected release from this workspace"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span>;
}

/** The origin has commits this branch's copy lacks; quiet beside the name, apart from the status dot and badges. */
function BehindOriginGlyph({ branch }: { branch: string | null }) {
  return <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" role="img" title={branch ? `Behind origin/${branch}` : 'Behind origin'} aria-label="Behind origin"><ArrowDown width={12} height={12} strokeWidth={1.5} /></span>;
}

/**
 * Source pill: what this machine runs, or the launch phase while one is in
 * flight. Failures stick until the next launch replaces the track.
 */
function SourcePill({ deployment, onOpenSettings }: { deployment: SidebarDeploymentProps } & Pick<AppSidebarProps, 'onOpenSettings'>) {
  const { status, launch } = deployment;
  const running = launch?.status === 'running';
  const failed = launch?.status === 'failed';
  const progress = running && launch ? latestLaunchProgress(launch) : null;
  let label = runningLabel(status);
  if (progress) label = launchPhaseLabel(progress);
  else if (failed) label = 'Launch failed';
  else if (converging(status)) {
    const machines = machineConvergence(status);
    label = machines.applied < machines.total
      ? `converging ${machines.applied}/${machines.total} machines`
      : 'Applying releases…';
  }
  const tooltip = `Worker ${status.current.worker.version ?? 'unknown'}`;
  return <SidebarMenu>
    <SidebarMenuItem>
      <Tooltip content={tooltip} side="top">
        <SidebarMenuButton size="sm" icon={LaunchGlyph} aria-label={`Source · ${label}`} data-launch={running ? 'running' : failed ? 'failed' : undefined} className={failed ? 'text-destructive [&_span]:text-destructive' : undefined} onClick={() => onOpenSettings?.('source')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{label}</span>
            {running ? <ThinkingIndicator size="compact" className="shrink-0 p-0 [&>span[aria-hidden]]:hidden" /> : null}
          </span>
        </SidebarMenuButton>
      </Tooltip>
    </SidebarMenuItem>
  </SidebarMenu>;
}

/**
 * A folded project keeps its actions cluster on screen so the expand chevron
 * stays as the reopen cue (as the kit's group headers do); its other actions
 * still wait for hover. With the sub-tree folded, the row is the whole item.
 */
const FOLDED_ACTION_REVEAL = 'opacity-0 group-hover/menu-item:opacity-100 group-focus-within/menu-item:opacity-100 data-[popup-open]:opacity-100';

function ProjectRows({ project, collapsed, onCollapse, selected, machines, deployment, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId, onArchive, onRestore, onDelete, onNewWorkspace, onOpenProjectSettings, onOpenProjectAutomations }: { project: SidebarProject; collapsed: boolean; onCollapse(projectId: string, collapsed: boolean): void } & Pick<AppSidebarProps, 'selected' | 'machines' | 'deployment' | 'onSelectProject' | 'onSelectWorkspace' | 'onReleaseMachines' | 'releasePendingSpaceId' | 'onArchive' | 'onRestore' | 'onDelete' | 'onNewWorkspace' | 'onOpenProjectSettings' | 'onOpenProjectAutomations'>) {
  const { base, workspaces } = project;
  const [showArchived, setShowArchived] = useState(false);
  const visible = workspaces.filter((workspace) => !workspace.closedAt);
  const archived = workspaces.filter((workspace) => !!workspace.closedAt);
  const baseSelected = selected?.workspaceId === null && selected.projectId === project.id;
  // A folded project still shows its selected workspace, without rewriting the stored preference.
  const open = !collapsed || (selected?.projectId === project.id && selected.workspaceId !== null);
  const baseSummary = project.baseSummary ?? base;
  const baseReleased = baseSummary && !baseSummary.closedAt && baseSummary.holder.kind === 'released';
  const createWorkspace = onNewWorkspace && project.lifecycle !== 'archived' && project.lifecycle !== 'deleting' ? () => onNewWorkspace(project.id) : undefined;
  const running = workspaces.filter((workspace) => { const summary = sidebarWorkspaceSummary(workspace); return summary && workspaceStatusColor(summary) === 'green'; }).length;
  const row = (workspace: SidebarWorkspace) => {
    const summary = sidebarWorkspaceSummary(workspace);
    const released = summary?.holder.kind === 'released';
    const suffix = released && !summary?.closedAt;
    return <SpaceSummaryContext.Provider key={workspace.id} value={summary}><SidebarMenuSubItem>
      <SidebarMenuSubButton className={released ? 'text-muted-foreground' : undefined} render={<button type="button" onClick={() => onSelectWorkspace(workspace)} />} isActive={selected?.projectId === workspace.projectId && selected.workspaceId === workspace.id} icon={SpaceStatusGlyph} title={`${workspace.branch} · ${summary ? summaryLabel(summary) : 'Status unknown'}${suffix ? ' · released' : ''}`} aria-description={summary?.detail ?? undefined}>{workspace.name}{workspace.definition?.remote?.behind ? <BehindOriginGlyph branch={workspace.branch} /> : null}{launchedFrom(deployment, workspace.id) ? <LaunchedGlyph /> : null}{suffix ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· released</span> : null}</SidebarMenuSubButton>
      <SidebarMenuActions showOnHover><SpaceMenu space={workspace} kind="workspace" summary={summary} deployment={deployment} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} /></SidebarMenuActions>
    </SidebarMenuSubItem></SpaceSummaryContext.Provider>;
  };
  return <SidebarMenuItem>
    <SpaceSummaryContext.Provider value={baseSummary}>
      <SidebarMenuButton className={baseReleased ? 'text-muted-foreground' : undefined} icon={SpaceStatusGlyph} isActive={baseSelected} title={[baseSummary ? `Base · ${summaryLabel(baseSummary)}${baseReleased ? ' · released' : ''}` : project.lifecycle === 'cloud-only' ? 'Saved in your account · no checkout' : `${project.name} · Status unknown`, project.error].filter(Boolean).join(' · ')} aria-description={project.error ?? undefined} onClick={() => onSelectProject?.(project.id)}>{project.name}{project.remote?.behind ? <BehindOriginGlyph branch={base?.branch ?? null} /> : null}{baseReleased ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· released</span> : null}</SidebarMenuButton>
    </SpaceSummaryContext.Provider>
    {running ? <SidebarMenuBadge title={`${running} ${running === 1 ? 'workspace' : 'workspaces'} last reported working`}>{running}</SidebarMenuBadge> : null}
    <SidebarMenuActions showOnHover={open}>
      <SidebarMenuAction aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={open} onClick={() => onCollapse(project.id, open)}><ChevronRight width={16} height={16} strokeWidth={1.5} className={open ? 'rotate-90 transition-[rotate] duration-80' : 'transition-[rotate] duration-80'} /></SidebarMenuAction>
      {createWorkspace ? <Tooltip content="New workspace" side="top"><SidebarMenuAction className={open ? undefined : FOLDED_ACTION_REVEAL} aria-label={`New workspace in ${project.name}`} onClick={createWorkspace}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip> : null}
      <SpaceMenu space={base ?? project} kind="project" summary={baseSummary} deployment={deployment} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onInspect={onSelectProject ? () => onSelectProject(project.id) : undefined} onNewWorkspace={createWorkspace} onOpenProjectSettings={onOpenProjectSettings ? () => onOpenProjectSettings(project.id) : undefined} onOpenAutomations={onOpenProjectAutomations ? () => onOpenProjectAutomations(project.id) : undefined} triggerClassName={open ? undefined : FOLDED_ACTION_REVEAL} />
    </SidebarMenuActions>
    <SidebarMenuSub open={open}>
      {visible.map(row)}
      {archived.length ? <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived} />} icon={ArchiveGlyph}>Archived</SidebarMenuSubButton>
        <SidebarMenuBadge>{archived.length}</SidebarMenuBadge>
      </SidebarMenuSubItem> : null}
      {showArchived || archived.some((workspace) => workspace.id === selected?.workspaceId) ? archived.map(row) : null}
    </SidebarMenuSub>
  </SidebarMenuItem>;
}

const COLLAPSED_PROJECTS_KEY = 'gitspace.sidebar.collapsedProjects';

/** Project ids whose workspaces the user folded away; missing, malformed, or unreadable storage folds nothing. */
function readCollapsedProjects(): ReadonlySet<string> {
  if (typeof window === 'undefined') return new Set();
  let parsed: unknown = null;
  try { parsed = JSON.parse(window.localStorage.getItem(COLLAPSED_PROJECTS_KEY) ?? 'null'); } catch { /* private mode or malformed */ }
  return new Set(Array.isArray(parsed) ? parsed.filter((id: unknown): id is string => typeof id === 'string') : []);
}

export function AppSidebar({ view, onView, selected, selectedSummary, projects, machines, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId = null, onArchive, onRestore, onDelete, onNewWorkspace, onNewProject, onOpenSettings, onOpenProjectSettings, onOpenProjectAutomations, failedAutomationRuns = 0, user, deployment }: AppSidebarProps) {
  const userName = user?.name || 'Your account';
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects);
  const collapseProject = (projectId: string, collapse: boolean): void => {
    const next = new Set(collapsedProjects);
    if (collapse) next.add(projectId);
    else next.delete(projectId);
    setCollapsedProjects(next);
    try { window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
  };
  return <Sidebar variant="inset">
    <SidebarHeader>
      <SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} />
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup collapsible>
        <SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>
          {NAV.map((item) => <SidebarMenuItem key={item.view}>
            <SidebarMenuButton icon={item.icon} isActive={view === item.view} onClick={() => onView(item.view)}>{PRODUCT_ROUTE_LABELS[item.view]}</SidebarMenuButton>
            {item.view === 'automations' && failedAutomationRuns > 0 ? <SidebarMenuBadge title={`${failedAutomationRuns} automation ${failedAutomationRuns === 1 ? 'run' : 'runs'} failed today`}>{failedAutomationRuns}</SidebarMenuBadge> : null}
          </SidebarMenuItem>)}
        </SidebarMenu>
      </SidebarGroup>

      <SidebarGroup collapsible>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupActions>
          {onNewProject ? <Tooltip content="New project" side="top">
            <SidebarGroupAction aria-label="New project" onClick={onNewProject}><FolderPlus width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction>
          </Tooltip> : null}
        </SidebarGroupActions>
        <SidebarMenu>
          {projects.map((project) => <ProjectRows key={project.id} project={selectedSummary && selected?.projectId === project.id
            ? selected.workspaceId === null
              ? { ...project, baseSummary: selectedSummary }
              : { ...project, workspaces: project.workspaces.map((workspace) => workspace.id === selected.workspaceId ? { ...workspace, summary: selectedSummary } : workspace) }
            : project} collapsed={collapsedProjects.has(project.id)} onCollapse={collapseProject} selected={selected} machines={machines} deployment={deployment} onSelectProject={onSelectProject} onSelectWorkspace={onSelectWorkspace} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} onNewWorkspace={onNewWorkspace} onOpenProjectSettings={onOpenProjectSettings} onOpenProjectAutomations={onOpenProjectAutomations} />)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      {deployment ? <SourcePill deployment={deployment} onOpenSettings={onOpenSettings} /> : null}
      <SidebarUserFooter
        name={userName}
        avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">{userName.slice(0, 1).toUpperCase()}</span>}
        menu={<>
          <MenuItem index={0} icon={SettingsGlyph} label="Settings" onSelect={() => onOpenSettings?.()} />
        </>}
      />
    </SidebarFooter>
  </Sidebar>;
}
