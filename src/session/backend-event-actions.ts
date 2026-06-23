import type { BackendKey } from './backend.js';
import type { BackendEvent } from './events.js';
import type { SessionEngineAction } from './types.js';

export function backendEventToActions(backendKey: BackendKey, event: BackendEvent): SessionEngineAction[] {
  switch (event.type) {
    case 'status':
      return [{ type: 'SET_BACKEND_STATUS', backendKey, status: event.status, error: event.error ?? null }];
    case 'projects':
      return [{ type: 'SET_PROJECTS', backendKey, projects: event.projects }];
    case 'workspaces': {
      const actions: SessionEngineAction[] = [{ type: 'SET_WORKSPACES', backendKey, workspaces: event.workspaces }];
      if (event.savedEventFilters) actions.push({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
      return actions;
    }
    case 'sessions':
      return [{ type: 'SET_SESSIONS', backendKey, sessions: event.sessions }];
    case 'replays':
      return [{ type: 'SET_REPLAYS', backendKey, replays: event.replays }];
    case 'inbox':
      return [{ type: 'SET_INBOX', backendKey, items: event.items, unreadCount: event.unreadCount }];
    case 'notification_config':
      return [{ type: 'SET_NOTIFICATION_CONFIG', backendKey, config: event.config }];
    case 'operation_snapshot':
      return [{ type: 'SET_OPERATIONS', backendKey, operations: event.operations }];
    case 'operation_event':
      return [{ type: 'APPLY_OPERATION_EVENT', backendKey, operation: event.event.operation }];
    case 'operation_dismissed':
      return [{ type: 'DISMISS_OPERATION', backendKey, operationId: event.operationId }];
    case 'pane_attached':
      return [{
        type: 'ADD_PANE',
        backendKey,
        pane: {
          paneId: event.paneId,
          streamId: event.streamId,
          sessionId: event.sessionId,
          sessionName: event.sessionName ?? null,
          meta: { sessionName: event.sessionName ?? null },
          workspaceId: event.workspaceId ?? null,
          agentSessionId: event.agentSessionId ?? null,
          viewOnly: event.viewOnly ?? false,
        },
      }];
    case 'pane_meta':
      return [{ type: 'UPDATE_PANE_META', backendKey, paneId: event.paneId, meta: event.meta }];
    case 'pane_detached':
    case 'pane_exited':
      return [{ type: 'REMOVE_PANE', backendKey, paneId: event.paneId }];
    case 'attached':
      return [{
        type: 'SET_ATTACHED_SESSION',
        backendKey,
        sessionId: event.sessionId,
        sessionName: event.sessionName ?? null,
        meta: { sessionName: event.sessionName ?? null },
        workspaceId: event.workspaceId ?? null,
        agentSessionId: event.agentSessionId ?? null,
      }];
    case 'session_meta':
      return [{ type: 'SET_ATTACHED_SESSION_META', backendKey, meta: event.meta }];
    case 'detached':
      return [{ type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null }];
    case 'session_exited':
      return [{ type: 'SET_ATTACHED_SESSION', backendKey, sessionId: null, preserveContextOnExit: true }];
    case 'command_error':
      return [{ type: 'SET_COMMAND_ERROR', backendKey, commandError: { code: event.code, message: event.message } }];
    case 'error':
      return [{ type: 'SET_BACKEND_STATUS', backendKey, status: 'error', error: event.message }];
    case 'script_output':
      return [{
        type: 'SET_SCRIPT_STATE',
        backendKey,
        scriptState: event.done && !event.error
          ? null
          : {
              phase: event.phase,
              isRunning: !event.done,
              error: event.error,
              exitCode: event.exitCode,
              workspaceId: event.workspaceId,
            },
      }];
    case 'events': {
      const actions: SessionEngineAction[] = [{ type: 'SET_EVENTS', backendKey, events: event.events, liveEventIds: event.liveEventIds }];
      if (event.savedEventFilters) actions.push({ type: 'SET_SAVED_EVENT_FILTERS', backendKey, filters: event.savedEventFilters });
      return actions;
    }
    case 'machine_snapshot':
      return [{ type: 'SET_MACHINE_SNAPSHOT', backendKey, snapshot: event.snapshot }];
    case 'host_ui_dialog_request':
      return [{ type: 'SET_HOST_UI_DIALOG', backendKey, request: event.request }];
    case 'host_ui_event':
      return event.event.type === 'working-message'
        ? [{ type: 'SET_HOST_UI_WORKING_MESSAGE', backendKey, sessionId: event.event.payload.sessionId, message: event.event.payload.message }]
        : [];
    case 'process_started':
    case 'process_stopped':
      return [];
    default:
      return [];
  }
}
