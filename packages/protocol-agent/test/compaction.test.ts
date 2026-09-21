import { expect, test } from 'bun:test';
import { computeSessionActivity, sessionStatusFromActivity, transitionAgentExecution, type AgentExecutionState } from '../src/index.js';

const idle: AgentExecutionState = { status: { type: 'idle' }, turnActive: false, failure: null };
const sessionId = 'session';

test('pre-prompt and background compaction survive turn start/end and legacy method terminal events', () => {
  let state = transitionAgentExecution(idle, { type: 'compaction_state', sessionId, active: true, detail: 'Background soft' }, 0);
  for (const type of ['agent_start', 'agent_end', 'auto_compaction_end', 'auto_compaction_start']) {
    state = transitionAgentExecution(state, { type, sessionId }, 1);
    expect(computeSessionActivity({ statuses: { [sessionId]: state.status } }, sessionId)).toEqual({
      active: true, reasons: [{ kind: 'compacting', detail: 'Background soft' }],
    });
  }
  state = transitionAgentExecution(state, { type: 'compaction_state', sessionId, active: true, detail: 'Automatic soft · provider/model · attempt 2' }, 2);
  expect(sessionStatusFromActivity(computeSessionActivity({ statuses: { [sessionId]: state.status } }, sessionId))).toEqual(state.status);
  state = transitionAgentExecution(state, { type: 'compaction_state', sessionId, active: false }, 3);
  expect(state.status).toEqual({ type: 'idle' });
});

test('finishing maintenance restores an overlapping turn or execution retry rather than guessing idle', () => {
  let state = transitionAgentExecution(idle, { type: 'compaction_state', sessionId, active: true }, 0);
  state = transitionAgentExecution(state, { type: 'agent_start', sessionId }, 1);
  expect(transitionAgentExecution(state, { type: 'compaction_state', sessionId, active: false }, 2).status).toEqual({ type: 'busy' });
  state = transitionAgentExecution(state, { type: 'auto_retry_start', sessionId, attempt: 2, delayMs: 500, message: 'Rate limited' }, 10);
  expect(state.status.type).toBe('compacting');
  const settled = transitionAgentExecution(state, { type: 'compaction_state', sessionId, active: false }, 20);
  expect(settled.status).toEqual({ type: 'retry', attempt: 2, message: 'Rate limited', next: 510 });
  expect(settled.failure?.message).toBe('Rate limited');
});

test('manual cancellation reconciles a disconnected turn without erasing execution failure', () => {
  let state = transitionAgentExecution(idle, { type: 'agent_start', sessionId }, 0);
  state = transitionAgentExecution(state, { type: 'message_end', sessionId, succeeded: false, message: 'Provider failed' }, 1);
  state = transitionAgentExecution(state, { type: 'compaction_state', sessionId, active: true }, 2);
  // Manual SDK compaction disconnects the agent listener before aborting the turn.
  state = transitionAgentExecution(state, { type: 'compaction_state', sessionId, active: false, turnActive: false }, 3);
  expect(state.status).toEqual({ type: 'idle' });
  expect(state.turnActive).toBe(false);
  expect(state.failure?.message).toBe('Provider failed');
});

test('retry failure or recovery cannot end active compaction', () => {
  let state = transitionAgentExecution(idle, { type: 'compaction_state', sessionId, active: true }, 0);
  state = transitionAgentExecution(state, { type: 'auto_retry_end', sessionId, succeeded: false }, 1);
  expect(state.status.type).toBe('compacting');
  expect(state.failure?.code).toBe('AGENT_EXECUTION_FAILED');
  state = transitionAgentExecution(state, { type: 'auto_retry_end', sessionId, succeeded: true }, 2);
  expect(state.status.type).toBe('compacting');
  expect(state.failure).toBeNull();
});
