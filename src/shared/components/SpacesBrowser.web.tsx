/** @jsxImportSource react */
/**
 * SpacesBrowser - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useSpacesBrowser hook.
 */

import type { UseSpacesBrowserReturn } from './SpacesBrowser.js';
import { formatTime } from './SpacesBrowser.js';

// ============================================================================
// Component
// ============================================================================

export function SpacesBrowserWeb(props: UseSpacesBrowserReturn) {
  const {
    items,
    machineName,
    isEmpty,
    selectIndex,
    toggleWorkspace,
    attachSession,
    refresh,
    back,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <div className="h-screen flex flex-col bg-gray-900">
        <Header machineName={machineName} onBack={back} onRefresh={refresh} />
        <div className="flex-1 flex flex-col items-center justify-center text-gray-400 px-4">
          <div className="text-lg mb-2 text-center">No workspaces found</div>
          <div className="text-sm text-gray-500 text-center">
            Create workspaces with <code className="text-green-400">gssh add</code>
          </div>
        </div>
        <Footer />
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col bg-gray-900">
      <Header machineName={machineName} onBack={back} onRefresh={refresh} />

      {/* Tree list */}
      <div className="flex-1 overflow-y-auto">
        {items.map((item) => {
          const { isSelected, index } = item;

          if (item.type === 'project') {
            return (
              <div
                key={`project-${item.name}`}
                className="px-4 py-3 text-xs text-gray-500 uppercase tracking-wide bg-gray-800 border-b border-gray-700 min-h-[44px] flex items-center"
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
                  px-4 py-4 cursor-pointer border-b border-gray-800 flex items-center justify-between min-h-[56px]
                  ${isSelected ? 'bg-gray-700 border-l-4 border-l-blue-500' : 'hover:bg-gray-800 active:bg-gray-700'}
                  ${ws.isStale ? 'opacity-60' : ''}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-gray-500 w-5 flex-shrink-0 text-center">
                    {item.expanded ? '▼' : '▶'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-white font-medium truncate">{ws.name}</div>
                    {ws.branch && (
                      <div className="text-xs text-gray-500 truncate">
                        <span className="text-purple-400">{ws.branch}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0 ml-2">
                  {ws.sessionCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded bg-green-900 text-green-300">
                      {ws.sessionCount}
                    </span>
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
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-gray-800 flex items-center justify-between min-h-[52px]
                  ${isSelected ? 'bg-gray-700 border-l-4 border-l-blue-500' : 'hover:bg-gray-800 active:bg-gray-700'}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${session.attached ? 'bg-yellow-500' : 'bg-green-500'}`} />
                  <div className="min-w-0 flex-1">
                    <span className="text-gray-300 truncate block">{session.name.split(':').pop()}</span>
                    {session.processTitle && (
                      <span className="text-xs text-yellow-400 truncate block">{session.processTitle}</span>
                    )}
                  </div>
                </div>
                <div className="text-xs text-gray-500 flex-shrink-0 ml-2">
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
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-gray-800 min-h-[48px] flex items-center
                  ${isSelected ? 'bg-gray-700 border-l-4 border-l-blue-500' : 'hover:bg-gray-800 active:bg-gray-700'}
                `}
              >
                <span className="text-blue-400">+ New Session</span>
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
    <div className="bg-gray-800 px-4 py-3 flex items-center justify-between border-b border-gray-700 min-h-[52px]">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          onClick={onBack}
          className="text-sm text-gray-400 hover:text-white active:text-blue-400 py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div className="text-white font-medium truncate">
          {machineName || 'Workspaces'}
        </div>
      </div>
      <button
        onClick={onRefresh}
        className="text-sm text-gray-400 hover:text-white active:text-blue-400 py-2 pl-2 -mr-2 min-h-[44px] flex items-center flex-shrink-0"
      >
        Refresh
      </button>
    </div>
  );
}

function Footer() {
  return (
    <div className="bg-gray-800 px-4 py-2 border-t border-gray-700 safe-bottom">
      {/* Desktop keyboard hints */}
      <div className="hidden sm:flex gap-4 text-xs text-gray-500 flex-wrap">
        <span>↑↓ Navigate</span>
        <span>Enter Select</span>
        <span>n New</span>
        <span>x Kill</span>
        <span>d Delete</span>
        <span>r Refresh</span>
        <span>Esc Back</span>
      </div>
      {/* Mobile hint */}
      <div className="sm:hidden text-xs text-gray-500 text-center">
        Tap to expand • Tap session to attach
      </div>
    </div>
  );
}
