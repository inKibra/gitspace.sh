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
import { Archive, Calendar, Columns03, DotsHorizontal, FolderClosed, FolderPlus, HardDrive, Inbox01, Key01, Plus, PuzzlePiece01, RefreshCcw01, Rocket02, Settings01, Stars01 } from '@untitledui/icons';
import { useState } from 'react';
import { glyph } from './glyph.js';
import { converging, latestLaunchProgress, launchPhaseLabel, machineConvergence, runningLabel, workspaceRelease, type LaunchTrack } from './release.js';
import type { AppView } from './routes.js';
import { spaceHolderLabel, StatusDot, workspaceStatusLabel, type AgentScopeView, type ProjectAgentView, type WorkspaceView } from './GitSpaceShell.js';

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

export interface AppSidebarProps {
  view: AppView;
  onView(view: AppView): void;
  selected: AgentScopeView;
  projects: Array<{ base: ProjectAgentView; workspaces: WorkspaceView[] }>;
  machines: Array<{ id: string; label: string }>;
  onSelectProject?(projectId: string): void;
  onSelectWorkspace(workspace: WorkspaceView): void;
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

/** Whether GitSpace currently runs from the workspace: its newest release is the desired one. */
function launchedFrom(deployment: SidebarDeploymentProps | null | undefined, workspaceId: string): boolean {
  if (!deployment) return false;
  const release = workspaceRelease(deployment.status, workspaceId);
  return release !== null && release.sha === deployment.status.desired.sha;
}

function SpaceMenu({ space, machines, deployment, onArchive, onRestore, onMove }: { space: AgentScopeView } & Pick<AppSidebarProps, 'machines' | 'deployment' | 'onArchive' | 'onRestore' | 'onMove'>) {
  // Archived or released: nothing runs anywhere, so the only action is bringing it back (to the home machine).
  const closed = !!space.closedAt || space.holder.kind === 'released';
  const noun = space.kind === 'project' ? 'project' : 'workspace';
  const launchable = !closed && space.kind === 'workspace' && deployment?.isGitSpaceProject === true;
  const launching = deployment?.launch?.status === 'running';
  let index = 0;
  return <DropdownMenu>
    <DropdownTrigger render={<SidebarMenuAction aria-label={`Space actions for ${space.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
    <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4}>
      <MenuItem index={index++} icon={glyph(closed ? RefreshCcw01 : Archive)} label={closed ? `Restore ${noun}` : `Archive ${noun}`} onSelect={() => { if (closed) void onRestore?.(space.id); else void onArchive?.(space.id); }} />
      {!closed ? machines.map((machine) => <MenuItem key={machine.id} index={index++} icon={glyph(HardDrive)} label={`Move to ${machine.label}`} onSelect={() => {
        if (!window.confirm(`Move ${space.name} to ${machine.label}? Ignored files and machine-local secrets will not move.`)) return;
        void onMove?.(space.id, machine.id);
      }} />) : null}
      {launchable && deployment ? <MenuItem index={index++} icon={glyph(Rocket02)} label="Launch GitSpace from here" disabled={launching} onSelect={() => void deployment.onLaunch(space.id)} /> : null}
      {launchable && deployment && launchedFrom(deployment, space.id) ? <MenuItem index={index++} icon={glyph(RefreshCcw01)} label="Back to stable" disabled={launching} onSelect={() => void deployment.onRevert()} /> : null}
    </DropdownContent>
  </DropdownMenu>;
}

function LaunchedGlyph() {
  return <span className="ml-1 inline-flex shrink-0 items-center text-muted-foreground" title="GitSpace is running from this workspace" aria-label="GitSpace is running from this workspace"><Rocket02 width={12} height={12} strokeWidth={1.5} /></span>;
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
  const label = progress
    ? launchPhaseLabel(progress)
    : failed
      ? 'Launch failed'
      : converging(status)
        ? `converging ${machineConvergence(status).applied}/${machineConvergence(status).total} machines`
        : runningLabel(status);
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

function ProjectRows({ base, workspaces, selected, machines, deployment, onSelectProject, onSelectWorkspace, onArchive, onRestore, onMove, onNewWorkspace }: { base: ProjectAgentView; workspaces: WorkspaceView[] } & Pick<AppSidebarProps, 'selected' | 'machines' | 'deployment' | 'onSelectProject' | 'onSelectWorkspace' | 'onArchive' | 'onRestore' | 'onMove' | 'onNewWorkspace'>) {
  const [showClosed, setShowClosed] = useState(false);
  const open = workspaces.filter((workspace) => !workspace.closedAt);
  const closed = workspaces.filter((workspace) => workspace.closedAt);
  const baseSelected = selected.kind === 'project' && selected.projectId === base.projectId;
  const running = workspaces.filter((workspace) => workspace.status.primaryColor === 'green').length;
  return <SidebarMenuItem>
    <SidebarMenuButton icon={statusGlyph(base.status.primaryColor, base.status.primaryColor === 'green')} isActive={baseSelected} title={`Base · ${workspaceStatusLabel(base)}${spaceHolderLabel(base) ? ` · ${spaceHolderLabel(base)}` : ''}`} onClick={() => onSelectProject?.(base.projectId)}>{base.projectName}{spaceHolderLabel(base) ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· {spaceHolderLabel(base)}</span> : null}</SidebarMenuButton>
    {running ? <SidebarMenuBadge>{running}</SidebarMenuBadge> : null}
    <SidebarMenuActions showOnHover>
      {onNewWorkspace && !base.closedAt ? <Tooltip content="New workspace" side="top"><SidebarMenuAction aria-label={`New workspace in ${base.projectName}`} onClick={() => onNewWorkspace(base.projectId)}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip> : null}
      <SpaceMenu space={base} machines={machines} deployment={deployment} onArchive={onArchive} onRestore={onRestore} onMove={onMove} />
    </SidebarMenuActions>
    <SidebarMenuSub>
      {open.map((workspace) => {
        const active = selected.kind === 'workspace' && selected.id === workspace.id;
        return <SidebarMenuSubItem key={workspace.id}>
          <SidebarMenuSubButton render={<button type="button" onClick={() => onSelectWorkspace(workspace)} />} isActive={active} icon={statusGlyph(workspace.status.primaryColor, workspace.status.primaryColor === 'green')} title={`${workspace.branch} · ${workspace.phase}${spaceHolderLabel(workspace) ? ` · ${spaceHolderLabel(workspace)}` : ''}`}>{workspace.name}{launchedFrom(deployment, workspace.id) ? <LaunchedGlyph /> : null}{spaceHolderLabel(workspace) ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· {spaceHolderLabel(workspace)}</span> : null}</SidebarMenuSubButton>
          <SidebarMenuActions showOnHover>
            <SpaceMenu space={workspace} machines={machines} deployment={deployment} onArchive={onArchive} onRestore={onRestore} onMove={onMove} />
          </SidebarMenuActions>
        </SidebarMenuSubItem>;
      })}
      {closed.length ? <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" onClick={() => setShowClosed((value) => !value)} aria-expanded={showClosed} />} icon={glyph(Archive)}>Closed</SidebarMenuSubButton>
        <SidebarMenuBadge>{closed.length}</SidebarMenuBadge>
      </SidebarMenuSubItem> : null}
      {showClosed ? closed.map((workspace) => <SidebarMenuSubItem key={workspace.id}>
        <SidebarMenuSubButton render={<button type="button" onClick={() => onSelectWorkspace(workspace)} />} isActive={selected.kind === 'workspace' && selected.id === workspace.id} icon={glyph(Archive)}>{workspace.name}</SidebarMenuSubButton>
        <SidebarMenuActions showOnHover>
          <SpaceMenu space={workspace} machines={machines} deployment={deployment} onArchive={onArchive} onRestore={onRestore} onMove={onMove} />
        </SidebarMenuActions>
      </SidebarMenuSubItem>) : null}
    </SidebarMenuSub>
  </SidebarMenuItem>;
}

export function AppSidebar({ view, onView, selected, projects, machines, onSelectProject, onSelectWorkspace, onArchive, onRestore, onMove, onNewWorkspace, onNewProject, onOpenSettings, user, deployment }: AppSidebarProps) {
  const userName = user?.name || selected.possessedBy;
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
          {onNewWorkspace ? <Tooltip content="New workspace" side="top">
            <SidebarGroupAction aria-label="New workspace" onClick={() => onNewWorkspace(selected.projectId)}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction>
          </Tooltip> : null}
        </SidebarGroupActions>
        <SidebarMenu>
          {projects.map((project) => <ProjectRows key={project.base.projectId} base={project.base} workspaces={project.workspaces} selected={selected} machines={machines} deployment={deployment} onSelectProject={onSelectProject} onSelectWorkspace={onSelectWorkspace} onArchive={onArchive} onRestore={onRestore} onMove={onMove} onNewWorkspace={onNewWorkspace} />)}
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
