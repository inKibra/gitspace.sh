import type { DeploymentStatusView } from '@gitspace/protocol';
import type { CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
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
import { Archive, Calendar, ChevronRight, Columns03, DotsHorizontal, FolderClosed, FolderPlus, HardDrive, Inbox01, Key01, Plus, PuzzlePiece01, RefreshCcw01, Rocket02, Settings01, Square, Stars01 } from '@untitledui/icons';
import { createContext, useContext, useState, type Dispatch, type SetStateAction } from 'react';
import { glyph } from './glyph.js';
import { converging, latestLaunchProgress, launchPhaseLabel, machineConvergence, RELEASE_TARGETS, runningLabel, workspaceRelease, type LaunchTrack } from './release.js';
import { PRODUCT_ROUTE_LABELS, type AppView, type ProductRoute } from './routes.js';
import { spaceHolderLabel, StatusDot, workspaceStatusColor, workspaceStatusLabel, type AgentScopeView, type ProjectAgentView, type ProjectLifecycleView, type WorkspaceCreationState, type WorkspaceView } from './GitSpaceShell.js';

const NAV: Array<{ view: Exclude<AppView, 'agent'>; icon: IconComponent }> = [
  { view: 'kanban', icon: glyph(Columns03) },
  { view: 'projects', icon: glyph(FolderClosed) },
  { view: 'inference', icon: glyph(Stars01) },
  { view: 'plugins', icon: glyph(PuzzlePiece01) },
  { view: 'skills', icon: glyph(Stars01) },
  { view: 'crons', icon: glyph(Calendar) },
  { view: 'secrets', icon: glyph(Key01) },
  { view: 'inbox', icon: glyph(Inbox01) },
];


/** Self-development surface for the sidebar: the Source pill, launched-row badges, and launch actions. */
export interface SidebarDeploymentProps {
  status: DeploymentStatusView;
  /** The launch this browser follows (in flight or the last one), or null when none is known. */
  launch: LaunchTrack | null;
  /** Launch actions are offered only inside the GitSpace project itself. */
  isGitSpaceProject: boolean;
  /** Launch every target from the workspace. */
  onLaunch(workspaceId: string): void | Promise<void>;
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
const ReopenGlyph = glyph(RefreshCcw01);
const CloseGlyph = glyph(Square);
const MachineGlyph = glyph(HardDrive);
const LaunchGlyph = glyph(Rocket02);
const SettingsGlyph = glyph(Settings01);
const ProjectGlyph = glyph(FolderClosed);
const NewWorkspaceGlyph = glyph(Plus);

/** Icon slots take component types, so keep this type stable while context updates the accepted status. */
function SpaceStatusGlyph({ className, size, strokeWidth }: IconComponentProps) {
  const summary = useContext(SpaceSummaryContext);
  const color = summary ? workspaceStatusColor(summary) : 'orange';
  const freshness = summary?.freshness ?? (summary?.status ? 'fresh' : 'unknown');
  return <span className={`inline-flex items-center justify-center ${className ?? ''}`} style={{ width: size, height: size }} data-freshness={freshness}>
    {summary?.closedAt ? <ArchiveGlyph size={size} strokeWidth={strokeWidth} /> : <StatusDot color={color} pulse={color === 'green' && freshness === 'fresh'} />}
  </span>;
}

export interface SidebarWorkspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  closedAt: Date | null;
  definition?: CloudWorkspaceDefinition;
  runtime?: WorkspaceView;
  summary?: SidebarSpaceSummary;
}

export interface SidebarProject {
  id: string;
  name: string;
  lifecycle?: ProjectLifecycleView['lifecycle'];
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
  projects: readonly SidebarProject[];
  machines: Array<{ id: string; label: string }>;
  onSelectProject?(projectId: string): void;
  onSelectWorkspace(workspace: SidebarWorkspace): void;
  onClose?(spaceId: string): void | Promise<void>;
  closePendingSpaceId?: string | null;
  onReopen?(spaceId: string): void | Promise<void>;
  onArchive?(spaceId: string): void | Promise<void>;
  onRestore?(spaceId: string): void | Promise<void>;
  onMove?(spaceId: string, destinationMachineId: string): void | Promise<void>;
  onNewWorkspace?(projectId: string): void;
  onOpenProjectSettings?(projectId: string): void;
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

function SpaceMenu({ space, kind, runtime, summary = runtime, machines, deployment, onClose, closePendingSpaceId, onReopen, onArchive, onRestore, onMove, onInspect, onNewWorkspace, onOpenProjectSettings, triggerClassName }: { space: Pick<AgentScopeView, 'id' | 'name'>; kind: AgentScopeView['kind']; runtime?: AgentScopeView; summary?: SidebarSpaceSummary; onInspect?: () => void; onNewWorkspace?: () => void; onOpenProjectSettings?: () => void; triggerClassName?: string } & Pick<AppSidebarProps, 'machines' | 'deployment' | 'onClose' | 'closePendingSpaceId' | 'onReopen' | 'onArchive' | 'onRestore' | 'onMove'>) {
  const archived = !!summary?.closedAt;
  const released = !archived && summary?.holder.kind === 'released';
  const active = !!runtime && !archived && summary?.holder.kind === 'held';
  const launchable = active && kind === 'workspace' && deployment?.isGitSpaceProject === true;
  const canReopen = released && !!onReopen;
  const canClose = !archived && summary?.holder.kind === 'held' && !!onClose;
  const outstanding = !!summary?.status && summary.status.agents.green + summary.status.agents.orange + summary.status.agents.red > 0;
  const canRestore = kind === 'workspace' && archived && !!onRestore;
  const canArchive = kind === 'workspace' && !archived && !summary?.creation && !!onArchive;
  const canMove = active && !!onMove && machines.length > 0;
  if (!onInspect && !onNewWorkspace && !onOpenProjectSettings && !canReopen && !canClose && !canRestore && !canArchive && !canMove && !launchable) return null;
  const launching = deployment?.launch?.status === 'running';
  let index = 0;
  return <DropdownMenu>
    <DropdownTrigger render={<SidebarMenuAction className={triggerClassName} aria-label={`Space actions for ${space.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
    <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
      {onInspect ? <MenuItem index={index++} icon={ProjectGlyph} label="Open project" onSelect={onInspect} /> : null}
      {onNewWorkspace ? <MenuItem index={index++} icon={NewWorkspaceGlyph} label="New workspace" onSelect={onNewWorkspace} /> : null}
      {onOpenProjectSettings ? <MenuItem index={index++} icon={SettingsGlyph} label="Project settings" onSelect={onOpenProjectSettings} /> : null}
      {canReopen ? <MenuItem index={index++} icon={ReopenGlyph} label="Reopen space" onSelect={() => void onReopen?.(space.id)} /> : null}
      {canClose ? <MenuItem index={index++} icon={CloseGlyph} label={closePendingSpaceId === space.id ? outstanding ? 'Stopping agent…' : 'Closing space…' : outstanding ? 'Stop and close' : 'Close space'} disabled={closePendingSpaceId !== null && closePendingSpaceId !== undefined} onSelect={() => void onClose?.(space.id)} /> : null}
      {canRestore ? <MenuItem index={index++} icon={ReopenGlyph} label="Restore workspace" onSelect={() => void onRestore?.(space.id)} /> : null}
      {canArchive ? <MenuItem index={index++} icon={ArchiveGlyph} label="Archive workspace" onSelect={() => void onArchive?.(space.id)} /> : null}
      {canMove ? machines.map((machine) => <MenuItem key={machine.id} index={index++} icon={MachineGlyph} label={`Move to ${machine.label}`} onSelect={() => {
        if (!window.confirm(`Move ${space.name} to ${machine.label}? Ignored files and machine-local secrets will not move.`)) return;
        void onMove?.(space.id, machine.id);
      }} />) : null}
      {launchable && deployment ? <MenuItem index={index++} icon={LaunchGlyph} label="Launch GitSpace from here" disabled={launching} onSelect={() => void deployment.onLaunch(space.id)} /> : null}
      {launchable && deployment && launchedFrom(deployment, space.id) ? <MenuItem index={index++} icon={ReopenGlyph} label="Back to stable" disabled={launching} onSelect={() => void deployment.onRevert()} /> : null}
    </DropdownContent>
  </DropdownMenu>;
}

function LaunchedGlyph() {
  return <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" title="GitSpace has a selected release from this workspace" aria-label="GitSpace has a selected release from this workspace"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span>;
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
  const tooltip = `${status.thisMachine.sha ?? 'channel build'} · generation ${status.thisMachine.generation ?? 'unknown'}`;
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

function ProjectRows({ project, collapsed, onCollapse, selected, machines, deployment, onSelectProject, onSelectWorkspace, onClose, closePendingSpaceId, onReopen, onArchive, onRestore, onMove, onNewWorkspace, onOpenProjectSettings }: { project: SidebarProject; collapsed: boolean; onCollapse(projectId: string, collapsed: boolean): void } & Pick<AppSidebarProps, 'selected' | 'machines' | 'deployment' | 'onSelectProject' | 'onSelectWorkspace' | 'onClose' | 'closePendingSpaceId' | 'onReopen' | 'onArchive' | 'onRestore' | 'onMove' | 'onNewWorkspace' | 'onOpenProjectSettings'>) {
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
  const running = workspaces.filter(({ runtime, summary = runtime }) => summary && !summary.closedAt && summary.holder.kind === 'held' && summary.status?.primaryColor === 'green').length;
  const row = (workspace: SidebarWorkspace) => {
    const runtime = workspace.runtime;
    const supplied: SidebarSpaceSummary | undefined = workspace.summary ?? runtime;
    const summary = workspace.closedAt ? { ...supplied, closedAt: workspace.closedAt, holder: supplied?.holder ?? { kind: 'unknown' as const } } : supplied;
    const released = summary?.holder.kind === 'released';
    const holder = summary ? spaceHolderLabel(summary) : null;
    return <SpaceSummaryContext.Provider key={workspace.id} value={summary}><SidebarMenuSubItem>
      <SidebarMenuSubButton className={released ? 'text-muted-foreground' : undefined} render={<button type="button" onClick={() => onSelectWorkspace(workspace)} />} isActive={selected?.projectId === workspace.projectId && selected.workspaceId === workspace.id} icon={SpaceStatusGlyph} title={`${workspace.branch} · ${summary ? summaryLabel(summary) : 'Status unknown'}${holder ? ` · ${holder}` : ''}`} aria-description={summary?.detail ?? undefined}>{workspace.name}{launchedFrom(deployment, workspace.id) ? <LaunchedGlyph /> : null}{holder ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· {holder}</span> : null}</SidebarMenuSubButton>
      <SidebarMenuActions showOnHover><SpaceMenu space={workspace} kind="workspace" runtime={runtime} summary={summary} machines={machines} deployment={deployment} onClose={onClose} closePendingSpaceId={closePendingSpaceId} onReopen={onReopen} onArchive={onArchive} onRestore={onRestore} onMove={onMove} /></SidebarMenuActions>
    </SidebarMenuSubItem></SpaceSummaryContext.Provider>;
  };
  return <SidebarMenuItem>
    <SpaceSummaryContext.Provider value={baseSummary}>
      <SidebarMenuButton className={baseReleased ? 'text-muted-foreground' : undefined} icon={SpaceStatusGlyph} isActive={baseSelected} title={[baseSummary ? `Base · ${summaryLabel(baseSummary)}${spaceHolderLabel(baseSummary) ? ` · ${spaceHolderLabel(baseSummary)}` : ''}` : project.lifecycle === 'cloud-only' ? 'Saved in your account · no checkout' : `${project.name} · Status unknown`, project.error].filter(Boolean).join(' · ')} aria-description={project.error ?? undefined} onClick={() => onSelectProject?.(project.id)}>{project.name}{baseSummary && spaceHolderLabel(baseSummary) ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· {spaceHolderLabel(baseSummary)}</span> : null}</SidebarMenuButton>
    </SpaceSummaryContext.Provider>
    {running ? <SidebarMenuBadge title={`${running} ${running === 1 ? 'workspace' : 'workspaces'} last reported working`}>{running}</SidebarMenuBadge> : null}
    <SidebarMenuActions showOnHover={open}>
      <SidebarMenuAction aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={open} onClick={() => onCollapse(project.id, open)}><ChevronRight width={16} height={16} strokeWidth={1.5} className={open ? 'rotate-90 transition-[rotate] duration-80' : 'transition-[rotate] duration-80'} /></SidebarMenuAction>
      {createWorkspace ? <Tooltip content="New workspace" side="top"><SidebarMenuAction className={open ? undefined : FOLDED_ACTION_REVEAL} aria-label={`New workspace in ${project.name}`} onClick={createWorkspace}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip> : null}
      <SpaceMenu space={base ?? project} kind="project" runtime={base} summary={baseSummary} machines={machines} deployment={deployment} onClose={onClose} closePendingSpaceId={closePendingSpaceId} onReopen={onReopen} onArchive={onArchive} onRestore={onRestore} onMove={onMove} onInspect={onSelectProject ? () => onSelectProject(project.id) : undefined} onNewWorkspace={createWorkspace} onOpenProjectSettings={onOpenProjectSettings ? () => onOpenProjectSettings(project.id) : undefined} triggerClassName={open ? undefined : FOLDED_ACTION_REVEAL} />
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

export function AppSidebar({ view, onView, selected, projects, machines, onSelectProject, onSelectWorkspace, onClose, closePendingSpaceId = null, onReopen, onArchive, onRestore, onMove, onNewWorkspace, onNewProject, onOpenSettings, onOpenProjectSettings, user, deployment }: AppSidebarProps) {
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
          {projects.map((project) => <ProjectRows key={project.id} project={project} collapsed={collapsedProjects.has(project.id)} onCollapse={collapseProject} selected={selected} machines={machines} deployment={deployment} onSelectProject={onSelectProject} onSelectWorkspace={onSelectWorkspace} onClose={onClose} closePendingSpaceId={closePendingSpaceId} onReopen={onReopen} onArchive={onArchive} onRestore={onRestore} onMove={onMove} onNewWorkspace={onNewWorkspace} onOpenProjectSettings={onOpenProjectSettings} />)}
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
