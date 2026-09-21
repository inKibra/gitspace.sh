import type { SessionStatus } from './activity.js';
import type { AgentFailure } from './errors.js';

type TurnStatus = Exclude<SessionStatus, { type: 'compacting' }>;
export interface AgentExecutionState {
  status: SessionStatus;
  turnActive: boolean;
  failure: AgentFailure | null;
  /** Compaction outlives ordinary turn events and may overlap execution retries. */
  compaction?: { detail?: string };
  turnStatus?: TurnStatus;
}
export interface AgentExecutionObservation { type: string; sessionId: string; message?: string; attempt?: number; delayMs?: number; succeeded?: boolean; active?: boolean; turnActive?: boolean; detail?: string }

function withTurnStatus(state: AgentExecutionState, turnStatus: TurnStatus): AgentExecutionState {
  return { ...state, turnStatus, status: state.compaction ? { type: 'compacting', ...state.compaction } : turnStatus };
}

/** Runtime events provide facts; only explicit successful execution clears execution failure. */
export function transitionAgentExecution(state: AgentExecutionState, event: AgentExecutionObservation, now: number): AgentExecutionState {
  switch (event.type) {
    case 'agent_start': return withTurnStatus({ ...state, turnActive: true }, { type: 'busy' });
    case 'agent_end': return withTurnStatus({ ...state, turnActive: false }, { type: 'idle' });
    case 'compaction_state': {
      if (event.active === undefined) return state;
      const turnActive = event.turnActive ?? state.turnActive;
      const previous: TurnStatus = state.turnStatus ?? (state.status.type === 'compacting' ? { type: state.turnActive ? 'busy' : 'idle' } : state.status);
      const turnStatus: TurnStatus = previous.type === 'retry' ? previous : { type: turnActive ? 'busy' : 'idle' };
      return withTurnStatus({
        ...state,
        turnActive,
        compaction: event.active ? (event.detail === undefined ? {} : { detail: event.detail }) : undefined,
      }, turnStatus);
    }
    case 'auto_retry_start': {
      const message = event.message ?? 'Agent execution is retrying';
      return withTurnStatus({ ...state, failure: { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message, context: { sessionId: event.sessionId, attempt: event.attempt ?? 1 } } }, { type: 'retry', attempt: event.attempt ?? 1, message, next: now + Math.max(0, event.delayMs ?? 0) });
    }
    case 'auto_retry_end':
      return withTurnStatus({ ...state, failure: event.succeeded ? null : { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message: event.message ?? state.failure?.message ?? 'Agent execution failed after retrying', context: { sessionId: event.sessionId } } }, { type: event.succeeded && state.turnActive ? 'busy' : 'idle' });
    case 'message_end':
      if (event.succeeded === true) return { ...state, failure: null };
      if (event.succeeded === false) return { ...state, failure: { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message: event.message ?? 'Agent execution failed', context: { sessionId: event.sessionId } } };
      return state;
    default: return state;
  }
}
