/** @jsxImportSource react */
/**
 * WorkspaceDetailPane - Web: full-screen workspace detail view.
 *
 * Layout matches the TUI WorkspaceDetailScreen:
 *   pill bar → header (with ← Board) → sidebar + main split
 *
 * Sidebar: AI Agents, Terminals, Services/Processes, System/Config
 * Main: terminal outlet (children) or empty state
 */

import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import type { WorkspaceDetailPaneProps } from './WorkspaceDetailPane.js';
import { getWorkspaceStripColor } from '../app/shared/workspace-detail/strip.js';
import { useWorkspaceDetailModel } from '../app/shared/workspace-detail/useWorkspaceDetailModel.js';
import { useTheme, THEMES } from '../lib/theme.web.js';

/* ─── Sidebar helpers ─────────────────────────────────────────────────────── */

const SIDEBAR_WIDTH_STORAGE_KEY = 'gssh:workspace-detail-sidebar-width';
const SIDEBAR_CLOSED_STORAGE_KEY = 'gssh:workspace-detail-sidebar-closed';
const DEFAULT_SIDEBAR_WIDTH = 240;
const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 420;

function readStoredSidebarWidth(): number {
  if (typeof window === 'undefined') return DEFAULT_SIDEBAR_WIDTH;
  try {
    const value = Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY));
    return Number.isFinite(value) ? Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, value)) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function readStoredSidebarClosed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_CLOSED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function SidebarSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)] font-medium">{title}</span>
        {extra}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function SidebarItem({
  dotColor,
  label,
  subtitle,
  rightLabel,
  onClick,
  active = false,
  highlight = false,
}: {
  dotColor?: string;
  label: string;
  subtitle?: string;
  rightLabel?: string;
  onClick?: () => void;
  active?: boolean;
  highlight?: boolean;
}) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={
        'w-full flex items-center gap-1.5 px-1.5 py-1 rounded text-xs text-left truncate transition-colors ' +
        (highlight
          ? 'bg-[var(--gs-highlight-bg)] text-[var(--gs-text)] ring-1 ring-[var(--gs-info)]/30'
          : active
            ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]'
            : 'text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]')
      }
    >
      {dotColor && <span className={dotColor} style={{ fontSize: '8px' }}>●</span>}
      <span className="truncate flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {subtitle && <span className="block truncate text-[10px] text-[var(--gs-text-dim)]">{subtitle}</span>}
      </span>
      {rightLabel && <span className="text-[10px] text-[var(--gs-text-ghost)] flex-shrink-0">{rightLabel}</span>}
    </Tag>
  );
}


