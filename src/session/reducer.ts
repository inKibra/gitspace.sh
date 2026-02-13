import type { BackendDescriptor } from './backend.js';
import type {
  BackendSessionState,
  SessionEngineAction,
  SessionEngineState,
} from './types.js';

function createBackendState(descriptor: BackendDescriptor): BackendSessionState {
  return {
    descriptor,
    status: 'disconnected',
    error: null,
    commandError: null,
    projects: [],
    workspaces: [],
    sessions: [],
    inbox: [],
    inboxUnreadCount: 0,
    notificationConfig: null,
    mode: 'browsing',
    attachedSessionId: null,
    attachedSessionName: null,
    scriptState: null,
  };
}

export function createInitialSessionEngineState(): SessionEngineState {
  return {
    backendOrder: [],
    backends: {},
    activeBackendKey: null,
  };
}

export function sessionEngineReducer(
  state: SessionEngineState,
  action: SessionEngineAction
): SessionEngineState {
  switch (action.type) {
    case 'REGISTER_BACKEND': {
      if (state.backends[action.descriptor.key]) {
        return state;
      }

      const nextBackends = {
        ...state.backends,
        [action.descriptor.key]: createBackendState(action.descriptor),
      };

      const nextOrder = [...state.backendOrder, action.descriptor.key];
      return {
        ...state,
        backends: nextBackends,
        backendOrder: nextOrder,
        activeBackendKey: state.activeBackendKey ?? action.descriptor.key,
      };
    }

    case 'UNREGISTER_BACKEND': {
      if (!state.backends[action.backendKey]) {
        return state;
      }

      const nextBackends = { ...state.backends };
      delete nextBackends[action.backendKey];
      const nextOrder = state.backendOrder.filter((key) => key !== action.backendKey);

      let nextActive = state.activeBackendKey;
      if (nextActive === action.backendKey) {
        nextActive = nextOrder[0] ?? null;
      }

      return {
        ...state,
        backends: nextBackends,
        backendOrder: nextOrder,
        activeBackendKey: nextActive,
      };
    }

    case 'SET_ACTIVE_BACKEND':
      return {
        ...state,
        activeBackendKey: action.backendKey,
      };

    case 'SET_BACKEND_STATUS': {
      const backend = state.backends[action.backendKey];
      if (!backend) {
        return state;
      }

      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            status: action.status,
            error: action.error ?? null,
            commandError: action.status === 'error' ? backend.commandError : null,
          },
        },
      };
    }

    case 'SET_COMMAND_ERROR': {
      const backend = state.backends[action.backendKey];
      if (!backend) {
        return state;
      }

      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            commandError: action.commandError,
          },
        },
      };
    }

    case 'SET_PROJECTS': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            projects: action.projects,
          },
        },
      };
    }

    case 'SET_WORKSPACES': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            workspaces: action.workspaces,
          },
        },
      };
    }

    case 'SET_SESSIONS': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            sessions: action.sessions,
          },
        },
      };
    }

    case 'SET_INBOX': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            inbox: action.items,
            inboxUnreadCount: action.unreadCount,
          },
        },
      };
    }

    case 'SET_NOTIFICATION_CONFIG': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            notificationConfig: action.config,
          },
        },
      };
    }

    case 'SET_SCRIPT_STATE': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            scriptState: action.scriptState,
          },
        },
      };
    }

    case 'SET_ATTACHED_SESSION': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const attached = !!action.sessionId;
      const nextSessionName = attached
        ? (action.sessionName ?? backend.attachedSessionName)
        : null;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            mode: attached ? 'attached' : 'browsing',
            attachedSessionId: action.sessionId,
            attachedSessionName: nextSessionName,
          },
        },
      };
    }

    default:
      return state;
  }
}
