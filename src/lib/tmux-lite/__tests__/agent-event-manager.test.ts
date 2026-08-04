import { describe, expect, it } from 'bun:test';

import { AgentEventManager, computeSessionActivity, type AgentStateUpdateDelta, type WorkspaceAgentState } from '../agent-event-manager.js';

function createManager() {
  let now = 1_000;
  let nextHandle = 1;
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  const manager = new AgentEventManager({
    lastMessageEmitIntervalMs: 100,
    now: () => now,
    setTimeout: (callback, delay) => {
      const handle = nextHandle++;
      delays.push(delay);
      timers.set(handle, callback);
      return handle as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as unknown as number);
    },
  });
  return {
    manager,
    delays,
    advance(ms: number) {
      now += ms;
    },
    runNextTimer() {
      const [handle, callback] = timers.entries().next().value ?? [];
      if (handle === undefined || !callback) throw new Error('No pending timer');
      timers.delete(handle);
      callback();
    },
    get pendingTimerCount() {
      return timers.size;
    },
  };
}

function collectDeltas(manager: AgentEventManager): AgentStateUpdateDelta[] {
  const deltas: AgentStateUpdateDelta[] = [];
  manager.subscribe((delta) => deltas.push(delta));
  return deltas;
}

describe('AgentEventManager', () => {
  it('coalesces streaming last-message deltas while keeping the latest preview', () => {
    const harness = createManager();
    const deltas = collectDeltas(harness.manager);
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');

    harness.manager.setExternalLastMessage('workspace-1', 'session-1', 'first');
    harness.manager.setExternalLastMessage('workspace-1', 'session-1', 'second');
    harness.manager.setExternalLastMessage('workspace-1', 'session-1', 'third');

    expect(deltas).toEqual([
      { type: 'agent_state_snapshot', workspaces: harness.manager.getSnapshot() },
      { type: 'agent_last_message', workspaceId: 'workspace-1', sessionId: 'session-1', preview: 'first' },
    ]);
    expect(harness.delays).toEqual([100]);
    expect(harness.pendingTimerCount).toBe(1);

    harness.advance(100);
    harness.runNextTimer();

    expect(deltas.at(-1)).toEqual({
      type: 'agent_last_message',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      preview: 'third',
    });
    expect(harness.pendingTimerCount).toBe(0);
  });

  it('cancels pending last-message emissions when a session closes', () => {
    const harness = createManager();
    const deltas = collectDeltas(harness.manager);
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');

    harness.manager.setExternalLastMessage('workspace-1', 'session-1', 'first');
    harness.manager.setExternalLastMessage('workspace-1', 'session-1', 'second');
    expect(harness.pendingTimerCount).toBe(1);

    harness.manager.markSessionClosed('workspace-1', 'session-1');
    expect(harness.pendingTimerCount).toBe(0);

    harness.advance(100);
    expect(() => harness.runNextTimer()).toThrow('No pending timer');
    expect(deltas.filter((delta) => delta.type === 'agent_last_message')).toEqual([
      { type: 'agent_last_message', workspaceId: 'workspace-1', sessionId: 'session-1', preview: 'first' },
    ]);
  });

  it('does not reintroduce archived sessions during sync', () => {
    const harness = createManager();
    const deltas = collectDeltas(harness.manager);
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');

    harness.manager.syncKnownSessions('workspace-1', [
      { id: 'session-1', title: 'Active session', updatedAt: '2026-05-12T00:00:00.000Z' },
    ]);
    expect(harness.manager.getSnapshot()['workspace-1']?.sessions.map((session) => session.id)).toEqual(['session-1']);

    harness.manager.markSessionArchived('workspace-1', 'session-1');
    harness.manager.syncKnownSessions('workspace-1', [
      { id: 'session-1', title: 'Active session', updatedAt: '2026-05-12T00:00:01.000Z' },
    ]);

    expect(harness.manager.getSnapshot()['workspace-1']?.sessions).toEqual([]);
    expect(deltas.at(-1)).toEqual({ type: 'agent_state_snapshot', workspaces: harness.manager.getSnapshot() });
  });

  it('closing a session clears frozen retry + error', () => {
    // Retiring a session must drop the transient per-session state, which
    // describes a LIVE worker — otherwise the card renders a stale red.
    const harness = createManager();
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');

    harness.manager.setExternalStatus('workspace-1', 'session-1', {
      type: 'retry',
      attempt: 2,
      message: 'rate limit',
      next: 0,
    });
    harness.manager.setExternalError('workspace-1', 'session-1', 'rate limit');
    expect(harness.manager.getSnapshot()['workspace-1']?.statuses['session-1']?.type).toBe('retry');
    expect(harness.manager.getSnapshot()['workspace-1']?.errorMessages['session-1']).toBe('rate limit');

    harness.manager.markSessionClosed('workspace-1', 'session-1');

    const state = harness.manager.getSnapshot()['workspace-1'];
    expect(state?.statuses['session-1']).toBeUndefined();
    expect(state?.errorMessages['session-1']).toBeUndefined();
    expect(state?.sessions.find((s) => s.id === 'session-1')?.closedAt).toBeDefined();
  });

  it('emits every failure attempt: identical consecutive errors carry increasing errorSeq', () => {
    const harness = createManager();
    const deltas = collectDeltas(harness.manager);
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');

    harness.manager.setExternalError('workspace-1', 'session-1', 'prompt failed');
    harness.manager.setExternalError('workspace-1', 'session-1', 'prompt failed');

    const errors = deltas.filter((delta) => delta.type === 'agent_session_error');
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      errorMessage: 'prompt failed',
    });
    const first = errors[0] as Extract<AgentStateUpdateDelta, { type: 'agent_session_error' }>;
    const second = errors[1] as Extract<AgentStateUpdateDelta, { type: 'agent_session_error' }>;
    expect(typeof first.errorSeq).toBe('number');
    expect(second.errorSeq!).toBeGreaterThan(first.errorSeq!);
    expect(harness.manager.getSnapshot()['workspace-1']?.errorMessages['session-1']).toBe('prompt failed');
  });

  it('rejects invalid last-message coalescing intervals', () => {
    expect(() => new AgentEventManager({ lastMessageEmitIntervalMs: Number.NaN })).toThrow(
      'lastMessageEmitIntervalMs must be a non-negative finite number',
    );
  });

  it('distinguishes dormant (no worker) from closed (dismissed)', () => {
    // One field used to mean both, so a session that merely had no live worker
    // was indistinguishable from one the user deliberately closed.
    const harness = createManager();
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');
    harness.manager.setExternalStatus('workspace-1', 'dormant-session', { type: 'idle' });
    harness.manager.setExternalStatus('workspace-1', 'closed-session', { type: 'idle' });

    harness.manager.markSessionDormant('workspace-1', 'dormant-session');
    harness.manager.markSessionClosed('workspace-1', 'closed-session');

    const sessions = harness.manager.getSnapshot()['workspace-1']?.sessions ?? [];
    const dormant = sessions.find((session) => session.id === 'dormant-session');
    const closed = sessions.find((session) => session.id === 'closed-session');
    expect(dormant?.dormantSince).toBeDefined();
    expect(dormant?.closedAt).toBeUndefined();
    expect(closed?.closedAt).toBeDefined();
    expect(closed?.dormantSince).toBeUndefined();
  });

  it('reopening clears both retirement markers', () => {
    const harness = createManager();
    harness.manager.registerWorkspace('workspace-1', '/tmp/workspace-1');
    harness.manager.setExternalStatus('workspace-1', 'session-1', { type: 'idle' });
    harness.manager.markSessionDormant('workspace-1', 'session-1');

    harness.manager.markSessionOpen('workspace-1', 'session-1');

    const session = harness.manager.getSnapshot()['workspace-1']?.sessions.find((s) => s.id === 'session-1');
    expect(session?.dormantSince).toBeUndefined();
    expect(session?.closedAt).toBeUndefined();
  });
});

