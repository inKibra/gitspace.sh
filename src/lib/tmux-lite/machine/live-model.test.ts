import { describe, expect, it } from 'bun:test';
import type { Session } from '../protocol.js';
import type { WorkspaceAgentState } from '../agent-event-manager.js';
import type { MachineGoalRecord, MachineSnapshot, MachineWorkspaceRecord } from './types.js';
import {
  computeAgentWorkspaceDeltaEvents,
  computeProjectGoalsDeltaEvents,
  computeTerminalDeltaEvents,
} from './live-model.js';
import { applyMachineEventToSnapshot } from './snapshot-patch.js';

function makeWorkspaceRecord(overrides: Partial<MachineWorkspaceRecord> = {}): MachineWorkspaceRecord {
  return {
    id: 'demo:ws-1',
    name: 'ws-1',
    projectId: 'demo',
    projectName: 'demo',
    path: '/tmp/demo/ws-1',
    phase: 'code',
    terminalSessionIds: [],
    agentSessionIds: [],
    processIds: [],
    replayIds: [],
    summary: {
      terminalCount: 0,
      attachedTerminalCount: 0,
      runningTerminalCount: 0,
      failedTerminalCount: 0,
      agentCount: 0,
      runningAgentCount: 0,
      waitingAgentCount: 0,
      permissionAgentCount: 0,
      retryingAgentCount: 0,
      closedAgentCount: 0,
      archivedAgentCount: 0,
      configuredProcessCount: 0,
      runningProcessCount: 0,
      failedProcessCount: 0,
    },
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MachineSnapshot> = {}): MachineSnapshot {
  const workspace = makeWorkspaceRecord();
  return {
    snapshotNonce: 5,
    generatedAt: new Date().toISOString(),
    projectsById: {
      demo: { id: 'demo', name: 'demo', repository: 'org/demo', isCurrent: true, workspaceIds: [workspace.id], workspaceCount: 1 },
    },
    projectOrder: ['demo'],
    workspacesById: { [workspace.id]: workspace },
    workspaceOrder: [workspace.id],
    workspaceIdsByProjectId: { demo: [workspace.id] },
    goalsById: {},
    goalOrder: [],
    goalIdsByProjectId: { demo: [] },
    terminalSessionsById: {},
    terminalSessionIdsByWorkspaceId: {},
    agentSessionsById: {},
    agentSessionIdsByWorkspaceId: {},
    processesById: {},
    processIdsByWorkspaceId: {},
    replaysById: {},
    replayIdsByWorkspaceId: {},
    notificationsById: {},
    notificationOrder: [],
    ...overrides,
  };
}

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'pty-1',
    name: 'shell-1',
    socketPath: '/tmp/pty-1.sock',
    pid: 42,
    attached: false,
    cwd: '/tmp/demo/ws-1',
    createdAt: Date.now(),
    metadata: { workspaceId: 'demo:ws-1' },
    ...overrides,
  } as Session;
}

function applyAll(snapshot: MachineSnapshot, events: ReturnType<typeof computeTerminalDeltaEvents>): MachineSnapshot {
  let nonce = snapshot.snapshotNonce;
  let next = snapshot;
  for (const event of events) {
    nonce += 1;
    (event as { snapshotNonce: number }).snapshotNonce = nonce;
    next = applyMachineEventToSnapshot(next, event);
  }
  return next;
}

