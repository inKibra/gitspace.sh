import { listProjectSummaries } from '../../../core/project-catalog.js';
import { listProjectGoalKanbanItems } from '../../../core/goal-chain.js';
import { countArchivedSessions, getArchivedSessions } from '../../../agents/agent-db.js';
import type { WorkspaceAgentState } from '../agent-event-manager.js';
import type { Session, WorkspaceRuntimeRecord } from '../protocol.js';
import { parseProcessSessionName } from '../../processes/names.js';
import type {
  MachineAgentSessionRecord,
  MachineProcessRecord,
  MachineProjectRecord,
  MachineGoalRecord,
  MachineSnapshot,
  MachineTerminalSessionRecord,
  MachineWorkspaceRecord,
} from './types.js';
import { getWorkspacePmSnapshot } from './pm-links.js';

function determineTerminalState(session: Session): MachineTerminalSessionRecord['state'] {
  if (session.attached) return 'attached';
  if (session.exitCode === undefined) return 'running';
  if (session.exitCode === 0) return 'exited';
  return 'failed';
}

function determineAgentState(
  workspace: WorkspaceAgentState,
  sessionId: string,
  closedAt: string | undefined,
  errorMessage: string | undefined,
  pendingQuestionCount: number,
  pendingPermissionCount: number,
): MachineAgentSessionRecord['state'] {
  if (closedAt) return 'closed';
  if (pendingPermissionCount > 0 || pendingQuestionCount > 0) return 'permission-needed';
  const status = workspace.statuses[sessionId];
  if (status?.type === 'retry' || errorMessage) return 'retrying';
  // 'compacting' (auto-compaction in progress) is active work, like 'busy' —
  // it must surface as a running/green-pulse agent on the board, not idle.
  if (status?.type === 'busy' || status?.type === 'compacting') return 'running';
  return 'waiting';
}


export function resolveWorkspaceIdForTerminal(
  session: Session,
  workspacesById: Record<string, MachineWorkspaceRecord>,
): string | undefined {
  const metadataWorkspaceId = session.metadata?.workspaceId;
  if (metadataWorkspaceId && workspacesById[metadataWorkspaceId]) {
    return metadataWorkspaceId;
  }
  const parsed = parseProcessSessionName(session.name);
  if (parsed?.workspaceId) {
    const match = Object.values(workspacesById).find(
      (workspace) => workspace.id === parsed.workspaceId || workspace.name === parsed.workspaceId,
    );
    if (match) {
      return match.id;
    }
  }
  const match = Object.values(workspacesById).find((workspace) => workspace.path === session.cwd);
  return match?.id;
}

function getProcessIdentity(session: Session): { processName?: string; processInstance?: number } {
  const parsed = parseProcessSessionName(session.name);
  return {
    processName: session.metadata?.processName ?? parsed?.processName,
    processInstance: session.metadata?.processInstance
      ? Number(session.metadata.processInstance)
      : parsed?.instance,
  };
}

function cloneWorkspaceRecord(workspace: WorkspaceRuntimeRecord): MachineWorkspaceRecord {
  return {
    id: workspace.id,
    name: workspace.name,
    projectId: workspace.projectName,
    projectName: workspace.projectName,
    path: workspace.path,
    branch: workspace.branch,
    phase: workspace.status,
    isStale: workspace.isStale,
    serveDomain: workspace.serveDomain,
    processes: workspace.processes,
    processConfigError: workspace.processConfigError,
    notesSummary: workspace.notesSummary,
    terminalSessionIds: [],
    agentSessionIds: [],
    processIds: [],
    replayIds: [],
    summary: {
      terminalCount: workspace.terminals.sessionCount,
      attachedTerminalCount: workspace.terminals.attachedCount,
      runningTerminalCount: workspace.terminals.runningCount,
      failedTerminalCount: workspace.terminals.failedCount,
      agentCount: workspace.agents.sessionCount,
      runningAgentCount: workspace.agents.busyCount,
      waitingAgentCount: workspace.agents.waitingCount,
      permissionAgentCount: workspace.agents.needsPermissionCount,
      retryingAgentCount: workspace.agents.errorCount,
      closedAgentCount: workspace.agents.closedCount,
      archivedAgentCount: workspace.agents.archivedCount,
      configuredProcessCount: workspace.processSummary.configuredCount,
      runningProcessCount: workspace.processSummary.runningCount,
      failedProcessCount: workspace.processSummary.failedCount,
    },
  };
}

