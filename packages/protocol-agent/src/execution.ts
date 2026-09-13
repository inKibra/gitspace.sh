import type { SessionStatus } from './activity.js';
import type { AgentFailure } from './errors.js';

export interface AgentExecutionState { status: SessionStatus; turnActive: boolean; failure: AgentFailure | null }
export interface AgentExecutionObservation { type: string; sessionId: string; message?: string; attempt?: number; delayMs?: number; succeeded?: boolean }

/** Runtime events provide facts; only explicit successful execution clears execution failure. */
export function transitionAgentExecution(state: AgentExecutionState, event: AgentExecutionObservation, now: number): AgentExecutionState {
  switch (event.type) {
    case 'agent_start': return { ...state, status: { type: 'busy' }, turnActive: true };
    case 'agent_end': return { ...state, status: { type: 'idle' }, turnActive: false };
    case 'auto_compaction_start': return { ...state, status: { type: 'compacting' } };
    case 'auto_compaction_end': return { ...state, status: { type: state.turnActive ? 'busy' : 'idle' } };
    case 'auto_retry_start': {
      const message = event.message ?? 'Agent execution is retrying';
      return { ...state, status: { type: 'retry', attempt: event.attempt ?? 1, message, next: now + Math.max(0, event.delayMs ?? 0) }, failure: { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message, context: { sessionId: event.sessionId, attempt: event.attempt ?? 1 } } };
    }
    case 'auto_retry_end':
      return { ...state, status: { type: event.succeeded && state.turnActive ? 'busy' : 'idle' }, failure: event.succeeded ? null : { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message: event.message ?? state.failure?.message ?? 'Agent execution failed after retrying', context: { sessionId: event.sessionId } } };
    case 'message_end':
      if (event.succeeded === true) return { ...state, failure: null };
      if (event.succeeded === false) return { ...state, failure: { domain: 'agent', code: 'AGENT_EXECUTION_FAILED', message: event.message ?? 'Agent execution failed', context: { sessionId: event.sessionId } } };
      return state;
    default: return state;
  }
}
