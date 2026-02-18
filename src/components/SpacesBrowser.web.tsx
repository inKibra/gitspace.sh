/** @jsxImportSource react */
/**
 * SpacesBrowser - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useSpacesBrowser hook.
 */

import type { UseSpacesBrowserReturn } from './SpacesBrowser.js';
import { formatTime } from './SpacesBrowser.js';
import type { WorkspaceInfo } from '../lib/remote-session/protocol.js';

// ============================================================================
// Component
// ============================================================================

export interface SpacesBrowserWebProps extends UseSpacesBrowserReturn {
  onReview?: (workspace: WorkspaceInfo) => void;
}

export function SpacesBrowserWeb(props: SpacesBrowserWebProps) {
  const {
    items,
    machineName,
    isEmpty,
    selectIndex,
    toggleWorkspace,
    attachSession,
    refresh,
    back,
    onReview,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <div className="h-screen flex flex-col bg-[#0d1117]">
        <Header machineName={machineName} onBack={back} onRefresh={refresh} />
        <div className="flex-1 flex flex-col items-center justify-center text-[#8b949e] px-4">
          <div className="text-lg mb-2 text-center">No workspaces found</div>
          <div className="text-sm text-[#6e7681] text-center">
            Create workspaces with <code className="text-[#3fb950]">gssh add</code>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-[#0d1117]">
      <Header machineName={machineName} onBack={back} onRefresh={refresh} />

      {/* Tree list */}
      <div className="flex-1 overflow-y-auto">
        {items.map((item) => {
          const { isSelected, index } = item;

          if (item.type === 'project') {
            return (
              <div
                key={`project-${item.name}`}
                className="px-4 py-3 text-xs text-[#6e7681] uppercase tracking-wide bg-[#161b22] border-b border-[#30363d] min-h-[44px] flex items-center"
              >
                {item.name} ({item.workspaceCount})
              </div>
            );
          }

          if (item.type === 'workspace') {
            const ws = item.workspace;
            return (
              <div
                key={`ws-${ws.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  console.log('[SpacesBrowser] Workspace clicked:', ws.id, ws.name);
                  selectIndex(index);
                  toggleWorkspace(ws.id);
                }}
                className={`
                  px-4 py-4 cursor-pointer border-b border-[#30363d] flex items-center justify-between min-h-[56px]
                  ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
                  ${ws.isStale ? 'opacity-60' : ''}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-[#6e7681] w-5 flex-shrink-0 text-center">
                    {item.expanded ? '▼' : '▶'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[#e6edf3] font-medium truncate">{ws.name}</div>
                    {ws.branch && (
                      <div className="text-xs text-[#8b949e] truncate">
                        <span className="text-[#d2a8ff]">{ws.branch}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  {ws.sessionCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded bg-[#238636] text-[#e6edf3]">
                      {ws.sessionCount}
                    </span>
                  )}
                  {onReview && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onReview(ws);
                      }}
                      className="text-xs px-2 py-1 rounded bg-[#21262d] hover:bg-[#30363d] text-[#8b949e] hover:text-[#58a6ff] border border-[#30363d] hover:border-[#58a6ff] transition-colors"
                    >
                      Review
                    </button>
                  )}
                </div>
              </div>
            );
          }

          if (item.type === 'session') {
            const session = item.session;
            return (
              <div
                key={`session-${session.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  console.log('[SpacesBrowser] Session clicked:', session.id, session.name);
                  selectIndex(index);
                  attachSession({ sessionId: session.id });
                }}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[#30363d] flex items-center justify-between min-h-[52px]
                  ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${session.attached ? 'bg-[#d29922]' : 'bg-[#3fb950]'}`} />
                  <div className="min-w-0 flex-1">
                    <span className="text-[#8b949e] truncate block">{session.name.split(':').pop()}</span>
                    {session.processTitle && (
                      <span className="text-xs text-[#d29922] truncate block">{session.processTitle}</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-[#6e7681] flex-shrink-0 ml-2">
                  {session.attached ? 'attached' : formatTime(session.createdAt)}
                </div>
              </div>
            );
          }

          if (item.type === 'new-session') {
            return (
              <div
                key={`new-${item.workspaceId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  console.log('[SpacesBrowser] New session clicked for workspace:', item.workspaceId);
                  selectIndex(index);
                  attachSession({ workspaceId: item.workspaceId });
                }}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[#30363d] min-h-[48px] flex items-center
                  ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
                `}
              >
                <span className="text-[#58a6ff]">+ New Session</span>
              </div>
            );
          }

          return null;
        })}
      </div>

      <Footer />
    </div>
  );
}

// ============================================================================
// Subcomponents
// ============================================================================

function Header({
  machineName,
  onBack,
  onRefresh,
}: {
  machineName: string | null;
  onBack: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-[#30363d] min-h-[52px]">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          onClick={onBack}
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div className="text-[#e6edf3] font-medium truncate">
          {machineName || 'Workspaces'}
        </div>
      </div>
      <button
        onClick={onRefresh}
        className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pl-2 -mr-2 min-h-[44px] flex items-center flex-shrink-0"
      >
        Refresh
      </button>
    </div>
  );
}

function Footer() {
  return (
    <div className="bg-[#161b22] px-4 py-2 border-t border-[#30363d] safe-bottom">
      {/* Desktop keyboard hints */}
      <div className="hidden sm:flex gap-4 text-xs text-[#6e7681] flex-wrap">
        <span>↑↓ Navigate</span>
        <span>Enter Select</span>
        <span>n New</span>
        <span>x Kill</span>
        <span>d Delete</span>
        <span>r Refresh</span>
        <span>Esc Back</span>
      </div>
      {/* Mobile hint */}
      <div className="sm:hidden text-xs text-[#6e7681] text-center">
        Tap to expand • Tap session to attach
      </div>
    </div>
  );
}
