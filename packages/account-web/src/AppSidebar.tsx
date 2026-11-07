import type { DeploymentStatusView, StackStatus } from '@gitspace/protocol';
import type { CloudProjectOperation, CloudWorkspaceDefinition, RemoteBranchState } from '@gitspace/protocol/project-authority';
import type { WorkspaceStatusColor } from '@gitspace/protocol-workspace';
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
import { Activity, Archive, ArrowDown, BookOpen01, ChevronRight, Columns03, DotsHorizontal, FolderClosed, FolderPlus, Key01, Plus, PuzzlePiece01, RefreshCcw01, Rocket02, Settings01, Square, Stars01, Trash01, Zap } from '@untitledui/icons';
import { createContext, Fragment, useContext, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { glyph } from './glyph.js';
import { converging, latestLaunchProgress, launchPhaseLabel, machineConvergence, RELEASE_TARGETS, runningLabel, workspaceRelease, type LaunchTrack } from './release.js';
import { PRODUCT_ROUTE_LABELS, type AppView, type ProductRoute } from './routes.js';
import { operationActive } from './OperationProgress.js';
import { PHASE_LABEL, PHASES, STATUS_COLOR, StatusDot, workspaceStatusColor, workspaceStatusLabel, WorkspaceStatusDot, type AgentScopeView, type ProjectAgentView, type ProjectLifecycleView, type WorkspaceCreationState, type WorkspaceView } from './GitSpaceShell.js';
import { blocks, lit, relation, stackTree, waitsOn, type Lit, type Relation } from './sidebar/graph.js';
import { DependencyText, DOWNSTREAM_TONE, GroupHeading, PhaseTag, PrChip, StackCaption, UPSTREAM_TONE } from './sidebar/parts.js';
import type { ProjectGraph } from './sidebar/project-graph.js';
import { stackPosition, type ChainWorkspace } from './sidebar/StackChain.js';

const NAV: Array<{ view: Exclude<AppView, 'agent'>; icon: IconComponent }> = [
  { view: 'kanban', icon: glyph(Columns03) },
  { view: 'projects', icon: glyph(FolderClosed) },
  { view: 'inference', icon: glyph(Stars01) },
  { view: 'plugins', icon: glyph(PuzzlePiece01) },
  { view: 'skills', icon: glyph(BookOpen01) },
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
  /** The GitSpace project's base branch, which Launch reads from its repository. */
  branch: string;
  /** Read the head of the GitSpace project's branch, then launch every target from that commit. */
  onLaunchBranch(): void | Promise<void>;
  /** Every target returns to the default release. */
  onBackToDefault(): void | Promise<void>;
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
  /** The phase when no definition carries it, as a runtime pane's own listing reports it. */
  phase?: WorkspaceView['phase'];
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
  /** The project's operations its views show: a dot after its name says some run or failed. */
  operations?: readonly CloudProjectOperation[];
  /** Each workspace's relations and linked pull request; absent until read, when rows show no stacks or markers. */
  graph?: ProjectGraph;
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
  onOpenSettings?(section?: 'source' | 'github'): void;
  /** The signed-in user; the footer identity row. */
  user?: { name: string; handle?: string | null };
  /** Null or absent when this install has no deployment status (not a GitSpace tenant). */
  deployment?: SidebarDeploymentProps | null;
  /** The git position of each stacked workspace in the selected workspace's stack, which its row's caption shows. */
  stackStatuses?: ReadonlyMap<string, StackStatus>;
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
      {kind === 'project' && deployment?.isGitSpaceProject ? <MenuItem index={index++} icon={LaunchGlyph} label={`Launch ${deployment.branch}`} disabled={launching} onSelect={() => void deployment.onLaunchBranch()} /> : null}
      {launchable && deployment && launchedFrom(deployment, space.id) ? <MenuItem index={index++} icon={ReopenGlyph} label="Back to default" disabled={launching} onSelect={() => void deployment.onBackToDefault()} /> : null}
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

/** Blue and pulsing while the project's operations run, red once one failed until it is retried or dismissed. */
function ProjectOperationsGlyph({ operations }: { operations: readonly CloudProjectOperation[] }) {
  const failed = operations.filter((operation) => operation.state === 'failed').length;
  const running = operations.filter(operationActive).length;
  if (!failed && !running) return null;
  const summary = `Operations: ${[running ? `${running} running` : null, failed ? `${failed} failed` : null].filter(Boolean).join(', ')}`;
  return <span className="ml-1.5 inline-flex shrink-0 items-center" role="img" title={summary} aria-label={summary}><StatusDot color={failed ? 'red' : 'blue'} pulse={!failed} /></span>;
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

export type SidebarFilter = 'all' | 'needs-you' | 'running' | 'review' | 'ship';
export type SidebarGroupBy = 'none' | 'state' | 'phase';
/** A row's state for filters and Group by State: its status colour read as what it asks of you. */
type RowState = 'needs-you' | 'failed' | 'running' | 'waiting' | 'idle';
const STATE_OF: Record<WorkspaceStatusColor, RowState> = { orange: 'needs-you', red: 'failed', green: 'running', blue: 'waiting', dim: 'idle' };
const STATE_LABEL: Record<RowState, string> = { 'needs-you': 'Needs you', failed: 'Failed', running: 'Running', waiting: 'Waiting', idle: 'Idle' };
const STATE_COLOR: Record<RowState, WorkspaceStatusColor> = { 'needs-you': 'orange', failed: 'red', running: 'green', waiting: 'blue', idle: 'dim' };
const STATE_ORDER: readonly RowState[] = ['needs-you', 'failed', 'running', 'waiting', 'idle'];
const FILTERS: readonly { id: SidebarFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'needs-you', label: 'Needs you' }, { id: 'running', label: 'Running' }, { id: 'review', label: 'Review' }, { id: 'ship', label: 'Ship' }];
const GROUP_BYS: readonly { id: SidebarGroupBy; label: string }[] = [{ id: 'none', label: 'None' }, { id: 'state', label: 'State' }, { id: 'phase', label: 'Phase' }];
/** Left inset of a first-level row, a row in a stack and a grouped row; the x of each tree guide line. */
const INSET = { first: 14, stacked: 30, grouped: 8 };
const FIRST_GUIDES: readonly number[] = [7];
const STACK_GUIDES: readonly number[] = [7, 21];

/** An open workspace as its row and the stack chain read it. */
interface RowItem extends ChainWorkspace { workspace: SidebarWorkspace; summary: SidebarSpaceSummary | undefined; state: RowState; phase: WorkspaceView['phase'] | null }

function rowItem(workspace: SidebarWorkspace, graph: ProjectGraph | undefined): RowItem {
  const summary = sidebarWorkspaceSummary(workspace);
  const relations = graph?.relations[workspace.id];
  return {
    id: workspace.id, name: workspace.name, branch: workspace.branch, dependsOn: relations?.dependsOn ?? [], stackedOn: relations?.stackedOn ?? null,
    status: summary, workspace, summary, state: STATE_OF[summary ? workspaceStatusColor(summary) : 'dim'], phase: workspace.definition?.phase ?? workspace.phase ?? null,
  };
}

function matches(item: RowItem, filter: SidebarFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs-you' || filter === 'running') return item.state === filter;
  return item.phase === filter;
}

/** A workspace row: the status dot and name, then its stack parent, phase, pull request and what it waits on or blocks.
 * A focused workspace lights what it waits on (violet edge) and what waits on it (teal edge); unrelated rows recede. */
function WorkspaceRow({ item, kin, selected, inset, guides, meta, flags, dimmed, actions, onHover, onSelect }: { item: RowItem; kin: Relation; selected: boolean; inset: number; guides: readonly number[]; meta: ReactNode; flags: ReactNode; dimmed: boolean; actions: ReactNode; onHover(id: string | null): void; onSelect(): void }) {
  const { summary } = item;
  const tone = kin === 'upstream' ? UPSTREAM_TONE : kin === 'downstream' ? DOWNSTREAM_TONE : null;
  const released = summary?.holder.kind === 'released';
  const freshness = summary?.freshness ?? (summary?.status ? 'fresh' : 'unknown');
  return <SidebarMenuSubItem data-workspace={item.id} data-relation={kin}>
    <button type="button" aria-current={selected ? 'page' : undefined} title={`${item.branch} · ${summary ? summaryLabel(summary) : 'Status unknown'}${released && !summary?.closedAt ? ' · released' : ''}`} aria-description={summary?.detail ?? undefined}
      onMouseEnter={() => onHover(item.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(item.id)} onBlur={() => onHover(null)} onClick={onSelect}
      className={`relative flex w-full min-w-0 select-none flex-col gap-0.5 rounded-[10px] py-[5px] pr-2 text-left outline-none transition-[opacity,background-color] duration-150 group-hover/menu-sub-item:pr-8 focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50 ${selected ? 'bg-active' : 'hover:bg-hover'} ${kin === 'unrelated' || dimmed ? 'opacity-40' : ''}`}
      style={{ paddingLeft: inset }}>
      {guides.map(x => <span key={x} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: x }} />)}
      {tone ? <>
        <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 rounded-[10px]" style={{ left: Math.max(inset - 6, 0), background: `linear-gradient(90deg, color-mix(in oklab, ${tone} 16%, transparent), transparent 75%)` }} />
        <span aria-hidden className="pointer-events-none absolute inset-y-1 w-0.5 rounded-full" style={{ left: Math.max(inset - 6, 1), background: tone, boxShadow: `0 0 8px color-mix(in oklab, ${tone} 60%, transparent)` }} />
      </> : null}
      <span className="relative flex min-w-0 items-center gap-1.5">
        <span className="inline-flex size-4 shrink-0 items-center justify-center" data-freshness={freshness}>{summary?.closedAt ? <ArchiveGlyph size={14} strokeWidth={1.5} /> : summary ? <WorkspaceStatusDot space={summary} /> : <StatusDot color="dim" />}</span>
        <span className={`min-w-0 truncate text-body ${released ? 'text-muted-foreground' : item.state === 'needs-you' || selected ? 'font-medium text-foreground' : 'text-foreground/90'}`}>{item.name}</span>
        {flags}
      </span>
      <span className="relative flex min-w-0 items-center gap-1.5 pl-[22px] text-[11px] text-muted-foreground">{meta}</span>
    </button>
    <SidebarMenuActions showOnHover>{actions}</SidebarMenuActions>
  </SidebarMenuSubItem>;
}

/** Orange and green counts after a project's name: how many of its workspaces need you and how many run. Inline in the
 * row's button, which leaves room for the row's actions, so the actions never cover them. */
function StateCounts({ items }: { items: readonly RowItem[] }) {
  const needs = items.filter(item => item.state === 'needs-you').length;
  const running = items.filter(item => item.state === 'running').length;
  if (!needs && !running) return null;
  return <span className="ml-1.5 inline-flex shrink-0 items-center gap-1.5 text-[11px] tabular-nums" title={[needs ? `${needs} need you` : null, running ? `${running} last reported working` : null].filter(Boolean).join(' · ')}>
    {needs ? <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR.orange }} />{needs}</span> : null}
    {running ? <span className="inline-flex items-center gap-1 text-muted-foreground"><span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR.green }} />{running}</span> : null}
  </span>;
}

