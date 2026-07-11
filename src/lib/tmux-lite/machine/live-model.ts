/**
 * Live machine-model scoped updates (ticket #3: snapshot → event-driven deltas).
 *
 * The daemon holds the last-built MachineSnapshot as a live in-memory model.
 * Each mutation site computes the *scoped* MachineEvents that describe its
 * change (instead of rebuilding the whole snapshot), the server stamps nonces
 * on them, applies them to the model via the SAME `applyMachineEventToSnapshot`
 * transform clients use (so daemon and clients converge by construction), and
 * broadcasts them over the existing machine-event stream.
 *
 * Events returned here carry `snapshotNonce: 0` — the emitter owns nonce
 * assignment (one nonce per event, monotonically increasing).
 *
 * All computations are synchronous over in-memory inputs; the periodic
 * full rebuild (5-min reconciliation + snapshot-replaced) remains the
 * safety net for anything a scoped update cannot see.
 */
import type { Session } from '../protocol.js';
import type { WorkspaceAgentState } from '../agent-event-manager.js';
import type {
  MachineEvent,
  MachineGoalRecord,
  MachineProcessRecord,
  MachineSnapshot,
  MachineTerminalSessionRecord,
  MachineWorkspaceRecord,
} from './types.js';
import {
  buildAgentSessionRecordsForWorkspace,
  buildTerminalRecord,
  computeAgentSummaryCounts,
  computeProcessSummaryCounts,
  computeTerminalSummaryCounts,
} from './build.js';

function recordsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function listWorkspaceTerminals(
  terminalSessionsById: Record<string, MachineTerminalSessionRecord>,
  workspaceId: string,
): MachineTerminalSessionRecord[] {
  return Object.values(terminalSessionsById).filter((terminal) => terminal.workspaceId === workspaceId);
}

function processIdFor(terminal: MachineTerminalSessionRecord): string | null {
  if (!terminal.workspaceId || !terminal.processName || terminal.kind === 'agent') return null;
  return `${terminal.workspaceId}:${terminal.processName}:${terminal.processInstance ?? 1}`;
}

/** Recompute one process record from the terminals that map to it.
 *  Returns null when no terminal carries the process any more. */
function computeProcessRecord(
  processId: string,
  workspaceId: string,
  projectId: string,
  terminals: MachineTerminalSessionRecord[],
): MachineProcessRecord | null {
  const carriers = terminals.filter((terminal) => processIdFor(terminal) === processId);
  if (carriers.length === 0) return null;
  const running = carriers.find((terminal) => terminal.exitCode === undefined);
  const source = running ?? carriers[carriers.length - 1];
  const status: MachineProcessRecord['status'] = running
    ? 'running'
    : source.exitCode === 0
      ? 'stopped'
      : 'failed';
  return {
    id: processId,
    workspaceId,
    projectId,
    name: source.processName ?? '',
    instance: source.processInstance,
    status,
    terminalSessionId: source.id,
    errorMessage: status === 'failed' ? `Exit ${source.exitCode}` : undefined,
  };
}

/** Rebuild the workspace record's terminal/process derived fields from a
 *  terminal map that already reflects the change. */
function updatedWorkspaceForTerminals(
  workspace: MachineWorkspaceRecord,
  terminalSessionsById: Record<string, MachineTerminalSessionRecord>,
): MachineWorkspaceRecord {
  const terminals = listWorkspaceTerminals(terminalSessionsById, workspace.id);
  const nonAgent = terminals.filter((terminal) => terminal.kind !== 'agent');
  const processIds = Array.from(new Set(
    nonAgent.map((terminal) => processIdFor(terminal)).filter((id): id is string => !!id),
  ));
  return {
    ...workspace,
    terminalSessionIds: nonAgent.map((terminal) => terminal.id),
    processIds,
    summary: {
      ...workspace.summary,
      ...computeTerminalSummaryCounts(terminals),
      ...computeProcessSummaryCounts(nonAgent),
    },
  };
}

/** Slim event carrying only the session-derived workspace fields — the full
 *  record (embedded goal doc, pm state) is heavy and unchanged here. */
