import { useCallback, useMemo, useState } from 'react';
import type { WorkspaceDetailModel, WorkspaceDetailModelInput } from './types.js';
import type { SessionInfo } from '../../../components/SpacesBrowser.js';
import {
  buildWorkspaceDetailStripDisplayItems,
  getVisibleWorkspaceDetailStripWorkspaces,
} from './strip.js';
import { formatTime, getAgentSessionDisplayState } from '../../../components/SpacesBrowser.js';
import { normalizeProcessInstanceCount } from '../../../lib/processes/instances.js';
import { parseProcessSessionName } from '../../../lib/processes/names.js';
import { getSessionAlertLabel, getSessionSubtitle } from '../workspace-runtime/derive.js';
import { getPrimaryProcessPort } from '../../../lib/processes/runtime-ports.js';
import { resolveHostedServiceUrl } from '../../../lib/tmux-lite/hosting/routes.js';
const REPLAY_HISTORY_PREVIEW_LIMIT = 3;
const NOTE_TODO_PREVIEW_LIMIT = 2;
const NOTE_RECENT_PREVIEW_LIMIT = 1;

function toSingleLinePreview(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > 72 ? `${normalized.slice(0, 69)}...` : normalized;
}

function toSessionDisplayLabel(value: string): string {
  return value.split(':').pop()?.trim() || value;
}

function toReplayDisplayParts(sessionName: string): { label: string; processLabel?: string } {
  const parsed = parseProcessSessionName(sessionName);
  if (!parsed) {
    return { label: toSessionDisplayLabel(sessionName) };
  }
  return {
    label: `${toSessionDisplayLabel(sessionName)} · ${parsed.processName}`,
    processLabel: parsed.processName,
  };
}

function mergeWorkspaceSessions(runtimeSessions: SessionInfo[], fallbackSessions: SessionInfo[]): SessionInfo[] {
  const byId = new Map<string, SessionInfo>();
  for (const session of runtimeSessions) {
    byId.set(session.id, session);
  }
  for (const session of fallbackSessions) {
    byId.set(session.id, { ...(byId.get(session.id) ?? session), ...session });
  }
  return Array.from(byId.values()).sort((a, b) => b.createdAt - a.createdAt);
}

function resolvePhase(workspace: WorkspaceDetailModelInput['workspace']): string {
  if ('phase' in workspace && typeof (workspace as { phase?: string }).phase === 'string') {
    return (workspace as { phase: string }).phase;
  }
  if ('status' in workspace && typeof (workspace as { status?: string }).status === 'string') {
    return (workspace as { status: string }).status;
  }
  return 'code';
}

