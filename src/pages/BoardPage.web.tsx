/** @jsxImportSource react */
/**
 * BoardPage — full-screen kanban board view.
 *
 * Matches the TUI `state.view === 'projects'` layout:
 * header bar + full-height kanban board with all phases visible.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTheme, THEMES } from '../lib/theme.web.js';
import { KanbanBoardWeb } from '../components/KanbanBoard.web.js';
import type { KanbanGoalItem, WorkspaceBoardGroup } from '../app/shared/board/types.js';
import { getShiftArrowPhaseChange } from '../app/shared/board/phase-movement.js';
import type { WorkspacePhase } from '../types/config.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';

export interface BoardPageProps {
  /** Rendered under the GlobalChromeBar — suppress the legacy header row. */
  embedded?: boolean;
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceKey: string | null) => void;
  onPhaseChange?: (workspaceKey: string, phase: WorkspacePhase) => void;
  worktreeCount: number;
  inboxUnreadCount: number;
  onOpenInbox: () => void;
  onOpenHelp: () => void;
  onOpenCreateMenu: () => void;
  /** Open the project home view (docs mock: ProjectHome). */
  onOpenProjectHome?: () => void;
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

interface ProjectStripEntry {
  name: string;
  chains: number;
  workspaces: number;
  active: number;
}