function workspaceDerivedEvent(workspace: MachineWorkspaceRecord): MachineEvent {
  return {
    type: 'workspace-derived-replaced',
    snapshotNonce: 0,
    workspaceId: workspace.id,
    terminalSessionIds: workspace.terminalSessionIds,
    agentSessionIds: workspace.agentSessionIds,
    processIds: workspace.processIds,
    summary: workspace.summary,
  };
}

/**
 * Scoped delta for one terminal session change (created / exited / removed).
 * `session` is the current daemon-side Session, or null when the session no
 * longer exists.
 */
export function computeTerminalDeltaEvents(
  snapshot: MachineSnapshot,
  sessionId: string,
  session: Session | null,
): MachineEvent[] {
  const previous = snapshot.terminalSessionsById[sessionId];
  const events: MachineEvent[] = [];

  if (!session) {
    if (!previous) return [];
    events.push({ type: 'terminal-session-removed', snapshotNonce: 0, sessionId, workspaceId: previous.workspaceId });
    const nextTerminals = { ...snapshot.terminalSessionsById };
    delete nextTerminals[sessionId];
    if (previous.workspaceId) {
      const workspace = snapshot.workspacesById[previous.workspaceId];
      if (workspace) {
        events.push(workspaceDerivedEvent(updatedWorkspaceForTerminals(workspace, nextTerminals)));
      }
      const processId = processIdFor(previous);
      if (processId) {
        const record = computeProcessRecord(
          processId,
          previous.workspaceId,
          previous.projectId ?? workspace?.projectId ?? '',
          Object.values(nextTerminals),
        );
        if (record) {
          events.push({ type: 'process-upserted', snapshotNonce: 0, process: record });
        } else if (snapshot.processesById[processId]) {
          events.push({ type: 'process-removed', snapshotNonce: 0, processId, workspaceId: previous.workspaceId });
        }
      }
    }
    return events;
  }

  const record = buildTerminalRecord(session, snapshot.workspacesById);
  if (previous && recordsEqual(previous, record)) return [];
  events.push({ type: 'terminal-session-upserted', snapshotNonce: 0, session: record });

  const nextTerminals = { ...snapshot.terminalSessionsById, [sessionId]: record };
  const touchedWorkspaceIds = new Set<string>();
  if (previous?.workspaceId) touchedWorkspaceIds.add(previous.workspaceId);
  if (record.workspaceId) touchedWorkspaceIds.add(record.workspaceId);
  for (const workspaceId of touchedWorkspaceIds) {
    const workspace = snapshot.workspacesById[workspaceId];
    if (!workspace) continue;
    const updated = updatedWorkspaceForTerminals(workspace, nextTerminals);
    if (!recordsEqual(workspace, updated)) {
      events.push(workspaceDerivedEvent(updated));
    }
  }

  const touchedProcessIds = new Set<string>();
  const previousProcessId = previous ? processIdFor(previous) : null;
  const nextProcessId = processIdFor(record);
  if (previousProcessId) touchedProcessIds.add(previousProcessId);
  if (nextProcessId) touchedProcessIds.add(nextProcessId);
  for (const processId of touchedProcessIds) {
    const workspaceId = processId.slice(0, processId.lastIndexOf(':', processId.lastIndexOf(':') - 1));
    const owner = processId === nextProcessId ? record : previous;
    const wsId = owner?.workspaceId ?? workspaceId;
    const projectId = owner?.projectId ?? snapshot.workspacesById[wsId]?.projectId ?? '';
    const processRecord = computeProcessRecord(processId, wsId, projectId, Object.values(nextTerminals));
    if (processRecord) {
      if (!recordsEqual(snapshot.processesById[processId], processRecord)) {
        events.push({ type: 'process-upserted', snapshotNonce: 0, process: processRecord });
      }
    } else if (snapshot.processesById[processId]) {
      events.push({ type: 'process-removed', snapshotNonce: 0, processId, workspaceId: wsId });
    }
  }

  return events;
}

/**
 * Scoped delta for one workspace's agent-session state (agent-event-manager
 * delta arrived): rebuild that workspace's agent records, diff against the
 * model, and refresh the workspace summary counts.
 */
