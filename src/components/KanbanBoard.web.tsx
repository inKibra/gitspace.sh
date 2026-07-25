/**
 * KanbanBoard Web - columns and workspace cards for browser.
 * Desktop: side-by-side columns with 1px gap gutters.
 * Mobile (<640px): tab bar at top, one phase visible at a time.
 */

import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { KanbanGoalItem, WorkspaceBoardGroup, KanbanWorkspaceItem } from '../app/shared/board/types.js';
import { PHASE_LABELS } from '../app/shared/board/types.js';
import { canShiftGoalInChainOrder } from '../app/shared/board/chain-order.js';
	import type { WorkspacePhase } from '../types/config.js';
import { getWorkspaceDisplayName } from './KanbanBoard.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';
import { btnGhost, btnPrimary, R_CHIP, R_MODAL } from './ui/control.js';

function PmChip({ label, tone = 'dim', className = '' }: { label: string; tone?: 'green' | 'blue' | 'amber' | 'red' | 'dim'; className?: string }) {
  const toneClass =
    tone === 'green' ? 'text-[var(--gs-chip-green-text)] bg-[var(--gs-chip-green-bg)]'
    : tone === 'blue' ? 'text-[var(--gs-chip-blue-text)] bg-[var(--gs-chip-blue-bg)]'
    : tone === 'amber' ? 'text-[var(--gs-chip-amber-text)] bg-[var(--gs-chip-amber-bg)]'
    : tone === 'red' ? 'text-[var(--gs-chip-red-text)] bg-[var(--gs-chip-red-bg)]'
    : 'text-[var(--gs-chip-dim-text)] bg-[var(--gs-chip-dim-bg)]';
  return <span className={`px-1.5 py-0.5 text-[9px] font-medium tracking-wide uppercase ${toneClass} ${className}`}>{label}</span>;
}

const CHAIN_PALETTE = [
  { fg: '#7dd3fc', bg: 'rgba(125,211,252,0.08)', border: 'rgba(125,211,252,0.34)' },
  { fg: '#a78bfa', bg: 'rgba(167,139,250,0.08)', border: 'rgba(167,139,250,0.34)' },
  { fg: '#34d399', bg: 'rgba(52,211,153,0.08)', border: 'rgba(52,211,153,0.34)' },
  { fg: '#fbbf24', bg: 'rgba(251,191,36,0.08)', border: 'rgba(251,191,36,0.34)' },
  { fg: '#fb7185', bg: 'rgba(251,113,133,0.08)', border: 'rgba(251,113,133,0.34)' },
  { fg: '#f472b6', bg: 'rgba(244,114,182,0.08)', border: 'rgba(244,114,182,0.34)' },
];

function getChainPalette(chainId: string) {
  let hash = 0;
  for (let index = 0; index < chainId.length; index += 1) {
    hash = ((hash << 5) - hash + chainId.charCodeAt(index)) | 0;
  }
  return CHAIN_PALETTE[Math.abs(hash) % CHAIN_PALETTE.length] ?? CHAIN_PALETTE[0];
}

function chainHoverClass(_related?: boolean): string {
  // Chain badge stays visible at rest (mock parity); related/dim treatment
  // is handled by card-level opacity instead of hiding the badge.
  return 'opacity-100';
}

/** Column header blurbs — mirrors agent-surfaces-app mock STAGE_BLURB. */
const PHASE_BLURBS: Record<string, string> = {
  plan: 'Author the spec — goal, rubric, review-gated workflow. Not editing the repo.',
  code: 'Run the implementation workflow and guide it.',
  review: 'Code review — commit staging and the narrative arc of the change.',
  ship: 'Post-merge ops — monitor, deploy, crons, roll-up.',
};

/** Status-colored card edge/dot — mirrors mock WS_STATUS_COLOR. */
function statusEdgeColor(primaryColor: string | undefined): string {
  switch (primaryColor) {
    case 'green': return 'var(--gs-accent)';
    case 'orange': return 'var(--gs-warning-bright)';
    case 'red': return 'var(--gs-danger-hover)';
    case 'blue': return 'var(--gs-info)';
    default: return 'var(--gs-text-ghost)';
  }
}

/** Accepted/total gates from goal validation requirements. Reads the slim
 *  snapshot projection (ticket #42): readiness totals first, requirement
 *  statuses as the fallback — neither needs the dropped evidence/reviews. */
export function getGateTally(validation?: {
  requirements?: Record<string, { status: string }>;
  readiness?: { totals?: { accepted: number; total: number } };
}): { passed: number; total: number } | null {
  if (!validation) return null;
  const totals = validation.readiness?.totals;
  if (totals && totals.total > 0) {
    return { passed: totals.accepted, total: totals.total };
  }
  const requirements = Object.values(validation.requirements ?? {});
  if (requirements.length === 0) return null;
  return {
    passed: requirements.filter((requirement) => requirement.status === 'accepted').length,
    total: requirements.length,
  };
}


function compareChainOrder(
  a: { goal?: Pick<KanbanGoalItem, 'chainId' | 'chainPosition' | 'title'>; name?: string },
  b: { goal?: Pick<KanbanGoalItem, 'chainId' | 'chainPosition' | 'title'>; name?: string },
): number {
  if (a.goal && b.goal && a.goal.chainId === b.goal.chainId) {
    return a.goal.chainPosition - b.goal.chainPosition;
  }
  return 0;
}

function displayGoalPhase(goal: Pick<KanbanGoalItem, 'phase' | 'status'>) {
  return goal.status === 'planned' ? 'plan' : goal.phase;
}

function sortGoalsForLane(goals: KanbanGoalItem[]): KanbanGoalItem[] {
  return [...goals].sort((a, b) => compareChainOrder({ goal: a }, { goal: b }));
}

function sortWorkspacesForLane(workspaces: KanbanWorkspaceItem[]): KanbanWorkspaceItem[] {
  return [...workspaces].sort((a, b) => compareChainOrder({ goal: a.goal, name: a.name }, { goal: b.goal, name: b.name }));
}

function getGoalStatusChip(goal: Pick<KanbanGoalItem, 'blockedReason' | 'stackStatus'> | undefined): { label: string; tone: 'green' | 'amber' | 'red' | 'dim' } | null {
  if (!goal?.blockedReason && !goal?.stackStatus) {
    return null;
  }
  if (goal?.stackStatus === 'aligned') {
    return { label: 'aligned', tone: 'green' };
  }
  if (goal?.stackStatus === 'needs-rebase') {
    return { label: 'needs rebase', tone: 'amber' };
  }
  if (goal?.stackStatus === 'dirty-worktree') {
    return { label: 'dirty worktree', tone: 'red' };
  }
  if (goal?.stackStatus === 'missing-branch') {
    return { label: 'missing branch', tone: 'amber' };
  }
  if (goal?.stackStatus === 'missing-workspace') {
    return { label: 'not created', tone: 'dim' };
  }
  return { label: 'blocked', tone: 'amber' };
}

type RectLike = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
type ConnectorPoint = { x: number; y: number };
type ChainConnector = { points: string; from: ConnectorPoint; to: ConnectorPoint };

