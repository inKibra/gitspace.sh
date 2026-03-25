/**
 * AgentEventManager
 *
 * Tracks agent sessions for each workspace from two sources only:
 * - known sessions discovered from on-disk Pi session files
 * - live in-process runtime updates forwarded from the Pi extension
 *
 * Archived sessions are excluded from the active list and can only re-enter
 * through an explicit restore path.
 */

import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../agents/session-display.js';
import { getArchivedSessions } from '../../agents/agent-db.js';
import { writeAgentLog } from '../../agents/agent-log.js';
import { normalizeWorkspacePath } from '../../agents/agent-runtime-shared.js';
import type {
  PendingQuestion,
  Permission,
  SessionStatus,
} from '../../agents/agent-runtime-types.js';

export interface AgentSessionSummary {
  id: string;
  title: string;
  closedAt?: string;
  archivedAt?: string;
  updatedAt?: string;
}

export interface WorkspaceAgentState {
  workspaceId: string;
  sessions: AgentSessionSummary[];
  statuses: Record<string, SessionStatus>;
  pendingPermissions: Record<string, Permission[]>;
  pendingQuestions: Record<string, PendingQuestion[]>;
  lastMessages: Record<string, string>;
  errorMessages: Record<string, string>;
}

export type AgentStateUpdateDelta =
  | { type: 'agent_state_snapshot'; workspaces: Record<string, WorkspaceAgentState> }
  | { type: 'agent_session_status'; workspaceId: string; sessionId: string; status: SessionStatus }
  | { type: 'agent_permission_added'; workspaceId: string; sessionId: string; permission: Permission }
  | { type: 'agent_permission_removed'; workspaceId: string; sessionId: string; permissionId: string }
  | { type: 'agent_question_added'; workspaceId: string; sessionId: string; question: PendingQuestion }
  | { type: 'agent_question_removed'; workspaceId: string; sessionId: string; requestId: string }
  | { type: 'agent_session_error'; workspaceId: string; sessionId: string; errorMessage: string }
  | { type: 'agent_last_message'; workspaceId: string; sessionId: string; preview: string }
  | { type: 'agent_session_created'; workspaceId: string; sessionId: string; title: string }
  | { type: 'agent_session_updated'; workspaceId: string; sessionId: string; title: string }
  | { type: 'agent_session_deleted'; workspaceId: string; sessionId: string };

export interface ExternalSessionRuntimeState {
  status: SessionStatus;
  pendingPermissions: Permission[];
  pendingQuestions: PendingQuestion[];
  errorMessage?: string;
  lastMessage?: string;
}

const LAST_MESSAGE_MAX_CHARS = 120;

export class AgentEventManager {
  private readonly workspaceStates = new Map<string, WorkspaceAgentState>();
  private readonly handlers = new Set<(delta: AgentStateUpdateDelta) => void>();
  private readonly previousStatuses = new Map<string, SessionStatus>();
  private readonly workspacePaths = new Map<string, string>();
  private readonly archivedSessionIds = new Map<string, Set<string>>();

  async initialize(): Promise<void> {
    // No external runtime bootstrap remains. Pi session discovery and in-process
    // updates seed state through syncKnownSessions/syncExternalRuntimeState.
  }

  registerWorkspace(workspaceId: string, workspacePath: string): void {
    const normalized = normalizeWorkspacePath(workspacePath);
    this.workspacePaths.set(workspaceId, normalized);
    this.getOrCreateState(workspaceId);
    writeAgentLog('register workspace', { workspaceId, workspacePath: normalized });

    if (!this.archivedSessionIds.has(workspaceId)) {
      const rows = getArchivedSessions(workspaceId);
      if (rows.length > 0) {
        this.archivedSessionIds.set(workspaceId, new Set(rows.map((row) => row.sessionId)));
      }
    }
  }

