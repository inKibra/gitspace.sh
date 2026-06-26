/**
 * AgentEventManager
 *
 * Tracks agent sessions for each workspace from two sources:
 * - known sessions discovered from on-disk Pi session files
 * - live in-process SDK events forwarded by PiCoordinator
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
  AgentModelInfo,
  PendingQuestion,
  Permission,
  SessionStatus,
  TodoPhase,
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
  /** Todo phases per session (populated when session runs in-process via SDK). */
  todoPhases: Record<string, TodoPhase[]>;
  /** Model info per session (populated when session runs in-process via SDK). */
  modelInfo: Record<string, AgentModelInfo>;
  /** SDK-backed queued steer/follow-up messages per session for UI display. */
  queuedMessages: Record<string, { steering: string[]; followUp: string[] }>;
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
  | { type: 'agent_session_deleted'; workspaceId: string; sessionId: string }
  | { type: 'agent_todo_update'; workspaceId: string; sessionId: string; phases: TodoPhase[] }
  | { type: 'agent_model_update'; workspaceId: string; sessionId: string; modelInfo: AgentModelInfo }
  | { type: 'agent_transcript_live'; workspaceId: string; sessionId: string; blocks: import('../../blocks/index.js').Block[]; committed: boolean };


const LAST_MESSAGE_MAX_CHARS = 120;
const LAST_MESSAGE_EMIT_INTERVAL_MS = 250;

type LastMessageDelta = Extract<AgentStateUpdateDelta, { type: 'agent_last_message' }>;
type TimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface AgentEventManagerOptions {
  /**
   * Minimum interval for streaming last-message deltas. The state is updated
   * synchronously; only watcher notifications are coalesced.
   */
  lastMessageEmitIntervalMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
}


function resolveLastMessageEmitIntervalMs(value: number | undefined): number {
  if (value === undefined) return LAST_MESSAGE_EMIT_INTERVAL_MS;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('lastMessageEmitIntervalMs must be a non-negative finite number');
  }
  return Math.floor(value);
}
function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}


export class AgentEventManager {
  private readonly workspaceStates = new Map<string, WorkspaceAgentState>();
  private readonly handlers = new Set<(delta: AgentStateUpdateDelta) => void>();
  private readonly previousStatuses = new Map<string, SessionStatus>();
  private readonly workspacePaths = new Map<string, string>();
  private readonly archivedSessionIds = new Map<string, Set<string>>();
  private readonly suppressedSessionIds = new Map<string, Set<string>>();
  private readonly lastMessageEmitIntervalMs: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: (callback: () => void, delay: number) => TimerHandle;
  private readonly cancelTimeout: (handle: TimerHandle) => void;
  private readonly lastMessageEmitTimes = new Map<string, number>();
  private readonly pendingLastMessageDeltas = new Map<string, LastMessageDelta>();
  private readonly pendingLastMessageTimers = new Map<string, TimerHandle>();

  constructor(options: AgentEventManagerOptions = {}) {
    this.lastMessageEmitIntervalMs = resolveLastMessageEmitIntervalMs(options.lastMessageEmitIntervalMs);
    this.now = options.now ?? (() => Date.now());
    this.scheduleTimeout = options.setTimeout ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.cancelTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  }