export function computeAgentWorkspaceDeltaEvents(
  snapshot: MachineSnapshot,
  workspaceId: string,
  agentState: WorkspaceAgentState | undefined,
): MachineEvent[] {
  const workspace = snapshot.workspacesById[workspaceId];
  const projectId = workspace?.projectId
    ?? (workspaceId.endsWith(':@base') ? workspaceId.slice(0, -':@base'.length) : undefined);
  if (projectId === undefined) return [];

  const records = buildAgentSessionRecordsForWorkspace({
    workspaceId,
    projectId,
    workspace: agentState,
    terminalSessionsById: snapshot.terminalSessionsById,
  });

  const events: MachineEvent[] = [];
  const nextIds = new Set(records.map((record) => record.id));
  const previousIds = snapshot.agentSessionIdsByWorkspaceId[workspaceId] ?? [];

  for (const previousId of previousIds) {
    if (!nextIds.has(previousId)) {
      events.push({ type: 'agent-session-removed', snapshotNonce: 0, sessionId: previousId, workspaceId });
    }
  }
  for (const record of records) {
    const previous = snapshot.agentSessionsById[record.id];
    if (!previous || !recordsEqual(previous, record)) {
      events.push({ type: 'agent-session-upserted', snapshotNonce: 0, session: record });
    }
  }

  if (workspace) {
    const updated: MachineWorkspaceRecord = {
      ...workspace,
      agentSessionIds: records.map((record) => record.id),
      summary: {
        ...workspace.summary,
        ...computeAgentSummaryCounts(records),
      },
    };
    if (!recordsEqual(workspace, updated)) {
      events.push(workspaceDerivedEvent(updated));
    }
  }

  return events;
}

/**
 * Scoped delta for one project's goal state (goal-update commands, or the
 * fire-and-forget `goal-changed` notify after a space CLI goal.json write).
 * `goals` are machine-scoped records (ids already `project:`-prefixed).
 */
export function computeProjectGoalsDeltaEvents(
  snapshot: MachineSnapshot,
  projectName: string,
  goals: MachineGoalRecord[],
): MachineEvent[] {
  const previousIds = snapshot.goalIdsByProjectId?.[projectName] ?? [];
  const previousGoals = previousIds
    .map((goalId) => snapshot.goalsById?.[goalId])
    .filter((goal): goal is MachineGoalRecord => !!goal);

  const events: MachineEvent[] = [];
  if (!recordsEqual(previousGoals, goals)) {
    events.push({
      type: 'project-goals-replaced',
      snapshotNonce: 0,
      projectId: projectName,
      goalsById: Object.fromEntries(goals.map((goal) => [goal.id, goal])),
      goalOrder: goals.map((goal) => goal.id),
    });
  }

  // Workspace records embed their bound goal (and inherit its phase) — keep
  // them in sync with the project's new goal set.
  const goalByWorkspaceName = new Map<string, MachineGoalRecord>();
  for (const goal of goals) {
    if (goal.workspaceName) goalByWorkspaceName.set(goal.workspaceName, goal);
  }
  for (const workspaceId of snapshot.workspaceIdsByProjectId[projectName] ?? []) {
    const workspace = snapshot.workspacesById[workspaceId];
    if (!workspace) continue;
    const goal = goalByWorkspaceName.get(workspace.name);
    const updated: MachineWorkspaceRecord = {
      ...workspace,
      goal,
      phase: goal ? goal.phase : workspace.phase,
    };
    if (!recordsEqual(workspace, updated)) {
      events.push({ type: 'workspace-upserted', snapshotNonce: 0, workspace: updated });
    }
  }

  return events;
}

/**
 * Scoped delta for PM (pull request / Linear) state changes: refresh the pm
 * fields on any workspace record whose state moved.
 */
export function computePmDeltaEvents(
  snapshot: MachineSnapshot,
  pmByWorkspaceId: Record<string, { pullRequest?: MachineWorkspaceRecord['pullRequest']; linear?: MachineWorkspaceRecord['linear'] }>,
): MachineEvent[] {
  const events: MachineEvent[] = [];
  for (const workspace of Object.values(snapshot.workspacesById)) {
    const pmState = pmByWorkspaceId[workspace.id];
    if (!pmState) continue;
    const updated: MachineWorkspaceRecord = {
      ...workspace,
      pullRequest: pmState.pullRequest,
      linear: pmState.linear,
    };
    if (!recordsEqual(workspace, updated)) {
      events.push({ type: 'workspace-upserted', snapshotNonce: 0, workspace: updated });
    }
  }
  return events;
}
