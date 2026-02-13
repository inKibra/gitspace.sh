import type { BackendKey } from './backend.js';
import type { BackendSessionState, SessionEngineState } from './types.js';

export function getActiveBackendKey(state: SessionEngineState): BackendKey | null {
  return state.activeBackendKey;
}

export function getBackendState(
  state: SessionEngineState,
  backendKey: BackendKey
): BackendSessionState | null {
  return state.backends[backendKey] || null;
}

export function getActiveBackendState(state: SessionEngineState): BackendSessionState | null {
  if (!state.activeBackendKey) {
    return null;
  }
  return getBackendState(state, state.activeBackendKey);
}

export function getBackendKeys(state: SessionEngineState): BackendKey[] {
  return state.backendOrder;
}

export function getConnectedBackendKeys(state: SessionEngineState): BackendKey[] {
  return state.backendOrder.filter((key) => state.backends[key]?.status === 'connected');
}