/** Build one terminal session record. Shared by the full snapshot build and
 *  the live-model scoped updates so both paths stay byte-identical. */
export function buildTerminalRecord(
  session: Session,
  workspacesById: Record<string, MachineWorkspaceRecord>,
): MachineTerminalSessionRecord {
  const workspaceId = resolveWorkspaceIdForTerminal(session, workspacesById);
  const projectId = workspaceId ? workspacesById[workspaceId]?.projectId : undefined;
  const processIdentity = getProcessIdentity(session);
  return {
    id: session.id,
    name: session.name,
    workspaceId,
    projectId,
    socketPath: session.socketPath,
    cwd: session.cwd,
    kind: session.kind === 'agent'
      ? 'agent'
      : processIdentity.processName
        ? 'process'
        : 'shell',
    hidden: session.hidden === true,
    state: determineTerminalState(session),
    attached: session.attached,
    createdAt: session.createdAt,
    exitCode: session.exitCode,
    processTitle: session.processTitle,
    terminalTitle: session.terminalTitle,
    lastAlertKind: session.lastAlertKind,
    lastAlertPreview: session.lastAlertPreview,
    lastAlertAt: session.lastAlertAt,
    unreadAlertCount: session.unreadAlertCount,
    processName: processIdentity.processName,
    processInstance: processIdentity.processInstance,
    linkedAgentSessionId: session.metadata?.agentSessionId,
    metadata: session.metadata,
  };
}

/**
 * Slim a goal's validation for the connect snapshot (ticket #42). The board and
 * its fallback tally only need each requirement's `status` plus the precomputed
 * `readiness` totals — the unbounded-with-uptime content (evidence
 * stdout/stderr/body, reviews, and the timeline event log) is dropped here and
 * pulled on demand via the `goal-detail` RPC. Requirement metadata shells are
 * bounded (one per declared requirement) so they stay for the board fallback.
 */
/** Reduce a requirement's evidence for the snapshot: keep only the latest
 *  entry per command (manual entries kept individually) and strip the heavy
 *  captured streams — `goal-detail` serves the full trail with output. */
function slimEvidence(
  evidence: import('../../../types/goals.js').Evidence[],
): import('../../../types/goals.js').Evidence[] {
  const latestByKey = new Map<string, import('../../../types/goals.js').Evidence>();
  for (const entry of evidence) {
    // Command evidence dedups by command; manual/other stays per-entry (id key).
    const key = entry.command ? `cmd:${entry.command}` : `id:${entry.id}`;
    const existing = latestByKey.get(key);
    if (!existing || entry.createdAt >= existing.createdAt) {
      latestByKey.set(key, entry);
    }
  }
  return [...latestByKey.values()].map((entry) => ({
    ...entry,
    stdout: undefined,
    stderr: undefined,
    body: undefined,
  }));
}

function slimGoalValidation(
  validation: import('../../../types/goals.js').GoalValidation | undefined,
): import('../../../types/goals.js').GoalValidation | undefined {
  if (!validation) return undefined;
  const requirements: import('../../../types/goals.js').GoalValidation['requirements'] = {};
  for (const [id, requirement] of Object.entries(validation.requirements)) {
    // Keep the bounded shell; drop the review trail entirely (full trail via
    // goal-detail) and reduce evidence to the latest entry per command with
    // its heavy stdout/stderr/body stripped — both grow with machine uptime.
    requirements[id] = {
      ...requirement,
      evidence: slimEvidence(requirement.evidence),
      reviews: [],
    };
  }
  return {
    reqOrder: validation.reqOrder,
    requirements,
    events: [],
    readiness: validation.readiness,
  };
}