interface ConnectorOptions {
  fromYRatio?: number;
  toYRatio?: number;
  laneOffset?: number;
}

function formatPoints(points: ConnectorPoint[]): string {
  const simplified = points.filter((point, index) => {
    const previous = points[index - 1];
    const next = points[index + 1];
    if (previous && samePoint(previous, point)) return false;
    if (!previous || !next) return true;
    const horizontal = Math.abs(previous.y - point.y) < 0.01 && Math.abs(point.y - next.y) < 0.01;
    const vertical = Math.abs(previous.x - point.x) < 0.01 && Math.abs(point.x - next.x) < 0.01;
    return !horizontal && !vertical;
  });
  return simplified.map((point) => `${point.x},${point.y}`).join(' ');
}

function parsePoints(points: string): ConnectorPoint[] {
  return points.split(' ').map((part) => {
    const [x, y] = part.split(',').map(Number);
    return { x: x ?? 0, y: y ?? 0 };
  });
}

function samePoint(a: ConnectorPoint, b: ConnectorPoint): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
}


function between(value: number, a: number, b: number): boolean {
  return value >= Math.min(a, b) - 0.01 && value <= Math.max(a, b) + 0.01;
}

function segmentIntersection(a1: ConnectorPoint, a2: ConnectorPoint, b1: ConnectorPoint, b2: ConnectorPoint): ConnectorPoint | null {
  const aVertical = Math.abs(a1.x - a2.x) < 0.01;
  const bVertical = Math.abs(b1.x - b2.x) < 0.01;

  if (aVertical === bVertical) {
    const sameLine = aVertical ? Math.abs(a1.x - b1.x) < 0.01 : Math.abs(a1.y - b1.y) < 0.01;
    if (!sameLine) return null;
    const aStart = aVertical ? a1.y : a1.x;
    const aEnd = aVertical ? a2.y : a2.x;
    const bStart = aVertical ? b1.y : b1.x;
    const bEnd = aVertical ? b2.y : b2.x;
    const overlapStart = Math.max(Math.min(aStart, aEnd), Math.min(bStart, bEnd));
    const overlapEnd = Math.min(Math.max(aStart, aEnd), Math.max(bStart, bEnd));
    if (overlapEnd - overlapStart <= 0.01) return null;
    return aVertical ? { x: a1.x, y: overlapStart } : { x: overlapStart, y: a1.y };
  }

  const verticalStart = aVertical ? a1 : b1;
  const verticalEnd = aVertical ? a2 : b2;
  const horizontalStart = aVertical ? b1 : a1;
  const horizontalEnd = aVertical ? b2 : a2;
  const point = { x: verticalStart.x, y: horizontalStart.y };
  return between(point.y, verticalStart.y, verticalEnd.y) && between(point.x, horizontalStart.x, horizontalEnd.x)
    ? point
    : null;
}

export function countConnectorCrossings(connectors: ChainConnector[]): number {
  let crossings = 0;
  const segments = connectors.flatMap((connector, connectorIndex) => {
    const points = parsePoints(connector.points);
    return points.slice(0, -1).map((point, index) => ({
      connectorIndex,
      a: point,
      b: points[index + 1]!,
    }));
  });

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const first = segments[i]!;
      const second = segments[j]!;
      if (first.connectorIndex === second.connectorIndex) continue;
      const intersection = segmentIntersection(first.a, first.b, second.a, second.b);
      if (!intersection) continue;
      const sharedEndpoint = [first.a, first.b].some((point) => samePoint(point, intersection))
        && [second.a, second.b].some((point) => samePoint(point, intersection));
      if (!sharedEndpoint) crossings += 1;
    }
  }

  return crossings;
}

export function buildChainConnector(fromRect: RectLike, toRect: RectLike, options: ConnectorOptions = {}): ChainConnector {
  const fromPortY = fromRect.top + fromRect.height * (options.fromYRatio ?? 0.32);
  const toPortY = toRect.top + toRect.height * (options.toYRatio ?? 0.68);
  const laneOffset = options.laneOffset ?? 18;
  const fromIsLeftOfTarget = fromRect.right <= toRect.left;
  const targetIsLeftOfFrom = toRect.right <= fromRect.left;
  const horizontalOverlap = Math.min(fromRect.right, toRect.right) - Math.max(fromRect.left, toRect.left);
  const sameLane = horizontalOverlap > Math.min(fromRect.width, toRect.width) * 0.55;

  if (sameLane) {
    const from = {
      x: fromRect.right,
      y: fromPortY,
    };
    const to = {
      x: toRect.right,
      y: toPortY,
    };
    return {
      from,
      to,
      points: formatPoints([from, to]),
    };
  }

  const from = {
    x: fromIsLeftOfTarget ? fromRect.right : targetIsLeftOfFrom ? fromRect.left : fromRect.right,
    y: fromPortY,
  };
  const topMiddlePort = { x: toRect.left + toRect.width / 2, y: toRect.top };
  const bottomMiddlePort = { x: toRect.left + toRect.width / 2, y: toRect.bottom };
  const nearestVerticalTargetPort = Math.abs(fromPortY - topMiddlePort.y) <= Math.abs(fromPortY - bottomMiddlePort.y)
    ? topMiddlePort
    : bottomMiddlePort;
  const to = fromIsLeftOfTarget
    ? nearestVerticalTargetPort
    : {
      x: targetIsLeftOfFrom ? toRect.right : toRect.right,
      y: toPortY,
    };

  const elbow = fromIsLeftOfTarget || targetIsLeftOfFrom
    ? { x: to.x, y: from.y }
    : { x: Math.max(fromRect.right, toRect.right) + laneOffset, y: from.y };
  const secondElbow = fromIsLeftOfTarget || targetIsLeftOfFrom
    ? null
    : { x: elbow.x, y: to.y };

  return {
    from,
    to,
    points: formatPoints(secondElbow ? [from, elbow, secondElbow, to] : [from, elbow, to]),
  };
}
export function buildVisibleChainConnectors(rects: RectLike[]): ChainConnector[] {
  const connectorPairs = rects.slice(0, -1).map((headRect, index) => ({
    fromRect: rects[index + 1]!,
    toRect: headRect,
  }));
  const laneOffsets = [18, 32, 48, 64, 84];
  let best: ChainConnector[] = [];
  let bestCrossings = Number.POSITIVE_INFINITY;

  for (const laneOffset of laneOffsets) {
    const connectors = connectorPairs.map(({ fromRect, toRect }) => (
      buildChainConnector(fromRect, toRect, { laneOffset })
    ));
    const crossings = countConnectorCrossings(connectors);
    if (crossings === 0) return connectors;
    if (crossings < bestCrossings) {
      best = connectors;
      bestCrossings = crossings;
    }
  }

  return best;
}

