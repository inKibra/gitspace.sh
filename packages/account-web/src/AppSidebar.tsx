import type { DeploymentStatusView } from '@gitspace/protocol';
import type { WorkspaceStatusColor } from '@gitspace/protocol/workspace-status';
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
import { Archive, Calendar, Columns03, DotsHorizontal, FolderClosed, FolderPlus, HardDrive, Inbox01, Key01, Plus, PuzzlePiece01, RefreshCcw01, Rocket02, Settings01, Square, Stars01 } from '@untitledui/icons';
import { createContext, useState, type Dispatch, type SetStateAction } from 'react';
import { glyph } from './glyph.js';
import { converging, latestLaunchProgress, launchPhaseLabel, machineConvergence, RELEASE_TARGETS, runningLabel, workspaceRelease, type LaunchTrack } from './release.js';
import type { AppView, ProductRoute } from './routes.js';
import { spaceHolderLabel, StatusDot, workspaceStatusLabel, type AgentScopeView, type ProjectAgentView, type ProjectLifecycleView, type WorkspaceView } from './GitSpaceShell.js';

const NAV: Array<{ view: AppView; label: string; icon: IconComponent }> = [
  { view: 'kanban', label: 'Kanban', icon: glyph(Columns03) },
  { view: 'projects', label: 'Projects', icon: glyph(FolderClosed) },
  { view: 'plugins', label: 'Plugins', icon: glyph(PuzzlePiece01) },
  { view: 'skills', label: 'Skills', icon: glyph(Stars01) },
  { view: 'crons', label: 'Crons', icon: glyph(Calendar) },
  { view: 'secrets', label: 'Secrets', icon: glyph(Key01) },
  { view: 'inbox', label: 'Inbox', icon: glyph(Inbox01) },
];

/** The workspace's own status colour as the row's leading icon - the same dot Kanban and the topbar use. */
function statusGlyph(color: WorkspaceStatusColor, pulse: boolean): IconComponent {
  return function StatusGlyph({ className }: IconComponentProps) {
    return <span className={`inline-flex items-center justify-center ${className ?? ''}`}><StatusDot color={color} pulse={pulse} /></span>;
  };
}

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

export interface SidebarWorkspace {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  closedAt: Date | null;
  runtime?: WorkspaceView;
}

export interface SidebarProject {
  id: string;
  name: string;
  lifecycle?: ProjectLifecycleView['lifecycle'];
  base?: ProjectAgentView;
  workspaces: SidebarWorkspace[];
  error?: string | null;
}

/** A running pane contributes controls; the account owns navigation and its lifetime. */
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