function toPhaseLabel(phase: string): string {
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

export function useWorkspaceDetailModel(input: WorkspaceDetailModelInput): WorkspaceDetailModel {
  const {
    workspace,
    sessions,
    replays,
    agentSessions = [],
    allWorkspaces = [],
    workspaceStatusById = {},
    runtime = null,
    actions = {},
  } = input;

  const [showArchivedAgents, setShowArchivedAgents] = useState(false);

  const workspaceSessions = useMemo(() => {
    const directSessions = sessions.filter((session) => session.workspaceId === workspace.id);
    const runtimeSessions = runtime?.sessions ?? [];
    return mergeWorkspaceSessions(runtimeSessions, directSessions);
  }, [runtime?.sessions, sessions, workspace.id]);

  const workspaceReplays = useMemo(
    () => replays
      .filter((replay) => replay.workspaceId === workspace.id)
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
    [replays, workspace.id],
  );

  const phase = useMemo(() => resolvePhase(workspace), [workspace]);
  const phaseLabel = useMemo(() => toPhaseLabel(phase), [phase]);

  const visibleStripWorkspaces = useMemo(
    () => getVisibleWorkspaceDetailStripWorkspaces({
      workspaces: allWorkspaces,
      currentWorkspaceId: workspace.id,
      workspaceStatusById,
    }),
    [allWorkspaces, workspace.id, workspaceStatusById],
  );

  const stripDisplayItems = useMemo(
    () => buildWorkspaceDetailStripDisplayItems({
      workspaces: allWorkspaces,
      currentWorkspaceId: workspace.id,
      workspaceStatusById,
    }),
    [allWorkspaces, workspace.id, workspaceStatusById],
  );

  const currentWorkspaceStripIndex = useMemo(
    () => Math.max(0, visibleStripWorkspaces.findIndex((item) => item.id === workspace.id)),
    [visibleStripWorkspaces, workspace.id],
  );

  const activeAgentSessions = useMemo(
    () => (runtime?.agentSessions ?? agentSessions).filter((session) => !session.archivedAt && !session.closedAt),
    [runtime, agentSessions],
  );

  const closedAgentSessions = useMemo(
    () => (runtime?.agentSessions ?? agentSessions).filter((session) => !!session.closedAt && !session.archivedAt),
    [runtime, agentSessions],
  );

  const archivedAgentSessions = useMemo(
    () => (runtime?.agentSessions ?? agentSessions).filter((session) => !!session.archivedAt),
    [runtime, agentSessions],
  );

  const agentRows = useMemo(
    () => [
      ...activeAgentSessions.map((session) => ({
        id: session.id,
        title: session.title,
        bucket: 'active' as const,
        state: getAgentSessionDisplayState(session),
        lastActiveLabel: session.lastActivityAt
          ? formatTime(session.lastActivityAt)
          : session.updatedAt
            ? formatTime(new Date(session.updatedAt).getTime())
            : undefined,
      })),
      ...closedAgentSessions.map((session) => ({
        id: session.id,
        title: session.title,
        bucket: 'closed' as const,
        state: 'closed' as const,
        lastActiveLabel: session.lastActivityAt
          ? formatTime(session.lastActivityAt)
          : session.updatedAt
            ? formatTime(new Date(session.updatedAt).getTime())
            : undefined,
      })),
      ...archivedAgentSessions.map((session) => ({
        id: session.id,
        title: session.title,
        bucket: 'archived' as const,
        state: 'archived' as const,
        lastActiveLabel: session.lastActivityAt
          ? formatTime(session.lastActivityAt)
          : session.updatedAt
            ? formatTime(new Date(session.updatedAt).getTime())
            : undefined,
      })),
    ],
    [activeAgentSessions, closedAgentSessions, archivedAgentSessions],
  );

  const sessionRows = useMemo(
    () => workspaceSessions.filter((session) => !session.processName).map((session) => ({
      id: session.id,
      label: toSessionDisplayLabel(session.name),
      attached: session.attached,
      statusLabel: session.attached ? 'attached' as const : 'idle' as const,
      subtitle: getSessionSubtitle(session),
      alertLabel: getSessionAlertLabel(session),
    })),
    [workspaceSessions],
  );

  const replayRows = useMemo(
    () => workspaceReplays.map((replay) => {
      const display = toReplayDisplayParts(replay.sessionName);
      return {
        replayId: replay.replayId,
        label: display.label,
        tone: replay.status === 'crashed' ? 'red' as const : 'green' as const,
        processLabel: display.processLabel,
        statusLabel:
          replay.status === 'crashed' ? 'crashed' as const
          : replay.status === 'running' ? 'running' as const
          : 'completed' as const,
        timeLabel: formatTime(replay.endedAt ?? replay.startedAt),
        detailLabel: replay.title,
      };
    }),
    [workspaceReplays],
  );

  const visibleReplayRows = useMemo(
    () => replayRows.slice(0, REPLAY_HISTORY_PREVIEW_LIMIT),
    [replayRows],
  );

  const hiddenReplayCount = useMemo(
    () => Math.max(0, replayRows.length - visibleReplayRows.length),
    [replayRows.length, visibleReplayRows.length],
  );

  const hasMoreReplayRows = hiddenReplayCount > 0;
  const seeAllReplayLabel = hasMoreReplayRows ? `See all (${hiddenReplayCount})` : undefined;
  const notesSummary = workspace.notesSummary;

  const visibleTodoRows = useMemo(
    () => (notesSummary?.topOpenTodos ?? []).slice(0, NOTE_TODO_PREVIEW_LIMIT).map((note) => ({
      id: note.id,
      kind: 'todo' as const,
      label: toSingleLinePreview(note.body),
      priority: note.priority,
      done: Boolean(note.doneAt),
    })),
    [notesSummary],
  );

  const visibleRecentNoteRows = useMemo(
    () => (notesSummary?.recentNotes ?? []).slice(0, NOTE_RECENT_PREVIEW_LIMIT).map((note) => ({
      id: note.id,
      kind: 'note' as const,
      label: toSingleLinePreview(note.body),
      priority: note.priority,
      done: Boolean(note.doneAt),
    })),
    [notesSummary],
  );

  const serviceRows = useMemo(() => {
    const rows: WorkspaceDetailModel['serviceRows'] = [];
    for (const process of workspace.processes ?? []) {
      const count = normalizeProcessInstanceCount(process.instances);
      if (count === 0) {
        rows.push({
          key: `${process.name}:disabled`,
          processName: process.name,
          instance: 0,
          label: `${process.name} (disabled)`,
          state: 'disabled',
        });
        continue;
      }
      for (let instance = 1; instance <= count; instance += 1) {
        const port = getPrimaryProcessPort(process.ports, instance);
        const matchingSessions = workspaceSessions.filter(
          (session) =>
            session.processName === process.name &&
            (session.processInstance ?? 1) === instance,
        );
        const runningSession = matchingSessions
          .filter((session) => session.exitCode === undefined)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        const latestSession = [...matchingSessions].sort((a, b) => b.createdAt - a.createdAt)[0];
        const localUrl = port ? `localhost:${port.port}` : undefined;
        const hostedUrl = runningSession && port ? resolveHostedServiceUrl({
          baseHost: workspace.serveDomain,
          workspaceId: workspace.id,
          processName: process.name,
          instance,
          portLabel: port.name,
          protocol: port.protocol === 'tcp' ? 'tcp' : 'http',
        }) : undefined;
        rows.push({
          key: `${process.name}:${instance}`,
          processName: process.name,
          instance,
          label: `${process.name}#${instance}`,
          portLabel: hostedUrl ? hostedUrl.replace(/^http:\/\//, '') : localUrl,
          localUrl,
          hostedUrl,
          state: runningSession ? 'running' : latestSession?.exitCode !== undefined ? (latestSession.exitCode === 0 ? 'stopped' : 'failed') : 'stopped',
          subtitle: latestSession ? getSessionSubtitle(runningSession ?? latestSession) : undefined,
          alertLabel: latestSession ? getSessionAlertLabel(runningSession ?? latestSession) : undefined,
          attachableSessionId: runningSession?.id,
        });
      }
    }
    return rows;
  }, [workspace.processes, workspaceSessions]);

  const pmRows = useMemo(() => {
    const rows: WorkspaceDetailModel['pmRows'] = [];
    const pullRequest = workspace.pullRequest;
    if (pullRequest && pullRequest.syncState !== 'not_found') {
      rows.push({
        id: 'pull-request',
        section: 'pull-request',
        label: pullRequest.number ? `PR #${pullRequest.number}` : 'Pull Request',
        detail:
          pullRequest.reviewDecision === 'changes_requested' ? 'Changes requested'
          : pullRequest.reviewDecision === 'approved' ? 'Approved'
          : pullRequest.state === 'merged' ? 'Merged'
          : pullRequest.syncState === 'loading' ? 'Loading PR…'
          : pullRequest.syncState === 'cli_missing' ? 'Install GitHub CLI'
          : pullRequest.syncState === 'unauthenticated' ? 'Run gh auth login'
          : pullRequest.syncState === 'unavailable' ? (pullRequest.errorMessage ?? 'PR unavailable')
          : 'In review',
        tone:
          pullRequest.reviewDecision === 'changes_requested' ? 'red'
          : pullRequest.reviewDecision === 'approved' ? 'green'
          : 'blue',
        actionable: Boolean(pullRequest.url),
      });
      if (pullRequest.author) {
        rows.push({ id: 'pull-request-author', section: 'pull-request', label: `Author: @${pullRequest.author.login}`, tone: 'dim' });
      }
      if (pullRequest.reviewers.length > 0) {
        rows.push({ id: 'pull-request-reviewed', section: 'pull-request', label: `Reviewed: ${pullRequest.reviewers.map((a) => `@${a.login}`).join(', ')}`, tone: 'dim' });
      }
      if (pullRequest.requestedReviewers.length > 0) {
        rows.push({ id: 'pull-request-requested', section: 'pull-request', label: `Requested: ${pullRequest.requestedReviewers.map((a) => `@${a.login}`).join(', ')}`, tone: 'dim' });
      }
      if (pullRequest.changesRequestedBy.length > 0) {
        rows.push({ id: 'pull-request-changes', section: 'pull-request', label: `Changes by: ${pullRequest.changesRequestedBy.map((a) => `@${a.login}`).join(', ')}`, tone: 'red' });
      }
    }
    const linear = workspace.linear;
    if (linear && linear.syncState !== 'not_found') {
      rows.push({
        id: 'linear',
        section: 'linear',
        label: linear.identifier ? `Linear ${linear.identifier}` : 'Linear',
        detail:
          linear.stateName
          ?? (linear.syncState === 'unconfigured' ? 'unconfigured'
            : linear.syncState === 'identifier_missing' ? 'no issue key'
            : undefined),
        tone: linear.syncState === 'ready' ? 'blue' : 'dim',
      });
    }
    return rows;
  }, [workspace.pullRequest, workspace.linear]);

  const footerActions = useMemo(() => {
    const actions: WorkspaceDetailModel['footerActions'] = [
      { id: 'open-review', label: 'Open Review' },
      { id: 'launch-commit', label: 'Auto Commit Changes (Alpha)' },
      { id: 'edit-bundle-config', label: 'Edit Bundle Config' },
      { id: 'edit-process-config', label: 'Edit Process Config' },
      { id: 'change-status', label: 'Change Status', rightLabel: `[${phase}]` },
    ];
    if (workspace.pullRequest?.url) {
      actions.unshift({ id: 'open-github-pr', label: 'Open GitHub PR' });
    }
    return actions;
  }, [phase, workspace.pullRequest?.url]);

  const toggleArchivedAgents = useCallback(() => {
    setShowArchivedAgents((value) => !value);
  }, []);

  const modelActions: WorkspaceDetailModel['actions'] = useMemo(() => ({
    selectWorkspace: (workspaceId: string) => {
      void actions.onSelectWorkspace?.(workspaceId);
    },
    attachSession: (sessionId: string) => actions.onAttachSession?.({ sessionId }),
    createSession: () => actions.onAttachSession?.({ workspaceId: workspace.id }),
    deleteSession: (sessionId: string, sessionName: string) => {
      actions.onDeleteSession?.(sessionId, sessionName);
    },
    openReplay: (replayId: string) => actions.onOpenReplay?.(replayId),
    openReplayHistory: () => {
      if (replayRows.length === 0) return;
      return actions.onOpenReplayHistory?.({
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        replayRows,
      });
    },
    activateService: (processName: string, instance: number, state: 'running' | 'stopped' | 'failed' | 'disabled') => {
      if (state === 'disabled') return;
      if (state === 'running') {
        const runningSession = workspaceSessions
          .filter((session) => session.processName === processName && (session.processInstance ?? 1) === instance && session.exitCode === undefined)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        if (runningSession) {
          return actions.onAttachSession?.({ sessionId: runningSession.id, viewOnly: true });
        }
        return;
      }
      actions.onStartProcessAttach?.({ workspaceId: workspace.id, processName, instance });
    },
    footerAction: (id) => {
      if (id === 'open-github-pr') return actions.onOpenGitHubPullRequest?.(workspace.id);
      if (id === 'open-review') return actions.onOpenReview?.(workspace.id);
      if (id === 'launch-commit') return actions.onLaunchCommit?.(workspace.id);
      if (id === 'edit-bundle-config') return actions.onManageBundleConfig?.({ workspaceId: workspace.id });
      if (id === 'edit-process-config') return actions.onEditProcesses?.({ workspaceId: workspace.id });
      return actions.onRequestStatusChange?.(workspace.id, workspace.projectName);
    },
    openAgentSession: (agentSessionId: string) => actions.onOpenAgentSession?.(workspace.id, agentSessionId),
    createAgentSession: () => actions.onCreateAgentSession?.(workspace.id),
    abortAgentSession: (agentSessionId: string) => actions.onAbortAgentSession?.(workspace.id, agentSessionId),
    closeAgentSession: (agentSessionId: string) => actions.onCloseAgentSession?.(workspace.id, agentSessionId),
    archiveAgentSession: (agentSessionId: string) => actions.onArchiveAgentSession?.(workspace.id, agentSessionId),
    restoreAgentSession: (agentSessionId: string) => actions.onRestoreAgentSession?.(workspace.id, agentSessionId),
  }), [actions, replayRows, workspace.id, workspace.name, workspace.projectName, workspaceSessions]);

  return {
    phase,
    phaseLabel,
    workspaceSessions,
    workspaceReplays,
    visibleStripWorkspaces,
    stripDisplayItems,
    currentWorkspaceStripIndex,
    activeAgentSessions,
    archivedAgentSessions,
    showArchivedAgents,
    toggleArchivedAgents,
    agentRows,
    sessionRows,
    replayRows,
    visibleReplayRows,
    hiddenReplayCount,
    hasMoreReplayRows,
    seeAllReplayLabel,
    notesSummary,
    visibleTodoRows,
    visibleRecentNoteRows,
    serviceRows,
    pmRows,
    footerActions,
    actions: modelActions,
  };
}