  syncKnownSessions(
    workspaceId: string,
    sessions: Array<Pick<AgentSessionSummary, 'id' | 'title' | 'updatedAt'>>,
  ): void {
    const state = this.getOrCreateState(workspaceId);
    let changed = false;

    for (const session of sessions) {
      if (!shouldDisplayAgentSession(session)) {
        continue;
      }

      const normalizedTitle = getAgentSessionDisplayTitle({
        id: session.id,
        title: session.title,
        rawTitle: session.title,
      });
      const index = state.sessions.findIndex((item) => item.id === session.id);
      if (index === -1) {
        if (this.ensureSessionEntry(workspaceId, session.id, normalizedTitle, session.updatedAt)) {
          changed = true;
          this.emit({ type: 'agent_session_created', workspaceId, sessionId: session.id, title: normalizedTitle });
        }
        continue;
      }

      const existing = state.sessions[index]!;
      const next: AgentSessionSummary = {
        ...existing,
        title: normalizedTitle,
        updatedAt: session.updatedAt,
      };
      if (next.title !== existing.title || next.updatedAt !== existing.updatedAt) {
        state.sessions[index] = next;
        changed = true;
        this.emit({ type: 'agent_session_updated', workspaceId, sessionId: session.id, title: normalizedTitle });
      }
    }

    if (changed) {
      this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
    }
  }

  async reconcileWorkspace(_workspaceId: string): Promise<void> {
    // No remote runtime reconciliation remains. State is driven by Pi session
    // discovery plus explicit runtime updates.
  }

  subscribe(handler: (delta: AgentStateUpdateDelta) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  getSnapshot(): Record<string, WorkspaceAgentState> {
    const snapshot: Record<string, WorkspaceAgentState> = {};
    for (const [workspaceId, state] of this.workspaceStates) {
      snapshot[workspaceId] = state;
    }
    return snapshot;
  }

  markSessionClosed(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    const index = state.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) return;
    if (state.sessions[index]?.closedAt) return;

    state.sessions[index] = { ...state.sessions[index]!, closedAt: new Date().toISOString() };
    delete state.statuses[sessionId];
    delete state.pendingPermissions[sessionId];
    delete state.pendingQuestions[sessionId];
    delete state.lastMessages[sessionId];
    delete state.errorMessages[sessionId];
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  markSessionOpen(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    const index = state.sessions.findIndex((session) => session.id === sessionId);
    if (index === -1) {
      if (this.ensureSessionEntry(workspaceId, sessionId, sessionId)) {
        const newIndex = state.sessions.findIndex((session) => session.id === sessionId);
        if (newIndex !== -1) {
          state.sessions[newIndex] = { ...state.sessions[newIndex]!, closedAt: undefined };
        }
        this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
      }
      return;
    }
    if (!state.sessions[index]?.closedAt) return;
    state.sessions[index] = { ...state.sessions[index]!, closedAt: undefined };
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  setExternalStatus(workspaceId: string, sessionId: string, status: SessionStatus): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    state.statuses[sessionId] = status;
    delete state.errorMessages[sessionId];
    this.previousStatuses.set(`${workspaceId}:${sessionId}`, status);
    this.emit({ type: 'agent_session_status', workspaceId, sessionId, status });
  }

  setExternalLastMessage(workspaceId: string, sessionId: string, preview: string): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    const trimmed = preview.trim();
    if (!trimmed) return;
    const normalized = trimmed.slice(-LAST_MESSAGE_MAX_CHARS);
    state.lastMessages[sessionId] = normalized;
    delete state.errorMessages[sessionId];
    this.emit({ type: 'agent_last_message', workspaceId, sessionId, preview: normalized });
  }

