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

import type { ReactNode } from 'react';
import type { WorkspaceDetailPaneProps } from './WorkspaceDetailPane.js';
import { getWorkspaceStripColor } from '../app/shared/workspace-detail/strip.js';
import { useWorkspaceDetailModel } from '../app/shared/workspace-detail/useWorkspaceDetailModel.js';
import { useTheme, THEMES } from '../lib/theme.web.js';

/* ─── Sidebar helpers ─────────────────────────────────────────────────────── */

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
  return (
    <div className="relative group ml-auto flex-shrink-0">
      <button
        type="button"
        className="px-2 py-0.5 text-[10px] rounded text-[var(--gs-text-dim)] hover:text-[var(--gs-text)] hover:bg-[var(--gs-bg-active)]"
        title={`Theme: ${current?.label ?? theme}`}
      >
        ◐
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

/* ─── Main component ──────────────────────────────────────────────────────── */

export interface WorkspaceDetailPaneWebProps extends WorkspaceDetailPaneProps {
  /** Terminal outlet rendered in the main area when a session/agent is attached. */
  children?: ReactNode;
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
    onOpenEvents,
    onOpenAgentSession,
    onCreateAgentSession,
    onAbortAgentSession,
    onCloseAgentSession,
    onArchiveAgentSession,
    onRestoreAgentSession,
    onDeleteSession,
    allWorkspaces = [],
    workspaceStatusById = {},
    attachedSessionId = null,
    attachedAgentSessionId = null,
    onSelectWorkspace,
    onClose,
    children,
    pendingAgentAttach = false,
  } = props;


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
      onAbortAgentSession,
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
    activeAgentSessions,
    archivedAgentSessions,
    showArchivedAgents,
    toggleArchivedAgents,
    agentRows,
    agentTodoPhases,
    sessionRows,
    visibleReplayRows,
    hasMoreReplayRows,
    seeAllReplayLabel,
    notesSummary,
    visibleTodoRows,
    visibleRecentNoteRows,
    serviceRows,
    pmRows,
    footerActions,
    actions: detailActions,
  } = detailModel;
  const pullRequest = workspace.pullRequest;
  const shellSessions = workspaceSessions.filter((session) => !session.processName);
  const attachedWorkspaceSession = workspaceSessions.find((session) => session.id === attachedSessionId) ?? null;
  const attachedServiceIdentity = attachedWorkspaceSession?.processName
    ? {
        processName: attachedWorkspaceSession.processName,
        instance: attachedWorkspaceSession.processInstance ?? 1,
      }
    : null;

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
                onClick={() => detailActions.selectWorkspace(w.id)}
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
          className="text-sm text-[var(--gs-text-muted)] hover:text-[var(--gs-text)] flex-shrink-0"
        >
          ← Board
        </button>
        <span className="text-[var(--gs-border)]">|</span>
        <div className="min-w-0 flex-1">
          <span className="font-medium text-[var(--gs-text)] truncate">{workspace.name}</span>
          <span className="ml-2 text-xs text-[var(--gs-text-muted)]">
            {phase && <span className="px-1.5 py-0.5 bg-[var(--gs-bg-active)] text-[var(--gs-info-light)] mr-2">{phaseLabel}</span>}
            {workspaceSessions.length} session(s) · {workspaceReplays.length} replay(s)
          </span>
        </div>
        <ThemeSwitcher />
      </div>

      {/* ── Sidebar + Main ── */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <div className="w-[240px] flex-shrink-0 border-r border-[var(--gs-border-muted)] bg-[var(--gs-sidebar-bg)] overflow-y-auto px-2 py-3 flex flex-col">
          <div>
          {/* AI AGENTS */}
          <SidebarSection
            title="AI Agents"
            extra={
              <>
                {agentSessionCount > 0 && <span className="text-[10px] text-[var(--gs-text-ghost)]">{agentSessionCount}</span>}
                {pendingPermissions > 0 && <span className="text-[10px] text-[var(--gs-warning-bright)]">⚡{pendingPermissions}</span>}
              </>
            }
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
                      active={row.id === attachedAgentSessionId}
                      onClick={() => {
                        void detailActions.openAgentSession(row.id);
                      }}
                    />
                    {onAbortAgentSession && agentState === 'running' && (
                      <button type="button" onClick={() => void detailActions.abortAgentSession(row.id)} className="text-[10px] text-[var(--gs-danger-hover)] hover:text-[var(--gs-danger-hover)] flex-shrink-0 px-1">✕</button>
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
                <SidebarItem
                  dotColor="text-[var(--gs-text-ghost)]"
                  label={row.title}
                  rightLabel="closed"
                  onClick={() => {
                    void detailActions.openAgentSession(row.id);
                  }}
                />
                {onArchiveAgentSession && (
                  <button type="button" onClick={() => void detailActions.archiveAgentSession(row.id)} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)] flex-shrink-0 px-1">arc</button>
                )}
              </div>
            ))}
            {archivedAgentSessions.length > 0 && (
              <>
                <SidebarItem
                  label={`Archived agent sessions (${archivedAgentSessions.length})`}
                  rightLabel={showArchivedAgents ? 'hide' : 'show'}
                  onClick={toggleArchivedAgents}
                />
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
              <SidebarItem
                label="+ New agent session"
                onClick={() => void detailActions.createAgentSession()}
              />
            )}
          </SidebarSection>

          {/* AGENT TASKS — from in-process SDK todo state */}
          {agentTodoPhases && agentTodoPhases.length > 0 && (
            <SidebarSection
              title="Agent Tasks"
              extra={
                <span className="text-[10px] text-[var(--gs-text-ghost)]">
                  {agentTodoPhases.reduce((n, p) => n + p.tasks.filter(t => t.status === 'completed').length, 0)}/
                  {agentTodoPhases.reduce((n, p) => n + p.tasks.length, 0)} done
                </span>
              }
            >
              {agentTodoPhases.map((phase) => (
                <div key={phase.name} className="mb-1">
                  <div className="text-[10px] text-[var(--gs-text-muted)] uppercase tracking-wide px-1.5 mb-0.5">{phase.name}</div>
                  {phase.tasks.map((task, i) => {
                    const dotColor =
                      task.status === 'completed' ? 'text-[var(--gs-success)]'
                      : task.status === 'in_progress' ? 'text-[var(--gs-info)]'
                      : task.status === 'abandoned' ? 'text-[var(--gs-text-ghost)]'
                      : 'text-[var(--gs-text-muted)]';
                    return (
                      <SidebarItem
                        key={`${phase.name}-${i}`}
                        dotColor={dotColor}
                        label={task.content}
                        rightLabel={task.status === 'in_progress' ? '...' : undefined}
                      />
                    );
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
                if (s.processName) {
                  return null;
                }
                const isOpen = attachedSessionId === row.id;
                return (
                  <div key={row.id} className="flex items-center gap-1">
                    <SidebarItem
                      dotColor={isOpen ? 'text-[var(--gs-success)]' : row.attached ? 'text-[var(--gs-warning-bright)]' : 'text-[var(--gs-running)]'}
                      label={row.label}
                      subtitle={row.subtitle}
                      rightLabel={row.alertLabel ?? row.statusLabel}
                      highlight={isOpen}
                      active={row.attached && !isOpen}
                      onClick={() => {
                        void detailActions.attachSession(row.id);
                      }}
                    />
                    {onDeleteSession && (
                      <button type="button" onClick={() => detailActions.deleteSession(s.id, s.name)} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-danger-hover)] flex-shrink-0 px-1">×</button>
                    )}
                  </div>
                );
              })
            )}
            <SidebarItem
              label="+ New session"
              onClick={() => void detailActions.createSession()}
            />
          </SidebarSection>

          {/* SERVICES / PROCESSES */}
          {/* TODO: Catch web up to the TUI service launcher once this pane shares the same explicit service selection + keyboard model. */}
          {serviceRows.length > 0 && (
            <SidebarSection title="Services">
              {serviceRows.map((service) => {
                  const localUrl = service.localUrl;
                  const isOpen = attachedServiceIdentity?.processName === service.processName
                    && attachedServiceIdentity.instance === service.instance;
                  return (
                    <div key={service.key}>
                      <div className="flex items-center gap-1">
                        <SidebarItem
                          dotColor={isOpen ? 'text-[var(--gs-success)]' : service.state === 'running' ? 'text-[var(--gs-running)]' : 'text-[var(--gs-text-ghost)]'}
                          label={service.label}
                          subtitle={service.subtitle ?? localUrl}
                          rightLabel={service.state === 'disabled' ? undefined : (service.alertLabel ?? service.state)}
                          highlight={isOpen}
                          onClick={service.state === 'disabled'
                            ? undefined
                            : service.state === 'running'
                              ? () => void detailActions.activateService(service.processName, service.instance, service.state)
                              : () => void detailActions.activateService(service.processName, service.instance, service.state)
                          }
                        />
                        {service.state === 'running' && service.attachableSessionId && (
                          <button
                            type="button"
                            onClick={() => onAttachSession({ sessionId: service.attachableSessionId, viewOnly: true })}
                            className="text-[10px] text-[var(--gs-info)] hover:text-[var(--gs-info-light)] flex-shrink-0 px-1"
                            title="Attach service terminal"
                          >
                            att
                          </button>
                        )}
                        {service.state === 'running' && localUrl && (() => {
                          const targetUrl = service.hostedUrl ?? `http://${localUrl}`;
                          return (
                            <button
                              type="button"
                              onClick={() => window.open(targetUrl, '_blank', 'noopener,noreferrer')}
                              className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-info)] flex-shrink-0 px-1"
                              title={`Open ${targetUrl}` }
                            >
                              ↗
                            </button>
                          );
                        })()}
                        {service.state === 'running' && onStopProcess && (
                          <button
                            type="button"
                            onClick={() => onStopProcess({ workspaceId: workspace.id, processName: service.processName })}
                            className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-danger-hover)] flex-shrink-0 px-1"
                            title="Stop service"
                          >
                            stop
                          </button>
                        )}
                      </div>
                      {service.state === 'running' && localUrl && (
                        <div className="pl-5 text-[10px] text-[var(--gs-text-ghost)] truncate">
                          {service.hostedUrl
                            ? <a href={service.hostedUrl} target="_blank" rel="noopener noreferrer" className="hover:text-[var(--gs-info)] transition-colors">{service.hostedUrl.replace(/^http:\/\//, '')}</a>
                            : localUrl ? <span>{localUrl}</span> : null
                          }
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
              {visibleReplayRows.map((replay) => {
                const tone = replay.tone === 'red' ? 'text-[var(--gs-danger-hover)]' : 'text-[var(--gs-success)]';
                return (
                  <SidebarItem
                    key={replay.replayId}
                    dotColor={tone}
                    label={replay.label}
                    onClick={() => {
                      void detailActions.openReplay(replay.replayId);
                    }}
                  />
                );
              })}
              {hasMoreReplayRows && seeAllReplayLabel && (
                <SidebarItem
                  label={seeAllReplayLabel}
                  rightLabel="/"
                  onClick={() => {
                    void detailActions.openReplayHistory();
                  }}
                />
              )}
            </SidebarSection>
          )}

          {(notesSummary?.total ?? 0) > 0 && (
            <SidebarSection
              title="Notes"
              extra={<span className="text-[10px] text-[var(--gs-text-ghost)]">{notesSummary?.openTodoCount ?? 0} todo</span>}
            >
              {visibleTodoRows.map((note) => (
                <SidebarItem
                  key={note.id}
                  dotColor={note.priority === 'high' ? 'text-[var(--gs-danger-hover)]' : note.priority === 'medium' ? 'text-[var(--gs-warning-bright)]' : 'text-[var(--gs-info)]'}
                  label={note.label}
                  rightLabel={note.priority}
                />
              ))}
              {visibleRecentNoteRows.map((note) => (
                <SidebarItem
                  key={note.id}
                  dotColor="text-[var(--gs-text-ghost)]"
                  label={note.label}
                  rightLabel="note"
                />
              ))}
            </SidebarSection>
          )}

          {pmRows.length > 0 && (
            <SidebarSection title="PM Links">
              {pmRows.map((row) => (
                <SidebarItem
                  key={row.id}
                  dotColor={row.tone === 'red' ? 'text-[var(--gs-danger-hover)]' : row.tone === 'green' ? 'text-[var(--gs-success)]' : row.tone === 'blue' ? 'text-[var(--gs-info)]' : 'text-[var(--gs-text-ghost)]'}
                  label={row.label}
                  rightLabel={row.detail}
                  onClick={row.actionable && row.section === 'pull-request' && onOpenGitHubPullRequest ? () => void detailActions.footerAction('open-github-pr') : undefined}
                />
              ))}
            </SidebarSection>
          )}

          {/* SYSTEM */}
          <SidebarSection title="System">
            <SidebarItem label="Event Logs" dotColor="text-[var(--gs-running)]" rightLabel="live" onClick={() => onOpenEvents(workspace.id)} />
          </SidebarSection>
          </div>

          <div className="mt-auto pt-3 border-t border-[var(--gs-border-muted)] space-y-0.5">
            {pendingPermissions > 0 && (
              <div className="px-1.5 text-[11px] text-[var(--gs-warning-bright)]">
                ⚡ {pendingPermissions} pending permission{pendingPermissions !== 1 ? 's' : ''}
              </div>
            )}
            {footerActions.map((action) => {
              if (action.id === 'open-github-pr' && (!onOpenGitHubPullRequest || !pullRequest?.url)) return null;
              if (action.id === 'open-review' && !onOpenReview) return null;
              if (action.id === 'change-status' && !onRequestStatusChange) return null;
              const onClick = () => void detailActions.footerAction(action.id);
              return <SidebarItem key={action.id} label={action.label} rightLabel={action.rightLabel} onClick={onClick} />;
            })}
          </div>
        </div>

        {/* Main area: terminal outlet */}
        <div className="flex-1 flex flex-col min-w-0">
          {/* Terminal outlet / empty state */}
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
                    <div className="text-xs text-[var(--gs-border)] mt-1">Attach a session or agent from the sidebar.</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