/** Derive the PROJECTS strip entries from board groups (mock ghome-projects). */
function deriveProjects(
  groups: WorkspaceBoardGroup[],
  workspaceStatusById: Record<string, WorkspaceStatusSummary>,
): ProjectStripEntry[] {
  const byName = new Map<string, { chainIds: Set<string>; workspaces: number; active: number }>();
  const ensure = (name: string) => {
    let entry = byName.get(name);
    if (!entry) {
      entry = { chainIds: new Set<string>(), workspaces: 0, active: 0 };
      byName.set(name, entry);
    }
    return entry;
  };
  for (const group of groups) {
    for (const workspace of group.workspaces) {
      const entry = ensure(workspace.projectName);
      entry.workspaces += 1;
      if (workspace.goal) entry.chainIds.add(workspace.goal.chainId);
      const status = workspaceStatusById[workspace.selectionKey];
      if (status && (status.agents.green > 0 || status.agents.orange > 0)) entry.active += 1;
    }
    for (const goal of group.plannedGoals ?? []) {
      ensure(goal.projectName).chainIds.add(goal.chainId);
    }
  }
  return Array.from(byName.entries())
    .map(([name, entry]) => ({ name, chains: entry.chainIds.size, workspaces: entry.workspaces, active: entry.active }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** PROJECTS strip above the kanban (mock Board.tsx ghome-projects section). */
function ProjectsStrip({ projects, onOpenProjectHome, onNewProject }: {
  projects: ProjectStripEntry[];
  onOpenProjectHome?: () => void;
  onNewProject: () => void;
}) {
  const [filter, setFilter] = useState('');
  const visible = projects.filter((project) => project.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className="flex-shrink-0 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)] px-4 py-3">
      <div className="mb-2.5 flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">Projects</span>
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="filter projects…"
          className="w-[200px] border border-[var(--gs-border)] bg-[var(--gs-bg)] px-2 py-1 text-[12px] text-[var(--gs-text)] outline-none placeholder:text-[var(--gs-text-ghost)] focus:border-[var(--gs-border-active)]"
        />
        <button
          type="button"
          onClick={onNewProject}
          className="ml-auto rounded bg-[var(--gs-accent)] px-2 py-1 text-xs text-[var(--gs-text-on-accent)] hover:bg-[var(--gs-accent-hover)]"
        >
          ＋ New project
        </button>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2.5">
        {visible.length === 0 && (
          <div className="py-2 text-[11.5px] italic text-[var(--gs-text-ghost)]">
            {projects.length === 0 ? 'No projects yet' : 'No projects match the filter'}
          </div>
        )}
        {visible.map((project) => (
          <button
            key={project.name}
            type="button"
            onClick={onOpenProjectHome}
            disabled={!onOpenProjectHome}
            title={onOpenProjectHome ? `Open ${project.name} project home` : 'Project home unavailable'}
            className="border border-[var(--gs-border)] bg-[var(--gs-bg-surface)] px-[13px] py-[11px] text-left transition-colors hover:border-[var(--gs-border-active)] hover:bg-[var(--gs-bg-hover)] disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[13px] text-[var(--gs-text)]">{project.name}</span>
              {project.active > 0 && <span className="h-[7px] w-[7px] animate-pulse rounded-full bg-[var(--gs-accent)]" />}
            </div>
            <div className="mt-[5px] text-[11px] text-[var(--gs-text-dim)]">
              {project.chains} chains · {project.workspaces} workspaces{project.active > 0 ? ` · ${project.active} active` : ''}
            </div>
            <div className="mt-2 text-[10.5px] text-[var(--gs-info)]">enter project home →</div>
          </button>
        ))}
      </div>
    </div>
  );
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
  embedded = false,
  groups,
  selectedWorkspaceId,
  onSelectWorkspace,
  onPhaseChange,
  worktreeCount,
  inboxUnreadCount,
  onOpenInbox,
  onOpenHelp,
  onOpenCreateMenu,
  onOpenProjectHome,
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
  const [boardView, setBoardView] = useState<'workspaces' | 'stacks'>('workspaces');
  const projects = useMemo(
    () => deriveProjects(groups, workspaceStatusById),
    [groups, workspaceStatusById],
  );

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
    <div className={`${embedded ? 'h-full w-full' : 'h-screen w-screen'} flex flex-col bg-[var(--gs-bg)]`}>
      {/* Header bar (hidden when the GlobalChromeBar renders above — mock item 4) */}
      {!embedded && (
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
        <span className="text-sm font-medium text-[var(--gs-text)]">Project Board</span>
        {onOpenProjectHome && (
          <button
            onClick={onOpenProjectHome}
            className="px-1.5 py-0.5 text-xs rounded text-[var(--gs-text-dim)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
            title="Project home"
          >
            ⌂ home
          </button>
        )}
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
      )}

      {/* PROJECTS strip (mock ghome-projects) */}
      {!loading && (
        <ProjectsStrip
          projects={projects}
          onOpenProjectHome={onOpenProjectHome}
          onNewProject={onOpenCreateMenu}
        />
      )}

      {/* Kicker + Workspaces/Stacks segmented toggle (mock ghome-kanban-h) */}
      {!loading && (
        <div className="flex flex-shrink-0 items-center px-4 pb-1 pt-2.5">
          <span className="text-[10px] uppercase tracking-[0.12em] text-[var(--gs-text-dim)]">
            {boardView === 'workspaces' ? 'All workspaces · across projects' : 'Goal stacks · alignment across the chain'}
          </span>
          <span className="ml-2.5 inline-flex border border-[var(--gs-border)]">
            <button
              type="button"
              onClick={() => setBoardView('workspaces')}
              className={`px-[11px] py-[3px] text-[11px] ${boardView === 'workspaces' ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)] shadow-[inset_0_-2px_0_var(--gs-accent)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
            >
              Workspaces
            </button>
            <button
              type="button"
              onClick={() => setBoardView('stacks')}
              className={`px-[11px] py-[3px] text-[11px] ${boardView === 'stacks' ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)] shadow-[inset_0_-2px_0_var(--gs-accent)]' : 'text-[var(--gs-text-dim)] hover:text-[var(--gs-text)]'}`}
            >
              Stacks
            </button>
          </span>
        </div>
      )}

      {/* Kanban board — fills remaining height */}
      <div className="flex-1 min-h-0 px-3 pb-3 pt-1 overflow-auto">
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
            view={boardView}
          />
        )}
      </div>
    </div>
  );
}
