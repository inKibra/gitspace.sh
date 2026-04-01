/** @jsxImportSource react */
/**
 * SpacesBrowser - Web Display Component
 *
 * Presentational component for web with visible actions for desktop and mobile.
 */

import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';
import type { TreeItem, UseSpacesBrowserReturn } from './SpacesBrowser.js';
import { formatTime, getAgentSessionDisplayLabel, getAgentSessionDisplayState } from './SpacesBrowser.js';
import type { WorkspaceInfo } from '../lib/remote-session/protocol.js';

function isActivateKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

function stopButtonActivationPropagation(event: KeyboardEvent<HTMLButtonElement>): void {
  if (isActivateKey(event.key)) {
    event.stopPropagation();
  }
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
    ? 'h-full flex flex-col bg-[var(--gs-bg)]'
    : 'h-screen flex flex-col bg-[var(--gs-bg)]';
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
        <div className="flex-1 flex flex-col items-center justify-center text-[var(--gs-text-muted)] px-4">
          <div className="text-lg mb-2 text-center">{resolvedEmptyTitle}</div>
          <div className="text-sm text-[var(--gs-text-dim)] text-center max-w-md">
            {resolvedEmptyDescription}
          </div>
          {handleEmptyAction && (
            <button
              onClick={handleEmptyAction}
              className="mt-5 px-4 py-3 rounded-lg bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] text-[var(--gs-text-on-accent)] font-medium min-h-[48px] shadow-glow"
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
                  `px-4 py-3 text-xs uppercase tracking-wide border-b border-[var(--gs-border)] min-h-[52px] flex items-center justify-between gap-3 cursor-pointer ${
                    isSelected
                      ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)] text-[var(--gs-text)]'
                      : 'bg-[var(--gs-bg-elevated)] text-[var(--gs-text-dim)] hover:bg-[var(--gs-bg-hover)] active:bg-[var(--gs-bg-active)]'
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
                  px-4 py-4 cursor-pointer border-b border-[var(--gs-border)] flex items-center justify-between min-h-[56px] gap-3
                  ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                  ${ws.isStale ? 'opacity-60' : ''}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className="text-[var(--gs-text-dim)] w-5 flex-shrink-0 text-center">
                    {item.expanded ? '▼' : '▶'}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[var(--gs-text)] font-medium truncate">{ws.name}</div>
                    {ws.branch && (
                      <div className="text-xs text-[var(--gs-text-muted)] truncate">
                        <span className="text-[var(--gs-purple)]">{ws.branch}</span>
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2 flex-wrap justify-end">
                  {ws.sessionCount > 0 && (
                    <span className="text-xs px-2 py-1 rounded bg-[var(--gs-success-muted)] text-[var(--gs-text)]">
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
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] flex items-center justify-between min-h-[52px] gap-3
                  ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${session.attached ? 'bg-[var(--gs-warning)]' : 'bg-[var(--gs-success)]'}`} />
                  <div className="min-w-0 flex-1">
                    <span className="text-[var(--gs-text-muted)] truncate block">{session.name.split(':').pop()}</span>
                    {(item.subtitle ?? session.processTitle ?? session.terminalTitle) && (
                      <span className="text-xs text-[var(--gs-warning)] truncate block">{item.subtitle ?? session.processTitle ?? session.terminalTitle}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0 ml-2">
                  <div className="text-xs text-[var(--gs-text-dim)] hidden sm:block">
                    {item.alertLabel ?? (session.attached ? 'attached' : formatTime(session.createdAt))}
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

          if (item.type === 'replay-section') {
            const arrow = item.expanded ? '▾' : '▸';
            return (
              <div
                key={`replay-section-${item.workspaceId}`}
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => { e.stopPropagation(); void activateIndex(index); }}
                onKeyDown={(e) => { if (!isActivateKey(e.key)) return; e.preventDefault(); e.stopPropagation(); void activateIndex(index); }}
                role="button"
                tabIndex={0}
                className={`pl-8 sm:pl-10 pr-4 py-2 cursor-pointer border-b border-[var(--gs-border)] flex items-center gap-2 min-h-[36px] ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)]'}`}
              >
                <span className="text-[var(--gs-text-dim)] text-xs">{arrow}</span>
                <span className="text-[var(--gs-text-muted)] text-xs font-medium">History</span>
                <span className="text-[var(--gs-text-dim)] text-xs">({item.count})</span>
              </div>
            );
          }

          if (item.type === 'orphaned-replay-section') {
            const arrow = item.expanded ? '▾' : '▸';
            return (
              <div
                key={`orphaned-replay-section-${item.projectName}`}
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => { e.stopPropagation(); void activateIndex(index); }}
                onKeyDown={(e) => { if (!isActivateKey(e.key)) return; e.preventDefault(); e.stopPropagation(); void activateIndex(index); }}
                role="button"
                tabIndex={0}
                className={`pl-8 sm:pl-10 pr-4 py-2 cursor-pointer border-b border-[var(--gs-border)] flex items-center gap-2 min-h-[36px] ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)]'}`}
              >
                <span className="text-[var(--gs-warning)] text-xs">{arrow}</span>
                <span className="text-[var(--gs-warning)] text-xs font-medium">Orphaned History</span>
                <span className="text-[var(--gs-text-dim)] text-xs">({item.count})</span>
              </div>
            );
          }

          if (item.type === 'replay') {
            const replay = item.replay;
            const tone = replay.status === 'crashed' ? 'text-[var(--gs-danger-hover)]' : 'text-[var(--gs-info-light)]';
            const dismissed = replay.dismissedAt ? ' opacity-50' : '';
            return (
              <div
                key={`replay-${replay.replayId}`}
                ref={isSelected ? selectedRowRef : null}
                onClick={(e) => { e.stopPropagation(); void activateIndex(index); }}
                onKeyDown={(e) => { if (!isActivateKey(e.key)) return; e.preventDefault(); e.stopPropagation(); void activateIndex(index); }}
                role="button"
                tabIndex={0}
                className={`pl-12 sm:pl-14 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] flex items-center justify-between min-h-[48px] gap-3${dismissed} ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}`}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`${tone} flex-shrink-0 text-xs`}>↺</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[var(--gs-text-muted)] truncate block text-sm">{replay.sessionName}</span>
                    <span className={`text-xs truncate block ${tone}`}>{replay.status === 'crashed' ? 'crashed' : 'replay'}</span>
                  </div>
                </div>
                <div className="text-xs text-[var(--gs-text-dim)] hidden sm:block shrink-0">
                  {formatTime(replay.endedAt ?? replay.startedAt)}
                </div>
              </div>
            );
          }

          if (item.type === 'process') {
            const statusIcon = item.status === 'running' ? '▶' : item.status === 'failed' ? '✗' : '■';
            const statusColor = item.status === 'running' ? 'text-[var(--gs-success)]' : item.status === 'failed' ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-text-muted)]';
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
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] flex items-center justify-between min-h-[52px] gap-3
                  ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                `}
              >
                <div className="flex items-center gap-3 min-w-0 flex-1">
                  <span className={`w-2.5 h-2.5 flex-shrink-0 ${statusColor}`}>{statusIcon}</span>
                  <div className="min-w-0 flex-1">
                    <span className="text-[var(--gs-text)] truncate block">{item.processName}#{item.instance}</span>
                    <span className="text-xs text-[var(--gs-text-muted)] truncate block">{item.subtitle ?? portInfo}</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                  <span className={`text-xs ${statusColor} hidden sm:inline`}>{item.alertLabel ?? item.status}</span>
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

          if (item.type === 'agents') {
            return (
              <div
                key={`agents-${item.workspaceId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                className={`
                  pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] min-h-[48px] flex items-center justify-between
                  ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                `}
              >
                <span className="text-[var(--gs-purple)]">{item.expanded ? '▾' : '▸'} ✦ Agent Sessions</span>
                <div className="flex items-center gap-1">
                  {(item.pendingPermissions ?? 0) > 0 && (
                    <span className="text-xs px-2 py-0.5 rounded bg-[var(--gs-warning)] text-[var(--gs-text-on-accent)] font-medium">
                      ⚡{item.pendingPermissions}
                    </span>
                  )}
                  {(item.count ?? 0) > 0 && (
                    <span className="text-xs px-2 py-1 rounded bg-[var(--gs-border)] text-[var(--gs-text)]">{item.count}</span>
                  )}
                </div>
              </div>
            );
          }

          if (item.type === 'agent-session') {
            const state = getAgentSessionDisplayState(item.session);
            const label = getAgentSessionDisplayLabel(item.session);
            const signal =
              state === 'needs-permission' ? `⚡ ${label}`
              : state === 'error' ? `! ${label}`
              : state === 'running' ? `● ${label}`
              : state === 'retrying' ? `↻ ${label}`
              : `◦ ${label}`;
            const signalColor =
              state === 'needs-permission' ? 'text-[var(--gs-warning-bright)]'
              : state === 'running' ? 'text-[var(--gs-running)]'
              : state === 'waiting' ? 'text-[var(--gs-info)]'
              : 'text-[var(--gs-text-muted)]';
            return (
              <div
                key={`agent-session-${item.workspaceId}-${item.session.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                className={`
                  pl-14 sm:pl-16 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] min-h-[48px] flex items-center justify-between
                  ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                `}
              >
                <div className="min-w-0 flex-1">
                  <div className="text-[var(--gs-purple)] truncate text-sm">❖ {item.session.title}</div>
                  <div className={`text-xs truncate ${signalColor}`}>
                    {signal}
                  </div>
                </div>
                {item.session.updatedAt && (
                  <div className="text-xs text-[var(--gs-text-dim)] ml-3 shrink-0 hidden sm:block">
                    {formatTime(new Date(item.session.updatedAt).getTime())}
                  </div>
                )}
              </div>
            );
          }

          if (item.type === 'new-agent-session') {
            return (
              <div
                key={`new-agent-${item.workspaceId}`}
                onClick={(e) => {
                  e.stopPropagation();
                  void activateIndex(index);
                }}
                className={`
                  pl-14 sm:pl-16 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] min-h-[48px] flex items-center
                  ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
                `}
              >
                <span className="text-[var(--gs-purple)] text-sm">+ New Agent Session</span>
              </div>
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
    <div className="bg-[var(--gs-bg-elevated)] px-4 py-3 flex items-center justify-between border-b border-[var(--gs-border)] min-h-[52px] gap-3">
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <button
          type="button"
          onClick={onBack}
          onKeyDown={stopButtonActivationPropagation}
          aria-label="Back"
          className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] active:text-[var(--gs-accent)] py-2 pr-2 -ml-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          ← <span className="hidden sm:inline ml-1">Back</span>
        </button>
        <div className="text-[var(--gs-text)] font-medium truncate">
          {machineName || 'Workspaces'}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0 flex-wrap justify-end">
        {onOpenInbox && (
          <button
            type="button"
            onClick={onOpenInbox}
            onKeyDown={stopButtonActivationPropagation}
            className="px-3 py-2 text-sm bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] rounded text-[var(--gs-text)] min-h-[44px] border border-[var(--gs-border)]"
          >
            Inbox
            {inboxUnreadCount > 0 && (
              <span className="ml-2 px-1.5 py-0.5 text-xs bg-[var(--gs-info)] rounded-full text-[var(--gs-text-on-accent)] font-medium">
                {inboxUnreadCount}
              </span>
            )}
          </button>
        )}
        {onHelp && (
          <button
            type="button"
            onClick={onHelp}
            onKeyDown={stopButtonActivationPropagation}
            aria-label="Help"
            className="px-3 py-2 text-sm bg-[var(--gs-btn-secondary-bg)] hover:bg-[var(--gs-border)] active:bg-[var(--gs-bg-elevated)] rounded text-[var(--gs-text)] min-h-[44px] border border-[var(--gs-border)]"
          >
            ? <span className="hidden sm:inline ml-1">Help</span>
          </button>
        )}
        {onCreate && (
          <button
            type="button"
            onClick={onCreate}
            onKeyDown={stopButtonActivationPropagation}
            aria-label="New workspace or project"
            className="px-3 py-2 text-sm bg-[var(--gs-accent)] hover:bg-[var(--gs-accent-hover)] active:bg-[var(--gs-accent-hover)] rounded text-[var(--gs-text-on-accent)] font-medium min-h-[44px] shadow-glow"
          >
            + <span className="hidden sm:inline ml-1">New</span>
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          onKeyDown={stopButtonActivationPropagation}
          className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] active:text-[var(--gs-accent)] py-2 pl-2 min-h-[44px] flex items-center flex-shrink-0"
        >
          Refresh
        </button>
        {onDisconnect && (
          <button
            type="button"
            onClick={onDisconnect}
            onKeyDown={stopButtonActivationPropagation}
            aria-label="Disconnect"
            className="px-3 py-2 text-sm bg-[var(--gs-danger)] hover:bg-[var(--gs-danger-hover)] active:bg-[var(--gs-danger-active)] rounded text-white min-h-[44px] border border-[var(--gs-danger)]"
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
    <div className="bg-[var(--gs-bg-elevated)] px-4 py-2 border-t border-[var(--gs-border)] safe-bottom">
      <div className="hidden sm:flex gap-4 text-xs text-[var(--gs-text-dim)] flex-wrap">
        {hint.desktop.map((item) => (
          <span key={item}>{item}</span>
        ))}
      </div>
      <div className="sm:hidden text-xs text-[var(--gs-text-dim)] text-center">
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

  if (selectedItem?.type === 'replay-section') {
    return {
      desktop: [selectedItem.expanded ? 'Enter Collapse' : 'Enter Expand', 'r Refresh', '? Help'],
      mobile: selectedItem.expanded ? 'Tap to collapse history' : 'Tap to expand history',
    };
  }

  if (selectedItem?.type === 'orphaned-replay-section') {
    return {
      desktop: [selectedItem.expanded ? 'Enter Collapse' : 'Enter Expand', 'h Hidden', 'r Refresh', '? Help'],
      mobile: selectedItem.expanded ? 'Tap to collapse orphaned history' : 'Tap to expand orphaned history',
    };
  }

  if (selectedItem?.type === 'replay') {
    return {
      desktop: ['Enter Open', 'd Dismiss', 'h Hidden', 'r Refresh', '? Help'],
      mobile: 'Tap to open replay • Press d to dismiss',
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
    ? 'bg-[var(--gs-chip-red-bg)] border-[var(--gs-danger)]/40 text-[var(--gs-danger-hover)] hover:bg-[var(--gs-chip-red-bg)]'
    : tone === 'success'
      ? 'bg-[var(--gs-chip-green-bg)] border-[var(--gs-accent)]/40 text-[var(--gs-success)] hover:bg-[var(--gs-chip-green-bg)]'
      : 'bg-[var(--gs-btn-secondary-bg)] border-[var(--gs-border)] text-[var(--gs-text-muted)] hover:bg-[var(--gs-border)] hover:text-[var(--gs-text)]';

  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onKeyDown={stopButtonActivationPropagation}
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
    ? 'text-[var(--gs-warning-bright)]'
    : tone === 'error'
      ? 'text-[var(--gs-danger)]'
      : tone === 'accent'
        ? 'text-[var(--gs-info)]'
        : tone === 'violet'
          ? 'text-[var(--gs-purple)]'
          : 'text-[var(--gs-text-muted)]';

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
        pl-10 sm:pl-12 pr-4 py-3 cursor-pointer border-b border-[var(--gs-border)] min-h-[48px] flex items-center
        ${isSelected ? 'bg-[var(--gs-bg-active)] border-l-4 border-l-[var(--gs-info)]' : 'hover:bg-[var(--gs-bg-elevated)] active:bg-[var(--gs-bg-active)]'}
      `}
      title={title}
    >
      <span className={textClass}>{label}</span>
    </div>
  );
}
