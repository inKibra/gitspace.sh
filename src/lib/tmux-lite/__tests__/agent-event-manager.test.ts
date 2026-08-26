import { describe, expect, it } from 'bun:test';

import { AgentEventManager, computeSessionActivity, type AgentStateUpdateDelta, type WorkspaceAgentState } from '../agent-event-manager.js';
import { determineAgentState, type SessionActivity } from '../../../agents/agent-runtime-types.js';
import { applyAgentDeltaToAgentState, applyTranscriptDelta } from '../agent-state-reducer.js';

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
      {
        type: 'agent_workspace_snapshot',
        workspaceId: 'workspace-1',
        workspace: harness.manager.getSnapshot()['workspace-1']!,
      },
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
    expect(deltas.at(-1)).toEqual({
      type: 'agent_workspace_snapshot',
      workspaceId: 'workspace-1',
      workspace: harness.manager.getSnapshot()['workspace-1']!,
    });
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
  it('streams append-only text patches instead of rebroadcasting the growing block', () => {
    const harness = createManager();
    const deltas = collectDeltas(harness.manager);
    const block = (text: string) => ({
      id: 'assistant-1',
      type: 'message',
      data: { role: 'assistant', text },
    });

    harness.manager.emitTranscriptLive('workspace-1', 'session-1', [block('a')], false);
    harness.manager.emitTranscriptLive('workspace-1', 'session-1', [block('ab')], false);
    harness.manager.emitTranscriptLive('workspace-1', 'session-1', [block('abc')], false);

    const transcriptDeltas = deltas.filter(
      (delta): delta is Extract<AgentStateUpdateDelta, { type: 'agent_transcript_delta' }> =>
        delta.type === 'agent_transcript_delta',
    );
    expect(transcriptDeltas).toHaveLength(3);
    expect(transcriptDeltas[0]?.upserts).toEqual([block('a')]);
    expect(transcriptDeltas[1]).toMatchObject({
      upserts: [],
      appends: [{ id: 'assistant-1', field: 'text', text: 'b' }],
      order: ['assistant-1'],
    });
    expect(transcriptDeltas[2]?.appends).toEqual([{ id: 'assistant-1', field: 'text', text: 'c' }]);

    const reconstructed = transcriptDeltas.reduce(applyTranscriptDelta, []);
    expect(reconstructed).toEqual([block('abc')]);

    harness.manager.emitTranscriptLive('workspace-1', 'session-1', [], true);
    expect(applyTranscriptDelta(reconstructed, deltas.at(-1) as typeof transcriptDeltas[number])).toEqual([]);
  });

  it('bounds structured live tool payloads while committed history remains authoritative', () => {
    const harness = createManager();
    const deltas = collectDeltas(harness.manager);
    harness.manager.emitTranscriptLive('workspace-1', 'session-1', [{
      id: 'tool-1',
      type: 'tool-call',
      data: {
        tool: 'read',
        status: 'done',
        details: { text: 'x'.repeat(100_000) },
      },
    }], false);

    const delta = deltas.at(-1);
    expect(delta?.type).toBe('agent_transcript_delta');
    if (delta?.type !== 'agent_transcript_delta') throw new Error('expected transcript delta');
    const data = delta.upserts[0]?.data;
    if (!data || typeof data !== 'object' || !('details' in data)) throw new Error('expected bounded details');
    const details = data.details;
    if (!details || typeof details !== 'object' || !('truncated' in details) || !('originalChars' in details)) {
      throw new Error('expected truncation metadata');
    }
    expect(details.truncated).toBe(true);
    expect(details.originalChars).toBeGreaterThan(100_000);
    expect(JSON.stringify(delta).length).toBeLessThan(20_000);
  });

});

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
describe('computeSessionActivity', () => {

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

describe('determineAgentState', () => {
  const idle: SessionActivity = { active: false, reasons: [] };

  it('reports a session discovered on disk as dormant, not waiting', () => {
    // The relay client kept its own copy of this ladder without the dormant
    // branch, so every seeded session rendered blue ('waiting') in the browser
    // while the daemon called it dormant. Both builders now share this function.
    expect(determineAgentState(idle, { dormantSince: '2026-01-01T00:00:00Z' }, undefined)).toBe('dormant');
  });

  it('orders lifecycle ahead of activity', () => {
    const busy = { active: true, reasons: [{ kind: 'turn' } as const] };
    expect(determineAgentState(busy, { archivedAt: 'a', closedAt: 'c', dormantSince: 'd' }, undefined)).toBe('archived');
    expect(determineAgentState(busy, { closedAt: 'c', dormantSince: 'd' }, undefined)).toBe('closed');
    expect(determineAgentState(busy, { dormantSince: 'd' }, undefined)).toBe('dormant');
  });

  it('projects activity onto the coarse label once no lifecycle field applies', () => {
    expect(determineAgentState(idle, {}, undefined)).toBe('waiting');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'turn' }] }, {}, undefined)).toBe('running');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'compacting' }] }, {}, undefined)).toBe('running');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'human', questions: 1, permissions: 0 }] }, {}, undefined)).toBe('permission-needed');
    expect(determineAgentState(idle, {}, 'boom')).toBe('retrying');
  });

  it('does not paint an agent as running for work it merely owes', () => {
    // 'queued' and 'subagents' mean owed, not executing.
    expect(determineAgentState({ active: true, reasons: [{ kind: 'queued', steering: 1, followUp: 0 }] }, {}, undefined)).toBe('waiting');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'subagents', count: 3 }] }, {}, undefined)).toBe('waiting');
  });
});

describe('agent workspace snapshots', () => {
  it('replaces only the affected workspace', () => {
    const alpha = stateWith({ workspaceId: 'alpha' });
    const beta = stateWith({ workspaceId: 'beta' });
    const updatedAlpha = stateWith({
      workspaceId: 'alpha',
      sessions: [{ id: 'session-1', title: 'Updated' }],
    });

    expect(applyAgentDeltaToAgentState(
      { alpha, beta },
      { type: 'agent_workspace_snapshot', workspaceId: 'alpha', workspace: updatedAlpha },
    )).toEqual({ alpha: updatedAlpha, beta });
  });
});
