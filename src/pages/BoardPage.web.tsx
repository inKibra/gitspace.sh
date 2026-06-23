/** @jsxImportSource react */
/**
 * BoardPage — full-screen kanban board view.
 *
 * Matches the TUI `state.view === 'projects'` layout:
 * header bar + full-height kanban board with all phases visible.
 */

import { useEffect, useState } from 'react';
import { useTheme, THEMES } from '../lib/theme.web.js';
import { KanbanBoardWeb } from '../components/KanbanBoard.web.js';
import type { KanbanGoalItem, WorkspaceBoardGroup } from '../app/shared/board/types.js';
import { getShiftArrowPhaseChange } from '../app/shared/board/phase-movement.js';
import type { WorkspacePhase } from '../types/config.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';

export interface BoardPageProps {
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceKey: string | null) => void;
  onPhaseChange?: (workspaceKey: string, phase: WorkspacePhase) => void;
  worktreeCount: number;
  inboxUnreadCount: number;
  onOpenInbox: () => void;
  onOpenHelp: () => void;
  onOpenCreateMenu: () => void;
  onOpenCommandPalette?: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  workspaceStatusById?: Record<string, WorkspaceStatusSummary>;
	  deletingWorkspaceIds?: Record<string, { status: string; progressLabel?: string }>;
	  creatingWorkspaceIds?: Record<string, { status: string; progressLabel?: string; workspaceName: string; phase: WorkspacePhase }>;
  onCreatePlannedGoalWorkspace?: (goal: KanbanGoalItem) => void;
  onSelectPlannedGoal?: (goal: KanbanGoalItem) => void;
  onSaveChainOrder?: (goals: KanbanGoalItem[]) => void | Promise<void>;
  boardMessage?: string | null;
  /** True when backend is connected but workspaces haven't arrived yet. */
  loading?: boolean;
  loadingLabel?: string;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

/** Compact theme switcher — dropdown on hover. Shows icon-only on mobile. */
function ThemePicker() {
  const { theme, setTheme } = useTheme();
  const current = THEMES.find(t => t.id === theme);
  return (
    <div className="relative group">
      <button
        type="button"
        className="px-2 py-1 text-xs rounded text-[var(--gs-text-dim)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
        title={`Theme: ${current?.label ?? theme}`}
      >
        ◐<span className="hidden sm:inline"> {current?.label ?? theme}</span>
      </button>
      <div className="hidden group-hover:block absolute right-0 top-full mt-1 py-1 min-w-[160px] bg-[var(--gs-bg-elevated)] border border-[var(--gs-border)] z-50">
        {THEMES.map(t => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTheme(t.id)}
            className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--gs-bg-active)] ${t.id === theme ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-muted)]'}`}
          >
            {t.label}
            {t.group === 'light' ? ' ☀' : ''}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Mobile-only overflow menu for secondary header actions. */