/** Slim a goal's doc for the snapshot: the body markdown and composed blocks
 *  are served by `goal-detail`; only bounded metadata is kept. */
function slimGoalDoc(
  doc: import('../../../types/goals.js').GoalDoc | undefined,
): import('../../../types/goals.js').GoalDoc | undefined {
  if (!doc) return undefined;
  return {
    bodyMarkdown: '',
    updatedAt: doc.updatedAt,
    updatedBy: doc.updatedBy,
    exemplarBlockIds: doc.exemplarBlockIds,
  };
}

/** Machine-scoped goal records for one project (ids prefixed `project:`).
 *  The doc + validation are slimmed to a board projection here — the connect
 *  snapshot must not carry evidence/reviews/timeline that grow with uptime
 *  (ticket #42); detail views lazy-fetch the full record via `goal-detail`. */
export function buildGoalRecordsForProject(projectName: string): MachineGoalRecord[] {
  let goals: MachineGoalRecord[] = [];
  try {
    goals = listProjectGoalKanbanItems(projectName);
  } catch {
    goals = [];
  }
  return goals.map((goal) => ({
    ...goal,
    id: `${projectName}:${goal.id}`,
    previousGoalId: goal.previousGoalId ? `${projectName}:${goal.previousGoalId}` : undefined,
    doc: slimGoalDoc(goal.doc),
    validation: slimGoalValidation(goal.validation),
  }));
}

/** Newest archived agent sessions per workspace carried inline in the snapshot
 *  (ticket #42). Older ones are reachable via the agent-sessions RPC. */
export const ARCHIVED_SNAPSHOT_LIMIT = 20;

/** Build the agent session records for one workspace (live + newest archived),
 *  mirroring the full-snapshot build exactly. Archived sessions are capped to
 *  the newest `ARCHIVED_SNAPSHOT_LIMIT`; `archivedMoreCount` reports how many
 *  older ones were left out so the UI can show an 'N more' affordance. */
export function buildAgentSessionRecordsForWorkspace(params: {
  workspaceId: string;
  projectId: string;
  workspace: WorkspaceAgentState | undefined;
  terminalSessionsById: Record<string, MachineTerminalSessionRecord>;
  /** Live "ask" dialog ids per session (single source of truth: the
   *  coordinator's open dialogs). Folded into pendingQuestionIds so a session
   *  blocked on a user dialog shows amber, cleared automatically when it
   *  resolves. */
  pendingDialogIdsBySession?: Record<string, string[]>;
}): { records: MachineAgentSessionRecord[]; archivedMoreCount: number } {
  const { workspaceId, projectId, workspace, terminalSessionsById, pendingDialogIdsBySession } = params;
  const records: MachineAgentSessionRecord[] = [];
  const archivedSessions = getArchivedSessions(workspaceId, ARCHIVED_SNAPSHOT_LIMIT);
  const archivedTotal = countArchivedSessions(workspaceId);
  const archivedSessionIds = new Set(archivedSessions.map((session) => session.sessionId));
  const seen = new Set<string>();

  if (workspace) {
    for (const session of workspace.sessions) {
      if (archivedSessionIds.has(session.id) || session.archivedAt) continue;
      const pendingPermissionIds = (workspace.pendingPermissions[session.id] ?? []).map((permission) => permission.id);
      const pendingQuestionIds = [
        ...(workspace.pendingQuestions[session.id] ?? []).map((q) => q.id),
        ...(pendingDialogIdsBySession?.[session.id] ?? []),
      ];
      const linkedTerminal = Object.values(terminalSessionsById).find(
        (terminal) => terminal.workspaceId === workspaceId && terminal.linkedAgentSessionId === session.id,
      );
      const errorMessage = workspace.errorMessages[session.id]
        ?? (workspace.statuses[session.id]?.type === 'retry' ? 'retrying' : undefined);
      records.push({
        id: session.id,
        workspaceId,
        projectId,
        title: session.title,
        state: determineAgentState(
          workspace,
          session.id,
          session.closedAt,
          errorMessage,
          pendingQuestionIds.length,
          pendingPermissionIds.length,
        ),
        updatedAt: session.updatedAt,
        closedAt: session.closedAt,
        pendingPermissionIds,
        pendingPermissionCount: pendingPermissionIds.length,
        pendingQuestionIds,
        pendingQuestionCount: pendingQuestionIds.length,
        errorMessage,
        lastMessagePreview: workspace.lastMessages[session.id],
        linkedTerminalSessionId: linkedTerminal?.id,
        modelInfo: workspace.modelInfo?.[session.id],
        todoPhases: workspace.todoPhases?.[session.id],
        queuedMessages: workspace.queuedMessages?.[session.id],
      });
      seen.add(session.id);
    }
  }

  for (const archived of archivedSessions) {
    if (seen.has(archived.sessionId)) continue;
    records.push({
      id: archived.sessionId,
      workspaceId,
      projectId,
      title: archived.title,
      state: 'archived',
      archivedAt: archived.archivedAt,
      pendingPermissionIds: [],
      pendingPermissionCount: 0,
      pendingQuestionIds: [],
      pendingQuestionCount: 0,
    });
    seen.add(archived.sessionId);
  }

  return { records, archivedMoreCount: Math.max(0, archivedTotal - archivedSessions.length) };
}