  setExternalError(workspaceId: string, sessionId: string, errorMessage: string): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    state.errorMessages[sessionId] = errorMessage;
    this.emit({ type: 'agent_session_error', workspaceId, sessionId, errorMessage });
  }

  syncExternalRuntimeState(
    workspaceId: string,
    sessionId: string,
    update: ExternalSessionRuntimeState,
  ): void {
    const state = this.getOrCreateState(workspaceId);
    if (state.sessions.findIndex((session) => session.id === sessionId) === -1) {
      this.ensureSessionEntry(workspaceId, sessionId, sessionId);
    }

    const sessionIndex = state.sessions.findIndex((session) => session.id === sessionId);
    if (sessionIndex !== -1 && state.sessions[sessionIndex]?.closedAt) {
      state.sessions[sessionIndex] = { ...state.sessions[sessionIndex]!, closedAt: undefined };
    }

    state.statuses[sessionId] = update.status;
    this.previousStatuses.set(`${workspaceId}:${sessionId}`, update.status);

    if (update.pendingPermissions.length > 0) {
      state.pendingPermissions[sessionId] = update.pendingPermissions;
    } else {
      delete state.pendingPermissions[sessionId];
    }

    if (update.pendingQuestions.length > 0) {
      state.pendingQuestions[sessionId] = update.pendingQuestions;
    } else {
      delete state.pendingQuestions[sessionId];
    }

    const normalizedMessage = update.lastMessage?.trim();
    if (normalizedMessage) {
      state.lastMessages[sessionId] = normalizedMessage.slice(-LAST_MESSAGE_MAX_CHARS);
    } else if (update.lastMessage !== undefined) {
      delete state.lastMessages[sessionId];
    }

    const normalizedError = update.errorMessage?.trim();
    if (normalizedError) {
      state.errorMessages[sessionId] = normalizedError;
    } else {
      delete state.errorMessages[sessionId];
    }

    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  markSessionArchived(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    state.sessions = state.sessions.filter((session) => session.id !== sessionId);
    delete state.statuses[sessionId];
    delete state.pendingPermissions[sessionId];
    delete state.pendingQuestions[sessionId];
    delete state.lastMessages[sessionId];
    delete state.errorMessages[sessionId];
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
    let archived = this.archivedSessionIds.get(workspaceId);
    if (!archived) {
      archived = new Set();
      this.archivedSessionIds.set(workspaceId, archived);
    }
    archived.add(sessionId);
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  markSessionRestored(workspaceId: string, sessionId: string, title: string): void {
    this.archivedSessionIds.get(workspaceId)?.delete(sessionId);
    const state = this.getOrCreateState(workspaceId);
    const existing = state.sessions.find((session) => session.id === sessionId);
    if (existing) {
      const index = state.sessions.indexOf(existing);
      state.sessions[index] = { ...existing, closedAt: new Date().toISOString(), archivedAt: undefined };
    } else {
      state.sessions.push({ id: sessionId, title, closedAt: new Date().toISOString() });
    }
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  private emit(delta: AgentStateUpdateDelta): void {
    for (const handler of this.handlers) {
      try {
        handler(delta);
      } catch {
        // never let a handler crash the manager
      }
    }
  }

  private ensureSessionEntry(
    workspaceId: string,
    id: string,
    title: string,
    updatedAt?: string,
  ): boolean {
    if (this.archivedSessionIds.get(workspaceId)?.has(id)) return false;
    const state = this.getOrCreateState(workspaceId);
    if (state.sessions.some((session) => session.id === id)) return false;
    state.sessions.push({ id, title, closedAt: new Date().toISOString(), updatedAt });
    return true;
  }

  private getOrCreateState(workspaceId: string): WorkspaceAgentState {
    let state = this.workspaceStates.get(workspaceId);
    if (!state) {
      state = {
        workspaceId,
        sessions: [],
        statuses: {},
        pendingPermissions: {},
        pendingQuestions: {},
        lastMessages: {},
        errorMessages: {},
      };
      this.workspaceStates.set(workspaceId, state);
    }
    return state;
  }
}

export const defaultAgentEventManager = new AgentEventManager();