interface ProjectRowsProps extends Pick<AppSidebarProps, 'selected' | 'deployment' | 'onSelectProject' | 'onSelectWorkspace' | 'onReleaseMachines' | 'releasePendingSpaceId' | 'onArchive' | 'onRestore' | 'onDelete' | 'onNewWorkspace' | 'onOpenProjectSettings' | 'onOpenProjectAutomations'> {
  project: SidebarProject;
  collapsed: boolean;
  onCollapse(projectId: string, collapsed: boolean): void;
  filter: SidebarFilter;
  groupBy: SidebarGroupBy;
  hovered: string | null;
  onHover(id: string | null): void;
  stackStatuses: ReadonlyMap<string, StackStatus>;
}

function ProjectRows({ project, collapsed, onCollapse, selected, deployment, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId, onArchive, onRestore, onDelete, onNewWorkspace, onOpenProjectSettings, onOpenProjectAutomations, filter, groupBy, hovered, onHover, stackStatuses }: ProjectRowsProps) {
  const { base, workspaces, graph } = project;
  const [showArchived, setShowArchived] = useState(false);
  const items = workspaces.filter((workspace) => !workspace.closedAt).map((workspace) => rowItem(workspace, graph));
  const archived = workspaces.filter((workspace) => !!workspace.closedAt).map((workspace) => rowItem(workspace, undefined));
  const baseSelected = selected?.workspaceId === null && selected.projectId === project.id;
  const selectedId = selected?.projectId === project.id ? selected.workspaceId : null;
  // A folded project still shows its selected workspace, without rewriting the stored preference.
  const open = !collapsed || (selected?.projectId === project.id && selected.workspaceId !== null);
  const baseSummary = project.baseSummary ?? base;
  const baseReleased = baseSummary && !baseSummary.closedAt && baseSummary.holder.kind === 'released';
  const createWorkspace = onNewWorkspace && project.lifecycle !== 'archived' && project.lifecycle !== 'deleting' ? () => onNewWorkspace(project.id) : undefined;
  const names = new Map(items.map((item) => [item.id, item.name]));
  const byId = new Map(items.map((item) => [item.id, item]));
  const caption = (item: RowItem) => {
    const parent = item.stackedOn ? byId.get(item.stackedOn) : undefined;
    return parent ? <StackCaption parent={parent.name} position={stackPosition(stackStatuses.get(item.id), parent)} /> : null;
  };
  // A focus with nothing related lights nothing, rather than fading every other row.
  const focus = [hovered, selectedId].map((id) => lit(items, id)).find((light): light is Lit => light !== null && light.upstream.size + light.downstream.size > 0) ?? null;
  const row = (item: RowItem, inset: number, guides: readonly number[], meta: ReactNode, dimmed: boolean) => {
    const summary = item.summary;
    return <WorkspaceRow key={item.id} item={item} kin={relation(focus, item.id)} selected={selectedId === item.id} inset={inset} guides={guides} dimmed={dimmed} onHover={onHover} onSelect={() => onSelectWorkspace(item.workspace)} meta={meta}
      flags={<>{item.workspace.definition?.remote?.behind ? <BehindOriginGlyph branch={item.branch} /> : null}{launchedFrom(deployment, item.id) ? <LaunchedGlyph /> : null}{summary?.holder.kind === 'released' && !summary.closedAt ? <span className="ml-1 shrink-0 text-caption text-muted-foreground/70">· released</span> : null}</>}
      actions={<SpaceMenu space={item.workspace} kind="workspace" summary={summary} deployment={deployment} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} />} />;
  };
  /** The second line after the stack caption and phase or state: the linked pull request and what blocks it or what it
   * blocks. A dependency blocks while it is open and not in Ship, as the server's `blockedBy` reads it; an archived one
   * is not listed here, and one of unknown phase says nothing. */
  const markers = (item: RowItem) => {
    const pr = graph?.pullRequests[item.id];
    const holds = (id: string) => {
      const phase = byId.get(id)?.phase;
      return !!phase && phase !== 'ship';
    };
    return <>{pr ? <PrChip pr={pr} /> : null}<DependencyText blockedBy={waitsOn(item).filter(holds).flatMap((id) => names.get(id) ?? [])} blocking={holds(item.id) ? blocks(items, item.id).flatMap((id) => names.get(id) ?? []) : []} /></>;
  };
  const tree = () => {
    // One run per first-level row and its stack; a run shows whole while any of it matches the filter, its other rows dimmed.
    const runs: { item: RowItem; stacked: boolean }[][] = [];
    for (const entry of stackTree(items)) {
      if (!entry.stacked || !runs.length) runs.push([entry]);
      else runs.at(-1)?.push(entry);
    }
    return runs.filter((run) => run.some(({ item }) => matches(item, filter))).flat().map(({ item, stacked }) =>
      row(item, stacked ? INSET.stacked : INSET.first, stacked ? STACK_GUIDES : FIRST_GUIDES, <>{stacked ? caption(item) : null}<PhaseTag phase={item.phase} />{markers(item)}</>, !matches(item, filter)));
  };
  const grouped = (by: 'state' | 'phase') => {
    const shown = items.filter((item) => matches(item, filter));
    const groups = by === 'state'
      ? STATE_ORDER.map((state) => ({ key: state, label: STATE_LABEL[state], tone: STATUS_COLOR[STATE_COLOR[state]], items: shown.filter((item) => item.state === state) }))
      : [...[...PHASES].reverse().map((phase) => ({ key: phase, label: PHASE_LABEL[phase], tone: undefined, items: shown.filter((item) => item.phase === phase) })), { key: 'unknown', label: 'Phase unknown', tone: undefined, items: shown.filter((item) => item.phase === null) }];
    return groups.filter((group) => group.items.length).map((group) => <Fragment key={group.key}>
      <li className="list-none"><GroupHeading tone={group.tone} count={group.items.length}>{group.label}</GroupHeading></li>
      {group.items.map((item) => row(item, INSET.grouped, [], <>{caption(item)}{by === 'state' ? <PhaseTag phase={item.phase} /> : <span className="shrink-0">{STATE_LABEL[item.state]}</span>}{markers(item)}</>, false))}
    </Fragment>);
  };
  return <SidebarMenuItem>
    <SpaceSummaryContext.Provider value={baseSummary}>
      <SidebarMenuButton className={baseReleased ? 'text-muted-foreground' : undefined} icon={SpaceStatusGlyph} isActive={baseSelected} title={[baseSummary ? `Base · ${summaryLabel(baseSummary)}${baseReleased ? ' · released' : ''}` : project.lifecycle === 'cloud-only' ? 'Saved in your account · no checkout' : `${project.name} · Status unknown`, project.error].filter(Boolean).join(' · ')} aria-description={project.error ?? undefined} onClick={() => onSelectProject?.(project.id)}>{project.name}<StateCounts items={items} />{project.operations?.length ? <ProjectOperationsGlyph operations={project.operations} /> : null}{project.remote?.behind ? <BehindOriginGlyph branch={base?.branch ?? null} /> : null}{baseReleased ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· released</span> : null}</SidebarMenuButton>
    </SpaceSummaryContext.Provider>
    <SidebarMenuActions showOnHover={open}>
      <SidebarMenuAction aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={open} onClick={() => onCollapse(project.id, open)}><ChevronRight width={16} height={16} strokeWidth={1.5} className={open ? 'rotate-90 transition-[rotate] duration-80' : 'transition-[rotate] duration-80'} /></SidebarMenuAction>
      {createWorkspace ? <Tooltip content="New workspace" side="top"><SidebarMenuAction className={open ? undefined : FOLDED_ACTION_REVEAL} aria-label={`New workspace in ${project.name}`} onClick={createWorkspace}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip> : null}
      <SpaceMenu space={base ?? project} kind="project" summary={baseSummary} deployment={deployment} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onInspect={onSelectProject ? () => onSelectProject(project.id) : undefined} onNewWorkspace={createWorkspace} onOpenProjectSettings={onOpenProjectSettings ? () => onOpenProjectSettings(project.id) : undefined} onOpenAutomations={onOpenProjectAutomations ? () => onOpenProjectAutomations(project.id) : undefined} triggerClassName={open ? undefined : FOLDED_ACTION_REVEAL} />
    </SidebarMenuActions>
    <SidebarMenuSub open={open} className="ml-0 gap-0 border-l-0 pl-1">
      {groupBy === 'none' ? tree() : grouped(groupBy)}
      {items.length && !items.some((item) => matches(item, filter)) ? <li className="list-none px-2 py-1 text-[11px] text-muted-foreground">No workspaces match this filter</li> : null}
      {archived.length ? <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived} />} icon={ArchiveGlyph}>Archived</SidebarMenuSubButton>
        <SidebarMenuBadge>{archived.length}</SidebarMenuBadge>
      </SidebarMenuSubItem> : null}
      {showArchived || archived.some((item) => item.id === selectedId) ? archived.map((item) => row(item, INSET.first, [], <PhaseTag phase={item.phase} />, false)) : null}
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