/** Agent-state summary counts for a workspace record. */
export function computeAgentSummaryCounts(agents: MachineAgentSessionRecord[]): {
  agentCount: number;
  runningAgentCount: number;
  waitingAgentCount: number;
  permissionAgentCount: number;
  retryingAgentCount: number;
  closedAgentCount: number;
  archivedAgentCount: number;
} {
  let runningAgentCount = 0;
  let waitingAgentCount = 0;
  let permissionAgentCount = 0;
  let retryingAgentCount = 0;
  let closedAgentCount = 0;
  let archivedAgentCount = 0;
  for (const agent of agents) {
    switch (agent.state) {
      case 'running': runningAgentCount += 1; break;
      case 'waiting': waitingAgentCount += 1; break;
      case 'permission-needed': permissionAgentCount += 1; break;
      case 'retrying': retryingAgentCount += 1; break;
      case 'closed': closedAgentCount += 1; break;
      case 'archived': archivedAgentCount += 1; break;
    }
  }
  return {
    agentCount: agents.length,
    runningAgentCount,
    waitingAgentCount,
    permissionAgentCount,
    retryingAgentCount,
    closedAgentCount,
    archivedAgentCount,
  };
}

/** Terminal summary counts for a workspace record (visible shells/processes:
 *  hidden and agent-kind terminals are excluded, matching the scanner). */
export function computeTerminalSummaryCounts(terminals: MachineTerminalSessionRecord[]): {
  terminalCount: number;
  attachedTerminalCount: number;
  runningTerminalCount: number;
  failedTerminalCount: number;
} {
  const relevant = terminals.filter((terminal) => !terminal.hidden && terminal.kind !== 'agent');
  return {
    terminalCount: relevant.length,
    attachedTerminalCount: relevant.filter((terminal) => terminal.attached).length,
    runningTerminalCount: relevant.filter((terminal) => terminal.exitCode === undefined).length,
    failedTerminalCount: relevant.filter((terminal) => terminal.exitCode !== undefined && terminal.exitCode !== 0).length,
  };
}

/** Process summary run/fail counts derived from process-carrying terminals. */
export function computeProcessSummaryCounts(terminals: MachineTerminalSessionRecord[]): {
  runningProcessCount: number;
  failedProcessCount: number;
} {
  const relevant = terminals.filter((terminal) => !!terminal.processName);
  return {
    runningProcessCount: relevant.filter((terminal) => terminal.exitCode === undefined).length,
    failedProcessCount: relevant.filter((terminal) => terminal.exitCode !== undefined && terminal.exitCode !== 0).length,
  };
}