  async initialize(): Promise<void> {
    // No external runtime bootstrap remains. Pi session discovery and in-process
    // updates seed state through syncKnownSessions and explicit runtime update methods.
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

    const archivedIds = this.archivedSessionIds.get(workspaceId);
    const archivedSessionsRemoved = archivedIds
      ? state.sessions.filter((session) => archivedIds.has(session.id)).map((session) => session.id)
      : [];
    if (archivedSessionsRemoved.length > 0) {
      state.sessions = state.sessions.filter((session) => !archivedIds?.has(session.id));
      for (const sessionId of archivedSessionsRemoved) {
        delete state.statuses[sessionId];
        delete state.pendingPermissions[sessionId];
        delete state.pendingQuestions[sessionId];
        delete state.lastMessages[sessionId];
        delete state.errorMessages[sessionId];
        delete state.todoPhases[sessionId];
        delete state.modelInfo[sessionId];
        delete state.queuedMessages[sessionId];
        this.clearLastMessageThrottle(workspaceId, sessionId);
        this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
      }
      changed = true;
    }

    for (const session of sessions) {
      if (!shouldDisplayAgentSession(session) || archivedIds?.has(session.id) || this.suppressedSessionIds.get(workspaceId)?.has(session.id)) {
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
    delete state.todoPhases[sessionId];
    delete state.modelInfo[sessionId];
    delete state.queuedMessages[sessionId];
    this.clearLastMessageThrottle(workspaceId, sessionId);
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  markSessionOpen(workspaceId: string, sessionId: string): void {
    this.unsuppressSession(workspaceId, sessionId);
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
    if (jsonEqual(state.statuses[sessionId], status)) return;
    state.statuses[sessionId] = status;
    // Only clear error messages when transitioning to a non-error status.
    // Retry status carries an error message that must survive.
    if (status.type !== 'retry') {
      delete state.errorMessages[sessionId];
    }
    this.previousStatuses.set(`${workspaceId}:${sessionId}`, status);
    this.emit({ type: 'agent_session_status', workspaceId, sessionId, status });
  }

  /** Broadcast the live transcript suffix for a session (transient — not stored). */
  emitTranscriptLive(workspaceId: string, sessionId: string, blocks: import('../../blocks/index.js').Block[], committed: boolean): void {
    this.emit({ type: 'agent_transcript_live', workspaceId, sessionId, blocks, committed });
  }

  setExternalLastMessage(workspaceId: string, sessionId: string, preview: string): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    const trimmed = preview.trim();
    if (!trimmed) return;
    const normalized = trimmed.slice(-LAST_MESSAGE_MAX_CHARS);
    if (state.lastMessages[sessionId] === normalized) return;
    state.lastMessages[sessionId] = normalized;
    delete state.errorMessages[sessionId];
    this.emitLastMessage({ type: 'agent_last_message', workspaceId, sessionId, preview: normalized });
  }

  setExternalError(workspaceId: string, sessionId: string, errorMessage: string): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    if (state.errorMessages[sessionId] === errorMessage) return;
    state.errorMessages[sessionId] = errorMessage;
    this.emit({ type: 'agent_session_error', workspaceId, sessionId, errorMessage });
  }

  setExternalTodoPhases(workspaceId: string, sessionId: string, phases: TodoPhase[]): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    if (jsonEqual(state.todoPhases[sessionId], phases)) return;
    state.todoPhases[sessionId] = phases;
    this.emit({ type: 'agent_todo_update', workspaceId, sessionId, phases });
  }

