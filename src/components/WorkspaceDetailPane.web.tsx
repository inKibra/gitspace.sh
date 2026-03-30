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

/* ─── Sidebar helpers ─────────────────────────────────────────────────────── */

function SidebarSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-[10px] uppercase tracking-wider text-[#484f58] font-medium">{title}</span>
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
          ? 'bg-[#1c2333] text-[#e6edf3] ring-1 ring-[#58a6ff]/30'
          : active
            ? 'bg-[#1c1c1e] text-[#e6edf3]'
            : 'text-[#a1a1aa] hover:bg-[#1c1c1e] hover:text-[#e6edf3]')
      }
    >
      {dotColor && <span className={dotColor} style={{ fontSize: '8px' }}>●</span>}
      <span className="truncate flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {subtitle && <span className="block truncate text-[10px] text-[#6e7681]">{subtitle}</span>}
      </span>
      {rightLabel && <span className="text-[10px] text-[#484f58] flex-shrink-0">{rightLabel}</span>}
    </Tag>
  );
}

/* DetailActionButton removed — sidebar uses SidebarItem + inline micro-buttons instead */

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
    onSelectWorkspace,
    onClose,
    children,
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
    <div className="h-full flex flex-col bg-[#0d1117] overflow-hidden">
      {/* ── Workspace pill strip ── */}
      {visibleStripWorkspaces.length > 0 && (
        <div className="flex-shrink-0 flex items-center gap-0 overflow-x-auto border-b border-[#21262d] bg-[#0d1117] px-1 py-0.5 scrollbar-none">
          {stripDisplayItems.map((di, idx) => {
            if (di.type === 'project-label') {
              return (
                <span
                  key={`label-${di.tier}-${di.projectName}`}
                  className={
                    'px-2 text-xs text-[#484f58] flex-shrink-0 select-none whitespace-nowrap' +
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
              primaryColor === 'orange' ? 'text-[#f59e0b]' :
              primaryColor === 'red'    ? 'text-[#ff7b72]' :
              primaryColor === 'green'  ? 'text-[#22c55e]' :
              primaryColor === 'blue'   ? 'text-[#58a6ff]' :
              'text-[#374151]';
            return (
              <button
                key={w.id}
                type="button"
                onClick={() => detailActions.selectWorkspace(w.id)}
                className={
                  'flex items-center gap-1 px-2 py-1 rounded text-xs flex-shrink-0 transition-colors ' +
                  (isCurrent
                    ? 'bg-[#21262d] text-[#e6edf3]'
                    : 'text-[#8b949e] hover:text-[#e6edf3] hover:bg-[#161b22]')
                }
                title={`${w.name} (${w.projectName})`}
              >
                <span className={dotColorClass}>●</span>
                <span>{w.name}</span>
                {getWorkspaceStripColor(w, workspaceStatusById) === 'orange' && (
                  <span className="text-[#f59e0b]">⚡</span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* ── Header ── */}
      <div className="flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[#30363d] bg-[#161b22]">
        <button
          type="button"
          onClick={onClose}
          className="text-sm text-[#8b949e] hover:text-[#e6edf3] flex-shrink-0"
        >
          ← Board
        </button>
        <span className="text-[#30363d]">|</span>
        <div className="min-w-0 flex-1">
          <span className="font-medium text-[#e6edf3] truncate">{workspace.name}</span>
          <span className="ml-2 text-xs text-[#8b949e]">
            {phase && <span className="px-1.5 py-0.5 rounded bg-[#21262d] text-[#79c0ff] mr-2">{phaseLabel}</span>}
            {workspaceSessions.length} session(s) · {workspaceReplays.length} replay(s)
          </span>
        </div>
      </div>

      {/* ── Sidebar + Main ── */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <div className="w-[240px] flex-shrink-0 border-r border-[#21262d] bg-[#161618] overflow-y-auto px-2 py-3 flex flex-col">
          <div>
          {/* AI AGENTS */}
          <SidebarSection
            title="AI Agents"
            extra={
              <>
                {agentSessionCount > 0 && <span className="text-[10px] text-[#484f58]">{agentSessionCount}</span>}
                {pendingPermissions > 0 && <span className="text-[10px] text-[#f59e0b]">⚡{pendingPermissions}</span>}
              </>
            }
          >
            {activeAgentSessions.length === 0 ? (
              <div className="text-xs text-[#484f58] px-1.5">No agents</div>
            ) : (
              agentRows.filter((row) => row.bucket === 'active').map((row) => {
                const agentState = row.state;
                const dotColor =
                  agentState === 'needs-permission' ? 'text-[#f59e0b]'
                  : agentState === 'running' ? 'text-[#10b981]'
                  : agentState === 'waiting' ? 'text-[#3b82f6]'
                  : agentState === 'retrying' || agentState === 'error' ? 'text-[#ef4444]'
                  : 'text-[#484f58]';
                return (
                  <div key={row.id} className="flex items-center gap-1">
                    <SidebarItem
                      dotColor={dotColor}
                      label={row.title}
                      subtitle={row.modelLabel}
                      rightLabel={row.lastActiveLabel ?? undefined}
                      onClick={() => {
                        void detailActions.openAgentSession(row.id);
                      }}
                    />
                    {onAbortAgentSession && agentState === 'running' && (
                      <button type="button" onClick={() => void detailActions.abortAgentSession(row.id)} className="text-[10px] text-[#ff7b72] hover:text-[#ff9e9e] flex-shrink-0 px-1">✕</button>
                    )}
                    {onCloseAgentSession && agentState !== 'running' && (
                      <button type="button" onClick={() => void detailActions.closeAgentSession(row.id)} className="text-[10px] text-[#484f58] hover:text-[#8b949e] flex-shrink-0 px-1">×</button>
                    )}
                  </div>
                );
              })
            )}
            {agentRows.filter((row) => row.bucket === 'closed').map((row) => (
              <div key={`closed:${row.id}`} className="flex items-center gap-1">
                <SidebarItem
                  dotColor="text-[#484f58]"
                  label={row.title}
                  rightLabel="closed"
                  onClick={() => {
                    void detailActions.openAgentSession(row.id);
                  }}
                />
                {onArchiveAgentSession && (
                  <button type="button" onClick={() => void detailActions.archiveAgentSession(row.id)} className="text-[10px] text-[#484f58] hover:text-[#8b949e] flex-shrink-0 px-1">arc</button>
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
                    <SidebarItem dotColor="text-[#484f58]" label={row.title} rightLabel="archived" />
                    {onRestoreAgentSession && (
                      <button type="button" onClick={() => void detailActions.restoreAgentSession(row.id)} className="text-[10px] text-[#3fb950] hover:text-[#22c55e] flex-shrink-0 px-1">res</button>
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
                <span className="text-[10px] text-[#484f58]">
                  {agentTodoPhases.reduce((n, p) => n + p.tasks.filter(t => t.status === 'completed').length, 0)}/
                  {agentTodoPhases.reduce((n, p) => n + p.tasks.length, 0)} done
                </span>
              }
            >
              {agentTodoPhases.map((phase) => (
                <div key={phase.name} className="mb-1">
                  <div className="text-[10px] text-[#8b949e] uppercase tracking-wide px-1.5 mb-0.5">{phase.name}</div>
                  {phase.tasks.map((task, i) => {
                    const dotColor =
                      task.status === 'completed' ? 'text-[#3fb950]'
                      : task.status === 'in_progress' ? 'text-[#58a6ff]'
                      : task.status === 'abandoned' ? 'text-[#484f58]'
                      : 'text-[#8b949e]';
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
              <div className="text-xs text-[#484f58] px-1.5">No sessions</div>
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
                      dotColor={isOpen ? 'text-[#3fb950]' : row.attached ? 'text-[#f59e0b]' : 'text-[#10b981]'}
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
                      <button type="button" onClick={() => detailActions.deleteSession(s.id, s.name)} className="text-[10px] text-[#484f58] hover:text-[#ff7b72] flex-shrink-0 px-1">×</button>
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
                          dotColor={isOpen ? 'text-[#3fb950]' : service.state === 'running' ? 'text-[#10b981]' : 'text-[#484f58]'}
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
                            className="text-[10px] text-[#58a6ff] hover:text-[#79c0ff] flex-shrink-0 px-1"
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
                              className="text-[10px] text-[#484f58] hover:text-[#58a6ff] flex-shrink-0 px-1"
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
                            className="text-[10px] text-[#484f58] hover:text-[#ff7b72] flex-shrink-0 px-1"
                            title="Stop service"
                          >
                            stop
                          </button>
                        )}
                      </div>
                      {service.state === 'running' && localUrl && (
                        <div className="pl-5 text-[10px] text-[#484f58] truncate">
                          {service.hostedUrl
                            ? <a href={service.hostedUrl} target="_blank" rel="noopener noreferrer" className="hover:text-[#58a6ff] transition-colors">{service.hostedUrl.replace(/^http:\/\//, '')}</a>
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
                const tone = replay.tone === 'red' ? 'text-[#ff7b72]' : 'text-[#3fb950]';
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
              extra={<span className="text-[10px] text-[#484f58]">{notesSummary?.openTodoCount ?? 0} todo</span>}
            >
              {visibleTodoRows.map((note) => (
                <SidebarItem
                  key={note.id}
                  dotColor={note.priority === 'high' ? 'text-[#ff7b72]' : note.priority === 'medium' ? 'text-[#f59e0b]' : 'text-[#3b82f6]'}
                  label={note.label}
                  rightLabel={note.priority}
                />
              ))}
              {visibleRecentNoteRows.map((note) => (
                <SidebarItem
                  key={note.id}
                  dotColor="text-[#484f58]"
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
                  dotColor={row.tone === 'red' ? 'text-[#ff7b72]' : row.tone === 'green' ? 'text-[#3fb950]' : row.tone === 'blue' ? 'text-[#58a6ff]' : 'text-[#484f58]'}
                  label={row.label}
                  rightLabel={row.detail}
                  onClick={row.actionable && row.section === 'pull-request' && onOpenGitHubPullRequest ? () => void detailActions.footerAction('open-github-pr') : undefined}
                />
              ))}
            </SidebarSection>
          )}

          {/* SYSTEM */}
          <SidebarSection title="System">
            <SidebarItem label="Event Logs" dotColor="text-[#10b981]" rightLabel="live" onClick={() => onOpenEvents(workspace.id)} />
          </SidebarSection>
          </div>

          <div className="mt-auto pt-3 border-t border-[#21262d] space-y-0.5">
            {pendingPermissions > 0 && (
              <div className="px-1.5 text-[11px] text-[#f59e0b]">
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
              <div className="flex-1 flex flex-col items-center justify-center text-[#484f58]">
                <div className="text-sm">No active session</div>
                <div className="text-xs mt-1">Attach a session or agent from the sidebar.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