function listGoalsForSnapshot(projectNames: string[]): {
  goalsById: Record<string, MachineGoalRecord>;
  goalOrder: string[];
  goalIdsByProjectId: Record<string, string[]>;
  goalByWorkspace: Map<string, MachineGoalRecord>;
} {
  const goalsById: Record<string, MachineGoalRecord> = {};
  const goalOrder: string[] = [];
  const goalIdsByProjectId: Record<string, string[]> = {};
  const goalByWorkspace = new Map<string, MachineGoalRecord>();

  for (const projectName of projectNames) {
    goalIdsByProjectId[projectName] = [];
    for (const machineGoal of buildGoalRecordsForProject(projectName)) {
      goalsById[machineGoal.id] = machineGoal;
      goalOrder.push(machineGoal.id);
      goalIdsByProjectId[projectName].push(machineGoal.id);
      if (machineGoal.workspaceName) {
        goalByWorkspace.set(`${projectName}:${machineGoal.workspaceName}`, machineGoal);
      }
    }
  }

  return { goalsById, goalOrder, goalIdsByProjectId, goalByWorkspace };
}


/**
 * Hard ceiling on the serialized machine snapshot, kept well under the client's
 * frame reassembly cap (frame-chunk.ts MAX_REASSEMBLED_BYTES = 128 MiB). A
 * snapshot that crosses the reassembly cap is DROPPED by the client as a
 * "malformed chunk" and the whole app dies with "Connection failed" — there is
 * no recovery. So the daemon must never emit one that big. This budget triggers
 * only in the pathological case (normal snapshots are tens of KB); when it does,
 * we degrade the at-a-glance projection rather than kill the connection.
 */
const SNAPSHOT_SIZE_BUDGET_BYTES = 24 * 1024 * 1024;
/** When trimming, how much per-message/preview text to keep for display. */
const CAP_TEXT_CHARS = 200;
const CAP_TODO_PHASES = 40;

/** Enforce SNAPSHOT_SIZE_BUDGET_BYTES by progressively trimming the heaviest
 *  per-session fields (freshly built here, so mutating them is safe). Logs
 *  `[snapshot-cap]` with the top byte contributors so an oversized snapshot is
 *  self-diagnosing — this is the diagnostic we otherwise had to ask users for. */