function SpaceMenu({ space, machines, deployment, onClose, closePendingSpaceId, onReopen, onArchive, onRestore, onMove }: { space: AgentScopeView } & Pick<AppSidebarProps, 'machines' | 'deployment' | 'onClose' | 'closePendingSpaceId' | 'onReopen' | 'onArchive' | 'onRestore' | 'onMove'>) {
  const archived = !!space.closedAt;
  const released = !archived && space.holder.kind === 'released';
  const active = !archived && !released;
  const launchable = active && space.kind === 'workspace' && deployment?.isGitSpaceProject === true;
  const launching = deployment?.launch?.status === 'running';
  let index = 0;
  return <DropdownMenu>
    <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${space.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
    <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
      {released ? <MenuItem index={index++} icon={glyph(RefreshCcw01)} label="Reopen space" onSelect={() => void onReopen?.(space.id)} /> : null}
      {active ? <MenuItem index={index++} icon={glyph(Square)} label={closePendingSpaceId === space.id ? space.status.primaryColor === 'green' ? 'Stopping agent…' : 'Closing space…' : space.status.primaryColor === 'green' ? 'Stop and close' : 'Close space'} disabled={closePendingSpaceId !== null && closePendingSpaceId !== undefined} onSelect={() => void onClose?.(space.id)} /> : null}
      {space.kind === 'workspace' && archived ? <MenuItem index={index++} icon={glyph(RefreshCcw01)} label="Restore workspace" onSelect={() => void onRestore?.(space.id)} /> : null}
      {space.kind === 'workspace' && !archived ? <MenuItem index={index++} icon={glyph(Archive)} label="Archive workspace" onSelect={() => void onArchive?.(space.id)} /> : null}
      {active ? machines.map((machine) => <MenuItem key={machine.id} index={index++} icon={glyph(HardDrive)} label={`Move to ${machine.label}`} onSelect={() => {
        if (!window.confirm(`Move ${space.name} to ${machine.label}? Ignored files and machine-local secrets will not move.`)) return;
        void onMove?.(space.id, machine.id);
      }} />) : null}
      {launchable && deployment ? <MenuItem index={index++} icon={glyph(Rocket02)} label="Launch GitSpace from here" disabled={launching} onSelect={() => void deployment.onLaunch(space.id)} /> : null}
      {launchable && deployment && launchedFrom(deployment, space.id) ? <MenuItem index={index++} icon={glyph(RefreshCcw01)} label="Back to stable" disabled={launching} onSelect={() => void deployment.onRevert()} /> : null}
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
        <SidebarMenuButton size="sm" icon={glyph(Rocket02)} aria-label={`Source · ${label}`} data-launch={running ? 'running' : failed ? 'failed' : undefined} className={failed ? 'text-destructive [&_span]:text-destructive' : undefined} onClick={() => onOpenSettings?.('source')}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{label}</span>
            {running ? <ThinkingIndicator size="compact" className="shrink-0 p-0 [&>span[aria-hidden]]:hidden" /> : null}
          </span>
        </SidebarMenuButton>
      </Tooltip>
    </SidebarMenuItem>
  </SidebarMenu>;
}

function ProjectRows({ project, selected, machines, deployment, onSelectProject, onSelectWorkspace, onClose, closePendingSpaceId, onReopen, onArchive, onRestore, onMove, onNewWorkspace }: { project: SidebarProject } & Pick<AppSidebarProps, 'selected' | 'machines' | 'deployment' | 'onSelectProject' | 'onSelectWorkspace' | 'onClose' | 'closePendingSpaceId' | 'onReopen' | 'onArchive' | 'onRestore' | 'onMove' | 'onNewWorkspace'>) {
  const { base, workspaces } = project;
  const [showArchived, setShowArchived] = useState(false);
  const visible = workspaces.filter((workspace) => !workspace.closedAt);
  const archived = workspaces.filter((workspace) => !!workspace.closedAt);
  const baseSelected = selected?.workspaceId === null && selected.projectId === project.id;
  const baseReleased = base && !base.closedAt && base.holder.kind === 'released';
  const running = workspaces.filter(({ runtime }) => runtime && !runtime.closedAt && runtime.holder.kind !== 'released' && runtime.status.primaryColor === 'green').length;
  const row = (workspace: SidebarWorkspace) => {
    const runtime = workspace.runtime;
    const released = runtime?.holder.kind === 'released';
    const holder = runtime ? spaceHolderLabel(runtime) : null;
    return <SidebarMenuSubItem key={workspace.id}>
      <SidebarMenuSubButton className={released ? 'text-muted-foreground' : undefined} render={<button type="button" onClick={() => onSelectWorkspace(workspace)} />} isActive={selected?.projectId === workspace.projectId && selected.workspaceId === workspace.id} icon={workspace.closedAt ? glyph(Archive) : runtime ? statusGlyph(released ? 'dim' : runtime.status.primaryColor, !released && runtime.status.primaryColor === 'green') : glyph(FolderClosed)} title={`${workspace.branch}${holder ? ` · ${holder}` : ''}`}>{workspace.name}{launchedFrom(deployment, workspace.id) ? <LaunchedGlyph /> : null}{holder ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· {holder}</span> : null}</SidebarMenuSubButton>
      {runtime ? <SidebarMenuActions showOnHover><SpaceMenu space={runtime} machines={machines} deployment={deployment} onClose={onClose} closePendingSpaceId={closePendingSpaceId} onReopen={onReopen} onArchive={onArchive} onRestore={onRestore} onMove={onMove} /></SidebarMenuActions> : null}
    </SidebarMenuSubItem>;
  };
  return <SidebarMenuItem>
    <SidebarMenuButton className={baseReleased ? 'text-muted-foreground' : undefined} icon={base ? statusGlyph(baseReleased ? 'dim' : base.status.primaryColor, !baseReleased && base.status.primaryColor === 'green') : glyph(FolderClosed)} isActive={baseSelected} title={base ? `Base · ${workspaceStatusLabel(base)}${spaceHolderLabel(base) ? ` · ${spaceHolderLabel(base)}` : ''}` : project.lifecycle === 'cloud-only' ? 'Saved in your account · no checkout' : project.name} onClick={() => onSelectProject?.(project.id)}>{project.name}{base && spaceHolderLabel(base) ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· {spaceHolderLabel(base)}</span> : null}</SidebarMenuButton>
    {running ? <SidebarMenuBadge>{running}</SidebarMenuBadge> : null}
    {base ? <SidebarMenuActions showOnHover>
      {onNewWorkspace && !base.closedAt ? <Tooltip content="New workspace" side="top"><SidebarMenuAction aria-label={`New workspace in ${project.name}`} onClick={() => onNewWorkspace(project.id)}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip> : null}
      <SpaceMenu space={base} machines={machines} deployment={deployment} onClose={onClose} closePendingSpaceId={closePendingSpaceId} onReopen={onReopen} onArchive={onArchive} onRestore={onRestore} onMove={onMove} />
    </SidebarMenuActions> : null}
    <SidebarMenuSub>
      {visible.map(row)}
      {archived.length ? <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived} />} icon={glyph(Archive)}>Archived</SidebarMenuSubButton>
        <SidebarMenuBadge>{archived.length}</SidebarMenuBadge>
      </SidebarMenuSubItem> : null}
      {showArchived || archived.some((workspace) => workspace.id === selected?.workspaceId) ? archived.map(row) : null}
      {project.error ? <SidebarMenuSubItem><span role="status" className="px-2 text-caption text-muted-foreground" title={project.error}>Workspace list unavailable</span></SidebarMenuSubItem> : null}
    </SidebarMenuSub>
  </SidebarMenuItem>;
}

