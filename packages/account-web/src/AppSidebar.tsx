import type { DeploymentStatusView } from '@gitspace/protocol';
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
  ThinkingIndicator,
  Tooltip,
  DropdownLabel,
  DropdownSeparator,
  type IconComponent,
} from '@gitspace/ui';
import { Activity, Archive, ArrowDown, ArrowUp, BookOpen01, Check, ChevronRight, Columns03, DotsHorizontal, Edit03, FolderClosed, FolderPlus, GitBranch01, Hourglass03, Key01, Link03, Lock01, Plus, PuzzlePiece01, RefreshCcw01, Rocket02, Settings01, Square, Stars01, Stars02, Trash01, Zap } from '@untitledui/icons';
import { AnimatePresence, motion } from 'framer-motion';
import { createContext, Fragment, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { glyph } from './glyph.js';
import { converging, latestLaunchProgress, launchPhaseLabel, machineConvergence, RELEASE_TARGETS, runningLabel, workspaceRelease, type LaunchTrack } from './release.js';
import { PRODUCT_ROUTE_LABELS, type AppView, type ProductRoute } from './routes.js';
import { operationActive } from './OperationProgress.js';
import { PHASE_LABEL, PHASES, STATUS_COLOR, StatusDot, workspaceStatusColor, workspaceStatusLabel, WorkspaceStatusDot, type AgentScopeView, type ProjectAgentView, type ProjectLifecycleView, type WorkspaceCreationState, type WorkspaceView } from './GitSpaceShell.js';
import { blocks, lit, relation, stackBelow, stackTree, type Lit, type Relation } from './sidebar/graph.js';
import { ACCENT, DOWNSTREAM_TONE, GroupHeading, HeadTag, LabelText, PhaseTag, PrChips, StackCaption, StackMarker, UPSTREAM_TONE } from './sidebar/parts.js';
import type { ProjectGraph } from './sidebar/project-graph.js';
import { stackPosition, type ChainWorkspace } from './sidebar/StackChain.js';
import { phaseRefusal, pickRefusal, type PickKind } from './sidebar/stack-rules.js';
import { StackToasts, useStackToast } from './sidebar/stack-toast.js';

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
  /** The main agent's latest message as one line of plain text (the status row's `preview`); null before one. */
  preview?: string | null;
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
const RenameGlyph = glyph(Edit03);
const CloseGlyph = glyph(Square);
const LaunchGlyph = glyph(Rocket02);
const SettingsGlyph = glyph(Settings01);
const ProjectGlyph = glyph(FolderClosed);
const NewWorkspaceGlyph = glyph(Plus);
const AutomationsGlyph = glyph(Zap);
const StackGlyph = glyph(GitBranch01);
const UnstackGlyph = glyph(ArrowUp);
const WaitsGlyph = glyph(Hourglass03);
const RelatedGlyph = glyph(Link03);

/** The project row's status slot: the project agent's sparkle, with the base's status dot on its corner. Icon slots take
 * component types, so keep this type stable while context updates the accepted status. */
function AgentGlyph({ className, size, strokeWidth }: IconComponentProps) {
  const summary = useContext(SpaceSummaryContext);
  const freshness = summary?.freshness ?? (summary?.status ? 'fresh' : 'unknown');
  return <span className={`relative inline-flex items-center justify-center ${className ?? ''}`} style={{ width: size, height: size, color: summary?.closedAt ? undefined : ACCENT }} data-freshness={freshness}>
    {summary?.closedAt ? <ArchiveGlyph size={size} strokeWidth={strokeWidth} /> : <>
      <Stars02 width={size} height={size} strokeWidth={1.5} />
      <span className="absolute -bottom-[3px] -right-[3px] inline-flex rounded-full bg-background p-px">{summary ? <WorkspaceStatusDot space={summary} /> : <StatusDot color="dim" />}</span>
    </>}
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
  /** Renames a workspace: its id and branch stay. */
  onRename?(spaceId: string, name: string): void | Promise<void>;
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
  /** Writes a workspace's relations over `expected`, what the list last read (the server refuses, by throwing, when they
   * changed since), and resolves to the relations it applied. Absent: the list offers no stack, waits-on or related
   * changes. */
  onSetRelations?(workspaceId: string, relations: WorkspaceView['relations'], expected: WorkspaceView['relations']): Promise<WorkspaceView['relations']>;
  /** Moves any workspace's phase from `expectedPhase`, what the list last read (refused, by throwing, when it changed
   * since; null when unread). Absent: rows offer no phase section. */
  onSetPhase?(projectId: string, workspaceId: string, phase: WorkspaceView['phase'], expectedPhase: WorkspaceView['phase'] | null): Promise<void>;
}

/** A row menu's stack and relation action. */
interface StackAction { key: string; label: string; icon: IconComponent; act(): void }
/** A row menu's Phase section: the phase it is in, why each other one is refused (null when it isn't), and the move. */
export interface PhaseSection { current: WorkspaceView['phase'] | null; refusal(phase: WorkspaceView['phase']): string | null; onSet(phase: WorkspaceView['phase']): void }

/** Why a menu item or a picked row is refused, under it. */
function Refusal({ why }: { why: string }) {
  return <span className="flex items-start gap-1 px-2 pb-1.5 text-[11px] leading-snug text-muted-foreground"><Lock01 width={11} height={11} className="mt-[2px] shrink-0" />{why}</span>;
}

/** The four phases as menu items from `from`; one the phase rule refuses is disabled, with why under it. */
export function PhaseMenuItems({ phase, from }: { phase: PhaseSection; from: number }) {
  return <>{PHASES.map((option, index) => {
    const why = phase.refusal(option);
    return <Fragment key={option}>
      <MenuItem index={from + index} label={PHASE_LABEL[option]} checked={option === phase.current} disabled={why !== null} onSelect={() => { if (option !== phase.current) phase.onSet(option); }} />
      {why ? <Refusal why={why} /> : null}
    </Fragment>;
  })}</>;
}

/** Whether any account target selects this workspace's newest release. */
function launchedFrom(deployment: SidebarDeploymentProps | null | undefined, workspaceId: string): boolean {
  if (!deployment) return false;
  const release = workspaceRelease(deployment.status, workspaceId);
  return release !== null && RELEASE_TARGETS.some((target) => deployment.status.desired[target] === release.sha);
}

function SpaceMenu({ space, kind, summary, deployment, onReleaseMachines, releasePendingSpaceId, onArchive, onRestore, onDelete, onRename, onInspect, onNewWorkspace, onOpenProjectSettings, onOpenAutomations, phase, stack = [], triggerClassName }: { space: Pick<AgentScopeView, 'id' | 'name'>; kind: AgentScopeView['kind']; summary?: SidebarSpaceSummary; onRename?: () => void; onInspect?: () => void; onNewWorkspace?: () => void; onOpenProjectSettings?: () => void; onOpenAutomations?: () => void; phase?: PhaseSection; stack?: readonly StackAction[]; triggerClassName?: string } & Pick<AppSidebarProps, 'deployment' | 'onReleaseMachines' | 'releasePendingSpaceId' | 'onArchive' | 'onRestore' | 'onDelete'>) {
  const archived = !!summary?.closedAt;
  const held = !archived && summary?.holder.kind === 'held';
  const launchable = (held || (!archived && summary?.holder.kind === 'cloud')) && deployment?.isGitSpaceProject === true;
  const canRelease = !archived && !summary?.creation && !!onReleaseMachines;
  const canRestore = kind === 'workspace' && archived && !!onRestore;
  const canArchive = kind === 'workspace' && !archived && !summary?.creation && !!onArchive;
  const canDelete = kind === 'workspace' && !!onDelete;
  const canRename = kind === 'workspace' && !summary?.creation && !!onRename;
  const phased = kind === 'workspace' && !archived && phase !== undefined;
  const stacking = kind === 'workspace' && !archived && stack.length > 0;
  const tail = canRelease || canRestore || canArchive || canDelete || launchable || (kind === 'project' && !!deployment?.isGitSpaceProject);
  if (!onInspect && !onNewWorkspace && !onOpenProjectSettings && !onOpenAutomations && !canRelease && !canRestore && !canArchive && !canDelete && !canRename && !launchable && !phased && !stacking) return null;
  const launching = deployment?.launch?.status === 'running';
  let index = 0;
  const head = (onInspect ? 1 : 0) + (onNewWorkspace ? 1 : 0) + (onOpenProjectSettings ? 1 : 0) + (onOpenAutomations ? 1 : 0) + (canRename ? 1 : 0);
  const phases = phased ? PHASES.length : 0;
  let next = head + phases + (stacking ? stack.length : 0);
  const checked = phased && phase.current ? head + PHASES.indexOf(phase.current) : undefined;
  return <DropdownMenu>
    <DropdownTrigger render={<SidebarMenuAction className={triggerClassName} aria-label={`Space actions for ${space.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction>} />
    <DropdownContent className="min-w-[240px] w-[240px]" align="start" sideOffset={4} checkedIndex={checked}>
      {onInspect ? <MenuItem index={index++} icon={ProjectGlyph} label="Open project" onSelect={onInspect} /> : null}
      {onNewWorkspace ? <MenuItem index={index++} icon={NewWorkspaceGlyph} label="New workspace" onSelect={onNewWorkspace} /> : null}
      {onOpenProjectSettings ? <MenuItem index={index++} icon={SettingsGlyph} label="Project settings" onSelect={onOpenProjectSettings} /> : null}
      {onOpenAutomations ? <MenuItem index={index++} icon={AutomationsGlyph} label="Automations" onSelect={onOpenAutomations} /> : null}
      {canRename ? <MenuItem index={index++} icon={RenameGlyph} label="Rename workspace" onSelect={() => onRename?.()} /> : null}
      {phased ? <>{head ? <DropdownSeparator /> : null}<DropdownLabel>Phase</DropdownLabel><PhaseMenuItems phase={phase} from={head} /></> : null}
      {stacking ? <>{head + phases ? <DropdownSeparator /> : null}{stack.map((action, offset) => <MenuItem key={action.key} index={head + phases + offset} icon={action.icon} label={action.label} onSelect={action.act} />)}</> : null}
      {(phased || stacking) && tail ? <DropdownSeparator /> : null}
      {canRelease ? <MenuItem index={next++} icon={CloseGlyph} label={releasePendingSpaceId === space.id ? 'Releasing machine caches…' : 'Release machine caches'} disabled={releasePendingSpaceId !== null && releasePendingSpaceId !== undefined} onSelect={() => void onReleaseMachines?.(space.id)} /> : null}
      {canRestore ? <MenuItem index={next++} icon={ReopenGlyph} label="Restore workspace" onSelect={() => void onRestore?.(space.id)} /> : null}
      {canArchive ? <MenuItem index={next++} icon={ArchiveGlyph} label="Archive workspace" onSelect={() => void onArchive?.(space.id)} /> : null}
      {canDelete ? <MenuItem index={next++} icon={DeleteGlyph} label="Delete workspace" onSelect={() => void onDelete?.(space.id)} /> : null}
      {launchable && deployment ? <MenuItem index={next++} icon={LaunchGlyph} label="Launch GitSpace from here" disabled={launching} onSelect={() => void deployment.onLaunch(space.id)} /> : null}
      {kind === 'project' && deployment?.isGitSpaceProject ? <MenuItem index={next++} icon={LaunchGlyph} label={`Launch ${deployment.branch}`} disabled={launching} onSelect={() => void deployment.onLaunchBranch()} /> : null}
      {launchable && deployment && launchedFrom(deployment, space.id) ? <MenuItem index={next++} icon={ReopenGlyph} label="Back to default" disabled={launching} onSelect={() => void deployment.onBackToDefault()} /> : null}
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
/** Left inset of a first-level row and of a row in a stack; the x of each tree guide line. */
const INSET = { first: 14, stacked: 30 };
const FIRST_GUIDES: readonly number[] = [7];
const STACK_GUIDES: readonly number[] = [7, 21];
const ROW = 'relative flex w-full min-w-0 select-none flex-col gap-0.5 rounded-[10px] py-[5px] text-left outline-none transition-[opacity,background-color] duration-150 focus-visible:ring-2 focus-visible:ring-[#6B97FF]/50';

/** An open workspace as its row, the stack chain and the phase rule read it: its relations, its branch's position against
 * its parent and whether it is ahead of that parent, as the project view last published them (`known` once read). */
interface RowItem extends ChainWorkspace { workspace: SidebarWorkspace; summary: SidebarSpaceSummary | undefined; state: RowState; phase: WorkspaceView['phase'] | null; relatedTo: readonly string[]; aheadOfParent: string | null; known: boolean }

function rowItem(workspace: SidebarWorkspace, graph: ProjectGraph | undefined): RowItem {
  const summary = sidebarWorkspaceSummary(workspace);
  const relations = graph?.relations[workspace.id];
  return {
    id: workspace.id, name: workspace.name, branch: workspace.branch, dependsOn: relations?.dependsOn ?? [], relatedTo: relations?.relatedTo ?? [], stackedOn: relations?.stackedOn ?? null,
    position: relations?.position ?? null, aheadOfParent: relations?.aheadOfParent ?? null, known: relations !== undefined,
    status: summary, workspace, summary, state: STATE_OF[summary ? workspaceStatusColor(summary) : 'dim'], phase: workspace.definition?.phase ?? workspace.phase ?? null,
  };
}

function relationsOf(item: RowItem): WorkspaceView['relations'] {
  return { dependsOn: item.dependsOn, relatedTo: item.relatedTo, stackedOn: item.stackedOn };
}

function matches(item: RowItem, filter: SidebarFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'needs-you' || filter === 'running') return item.state === filter;
  return item.phase === filter;
}

/** What a project lists: a group heading, or a row (faded when it is only there to keep its stack whole). `key` names
 * the entry a landing preview follows. */
type Entry = { kind: 'heading'; key: string; label: string; tone: string | undefined; count: number } | { kind: 'row'; key: string; item: RowItem; stacked: boolean; dimmed: boolean };

/**
 * A project's rows under a filter and a grouping. Every grouping draws stacks whole, as the tree draws them: a stack shows
 * while any of it matches, the rest faded. State and Phase put each stack under its head's group; a heading counts the
 * project's workspaces whose own state or phase is the heading's and that pass the filter, wherever their stack is drawn,
 * so it agrees with the filter tabs.
 */
function listEntries(items: readonly RowItem[], filter: SidebarFilter, groupBy: SidebarGroupBy): Entry[] {
  const runs: { item: RowItem; stacked: boolean }[][] = [];
  for (const entry of stackTree(items)) {
    if (!entry.stacked || !runs.length) runs.push([entry]);
    else runs.at(-1)?.push(entry);
  }
  const shown = runs.filter((run) => run.some(({ item }) => matches(item, filter)));
  const rows = (run: readonly { item: RowItem; stacked: boolean }[]) => run.map(({ item, stacked }): Entry => ({ kind: 'row', key: item.id, item, stacked, dimmed: !matches(item, filter) }));
  if (groupBy === 'none') return shown.flatMap(rows);
  const groups: { key: string; label: string; tone: string | undefined; holds(item: RowItem): boolean }[] = groupBy === 'state'
    ? STATE_ORDER.map((state) => ({ key: state, label: STATE_LABEL[state], tone: STATUS_COLOR[STATE_COLOR[state]], holds: (item: RowItem) => item.state === state }))
    : [...[...PHASES].reverse().map((phase) => ({ key: phase, label: PHASE_LABEL[phase], tone: undefined, holds: (item: RowItem) => item.phase === phase })), { key: 'unknown', label: 'Phase unknown', tone: undefined, holds: (item: RowItem) => item.phase === null }];
  return groups.flatMap((group): Entry[] => {
    const held = shown.filter((run) => run[0] && group.holds(run[0].item));
    if (!held.length) return [];
    const count = items.filter((item) => group.holds(item) && matches(item, filter)).length;
    return [{ kind: 'heading', key: `heading-${group.key}`, label: group.label, tone: group.tone, count }, ...held.flatMap(rows)];
  });
}

/** Where stacking `source` onto `onto` (or `top`, the top level) would put it: after which entry and at which level,
 * read from the list the change would draw under the same filter and grouping; null when it is already there. */
function landing(items: readonly RowItem[], source: RowItem, onto: string, filter: SidebarFilter, groupBy: SidebarGroupBy): { after: string | null; stacked: boolean } | null {
  if ((source.stackedOn ?? 'top') === onto) return null;
  const preview = listEntries(items.map((item) => item.id === source.id ? { ...item, stackedOn: onto === 'top' ? null : onto } : item), filter, groupBy);
  const index = preview.findIndex((entry) => entry.key === source.id);
  const at = preview[index];
  return at?.kind === 'row' ? { after: preview[index - 1]?.key ?? null, stacked: at.stacked } : null;
}

/** The list choosing for one workspace: what it stacks on (applied on a pick), or its waits-on or related set (`draft`,
 * applied by Done). */
type Mode = { kind: PickKind; projectId: string; id: string; draft: readonly string[] };
/** A row while choosing: the source, a choice (its ring filled once chosen), or refused, with why. */
type Target = { role: 'source' } | { role: 'choice'; chosen: boolean } | { role: 'refused'; why: string };

/** The list's picker, shared by every project's rows. `hover` is the choice under the pointer (a workspace, or `top`
 * for the project row while stacking). */
interface Picker {
  mode: Mode | null;
  hover: string | null;
  setHover(id: string | null): void;
  dragging: string | null;
  setDragging(id: string | null): void;
  start(item: RowItem, kind: PickKind): void;
  /** A click (or a drop) on a row, or `top` on the project row. A stack applies; a waits-on or related toggles the draft. */
  pick(id: string): void;
  leave(): void;
}
/** Writes a workspace's relations, reports the change with Undo or the refusal. */
type EditRelations = (item: RowItem, after: WorkspaceView['relations'], text: string) => void;
/** Moves a workspace's phase, reports the move with Undo or the refusal. */
type MovePhase = (item: RowItem, phase: WorkspaceView['phase']) => void;

/** The name being edited in place: Enter or leaving the field keeps it, Escape keeps the old one. */
function RenameInline({ name, onDone }: { name: string; onDone(name: string | null): void }) {
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.select(); }, []);
  return <input ref={input} autoFocus value={value} maxLength={160} aria-label="Workspace name" onChange={(event) => setValue(event.target.value)}
    onKeyDown={(event) => { if (event.key === 'Enter') onDone(value.trim() || null); if (event.key === 'Escape') onDone(null); }} onBlur={() => onDone(value.trim() || null)}
    className="h-6 min-w-0 flex-1 rounded-[6px] border border-[#6B97FF] bg-transparent px-1 text-body outline-none" />;
}

/** A choice's mark at the row's right edge while choosing: a ring to pick, filled once chosen. */
function Ring({ chosen }: { chosen: boolean }) {
  return <span aria-hidden className="absolute right-2 top-1/2 flex size-4 -translate-y-1/2 items-center justify-center rounded-full text-white transition-colors" style={{ border: `1.5px solid ${chosen ? ACCENT : 'color-mix(in oklab, var(--foreground) 28%, transparent)'}`, background: chosen ? ACCENT : 'transparent' }}>
    {chosen ? <Check width={11} height={11} strokeWidth={3} /> : null}
  </span>;
}

/**
 * A workspace row: the status dot and name (a stacked row's "↳ on X" after it, a stack's head tagged), then the phase
 * pips, pull request, how its branch stands against its parent, the planning labels and its agent's last message. A
 * focused workspace lights what it sits on or waits on (violet edge) and what sits on it or waits on it (teal edge);
 * unrelated rows recede. Its actions sit centred on the row's two lines. While `renaming`, the name is a field and the
 * row selects nothing; double-clicking the name starts it. While choosing (`target`), only its second line and right
 * edge change: the source says what the change would make of it, a refused row says why, a choice shows its ring.
 */
function WorkspaceRow({ item, kin, selected, inset, guides, caption, meta, override, flags, dimmed, title, target, actions, renaming, onStartRename, onHover, onClick, drag }: {
  item: RowItem; kin: Relation; selected: boolean; inset: number; guides: readonly number[]; caption: ReactNode; meta: ReactNode; override: ReactNode; flags: ReactNode; dimmed: boolean; title: string;
  target: Target | null; actions: ReactNode; renaming?: { onDone(name: string | null): void }; onStartRename?(): void; onHover(id: string | null): void; onClick(): void;
  drag?: { draggable: boolean; start(): void; drop(): void; end(): void };
}) {
  const { summary } = item;
  const tone = kin === 'upstream' ? UPSTREAM_TONE : kin === 'downstream' ? DOWNSTREAM_TONE : null;
  const released = summary?.holder.kind === 'released';
  const freshness = summary?.freshness ?? (summary?.status ? 'fresh' : 'unknown');
  const source = target?.role === 'source';
  const className = `${ROW} ${target ? 'pr-8' : 'pr-2 group-hover/menu-sub-item:pr-8'} ${target ? target.role === 'refused' ? 'opacity-45' : 'cursor-pointer hover:bg-hover' : `${selected ? 'bg-active' : 'hover:bg-hover'} ${kin === 'unrelated' || dimmed ? 'opacity-40' : ''}`}`;
  const style = { paddingLeft: inset, ...(source ? { background: `color-mix(in oklab, ${ACCENT} 12%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${ACCENT} 45%, transparent)` } : {}) };
  const body = <>
    {guides.map(x => <span key={x} aria-hidden className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: x }} />)}
    {tone ? <>
      <span aria-hidden className="pointer-events-none absolute inset-y-0 right-0 rounded-[10px]" style={{ left: Math.max(inset - 6, 0), background: `linear-gradient(90deg, color-mix(in oklab, ${tone} 16%, transparent), transparent 75%)` }} />
      <span aria-hidden className="pointer-events-none absolute inset-y-1 w-0.5 rounded-full" style={{ left: Math.max(inset - 6, 1), background: tone, boxShadow: `0 0 8px color-mix(in oklab, ${tone} 60%, transparent)` }} />
    </> : null}
    <span className="relative flex min-w-0 items-center gap-1.5">
      <span className="inline-flex size-4 shrink-0 items-center justify-center" data-freshness={freshness}>{summary?.closedAt ? <ArchiveGlyph size={14} strokeWidth={1.5} /> : summary ? <WorkspaceStatusDot space={summary} /> : <StatusDot color="dim" />}</span>
      {renaming ? <RenameInline name={item.name} onDone={renaming.onDone} />
        : <span onDoubleClick={onStartRename && !target ? (event) => { event.preventDefault(); onStartRename(); } : undefined} className={`min-w-0 truncate text-body ${released ? 'text-muted-foreground' : item.state === 'needs-you' || (selected && !target) || source ? 'font-medium text-foreground' : 'text-foreground/90'}`}>{item.name}</span>}
      {renaming ? null : caption}
      {flags}
    </span>
    {/* The second line is as tall as a pull request chip, its tallest part, whatever it holds: a preview never changes the
        row's height. It is clipped, so nothing on it runs under the row's actions. */}
    <span className="relative flex min-h-[18px] min-w-0 items-center gap-1.5 overflow-hidden pl-[22px] text-[11px] text-muted-foreground">
      {override ?? <>{meta}{summary?.preview && !summary.closedAt ? <span data-workspace-preview="" className="min-w-0 flex-1 truncate text-muted-foreground/90">{summary.preview}</span> : null}</>}
    </span>
    {target?.role === 'choice' ? <Ring chosen={target.chosen} /> : null}
  </>;
  return <SidebarMenuSubItem data-workspace={item.id} data-relation={kin}>
    {renaming ? <div className={className} style={style}>{body}</div>
      : <button type="button" aria-current={selected && !target ? 'page' : undefined} title={title} aria-description={summary?.detail ?? undefined} data-pick={target?.role}
        draggable={drag?.draggable} onDragStart={drag ? (event) => { event.dataTransfer.setData('text/plain', item.id); drag.start(); } : undefined}
        onDragOver={drag ? (event) => event.preventDefault() : undefined} onDrop={drag ? (event) => { event.preventDefault(); drag.drop(); } : undefined} onDragEnd={drag?.end}
        onMouseEnter={() => onHover(item.id)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(item.id)} onBlur={() => onHover(null)} onClick={onClick}
        className={className} style={style}>{body}</button>}
    {renaming || target ? null : <SidebarMenuActions showOnHover className="top-1/2 -translate-y-1/2">{actions}</SidebarMenuActions>}
  </SidebarMenuSubItem>;
}

/** The source as it would sit after the stack being previewed: faint, at its new level, saying what it would be on. */
function Ghost({ source, parent, carried, stacked }: { source: RowItem; parent: RowItem | undefined; carried: number; stacked: boolean }) {
  return <motion.li initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.14 }} className="relative list-none overflow-hidden" aria-hidden data-landing={source.id}>
    {(stacked ? STACK_GUIDES : FIRST_GUIDES).map(x => <span key={x} className="pointer-events-none absolute inset-y-0 w-px bg-border" style={{ left: x }} />)}
    <div className="relative my-0.5 flex min-h-[38px] items-center gap-1.5 rounded-[10px] border border-dashed pr-2" style={{ marginLeft: (stacked ? INSET.stacked : INSET.first) - 6, paddingLeft: 5, borderColor: `color-mix(in oklab, ${ACCENT} 60%, transparent)`, background: `color-mix(in oklab, ${ACCENT} 6%, transparent)` }}>
      <span className="inline-flex size-4 items-center justify-center opacity-60"><StatusDot color={STATE_COLOR[source.state]} /></span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-body" style={{ color: ACCENT }}>{source.name}</span>
        <span className="truncate text-[11px] text-muted-foreground">{parent ? `↳ on ${parent.name}` : 'top level'}{carried ? ` · +${carried} stacked on it` : ''}</span>
      </span>
    </div>
  </motion.li>;
}

/** Orange and green counts after a project's name: how many of its workspaces need you and how many run. Inline in the
 * row's button, which leaves room for the row's actions, so the actions never cover them. */
function StateCounts({ items }: { items: readonly RowItem[] }) {
  const needs = items.filter(item => item.state === 'needs-you').length;
  const running = items.filter(item => item.state === 'running').length;
  if (!needs && !running) return null;
  return <span className="ml-1.5 inline-flex shrink-0 items-center gap-1.5 text-[11px] font-normal tabular-nums" title={[needs ? `${needs} need you` : null, running ? `${running} last reported working` : null].filter(Boolean).join(' · ')}>
    {needs ? <span className="inline-flex items-center gap-1"><span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR.orange }} />{needs}</span> : null}
    {running ? <span className="inline-flex items-center gap-1 text-muted-foreground"><span className="size-1.5 rounded-full" style={{ background: STATUS_COLOR.green }} />{running}</span> : null}
  </span>;
}

interface ProjectRowsProps extends Pick<AppSidebarProps, 'selected' | 'deployment' | 'onSelectProject' | 'onSelectWorkspace' | 'onReleaseMachines' | 'releasePendingSpaceId' | 'onArchive' | 'onRestore' | 'onDelete' | 'onRename' | 'onNewWorkspace' | 'onOpenProjectSettings' | 'onOpenProjectAutomations'> {
  project: SidebarProject;
  /** Archived or being deleted: the row is dimmed and offers no new workspace. */
  archived: boolean;
  collapsed: boolean;
  onCollapse(projectId: string, collapsed: boolean): void;
  filter: SidebarFilter;
  groupBy: SidebarGroupBy;
  hovered: string | null;
  onHover(id: string | null): void;
  picker: Picker;
  edit: EditRelations | null;
  move: MovePhase | null;
}

function ProjectRows({ project, archived: projectArchived, collapsed, onCollapse, selected, deployment, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId, onArchive, onRestore, onDelete, onRename, onNewWorkspace, onOpenProjectSettings, onOpenProjectAutomations, filter, groupBy, hovered, onHover, picker, edit, move }: ProjectRowsProps) {
  const { base, workspaces, graph } = project;
  const [showArchived, setShowArchived] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const items = workspaces.filter((workspace) => !workspace.closedAt).map((workspace) => rowItem(workspace, graph));
  const archived = workspaces.filter((workspace) => !!workspace.closedAt).map((workspace) => rowItem(workspace, undefined));
  const baseSelected = selected?.workspaceId === null && selected.projectId === project.id;
  const selectedId = selected?.projectId === project.id ? selected.workspaceId : null;
  // A folded project still shows its selected workspace, without rewriting the stored preference.
  const open = !collapsed || (selected?.projectId === project.id && selected.workspaceId !== null);
  const baseSummary = project.baseSummary ?? base;
  const baseReleased = baseSummary && !baseSummary.closedAt && baseSummary.holder.kind === 'released';
  const createWorkspace = onNewWorkspace && !projectArchived ? () => onNewWorkspace(project.id) : undefined;
  const byId = new Map(items.map((item) => [item.id, item]));
  const mode = picker.mode?.projectId === project.id ? picker.mode : null;
  const source = mode ? byId.get(mode.id) : undefined;
  const stacking = mode?.kind === 'stack' ? mode : null;
  // A focus with nothing related lights nothing, rather than fading every other row; choosing lights nothing.
  const focus = picker.mode ? null : [hovered, selectedId].map((id) => lit(items, id)).find((light): light is Lit => light !== null && light.upstream.size + light.downstream.size > 0) ?? null;
  const target = (item: RowItem, archivedRow: boolean): Target | null => {
    if (!picker.mode) return null;
    if (!mode || !source) return { role: 'refused', why: 'in another project' };
    if (item.id === mode.id) return { role: 'source' };
    if (archivedRow) return { role: 'refused', why: 'archived' };
    const why = pickRefusal(items, mode.kind, source, item);
    return why ? { role: 'refused', why } : { role: 'choice', chosen: mode.draft.includes(item.id) };
  };
  const sourceLine = (): ReactNode => {
    if (!mode) return null;
    const into = byId.get(picker.hover ?? '');
    const named = mode.draft.map((id) => byId.get(id)?.name ?? id).join(', ');
    const text = mode.kind === 'stack' ? picker.hover === 'top' ? 'to the top level' : into ? `on ${into.name}` : 'choosing where it stacks…'
      : mode.kind === 'waits' ? `waits on ${named || 'nothing'}` : `related to ${named || 'nothing'}`;
    return <span className="truncate" style={{ color: ACCENT }}>{text}</span>;
  };
  const row = (item: RowItem, stacked: boolean, dimmed: boolean, archivedRow: boolean) => {
    const summary = item.summary;
    const choosing = target(item, archivedRow);
    const parentWorkspace = item.stackedOn ? workspaces.find((workspace) => workspace.id === item.stackedOn) : undefined;
    const position = parentWorkspace ? stackPosition(item.position, parentWorkspace) : null;
    const head = !archivedRow && !(item.stackedOn && byId.has(item.stackedOn)) && items.some((other) => other.stackedOn === item.id);
    const released = summary?.holder.kind === 'released' && !summary.closedAt;
    const startRename = onRename && !summary?.creation ? () => setRenaming(item.id) : undefined;
    const renamed = renaming === item.id && onRename ? { onDone: (name: string | null) => { setRenaming(null); if (name !== null && name !== item.name) void onRename(item.id, name); } } : undefined;
    const editable = !archivedRow && item.known;
    const restackOnto = item.stackedOn && item.position?.parentMerged === 'merged' ? item.position.baseBranch : null;
    const stack: StackAction[] = edit && editable ? [
      { key: 'stack', label: 'Stack on…', icon: StackGlyph, act: () => picker.start(item, 'stack') },
      ...(item.stackedOn ? [{ key: 'unstack', label: 'Remove from stack', icon: UnstackGlyph, act: () => edit(item, { ...relationsOf(item), stackedOn: null }, `${item.name} back at the top level`) }] : []),
      ...(restackOnto ? [{ key: 'restack', label: `Restack onto ${restackOnto}`, icon: ReopenGlyph, act: () => edit(item, { ...relationsOf(item), stackedOn: null }, `${item.name} is measured against ${restackOnto} now; its branch is untouched`) }] : []),
      { key: 'waits', label: 'Waits on…', icon: WaitsGlyph, act: () => picker.start(item, 'waits') },
      { key: 'related', label: 'Related to…', icon: RelatedGlyph, act: () => picker.start(item, 'related') },
    ] : [];
    const phase: PhaseSection | undefined = move && editable ? { current: item.phase, refusal: (next) => phaseRefusal(items, item, next), onSet: (next) => move(item, next) } : undefined;
    const waits = item.dependsOn.flatMap((id) => byId.get(id)?.name ?? []);
    const blocked = blocks(items, item.id).flatMap((id) => byId.get(id)?.name ?? []);
    const title = choosing?.role === 'refused' ? choosing.why : [
      `${item.branch} · ${summary ? summaryLabel(summary) : 'Status unknown'}${released ? ' · released' : ''}`,
      parentWorkspace ? `on ${parentWorkspace.name}${position?.short ? ` · ${position.short}` : ''}` : null,
    ].filter(Boolean).join(' · ');
    return <WorkspaceRow key={item.id} item={item} kin={relation(focus, item.id)} selected={selectedId === item.id} inset={stacked ? INSET.stacked : INSET.first} guides={archivedRow ? [] : stacked ? STACK_GUIDES : FIRST_GUIDES} dimmed={dimmed} title={title} target={choosing}
      onHover={(id) => { onHover(id); if (mode) picker.setHover(id && choosing?.role === 'choice' ? id : null); }}
      onClick={() => { if (!picker.mode) onSelectWorkspace(item.workspace); else if (mode) picker.pick(item.id); }}
      caption={<>{parentWorkspace ? <StackCaption parent={parentWorkspace.name} position={position} /> : null}{head ? <HeadTag /> : null}</>}
      meta={archivedRow ? <PhaseTag phase={item.phase} /> : <><PhaseTag phase={item.phase} /><PrChips pulls={graph?.pullRequests[item.id] ?? []} /><StackMarker position={position} ahead={item.aheadOfParent} /><LabelText waits={waits} blocks={blocked} /></>}
      override={choosing?.role === 'source' ? sourceLine() : choosing?.role === 'refused' ? <><Lock01 width={11} height={11} className="shrink-0" /><span className="truncate">{choosing.why}</span></> : null}
      renaming={renamed} onStartRename={startRename}
      drag={edit && editable ? { draggable: !picker.mode && renaming !== item.id, start: () => { picker.setDragging(item.id); picker.start(item, 'stack'); }, drop: () => { if (picker.dragging) picker.pick(item.id); picker.setDragging(null); }, end: () => { picker.setDragging(null); if (picker.dragging) picker.leave(); } } : undefined}
      flags={<>{item.workspace.definition?.remote?.behind ? <BehindOriginGlyph branch={item.branch} /> : null}{launchedFrom(deployment, item.id) ? <LaunchedGlyph /> : null}{released ? <span className="ml-1 shrink-0 text-caption text-muted-foreground/70">· released</span> : null}</>}
      actions={<SpaceMenu space={item.workspace} kind="workspace" summary={summary} deployment={deployment} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onDelete={onDelete} onRename={startRename} phase={phase} stack={stack} />} />;
  };
  const entries = listEntries(items, filter, groupBy);
  const spot = stacking && source && picker.hover ? landing(items, source, picker.hover, filter, groupBy) : null;
  const ghost = spot && source ? <Ghost key={`ghost-${picker.hover}`} source={source} parent={byId.get(picker.hover ?? '')} carried={stackBelow(items, source.id).length} stacked={spot.stacked} /> : null;
  return <SidebarMenuItem>
    <SpaceSummaryContext.Provider value={baseSummary}>
      <SidebarMenuButton className={projectArchived ? 'opacity-60' : baseReleased ? 'text-muted-foreground' : undefined} icon={AgentGlyph} isActive={baseSelected && !picker.mode} aria-description={project.error ?? undefined}
        title={stacking ? 'Move to the top level' : [baseSummary ? `${project.name} · project agent · ${summaryLabel(baseSummary)}${baseReleased ? ' · released' : ''}` : project.lifecycle === 'cloud-only' ? 'Saved in your account · no checkout' : `${project.name} · Status unknown`, project.error].filter(Boolean).join(' · ')}
        onClick={() => { if (!picker.mode) onSelectProject?.(project.id); else if (stacking) picker.pick('top'); }}
        onMouseEnter={() => { if (stacking) picker.setHover('top'); }} onMouseLeave={() => { if (stacking) picker.setHover(null); }}
        onDragOver={(event) => { if (stacking) event.preventDefault(); }} onDrop={(event) => { if (!stacking || !picker.dragging) return; event.preventDefault(); picker.pick('top'); picker.setDragging(null); }}>
        <span className="font-semibold">{project.name}</span>
        {stacking ? <span className="ml-1.5 text-[11px] font-normal" style={{ color: ACCENT }}>top level</span> : <StateCounts items={items} />}
        {project.operations?.length ? <ProjectOperationsGlyph operations={project.operations} /> : null}{project.remote?.behind ? <BehindOriginGlyph branch={base?.branch ?? null} /> : null}{baseReleased ? <span className="ml-1 truncate text-caption text-muted-foreground/70">· released</span> : null}
      </SidebarMenuButton>
    </SpaceSummaryContext.Provider>
    <SidebarMenuActions showOnHover={open}>
      <SidebarMenuAction aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`} aria-expanded={open} onClick={() => onCollapse(project.id, open)}><ChevronRight width={16} height={16} strokeWidth={1.5} className={open ? 'rotate-90 transition-[rotate] duration-80' : 'transition-[rotate] duration-80'} /></SidebarMenuAction>
      {createWorkspace ? <Tooltip content="New workspace" side="top"><SidebarMenuAction className={open ? undefined : FOLDED_ACTION_REVEAL} aria-label={`New workspace in ${project.name}`} onClick={createWorkspace}><Plus width={16} height={16} strokeWidth={1.5} /></SidebarMenuAction></Tooltip> : null}
      <SpaceMenu space={base ?? project} kind="project" summary={baseSummary} deployment={deployment} onReleaseMachines={onReleaseMachines} releasePendingSpaceId={releasePendingSpaceId} onArchive={onArchive} onRestore={onRestore} onInspect={onSelectProject ? () => onSelectProject(project.id) : undefined} onNewWorkspace={createWorkspace} onOpenProjectSettings={onOpenProjectSettings ? () => onOpenProjectSettings(project.id) : undefined} onOpenAutomations={onOpenProjectAutomations ? () => onOpenProjectAutomations(project.id) : undefined} triggerClassName={open ? undefined : FOLDED_ACTION_REVEAL} />
    </SidebarMenuActions>
    <SidebarMenuSub open={open} className="ml-0 gap-0 border-l-0 pl-1">
      {/* A hairline under the project row: it heads the workspaces below. */}
      <li aria-hidden className="mx-2 mb-1 mt-0.5 h-px list-none bg-foreground/15" />
      <AnimatePresence initial={false}>{spot?.after === null ? ghost : null}</AnimatePresence>
      {entries.map((entry) => <Fragment key={entry.key}>
        {entry.kind === 'heading' ? <li className="list-none"><GroupHeading tone={entry.tone} count={entry.count}>{entry.label}</GroupHeading></li> : row(entry.item, entry.stacked, entry.dimmed, false)}
        <AnimatePresence initial={false}>{spot?.after === entry.key ? ghost : null}</AnimatePresence>
      </Fragment>)}
      {items.length && !items.some((item) => matches(item, filter)) ? <li className="list-none px-2 py-1 text-[11px] text-muted-foreground">No workspaces match this filter</li> : null}
      {archived.length ? <SidebarMenuSubItem>
        <SidebarMenuSubButton render={<button type="button" onClick={() => setShowArchived((value) => !value)} aria-expanded={showArchived} />} icon={ArchiveGlyph}>Archived</SidebarMenuSubButton>
        <SidebarMenuBadge>{archived.length}</SidebarMenuBadge>
      </SidebarMenuSubItem> : null}
      {showArchived || archived.some((item) => item.id === selectedId) ? archived.map((item) => row(item, false, false, true)) : null}
    </SidebarMenuSub>
  </SidebarMenuItem>;
}

/**
 * The header's mode bar while choosing, over the page nav so nothing below moves: what is being chosen for which
 * workspace (its name scrolls its row into view), what the choice would do, Cancel (Esc) and, for waits-on and related,
 * Done (Enter).
 */
function PickerBar({ mode, source, items, hover, onReveal, onCancel, onDone }: { mode: Mode; source: RowItem; items: readonly RowItem[]; hover: string | null; onReveal(): void; onCancel(): void; onDone(): void }) {
  const name = <button type="button" onClick={onReveal} className="font-semibold underline decoration-white/40 underline-offset-2 hover:decoration-white">{source.name}</button>;
  const named = (ids: readonly string[]) => ids.map((id) => items.find((item) => item.id === id)?.name ?? id).join(', ');
  let title: ReactNode;
  let detail: string;
  if (mode.kind === 'stack') {
    title = <>Stack {name} on…</>;
    const into = items.find((item) => item.id === hover);
    const carried = stackBelow(items, mode.id).length;
    detail = hover === 'top' ? 'Moves to the top level' : into ? `On ${into.name}${carried ? ` · its ${carried} stacked come too` : ''}` : 'Pick a workspace, or the project for top level';
  } else {
    title = mode.kind === 'waits' ? <>{name} waits on…</> : <>{name} is related to…</>;
    const was = mode.kind === 'waits' ? source.dependsOn : source.relatedTo;
    const added = mode.draft.filter((id) => !was.includes(id));
    const removed = was.filter((id) => !mode.draft.includes(id));
    detail = added.length || removed.length ? [added.length ? `+ ${named(added)}` : '', removed.length ? `− ${named(removed)}` : ''].filter(Boolean).join('  ') : 'Pick to check or uncheck';
  }
  const enter = { opacity: 0, y: 8 };
  return <motion.div key="mode" role="group" aria-label="Choosing" initial={enter} exit={enter} transition={{ duration: 0.2, ease: 'easeOut' }}
    animate={{ opacity: 1, y: 0, boxShadow: [`0 0 0 0px color-mix(in oklab, ${ACCENT} 70%, transparent)`, `0 0 0 6px color-mix(in oklab, ${ACCENT} 0%, transparent)`] }}
    className="absolute inset-x-0 -inset-y-1.5 z-10 flex items-center gap-2 rounded-[12px] pl-3 pr-1.5 text-white" style={{ background: ACCENT }}>
    <span className="flex min-w-0 flex-1 flex-col leading-tight">
      <span className="truncate text-[12.5px]">{title}</span>
      <span className="truncate text-[11px] opacity-85">{detail}</span>
    </span>
    <button type="button" onClick={onCancel} title="Cancel (Esc)" className="h-7 shrink-0 rounded-[8px] px-2 text-caption font-medium hover:bg-white/15">Cancel</button>
    {mode.kind === 'stack' ? null : <button type="button" onClick={onDone} title="Done (Enter)" className="h-7 shrink-0 rounded-[8px] bg-white px-2.5 text-caption font-semibold" style={{ color: ACCENT }}>Done</button>}
  </motion.div>;
}

const COLLAPSED_PROJECTS_KEY = 'gitspace.sidebar.collapsedProjects';
/** Project lifecycles the sidebar folds into its Archived projects group. */
const ARCHIVED_PROJECT: Record<string, true> = { archived: true, deleting: true };

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

/** The account sidebar. Stack, relation and phase changes made from it report in the stack pill, with Undo. */
export function AppSidebar(props: AppSidebarProps) {
  return <StackToasts><SidebarBody {...props} /></StackToasts>;
}

function SidebarBody({ view, onView, selected, selectedSummary, projects, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId = null, onArchive, onRestore, onDelete, onRename, onNewWorkspace, onNewProject, onOpenSettings, onOpenProjectSettings, onOpenProjectAutomations, failedAutomationRuns = 0, user, deployment, onSetRelations, onSetPhase }: AppSidebarProps) {
  const userName = user?.name || 'Your account';
  const [collapsedProjects, setCollapsedProjects] = useState(readCollapsedProjects);
  const [filter, setFilter] = useState<SidebarFilter>('all');
  const [groupBy, setGroupBy] = useState(readGroupBy);
  const [hovered, setHovered] = useState<string | null>(null);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  // Archived projects start folded; the ones the user opened, not stored.
  const [openArchivedProjects, setOpenArchivedProjects] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode | null>(null);
  const [pickHover, setPickHover] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const toast = useStackToast();
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
  // The open pane's status shows on its row; the row keeps the directory's last-message preview.
  const shown = projects.map((project) => selectedSummary && selected?.projectId === project.id
    ? selected.workspaceId === null
      ? { ...project, baseSummary: selectedSummary }
      : { ...project, workspaces: project.workspaces.map((workspace) => workspace.id === selected.workspaceId ? { ...workspace, summary: { ...selectedSummary, preview: selectedSummary.preview ?? workspace.summary?.preview ?? null } } : workspace) }
    : project);
  const active = shown.filter((project) => !ARCHIVED_PROJECT[project.lifecycle ?? '']);
  const archivedProjects = shown.filter((project) => ARCHIVED_PROJECT[project.lifecycle ?? '']);
  const archivedOpen = showArchivedProjects || archivedProjects.some((project) => project.id === selected?.projectId);
  const collapseArchivedProject = (projectId: string, collapse: boolean): void => {
    const next = new Set(openArchivedProjects);
    if (collapse) next.delete(projectId);
    else next.add(projectId);
    setOpenArchivedProjects(next);
  };
  const all = active.flatMap((project) => project.workspaces.filter((workspace) => !workspace.closedAt).map((workspace) => rowItem(workspace, undefined)));
  const modeProject = mode ? shown.find((project) => project.id === mode.projectId) : undefined;
  const modeItems = modeProject ? modeProject.workspaces.filter((workspace) => !workspace.closedAt).map((workspace) => rowItem(workspace, modeProject.graph)) : [];
  const source = mode ? modeItems.find((item) => item.id === mode.id) : undefined;
  const leave = (): void => { setMode(null); setPickHover(null); };
  // The workspace being chosen for left the list (archived, deleted): nothing is left to choose for.
  useEffect(() => { if (mode && !source) leave(); });
  const edit: EditRelations | null = onSetRelations ? (item, after, text) => {
    const before = relationsOf(item);
    void onSetRelations(item.id, after, before).then(
      (applied) => toast.applied(text, async () => { await onSetRelations(item.id, before, applied); }),
      (failure: unknown) => toast.refused(failure, 'Change relations'),
    );
  } : null;
  const move: MovePhase | null = onSetPhase ? (item, phase) => {
    const previous = item.phase;
    void onSetPhase(item.workspace.projectId, item.id, phase, previous).then(
      // A phase that was never read has nothing to go back to: the move is reported without Undo.
      () => toast.applied(`${item.name} moved to ${PHASE_LABEL[phase]}`, previous === null ? null : () => onSetPhase(item.workspace.projectId, item.id, previous, phase)),
      (failure: unknown) => toast.refused(failure, 'Change phase'),
    );
  } : null;
  const done = (): void => {
    if (!mode || !source || mode.kind === 'stack') return;
    leave();
    const was = mode.kind === 'waits' ? source.dependsOn : source.relatedTo;
    if (was.length === mode.draft.length && was.every((id) => mode.draft.includes(id))) return;
    const named = mode.draft.map((id) => modeItems.find((item) => item.id === id)?.name ?? id).join(', ') || 'nothing';
    edit?.(source, mode.kind === 'waits' ? { ...relationsOf(source), dependsOn: mode.draft } : { ...relationsOf(source), relatedTo: mode.draft }, `${source.name} ${mode.kind === 'waits' ? 'waits on' : 'related to'} ${named}`);
  };
  const picker: Picker = {
    mode, hover: pickHover, setHover: setPickHover, dragging, setDragging, leave,
    start: (item, kind) => {
      toast.clear();
      setPickHover(null);
      setMode({ kind, projectId: item.workspace.projectId, id: item.id, draft: kind === 'stack' ? item.stackedOn ? [item.stackedOn] : [] : kind === 'waits' ? item.dependsOn : item.relatedTo });
    },
    pick: (id) => {
      if (!mode || !source) return;
      if (id === mode.id) { if (mode.kind === 'stack') leave(); else done(); return; }
      if (id === 'top') {
        if (mode.kind !== 'stack') return;
        leave();
        if (source.stackedOn !== null) edit?.(source, { ...relationsOf(source), stackedOn: null }, `${source.name} back at the top level`);
        return;
      }
      const chosen = modeItems.find((item) => item.id === id);
      if (!chosen || pickRefusal(modeItems, mode.kind, source, chosen)) return;
      if (mode.kind !== 'stack') { setMode({ ...mode, draft: mode.draft.includes(id) ? mode.draft.filter((other) => other !== id) : [...mode.draft, id] }); return; }
      leave();
      if (source.stackedOn !== chosen.id) edit?.(source, { ...relationsOf(source), stackedOn: chosen.id }, `${source.name} on ${chosen.name}`);
    },
  };
  useEffect(() => {
    if (!mode) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') leave();
      // Enter applies the draft; it does not also click the focused row.
      if (event.key === 'Enter') { event.preventDefault(); done(); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  const rowProps = { selected, deployment, onSelectProject, onSelectWorkspace, onReleaseMachines, releasePendingSpaceId, onArchive, onRestore, onDelete, onRename, onNewWorkspace, onOpenProjectSettings, onOpenProjectAutomations, filter, groupBy, hovered, onHover: setHovered, picker, edit, move };
  return <Sidebar ref={scroller} variant="inset">
    <SidebarHeader>
      <div className="relative">
        <nav aria-label="Navigate" aria-hidden={mode ? true : undefined} className={`flex items-center justify-between px-0.5 transition-opacity duration-200 ${mode ? 'pointer-events-none opacity-0' : ''}`}>
          {NAV.map((item) => <Tooltip key={item.view} content={item.view === 'automations' && failedAutomationRuns > 0 ? `${PRODUCT_ROUTE_LABELS[item.view]} · ${failedAutomationRuns} ${failedAutomationRuns === 1 ? 'run' : 'runs'} failed today` : PRODUCT_ROUTE_LABELS[item.view]} side="bottom">
            <button type="button" aria-label={PRODUCT_ROUTE_LABELS[item.view]} aria-current={view === item.view ? 'page' : undefined} onClick={() => onView(item.view)}
              className={`relative flex size-7 items-center justify-center rounded-lg hover:bg-hover hover:text-foreground ${view === item.view ? 'bg-active text-foreground' : 'text-muted-foreground'}`}>
              <item.icon size={16} strokeWidth={1.5} />
              {item.view === 'automations' && failedAutomationRuns > 0 ? <span className="absolute right-1 top-1 size-1.5 rounded-full" style={{ background: STATUS_COLOR.red }} /> : null}
            </button>
          </Tooltip>)}
        </nav>
        <AnimatePresence initial={false}>
          {mode && source ? <PickerBar mode={mode} source={source} items={modeItems} hover={pickHover} onCancel={leave} onDone={done}
            onReveal={() => scroller.current?.querySelector(`[data-workspace="${CSS.escape(mode.id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} /> : null}
        </AnimatePresence>
      </div>
    </SidebarHeader>

    <SidebarContent>
      {/* The filters rest while the list is a picker. */}
      <div className={`flex flex-col gap-1.5 pb-1 pt-1 transition-opacity duration-200 ${mode ? 'pointer-events-none opacity-35' : ''}`}>
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
          {/* Every grouping draws stacks whole. */}
          <span className="ml-auto truncate text-muted-foreground/80">stacks</span>
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
          {active.map((project) => <ProjectRows key={project.id} {...rowProps} project={project} archived={false} collapsed={collapsedProjects.has(project.id)} onCollapse={collapseProject} />)}
          {archivedProjects.length ? <SidebarMenuItem>
            <SidebarMenuButton icon={ArchiveGlyph} aria-expanded={archivedOpen} onClick={() => setShowArchivedProjects((value) => !value)}>Archived projects</SidebarMenuButton>
            <SidebarMenuBadge>{archivedProjects.length}</SidebarMenuBadge>
          </SidebarMenuItem> : null}
          {archivedOpen ? archivedProjects.map((project) => <ProjectRows key={project.id} {...rowProps} project={project} archived collapsed={!openArchivedProjects.has(project.id)} onCollapse={collapseArchivedProject} />) : null}
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