function OverflowMenu({ onOpenInbox, inboxUnreadCount, onOpenHelp, onOpenCommandPalette, onRefresh, onDisconnect }: {
  onOpenInbox: () => void;
  inboxUnreadCount: number;
  onOpenHelp: () => void;
  onOpenCommandPalette?: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  const [open, setOpen] = useState(false);
  const act = (fn: () => void) => { fn(); setOpen(false); };
  return (
    <div className="relative sm:hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="px-2 py-1 text-xs rounded text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
      >
        ⋮
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 py-1 min-w-[180px] bg-[var(--gs-bg-elevated)] border border-[var(--gs-border)] z-50">
            <button type="button" onClick={() => act(onOpenInbox)} className="w-full text-left px-3 py-2 text-xs text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]">
              Inbox{inboxUnreadCount > 0 ? ` (${inboxUnreadCount})` : ''}
            </button>
            <button type="button" onClick={() => act(onOpenHelp)} className="w-full text-left px-3 py-2 text-xs text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]">
              Help
            </button>
            {onOpenCommandPalette && (
              <button type="button" onClick={() => act(onOpenCommandPalette)} className="w-full text-left px-3 py-2 text-xs text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]">
                Command Palette
              </button>
            )}
            <button type="button" onClick={() => act(onRefresh)} className="w-full text-left px-3 py-2 text-xs text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]">
              Refresh
            </button>
            <div className="my-1 border-t border-[var(--gs-border-muted)]" />
            <button type="button" onClick={() => act(onDisconnect)} className="w-full text-left px-3 py-2 text-xs text-[var(--gs-danger)] hover:bg-[var(--gs-chip-red-bg)]">
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function BoardPage({
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
  onPhaseChange,
  worktreeCount,
  inboxUnreadCount,
  onOpenInbox,
  onOpenHelp,
  onOpenCreateMenu,
  onOpenCommandPalette,
  onRefresh,
  onDisconnect,
	  workspaceStatusById = {},
	  deletingWorkspaceIds = {},
	  creatingWorkspaceIds = {},
	  onCreatePlannedGoalWorkspace,
	  onSelectPlannedGoal,
	  onSaveChainOrder,
	  boardMessage,
	  loading = false,
	  loadingLabel = 'Loading worktrees...',
}: BoardPageProps) {
  useEffect(() => {
    if (!onPhaseChange) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !event.shiftKey) {
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }

      const change = getShiftArrowPhaseChange({
        groups,
        selectedWorkspaceId,
        direction: event.key === 'ArrowLeft' ? -1 : 1,
      });
      if (!change) {
        return;
      }

      event.preventDefault();
      onPhaseChange(change.workspaceKey, change.phase);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [groups, onPhaseChange, selectedWorkspaceId]);

  return (
    <div className="h-screen w-screen flex flex-col bg-[var(--gs-bg)]">
      {/* Header bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
        <span className="text-sm font-medium text-[var(--gs-text)]">Project Board</span>
        <span className="hidden sm:inline text-xs text-[var(--gs-text-ghost)]">·</span>
        <span className="hidden sm:inline text-xs text-[var(--gs-text-ghost)]">
          {worktreeCount} worktree{worktreeCount !== 1 ? 's' : ''}
        </span>
        <ThemePicker />
        <div className="flex-1" />

        {/* Always visible: + New */}
        <button
          onClick={onOpenCreateMenu}
          className="px-2 py-1 text-xs rounded bg-[var(--gs-accent)] text-[var(--gs-text-on-accent)] hover:bg-[var(--gs-accent-hover)]"
        >
          + New
        </button>

        {/* Desktop-only buttons */}
        <button
          onClick={onOpenInbox}
          className="hidden sm:inline-flex px-2 py-1 text-xs rounded text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
        >
          Inbox{inboxUnreadCount > 0 ? ` (${inboxUnreadCount})` : ''}
        </button>
        <button
          onClick={onOpenHelp}
          className="hidden sm:inline-flex px-2 py-1 text-xs rounded text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
        >
          ?
        </button>
        {onOpenCommandPalette && (
          <button
            onClick={onOpenCommandPalette}
            className="hidden sm:inline-flex px-2 py-1 text-xs rounded text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
          >
            Cmd+K
          </button>
        )}
        <button
          onClick={onRefresh}
          className="hidden sm:inline-flex px-2 py-1 text-xs rounded text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
        >
          Refresh
        </button>
        <button
          onClick={onDisconnect}
          className="hidden sm:inline-flex px-2 py-1 text-xs rounded text-[var(--gs-danger)] hover:bg-[var(--gs-chip-red-bg)]"
        >
          Disconnect
        </button>

        {/* Mobile overflow menu */}
        <OverflowMenu
          onOpenInbox={onOpenInbox}
          inboxUnreadCount={inboxUnreadCount}
          onOpenHelp={onOpenHelp}
          onOpenCommandPalette={onOpenCommandPalette}
          onRefresh={onRefresh}
          onDisconnect={onDisconnect}
        />
      </div>

      {/* Kanban board — fills remaining height */}
      <div className="flex-1 min-h-0 p-3 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-[var(--gs-text-muted)]">{loadingLabel}</div>
          </div>
        ) : (
          <KanbanBoardWeb
            groups={groups}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={onSelectWorkspace}
            workspaceStatusById={workspaceStatusById}
            deletingWorkspaceIds={deletingWorkspaceIds}
	            creatingWorkspaceIds={creatingWorkspaceIds}
            fullHeight
            onCreatePlannedGoalWorkspace={onCreatePlannedGoalWorkspace}
            onSelectPlannedGoal={onSelectPlannedGoal}
            onSaveChainOrder={onSaveChainOrder}
            boardMessage={boardMessage}
          />
        )}
      </div>
    </div>
  );
}
