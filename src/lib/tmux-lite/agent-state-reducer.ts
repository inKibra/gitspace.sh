import type { AgentStateUpdateDelta, WorkspaceAgentState } from './agent-event-manager.js';

function cloneWorkspaceState(state: WorkspaceAgentState): WorkspaceAgentState {
  return {
    ...state,
    sessions: [...state.sessions],
    statuses: { ...state.statuses },
    pendingPermissions: { ...state.pendingPermissions },
    pendingQuestions: { ...state.pendingQuestions },
    lastMessages: { ...state.lastMessages },
    errorMessages: { ...state.errorMessages },
    todoPhases: { ...state.todoPhases },
    modelInfo: { ...state.modelInfo },
    queuedMessages: { ...state.queuedMessages },
  };
}

function createEmptyWorkspaceState(workspaceId: string): WorkspaceAgentState {
  return {
    workspaceId,
    sessions: [],
    statuses: {},
    pendingPermissions: {},
    pendingQuestions: {},
    lastMessages: {},
    errorMessages: {},
    todoPhases: {},
    modelInfo: {},
    queuedMessages: {},
  };
}

export function applyAgentDeltaToAgentState(
  current: Record<string, WorkspaceAgentState>,
  delta: AgentStateUpdateDelta,
): Record<string, WorkspaceAgentState> {
  if (delta.type === 'agent_state_snapshot') {
    return { ...delta.workspaces };
  }
  if (delta.type === 'agent_oauth_event') {
    return current; // transient flow event — not part of workspace state
  }
  const state = current[delta.workspaceId] ?? createEmptyWorkspaceState(delta.workspaceId);
  const nextWorkspace = cloneWorkspaceState(state);
  const next: Record<string, WorkspaceAgentState> = {
    ...current,
    [delta.workspaceId]: nextWorkspace,
  };

  switch (delta.type) {
    case 'agent_session_status':
      nextWorkspace.statuses[delta.sessionId] = delta.status;
      if (delta.status.type !== 'retry') delete nextWorkspace.errorMessages[delta.sessionId];
      break;
    case 'agent_session_error':
      nextWorkspace.errorMessages[delta.sessionId] = delta.errorMessage;
      break;
    case 'agent_permission_added': {
      const existing = nextWorkspace.pendingPermissions[delta.sessionId] ?? [];
      nextWorkspace.pendingPermissions[delta.sessionId] = [
        ...existing.filter((permission) => permission.id !== delta.permission.id),
        delta.permission,
      ];
      break;
    }
    case 'agent_permission_removed': {
      const existing = nextWorkspace.pendingPermissions[delta.sessionId];
      if (existing) {
        const filtered = existing.filter((permission) => permission.id !== delta.permissionId);
        if (filtered.length > 0) nextWorkspace.pendingPermissions[delta.sessionId] = filtered;
        else delete nextWorkspace.pendingPermissions[delta.sessionId];
      }
      break;
    }
    case 'agent_question_added': {
      const existing = nextWorkspace.pendingQuestions[delta.sessionId] ?? [];
      nextWorkspace.pendingQuestions[delta.sessionId] = [
        ...existing.filter((question) => question.id !== delta.question.id),
        delta.question,
      ];
      break;
    }
    case 'agent_question_removed': {
      const existing = nextWorkspace.pendingQuestions[delta.sessionId];
      if (existing) {
        const filtered = existing.filter((question) => question.id !== delta.requestId);
        if (filtered.length > 0) nextWorkspace.pendingQuestions[delta.sessionId] = filtered;
        else delete nextWorkspace.pendingQuestions[delta.sessionId];
      }
      break;
    }
    case 'agent_last_message':
      nextWorkspace.lastMessages[delta.sessionId] = delta.preview;
      delete nextWorkspace.errorMessages[delta.sessionId];
      break;
    case 'agent_todo_update':
      nextWorkspace.todoPhases[delta.sessionId] = delta.phases;
      break;
    case 'agent_model_update':
      nextWorkspace.modelInfo[delta.sessionId] = delta.modelInfo;
      break;
    case 'agent_session_created':
      if (!nextWorkspace.sessions.some((session) => session.id === delta.sessionId)) {
        nextWorkspace.sessions.push({ id: delta.sessionId, title: delta.title });
      }
      break;
    case 'agent_session_updated': {
      const index = nextWorkspace.sessions.findIndex((session) => session.id === delta.sessionId);
      if (index === -1) nextWorkspace.sessions.push({ id: delta.sessionId, title: delta.title });
      else nextWorkspace.sessions[index] = { ...nextWorkspace.sessions[index], title: delta.title };
      break;
    }
    case 'agent_session_deleted':
      nextWorkspace.sessions = nextWorkspace.sessions.filter((session) => session.id !== delta.sessionId);
      delete nextWorkspace.statuses[delta.sessionId];
      delete nextWorkspace.pendingPermissions[delta.sessionId];
      delete nextWorkspace.pendingQuestions[delta.sessionId];
      delete nextWorkspace.lastMessages[delta.sessionId];
      delete nextWorkspace.errorMessages[delta.sessionId];
      delete nextWorkspace.todoPhases[delta.sessionId];
      delete nextWorkspace.modelInfo[delta.sessionId];
      delete nextWorkspace.queuedMessages[delta.sessionId];
      break;
    default:
      break;
  }
  return next;
}
