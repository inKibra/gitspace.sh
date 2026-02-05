/** @jsxImportSource react */
/**
 * SpacesBrowser - Web Display Component
 *
 * Dumb presentational component for web.
 * Receives all state and actions from useSpacesBrowser hook.
 */

import type { UseSpacesBrowserReturn } from './SpacesBrowser.js';
import { formatTime } from './SpacesBrowser.js';
import { buildProcessHostname } from '../../utils/hostnames.js';

// ============================================================================
// Component
// ============================================================================

export function SpacesBrowserWeb(props: UseSpacesBrowserReturn) {
  const {
    items,
    isEmpty,
    selectIndex,
    toggleWorkspace,
    attachSession,
    startProcess,
    stopProcess,
    refresh,
    openEvents,
  } = props;

  // Empty state
  if (isEmpty) {
    return (
      <div className="h-full flex flex-col bg-[#0d1117]">
        <Header onRefresh={refresh} />
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
    <div className="h-full flex flex-col bg-[#0d1117]">
      <Header onRefresh={refresh} />

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
                <div className="text-right flex-shrink-0 ml-2">
                  {ws.sessionCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded bg-[#238636] text-[#e6edf3]">
                      {ws.sessionCount}
                    </span>
                  )}
                </div>
              </div>
            );
          }

          if (item.type === 'process') {
            const links = buildProcessLinks(item);
            return (
              <div
                key={`proc-${item.workspaceId}-${item.processName}-${item.instance}`}
                onClick={(e) => {
                  e.stopPropagation();
                  selectIndex(index);
                }}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 border-b border-[#30363d] flex items-center justify-between min-h-[52px]
                  ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${item.status === 'running' ? 'bg-[#3fb950]' : item.status === 'failed' ? 'bg-[#f85149]' : 'bg-[#6e7681]'}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[#8b949e] truncate block">
                        {item.processName}#{item.instance}
                      </span>
                      <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#30363d] text-[#8b949e]">
                        process
                      </span>
                    </div>
                    <span className={`text-xs ${item.status === 'failed' ? 'text-[#f85149]' : 'text-[#6e7681]'}`}>
                      {item.status}
                    </span>
                    {links.length > 0 && (
                      <div className="text-xs text-[#6e7681] flex flex-wrap gap-x-2 gap-y-1 mt-1">
                        {links.map((link) =>
                          link.protocol === 'tcp' ? (
                            <span key={link.url} className="text-[#8b949e] break-all">
                              {link.url}
                            </span>
                          ) : (
                            <a
                              key={link.url}
                              href={link.url}
                              target="_blank"
                              rel="noreferrer"
                              className="text-[#58a6ff] hover:text-[#79c0ff] underline-offset-2 hover:underline break-all"
                            >
                              {link.url}
                            </a>
                          )
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-[#6e7681] flex-shrink-0 ml-2">
                  {item.status === 'running' ? (
                    <>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          const target = items.find(
                            (candidate) =>
                              candidate.type === 'session' &&
                              candidate.workspaceId === item.workspaceId &&
                              candidate.session.processName === item.processName &&
                              (candidate.session.processInstance ?? 1) === item.instance
                          );
                          if (target && target.type === 'session') {
                            attachSession({ sessionId: target.session.id });
                          }
                        }}
                        className="px-2 py-1 rounded bg-[#1f6feb] hover:bg-[#388bfd] text-[#e6edf3]"
                      >
                        Attach
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          stopProcess?.({ workspaceId: item.workspaceId, processName: item.processName });
                        }}
                        className="px-2 py-1 rounded bg-[#21262d] hover:bg-[#30363d] text-[#e6edf3]"
                      >
                        Stop
                      </button>
                    </>
                  ) : (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          startProcess?.({ workspaceId: item.workspaceId, processName: item.processName });
                        }}
                        className="px-2 py-1 rounded bg-[#238636] hover:bg-[#2ea043] text-[#e6edf3]"
                      >
                        Start
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
                    <div className="flex items-center gap-2">
                      <span className="text-[#8b949e] truncate block">
                        {session.processName
                          ? `${session.processName}#${session.processInstance ?? 1}`
                          : session.name.split(':').pop()}
                      </span>
                      {session.processName && (
                        <>
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#30363d] text-[#8b949e]">
                            process
                          </span>
                          <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-[#1f6feb] text-[#e6edf3]">
                            runner
                          </span>
                        </>
                      )}
                    </div>
                    {session.processTitle && (
                      <span className="text-xs text-[#d29922] truncate block">{session.processTitle}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 text-xs text-[#6e7681] flex-shrink-0 ml-2">
                  <span>{session.attached ? 'attached' : formatTime(session.createdAt)}</span>
                </div>
              </div>
            );
          }

          if (item.type === 'events') {
            return (
              <div
                key={`events-${item.workspaceId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  selectIndex(index);
                  openEvents(item.workspaceId);
                }}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[#30363d] min-h-[48px] flex items-center
                  ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
                `}
              >
                <span className="text-[#8b949e]">▸ Events</span>
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
  onRefresh,
}: {
  onRefresh: () => void;
}) {
  return (
    <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-[#30363d] min-h-[52px]">
      <div className="text-[#e6edf3] font-medium truncate">Workspaces</div>
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

// ============================================================================
// Helpers
// ============================================================================

type ProcessLink = {
  url: string;
  protocol: 'http' | 'tcp';
};

function buildProcessLinks(item: { processName: string; instance: number; workspaceId: string; ports?: { port: number; name?: string; protocol?: 'http' | 'tcp' }[]; serveDomain?: string }): ProcessLink[] {
  if (!item.ports || item.ports.length === 0 || !item.serveDomain) {
    return [];
  }
  const serveDomain = item.serveDomain;
  return item.ports.map((port) => {
    const portLabel = port.name ?? String(port.port);
    const host = buildProcessHostname(
      serveDomain,
      item.workspaceId,
      item.processName,
      item.instance,
      portLabel
    );
    const protocol = port.protocol === 'tcp' ? 'tcp' : 'http';
    const url = protocol === 'tcp' ? `tcp://${host}` : `https://${host}`;
    return { url, protocol };
  });
}
