/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { WorkspacePhase } from '../types/config.js';
import { STAGE_CAPS, STAGE_ORDER, stageColorVar } from '../app/shared/workspace-detail/stage-caps.js';
import type { KanbanGoalItem } from '../app/shared/board/types.js';
import { CHAIN_NODE_TONE_CLASS, CHAIN_NODE_DOT_BASE, CHAIN_NODE_DOT_EMPTY, WORKSPACE_CHIP_COLOR } from '../app/shared/status-display.js';
import type { WorkspaceStatusColor } from '../app/workspaces/workspace-status.js';

/**
 * Workspace sidebar chrome (mock: Sidebar.tsx header/modecaps/chainstack):
 *  - SidebarStageHeader: mono workspace name + stage-colored switcher dropdown
 *  - ModeCapsStrip: "{stage} mode" + capability chips
 *  - ChainStack: the goal chain rail with shipped/active/planned nodes
 */

export function SidebarStageHeader({ name, phase, onSwitchStage }: {
  name: string;
  phase: WorkspacePhase;
  onSwitchStage?: (phase: WorkspacePhase) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);
  const color = stageColorVar(phase);
  return (
    <div className="gs-ui flex h-[42px] flex-shrink-0 items-center gap-2 border-b border-[var(--gs-border)] px-[13px]">
      <span className="min-w-0 flex-1 truncate font-[family-name:var(--gs-font-mono)] text-[12.5px] text-[var(--gs-text)]">{name}</span>
      <div ref={rootRef} className="relative flex-shrink-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="bg-transparent px-[7px] py-[2px] text-[10.5px] uppercase tracking-[.05em]"
          style={{ color, border: `1px solid ${color}` }}
        >
          {phase} ▾
        </button>
        {open && (
          <div className="absolute right-0 top-full z-30 mt-1 min-w-[190px] border border-[var(--gs-border-active)] bg-[var(--gs-bg-overlay)] py-1">
            {STAGE_ORDER.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => { onSwitchStage?.(s); setOpen(false); }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-[var(--gs-bg-hover)]"
              >
                <span className="h-[7px] w-[7px] flex-shrink-0" style={{ background: stageColorVar(s) }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] capitalize text-[var(--gs-text)]">{s}</span>
                  <span className="block text-[10px] text-[var(--gs-text-dim)]">{STAGE_CAPS[s].note}</span>
                </span>
                {s === phase && <span className="flex-shrink-0 text-[10px] text-[var(--gs-text-dim)]">current</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Mock .modecap chip. */
function ModeCap({ label }: { label: string }): ReactElement {
  return <span className="whitespace-nowrap border border-[var(--gs-border)] px-1.5 py-px text-[10.5px] text-[var(--gs-text-muted)]">{label}</span>;
}

export function ModeCapsStrip({ phase }: { phase: WorkspacePhase }): ReactElement {
  const [firstCap, ...restCaps] = STAGE_CAPS[phase].unlocks;
  return (
    <div className="gs-ui flex flex-shrink-0 flex-wrap items-center gap-[5px] border-b border-[var(--gs-border)] bg-[#070707] px-[13px] py-[7px]">
      {/* Mock keeps the first mode chip inline on the "{stage} MODE" header row. */}
      <span className="flex items-center gap-[8px] whitespace-nowrap">
        <span className="text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-dim)]">{phase} mode</span>
        {firstCap && <ModeCap label={firstCap} />}
      </span>
      {restCaps.map((u) => <ModeCap key={u} label={u} />)}
    </div>
  );
}

export interface ChainStackNode {
  goalId: string;
  title: string;
  phase: WorkspacePhase;
  status: 'shipped' | 'active' | 'planned';
  workspaceSelectionKey?: string;
  ready?: { passed: number; total: number };
  /** The node's workspace status, when it HAS a workspace. The dot uses this so
   *  a chain node reports the same thing the strip and the chips do. */
  statusColor?: WorkspaceStatusColor;
}

/**
 * The workspace a chain node points at, resolved by the caller.
 *
 * Key and status come back together deliberately. They are two facts about the
 * same workspace, and resolving them separately is what broke this twice: the
 * dots looked up a goal key against a workspace-keyed map (always missed, always
 * grey), and navigation passed that same goal key to the workspace selector
 * (never matched, so the click deselected instead of navigating).
 */
export interface ChainNodeWorkspace {
  /** The WORKSPACE's selection key — backend-scoped, not `<backend>:goal:<id>`. */
  selectionKey: string;
  statusColor?: WorkspaceStatusColor;
}

/**
 * Chain nodes for the rail.
 *
 * `resolveWorkspace` maps a goal to its workspace. A node is navigable only when
 * that resolves: a goal naming a workspace this client cannot see (other backend,
 * filtered out) must not produce a key, because an unresolvable key reaching the
 * board selector clears the selection and ejects you from the workspace you were
 * looking at.
 *
 * A goal with no workspace has no status to report and stays 'planned'; without
 * this, every workspace-backed goal drew 'active' accent-green, so green meant
 * only "this goal has a workspace" while the same workspace showed its real
 * status two panels away.
 */
export function chainNodesFromGoals(
  goals: KanbanGoalItem[],
  currentWorkspaceName: string,
  resolveWorkspace?: (goal: KanbanGoalItem) => ChainNodeWorkspace | undefined,
): ChainStackNode[] {
  return [...goals]
    .sort((a, b) => a.chainPosition - b.chainPosition)
    .map((g) => {
      const isCurrent = g.workspaceName === currentWorkspaceName;
      const shipped = g.phase === 'ship' && !isCurrent && g.status === 'workspace-backed';
      const status: ChainStackNode['status'] = isCurrent ? 'active' : shipped ? 'shipped' : g.status === 'planned' ? 'planned' : 'active';
      const reqs = g.validation ? Object.values(g.validation.requirements ?? {}) : [];
      const passed = reqs.filter((r) => r.status === 'accepted').length;
      // One resolve per goal: the dot's status and the click target are the same
      // workspace, so they cannot drift apart.
      const ws = g.workspaceName ? resolveWorkspace?.(g) : undefined;
      return {
        goalId: g.id,
        title: g.title,
        phase: g.phase,
        status: isCurrent ? 'active' : status,
        // The current node is never a navigation target — you are already there.
        workspaceSelectionKey: isCurrent ? undefined : ws?.selectionKey,
        ready: reqs.length > 0 ? { passed, total: reqs.length } : undefined,
        statusColor: ws?.statusColor,
      };
    });
}

export function ChainStack({ title, nodes, currentGoalId, onSwitchWorkspace, onOpenGoal }: {
  title: string;
  nodes: ChainStackNode[];
  currentGoalId?: string;
  onSwitchWorkspace?: (selectionKey: string) => void;
  /** A chain node with no workspace yet (a planned goal) has nothing to switch
   *  to, and used to swallow the click silently. Open its goal instead. */
  onOpenGoal?: (goalId: string) => void;
}): ReactElement {
  // No per-status table here: a lit dot is ALWAYS the workspace's status colour
  // (see CHAIN_NODE_DOT_BASE). Everything else draws the hollow dot — a node
  // without a workspace has nothing to report, and the current node is already
  // marked by its `here` badge and its own emphasis.
  const PHASE_TONE = CHAIN_NODE_TONE_CLASS;
  return (
    <div className="mb-3">
      <div className="mb-1 px-[13px] pt-[11px] text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-muted)]">Chain · {title}</div>
      <div className="pb-1.5 pt-0.5">
        {nodes.map((nd, i) => {
          const isCurrent = nd.goalId === currentGoalId;
          const navigable = !!nd.workspaceSelectionKey && !isCurrent && !!onSwitchWorkspace;
          const openable = !navigable && !isCurrent && !!onOpenGoal;
          return (
            <div
              key={nd.goalId}
              title={navigable ? undefined : openable ? 'No workspace yet — open the goal' : undefined}
              onClick={() => {
                if (navigable) onSwitchWorkspace!(nd.workspaceSelectionKey!);
                else if (openable) onOpenGoal!(nd.goalId);
              }}
              className={`flex gap-[9px] px-[13px] py-[3px] ${navigable || openable ? 'cursor-pointer hover:bg-[var(--gs-bg-hover)]' : ''}`}
            >
              <span className="relative flex w-[10px] flex-shrink-0 justify-center">
                {/* Lit = that workspace's status, the same value the strip and
                    chips show. Hollow = no workspace, nothing to report. */}
                {nd.statusColor
                  ? <span className={`mt-[3px] h-[9px] w-[9px] ${CHAIN_NODE_DOT_BASE}`} style={{ borderColor: WORKSPACE_CHIP_COLOR[nd.statusColor], background: WORKSPACE_CHIP_COLOR[nd.statusColor] }} />
                  : <span className={`mt-[3px] h-[9px] w-[9px] ${CHAIN_NODE_DOT_BASE} ${CHAIN_NODE_DOT_EMPTY}`} />}
                {i < nodes.length - 1 && <span className="absolute bottom-[-7px] top-[14px] w-px bg-[var(--gs-border)]" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block text-[12px] leading-[1.3] ${isCurrent ? 'font-medium text-[var(--gs-text)]' : 'text-[var(--gs-text-muted)]'}`}>{nd.title}</span>
                <span className="flex items-center gap-[7px]">
                  <span className={`text-[10px] uppercase ${PHASE_TONE[isCurrent ? 'active' : nd.status]}`}>{nd.status === 'planned' ? 'planned' : nd.phase}</span>
                  {nd.ready && <span className="font-[family-name:var(--gs-font-mono)] text-[10.5px] tabular-nums text-[var(--gs-text-dim)]">{nd.ready.passed}/{nd.ready.total}</span>}
                  {isCurrent && <span className="border border-[rgba(0,255,102,.3)] px-1 text-[10.5px] uppercase text-[var(--gs-accent)]">here</span>}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
