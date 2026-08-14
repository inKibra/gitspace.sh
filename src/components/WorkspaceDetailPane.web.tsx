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
import { AGENT_STATE_DOT_CLASS } from '../app/shared/status-display.js';
import { getWorkspaceStripColor } from '../app/shared/workspace-detail/strip.js';
import { useWorkspaceDetailModel } from '../app/shared/workspace-detail/useWorkspaceDetailModel.js';
import { useTheme, THEMES } from '../lib/theme.web.js';
import { SidebarStageHeader, ModeCapsStrip, ChainStack, chainNodesFromGoals } from './WorkspaceSidebarChrome.web.js';

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

/** Mock .sb-grp — 10.5px uppercase tracked group header, full-bleed rows. */
function SidebarSection({ title, extra, children }: { title: string; extra?: ReactNode; children: ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-[13px] pt-[11px] pb-[5px]">
        <span className="text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">{title}</span>
        {extra}
      </div>
      <div>{children}</div>
    </div>
  );
}

/** Mock .litem — glyph column + label + right tag, inset accent bar when active.
 *  Exported so other sidebars render agent rows with THIS, rather than
 *  re-implementing the row and drifting on glyph, dot and busy pulse. */
export function SidebarItem({
  icon,
  iconClass,
  dotColor,
  label,
  subtitle,
  rightLabel,
  busy = false,
  danger = false,
  onClick,
  active = false,
  highlight = false,
}: {
  /** Fixed-width glyph column (mock .ic). */
  icon?: string;
  /** Tone override for the glyph (e.g. service status dots). */
  iconClass?: string;
  dotColor?: string;
  label: string;
  subtitle?: string;
  rightLabel?: string;
  /** Pulsing accent dot at the row's right edge (mock .dotpulse). */
  busy?: boolean;
  danger?: boolean;
  onClick?: () => void;
  active?: boolean;
  highlight?: boolean;
}) {
  const Tag = onClick ? 'button' : 'div';
  const glyph = icon ?? (dotColor ? '●' : undefined);
  const glyphCls = iconClass ?? dotColor ?? (active ? 'text-[var(--gs-accent)]' : 'text-[var(--gs-text-dim)]');
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={
        'w-full min-w-0 flex items-center gap-[9px] px-[13px] py-[5px] text-[12px] text-left transition-colors duration-100 ' +
        (highlight
          ? 'bg-[var(--gs-highlight-bg)] text-[var(--gs-text)] shadow-[inset_2px_0_0_var(--gs-info)]'
          : active
            ? 'bg-[var(--gs-bg-active)] text-[var(--gs-text)] shadow-[inset_2px_0_0_var(--gs-accent)]'
            : `text-[var(--gs-text-muted)] hover:bg-[var(--gs-bg-hover)] ${danger ? 'hover:text-[var(--gs-danger)]' : 'hover:text-[var(--gs-text)]'}`)
      }
    >
      {glyph && <span className={`w-[14px] flex-shrink-0 text-center text-[11px] ${active && !iconClass && !dotColor ? 'text-[var(--gs-accent)]' : glyphCls}`}>{glyph}</span>}
      <span className="truncate flex-1 min-w-0">
        <span className="block truncate">{label}</span>
        {subtitle && <span className="block truncate text-[10px] text-[var(--gs-text-dim)]">{subtitle}</span>}
      </span>
      {busy && <span className="h-[7px] w-[7px] flex-shrink-0 animate-pulse rounded-full bg-[var(--gs-accent)]" />}
      {rightLabel && <span className="ml-auto text-[10.5px] tabular-nums text-[var(--gs-text-dim)] flex-shrink-0">{rightLabel}</span>}
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
  goal?: WorkspaceDetailPaneProps['goal'];
  onOpenGoalDetail?: WorkspaceDetailPaneProps['onOpenGoalDetail'];
  onOpenGitHubPullRequest?: WorkspaceDetailPaneProps['onOpenGitHubPullRequest'];
  onOpenReview?: WorkspaceDetailPaneProps['onOpenReview'];
  onRequestStatusChange?: WorkspaceDetailPaneProps['onRequestStatusChange'];
  onOpenNotes?: WorkspaceDetailPaneProps['onOpenNotes'];
  onOpenEvents: WorkspaceDetailPaneProps['onOpenEvents'];
  onOpenGoalDoc?: WorkspaceDetailPaneProps['onOpenGoalDoc'];
  onOpenChangeGuide?: WorkspaceDetailPaneProps['onOpenChangeGuide'];
  onOpenRubric?: WorkspaceDetailPaneProps['onOpenRubric'];
  onOpenWorkflow?: WorkspaceDetailPaneProps['onOpenWorkflow'];
  onOpenCrons?: WorkspaceDetailPaneProps['onOpenCrons'];
  onCreateDashboard?: WorkspaceDetailPaneProps['onCreateDashboard'];
  dashboards?: WorkspaceDetailPaneProps['dashboards'];
  onOpenDashboard?: WorkspaceDetailPaneProps['onOpenDashboard'];
  chainGoals?: WorkspaceDetailPaneProps['chainGoals'];
  /** Same status map the workspace strip uses, so a chain node's dot reports the
   *  workspace's real status instead of merely "it has a workspace". */
  workspaceStatusById?: WorkspaceDetailPaneProps['workspaceStatusById'];
  /** Needed to map a chain goal to its workspace: the status map is keyed by the
   *  workspace's selectionKey, which a goal does not carry. */
  allWorkspaces?: WorkspaceDetailPaneProps['allWorkspaces'];
  chainTitle?: string;
  currentChainGoalId?: string;
  onSwitchChainWorkspace?: WorkspaceDetailPaneProps['onSwitchChainWorkspace'];
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
    onRequestStatusChange, onOpenNotes, onOpenEvents, onOpenGoalDoc, onOpenChangeGuide, onOpenRubric, onOpenWorkflow, onOpenCrons, onCreateDashboard,
    dashboards, onOpenDashboard, chainGoals, chainTitle, currentChainGoalId, onSwitchChainWorkspace, workspaceStatusById = {}, allWorkspaces = [],
    agentSessionCount, pendingPermissions, pullRequest, onDismiss,
    goal, onOpenGoalDetail,
  } = props;
  const {
    workspaceReplays, activeAgentSessions, archivedAgentSessions, showArchivedAgents, toggleArchivedAgents,
    agentRows, agentTodoPhases, sessionRows, visibleReplayRows, hasMoreReplayRows, seeAllReplayLabel,
    notesSummary, visibleRecentNoteRows, serviceRows, pmRows, footerActions, processConfigError,
    actions: detailActions,
  } = detailModel;
  const shellSessions = workspaceSessions.filter((s) => !s.processName);
  const attachedServiceSession = workspaceSessions.find((s) => s.id === attachedSessionId);
  const attachedServiceIdentity = attachedServiceSession?.processName
    ? { processName: attachedServiceSession.processName, instance: attachedServiceSession.processInstance ?? 1 }
    : null;

  /** Wrap sidebar actions: dismiss bottom sheet on mobile after action */
  const act = (fn: () => void) => { fn(); onDismiss?.(); };
  /** Closed/archived session history hides behind the section kebab (mock has no closed-sessions row). */

  const goalReqs = goal?.validation ? Object.values(goal.validation.requirements ?? {}) : [];
  const goalReady = goalReqs.length > 0
    ? `${goalReqs.filter((r) => (r as { status?: string }).status === 'accepted').length}/${goalReqs.length}`
    : '—';

  const closedAgentRows = agentRows.filter((row) => row.bucket === 'closed');

  return (
    <>
      <div>
      {/* AI AGENTS */}
      <SidebarSection
        title="Agent"
        extra={<>
          {agentSessionCount > 0 && <span className="text-[10px] text-[var(--gs-text-ghost)]">{agentSessionCount}</span>}
          {pendingPermissions > 0 && <span className="text-[10px] text-[var(--gs-warning-bright)]">⚡{pendingPermissions}</span>}
        </>}
      >
        {activeAgentSessions.length === 0 && closedAgentRows.length === 0 ? (
          <div className="text-xs text-[var(--gs-text-ghost)] px-[13px]">No agents</div>
        ) : (
          agentRows.filter((row) => row.bucket === 'active').map((row) => {
            const agentState = row.state;
            const dotColor = AGENT_STATE_DOT_CLASS[agentState];
            return (
              <div key={row.id} className="flex items-center gap-1">
                <SidebarItem
                  icon="▸"
                  iconClass={dotColor}
                  label={row.title}
                  subtitle={row.modelLabel}
                  rightLabel={row.lastActiveLabel ?? undefined}
                  busy={agentState === 'running'}
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
        {closedAgentRows.map((row) => (
          <div key={`closed:${row.id}`} className="flex items-center gap-1">
            <SidebarItem icon="▸" iconClass="text-[var(--gs-text-ghost)]" label={row.title} rightLabel="closed" onClick={() => act(() => void detailActions.openAgentSession(row.id))} />
            {onArchiveAgentSession && (
              <button type="button" title="Archive session" onClick={() => void detailActions.archiveAgentSession(row.id)} className="text-[10px] text-[var(--gs-text-ghost)] hover:text-[var(--gs-text-muted)] flex-shrink-0 px-1">arc</button>
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
          <SidebarItem icon="＋" label="New thread" onClick={() => act(() => void detailActions.createAgentSession())} />
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
          <div className="text-xs text-[var(--gs-text-ghost)] px-[13px]">No sessions</div>
        ) : (
          sessionRows.map((row) => {
            const s = workspaceSessions.find((session) => session.id === row.id)!;
            if (s.processName) return null;
            const isOpen = attachedSessionIds.includes(row.id) || attachedSessionId === row.id;
            return (
              <div key={row.id} className="flex items-center gap-1">
                <SidebarItem
                  icon="⌗"
                  iconClass={isOpen ? 'text-[var(--gs-success)]' : row.attached ? 'text-[var(--gs-warning-bright)]' : 'text-[var(--gs-text-dim)]'}
                  busy={row.attached && !isOpen}
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
        <SidebarItem icon="＋" label="New terminal" onClick={() => act(() => void detailActions.createSession())} />
      </SidebarSection>

      {/* SURFACES (mock Sidebar Surfaces group) */}
      <SidebarSection title="Surfaces">
        {onOpenGoalDoc && goal && (
          <SidebarItem icon="◇" label="Goal doc" rightLabel={goalReady} onClick={() => act(() => onOpenGoalDoc(workspace.id))} />
        )}
        {onOpenWorkflow && (
          <SidebarItem icon="⟜" label="Workflow" rightLabel="live" onClick={() => act(() => onOpenWorkflow(workspace.id))} />
        )}
        {onOpenChangeGuide && (
          <SidebarItem icon="⛓" label="Change Guide" onClick={() => act(() => onOpenChangeGuide(workspace.id))} />
        )}
        {onOpenRubric && (
          <SidebarItem icon="☰" label="Review rubric" onClick={() => act(() => onOpenRubric(workspace.id))} />
        )}
        {onOpenCrons && (
          <SidebarItem icon="◷" label="Crons & triggers" rightLabel="ship" onClick={() => act(() => onOpenCrons(workspace.id))} />
        )}
        <SidebarItem icon="⚑" label="Event logs" rightLabel="live" onClick={() => act(() => onOpenEvents(workspace.id))} />
      </SidebarSection>

      {/* DASHBOARDS (mock Sidebar Dashboards group — *.dashboard.json artifacts) */}
      {onOpenDashboard && (
        <SidebarSection title="Dashboards">
          {(dashboards ?? []).length === 0 && <div className="text-xs text-[var(--gs-text-ghost)] px-[13px]">No dashboards</div>}
          {(dashboards ?? []).map((d) => (
            <SidebarItem key={d.path} icon="▦" label={d.name} rightLabel={String(d.panels)} onClick={() => act(() => onOpenDashboard(d.path))} />
          ))}
          {onCreateDashboard && (
            <SidebarItem icon="＋" label="New dashboard" onClick={() => act(onCreateDashboard)} />
          )}
        </SidebarSection>
      )}

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
                    icon="●"
                    iconClass={isOpen || service.state === 'running' ? 'text-[var(--gs-success)]' : service.state === 'failed' ? 'text-[var(--gs-danger)]' : 'text-[var(--gs-text-dim)]'}
                    label={service.instance > 1 ? service.label : service.processName}
                    rightLabel={localUrl?.includes(':') ? `:${localUrl.split(':').pop()}` : (service.state === 'disabled' ? undefined : (service.alertLabel ?? undefined))}
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

      {/* CHAIN (mock chainstack) */}
      {chainGoals && chainGoals.length > 1 && chainTitle && (
        <ChainStack
          title={chainTitle}
          nodes={chainNodesFromGoals(chainGoals, workspace.name, (g) => {
            // Resolve the WORKSPACE the goal is backed by, and report it once.
            // A goal's own key is `<backend>:goal:<id>` and matches nothing here:
            // stripStatusById is keyed by the workspace's selectionKey (so the
            // dot fell back to grey), and passing it to the board selector
            // resolved to no workspace (so the click deselected instead of
            // navigating). No match means no key: better inert than ejected.
            const ws = allWorkspaces.find((w) => w.name === g.workspaceName && w.projectName === g.projectName);
            if (!ws?.selectionKey) return undefined;
            return { selectionKey: ws.selectionKey, statusColor: getWorkspaceStripColor(ws, workspaceStatusById) };
          })}
          currentGoalId={currentChainGoalId}
          onSwitchWorkspace={onSwitchChainWorkspace ? (key) => act(() => onSwitchChainWorkspace(key)) : undefined}
          onOpenGoal={onOpenGoalDetail ? (goalId) => {
            const item = chainGoals.find((g) => g.id === goalId);
            if (item) act(() => void onOpenGoalDetail(item));
          } : undefined}
        />
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
            <SidebarItem key={note.id} icon="✎" label={note.label} rightLabel="note" />
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


      </div>

      <div className="mt-auto pt-2 border-t border-[var(--gs-border-muted)]">
        <div className="px-[13px] pt-[5px] pb-[5px] text-[10.5px] uppercase tracking-[.12em] text-[var(--gs-text-dim)]">Workspace</div>
        {processConfigError && (
          <button
            type="button"
            onClick={() => void detailActions.footerAction('edit-process-config')}
            title="Click to edit .gitspace/processes.json"
            className="mx-1.5 mb-1 flex w-[calc(100%-12px)] flex-col gap-0.5 rounded border border-[var(--gs-danger-hover)] bg-[var(--gs-chip-red-bg)] px-2 py-1 text-left"
          >
            <span className="text-[10px] uppercase tracking-[.1em] text-[var(--gs-danger-hover)]">⚠ Invalid processes.json</span>
            <span className="text-[11px] leading-snug text-[var(--gs-text)] break-words">{processConfigError}</span>
          </button>
        )}
        {pendingPermissions > 0 && (
          <div className="px-1.5 text-[11px] text-[var(--gs-warning-bright)]">⚡ {pendingPermissions} pending permission{pendingPermissions !== 1 ? 's' : ''}</div>
        )}
        {footerActions.map((action) => {
          if (action.id === 'open-github-pr' && (!onOpenGitHubPullRequest || !pullRequest?.url)) return null;
          if (action.id === 'open-review' && !onOpenReview) return null;
          if (action.id === 'change-status' && !onRequestStatusChange) return null;
          const onClick = () => void detailActions.footerAction(action.id);
          const FOOT_ICON: Record<string, string> = { 'change-status': '◷', 'bundle-config': '⚙', 'open-review': '⛓', 'open-github-pr': '↗', 'auto-commit': '✓', 'edit-process-config': '⚙' };
          return <SidebarItem key={action.id} icon={FOOT_ICON[action.id] ?? '·'} label={action.label} rightLabel={action.rightLabel} onClick={onClick} />;
        })}
        {goal && onOpenGoalDetail && (
          <SidebarItem icon="◇" label="Goal" rightLabel={`⛓ ${goal.chainPosition}/${goal.chainLength}`} onClick={() => act(() => onOpenGoalDetail(goal))} />
        )}
        <SidebarItem icon="✎" label="Notes" rightLabel={notesSummary?.total ? `${notesSummary.total}` : 'open'} onClick={() => act(() => onOpenNotes?.(workspace.id))} />
        {onDeleteWorkspace && (
          <SidebarItem icon="⌫" danger label="Delete Workspace" rightLabel="danger" onClick={() => onDeleteWorkspace(workspace)} />
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
  /** The right rail (repo/artifacts) — composed by the app shell. */
  rightRail?: ReactNode;
}

export function WorkspaceDetailPaneWeb(props: WorkspaceDetailPaneWebProps) {
  const {
    workspace,
    sessions,
    replays,
    rightRail,
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
    goal,
    onOpenGoalDetail,
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
      {/* ── Workspace pill strip (mobile only — GlobalChromeBar supersedes on desktop) ── */}
      {visibleStripWorkspaces.length > 0 && (
        <div className="sm:hidden flex-shrink-0 flex items-center gap-0 overflow-x-auto border-b border-[var(--gs-border-muted)] bg-[var(--gs-bg)] px-1 py-0.5 scrollbar-none">
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

      {/* ── Header (mobile only — GlobalChromeBar supersedes on desktop) ── */}
      <div className="sm:hidden flex-shrink-0 flex items-center gap-2 px-3 py-2 border-b border-[var(--gs-border)] bg-[var(--gs-bg-elevated)]">
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
              className="gs-ui hidden sm:flex flex-shrink-0 bg-[var(--gs-sidebar-bg)] overflow-hidden flex-col"
              style={{ width: sidebarWidth }}
            >
              <SidebarStageHeader
                name={workspace.name}
                phase={props.phase ?? 'code'}
                onSwitchStage={props.onSwitchStage}
              />
              <ModeCapsStrip phase={props.phase ?? 'code'} />
              <div className="flex-1 overflow-y-auto pb-3 flex flex-col">
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
                goal={goal}
                onOpenGoalDetail={onOpenGoalDetail}
                onOpenEvents={onOpenEvents}
                onOpenGoalDoc={props.onOpenGoalDoc}
                onOpenChangeGuide={props.onOpenChangeGuide}
                onOpenRubric={props.onOpenRubric}
                onOpenWorkflow={props.onOpenWorkflow}
                onOpenCrons={props.onOpenCrons}
                onCreateDashboard={props.onCreateDashboard}
                dashboards={props.dashboards}
                onOpenDashboard={props.onOpenDashboard}
                chainGoals={props.chainGoals}
                workspaceStatusById={props.workspaceStatusById}
                allWorkspaces={props.allWorkspaces}
                chainTitle={props.chainTitle}
                currentChainGoalId={props.currentChainGoalId}
                onSwitchChainWorkspace={props.onSwitchChainWorkspace}
                agentSessionCount={agentSessionCount}
                pendingPermissions={pendingPermissions}
                pullRequest={pullRequest}
              />
              </div>
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

        {/* Right rail (repo / artifacts) — layout slot owned by the app shell */}
        {rightRail && <div className="hidden sm:flex h-full flex-shrink-0">{rightRail}</div>}
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
                  goal={goal}
                  onOpenGoalDetail={onOpenGoalDetail}
                  onOpenEvents={onOpenEvents}
                  onOpenGoalDoc={props.onOpenGoalDoc}
                  onOpenChangeGuide={props.onOpenChangeGuide}
                  onOpenRubric={props.onOpenRubric}
                  onOpenWorkflow={props.onOpenWorkflow}
                  onOpenCrons={props.onOpenCrons}
                  onCreateDashboard={props.onCreateDashboard}
                  dashboards={props.dashboards}
                  onOpenDashboard={props.onOpenDashboard}
                  chainGoals={props.chainGoals}
                  workspaceStatusById={props.workspaceStatusById}
                  allWorkspaces={props.allWorkspaces}
                  chainTitle={props.chainTitle}
                  currentChainGoalId={props.currentChainGoalId}
                  onSwitchChainWorkspace={props.onSwitchChainWorkspace}
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