const GROUP_BY_KEY = 'gitspace.sidebar.groupBy';

function readGroupBy(): SidebarGroupBy {
  if (typeof window === 'undefined') return 'none';
  let stored: string | null = null;
  try { stored = window.localStorage.getItem(GROUP_BY_KEY); } catch { /* private mode */ }
  return GROUP_BYS.find((option) => option.id === stored)?.id ?? 'none';
}

export function AppSidebar({ view, onView, selected, selectedSummary, projects, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId = null, onArchive, onRestore, onDelete, onNewWorkspace, onNewProject, onOpenSettings, onOpenProjectSettings, onOpenProjectAutomations, failedAutomationRuns = 0, user, deployment, stackStatuses = new Map() }: AppSidebarProps) {
  const userName = user?.name || 'Your account';
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects);
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const [groupBy, setGroupBy] = useState(readGroupBy);
  const [hovered, setHovered] = useState<string | null>(null);
  const collapseProject = (projectId: string, collapse: boolean): void => {
    const next = new Set(collapsedProjects);
    if (collapse) next.add(projectId);
    else next.delete(projectId);
    setCollapsedProjects(next);
    try { window.localStorage.setItem(COLLAPSED_PROJECTS_KEY, JSON.stringify([...next])); } catch { /* private mode */ }
  };
  const chooseGroupBy = (next: SidebarGroupBy): void => {
    setGroupBy(next);
    try { window.localStorage.setItem(GROUP_BY_KEY, next); } catch { /* private mode */ }
  };
  const shown = projects.map((project) => selectedSummary && selected?.projectId === project.id
    ? selected.workspaceId === null
      ? { ...project, baseSummary: selectedSummary }
      : { ...project, workspaces: project.workspaces.map((workspace) => workspace.id === selected.workspaceId ? { ...workspace, summary: selectedSummary } : workspace) }
    : project);
  const all = shown.flatMap((project) => project.workspaces.filter((workspace) => !workspace.closedAt).map((workspace) => rowItem(workspace, undefined)));
  return <Sidebar variant="inset">
    <SidebarHeader>
      <SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} />
      <nav aria-label="Navigate" className="flex items-center justify-between px-0.5">
        {NAV.map((item) => <Tooltip key={item.view} content={item.view === 'automations' && failedAutomationRuns > 0 ? `${PRODUCT_ROUTE_LABELS[item.view]} · ${failedAutomationRuns} ${failedAutomationRuns === 1 ? 'run' : 'runs'} failed today` : PRODUCT_ROUTE_LABELS[item.view]} side="bottom">
          <button type="button" aria-label={PRODUCT_ROUTE_LABELS[item.view]} aria-current={view === item.view ? 'page' : undefined} onClick={() => onView(item.view)}
            className={`relative flex size-7 items-center justify-center rounded-lg hover:bg-hover hover:text-foreground ${view === item.view ? 'bg-active text-foreground' : 'text-muted-foreground'}`}>
            <item.icon size={16} strokeWidth={1.5} />
            {item.view === 'automations' && failedAutomationRuns > 0 ? <span className="absolute right-1 top-1 size-1.5 rounded-full" style={{ background: STATUS_COLOR.red }} /> : null}
          </button>
        </Tooltip>)}
      </nav>
    </SidebarHeader>

    <SidebarContent>
      <div className="flex flex-col gap-1.5 pb-1 pt-1">
        <div role="group" aria-label="Filter workspaces" className="flex flex-wrap items-center gap-1 px-2">
          {FILTERS.map((option) => {
            const pressed = option.id === filter;
            const count = all.filter((item) => matches(item, option.id)).length;
            const tone = option.id === 'needs-you' ? STATUS_COLOR.orange : option.id === 'running' ? STATUS_COLOR.green : null;
            return <button type="button" key={option.id} aria-pressed={pressed} onClick={() => setFilter(option.id)}
              className={`inline-flex h-6 items-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-colors duration-150 ${pressed ? 'bg-active text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}>
              {tone ? <span className="size-1.5 rounded-full" style={{ background: tone }} /> : null}
              {option.label}
              <span className={`min-w-4 rounded-full px-1 text-center text-[10.5px] leading-4 tabular-nums ${pressed ? 'bg-background text-foreground' : 'bg-muted text-muted-foreground'}`}>{count}</span>
            </button>;
          })}
        </div>
        <div role="group" aria-label="Group by" className="flex items-center gap-1 px-2 text-[11px] text-muted-foreground">
          Group by
          {GROUP_BYS.map((option) => <button type="button" key={option.id} aria-pressed={groupBy === option.id} onClick={() => chooseGroupBy(option.id)}
            className={`rounded-md px-1.5 py-0.5 ${groupBy === option.id ? 'bg-active text-foreground' : 'hover:bg-hover hover:text-foreground'}`}>{option.label}</button>)}
          {groupBy === 'none' ? <span className="ml-auto truncate text-muted-foreground/80">stacks</span> : null}
        </div>
      </div>

      <SidebarGroup collapsible>
        <SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarGroupActions>
          {onNewProject ? <Tooltip content="New project" side="top">
            <SidebarGroupAction aria-label="New project" onClick={onNewProject}><FolderPlus width={16} height={16} strokeWidth={1.5} /></SidebarGroupAction>
          </Tooltip> : null}
        </SidebarGroupActions>
        <SidebarMenu>
          {shown.map((project) => <ProjectRows key={project.id} project={project} collapsed={collapsedProjects.has(project.id)} onCollapse={collapseProject} selected={selected} deployment={deployment} onSelectProject={onSelectProject} onSelectWorkspace={onSelectWorkspace} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} onNewWorkspace={onNewWorkspace} onOpenProjectSettings={onOpenProjectSettings} onOpenProjectAutomations={onOpenProjectAutomations}
            filter={filter} groupBy={groupBy} hovered={hovered} onHover={setHovered} stackStatuses={stackStatuses} />)}
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
