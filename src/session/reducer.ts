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
      replays: [],
      machineSnapshot: null,
      snapshotError: null,
      operations: {},
      inbox: [],
      inboxUnreadCount: 0,
    notificationConfig: null,
    mode: 'browsing',
    attachedSessionId: null,
    attachedSessionName: null,
    attachedSessionMeta: null,
    attachedWorkspaceId: null,
    attachedAgentSessionId: null,
    pendingAgentAttach: false,
    attachedPanes: {},
    scriptState: null,
    events: [],
    liveEventIds: [],
    savedEventFilters: [],
    pendingDialogRequest: null,
    agentWorkingMessage: undefined,
    pendingDialogByAgentSessionId: {},
    workingMessageByAgentSessionId: {},
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
            pendingAgentAttach: false,
          },
        },
      };
    }

    case 'SET_PENDING_AGENT_ATTACH': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            pendingAgentAttach: action.pending,
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

    case 'SET_REPLAYS': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            replays: action.replays,
          },
        },
      };
    }

    case 'SET_MACHINE_SNAPSHOT': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            machineSnapshot: action.snapshot,
            // A real snapshot supersedes a previous load failure.
            snapshotError: action.snapshot ? null : backend.snapshotError,
          },
        },
      };
    }

    case 'SET_SNAPSHOT_ERROR': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      if (backend.snapshotError === action.message) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            snapshotError: action.message,
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

    case 'SET_OPERATIONS': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            operations: Object.fromEntries(action.operations.map((operation) => [operation.operationId, operation])),
          },
        },
      };
    }

    case 'APPLY_OPERATION_EVENT': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            operations: {
              ...backend.operations,
              [action.operation.operationId]: action.operation,
            },
          },
        },
      };
    }

    case 'DISMISS_OPERATION': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const operations = { ...backend.operations };
      delete operations[action.operationId];
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            operations,
          },
        },
      };
    }

    case 'SET_ATTACHED_SESSION': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const attached = !!action.sessionId;
      const preserveContextOnExit = action.preserveContextOnExit === true && !attached;
      const nextSessionName = attached
        ? (action.sessionName ?? backend.attachedSessionName)
        : preserveContextOnExit
          ? backend.attachedSessionName
          : null;
      const nextMeta = attached
        ? {
            ...(backend.attachedSessionMeta ?? {}),
            ...(action.meta ?? {}),
            sessionName: action.sessionName ?? action.meta?.sessionName ?? nextSessionName ?? null,
          }
        : preserveContextOnExit
          ? backend.attachedSessionMeta
          : null;
      const nextWorkspaceId = attached
        ? (action.workspaceId ?? backend.attachedWorkspaceId)
        : preserveContextOnExit
          ? backend.attachedWorkspaceId
          : null;
      const nextAttachedPanes = attached
        ? {
            ...backend.attachedPanes,
            default: {
              paneId: 'default',
              streamId: 2,
              sessionId: action.sessionId!,
              sessionName: nextSessionName,
              meta: nextMeta,
              workspaceId: nextWorkspaceId,
              agentSessionId: action.agentSessionId ?? null,
              viewOnly: false,
            },
          }
        : preserveContextOnExit
          ? backend.attachedPanes
          : {};
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            mode: attached ? 'attached' : 'browsing',
            attachedSessionId: action.sessionId,
            attachedSessionName: nextSessionName,
            attachedSessionMeta: nextMeta,
            attachedWorkspaceId: nextWorkspaceId,
            attachedAgentSessionId: attached ? (action.agentSessionId ?? null) : null,
            attachedPanes: nextAttachedPanes,
            pendingDialogRequest: attached && action.agentSessionId ? backend.pendingDialogByAgentSessionId[action.agentSessionId] ?? null : null,
            agentWorkingMessage: attached && action.agentSessionId ? backend.workingMessageByAgentSessionId[action.agentSessionId] : undefined,
            pendingAgentAttach: false,
          },
        },
      };
    }

    case 'ADD_PANE': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const paneWorkspaceId = action.pane.workspaceId ?? backend.attachedWorkspaceId;
      const paneSessionName = action.pane.sessionName ?? backend.attachedSessionName;
      const paneMeta = action.pane.meta ?? backend.attachedSessionMeta;
      const nextPane = {
        ...action.pane,
        sessionName: paneSessionName,
        meta: paneMeta,
        workspaceId: paneWorkspaceId,
      };
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            mode: 'attached',
            attachedSessionId: nextPane.paneId === 'default' ? nextPane.sessionId : backend.attachedSessionId,
            attachedSessionName: nextPane.paneId === 'default' ? paneSessionName : backend.attachedSessionName,
            attachedSessionMeta: nextPane.paneId === 'default' ? paneMeta : backend.attachedSessionMeta,
            attachedWorkspaceId: nextPane.paneId === 'default' ? paneWorkspaceId : backend.attachedWorkspaceId,
            attachedAgentSessionId: nextPane.paneId === 'default' ? nextPane.agentSessionId : backend.attachedAgentSessionId,
            attachedPanes: { ...backend.attachedPanes, [nextPane.paneId]: nextPane },
            pendingAgentAttach: false,
          },
        },
      };
    }

    case 'REMOVE_PANE': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const attachedPanes = { ...backend.attachedPanes };
      delete attachedPanes[action.paneId];
      const hasPanes = Object.keys(attachedPanes).length > 0;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            attachedPanes,
            mode: hasPanes ? 'attached' : 'browsing',
          },
        },
      };
    }

    case 'UPDATE_PANE_META': {
      const backend = state.backends[action.backendKey];
      const pane = backend?.attachedPanes[action.paneId];
      if (!backend || !pane) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            attachedPanes: {
              ...backend.attachedPanes,
              [action.paneId]: { ...pane, meta: action.meta },
            },
          },
        },
      };
    }

    case 'CLEAR_ALL_PANES': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: { ...backend, attachedPanes: {}, mode: 'browsing' },
        },
      };
    }


    case 'SET_ATTACHED_SESSION_META': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            attachedSessionMeta: action.meta,
            attachedSessionName: action.meta?.sessionName ?? backend.attachedSessionName,
            attachedPanes: backend.attachedPanes.default
              ? { ...backend.attachedPanes, default: { ...backend.attachedPanes.default, meta: action.meta } }
              : backend.attachedPanes,
          },
        },
      };
    }

    case 'SET_EVENTS': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            events: action.events,
            liveEventIds: action.liveEventIds,
          },
        },
      };
    }

    case 'SET_SAVED_EVENT_FILTERS': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            savedEventFilters: action.filters,
          },
        },
      };
    }

    case 'SET_HOST_UI_DIALOG': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const pendingDialogByAgentSessionId = {
        ...backend.pendingDialogByAgentSessionId,
        [action.request.sessionId]: action.request,
      };
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            pendingDialogByAgentSessionId,
            pendingDialogRequest: backend.attachedAgentSessionId === action.request.sessionId ? action.request : backend.pendingDialogRequest,
          },
        },
      };
    }

    case 'SET_HOST_UI_WORKING_MESSAGE': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const workingMessageByAgentSessionId = { ...backend.workingMessageByAgentSessionId };
      if (action.message) {
        workingMessageByAgentSessionId[action.sessionId] = action.message;
      } else {
        delete workingMessageByAgentSessionId[action.sessionId];
      }
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            workingMessageByAgentSessionId,
            agentWorkingMessage: backend.attachedAgentSessionId === action.sessionId ? action.message : backend.agentWorkingMessage,
          },
        },
      };
    }

    case 'CLEAR_HOST_UI_DIALOG': {
      const backend = state.backends[action.backendKey];
      if (!backend) return state;
      const pendingDialogByAgentSessionId = { ...backend.pendingDialogByAgentSessionId };
      if (backend.pendingDialogRequest) {
        delete pendingDialogByAgentSessionId[backend.pendingDialogRequest.sessionId];
      }
      return {
        ...state,
        backends: {
          ...state.backends,
          [action.backendKey]: {
            ...backend,
            pendingDialogByAgentSessionId,
            pendingDialogRequest: null,
          },
        },
      };
    }

    default:
      return state;
  }
}
