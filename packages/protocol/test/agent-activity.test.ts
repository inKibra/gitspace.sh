import { describe, expect, it } from 'bun:test';
import { computeSessionActivity, determineAgentState, type SessionActivity, type WorkspaceAgentActivityState } from '../src/index.js';

const stateWith = (overrides: WorkspaceAgentActivityState): WorkspaceAgentActivityState => ({
  statuses: {}, pendingPermissions: {}, pendingQuestions: {}, queuedMessages: {}, subagentCounts: {}, ...overrides,
});

describe('computeSessionActivity parity', () => {
  it('is inactive only when nothing is owed', () => {
    expect(computeSessionActivity(stateWith({ statuses: { main: { type: 'idle' } } }), 'main')).toEqual({ active: false, reasons: [] });
  });

  it('treats compaction, human waits, queue, and side agents as active reasons', () => {
    expect(computeSessionActivity(stateWith({ statuses: { main: { type: 'compacting' } } }), 'main').reasons).toEqual([{ kind: 'compacting' }]);
    expect(computeSessionActivity(stateWith({ pendingQuestions: { main: [{}] } }), 'main').reasons).toEqual([{ kind: 'human', questions: 1, permissions: 0 }]);
    expect(computeSessionActivity(stateWith({ queuedMessages: { main: { steering: ['x'], followUp: ['y'] } } }), 'main').reasons).toEqual([{ kind: 'queued', steering: 1, followUp: 1 }]);
    expect(computeSessionActivity(stateWith({ subagentCounts: { main: 3 } }), 'main').reasons).toEqual([{ kind: 'subagents', count: 3 }]);
  });

  it('orders concurrent reasons turn, compaction/retry, human, queue, side agents', () => {
    const activity = computeSessionActivity(stateWith({
      statuses: { main: { type: 'busy' } },
      pendingPermissions: { main: [{}] },
      queuedMessages: { main: { steering: ['x'], followUp: [] } },
      subagentCounts: { main: 2 },
    }), 'main');
    expect(activity.reasons.map((reason) => reason.kind)).toEqual(['turn', 'human', 'queued', 'subagents']);
  });

  it('accepts sparse wire-reconstructed state', () => {
    expect(computeSessionActivity({}, 'main')).toEqual({ active: false, reasons: [] });
  });
});

describe('determineAgentState parity', () => {
  const idle: SessionActivity = { active: false, reasons: [] };

  it('orders lifecycle ahead of activity', () => {
    const busy: SessionActivity = { active: true, reasons: [{ kind: 'turn' }] };
    expect(determineAgentState(busy, { archivedAt: 'a', closedAt: 'c', dormantSince: 'd' }, undefined)).toBe('archived');
    expect(determineAgentState(busy, { closedAt: 'c', dormantSince: 'd' }, undefined)).toBe('closed');
    expect(determineAgentState(busy, { dormantSince: 'd' }, undefined)).toBe('dormant');
  });

  it('maps human, retry, turn, compaction, and waiting exactly', () => {
    expect(determineAgentState(idle, {}, undefined)).toBe('waiting');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'turn' }] }, {}, undefined)).toBe('running');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'compacting' }] }, {}, undefined)).toBe('running');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'human', questions: 1, permissions: 0 }] }, {}, undefined)).toBe('permission-needed');
    expect(determineAgentState(idle, {}, 'boom')).toBe('retrying');
  });

  it('keeps queued and side-agent-only activity waiting instead of green', () => {
    expect(determineAgentState({ active: true, reasons: [{ kind: 'queued', steering: 1, followUp: 0 }] }, {}, undefined)).toBe('waiting');
    expect(determineAgentState({ active: true, reasons: [{ kind: 'subagents', count: 3 }] }, {}, undefined)).toBe('waiting');
  });
});