  setExternalModelInfo(workspaceId: string, sessionId: string, modelInfo: AgentModelInfo): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    if (jsonEqual(state.modelInfo[sessionId], modelInfo)) return;
    state.modelInfo[sessionId] = modelInfo;
    this.emit({ type: 'agent_model_update', workspaceId, sessionId, modelInfo });
  }

  setExternalQueuedMessages(workspaceId: string, sessionId: string, queued: { steering: readonly string[]; followUp: readonly string[] }): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    const previousQueued = state.queuedMessages[sessionId];
    if (queued.steering.length === 0 && queued.followUp.length === 0) {
      delete state.queuedMessages[sessionId];
    } else {
      state.queuedMessages[sessionId] = {
        steering: [...queued.steering],
        followUp: [...queued.followUp],
      };
    }
    if (jsonEqual(previousQueued, state.queuedMessages[sessionId])) return;
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  addPendingQuestion(workspaceId: string, sessionId: string, question: PendingQuestion): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    const existing = state.pendingQuestions[sessionId] ?? [];
    state.pendingQuestions[sessionId] = [
      ...existing.filter((q) => q.id !== question.id),
      question,
    ];
    this.emit({ type: 'agent_question_added', workspaceId, sessionId, question });
  }

  removePendingQuestion(workspaceId: string, sessionId: string, requestId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    const existing = state.pendingQuestions[sessionId];
    if (!existing) return;
    const next = existing.filter((q) => q.id !== requestId);
    if (next.length > 0) {
      state.pendingQuestions[sessionId] = next;
    } else {
      delete state.pendingQuestions[sessionId];
    }
    this.emit({ type: 'agent_question_removed', workspaceId, sessionId, requestId });
  }

  addPendingPermission(workspaceId: string, sessionId: string, permission: Permission): void {
    this.markSessionOpen(workspaceId, sessionId);
    const state = this.getOrCreateState(workspaceId);
    const existing = state.pendingPermissions[sessionId] ?? [];
    state.pendingPermissions[sessionId] = [
      ...existing.filter((p) => p.id !== permission.id),
      permission,
    ];
    this.emit({ type: 'agent_permission_added', workspaceId, sessionId, permission });
  }

  removePendingPermission(workspaceId: string, sessionId: string, permissionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    const existing = state.pendingPermissions[sessionId];
    if (!existing) return;
    const next = existing.filter((p) => p.id !== permissionId);
    if (next.length > 0) {
      state.pendingPermissions[sessionId] = next;
    } else {
      delete state.pendingPermissions[sessionId];
    }
    this.emit({ type: 'agent_permission_removed', workspaceId, sessionId, permissionId });
  }

  clearPendingPermissions(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state || !state.pendingPermissions[sessionId]) return;
    const removed = state.pendingPermissions[sessionId]!;
    delete state.pendingPermissions[sessionId];
    for (const p of removed) {
      this.emit({ type: 'agent_permission_removed', workspaceId, sessionId, permissionId: p.id });
    }
  }

  markSessionIdle(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    state.statuses[sessionId] = { type: 'idle' };
    delete state.pendingPermissions[sessionId];
    delete state.pendingQuestions[sessionId];
    delete state.errorMessages[sessionId];
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
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
    delete state.todoPhases[sessionId];
    delete state.modelInfo[sessionId];
    delete state.queuedMessages[sessionId];
    this.clearLastMessageThrottle(workspaceId, sessionId);
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
    this.suppressedSessionIds.get(workspaceId)?.delete(sessionId);
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
    this.unsuppressSession(workspaceId, sessionId);
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


  private emitLastMessage(delta: LastMessageDelta): void {
    if (this.lastMessageEmitIntervalMs === 0) {
      this.emit(delta);
      return;
    }

    const key = `${delta.workspaceId}:${delta.sessionId}`;
    const now = this.now();
    const previousEmit = this.lastMessageEmitTimes.get(key);
    if (previousEmit === undefined || now - previousEmit >= this.lastMessageEmitIntervalMs) {
      this.clearPendingLastMessage(key);
      this.lastMessageEmitTimes.set(key, now);
      this.emit(delta);
      return;
    }

    this.pendingLastMessageDeltas.set(key, delta);
    if (this.pendingLastMessageTimers.has(key)) return;

    const delay = Math.max(1, this.lastMessageEmitIntervalMs - (now - previousEmit));
    const timer = this.scheduleTimeout(() => {
      this.pendingLastMessageTimers.delete(key);
      const pending = this.pendingLastMessageDeltas.get(key);
      if (!pending) return;
      this.pendingLastMessageDeltas.delete(key);
      this.lastMessageEmitTimes.set(key, this.now());
      this.emit(pending);
    }, delay);
    this.pendingLastMessageTimers.set(key, timer);
  }

  private clearPendingLastMessage(key: string): void {
    const timer = this.pendingLastMessageTimers.get(key);
    if (timer) {
      this.cancelTimeout(timer);
      this.pendingLastMessageTimers.delete(key);
    }
    this.pendingLastMessageDeltas.delete(key);
  }

  private clearLastMessageThrottle(workspaceId: string, sessionId: string): void {
    const key = `${workspaceId}:${sessionId}`;
    this.clearPendingLastMessage(key);
    this.lastMessageEmitTimes.delete(key);
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
    if (this.suppressedSessionIds.get(workspaceId)?.has(id)) return false;
    const state = this.getOrCreateState(workspaceId);
    if (state.sessions.some((session) => session.id === id)) return false;
    state.sessions.push({ id, title, closedAt: new Date().toISOString(), updatedAt });
    return true;
  }

  private unsuppressSession(workspaceId: string, sessionId: string): void {
    this.suppressedSessionIds.get(workspaceId)?.delete(sessionId);
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
        todoPhases: {},
        modelInfo: {},
        queuedMessages: {},
      };
      this.workspaceStates.set(workspaceId, state);
    }
    return state;
  }
}

export const defaultAgentEventManager = new AgentEventManager();