function ChainHandle({ goal, related }: { goal: KanbanGoalItem; related?: boolean }) {
  const palette = getChainPalette(goal.chainId);
  return (
    <span
      data-chain-anchor="true"
      title={`Goal chain position ${goal.chainPosition} of ${goal.chainLength}`}
      className={`ml-auto inline-flex h-5 flex-shrink-0 items-center gap-1 border px-1.5 text-[11px] leading-none transition-colors duration-150 ${chainHoverClass(related)}`}
      style={related
        ? { color: palette.fg, borderColor: palette.border, backgroundColor: palette.bg }
        : { color: 'var(--gs-text-dim)', borderColor: 'var(--gs-border)', backgroundColor: 'transparent' }}
    >
      ⛓
      <span className="text-[10px] font-semibold tabular-nums leading-none">
        {goal.chainPosition}/{goal.chainLength}
      </span>
    </span>
  );
}

function RearrangeHandle({ onOpenOrder }: { onOpenOrder?: () => void }) {
  return (
    <button
      type="button"
      title="Rearrange chain order"
      onClick={(event) => {
        event.stopPropagation();
        onOpenOrder?.();
      }}
      className={`inline-grid h-6 w-7 flex-shrink-0 translate-x-1 place-items-center ${R_CHIP} border border-[rgba(255,204,102,0.24)] bg-[rgba(255,204,102,0.06)] text-[12px] leading-none text-[var(--gs-chip-amber-text)] opacity-0 transition-[opacity,transform,scale] duration-150 ease-out group-hover:translate-x-0 group-hover:opacity-100 group-focus-within:translate-x-0 group-focus-within:opacity-100 active:scale-[0.9]`}
    >
      ⇅
    </button>
  );
}


function getPullRequestChip(entry: KanbanWorkspaceItem): { label: string; tone: 'green' | 'blue' | 'amber' | 'red' | 'dim' } | null {
  const pullRequest = entry.pullRequest;
  if (!pullRequest || pullRequest.syncState === 'not_found') {
    return null;
  }
  if (pullRequest.syncState === 'loading') {
    return { label: 'PR loading', tone: 'dim' };
  }
  if (pullRequest.syncState === 'cli_missing') {
    return { label: 'Install gh', tone: 'dim' };
  }
  if (pullRequest.syncState === 'unauthenticated') {
    return { label: 'gh login', tone: 'dim' };
  }
  if (pullRequest.syncState === 'unavailable') {
    return { label: 'PR unavailable', tone: 'dim' };
  }
  const prefix = pullRequest.number ? `PR #${pullRequest.number}` : 'PR';
  if (pullRequest.reviewDecision === 'changes_requested') {
    return { label: `${prefix} changes`, tone: 'red' };
  }
  if (pullRequest.reviewDecision === 'approved') {
    return { label: `${prefix} approved`, tone: 'green' };
  }
  if (pullRequest.state === 'merged') {
    return { label: `${prefix} merged`, tone: 'blue' };
  }
  return { label: `${prefix} review`, tone: 'amber' };
}

export interface KanbanBoardWebProps {
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceKey: string | null) => void;
  workspaceStatusById?: Record<string, WorkspaceStatusSummary>;
  deletingWorkspaceIds?: Record<string, { status: string; progressLabel?: string }>;
	  creatingWorkspaceIds?: Record<string, { status: string; progressLabel?: string; workspaceName: string; phase: WorkspacePhase }>;
  /** When true, lanes stretch vertically to fill the container. */
  fullHeight?: boolean;
  onCreatePlannedGoalWorkspace?: (goal: KanbanGoalItem) => void;
  onSelectPlannedGoal?: (goal: KanbanGoalItem) => void;
  onSaveChainOrder?: (goals: KanbanGoalItem[]) => void | Promise<void>;
  boardMessage?: string | null;
  /** Board lens: workspace kanban (default) or chain stack lanes. */
  view?: 'workspaces' | 'stacks';
}

	function PendingWorkspaceCard({
	  workspaceName,
	  progressLabel,
	}: {
	  workspaceName: string;
	  progressLabel?: string;
	}) {
	  return (
	    <div className="relative w-full px-3 py-2.5 border border-[var(--gs-border)] border-l-2 border-l-[var(--gs-info)] bg-[var(--gs-bg-surface)] opacity-70 cursor-not-allowed text-left">
	      <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden bg-[var(--gs-border)]">
	        <div
	          className="h-full w-1/2 bg-[var(--gs-info)]"
	          style={{ animation: 'gs-delete-card-progress 1.1s ease-in-out infinite' }}
	        />
	      </div>
	      <div className="flex items-center gap-2">
	        <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-ghost)]">●</span>
	        <span className="font-mono font-medium text-[12px] truncate text-[var(--gs-text-dim)]">{workspaceName}</span>
	        <span className="ml-auto text-[9px] uppercase tracking-wide text-[var(--gs-info)]">creating</span>
	      </div>
	      {progressLabel && (
	        <div className="mt-1 pl-[18px] text-[10px] text-[var(--gs-info)] truncate">
	          {progressLabel}
	        </div>
	      )}
	    </div>
	  );
	}



function PlannedGoalCard({ goal, onSelectGoal, onChainFocus, onOpenOrder, related, index = 0 }: { goal: KanbanGoalItem; onSelectGoal?: (goal: KanbanGoalItem) => void; onChainFocus?: (chainId: string | null) => void; onOpenOrder?: (chainId: string) => void; related?: boolean; index?: number }) {
  const handleClick = () => {
    onSelectGoal?.(goal);
  };
  // A planned goal is a spec with no workspace yet — style it as "under
  // construction" (dashed outline + faint diagonal caution stripes), NOT amber,
  // which reads as an agent asking a question.
  const blocked = Boolean(goal.blockedReason);
  // "Ready to proceed" = next-up in the chain: nothing blocks it AND its
  // predecessor has shipped. These get a striped-GREEN left accent (go). The
  // left edge no longer encodes blocked-ness in red — the status dot is about
  // agents, not chain readiness, so a not-yet-ready planned goal is just the
  // neutral muted placeholder.
  const canProceed = !blocked && goal.previousPhase === 'ship';
  const edgeColor = 'var(--gs-text-dim)';
  const CONSTRUCTION_STRIPES = 'repeating-linear-gradient(-45deg, rgba(255,204,102,0.07) 0 7px, transparent 7px 15px)';
  const READY_STRIPES = 'repeating-linear-gradient(-45deg, var(--gs-success) 0 3px, rgba(0,0,0,0) 3px 8px)';

  return (
    <div
      role="button"
      data-goal-card-key={goal.selectionKey}
      tabIndex={0}
      onClick={handleClick}
      onMouseEnter={() => onChainFocus?.(goal.chainId)}
      onFocus={() => onChainFocus?.(goal.chainId)}
      onMouseLeave={() => onChainFocus?.(null)}
      onBlur={() => onChainFocus?.(null)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleClick();
        }
      }}
      className={`gs-card-anim order-1 group relative w-full px-3 py-2.5 border border-dashed border-[var(--gs-border)] border-l-2 bg-[var(--gs-bg-surface)] text-left transition-[background-color,border-color,opacity] duration-150 hover:bg-[var(--gs-bg-hover)] hover:border-[var(--gs-border-active)] ${related === false ? 'opacity-40' : related === true ? 'ring-1' : ''}`}
      style={{
        borderLeftColor: related ? getChainPalette(goal.chainId).fg : canProceed ? 'transparent' : edgeColor,
        backgroundImage: CONSTRUCTION_STRIPES,
        animation: 'gs-card-in .3s cubic-bezier(0.2,0,0,1) both',
        animationDelay: `${index * 45}ms`,
        ...(related ? { ['--tw-ring-color' as string]: getChainPalette(goal.chainId).fg } : {}),
      }}
      title={goal.blockedReason ?? (canProceed ? `Ready — predecessor shipped. Create workspace in ${goal.chainTitle}` : `Create workspace for planned goal in ${goal.chainTitle}`)}
    >
      {canProceed && (
        <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-1.5" style={{ backgroundImage: READY_STRIPES }} title="ready — predecessor shipped" />
      )}
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 flex-shrink-0 rounded-full" style={{ background: 'var(--gs-text-ghost)' }} title="planned" />
        <span className="font-mono font-medium text-[12px] truncate">{goal.plannedWorkspaceName ?? goal.title}</span>
        <ChainHandle goal={goal} related={related} />
        <RearrangeHandle onOpenOrder={() => onOpenOrder?.(goal.chainId)} />
      </div>
      <div className="mt-1 text-[12px] text-[var(--gs-text-muted)] truncate">
        {goal.title}
      </div>
      {(() => {
        const chip = getGoalStatusChip(goal);
        return chip && chip.label !== 'not created' && chip.label !== 'blocked'
          ? <div className="flex flex-wrap items-center gap-1 mt-1.5"><PmChip label={chip.label} tone={chip.tone} /></div>
          : null;
      })()}
      {/* No machine footer: a planned goal is a spec, not a running workspace —
          it has no machine presence and no live status (the top dot already
          conveys planned/blocked). The old hardcoded green-dot + "local" was a
          mock leftover that looked like a different backend. */}
    </div>
  );
}