describe('computeSessionActivity', () => {
  function stateWith(overrides: Partial<WorkspaceAgentState>): WorkspaceAgentState {
    return {
      workspaceId: 'workspace-1',
      sessions: [{ id: 'session-1', title: 'Session' }],
      statuses: {},
      pendingPermissions: {},
      pendingQuestions: {},
      lastMessages: {},
      errorMessages: {},
      todoPhases: {},
      modelInfo: {},
      queuedMessages: {},
      subagentCounts: {},
      ...overrides,
    };
  }

  it('reports inactive only when the session owes nothing', () => {
    const activity = computeSessionActivity(stateWith({ statuses: { 'session-1': { type: 'idle' } } }), 'session-1');
    expect(activity).toEqual({ active: false, reasons: [] });
  });

  it('treats compacting as active work, not idle', () => {
    // This is the divergence that made a compacting agent render as idle in two
    // separate places before activity became the single producer.
    const activity = computeSessionActivity(stateWith({ statuses: { 'session-1': { type: 'compacting' } } }), 'session-1');
    expect(activity.active).toBe(true);
    expect(activity.reasons).toEqual([{ kind: 'compacting' }]);
  });

  it('is active while waiting on a human even with no turn in flight', () => {
    const activity = computeSessionActivity(stateWith({
      pendingQuestions: { 'session-1': [{ id: 'q1', sessionID: 'session-1', questions: [] }] },
    }), 'session-1');
    expect(activity.active).toBe(true);
    expect(activity.reasons).toEqual([{ kind: 'human', questions: 1, permissions: 0 }]);
  });

  it('is active while subagents are still running', () => {
    // The case no status can express: this session's own turn ended, but the
    // children it spawned are still working, so it is not idle.
    const activity = computeSessionActivity(stateWith({
      statuses: { 'session-1': { type: 'idle' } },
      subagentCounts: { 'session-1': 3 },
    }), 'session-1');
    expect(activity.active).toBe(true);
    expect(activity.reasons).toEqual([{ kind: 'subagents', count: 3 }]);
  });

  it('is active while a queued message is unconsumed', () => {
    const activity = computeSessionActivity(stateWith({
      queuedMessages: { 'session-1': { steering: ['tighten scope'], followUp: [] } },
    }), 'session-1');
    expect(activity.reasons).toEqual([{ kind: 'queued', steering: 1, followUp: 0 }]);
  });

  it('lists every concurrent reason, turn first', () => {
    const activity = computeSessionActivity(stateWith({
      statuses: { 'session-1': { type: 'busy' } },
      pendingPermissions: { 'session-1': [{
        id: 'p1', type: 'permission', sessionID: 'session-1', messageID: '', title: 'Allow?', metadata: {}, time: { created: 0 },
      }] },
      subagentCounts: { 'session-1': 2 },
    }), 'session-1');
    expect(activity.reasons.map((reason) => reason.kind)).toEqual(['turn', 'human', 'subagents']);
  });

  it('treats a sparse state (wire-reconstructed) as owing nothing', () => {
    // Snapshot-reconstructed states can omit maps entirely; that must read as
    // "nothing of that kind", never throw.
    const sparse = { workspaceId: 'workspace-1', sessions: [] } as unknown as WorkspaceAgentState;
    expect(computeSessionActivity(sparse, 'session-1')).toEqual({ active: false, reasons: [] });
  });
});
