import { expect, it } from 'bun:test';
import { AgentHealthStateSchema, beginAgentOperation, currentAgentExecutionFailure, currentAgentFailure, determineAgentState, settleAgentOperation, transitionAgentExecution, type AgentFailure, type AgentHealthState } from '../src/index.js';

const failed: AgentFailure = { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message: 'Provider refused the request', context: { provider: 'test' } };
const outcome = { sessionId: 'session', spaceId: 'space', now: '2026-09-12T00:00:00.000Z' };

it('rejects a late failure after a newer operation succeeded, including an initially healthy issue', () => {
  const initial: AgentHealthState = { revision: 0, issues: {} };
  const old = beginAgentOperation(initial, 'execution', 'old');
  const next = beginAgentOperation(old.state, 'execution', 'next');
  const recovered = settleAgentOperation(next.state, next.token, { ...outcome, failure: null });
  const stale = settleAgentOperation(recovered.state, old.token, { ...outcome, failure: failed });
  const lateSameOperation = settleAgentOperation(stale.state, next.token, { ...outcome, failure: failed });
  expect(currentAgentFailure(lateSameOperation.state)).toBeNull();
  expect(stale.changes).toEqual([]);
  expect(lateSameOperation.changes).toEqual([]);
});

it('clears only the recovered issue and preserves the incident and its matching recovery record', () => {
  const execution = beginAgentOperation({ revision: 0, issues: {} }, 'execution', 'turn');
  const first = settleAgentOperation(execution.state, execution.token, { ...outcome, failure: failed });
  const sync = beginAgentOperation(first.state, 'artifact-sync', 'sync');
  const second = settleAgentOperation(sync.state, sync.token, { ...outcome, failure: { ...failed, code: 'AGENT_ARTIFACT_SYNC_FAILED' } });
  const retry = beginAgentOperation(AgentHealthStateSchema.parse(JSON.parse(JSON.stringify(second.state))), 'execution', 'retry');
  const third = settleAgentOperation(retry.state, retry.token, { ...outcome, failure: null });
  expect(currentAgentExecutionFailure(third.state)).toBeNull();
  expect(currentAgentFailure(third.state)?.code).toBe('AGENT_ARTIFACT_SYNC_FAILED');
  expect(determineAgentState({ active: true, reasons: [{ kind: 'turn' }] }, {}, currentAgentExecutionFailure(third.state))).toBe('running');
  const incident = first.changes[0];
  expect(incident?.type).toBe('occurred');
  expect(third.changes).toMatchObject([{ type: 'recovered', incidentId: incident?.type === 'occurred' ? incident.incident.id : null }]);
  expect(first.changes[0]).toMatchObject({ type: 'occurred', incident: { failure: failed } });
});

it('does not mistake turn completion or restart for recovery from a failed provider request', () => {
  const retry = transitionAgentExecution({ status: { type: 'busy' }, turnActive: true, failure: null }, { type: 'auto_retry_end', sessionId: 'session', succeeded: false, message: failed.message }, 10);
  const ended = transitionAgentExecution(retry, { type: 'agent_end', sessionId: 'session' }, 11);
  const started = transitionAgentExecution(ended, { type: 'agent_start', sessionId: 'session' }, 12);
  expect(started.failure?.code).toBe('AGENT_EXECUTION_FAILED');
  expect(transitionAgentExecution(started, { type: 'message_end', sessionId: 'session', succeeded: true }, 13).failure).toBeNull();
});