function enforceSnapshotSizeBudget(snapshot: MachineSnapshot): MachineSnapshot {
  let json: string;
  try { json = JSON.stringify(snapshot); } catch { return snapshot; }
  if (json.length <= SNAPSHOT_SIZE_BUDGET_BYTES) return snapshot;

  const before = json.length;
  const records = Object.values(snapshot.agentSessionsById);
  const top = records
    .map((r) => ({
      id: r.id.slice(0, 8),
      bytes: JSON.stringify(r).length,
      queued: JSON.stringify(r.queuedMessages ?? null).length,
      todo: JSON.stringify(r.todoPhases ?? null).length,
      lastMsg: (r.lastMessagePreview ?? '').length,
    }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);

  const applied: string[] = [];
  const pass = (label: string, fn: (r: MachineAgentSessionRecord) => void): boolean => {
    for (const r of records) fn(r);
    applied.push(label);
    json = JSON.stringify(snapshot);
    return json.length <= SNAPSHOT_SIZE_BUDGET_BYTES;
  };

  // Order matters: shed the fields most likely to carry raw pasted text first.
  const done =
    pass('queuedMessages', (r) => {
      if (!r.queuedMessages) return;
      r.queuedMessages = {
        steering: r.queuedMessages.steering.map((m) => m.slice(0, CAP_TEXT_CHARS)),
        followUp: r.queuedMessages.followUp.map((m) => m.slice(0, CAP_TEXT_CHARS)),
      };
    })
    || pass('todoPhases', (r) => {
      if (Array.isArray(r.todoPhases) && r.todoPhases.length > CAP_TODO_PHASES) {
        r.todoPhases = r.todoPhases.slice(0, CAP_TODO_PHASES);
      }
    })
    || pass('lastMessagePreview', (r) => {
      if (r.lastMessagePreview) r.lastMessagePreview = r.lastMessagePreview.slice(0, CAP_TEXT_CHARS);
    });

  console.error(
    `[snapshot-cap] snapshot ${before} bytes exceeded budget ${SNAPSHOT_SIZE_BUDGET_BYTES}; `
    + `trimmed [${applied.join(', ')}] -> ${json.length} bytes${done ? '' : ' (STILL OVER)'}; `
    + `top contributors: ${top.map((t) => `${t.id}=${t.bytes}b(q${t.queued}/t${t.todo}/m${t.lastMsg})`).join(', ')}`,
  );
  return snapshot;
}

export function buildMachineSnapshot(params: {
  snapshotNonce: number;
  terminalSessions: Session[];
  workspaces: WorkspaceRuntimeRecord[];
  agentStateByWorkspaceId: Record<string, WorkspaceAgentState>;
  /** Live "ask" dialog ids, keyed workspaceId -> sessionId -> dialogIds. Sourced
   *  from the coordinator's open dialogs so blocked sessions show amber. */
  pendingDialogIdsByWorkspace?: Record<string, Record<string, string[]>>;
}): MachineSnapshot {
  const { snapshotNonce, terminalSessions, workspaces, agentStateByWorkspaceId, pendingDialogIdsByWorkspace } = params;

  const projectsById: Record<string, MachineProjectRecord> = {};
  const projectOrder: string[] = [];
  const workspaceIdsByProjectId: Record<string, string[]> = {};

  for (const project of listProjectSummaries()) {
    projectsById[project.name] = {
      id: project.name,
      name: project.name,
      repository: project.repository,
      isCurrent: project.isCurrent,
      workspaceIds: [],
      workspaceCount: project.workspaceCount,
    };
    projectOrder.push(project.name);
    workspaceIdsByProjectId[project.name] = [];
  }

  const {
    goalsById,
    goalOrder,
    goalIdsByProjectId,
    goalByWorkspace,
  } = listGoalsForSnapshot(projectOrder);


  const workspacesById: Record<string, MachineWorkspaceRecord> = {};
  const workspaceOrder: string[] = [];
  const workspacePmSnapshot = getWorkspacePmSnapshot(workspaces);

  for (const workspace of workspaces) {
    const record = cloneWorkspaceRecord(workspace);
    const pmState = workspacePmSnapshot[workspace.id];
    if (pmState) {
      record.pullRequest = pmState.pullRequest;
      record.linear = pmState.linear;
    }
    const goal = goalByWorkspace.get(`${record.projectId}:${record.name}`);
    if (goal) {
      record.goal = goal;
      record.phase = goal.phase;
    }
    workspacesById[record.id] = record;
    workspaceOrder.push(record.id);
    workspaceIdsByProjectId[record.projectId] = [...(workspaceIdsByProjectId[record.projectId] ?? []), record.id];
    if (projectsById[record.projectId]) {
      projectsById[record.projectId] = {
        ...projectsById[record.projectId],
        workspaceIds: [...projectsById[record.projectId].workspaceIds, record.id],
      };
    }
  }

  const terminalSessionsById: Record<string, MachineTerminalSessionRecord> = {};
  const terminalSessionIdsByWorkspaceId: Record<string, string[]> = {};
  const processesById: Record<string, MachineProcessRecord> = {};
  const processIdsByWorkspaceId: Record<string, string[]> = {};

  for (const session of terminalSessions) {
    const terminalRecord = buildTerminalRecord(session, workspacesById);
    const workspaceId = terminalRecord.workspaceId;
    const projectId = terminalRecord.projectId;
    terminalSessionsById[session.id] = terminalRecord;
    if (workspaceId && terminalRecord.kind !== 'agent') {
      terminalSessionIdsByWorkspaceId[workspaceId] = [
        ...(terminalSessionIdsByWorkspaceId[workspaceId] ?? []),
        session.id,
      ];
      workspacesById[workspaceId] = {
        ...workspacesById[workspaceId],
        terminalSessionIds: [...workspacesById[workspaceId].terminalSessionIds, session.id],
      };
      if (terminalRecord.processName) {
        const processId = `${workspaceId}:${terminalRecord.processName}:${terminalRecord.processInstance ?? 1}`;
        const nextStatus: MachineProcessRecord['status'] = session.exitCode === undefined
          ? 'running'
          : session.exitCode === 0
            ? 'stopped'
            : 'failed';
        const existing = processesById[processId];
        processesById[processId] = {
          id: processId,
          workspaceId,
          projectId: projectId ?? workspacesById[workspaceId]?.projectId ?? '',
          name: terminalRecord.processName,
          instance: terminalRecord.processInstance,
          status: existing?.status === 'running' ? existing.status : nextStatus,
          terminalSessionId: session.id,
          errorMessage: nextStatus === 'failed' ? `Exit ${session.exitCode}` : undefined,
        };
        processIdsByWorkspaceId[workspaceId] = [
          ...(processIdsByWorkspaceId[workspaceId] ?? []).filter((id) => id !== processId),
          processId,
        ];
        workspacesById[workspaceId] = {
          ...workspacesById[workspaceId],
          processIds: [...workspacesById[workspaceId].processIds.filter((id) => id !== processId), processId],
        };
      }
    }
  }

  const agentSessionsById: Record<string, MachineAgentSessionRecord> = {};
  const agentSessionIdsByWorkspaceId: Record<string, string[]> = {};
  const archivedMoreCountByWorkspaceId: Record<string, number> = {};

  for (const [workspaceId, workspace] of Object.entries(agentStateByWorkspaceId)) {
    // Project agents live on the '<project>:@base' pseudo-workspace (no
    // scanner record) — pass their sessions through so transcripts render.
    const projectId = workspacesById[workspaceId]?.projectId
      ?? (workspaceId.endsWith(':@base') ? workspaceId.slice(0, -':@base'.length) : undefined);
    if (projectId === undefined) continue;
    const { records, archivedMoreCount } = buildAgentSessionRecordsForWorkspace({
      workspaceId,
      projectId,
      workspace,
      terminalSessionsById,
      pendingDialogIdsBySession: pendingDialogIdsByWorkspace?.[workspaceId],
    });
    archivedMoreCountByWorkspaceId[workspaceId] = archivedMoreCount;
    for (const record of records) {
      agentSessionsById[record.id] = record;
      agentSessionIdsByWorkspaceId[workspaceId] = [...(agentSessionIdsByWorkspaceId[workspaceId] ?? []), record.id];
      // '@base' pseudo-workspaces have no scanner record in the map — their
      // sessions still land in agentSessionsById (transcripts/lists), but
      // only real workspace records carry agentSessionIds.
      if (workspacesById[workspaceId]) {
        workspacesById[workspaceId] = {
          ...workspacesById[workspaceId],
          agentSessionIds: [...workspacesById[workspaceId].agentSessionIds, record.id],
        };
      }
    }
  }

  for (const [workspaceId, workspaceRecord] of Object.entries(workspacesById)) {
    const agentIds = agentSessionIdsByWorkspaceId[workspaceId] ?? [];
    const agents = agentIds
      .map((agentId) => agentSessionsById[agentId])
      .filter((agent): agent is MachineAgentSessionRecord => !!agent);

    workspacesById[workspaceId] = {
      ...workspaceRecord,
      summary: {
        ...workspaceRecord.summary,
        ...computeAgentSummaryCounts(agents),
        agentCount: agentIds.length,
        archivedMoreCount: archivedMoreCountByWorkspaceId[workspaceId] ?? 0,
      },
    };
  }

  return enforceSnapshotSizeBudget({
    snapshotNonce,
    generatedAt: new Date().toISOString(),
    projectsById,
    projectOrder,
    workspacesById,
    workspaceOrder,
    workspaceIdsByProjectId,
    goalsById,
    goalOrder,
    goalIdsByProjectId,
    terminalSessionsById,
    terminalSessionIdsByWorkspaceId,
    agentSessionsById,
    agentSessionIdsByWorkspaceId,
    processesById,
    processIdsByWorkspaceId,
    replaysById: {},
    replayIdsByWorkspaceId: {},
    notificationsById: {},
    notificationOrder: [],
  });
}
