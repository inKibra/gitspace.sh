/** @jsxImportSource react */
/**
 * BoardPage — full-screen kanban board view.
 *
 * Matches the TUI `state.view === 'projects'` layout:
 * header bar + full-height kanban board with all phases visible.
 */

import { KanbanBoardWeb } from '../components/KanbanBoard.web.js';
import type { WorkspaceBoardGroup } from '../machine/controllers/useKanbanViewController.js';
import type { WorkspacePhase } from '../types/config.js';
import type { WorkspaceStatusSummary } from '../app/workspaces/workspace-status.js';

export interface BoardPageProps {
  groups: WorkspaceBoardGroup[];
  selectedWorkspaceId: string | null;
  onSelectWorkspace: (workspaceId: string | null) => void;
  onPhaseChange?: (workspaceId: string, phase: WorkspacePhase) => void;
  worktreeCount: number;
  inboxUnreadCount: number;
  onOpenInbox: () => void;
  onOpenHelp: () => void;
  onOpenCreateMenu: () => void;
  onOpenCommandPalette?: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
  workspaceStatusById?: Record<string, WorkspaceStatusSummary>;
  /** True when backend is connected but workspaces haven't arrived yet. */
  loading?: boolean;
  loadingLabel?: string;
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
  loading = false,
  loadingLabel = 'Loading worktrees...',
}: BoardPageProps) {
  return (
    <div className="h-screen w-screen flex flex-col bg-[#0d1117]">
      {/* Header bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[#30363d] bg-[#161b22]">
        <span className="text-sm font-medium text-[#e6edf3]">Project Board</span>
        <span className="text-xs text-[#484f58]">·</span>
        <span className="text-xs text-[#484f58]">
          {worktreeCount} worktree{worktreeCount !== 1 ? 's' : ''}
        </span>
        <div className="flex-1" />
        <button
          onClick={onOpenInbox}
          className="px-2 py-1 text-xs rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
        >
          Inbox{inboxUnreadCount > 0 ? ` (${inboxUnreadCount})` : ''}
        </button>
        <button
          onClick={onOpenHelp}
          className="px-2 py-1 text-xs rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
        >
          ?
        </button>
        <button
          onClick={onOpenCreateMenu}
          className="px-2 py-1 text-xs rounded bg-[#238636] text-white hover:bg-[#2ea043]"
        >
          + New
        </button>
        {onOpenCommandPalette && (
          <button
            onClick={onOpenCommandPalette}
            className="px-2 py-1 text-xs rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
          >
            Cmd+K
          </button>
        )}
        <button
          onClick={onRefresh}
          className="px-2 py-1 text-xs rounded text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#21262d]"
        >
          Refresh
        </button>
        <button
          onClick={onDisconnect}
          className="px-2 py-1 text-xs rounded text-[#f85149] hover:bg-[#2d1617]"
        >
          Disconnect
        </button>
      </div>

      {/* Kanban board — fills remaining height */}
      <div className="flex-1 min-h-0 p-3 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-sm text-[#8b949e]">{loadingLabel}</div>
          </div>
        ) : (
          <KanbanBoardWeb
            groups={groups}
            selectedWorkspaceId={selectedWorkspaceId}
            onSelectWorkspace={onSelectWorkspace}
            onPhaseChange={onPhaseChange}
            workspaceStatusById={workspaceStatusById}
            fullHeight
          />
        )}
      </div>
    </div>
  );
}