describe('computeTerminalDeltaEvents', () => {
  it('emits an upsert + workspace refresh for a created session', () => {
    const snapshot = makeSnapshot();
    const events = computeTerminalDeltaEvents(snapshot, 'pty-1', makeSession());

    expect(events.map((event) => event.type)).toEqual(['terminal-session-upserted', 'workspace-derived-replaced']);

    const next = applyAll(snapshot, events);
    expect(next.terminalSessionsById['pty-1']?.workspaceId).toBe('demo:ws-1');
    expect(next.terminalSessionIdsByWorkspaceId['demo:ws-1']).toEqual(['pty-1']);
    const workspace = next.workspacesById['demo:ws-1'];
    expect(workspace.terminalSessionIds).toEqual(['pty-1']);
    expect(workspace.summary.terminalCount).toBe(1);
    expect(workspace.summary.runningTerminalCount).toBe(1);
  });

  it('is a no-op when the session record is unchanged', () => {
    const snapshot = makeSnapshot();
    const session = makeSession();
    const next = applyAll(snapshot, computeTerminalDeltaEvents(snapshot, 'pty-1', session));
    expect(computeTerminalDeltaEvents(next, 'pty-1', session)).toEqual([]);
  });

  it('emits removal + workspace refresh when the session is gone', () => {
    const base = makeSnapshot();
    const session = makeSession();
    const withSession = applyAll(base, computeTerminalDeltaEvents(base, 'pty-1', session));

    const events = computeTerminalDeltaEvents(withSession, 'pty-1', null);
    expect(events.map((event) => event.type)).toEqual(['terminal-session-removed', 'workspace-derived-replaced']);

    const next = applyAll(withSession, events);
    expect(next.terminalSessionsById['pty-1']).toBeUndefined();
    expect(next.terminalSessionIdsByWorkspaceId['demo:ws-1']).toEqual([]);
    expect(next.workspacesById['demo:ws-1'].summary.terminalCount).toBe(0);
  });

  it('derives process records for process-named sessions', () => {
    const snapshot = makeSnapshot();
    const session = makeSession({
      id: 'pty-proc',
      name: 'proc:ws-1:web:1',
      metadata: { workspaceId: 'demo:ws-1', processName: 'web', processInstance: '1' },
    });
    const events = computeTerminalDeltaEvents(snapshot, 'pty-proc', session);
    expect(events.map((event) => event.type)).toContain('process-upserted');

    const next = applyAll(snapshot, events);
    const processId = 'demo:ws-1:web:1';
    expect(next.processesById[processId]?.status).toBe('running');
    expect(next.processIdsByWorkspaceId['demo:ws-1']).toEqual([processId]);

    // Session exits non-zero → process fails; removal drops the record.
    const exited = { ...session, exitCode: 3 } as Session;
    const afterExit = applyAll(next, computeTerminalDeltaEvents(next, 'pty-proc', exited));
    expect(afterExit.processesById[processId]?.status).toBe('failed');

    const afterRemoval = applyAll(afterExit, computeTerminalDeltaEvents(afterExit, 'pty-proc', null));
    expect(afterRemoval.processesById[processId]).toBeUndefined();
  });
});

describe('computeAgentWorkspaceDeltaEvents', () => {
  function makeAgentState(status: 'busy' | 'idle' = 'idle'): WorkspaceAgentState {
    return {
      workspaceId: 'demo:ws-1',
      sessions: [{ id: 'agent-1', title: 'Agent 1' }],
      statuses: status === 'busy' ? { 'agent-1': { type: 'busy' } } : {},
      pendingPermissions: {},
      pendingQuestions: {},
      lastMessages: {},
      errorMessages: {},
      todoPhases: {},
    } as unknown as WorkspaceAgentState;
  }

  it('emits agent upsert + workspace summary refresh on status change', () => {
    const snapshot = makeSnapshot();
    const created = computeAgentWorkspaceDeltaEvents(snapshot, 'demo:ws-1', makeAgentState('idle'));
    expect(created.map((event) => event.type)).toEqual(['agent-session-upserted', 'workspace-derived-replaced']);

    const withAgent = applyAll(snapshot, created);
    expect(withAgent.agentSessionsById['agent-1']?.state).toBe('waiting');
    expect(withAgent.workspacesById['demo:ws-1'].summary.waitingAgentCount).toBe(1);

    const busy = computeAgentWorkspaceDeltaEvents(withAgent, 'demo:ws-1', makeAgentState('busy'));
    expect(busy.map((event) => event.type)).toEqual(['agent-session-upserted', 'workspace-derived-replaced']);
    const next = applyAll(withAgent, busy);
    expect(next.agentSessionsById['agent-1']?.state).toBe('running');
    expect(next.workspacesById['demo:ws-1'].summary.runningAgentCount).toBe(1);
    expect(next.workspacesById['demo:ws-1'].summary.waitingAgentCount).toBe(0);
  });

  it('is a no-op when nothing changed', () => {
    const snapshot = makeSnapshot();
    const withAgent = applyAll(snapshot, computeAgentWorkspaceDeltaEvents(snapshot, 'demo:ws-1', makeAgentState()));
    expect(computeAgentWorkspaceDeltaEvents(withAgent, 'demo:ws-1', makeAgentState())).toEqual([]);
  });

  it('removes agent records that disappeared', () => {
    const snapshot = makeSnapshot();
    const withAgent = applyAll(snapshot, computeAgentWorkspaceDeltaEvents(snapshot, 'demo:ws-1', makeAgentState()));
    const events = computeAgentWorkspaceDeltaEvents(withAgent, 'demo:ws-1', {
      ...makeAgentState(),
      sessions: [],
    } as unknown as WorkspaceAgentState);
    expect(events.map((event) => event.type)).toEqual(['agent-session-removed', 'workspace-derived-replaced']);
    const next = applyAll(withAgent, events);
    expect(next.agentSessionsById['agent-1']).toBeUndefined();
    expect(next.agentSessionIdsByWorkspaceId['demo:ws-1']).toEqual([]);
  });
});