function ThemeSwitcher() {
  const { theme, setTheme } = useTheme();
  const current = THEMES.find(t => t.id === theme);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative ml-auto flex-shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="px-2 py-0.5 text-[10px] rounded text-[var(--gs-text-dim)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
        title={`Theme: ${current?.label ?? theme}`}
      >
        ◐
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 py-1 min-w-[160px] bg-[var(--gs-bg-elevated)] border border-[var(--gs-border)] z-50" role="menu">
          {THEMES.map(t => (
            <button
              key={t.id}
              type="button"
              role="menuitem"
              onClick={() => {
                setTheme(t.id);
                setOpen(false);
              }}
              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--gs-bg-active)] ${t.id === theme ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-muted)]'}`}
            >
              {t.label}
              {t.group === 'light' ? ' ☀' : ''}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── SidebarContent — extracted for desktop sidebar + mobile bottom sheet ─── */

function SidebarContent(props: {
  detailModel: ReturnType<typeof useWorkspaceDetailModel>;
  workspace: WorkspaceDetailPaneWebProps['workspace'];
  workspaceSessions: ReturnType<typeof useWorkspaceDetailModel>['workspaceSessions'];
  attachedSessionId: string | null;
  attachedAgentSessionId: string | null;
  attachedSessionIds: readonly string[];
  attachedAgentSessionIds: readonly string[];
  onAttachSession: WorkspaceDetailPaneProps['onAttachSession'];
  onStopAgentTurn?: WorkspaceDetailPaneProps['onStopAgentTurn'];
  onCloseAgentSession?: WorkspaceDetailPaneProps['onCloseAgentSession'];
  onArchiveAgentSession?: WorkspaceDetailPaneProps['onArchiveAgentSession'];
  onRestoreAgentSession?: WorkspaceDetailPaneProps['onRestoreAgentSession'];
  onCreateAgentSession?: WorkspaceDetailPaneProps['onCreateAgentSession'];
  onStopProcess?: WorkspaceDetailPaneProps['onStopProcess'];
  onDeleteSession?: WorkspaceDetailPaneProps['onDeleteSession'];
  onDeleteWorkspace?: WorkspaceDetailPaneProps['onDeleteWorkspace'];
  onOpenGitHubPullRequest?: WorkspaceDetailPaneProps['onOpenGitHubPullRequest'];
  onOpenReview?: WorkspaceDetailPaneProps['onOpenReview'];
  onRequestStatusChange?: WorkspaceDetailPaneProps['onRequestStatusChange'];
  onOpenNotes?: WorkspaceDetailPaneProps['onOpenNotes'];
  onOpenEvents: WorkspaceDetailPaneProps['onOpenEvents'];
  agentSessionCount: number;
  pendingPermissions: number;
  pullRequest?: { url?: string };
  onDismiss?: () => void;
}) {
  const {
    detailModel, workspace, workspaceSessions, attachedSessionId, attachedAgentSessionId,
    attachedSessionIds, attachedAgentSessionIds,
    onAttachSession, onStopAgentTurn, onCloseAgentSession, onArchiveAgentSession, onRestoreAgentSession,
    onCreateAgentSession, onStopProcess, onDeleteSession, onDeleteWorkspace, onOpenGitHubPullRequest, onOpenReview,
    onRequestStatusChange, onOpenNotes, onOpenEvents, agentSessionCount, pendingPermissions, pullRequest, onDismiss,
  } = props;
  const {
    workspaceReplays, activeAgentSessions, archivedAgentSessions, showArchivedAgents, toggleArchivedAgents,
    agentRows, agentTodoPhases, sessionRows, visibleReplayRows, hasMoreReplayRows, seeAllReplayLabel,
    notesSummary, visibleRecentNoteRows, serviceRows, pmRows, footerActions,
    actions: detailActions,
  } = detailModel;
  const shellSessions = workspaceSessions.filter((s) => !s.processName);
  const attachedServiceSession = workspaceSessions.find((s) => s.id === attachedSessionId);
  const attachedServiceIdentity = attachedServiceSession?.processName
    ? { processName: attachedServiceSession.processName, instance: attachedServiceSession.processInstance ?? 1 }
    : null;

  /** Wrap sidebar actions: dismiss bottom sheet on mobile after action */
  const act = (fn: () => void) => { fn(); onDismiss?.(); };

  return (
    <>
      <div>
      {/* AI AGENTS */}
      <SidebarSection
        title="AI Agents"
        extra={<>
          {agentSessionCount > 0 && <span className="text-[10px] text-[var(--gs-text-ghost)]">{agentSessionCount}</span>}
          {pendingPermissions > 0 && <span className="text-[10px] text-[var(--gs-warning-bright)]">⚡{pendingPermissions}</span>}
        </>}
      >
        {activeAgentSessions.length === 0 ? (
          <div className="text-xs text-[var(--gs-text-ghost)] px-1.5">No agents</div>
        ) : (
          agentRows.filter((row) => row.bucket === 'active').map((row) => {
            const agentState = row.state;
            const dotColor =
              agentState === 'needs-permission' ? 'text-[var(--gs-warning-bright)]'
              : agentState === 'running' ? 'text-[var(--gs-running)]'
              : agentState === 'waiting' ? 'text-[var(--gs-info)]'
              : agentState === 'retrying' || agentState === 'error' ? 'text-[var(--gs-danger)]'
              : 'text-[var(--gs-text-ghost)]';
            return (
              <div key={row.id} className="flex items-center gap-1">
                <SidebarItem
                  dotColor={dotColor}
                  label={row.title}
                  subtitle={row.modelLabel}
                  rightLabel={row.lastActiveLabel ?? undefined}
                  active={attachedAgentSessionIds.includes(row.id) || row.id === attachedAgentSessionId}
                  onClick={() => act(() => void detailActions.openAgentSession(row.id))}
                />
                {onStopAgentTurn && agentState === 'running' && (
                  <button type="button" onClick={() => void detailActions.stopAgentTurn(row.id)} className="text-[10px] text-[var(--gs-danger-hover)] hover:text-[var(--gs-danger-hover)] flex-shrink-0 px-1">✕</button>
                )}
                {onCloseAgentSession && agentState !== 'running' && (
                  <button type="button" onClick={() => void detailActions.closeAgentSession(row.id)} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)] flex-shrink-0 px-1">×</button>
                )}
              </div>
            );
          })
        )}
        {agentRows.filter((row) => row.bucket === 'closed').map((row) => (
          <div key={`closed:${row.id}`} className="flex items-center gap-1">
            <SidebarItem dotColor="text-[var(--gs-text-ghost)]" label={row.title} rightLabel="closed" onClick={() => act(() => void detailActions.openAgentSession(row.id))} />
            {onArchiveAgentSession && (
              <button type="button" onClick={() => void detailActions.archiveAgentSession(row.id)} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)] flex-shrink-0 px-1">arc</button>
            )}
          </div>
        ))}
        {archivedAgentSessions.length > 0 && (
          <>
            <SidebarItem label={`Archived agent sessions (${archivedAgentSessions.length})`} rightLabel={showArchivedAgents ? 'hide' : 'show'} onClick={toggleArchivedAgents} />
            {showArchivedAgents && agentRows.filter((row) => row.bucket === 'archived').map((row) => (
              <div key={`archived:${row.id}`} className="flex items-center gap-1">
                <SidebarItem dotColor="text-[var(--gs-text-ghost)]" label={row.title} rightLabel="archived" />
                {onRestoreAgentSession && (
                  <button type="button" onClick={() => void detailActions.restoreAgentSession(row.id)} className="text-[10px] text-[var(--gs-success)] hover:text-[var(--gs-accent)] flex-shrink-0 px-1">res</button>
                )}
              </div>
            ))}
          </>
        )}
        {onCreateAgentSession && (
          <SidebarItem label="+ New agent session" onClick={() => act(() => void detailActions.createAgentSession())} />
        )}
      </SidebarSection>

      {/* AGENT TASKS */}
      {agentTodoPhases && agentTodoPhases.length > 0 && (
        <SidebarSection title="Agent Tasks" extra={<span className="text-[10px] text-[var(--gs-text-ghost)]">{agentTodoPhases.reduce((n, p) => n + p.tasks.filter(t => t.status === 'completed').length, 0)}/{agentTodoPhases.reduce((n, p) => n + p.tasks.length, 0)} done</span>}>
          {agentTodoPhases.map((phase) => (
            <div key={phase.name} className="mb-1">
              <div className="text-[10px] text-[var(--gs-text-muted)] uppercase tracking-wide px-1.5 mb-0.5">{phase.name}</div>
              {phase.tasks.map((task, i) => {
                const dotColor = task.status === 'completed' ? 'text-[var(--gs-success)]' : task.status === 'in_progress' ? 'text-[var(--gs-info)]' : task.status === 'abandoned' ? 'text-[var(--gs-text-ghost)]' : 'text-[var(--gs-text-muted)]';
                return <SidebarItem key={`${phase.name}-${i}`} dotColor={dotColor} label={task.content} rightLabel={task.status === 'in_progress' ? '...' : undefined} />;
              })}
            </div>
          ))}
        </SidebarSection>
      )}

      {/* TERMINALS */}
      <SidebarSection title="Terminals">
        {shellSessions.length === 0 ? (
          <div className="text-xs text-[var(--gs-text-ghost)] px-1.5">No sessions</div>
        ) : (
          sessionRows.map((row) => {
            const s = workspaceSessions.find((session) => session.id === row.id)!;
            if (s.processName) return null;
            const isOpen = attachedSessionIds.includes(row.id) || attachedSessionId === row.id;
            return (
              <div key={row.id} className="flex items-center gap-1">
                <SidebarItem
                  dotColor={isOpen ? 'text-[var(--gs-success)]' : row.attached ? 'text-[var(--gs-warning-bright)]' : 'text-[var(--gs-running)]'}
                  label={row.label} subtitle={row.subtitle} rightLabel={row.alertLabel ?? row.statusLabel}
                  highlight={isOpen} active={row.attached && !isOpen}
                  onClick={() => act(() => void detailActions.attachSession(row.id))}
                />
                {onDeleteSession && (
                  <button type="button" onClick={() => detailActions.deleteSession(s.id, s.name)} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-danger-hover)] flex-shrink-0 px-1">×</button>
                )}
              </div>
            );
          })
        )}
        <SidebarItem label="+ New session" onClick={() => act(() => void detailActions.createSession())} />
      </SidebarSection>

      {/* SERVICES */}
      {serviceRows.length > 0 && (
        <SidebarSection title="Services">
          {serviceRows.map((service) => {
            const localUrl = service.localUrl;
            const isOpen = attachedServiceIdentity?.processName === service.processName && attachedServiceIdentity.instance === service.instance;
            return (
              <div key={service.key}>
                <div className="flex items-center gap-1">
                  <SidebarItem
                    dotColor={isOpen ? 'text-[var(--gs-success)]' : service.state === 'running' ? 'text-[var(--gs-running)]' : 'text-[var(--gs-text-ghost)]'}
                    label={service.label} subtitle={service.subtitle ?? localUrl}
                    rightLabel={service.state === 'disabled' ? undefined : (service.alertLabel ?? service.state)}
                    highlight={isOpen}
                    onClick={service.state === 'disabled' ? undefined : () => act(() => void detailActions.activateService(service.processName, service.instance, service.state))}
                  />
                  {service.state === 'running' && service.attachableSessionId && (
                    <button type="button" onClick={() => onAttachSession({ sessionId: service.attachableSessionId, viewOnly: true })} className="text-[10px] text-[var(--gs-info)] hover:text-[var(--gs-info-light)] flex-shrink-0 px-1">att</button>
                  )}
                  {service.state === 'running' && localUrl && (() => {
                    const targetUrl = service.hostedUrl ?? `http://${localUrl}`;
                    return <button type="button" onClick={() => window.open(targetUrl, '_blank', 'noopener,noreferrer')} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-info)] flex-shrink-0 px-1">↗</button>;
                  })()}
                  {service.state === 'running' && onStopProcess && (
                    <button type="button" onClick={() => onStopProcess({ workspaceId: workspace.id, processName: service.processName })} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-danger-hover)] flex-shrink-0 px-1">stop</button>
                  )}
                </div>
                {service.state === 'running' && localUrl && (
                  <div className="pl-5 text-[10px] text-[var(--gs-text-ghost)] truncate">
                    {service.hostedUrl ? <a href={service.hostedUrl} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--gs-info)] transition-colors">{service.hostedUrl.replace(/^http:\/\//, '')}</a> : localUrl ? <span>{localUrl}</span> : null}
                  </div>
                )}
              </div>
            );
          })}
        </SidebarSection>
      )}

      {/* REPLAYS */}
      {workspaceReplays.length > 0 && (
        <SidebarSection title="Replays">
          {visibleReplayRows.map((replay) => (
            <SidebarItem key={replay.replayId} dotColor={replay.tone === 'red' ? 'text-[var(--gs-danger-hover)]' : 'text-[var(--gs-success)]'} label={replay.label} onClick={() => act(() => void detailActions.openReplay(replay.replayId))} />
          ))}
          {hasMoreReplayRows && seeAllReplayLabel && (
            <SidebarItem label={seeAllReplayLabel} rightLabel="/" onClick={() => act(() => void detailActions.openReplayHistory())} />
          )}
        </SidebarSection>
      )}

      {/* NOTES */}
      {(notesSummary?.total ?? 0) > 0 && (
        <SidebarSection title="Notes" extra={<span className="text-[10px] text-[var(--gs-text-ghost)]">{notesSummary?.total ?? 0} note{(notesSummary?.total ?? 0) === 1 ? '' : 's'}</span>}>
          {visibleRecentNoteRows.map((note) => (
            <SidebarItem key={note.id} dotColor="text-[var(--gs-text-ghost)]" label={note.label} rightLabel="note" />
          ))}
        </SidebarSection>
      )}

      {/* PM LINKS */}
      {pmRows.length > 0 && (
        <SidebarSection title="PM Links">
          {pmRows.map((row) => (
            <SidebarItem key={row.id} dotColor={row.tone === 'red' ? 'text-[var(--gs-danger-hover)]' : row.tone === 'green' ? 'text-[var(--gs-success)]' : row.tone === 'blue' ? 'text-[var(--gs-info)]' : 'text-[var(--gs-text-ghost)]'} label={row.label} rightLabel={row.detail} onClick={row.actionable && row.section === 'pull-request' && onOpenGitHubPullRequest ? () => void detailActions.footerAction('open-github-pr') : undefined} />
          ))}
        </SidebarSection>
      )}

      {/* SYSTEM */}
      <SidebarSection title="System">
        <SidebarItem label="Event Logs" dotColor="text-[var(--gs-running)]" rightLabel="live" onClick={() => act(() => onOpenEvents(workspace.id))} />
      </SidebarSection>
      </div>

      <div className="mt-auto pt-3 border-t border-[var(--gs-border-muted)] space-y-0.5">
        {pendingPermissions > 0 && (
          <div className="px-1.5 text-[11px] text-[var(--gs-warning-bright)]">⚡ {pendingPermissions} pending permission{pendingPermissions !== 1 ? 's' : ''}</div>
        )}
        {footerActions.map((action) => {
          if (action.id === 'open-github-pr' && (!onOpenGitHubPullRequest || !pullRequest?.url)) return null;
          if (action.id === 'open-review' && !onOpenReview) return null;
          if (action.id === 'change-status' && !onRequestStatusChange) return null;
          const onClick = () => void detailActions.footerAction(action.id);
          return <SidebarItem key={action.id} label={action.label} rightLabel={action.rightLabel} onClick={onClick} />;
        })}
        <SidebarItem label="Notes" rightLabel={notesSummary?.total ? `${notesSummary.total}` : 'open'} onClick={() => act(() => onOpenNotes?.(workspace.id))} />
        {onDeleteWorkspace && (
          <SidebarItem label="Delete Workspace" rightLabel="danger" onClick={() => onDeleteWorkspace(workspace)} />
        )}
      </div>
    </>
  );
}

