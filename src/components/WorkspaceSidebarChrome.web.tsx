/** @jsxImportSource react */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { WorkspacePhase } from '../types/config.js';
import { STAGE_CAPS, STAGE_ORDER, stageColorVar } from '../app/shared/workspace-detail/stage-caps.js';
import type { KanbanGoalItem } from '../app/shared/board/types.js';

/**
 * Workspace sidebar chrome (mock: Sidebar.tsx header/modecaps/chainstack):
 *  - SidebarStageHeader: mono workspace name + stage-colored switcher dropdown
 *  - ModeCapsStrip: "{stage} mode" + capability chips
 *  - ChainStack: the goal chain rail with shipped/active/planned nodes
 */

export function SidebarStageHeader({ name, phase, onSwitchStage, onClose }: {
  name: string;
  phase: WorkspacePhase;
  onSwitchStage?: (phase: WorkspacePhase) => void;
  onClose?: () => void;
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
      {onClose && (
        <button type="button" onClick={onClose} title="Close workspace panel" className="flex-shrink-0 px-1 text-xs text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]">×</button>
      )}
    </div>
  );
}

export function ModeCapsStrip({ phase }: { phase: WorkspacePhase }): ReactElement {
  return (
    <div className="gs-ui flex flex-shrink-0 flex-wrap items-center gap-[5px] border-b border-[var(--gs-border)] bg-[#070707] px-[13px] py-[7px]">
      <span className="text-[10px] uppercase tracking-[.1em] text-[var(--gs-text-dim)]">{phase} mode</span>
      {STAGE_CAPS[phase].unlocks.map((u) => (
        <span key={u} className="border border-[var(--gs-border)] px-1.5 py-px text-[10.5px] text-[var(--gs-text-muted)]">{u}</span>
      ))}
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
}

export function chainNodesFromGoals(goals: KanbanGoalItem[], currentWorkspaceName: string): ChainStackNode[] {
  return [...goals]
    .sort((a, b) => a.chainPosition - b.chainPosition)
    .map((g) => {
      const isCurrent = g.workspaceName === currentWorkspaceName;
      const shipped = g.phase === 'ship' && !isCurrent && g.status === 'workspace-backed';
      const status: ChainStackNode['status'] = isCurrent ? 'active' : shipped ? 'shipped' : g.status === 'planned' ? 'planned' : 'active';
      const reqs = g.validation ? Object.values(g.validation.requirements ?? {}) : [];
      const passed = reqs.filter((r) => (r as { status?: string }).status === 'accepted').length;
      return {
        goalId: g.id,
        title: g.title,
        phase: g.phase,
        status: isCurrent ? 'active' : status,
        workspaceSelectionKey: g.workspaceName && !isCurrent ? g.selectionKey : undefined,
        ready: reqs.length > 0 ? { passed, total: reqs.length } : undefined,
      };
    });
}

export function ChainStack({ title, nodes, currentGoalId, onSwitchWorkspace }: {
  title: string;
  nodes: ChainStackNode[];
  currentGoalId?: string;
  onSwitchWorkspace?: (selectionKey: string) => void;
}): ReactElement {
  const DOT: Record<ChainStackNode['status'], string> = {
    shipped: 'border-[var(--gs-success)] bg-[var(--gs-success)]',
    active: 'border-[var(--gs-accent)] bg-[var(--gs-accent)] shadow-[0_0_8px_var(--gs-accent)]',
    planned: 'border-[var(--gs-border-active)] bg-[var(--gs-bg)]',
  };
  const PHASE_TONE: Record<ChainStackNode['status'], string> = {
    shipped: 'text-[var(--gs-success)]',
    active: 'text-[var(--gs-accent)]',
    planned: 'text-[var(--gs-text-dim)]',
  };
  return (
    <div className="mb-3">
      <div className="mb-1 px-[13px] pt-[11px] text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-muted)]">Chain · {title}</div>
      <div className="pb-1.5 pt-0.5">
        {nodes.map((nd, i) => {
          const isCurrent = nd.goalId === currentGoalId;
          const navigable = !!nd.workspaceSelectionKey && !isCurrent && !!onSwitchWorkspace;
          return (
            <div
              key={nd.goalId}
              onClick={() => { if (navigable) onSwitchWorkspace!(nd.workspaceSelectionKey!); }}
              className={`flex gap-[9px] px-[13px] py-[3px] ${navigable ? 'cursor-pointer hover:bg-[var(--gs-bg-hover)]' : ''}`}
            >
              <span className="relative flex w-[10px] flex-shrink-0 justify-center">
                <span className={`mt-[3px] h-[9px] w-[9px] flex-shrink-0 rounded-full border-2 ${DOT[isCurrent ? 'active' : nd.status]}`} />
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