export function AppSidebar({ view, onView, selected, projects, machines, onSelectProject, onSelectWorkspace, onClose, closePendingSpaceId = null, onReopen, onArchive, onRestore, onMove, onNewWorkspace, onNewProject, onOpenSettings, user, deployment }: AppSidebarProps) {
  const userName = user?.name || 'Your account';
  return <Sidebar variant="inset">
    <SidebarHeader>
      <SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} />
    </SidebarHeader>

    <SidebarContent>
      <SidebarGroup collapsible>
        <SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>
          {NAV.map((item) => <SidebarMenuItem key={item.view}>
            <SidebarMenuButton icon={item.icon} isActive={view === item.view} onClick={() => onView(item.view)}>{item.label}</SidebarMenuButton>
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
          {projects.map((project) => <ProjectRows key={project.id} project={project} selected={selected} machines={machines} deployment={deployment} onSelectProject={onSelectProject} onSelectWorkspace={onSelectWorkspace} onClose={onClose} closePendingSpaceId={closePendingSpaceId} onReopen={onReopen} onArchive={onArchive} onRestore={onRestore} onMove={onMove} onNewWorkspace={onNewWorkspace} />)}
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>

    <SidebarFooter>
      {deployment ? <SourcePill deployment={deployment} onOpenSettings={onOpenSettings} /> : null}
      <SidebarUserFooter
        name={userName}
        avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">{userName.slice(0, 1).toUpperCase()}</span>}
        menu={<>
          <MenuItem index={0} icon={glyph(Settings01)} label="Settings" onSelect={() => onOpenSettings?.()} />
        </>}
      />
    </SidebarFooter>
  </Sidebar>;
}