/* ─── Main component ──────────────────────────────────────────────────────── */
export interface WorkspaceDetailPaneWebProps extends WorkspaceDetailPaneProps {
  /** Terminal outlet rendered in the main area when a session/agent is attached. */
  children?: ReactNode;
  /** Layout-owned footer rendered below the sidebar/main split. */
  bottomContent?: ReactNode;
}

export function WorkspaceDetailPaneWeb(props: WorkspaceDetailPaneWebProps) {
  const {
    workspace,
    sessions,
    replays,
    agentSessions = [],
    agentSessionCount = 0,
    pendingPermissions = 0,
    onAttachSession,
    onOpenReplay,
    onOpenReplayHistory,
    onStartProcessAttach,
    onStopProcess,
    onEditProcesses,
    onManageBundleConfig,
    onOpenReview,
    onOpenGitHubPullRequest,
    onRequestStatusChange,
    onOpenNotes,
    onOpenEvents,
    onOpenAgentSession,
    onCreateAgentSession,
    onKillAgentSession,
    onStopAgentTurn,
    onCloseAgentSession,
    onArchiveAgentSession,
    onRestoreAgentSession,
    onDeleteSession,
    onDeleteWorkspace,
    allWorkspaces = [],
    workspaceStatusById = {},
    attachedSessionId = null,
    attachedAgentSessionId = null,
    attachedSessionIds = attachedSessionId ? [attachedSessionId] : [],
    attachedAgentSessionIds = attachedAgentSessionId ? [attachedAgentSessionId] : [],
    onSelectWorkspace,
    onClose,
    children,
    bottomContent,
    pendingAgentAttach = false,
  } = props;

  const [showMobileSidebar, setShowMobileSidebar] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(readStoredSidebarWidth);
  const [sidebarClosed, setSidebarClosed] = useState(readStoredSidebarClosed);

  const detailModel = useWorkspaceDetailModel({
    workspace,
    sessions,
    replays,
    agentSessions,
    allWorkspaces,
    workspaceStatusById,
    actions: {
      onSelectWorkspace,
      onAttachSession,
      onOpenReplay,
      onOpenReplayHistory,
      onStartProcessAttach,
      onStopProcess,
      onManageBundleConfig,
      onEditProcesses,
      onOpenReview,
      onOpenGitHubPullRequest,
      onRequestStatusChange,
      onOpenAgentSession,
      onCreateAgentSession,
      onKillAgentSession,
      onStopAgentTurn,
      onCloseAgentSession,
      onArchiveAgentSession,
      onRestoreAgentSession,
      onDeleteSession,
    },
  });
  const {
    phase,
    phaseLabel,
    workspaceSessions,
    workspaceReplays,
    visibleStripWorkspaces,
    stripDisplayItems,
    actions: detailActions,
  } = detailModel;
  const pullRequest = workspace.pullRequest;

  const handleSidebarResizeStart = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const initialClientX = event.clientX;
    const initialWidth = sidebarWidth;

    const handleMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - initialClientX;
      const next = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, initialWidth + delta));
      setSidebarWidth(next);
    };

    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch { /* ignore unavailable storage */ }
  }, [sidebarWidth]);

  const setDesktopSidebarClosed = useCallback((closed: boolean) => {
    setSidebarClosed(closed);
    try {
      window.localStorage.setItem(SIDEBAR_CLOSED_STORAGE_KEY, closed ? '1' : '0');
    } catch { /* ignore unavailable storage */ }
  }, []);

  return (
    <div className="h-full flex flex-col bg-[var(--gs-bg)] overflow-hidden">
      {/* ── Workspace pill strip ── */}
      {visibleStripWorkspaces.length > 0 && (
        <div className="flex-shrink-0 flex items-center gap-0 overflow-x-auto border-b border-[var(--gs-border-muted)] bg-[var(--gs-bg)] px-1 py-0.5 scrollbar-none">
          {stripDisplayItems.map((di, idx) => {
            if (di.type === 'project-label') {
              return (
                <span
                  key={`label-${di.tier}-${di.projectName}`}
                  className={
                    'px-2 text-xs text-[var(--gs-text-ghost)] flex-shrink-0 select-none whitespace-nowrap' +
                    (idx === 0 ? '' : ' ml-1')
                  }
                >
                  {di.projectName}:
                </span>
              );
            }
            const w = di.workspace;
            const isCurrent = w.id === workspace.id;
            const primaryColor = getWorkspaceStripColor(w, workspaceStatusById);
            const dotColorClass =
              primaryColor === 'orange' ? 'text-[var(--gs-warning-bright)]' :
              primaryColor === 'red'    ? 'text-[var(--gs-danger-hover)]' :
              primaryColor === 'green'  ? 'text-[var(--gs-accent)]' :
              primaryColor === 'blue'   ? 'text-[var(--gs-info)]' :
              'text-[var(--gs-text-ghost)]';
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => detailActions.selectWorkspace(w.selectionKey ?? w.id)}
                className={
                  'flex items-center gap-1 px-2 py-1 rounded text-xs flex-shrink-0 transition-colors ' +
                  (isCurrent
                    ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)]'
                    : 'text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-elevated)]')
                }
                title={`${w.name} (${w.projectName})`}
              >
                <span className={dotColorClass}>●</span>
                <span>{w.name}</span>
                {getWorkspaceStripColor(w, workspaceStatusById) === 'orange' && (
                  <span className="text-[var(--gs-warning-bright)]">⚡</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] flex-shrink-0 py-1 pr-2 min-h-[36px] flex items-center"
        >
          ← <span className="hidden sm:inline ml-1">Board</span>
        </button>
        <span className="hidden sm:inline text-[var(--gs-border)]">|</span>
        <div className="min-w-0 flex-1 truncate">
          <span className="font-medium text-[var(--gs-text)] truncate">{workspace.name}</span>
          <span className="hidden sm:inline ml-2 text-xs text-[var(--gs-text-muted)]">
            {phase && <span className="px-1.5 py-0.5 bg-[var(--gs-bg-active)] text-[var(--gs-info-light)] mr-2">{phaseLabel}</span>}
            {workspaceSessions.length} session(s) · {workspaceReplays.length} replay(s)
          </span>
        </div>
        <button
          type="button"
          onClick={() => setShowMobileSidebar(true)}
          className="sm:hidden px-2 py-1 text-xs text-[var(--gs-text-dim)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
          title="Open sidebar"
        >
          ☰
        </button>
        <ThemeSwitcher />
      </div>

      {/* ── Sidebar + Main ── */}
      <div className="flex-1 flex min-h-0 relative">
        {/* Desktop sidebar (≥640px) */}
        {!sidebarClosed ? (
          <>
            <div
              className="hidden sm:flex flex-shrink-0 bg-[var(--gs-sidebar-bg)] overflow-y-auto px-2 py-3 flex-col"
              style={{ width: sidebarWidth }}
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[10px] uppercase tracking-wider text-[var(--gs-text-ghost)] font-medium">Workspace Panel</span>
                <button
                  type="button"
                  onClick={() => setDesktopSidebarClosed(true)}
                  className="rounded px-1.5 py-0.5 text-xs text-[var(--gs-text-dim)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]"
                  title="Close workspace panel"
                >
                  ×
                </button>
              </div>
              <SidebarContent
                detailModel={detailModel}
                workspace={workspace}
                workspaceSessions={workspaceSessions}
                attachedSessionId={attachedSessionId}
                attachedAgentSessionId={attachedAgentSessionId}
                attachedSessionIds={attachedSessionIds}
                attachedAgentSessionIds={attachedAgentSessionIds}
                onAttachSession={onAttachSession}
                onStopAgentTurn={onStopAgentTurn}
                onCloseAgentSession={onCloseAgentSession}
                onArchiveAgentSession={onArchiveAgentSession}
                onRestoreAgentSession={onRestoreAgentSession}
                onCreateAgentSession={onCreateAgentSession}
                onStopProcess={onStopProcess}
                onDeleteSession={onDeleteSession}
                onDeleteWorkspace={onDeleteWorkspace}
                onOpenGitHubPullRequest={onOpenGitHubPullRequest}
                onOpenReview={onOpenReview}
                onRequestStatusChange={onRequestStatusChange}
                onOpenNotes={onOpenNotes}
                onOpenEvents={onOpenEvents}
                agentSessionCount={agentSessionCount}
                pendingPermissions={pendingPermissions}
                pullRequest={pullRequest}
              />
            </div>
            <div
              className="hidden sm:block w-1.5 flex-shrink-0 cursor-col-resize border-l border-r border-[var(--gs-border-muted)] bg-[var(--gs-bg)] hover:bg-[var(--gs-bg-active)]"
              onMouseDown={handleSidebarResizeStart}
              title="Resize workspace panel"
            />
          </>
        ) : (
          <div className="hidden sm:flex w-10 flex-shrink-0 items-start justify-center border-r border-[var(--gs-border-muted)] bg-[var(--gs-sidebar-bg)] py-3">
            <button
              type="button"
              onClick={() => setDesktopSidebarClosed(false)}
              className="rounded px-2 py-1 text-xs text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-active)] hover:text-[var(--gs-text)]"
              title="Open workspace panel"
            >
              ☰
            </button>
          </div>
        )}

        {/* Main area: terminal outlet */}
        <div className="flex-1 flex flex-col min-w-0">
          <div className="flex-1 min-h-0 flex flex-col">
            {children ? (
              children
            ) : (
              <div className="flex-1 flex items-center justify-center">
                {pendingAgentAttach ? (
                  <div className="text-center">
                    <div className="text-sm text-[var(--gs-text-muted)] animate-pulse">Attaching agent session…</div>
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="text-sm text-[var(--gs-text-ghost)]">No active session</div>
                    <div className="text-xs text-[var(--gs-border)] mt-1">Attach a session or agent from the <span className="hidden sm:inline">sidebar</span><span className="sm:hidden">☰ menu</span>.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      {bottomContent}

      {/* Mobile bottom sheet sidebar */}
        {showMobileSidebar && (
          <div className="sm:hidden fixed inset-0 z-50 flex flex-col">
            {/* Backdrop */}
            <div
              className="flex-shrink-0"
              style={{ height: '20%' }}
              onClick={() => setShowMobileSidebar(false)}
            />
            {/* Sheet */}
            <div className="flex-1 bg-[var(--gs-sidebar-bg)] border-t border-[var(--gs-border)] overflow-y-auto flex flex-col">
              {/* Handle + close */}
              <div className="flex-shrink-0 flex items-center justify-between px-4 py-3 border-b border-[var(--gs-border-muted)]">
                <span className="text-xs text-[var(--gs-text-dim)] tracking-[2px] uppercase">Sidebar</span>
                <button
                  type="button"
                  onClick={() => setShowMobileSidebar(false)}
                  className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] px-2 py-1"
                >
                  ✕
                </button>
              </div>
              {/* Sidebar content */}
              <div className="flex-1 overflow-y-auto px-2 py-3">
                <SidebarContent
                  detailModel={detailModel}
                  workspace={workspace}
                  workspaceSessions={workspaceSessions}
                  attachedSessionId={attachedSessionId}
                  attachedAgentSessionId={attachedAgentSessionId}
                  attachedSessionIds={attachedSessionIds}
                  attachedAgentSessionIds={attachedAgentSessionIds}
                  onAttachSession={onAttachSession}
                  onStopAgentTurn={onStopAgentTurn}
                  onCloseAgentSession={onCloseAgentSession}
                  onArchiveAgentSession={onArchiveAgentSession}
                  onRestoreAgentSession={onRestoreAgentSession}
                  onCreateAgentSession={onCreateAgentSession}
                  onStopProcess={onStopProcess}
            onDeleteSession={onDeleteSession}
            onDeleteWorkspace={onDeleteWorkspace}
                  onOpenGitHubPullRequest={onOpenGitHubPullRequest}
                  onOpenReview={onOpenReview}
                  onRequestStatusChange={onRequestStatusChange}
                  onOpenNotes={onOpenNotes}
                  onOpenEvents={onOpenEvents}
                  agentSessionCount={agentSessionCount}
                  pendingPermissions={pendingPermissions}
                  pullRequest={pullRequest}
                  onDismiss={() => setShowMobileSidebar(false)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
  );
}