function WorkspaceCard({
  entry,
  isSelected,
  onSelect,
  status,
  deletionTask,
  onChainFocus,
  related,
  onOpenOrder,
  index = 0,
}: {
  entry: KanbanWorkspaceItem;
  isSelected: boolean;
  onSelect: () => void;
  status?: WorkspaceStatusSummary;
  deletionTask?: { status: string; progressLabel?: string };
  onChainFocus?: (chainId: string | null) => void;
  related?: boolean;
  onOpenOrder?: (chainId: string) => void;
  index?: number;
}) {
  const name = getWorkspaceDisplayName(entry);
  const prChip = getPullRequestChip(entry);
  const linear = entry.linear;
  // Enrich the base goal record into a KanbanGoalItem (adds the backend-scoped
  // fields ChainHandle/RearrangeHandle need) — same shape as allGoalItems.
  const goal: KanbanGoalItem | undefined = entry.goal ? {
    ...entry.goal,
    selectionKey: `${entry.backendKey}:goal:${entry.goal.id}`,
    backendKey: entry.backendKey,
    machineLabel: entry.machineLabel,
    isRemote: entry.isRemote,
  } : undefined;
  const isDeleting = deletionTask?.status === 'running' || deletionTask?.status === 'queued';
  const goalChip = getGoalStatusChip(goal);
  const gates = getGateTally(goal?.validation);
  const machineLabel = entry.isRemote && entry.machineLabel ? entry.machineLabel : 'local';

  // Edge/dot color: use the same primaryColor from WorkspaceStatusSummary
  // that the workspace detail strip bar uses
  const primaryColor = status?.primaryColor ?? 'dim';
  const edgeColor = statusEdgeColor(primaryColor);

  // Build readable info chips from status counts
  const agentTotal = status ? status.agents.green + status.agents.blue + status.agents.orange + status.agents.red : 0;
  const serviceNames = entry.processes?.map(p => p.name) ?? [];

  return (
    <div
      data-goal-card-key={goal?.id ? `${entry.backendKey}:goal:${goal.id}` : undefined}
      onClick={isDeleting ? undefined : onSelect}
      onMouseEnter={() => goal && onChainFocus?.(goal.chainId)}
      onFocus={() => goal && onChainFocus?.(goal.chainId)}
      onMouseLeave={() => goal && onChainFocus?.(null)}
      onBlur={() => goal && onChainFocus?.(null)}
      onKeyDown={(event) => {
        if (!isDeleting && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={isDeleting ? -1 : 0}
      aria-pressed={isSelected}
      aria-disabled={isDeleting}
      className={
        'gs-card-anim group relative w-full px-3 py-2.5 border border-[var(--gs-border)] border-l-2 transition-colors text-left ' +
        (related === false ? 'opacity-40 ' : related === true ? 'ring-1 ring-[var(--gs-info)] ' : '') +
        (isDeleting ? 'cursor-not-allowed opacity-55 grayscale ' : 'cursor-pointer ') +
        (isSelected
          ? 'border-[var(--gs-border-active)] bg-[var(--gs-bg-selected)]'
          : 'bg-[var(--gs-bg-surface)] hover:bg-[var(--gs-bg-hover)] hover:border-[var(--gs-border-active)]')
      }
      style={{
        borderLeftColor: edgeColor,
        animation: 'gs-card-in .3s cubic-bezier(0.2,0,0,1) both',
        animationDelay: `${index * 45}ms`,
      }}
    >
      {isDeleting && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] overflow-hidden bg-[var(--gs-border)]">
          <div
            className="h-full w-1/2 bg-[var(--gs-warning)]"
            style={{ animation: 'gs-delete-card-progress 1.1s ease-in-out infinite' }}
          />
        </div>
      )}
      {/* Name + dot — green (an agent doing active work, incl. compacting)
          pulses so it reads as live, not resting. */}
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 flex-shrink-0 rounded-full ${primaryColor === 'green' ? 'animate-pulse' : ''}`}
          style={{ background: edgeColor }}
        />
        <span className="font-mono font-medium text-[12px] truncate">{name}</span>
        {goal && <ChainHandle goal={goal} related={related} />}
        {goal && <RearrangeHandle onOpenOrder={() => onOpenOrder?.(goal.chainId)} />}
        {isDeleting && <span className="ml-auto text-[9px] uppercase tracking-wide text-[var(--gs-warning)]">deleting</span>}
      </div>

      {isDeleting && (
        <div className="mt-1 pl-[18px] text-[10px] text-[var(--gs-warning)] truncate">
          {deletionTask.progressLabel ?? 'Deleting workspace...'}
        </div>
      )}

      {/* Human summary: goal title, falling back to branch */}
      {(goal?.title || entry.branch) && (
        <div className="mt-1 text-[12px] text-[var(--gs-text-muted)] truncate">{goal?.title ?? entry.branch}</div>
      )}

      {/* Status row: agents, terminals, services — readable text */}
      {(agentTotal > 0 || (status && (status.terminals.green > 0 || status.terminals.red > 0)) || (status && (status.services.green > 0 || status.services.red > 0))) && (
        <div className="flex flex-wrap items-center gap-1.5 mt-1.5 pl-[18px]">
          {/* Agents */}
          {status && status.agents.orange > 0 && (
            <PmChip label={`${status.agents.orange} agent${status.agents.orange !== 1 ? 's' : ''} ⚡`} tone="amber" />
          )}
          {status && status.agents.red > 0 && (
            <PmChip label={`${status.agents.red} agent err`} tone="red" />
          )}
          {status && status.agents.green > 0 && (
            <PmChip label={`${status.agents.green} agent${status.agents.green !== 1 ? 's' : ''} busy`} tone="green" />
          )}
          {status && status.agents.blue > 0 && (
            <PmChip label={`${status.agents.blue} agent${status.agents.blue !== 1 ? 's' : ''} idle`} tone="blue" />
          )}

          {/* Terminals */}
          {status && status.terminals.green > 0 && (
            <PmChip label={`${status.terminals.green} term`} tone="dim" />
          )}
          {status && status.terminals.red > 0 && (
            <PmChip label={`${status.terminals.red} term err`} tone="red" />
          )}

          {/* Services — show names without implying per-service health */}
          {status && status.services.green > 0 && (
            <PmChip label={`${status.services.green} svc run`} tone="dim" />
          )}
          {serviceNames.length > 0 && (
            serviceNames.map(svc => (
              <PmChip key={svc} label={svc} tone="dim" />
            ))
          )}
          {status && status.services.red > 0 && (
            <PmChip label={`${status.services.red} svc err`} tone="red" />
          )}
        </div>
      )}

      {/* Goal / PR / Linear chips */}
      {((goalChip && goalChip.label !== 'blocked') || prChip || linear?.syncState === 'ready' || linear?.syncState === 'unconfigured') && (
        <div className="flex flex-wrap items-center gap-1 mt-1 pl-[18px]">
          {goalChip && goalChip.label !== 'blocked' && <PmChip label={goalChip.label} tone={goalChip.tone} />}
          {prChip && <PmChip label={prChip.label} tone={prChip.tone} />}
          {linear?.syncState === 'ready' && linear.identifier && (
            <PmChip
              label={linear.stateName ? `${linear.identifier} ${linear.stateName}` : linear.identifier}
              tone="blue"
            />
          )}
          {linear?.syncState === 'unconfigured' && (
            <PmChip label="Linear setup" tone="dim" />
          )}
        </div>
      )}

      {/* Footer: machine chip + gates tally */}
      <div className="mt-1.5 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 text-[10.5px] text-[var(--gs-text-dim)]">
          {machineLabel}
        </span>
        {gates && (
          <span
            className="ml-auto text-[11px] tabular-nums"
            style={{ color: gates.passed === gates.total ? 'var(--gs-success)' : 'var(--gs-warning)' }}
          >
            {gates.passed}/{gates.total} gates
          </span>
        )}
      </div>
    </div>
  );
}

const ALIGN_CHIP_TONE: Record<string, 'green' | 'amber' | 'red' | 'dim'> = {
  aligned: 'green',
  'needs-rebase': 'amber',
  'dirty-worktree': 'amber',
  'missing-branch': 'red',
  'missing-workspace': 'dim',
  unknown: 'dim',
};

const ALIGN_CONNECTOR_CLASS: Record<string, string> = {
  'needs-rebase': 'text-[var(--gs-warning)]',
  'dirty-worktree': 'text-[var(--gs-warning)]',
  'missing-branch': 'text-[var(--gs-danger)]',
};

/** Stacks lens: chains as horizontal lanes of goal nodes (mock Board.tsx Stacks). */
function StacksLanes({
  chains,
  workspaceByGoalId,
  selectedWorkspaceId,
  onSelectWorkspace,
  onSelectPlannedGoal,
  onCreatePlannedGoalWorkspace,
}: {
  chains: Array<{ chainId: string; title: string; count: number; goals: KanbanGoalItem[] }>;
  workspaceByGoalId: Map<string, KanbanWorkspaceItem>;
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceKey: string | null) => void;
  onSelectPlannedGoal?: (goal: KanbanGoalItem) => void;
  onCreatePlannedGoalWorkspace?: (goal: KanbanGoalItem) => void;
}) {
  const alignFor = (goal: KanbanGoalItem): string =>
    goal.stackStatus ?? (goal.status === 'planned' ? 'missing-workspace' : 'aligned');

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto px-4 py-3.5">
      {chains.length === 0 && (
        <div className="py-10 text-center text-xs italic text-[var(--gs-text-ghost)]">No goal chains yet</div>
      )}
      {chains.map((chain) => (
        <div key={chain.chainId}>
          <div className="mb-2 flex items-baseline gap-[9px]">
            <span className="text-[13px] font-medium text-[var(--gs-text)]">⛓ {chain.title}</span>
            <span className="text-[11px] text-[var(--gs-text-dim)]">
              {chain.goals[0]?.projectName ?? ''} · {chain.count} goal{chain.count !== 1 ? 's' : ''}
            </span>
          </div>
          <div className="flex items-stretch overflow-x-auto">
            {chain.goals.map((goal, index) => {
              const workspace = workspaceByGoalId.get(goal.id);
              const here = Boolean(workspace && workspace.selectionKey === selectedWorkspaceId);
              const status = goal.status === 'planned' ? 'planned' : goal.phase === 'ship' ? 'shipped' : 'active';
              const dotColor = status === 'shipped' ? 'var(--gs-success)' : status === 'active' ? 'var(--gs-accent)' : 'var(--gs-text-dim)';
              const align = alignFor(goal);
              const next = chain.goals[index + 1];
              return (
                <div key={goal.selectionKey} className="flex items-center">
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => workspace ? onSelectWorkspace(workspace.selectionKey) : onSelectPlannedGoal?.(goal)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (workspace) onSelectWorkspace(workspace.selectionKey);
                        else onSelectPlannedGoal?.(goal);
                      }
                    }}
                    className={`w-[230px] flex-none cursor-pointer border bg-[var(--gs-bg-surface)] px-[11px] py-[9px] text-left transition-colors hover:bg-[var(--gs-bg-hover)] ${here ? 'border-[var(--gs-accent)] shadow-[inset_0_0_0_1px_var(--gs-accent)]' : 'border-[var(--gs-border)]'}`}
                  >
                    <div className="flex items-center gap-[7px]">
                      <span className="h-2 w-2 flex-none rounded-full" style={{ background: dotColor }} />
                      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--gs-text)]">{goal.title}</span>
                      {here && (
                        <span className="border border-[var(--gs-accent)] px-1 text-[10.5px] uppercase tracking-[0.06em] text-[var(--gs-accent)] opacity-90">here</span>
                      )}
                    </div>
                    <div className="mt-1.5 flex items-center gap-[7px] text-[10px]">
                      <span className="uppercase tracking-[0.05em] text-[var(--gs-text-dim)]">{goal.status === 'planned' ? 'planned' : goal.phase}</span>
                      <PmChip label={align} tone={ALIGN_CHIP_TONE[align] ?? 'dim'} />
                    </div>
                    {!workspace && goal.status === 'planned' && onCreatePlannedGoalWorkspace && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCreatePlannedGoalWorkspace(goal);
                        }}
                        className={btnGhost('mt-2')}
                      >
                        ＋ Create workspace
                      </button>
                    )}
                  </div>
                  {next && (
                    <span
                      className={`flex w-[34px] flex-none items-center justify-center ${ALIGN_CONNECTOR_CLASS[alignFor(next)] ?? 'text-[var(--gs-text-dim)]'}`}
                      title={alignFor(next)}
                    >
                      →
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export function KanbanBoardWeb({
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
	  workspaceStatusById = {},
	  deletingWorkspaceIds = {},
	  creatingWorkspaceIds = {},
	  onSelectPlannedGoal,
	  onCreatePlannedGoalWorkspace,
	  onSaveChainOrder,
	  boardMessage = null,
	  fullHeight = false,
	  view = 'workspaces',
}: KanbanBoardWebProps) {
  const [mobilePhaseIndex, setMobilePhaseIndex] = useState(0);
  const safeIndex = Math.min(mobilePhaseIndex, groups.length - 1);
  const mobileGroup = groups[safeIndex];
  const [activeChainId, setActiveChainId] = useState<string | null>(null);
  const [chainDraft, setChainDraft] = useState<KanbanGoalItem[]>([]);
  const [selectedChainGoalKey, setSelectedChainGoalKey] = useState<string | null>(null);
  const [orderDirty, setOrderDirty] = useState(false);
  const [orderSaving, setOrderSaving] = useState(false);
  const [chainConnectors, setChainConnectors] = useState<Array<{ points: string; from: { x: number; y: number }; to: { x: number; y: number } }>>([]);
  const [orderEditorChainId, setOrderEditorChainId] = useState<string | null>(null);

	  const creatingForPhase = (phase: WorkspacePhase) =>
	    Object.values(creatingWorkspaceIds).filter((task) => task.phase === phase && task.status === 'creating');
	  const plannedGoalsForPhase = (phase: WorkspacePhase) =>
	    sortGoalsForLane(groups.find((group) => group.phase === phase)?.plannedGoals ?? []);
	  const allGoalItems = useMemo(() => groups.flatMap((group) => [
	    ...(group.plannedGoals ?? []),
	    ...group.workspaces.map((workspace) => workspace.goal ? {
	      ...workspace.goal,
	      selectionKey: `${workspace.backendKey}:goal:${workspace.goal.id}`,
	      backendKey: workspace.backendKey,
	      machineLabel: workspace.machineLabel,
	      isRemote: workspace.isRemote,
	    } : null).filter((goal): goal is KanbanGoalItem => Boolean(goal)),
	  ]), [groups]);
  const chainSummaries = useMemo(() => Array.from(
    allGoalItems.reduce((map, goal) => {
      const existing = map.get(goal.chainId);
      const goals = [...(existing?.goals ?? []), goal].sort((a, b) => a.chainPosition - b.chainPosition);
      map.set(goal.chainId, {
        title: goal.chainTitle,
        goals,
      });
      return map;
    }, new Map<string, { title: string; goals: KanbanGoalItem[] }>()),
    ([chainId, summary]) => ({
      chainId,
      title: summary.title,
      count: summary.goals.length,
      goals: summary.goals,
      palette: getChainPalette(chainId),
    }),
  ), [allGoalItems]);
  const workspaceByGoalId = useMemo(() => {
    const map = new Map<string, KanbanWorkspaceItem>();
    for (const group of groups) {
      for (const workspace of group.workspaces) {
        if (workspace.goal) map.set(workspace.goal.id, workspace);
      }
    }
    return map;
  }, [groups]);
  const activeChainGoals = useMemo(
    () => activeChainId ? allGoalItems.filter((goal) => goal.chainId === activeChainId).sort((a, b) => a.chainPosition - b.chainPosition) : [],
    [activeChainId, allGoalItems],
  );
  const activeChainPalette = activeChainId ? getChainPalette(activeChainId) : getChainPalette('');
  const orderEditorGoals = useMemo(
    () => orderEditorChainId ? allGoalItems.filter((goal) => goal.chainId === orderEditorChainId).sort((a, b) => a.chainPosition - b.chainPosition) : [],
    [orderEditorChainId, allGoalItems],
  );

  const activeRenderedGoals = orderDirty ? chainDraft : orderEditorGoals;

  useEffect(() => {
    setChainDraft(orderEditorGoals);
    setSelectedChainGoalKey(orderEditorGoals[0]?.selectionKey ?? null);
    setOrderDirty(false);
  }, [orderEditorChainId, orderEditorGoals]);

  useLayoutEffect(() => {
    if (!activeChainId || activeChainGoals.length < 2) {
      setChainConnectors([]);
      return;
    }

    const updateConnectors = () => {
      const cards = Array.from(document.getElementsByTagName('*')).filter((element) => element.hasAttribute('data-goal-card-key')) as Element[];
      const rects = activeChainGoals
        .map((goal) => cards.find((item) => {
          if (item.getAttribute('data-goal-card-key') !== goal.selectionKey) return false;
          const rect = item.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        })?.getBoundingClientRect() ?? null)
        .filter((rect): rect is DOMRect => Boolean(rect));

      setChainConnectors(buildVisibleChainConnectors(rects));
    };

    updateConnectors();
    window.addEventListener('resize', updateConnectors);
    window.addEventListener('scroll', updateConnectors, true);
    return () => {
      window.removeEventListener('resize', updateConnectors);
      window.removeEventListener('scroll', updateConnectors, true);
    };
  }, [activeChainId, activeChainGoals]);

  const shiftDraftGoal = (goalKey: string, direction: -1 | 1) => {
    setChainDraft((current) => {
      const index = current.findIndex((goal) => goal.selectionKey === goalKey);
      const targetIndex = index + direction;
      if (!canShiftGoalInChainOrder(current, index, direction)) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
    setOrderDirty(true);
    setSelectedChainGoalKey(goalKey);
  };

  const saveDraftOrder = async () => {
    if (!orderDirty || !onSaveChainOrder) return;
    setOrderSaving(true);
    try {
      await onSaveChainOrder(chainDraft);
      setOrderDirty(false);
    } finally {
      setOrderSaving(false);
    }
  };

  const resetDraftOrder = () => {
    setChainDraft(orderEditorGoals);
    setSelectedChainGoalKey(orderEditorGoals[0]?.selectionKey ?? null);
    setOrderDirty(false);
  };

  const openOrderEditor = (chainId: string) => {
    setActiveChainId(chainId);
    setOrderEditorChainId(chainId);
  };
  return (
    <>
      <style>{`@keyframes gs-delete-card-progress { 0% { transform: translateX(-105%); } 100% { transform: translateX(205%); } } @keyframes gs-chain-dot-flow { from { stroke-dashoffset: 0; } to { stroke-dashoffset: -24; } } @keyframes gs-card-in { from { opacity: 0; transform: translateY(8px); filter: blur(4px); } to { opacity: 1; transform: translateY(0); filter: blur(0); } } @media (prefers-reduced-motion: reduce) { .gs-card-anim { animation: none !important; } }`}</style>
      {view === 'stacks' && (
        <div className={`flex flex-col ${fullHeight ? 'h-full' : 'flex-1'}`}>
          <StacksLanes
            chains={chainSummaries}
            workspaceByGoalId={workspaceByGoalId}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={onSelectWorkspace}
            onSelectPlannedGoal={onSelectPlannedGoal}
            onCreatePlannedGoalWorkspace={onCreatePlannedGoalWorkspace}
          />
        </div>
      )}
      {view === 'workspaces' && (<>
      {/* ── Mobile: tab bar + single phase ── */}
      <div className={`flex flex-col sm:hidden ${fullHeight ? 'h-full' : 'flex-1'}`}>
        {/* Phase tab bar */}
        <div className="flex border-b border-[var(--gs-border)]">
          {groups.map((group, i) => {
	            const isActive = i === safeIndex;
	            const count = group.workspaces.length + creatingForPhase(group.phase).length + plannedGoalsForPhase(group.phase).length;
	            return (
              <button
                key={group.phase}
                type="button"
                onClick={() => setMobilePhaseIndex(i)}
                className={
                  'flex-1 py-2.5 text-[10px] tracking-[1.5px] uppercase text-center transition-colors ' +
                  (isActive
                    ? 'text-[var(--gs-text)] border-b-2 border-b-[var(--gs-selected-border)]'
                    : 'text-[var(--gs-text-dim)]')
                }
              >
                {PHASE_LABELS[group.phase]?.slice(0, 4) ?? group.phase}
                {count > 0 && <span className="ml-1 text-[var(--gs-text-ghost)]">{count}</span>}
              </button>
            );
          })}
        </div>

        {/* Cards for active phase */}
        <div className="flex-1 overflow-y-auto">
	          {mobileGroup && (mobileGroup.workspaces.length > 0 || creatingForPhase(mobileGroup.phase).length > 0 || plannedGoalsForPhase(mobileGroup.phase).length > 0) ? (
	            <div className="flex flex-col gap-2 p-2.5">
	              {creatingForPhase(mobileGroup.phase).map((task) => (
	                <PendingWorkspaceCard
	                  key={`creating-${task.workspaceName}`}
	                  workspaceName={task.workspaceName}
	                  progressLabel={task.progressLabel}
	                />
	              ))}
	              {plannedGoalsForPhase(mobileGroup.phase).map((goal, index) => (
	                <PlannedGoalCard key={goal.selectionKey} goal={goal} index={index} onSelectGoal={onSelectPlannedGoal} onChainFocus={setActiveChainId} onOpenOrder={openOrderEditor} related={activeChainId ? goal.chainId === activeChainId : undefined} />
	              ))}
	              {sortWorkspacesForLane(mobileGroup.workspaces).map((w, index) => (
	                <WorkspaceCard
	                  key={w.selectionKey}
	                  entry={w}
	                  index={plannedGoalsForPhase(mobileGroup.phase).length + index}
	                  isSelected={w.selectionKey === selectedWorkspaceId}
	                  onSelect={() => onSelectWorkspace(w.selectionKey === selectedWorkspaceId ? null : w.selectionKey)}
	                  status={workspaceStatusById[w.selectionKey]}
                  deletionTask={deletingWorkspaceIds[w.selectionKey]}
                  onChainFocus={setActiveChainId}
                  onOpenOrder={openOrderEditor}
                  related={activeChainId && w.goal ? w.goal.chainId === activeChainId : undefined}
	                />
	              ))}
	            </div>
	          ) : (
	            <div className="flex items-center justify-center py-12 text-[var(--gs-text-ghost)] text-xs">
	              No workspaces in {PHASE_LABELS[mobileGroup?.phase] ?? 'this phase'}
	            </div>
	          )}
        </div>
      </div>

      {/* ── Desktop: side-by-side columns ── */}
      {/* The Goal Chains bar is ALWAYS shown (not gated on hover): it used to
          mount only when activeChainId was set, and mounting this in-flow strip
          pushed the columns down — moving the hovered card out from under the
          cursor, which cleared activeChainId, which unmounted the bar, which
          sprang the columns back… a hover-thrash loop. Persistent bar = no
          layout shift on hover; hovering a card/chip just HIGHLIGHTS its chain
          (scale/brightness are transforms/filters, never a reflow). */}
      {chainSummaries.length > 0 && (
        <div className="hidden sm:flex items-center gap-2 border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-3 py-2 text-xs text-[var(--gs-text-muted)]" onMouseLeave={() => setActiveChainId(null)} onBlur={() => setActiveChainId(null)}>
          <span className="font-semibold uppercase tracking-[0.14em] text-[var(--gs-text-dim)]">Goal Chains</span>
          {chainSummaries.map((chain) => {
            const isActive = chain.chainId === activeChainId;
            return (
              <button
                key={chain.chainId}
                type="button"
                onMouseEnter={() => setActiveChainId(chain.chainId)}
                onFocus={() => setActiveChainId(chain.chainId)}
                onClick={() => openOrderEditor(chain.chainId)}
                className={`${R_CHIP} border px-2 py-1 transition-[filter,transform,opacity] duration-150 ease-out hover:brightness-125 focus:brightness-125 active:scale-[0.96] ${
                  activeChainId ? (isActive ? 'scale-[1.04] brightness-125' : 'opacity-45') : ''
                }`}
                style={{ color: chain.palette.fg, borderColor: chain.palette.border, backgroundColor: chain.palette.bg }}
                title={`Click to rearrange this chain. Order: ${chain.goals.map((goal) => `${goal.chainPosition}. ${goal.workspaceName ?? goal.plannedWorkspaceName ?? goal.title}`).join(' → ')}`}
              >
                ⛓ {chain.title} · 1-{chain.count}
              </button>
            );
          })}
        </div>
      )}
      <div className={`hidden sm:flex flex-1 gap-4 overflow-x-auto ${fullHeight ? 'h-full' : ''}`}>
        {groups.map((group) => {
          const plannedGoals = plannedGoalsForPhase(group.phase);
          const creating = creatingForPhase(group.phase);
          const count = group.workspaces.length + creating.length + plannedGoals.length;
          const label = PHASE_LABELS[group.phase] ?? group.phase;
          return (
          <div
            key={group.phase}
            className={`flex min-w-[180px] flex-1 flex-col border-r border-[var(--gs-border-muted)] bg-[var(--gs-bg)] pr-3 last:border-r-0 last:pr-0 ${fullHeight ? 'h-full min-h-0' : ''}`}
          >
	            <div className="border-b border-[var(--gs-border)] px-3 py-2.5">
	              <div className="flex items-baseline justify-between">
	                <span className="text-[13px] font-semibold text-[var(--gs-text)]">{label}</span>
	                <span className="text-[11px] tabular-nums text-[var(--gs-text-dim)]">{count}</span>
	              </div>
	              {PHASE_BLURBS[group.phase] && (
	                <div className="mt-1 text-[11px] text-[var(--gs-text-muted)]">{PHASE_BLURBS[group.phase]}</div>
	              )}
	            </div>
	            <div className={`flex flex-col gap-2 p-2.5 ${fullHeight ? 'flex-1 overflow-y-auto' : ''}`}>
	              {count === 0 && (
	                <div className="px-2 py-4 text-center text-[11.5px] italic text-[var(--gs-text-dim)]">
	                  No workspaces in {String(label).toLowerCase()}
	                </div>
	              )}
	              {creating.map((task) => (
	                <PendingWorkspaceCard
	                  key={`creating-${task.workspaceName}`}
	                  workspaceName={task.workspaceName}
	                  progressLabel={task.progressLabel}
	                />
	              ))}
	              {plannedGoals.map((goal, index) => (
	                <PlannedGoalCard key={goal.selectionKey} goal={goal} index={creating.length + index} onSelectGoal={onSelectPlannedGoal} onChainFocus={setActiveChainId} onOpenOrder={openOrderEditor} related={activeChainId ? goal.chainId === activeChainId : undefined} />
	              ))}
	              {sortWorkspacesForLane(group.workspaces).map((w, index) => (
	                <WorkspaceCard
	                  key={w.selectionKey}
	                  entry={w}
	                  index={creating.length + plannedGoals.length + index}
	                  isSelected={w.selectionKey === selectedWorkspaceId}
	                  onSelect={() => onSelectWorkspace(w.selectionKey === selectedWorkspaceId ? null : w.selectionKey)}
	                  status={workspaceStatusById[w.selectionKey]}
                  deletionTask={deletingWorkspaceIds[w.selectionKey]}
                  onChainFocus={setActiveChainId}
                  onOpenOrder={openOrderEditor}
                  related={activeChainId && w.goal ? w.goal.chainId === activeChainId : undefined}
	                />
	              ))}
	            </div>
          </div>
          );
        })}
      </div>
      </>)}
      {chainConnectors.length > 0 && (
        <svg className="fixed inset-0 z-20 h-screen w-screen pointer-events-none opacity-90" aria-hidden="true">
          {chainConnectors.map((connector, index) => {
            const points = connector.points;
            return (
              <g key={`${connector.from.x}:${connector.from.y}:${connector.to.x}:${connector.to.y}:${index}`}>
                <polyline points={points} fill="none" stroke="var(--gs-bg)" strokeOpacity="0.88" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points={points} fill="none" stroke={activeChainPalette.fg} strokeOpacity={index === 0 ? 0.48 : 0.34} strokeWidth="1.5" strokeDasharray="6 6" strokeLinecap="round" strokeLinejoin="round" />
                <polyline points={points} fill="none" stroke={activeChainPalette.fg} strokeOpacity={index === 0 ? 0.92 : 0.72} strokeWidth="3.5" strokeDasharray="1 11" strokeLinecap="round" strokeLinejoin="round" style={{ animation: 'gs-chain-dot-flow 850ms linear infinite' }} />
                <circle cx={connector.from.x} cy={connector.from.y} r="4" fill={activeChainPalette.fg} opacity="0.78" />
                <circle cx={connector.to.x} cy={connector.to.y} r="5" fill="var(--gs-bg)" stroke={activeChainPalette.fg} strokeWidth="1.75" opacity="0.9" />
              </g>
            );
          })}
        </svg>
      )}
      {orderEditorGoals.length > 0 && (
        <div className={`fixed right-4 top-16 z-30 w-[360px] ${R_MODAL} border border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] shadow-2xl`}>
          <div className="flex items-start justify-between border-b border-[var(--gs-border)] p-3">
            <div>
              <div className="text-sm font-semibold text-[var(--gs-text)]">Edit chain order</div>
              <div className="mt-1 text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">
                {orderDirty ? 'Unsaved order changes · git stack unchanged until save' : 'Keyboard/buttons MVP · git stack unchanged'}
              </div>
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={resetDraftOrder} disabled={!orderDirty} className={btnGhost()}>Cancel</button>
              <button type="button" onClick={() => setOrderEditorChainId(null)} className={btnGhost()}>Close</button>
            </div>
          </div>
          <div className="divide-y divide-[var(--gs-border)]">
            {activeRenderedGoals.map((goal, index) => (
              <div key={goal.selectionKey} className={`grid grid-cols-[38px_1fr_auto] items-center gap-2 p-2 text-xs ${selectedChainGoalKey === goal.selectionKey ? 'bg-[var(--gs-bg-selected)]' : ''}`}>
                <span className="text-[10px] font-semibold text-[var(--gs-text-muted)]">{index + 1}/{activeRenderedGoals.length}</span>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedChainGoalKey(goal.selectionKey);
                    onSelectPlannedGoal?.(goal);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowUp') {
                      event.preventDefault();
                      if (canShiftGoalInChainOrder(activeRenderedGoals, index, -1)) shiftDraftGoal(goal.selectionKey, -1);
                    } else if (event.key === 'ArrowDown') {
                      event.preventDefault();
                      if (canShiftGoalInChainOrder(activeRenderedGoals, index, 1)) shiftDraftGoal(goal.selectionKey, 1);
                    }
                  }}
                  className="min-w-0 rounded-[var(--gs-btn-radius)] px-1 py-0.5 text-left transition-[background-color] duration-150 hover:bg-[var(--gs-bg-hover)]"
                >
                  <div className="truncate font-mono text-[var(--gs-text)]">{goal.workspaceName ?? goal.plannedWorkspaceName ?? goal.title}</div>
                  <div className="truncate text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">{displayGoalPhase(goal)} · {goal.status}</div>
                </button>
                <div className="flex gap-1">
                  <button type="button" disabled={!canShiftGoalInChainOrder(activeRenderedGoals, index, -1)} onClick={() => shiftDraftGoal(goal.selectionKey, -1)} className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--gs-btn-radius)] text-[var(--gs-text-muted)] transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--gs-bg-active)] active:scale-[0.96] disabled:opacity-30">↑</button>
                  <button type="button" disabled={!canShiftGoalInChainOrder(activeRenderedGoals, index, 1)} onClick={() => shiftDraftGoal(goal.selectionKey, 1)} className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--gs-btn-radius)] text-[var(--gs-text-muted)] transition-[background-color,scale] duration-150 ease-out hover:bg-[var(--gs-bg-active)] active:scale-[0.96] disabled:opacity-30">↓</button>
                </div>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between border-t border-[var(--gs-border)] p-3">
            <div className="text-[10px] uppercase tracking-wide text-[var(--gs-text-dim)]">Save updates planning order only.</div>
            <button type="button" disabled={!orderDirty || orderSaving || !onSaveChainOrder} onClick={() => void saveDraftOrder()} className={btnPrimary()}>
              {orderSaving ? 'Saving…' : 'Save order'}
            </button>
          </div>
        </div>
      )}

      {boardMessage && (
        <div className="fixed bottom-4 right-4 z-20 max-w-[420px] border border-[var(--gs-chip-amber-text)] bg-[var(--gs-chip-amber-bg)] px-3 py-2 text-xs text-[var(--gs-chip-amber-text)] shadow-xl">
          {boardMessage}
        </div>
      )}
    </>
  );
}
