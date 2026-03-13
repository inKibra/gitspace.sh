/** @jsxImportSource react */
/**
 * SpacesBrowser - Web Display Component
 *
 * Presentational component for web with visible actions for desktop and mobile.
 */

import { useEffect, useRef, type RefObject } from 'react';
import type { TreeItem, UseSpacesBrowserReturn } from './SpacesBrowser.js';
import { formatTime } from './SpacesBrowser.js';
import type { WorkspaceInfo } from '../lib/remote-session/protocol.js';

function isActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export interface SpacesBrowserWebProps extends UseSpacesBrowserReturn {
  onReview?: (workspace: WorkspaceInfo) => void;
  onCreate?: () => void;
  onHelp?: () => void;
  onOpenInbox?: () => void;
  inboxUnreadCount?: number;
  onDisconnect?: () => void;
  onCreateWorkspaceForProject?: (projectName: string) => void;
  onDeleteProject?: (projectName: string) => void;
  onDeleteWorkspace?: (workspace: WorkspaceInfo) => void;
  onDeleteSession?: (sessionId: string, sessionName: string) => void;
  embedded?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
}

export function SpacesBrowserWeb(props: SpacesBrowserWebProps) {
  const {
    items,
    machineName,
    isEmpty,
    selectedItem,
    activateIndex,
    refresh,
    back,
    onReview,
    onCreate,
    onHelp,
    onOpenInbox,
    inboxUnreadCount = 0,
    onDisconnect,
    onCreateWorkspaceForProject,
    onDeleteProject,
    onDeleteWorkspace,
    onDeleteSession,
    startProcessAttach,
    stopProcess,
    embedded = false,
    emptyTitle,
    emptyDescription,
    emptyActionLabel,
    onEmptyAction,
  } = props;
  const selectedRowRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, [items]);

  const shellClassName = embedded
    ? 'h-full flex flex-col bg-[#0d1117]'
    : 'h-screen flex flex-col bg-[#0d1117]';
  const resolvedEmptyTitle = emptyTitle ?? 'No workspaces found';
  const resolvedEmptyDescription = emptyDescription ?? 'Create a workspace from the app instead of dropping to the CLI.';
  const resolvedEmptyActionLabel = emptyActionLabel ?? 'New Workspace or Project';
  const handleEmptyAction = onEmptyAction ?? onCreate;

  if (isEmpty) {
    return (
      <div className={shellClassName}>
        <Header
          machineName={machineName}
          onBack={back}
          onRefresh={refresh}
          onCreate={onCreate}
          onHelp={onHelp}
          onOpenInbox={onOpenInbox}
          inboxUnreadCount={inboxUnreadCount}
          onDisconnect={onDisconnect}
        />
        <div className="flex-1 flex flex-col items-center justify-center text-[#8b949e] px-4">
          <div className="text-lg mb-2 text-center">{resolvedEmptyTitle}</div>
          <div className="text-sm text-[#6e7681] text-center max-w-md">
            {resolvedEmptyDescription}
          </div>
          {handleEmptyAction && (
            <button
              onClick={handleEmptyAction}
              className="mt-5 px-4 py-3 rounded-lg bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] text-[#0d1117] font-medium min-h-[48px] shadow-glow"
            >
              {resolvedEmptyActionLabel}
            </button>
          )}
        </div>
        <Footer selectedItem={selectedItem} hasVisibleActions={Boolean(onCreate || onHelp || handleEmptyAction)} />
      </div>
    );
  }

  return (
    <div className={shellClassName}>
      <Header
        machineName={machineName}
        onBack={back}
        onRefresh={refresh}
        onCreate={onCreate}
        onHelp={onHelp}
        onOpenInbox={onOpenInbox}
        inboxUnreadCount={inboxUnreadCount}
        onDisconnect={onDisconnect}
      />

      <div className="flex-1 overflow-y-auto min-h-0">
        {items.map((item) => {
          const { isSelected, index } = item;

          if (item.type === 'project') {
            return (
              <div
                key={`project-${item.name}`}
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                onKeyDown={(e) => {
                  if (!isActivateKey(e.key)) {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                role="button"
                tabIndex={0}
                className={
                  `px-4 py-3 text-xs uppercase tracking-wide border-b border-[#30363d] min-h-[52px] flex items-center justify-between gap-3 cursor-pointer ${
                    isSelected
                      ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff] text-[#e6edf3]'
                      : 'bg-[#161b22] text-[#6e7681] hover:bg-[#1b2129] active:bg-[#21262d]'
                  }`
                }
              >
                <span>{item.name} ({item.workspaceCount})</span>
                <div className="flex items-center gap-2">
                  {onCreateWorkspaceForProject && (
                    <ActionButton
                      label="New"
                      title={`Create workspace in ${item.name}`}
                      onClick={() => onCreateWorkspaceForProject(item.name)}
                    />
                  )}
                  {onDeleteProject && (
                    <ActionButton
                      label="Delete"
                      title={`Delete project ${item.name}`}
                      tone="danger"
                      onClick={() => onDeleteProject(item.name)}
                    />
                  )}
                </div>
              </div>
            );
          }

          if (item.type === 'workspace') {
            const ws = item.workspace;
            return (
              <div
                key={`ws-${ws.id}`}
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                onKeyDown={(e) => {
                  if (!isActivateKey(e.key)) {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                role="button"
                tabIndex={0}
                className={`
                  px-4 py-4 cursor-pointer border-b border-[#30363d] flex items-center justify-between min-h-[56px] gap-3
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
                <div className="flex items-center gap-2 flex-shrink-0 ml-2 flex-wrap justify-end">
                  {ws.sessionCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded bg-[#238636] text-[#e6edf3]">
                      {ws.sessionCount}
                    </span>
                  )}
                  {onReview && (
                    <ActionButton
                      label="Review"
                      title={`Review ${ws.name}`}
                      onClick={() => onReview(ws)}
                    />
                  )}
                  {onDeleteWorkspace && (
                    <ActionButton
                      label="Delete"
                      title={`Delete ${ws.name}`}
                      tone="danger"
                      onClick={() => onDeleteWorkspace(ws)}
                    />
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
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                onKeyDown={(e) => {
                  if (!isActivateKey(e.key)) {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                role="button"
                tabIndex={0}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[#30363d] flex items-center justify-between min-h-[52px] gap-3
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
                <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                  <div className="text-xs text-[#6e7681] hidden sm:block">
                    {session.attached ? 'attached' : formatTime(session.createdAt)}
                  </div>
                  {onDeleteSession && (
                    <ActionButton
                      label="Kill"
                      title={`Kill ${session.name}`}
                      tone="danger"
                      onClick={() => onDeleteSession(session.id, session.name)}
                    />
                  )}
                </div>
              </div>
            );
          }

          if (item.type === 'process') {
            const statusIcon = item.status === 'running' ? '▶' : item.status === 'failed' ? '✗' : '■';
            const statusColor = item.status === 'running' ? 'text-[#3fb950]' : item.status === 'failed' ? 'text-[#f85149]' : 'text-[#8b949e]';
            const portInfo = item.ports?.length ? `:${item.ports.map((port) => port.port).join(',')}` : '';

            return (
              <div
                key={`process-${item.workspaceId}-${item.processName}-${item.instance}`}
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                onKeyDown={(e) => {
                  if (!isActivateKey(e.key)) {
                    return;
                  }
                  e.preventDefault();
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                role="button"
                tabIndex={0}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[#30363d] flex items-center justify-between min-h-[52px] gap-3
                  ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`w-2.5 h-2.5 flex-shrink-0 ${statusColor}`}>{statusIcon}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[#e6edf3] truncate block">{item.processName}#{item.instance}</span>
                    {portInfo && <span className="text-xs text-[#8b949e] truncate block">{portInfo}</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  <span className={`text-xs ${statusColor} hidden sm:inline`}>{item.status}</span>
                  {item.status === 'running' ? (
                    <ActionButton
                      label="Stop"
                      title={`Stop ${item.processName}`}
                      tone="danger"
                      onClick={() => stopProcess({ workspaceId: item.workspaceId, processName: item.processName })}
                    />
                  ) : (
                    <ActionButton
                      label="Start"
                      title={`Start ${item.processName}`}
                      tone="success"
                      onClick={() => startProcessAttach({
                        workspaceId: item.workspaceId,
                        processName: item.processName,
                        instance: item.instance,
                      })}
                    />
                  )}
                </div>
              </div>
            );
          }

          if (item.type === 'process-disabled') {
            return (
              <SimpleTreeRow
                key={`process-disabled-${item.workspaceId}-${item.processName}`}
                index={index}
                isSelected={isSelected}
                onActivate={activateIndex}
                label={`⏸ ${item.processName} (disabled)`}
                selectedRef={isSelected ? selectedRowRef : undefined}
              />
            );
          }

          if (item.type === 'process-config-error') {
            return (
              <SimpleTreeRow
                key={`process-config-error-${item.workspaceId}`}
                index={index}
                isSelected={isSelected}
                onActivate={activateIndex}
                label="⚠ Invalid processes config"
                title={item.error}
                tone="error"
                selectedRef={isSelected ? selectedRowRef : undefined}
              />
            );
          }

          if (item.type === 'edit-processes') {
            return (
              <SimpleTreeRow
                key={`edit-processes-${item.workspaceId}`}
                index={index}
                isSelected={isSelected}
                onActivate={activateIndex}
                label="⚙ Edit Processes Config"
                tone="warning"
                selectedRef={isSelected ? selectedRowRef : undefined}
              />
            );
          }

          if (item.type === 'bundle-config') {
            return (
              <SimpleTreeRow
                key={`bundle-config-${item.workspaceId}`}
                index={index}
                isSelected={isSelected}
                onActivate={activateIndex}
                label="◇ Edit Bundle Config"
                tone="accent"
                selectedRef={isSelected ? selectedRowRef : undefined}
              />
            );
          }

          if (item.type === 'events') {
            return (
              <SimpleTreeRow
                key={`events-${item.workspaceId}`}
                index={index}
                isSelected={isSelected}
                onActivate={activateIndex}
                label="◆ Events"
                tone="violet"
                selectedRef={isSelected ? selectedRowRef : undefined}
              />
            );
          }

          if (item.type === 'new-session') {
            return (
              <SimpleTreeRow
                key={`new-${item.workspaceId}`}
                index={index}
                isSelected={isSelected}
                onActivate={activateIndex}
                label="+ New Session"
                tone="accent"
                selectedRef={isSelected ? selectedRowRef : undefined}
              />
            );
          }

          return null;
        })}
      </div>

      <Footer selectedItem={selectedItem} hasVisibleActions={Boolean(onCreate || onHelp)} />
    </div>
  );
}

function Header({
  machineName,
  onBack,
  onRefresh,
  onCreate,
  onHelp,
  onOpenInbox,
  inboxUnreadCount = 0,
  onDisconnect,
}: {
  machineName: string | null;
  onBack: () => void;
  onRefresh: () => void;
  onCreate?: () => void;
  onHelp?: () => void;
  onOpenInbox?: () => void;
  inboxUnreadCount?: number;
  onDisconnect?: () => void;
}) {
  return (
    <div className="bg-[#161b22] px-4 py-3 flex items-center justify-between border-b border-[#30363d] min-h-[52px] gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          onClick={onBack}
          aria-label="Back"
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div className="text-[#e6edf3] font-medium truncate">
          {machineName || 'Workspaces'}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
        {onOpenInbox && (
          <button
            onClick={onOpenInbox}
            className="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] rounded text-[#e6edf3] min-h-[44px] border border-[#30363d]"
          >
            Inbox
            {inboxUnreadCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs bg-[#58a6ff] rounded-full text-[#0d1117] font-medium">
                {inboxUnreadCount}
              </span>
            )}
          </button>
        )}
        {onHelp && (
          <button
            onClick={onHelp}
            aria-label="Help"
            className="px-3 py-2 text-sm bg-[#21262d] hover:bg-[#30363d] active:bg-[#161b22] rounded text-[#e6edf3] min-h-[44px] border border-[#30363d]"
          >
            ? <span className="hidden sm:inline ml-1">Help</span>
          </button>
        )}
        {onCreate && (
          <button
            onClick={onCreate}
            aria-label="New workspace or project"
            className="px-3 py-2 text-sm bg-[#22c55e] hover:bg-[#16a34a] active:bg-[#16a34a] rounded text-[#0d1117] font-medium min-h-[44px] shadow-glow"
          >
            + <span className="hidden sm:inline ml-1">New</span>
          </button>
        )}
        <button
          onClick={onRefresh}
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] active:text-[#22c55e] py-2 pl-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          Refresh
        </button>
        {onDisconnect && (
          <button
            onClick={onDisconnect}
            aria-label="Disconnect"
            className="px-3 py-2 text-sm bg-[#f85149] hover:bg-[#ff7b72] active:bg-[#da3633] rounded text-white min-h-[44px] border border-[#f85149]"
          >
            <span className="hidden sm:inline">Disconnect</span>
            <span className="sm:hidden">×</span>
          </button>
        )}
      </div>
    </div>
  );
}

function Footer({
  selectedItem,
  hasVisibleActions,
}: {
  selectedItem: TreeItem | null;
  hasVisibleActions: boolean;
}) {
  const hint = getFooterHint(selectedItem, hasVisibleActions);

  return (
    <div className="bg-[#161b22] px-4 py-2 border-t border-[#30363d] safe-bottom">
      <div className="hidden sm:flex gap-4 text-xs text-[#6e7681] flex-wrap">
        {hint.desktop.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div className="sm:hidden text-xs text-[#6e7681] text-center">
        {hint.mobile}
      </div>
    </div>
  );
}

function getFooterHint(selectedItem: TreeItem | null, hasVisibleActions: boolean) {
  if (selectedItem?.type === 'workspace') {
    return {
      desktop: ['Enter Expand', 'Delete Workspace', 'Review', 'b Bundle', '? Help'],
      mobile: 'Tap to expand • Use row actions for review/delete',
    };
  }

  if (selectedItem?.type === 'session') {
    return {
      desktop: ['Enter Attach', 'Kill Session', 'i Inbox', '? Help'],
      mobile: 'Tap to attach • Use Kill to end a session',
    };
  }

  if (selectedItem?.type === 'process') {
    return {
      desktop: ['Enter Open', selectedItem.status === 'running' ? 'Stop Process' : 'Start Process', 'b Bundle', '? Help'],
      mobile: selectedItem.status === 'running'
        ? 'Tap to view • Use Stop to halt the process'
        : 'Tap to inspect • Use Start to launch the process',
    };
  }

  return {
    desktop: [
      '↑↓ Navigate',
      'Enter Select',
      hasVisibleActions ? '+ New' : 'n New',
      'x Kill',
      'd Delete',
      'r Refresh',
      '? Help',
    ],
    mobile: 'Use New and row actions • Tap a session to attach',
  };
}

function ActionButton({
  label,
  title,
  onClick,
  tone = 'neutral',
}: {
  label: string;
  title?: string;
  onClick: () => void;
  tone?: 'neutral' | 'danger' | 'success';
}) {
  const toneClass = tone === 'danger'
    ? 'bg-[#2d1617] border-[#f85149]/40 text-[#ff7b72] hover:bg-[#3a1d1f]'
    : tone === 'success'
      ? 'bg-[#14261a] border-[#22c55e]/40 text-[#3fb950] hover:bg-[#183321]'
      : 'bg-[#21262d] border-[#30363d] text-[#8b949e] hover:bg-[#30363d] hover:text-[#e6edf3]';

  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      className={`px-2.5 py-1.5 rounded border text-xs min-h-[36px] ${toneClass}`}
    >
      {label}
    </button>
  );
}

function SimpleTreeRow({
  index,
  isSelected,
  onActivate,
  label,
  title,
  tone = 'neutral',
  selectedRef,
}: {
  index: number;
  isSelected: boolean;
  onActivate: (index: number) => Promise<void>;
  label: string;
  title?: string;
  tone?: 'neutral' | 'warning' | 'error' | 'accent' | 'violet';
  selectedRef?: RefObject<HTMLDivElement | null>;
}) {
  const textClass = tone === 'warning'
    ? 'text-[#ffaa55]'
    : tone === 'error'
      ? 'text-[#f85149]'
      : tone === 'accent'
        ? 'text-[#58a6ff]'
        : tone === 'violet'
          ? 'text-[#d2a8ff]'
          : 'text-[#8b949e]';

  return (
    <div
      ref={selectedRef ?? null}
      onClick={(e) => {
        e.stopPropagation();
        void onActivate(index);
      }}
      onKeyDown={(e) => {
        if (!isActivateKey(e.key)) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void onActivate(index);
      }}
      role="button"
      tabIndex={0}
      className={`
        pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[#30363d] min-h-[48px] flex items-center
        ${isSelected ? 'bg-[#21262d] border-l-4 border-l-[#58a6ff]' : 'hover:bg-[#161b22] active:bg-[#21262d]'}
      `}
      title={title}
    >
      <span className={textClass}>{label}</span>
    </div>
  );
}