describe('computeProjectGoalsDeltaEvents', () => {
  function makeGoal(overrides: Partial<MachineGoalRecord> = {}): MachineGoalRecord {
    return {
      id: 'demo:goal-1',
      chainId: 'chain-1',
      chainTitle: 'Chain',
      title: 'Ship it',
      projectName: 'demo',
      phase: 'code',
      workspaceName: 'ws-1',
      status: 'workspace-backed',
      chainPosition: 0,
      chainLength: 1,
      ...overrides,
    };
  }

  it('replaces the project goal set and refreshes bound workspaces', () => {
    const snapshot = makeSnapshot();
    const goal = makeGoal();
    const events = computeProjectGoalsDeltaEvents(snapshot, 'demo', [goal]);
    expect(events.map((event) => event.type)).toEqual(['project-goals-replaced', 'workspace-upserted']);

    const next = applyAll(snapshot, events);
    expect(next.goalsById?.['demo:goal-1']?.title).toBe('Ship it');
    expect(next.goalOrder).toEqual(['demo:goal-1']);
    expect(next.goalIdsByProjectId?.demo).toEqual(['demo:goal-1']);
    expect(next.workspacesById['demo:ws-1'].goal?.id).toBe('demo:goal-1');
    expect(next.workspacesById['demo:ws-1'].phase).toBe('code');

    // Phase moves (a CLI goal.json write) → scoped refresh updates both maps.
    const review = makeGoal({ phase: 'review' });
    const phaseEvents = computeProjectGoalsDeltaEvents(next, 'demo', [review]);
    expect(phaseEvents.map((event) => event.type)).toEqual(['project-goals-replaced', 'workspace-upserted']);
    const after = applyAll(next, phaseEvents);
    expect(after.goalsById?.['demo:goal-1']?.phase).toBe('review');
    expect(after.workspacesById['demo:ws-1'].phase).toBe('review');
    expect(after.workspacesById['demo:ws-1'].goal?.phase).toBe('review');
  });

  it('is a no-op when the goal set is unchanged', () => {
    const snapshot = makeSnapshot();
    const goal = makeGoal();
    const next = applyAll(snapshot, computeProjectGoalsDeltaEvents(snapshot, 'demo', [goal]));
    expect(computeProjectGoalsDeltaEvents(next, 'demo', [makeGoal()])).toEqual([]);
  });

  it('applies a slim-shape goal record (ticket #42) through the delta round-trip', () => {
    const snapshot = makeSnapshot();
    // The slim snapshot projection: readiness + requirement status only,
    // empty event/review trails, stripped doc body.
    const slim = makeGoal({
      updatedAt: '2026-01-01T00:00:00.000Z',
      doc: { bodyMarkdown: '', updatedAt: '2026-01-01T00:00:00.000Z' },
      validation: {
        reqOrder: ['r1'],
        requirements: {
          r1: {
            id: 'r1', title: 'Tests', kind: 'test-output', required: true, rubric: 'green',
            status: 'accepted', generation: { kind: 'manual' }, judgment: { kind: 'human' },
            evidence: [], reviews: [],
          },
        },
        events: [],
        readiness: { status: 'ready', summary: 'Ready', detail: 'ok', totals: { total: 1, missing: 0, review: 0, accepted: 1 } },
      },
    });
    const next = applyAll(snapshot, computeProjectGoalsDeltaEvents(snapshot, 'demo', [slim]));
    const applied = next.goalsById?.['demo:goal-1'];
    expect(applied?.validation?.readiness?.totals.accepted).toBe(1);
    expect(applied?.validation?.requirements['r1'].status).toBe('accepted');
    expect(applied?.validation?.events).toEqual([]);
    expect(applied?.doc?.bodyMarkdown).toBe('');
    // Bound workspace record picks up the slim goal + its phase.
    expect(next.workspacesById['demo:ws-1'].goal?.validation?.events).toEqual([]);
  });
});

describe('applyMachineEventToSnapshot forward compatibility', () => {
  it('keeps state (and advances the nonce) on unknown event types', () => {
    const snapshot = makeSnapshot();
    const next = applyMachineEventToSnapshot(
      snapshot,
      { type: 'some-future-event', snapshotNonce: 6 } as never,
    );
    expect(next.snapshotNonce).toBe(6);
    expect(next.workspacesById['demo:ws-1']).toBeDefined();
  });
});
