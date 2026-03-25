/**
 * AgentEventManager
 *
 * Machine-side singleton that:
 * - At startup: fetches all sessions from OpenCode and marks every one closed.
 *   Archived sessions (from agent-db) are excluded entirely from state.
 * - Subscribes to the machine-level OpenCode /event SSE stream.
 * - Un-closes a session the moment a live SSE status event arrives for it.
 * - Partitions sessions by workspace using session.directory.
 * - Aggregates SessionStatus, pending permissions, and last-message previews.
 * - Pushes AgentStateUpdateDelta to registered handlers.
 */

import type { OpenCodeRuntimeInfo } from '../../agents/opencode-runtime.js';
import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager, OpenCodeRuntimeManager } from '../../agents/opencode-runtime.js';
import { OpenCodeClient } from '../../agents/opencode-client.js';
import {
  parseOpenCodeEvent,
  type SessionStatus,
  type Permission,
  type PendingQuestion,
} from '../../agents/opencode-event-types.js';
import {
  getAgentSessionDisplayTitle,
  shouldDisplayAgentSession,
} from '../../agents/session-display.js';
import { normalizeWorkspacePath } from '../../agents/opencode-runtime-shared.js';
import { getAllArchivedSessions, getArchivedSessions } from '../../agents/agent-db.js';
import { writeAgentLog } from '../../agents/agent-log.js';

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
  /** Pending question tool invocations keyed by sessionID. */
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
const LAST_MESSAGE_DEBOUNCE_MS = 300;

interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  directory?: string;
  parentID?: string;
  time?: { updated?: number };
}

export class AgentEventManager {
  private readonly runtimeManager: OpenCodeRuntimeManager;
  private readonly workspaceStates = new Map<string, WorkspaceAgentState>();
  private readonly handlers = new Set<(delta: AgentStateUpdateDelta) => void>();
  private readonly lastMessageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly textAccumulators = new Map<string, string>();
  private readonly previousStatuses = new Map<string, SessionStatus>();
  private readonly workspacePaths = new Map<string, string>();
  /**
   * In-memory mirror of the archived-sessions DB, keyed by workspaceId.
   * Seeded by fetchInitialState and kept in sync by markSessionArchived /
   * markSessionRestored. All insertion paths go through ensureSessionEntry,
   * which checks this set before touching state.sessions — so no archived
   * session can ever re-appear in the live list regardless of which code path
   * triggers an upsert.
   */
  private readonly archivedSessionIds = new Map<string, Set<string>>();
  private eventAbortController: AbortController | null = null;
  private currentRuntimeInfo: OpenCodeRuntimeInfo | null = null;
  private readonly activeWorkspaceLoops = new Set<string>();
  private autoSubscribeEnabled = false;

  constructor(runtimeManager: OpenCodeRuntimeManager) {
    this.runtimeManager = runtimeManager;
    runtimeManager.onRuntimeStarted((info) => {
      if (this.autoSubscribeEnabled) {
        void this.subscribeRuntime(info);
      }
    });
    runtimeManager.onRuntimeStopped(() => { this.unsubscribeRuntime(); });
  }

  async initialize(): Promise<void> {
    this.autoSubscribeEnabled = true;
    const runtime = this.runtimeManager.listRuntimes()[0];
    if (runtime) {
      await this.subscribeRuntime(runtime);
    }
  }

  registerWorkspace(workspaceId: string, workspacePath: string): void {
    const normalized = normalizeWorkspacePath(workspacePath);
    this.workspacePaths.set(workspaceId, normalized);
    this.getOrCreateState(workspaceId);
    writeAgentLog('register workspace', { workspaceId, workspacePath: normalized });

    // Lazily seed archivedSessionIds for this workspace if fetchInitialState has
    // already run (which cleared and rebuilt from all then-known workspaces).
    // This ensures late-registered workspaces are also guarded.
    if (!this.archivedSessionIds.has(workspaceId)) {
      const rows = getArchivedSessions(workspaceId);
      if (rows.length > 0) {
        const ids = new Set(rows.map((r) => r.sessionId));
        this.archivedSessionIds.set(workspaceId, ids);
      }
    }

    // If the SSE runtime is already running, start a loop and reconcile current
    // status for this workspace immediately.
    if (this.currentRuntimeInfo && this.eventAbortController && !this.activeWorkspaceLoops.has(workspaceId)) {
      const info = this.currentRuntimeInfo;
      void this.runWorkspaceSseLoop(info, workspaceId, normalized, this.eventAbortController);
      void this.reconcileStatuses(info, workspaceId, normalized);
    }
  }

  syncKnownSessions(
    workspaceId: string,
    sessions: Array<Pick<AgentSessionSummary, 'id' | 'title' | 'updatedAt'>>,
  ): void {
    const state = this.getOrCreateState(workspaceId);
    let changed = false;

    for (const session of sessions) {
      const idx = state.sessions.findIndex((item) => item.id === session.id);
      if (idx === -1) {
        if (this.ensureSessionEntry(workspaceId, session.id, session.title, session.updatedAt)) {
          changed = true;
        }
        continue;
      }

      const existing = state.sessions[idx];
      const next: AgentSessionSummary = {
        ...existing,
        title: session.title,
        updatedAt: session.updatedAt,
      };
      if (
        next.title !== existing.title
        || next.updatedAt !== existing.updatedAt
      ) {
        state.sessions[idx] = next;
        changed = true;
      }
    }

    if (changed) {
      this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
    }
  }

  async reconcileWorkspace(workspaceId: string): Promise<void> {
    const info = this.currentRuntimeInfo;
    const workspacePath = this.workspacePaths.get(workspaceId);
    if (!info || !workspacePath) return;
    await this.reconcileStatuses(info, workspaceId, workspacePath);
  }

  subscribe(handler: (delta: AgentStateUpdateDelta) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  getSnapshot(): Record<string, WorkspaceAgentState> {
    const result: Record<string, WorkspaceAgentState> = {};
    for (const [workspaceId, state] of this.workspaceStates) {
      result[workspaceId] = state;
    }
    return result;
  }

  // -------------------------------------------------------------------------
  // Direct in-memory mutation methods (called after user-initiated actions)
  // -------------------------------------------------------------------------

  markSessionClosed(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    const idx = state.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return;
    if (state.sessions[idx].closedAt) return; // already closed
    state.sessions[idx] = { ...state.sessions[idx], closedAt: new Date().toISOString() };
    // Prune live data — closed sessions have no active status.
    delete state.statuses[sessionId];
    delete state.pendingPermissions[sessionId];
    delete state.pendingQuestions[sessionId];
    delete state.lastMessages[sessionId];
    delete state.errorMessages[sessionId];
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
    this.textAccumulators.delete(`${workspaceId}:${sessionId}`);
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  markSessionOpen(workspaceId: string, sessionId: string): void {
    const state = this.workspaceStates.get(workspaceId);
    if (!state) return;
    const idx = state.sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) {
      // Use the gatekeeper — archived sessions must never be re-opened this way.
      if (this.ensureSessionEntry(workspaceId, sessionId, sessionId)) {
        // The entry was added as closed; now immediately open it.
        const newIdx = state.sessions.findIndex((s) => s.id === sessionId);
        if (newIdx !== -1) {
          state.sessions[newIdx] = { ...state.sessions[newIdx], closedAt: undefined };
        }
        this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
      }
      return;
    }
    if (!state.sessions[idx].closedAt) return;
    state.sessions[idx] = { ...state.sessions[idx], closedAt: undefined };
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
    const existingIdx = state.sessions.findIndex((session) => session.id === sessionId);
    if (existingIdx === -1) {
      this.ensureSessionEntry(workspaceId, sessionId, sessionId);
    }
    const sessionIdx = state.sessions.findIndex((session) => session.id === sessionId);
    if (sessionIdx !== -1 && state.sessions[sessionIdx]?.closedAt) {
      state.sessions[sessionIdx] = { ...state.sessions[sessionIdx], closedAt: undefined };
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
    state.sessions = state.sessions.filter((s) => s.id !== sessionId);
    delete state.statuses[sessionId];
    delete state.pendingPermissions[sessionId];
    delete state.pendingQuestions[sessionId];
    delete state.lastMessages[sessionId];
    delete state.errorMessages[sessionId];
    this.previousStatuses.delete(`${workspaceId}:${sessionId}`);
    this.textAccumulators.delete(`${workspaceId}:${sessionId}`);
    // Mirror into the in-memory set so ensureSessionEntry blocks future re-insertion.
    let archived = this.archivedSessionIds.get(workspaceId);
    if (!archived) { archived = new Set(); this.archivedSessionIds.set(workspaceId, archived); }
    archived.add(sessionId);
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  markSessionRestored(workspaceId: string, sessionId: string, title: string): void {
    // Remove from the archived set first so ensureSessionEntry allows it back in.
    this.archivedSessionIds.get(workspaceId)?.delete(sessionId);
    const state = this.getOrCreateState(workspaceId);
    const existing = state.sessions.find((s) => s.id === sessionId);
    if (existing) {
      // Already in list (shouldn't happen, but be safe) — just clear archived flag.
      const idx = state.sessions.indexOf(existing);
      state.sessions[idx] = { ...existing, closedAt: new Date().toISOString(), archivedAt: undefined };
    } else {
      // Add back as closed — SSE will un-close it if the user opens it.
      state.sessions.push({ id: sessionId, title, closedAt: new Date().toISOString() });
    }
    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private emit(delta: AgentStateUpdateDelta): void {
    for (const handler of this.handlers) {
      try {
        handler(delta);
      } catch {
        // never let a handler crash the manager
      }
    }
  }

  /**
   * Gatekeeper for all insertions into state.sessions.
   */
  private ensureSessionEntry(
    workspaceId: string,
    id: string,
    title: string,
    updatedAt?: string,
  ): boolean {
    if (this.archivedSessionIds.get(workspaceId)?.has(id)) return false;
    const state = this.getOrCreateState(workspaceId);
    if (state.sessions.some((s) => s.id === id)) return false;
    state.sessions.push({ id, title, closedAt: new Date().toISOString(), updatedAt });
    return true;
  }

  private getOrCreateState(workspaceId: string): WorkspaceAgentState {
    let state = this.workspaceStates.get(workspaceId);
    if (!state) {
      state = { workspaceId, sessions: [], statuses: {}, pendingPermissions: {}, pendingQuestions: {}, lastMessages: {}, errorMessages: {} };
      this.workspaceStates.set(workspaceId, state);
    }
    return state;
  }

  private getWorkspaceIdForDirectory(directory?: string): string | null {
    if (!directory) return null;
    const normalized = normalizeWorkspacePath(directory);
    for (const [workspaceId, workspacePath] of this.workspacePaths) {
      if (workspacePath === normalized) return workspaceId;
    }
    return null;
  }

  private async subscribeRuntime(info: OpenCodeRuntimeInfo): Promise<void> {
    this.unsubscribeRuntime();
    const controller = new AbortController();
    this.eventAbortController = controller;
    this.currentRuntimeInfo = info;
    try {
      await this.fetchInitialState(info);
    } catch {
      // Non-fatal — SSE reconnect loop will keep trying.
    }
    void this.runSseLoop(info, controller);
  }

  private async fetchInitialState(info: OpenCodeRuntimeInfo): Promise<void> {
    const archivedRows = getAllArchivedSessions();
    this.archivedSessionIds.clear();
    for (const row of archivedRows) {
      let s = this.archivedSessionIds.get(row.workspaceId);
      if (!s) { s = new Set(); this.archivedSessionIds.set(row.workspaceId, s); }
      s.add(row.sessionId);
    }
    const archivedIds = this.archivedSessionIds;

    const authFetch = (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          authorization: createOpenCodeBasicAuthHeader(info),
        },
      });

    const startupClosedAt = new Date().toISOString();
    writeAgentLog('fetch initial state start', { runtimePort: info.port, workspaceCount: this.workspacePaths.size, archivedCount: archivedRows.length });

    for (const [workspaceId, workspacePath] of this.workspacePaths.entries()) {
      const state = this.getOrCreateState(workspaceId);
      const client = new OpenCodeClient({
        baseUrl: info.baseUrl,
        directory: workspacePath,
        fetch: authFetch,
      });
      let liveSessions: OpenCodeSessionInfo[] = [];
      try {
        liveSessions = (await client.listSessions()) as OpenCodeSessionInfo[];
      } catch {
        liveSessions = [];
      }
      const archived = archivedIds.get(workspaceId) ?? new Set();

      state.sessions = liveSessions
        .filter((s) => !archived.has(s.id) && shouldDisplayAgentSession(s))
        .map((s) => ({
          id: s.id,
          title: getAgentSessionDisplayTitle({ id: s.id, title: s.title, rawTitle: s.title }),
          closedAt: startupClosedAt,
          updatedAt: typeof s.time?.updated === 'number'
            ? new Date(s.time.updated).toISOString()
            : undefined,
        }));
      writeAgentLog('fetch initial state workspace', {
        workspaceId,
        workspacePath,
        liveCount: liveSessions.length,
        visibleCount: state.sessions.length,
        sample: state.sessions.slice(0, 5).map((s) => ({ id: s.id, title: s.title, closedAt: s.closedAt })),
      });

      state.statuses = {};
      state.pendingPermissions = {};
      state.pendingQuestions = {};
      state.lastMessages = {};
      state.errorMessages = {};
      void this.reconcileStatuses(info, workspaceId, workspacePath);
    }

    this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
  }

  private async runSseLoop(info: OpenCodeRuntimeInfo, controller: AbortController): Promise<void> {
    const loops = Array.from(this.workspacePaths.entries()).map(
      ([workspaceId, workspacePath]) =>
        this.runWorkspaceSseLoop(info, workspaceId, workspacePath, controller),
    );
    await Promise.all(loops);
  }

  private async runWorkspaceSseLoop(
    info: OpenCodeRuntimeInfo,
    workspaceId: string,
    workspacePath: string,
    controller: AbortController,
  ): Promise<void> {
    this.activeWorkspaceLoops.add(workspaceId);
    const authFetch = (input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: createOpenCodeBasicAuthHeader(info) },
      });
    const pollPromise = this.runWorkspaceStatusPollLoop(info, workspaceId, workspacePath, controller);

    try {
      while (!controller.signal.aborted) {
        try {
          const client = new OpenCodeClient({ baseUrl: info.baseUrl, directory: workspacePath, fetch: authFetch });
          for await (const event of client.subscribeToEvents(controller.signal)) {
            this.handleOpenCodeEvent(event as NonNullable<ReturnType<typeof parseOpenCodeEvent>>);
          }
        } catch {
          if (controller.signal.aborted) break;
          await this.delay(2000, controller.signal);
        }
      }
    } finally {
      void pollPromise.catch(() => {});
      this.activeWorkspaceLoops.delete(workspaceId);
    }
  }

  private async runWorkspaceStatusPollLoop(
    info: OpenCodeRuntimeInfo,
    workspaceId: string,
    workspacePath: string,
    controller: AbortController,
  ): Promise<void> {
    while (!controller.signal.aborted) {
      const state = this.workspaceStates.get(workspaceId);
      const hasOpenSessions = state?.sessions.some((session) => !session.closedAt) ?? false;
      if (hasOpenSessions) {
        await this.reconcileStatuses(info, workspaceId, workspacePath);
      }
      await this.delay(1000, controller.signal);
    }
  }

  private delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
  }

  private unsubscribeRuntime(): void {
    this.eventAbortController?.abort();
    this.eventAbortController = null;
    this.currentRuntimeInfo = null;
    this.activeWorkspaceLoops.clear();
  }

  private handleOpenCodeEvent(event: NonNullable<ReturnType<typeof parseOpenCodeEvent>>): void {
    const raw = event as { type: string; properties: Record<string, unknown> };

    switch (raw.type) {
      case 'session.status': {
        const props = raw.properties as { sessionID: string; status: SessionStatus };
        const { sessionID, status } = props;
        const workspaceId = this.findWorkspaceIdForSession(sessionID);
        if (!workspaceId) break;
        const state = this.getOrCreateState(workspaceId);
        const prevKey = `${workspaceId}:${sessionID}`;
        const prev = this.previousStatuses.get(prevKey);
        state.statuses[sessionID] = status;
        this.previousStatuses.set(prevKey, status);

        const sessIdx = state.sessions.findIndex((s) => s.id === sessionID);
        if (sessIdx !== -1 && state.sessions[sessIdx].closedAt) {
          state.sessions[sessIdx] = { ...state.sessions[sessIdx], closedAt: undefined };
        }

        this.emit({ type: 'agent_session_status', workspaceId, sessionId: sessionID, status });

        if (status.type === 'busy') {
          this.textAccumulators.delete(`${workspaceId}:${sessionID}`);
        }
        if (prev?.type === 'busy' && status.type === 'idle') {
          const preview = state.lastMessages[sessionID] ?? '';
          if (preview) {
            this.emit({ type: 'agent_last_message', workspaceId, sessionId: sessionID, preview });
          }
        }
        break;
      }

      case 'session.idle': {
        const props = raw.properties as { sessionID: string };
        const { sessionID } = props;
        const workspaceId = this.findWorkspaceIdForSession(sessionID);
        if (!workspaceId) break;
        const state = this.getOrCreateState(workspaceId);
        const prevKey = `${workspaceId}:${sessionID}`;
        const prev = this.previousStatuses.get(prevKey);
        const idleStatus: SessionStatus = { type: 'idle' };
        state.statuses[sessionID] = idleStatus;
        this.previousStatuses.set(prevKey, idleStatus);
        this.emit({ type: 'agent_session_status', workspaceId, sessionId: sessionID, status: idleStatus });
        if (prev?.type === 'busy') {
          const preview = state.lastMessages[sessionID] ?? '';
          if (preview) {
            this.emit({ type: 'agent_last_message', workspaceId, sessionId: sessionID, preview });
          }
        }
        break;
      }

      case 'permission.updated': {
        const permission = raw.properties as unknown as Permission;
        const workspaceId = this.findWorkspaceIdForSession(permission.sessionID);
        if (!workspaceId) break;
        const state = this.getOrCreateState(workspaceId);
        this.markSessionOpen(workspaceId, permission.sessionID);
        if (!state.pendingPermissions[permission.sessionID]) {
          state.pendingPermissions[permission.sessionID] = [];
        }
        const existing = state.pendingPermissions[permission.sessionID].findIndex((p) => p.id === permission.id);
        if (existing === -1) {
          state.pendingPermissions[permission.sessionID].push(permission);
          this.emit({ type: 'agent_permission_added', workspaceId, sessionId: permission.sessionID, permission });
        } else {
          state.pendingPermissions[permission.sessionID][existing] = permission;
        }
        break;
      }

      case 'permission.replied': {
        const props = raw.properties as { sessionID: string; permissionID: string };
        const workspaceId = this.findWorkspaceIdForSession(props.sessionID);
        if (!workspaceId) break;
        const state = this.getOrCreateState(workspaceId);
        this.markSessionOpen(workspaceId, props.sessionID);
        if (state.pendingPermissions[props.sessionID]) {
          state.pendingPermissions[props.sessionID] = state.pendingPermissions[props.sessionID].filter(
            (p) => p.id !== props.permissionID,
          );
        }
        this.emit({ type: 'agent_permission_removed', workspaceId, sessionId: props.sessionID, permissionId: props.permissionID });
        break;
      }

      case 'question.asked': {
        const question = raw.properties as unknown as PendingQuestion;
        const workspaceId = this.findWorkspaceIdForSession(question.sessionID);
        if (!workspaceId) break;
        const state = this.getOrCreateState(workspaceId);
        this.markSessionOpen(workspaceId, question.sessionID);
        if (!state.pendingQuestions[question.sessionID]) {
          state.pendingQuestions[question.sessionID] = [];
        }
        const existingIdx = state.pendingQuestions[question.sessionID].findIndex((q) => q.id === question.id);
        if (existingIdx === -1) {
          state.pendingQuestions[question.sessionID].push(question);
          this.emit({ type: 'agent_question_added', workspaceId, sessionId: question.sessionID, question });
        } else {
          state.pendingQuestions[question.sessionID][existingIdx] = question;
        }
        break;
      }

      case 'question.replied':
      case 'question.rejected': {
        const props = raw.properties as { sessionID: string; requestID: string };
        const workspaceId = this.findWorkspaceIdForSession(props.sessionID);
        if (!workspaceId) break;
        const state = this.getOrCreateState(workspaceId);
        if (state.pendingQuestions[props.sessionID]) {
          state.pendingQuestions[props.sessionID] = state.pendingQuestions[props.sessionID].filter(
            (q) => q.id !== props.requestID,
          );
        }
        this.emit({ type: 'agent_question_removed', workspaceId, sessionId: props.sessionID, requestId: props.requestID });
        break;
      }

      case 'session.error': {
        const props = raw.properties as { sessionID?: string; error?: { data?: { message?: string } } };
        if (!props.sessionID) break;
        const workspaceId = this.findWorkspaceIdForSession(props.sessionID);
        if (!workspaceId) break;
        this.markSessionOpen(workspaceId, props.sessionID);
        const errorMsg = props.error?.data?.message ?? 'Unknown error';
        const state = this.getOrCreateState(workspaceId);
        state.errorMessages[props.sessionID] = errorMsg;
        this.emit({ type: 'agent_session_error', workspaceId, sessionId: props.sessionID, errorMessage: errorMsg });
        break;
      }

      case 'session.created':
      case 'session.updated': {
        const props = raw.properties as { info: OpenCodeSessionInfo };
        const workspaceId = this.getWorkspaceIdForDirectory(props.info.directory);
        if (!workspaceId || !shouldDisplayAgentSession(props.info)) break;
        const state = this.getOrCreateState(workspaceId);
        const { id, title } = props.info;
        const titleOrId = getAgentSessionDisplayTitle({ id, title, rawTitle: title });
        const idx = state.sessions.findIndex((s) => s.id === id);
        if (idx !== -1) {
          state.sessions[idx] = { ...state.sessions[idx], id, title: titleOrId };
        } else {
          this.ensureSessionEntry(workspaceId, id, titleOrId);
        }
        this.emit({
          type: raw.type === 'session.created' ? 'agent_session_created' : 'agent_session_updated',
          workspaceId,
          sessionId: id,
          title: titleOrId,
        });
        break;
      }

      case 'session.deleted': {
        const props = raw.properties as { info: { id: string } };
        const workspaceId = this.findWorkspaceIdForSession(props.info.id);
        if (!workspaceId) break;
        const { id } = props.info;
        this.markSessionClosed(workspaceId, id);
        break;
      }

      case 'message.part.updated': {
        const props = raw.properties as { part: { sessionID: string } };
        const sessionID = props.part?.sessionID;
        if (!sessionID) break;
        const workspaceId = this.findWorkspaceIdForSession(sessionID);
        if (!workspaceId) break;
        this.markSessionOpen(workspaceId, sessionID);
        break;
      }

      case 'message.part.delta': {
        const props = raw.properties as { sessionID: string; field: string; delta: string };
        const { sessionID, field, delta } = props;
        if (field !== 'text' || !delta) break;
        const workspaceId = this.findWorkspaceIdForSession(sessionID);
        if (!workspaceId) break;
        this.markSessionOpen(workspaceId, sessionID);
        const state = this.getOrCreateState(workspaceId);
        const accKey = `${workspaceId}:${sessionID}`;
        const current = this.textAccumulators.get(accKey) ?? '';
        const updated = (current + delta).slice(-LAST_MESSAGE_MAX_CHARS);
        this.textAccumulators.set(accKey, updated);
        state.lastMessages[sessionID] = updated;
        const existingTimer = this.lastMessageTimers.get(accKey);
        if (existingTimer) clearTimeout(existingTimer);
        this.lastMessageTimers.set(
          accKey,
          setTimeout(() => {
            this.lastMessageTimers.delete(accKey);
            this.emit({ type: 'agent_last_message', workspaceId, sessionId: sessionID, preview: updated });
          }, LAST_MESSAGE_DEBOUNCE_MS),
        );
        break;
      }

      default:
        break;
    }
  }

  private async reconcileStatuses(info: OpenCodeRuntimeInfo, workspaceId: string, workspacePath: string): Promise<void> {
    try {
      const authFetch = (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, {
          ...init,
          headers: { ...(init?.headers ?? {}), authorization: createOpenCodeBasicAuthHeader(info) },
        });
      const client = new OpenCodeClient({ baseUrl: info.baseUrl, directory: workspacePath, fetch: authFetch });

      const [statuses, questions] = await Promise.all([
        client.getSessionStatuses(),
        client.getQuestions(),
      ]);

      const state = this.getOrCreateState(workspaceId);
      let changed = false;

      for (const [sessionId, status] of Object.entries(statuses)) {
        state.statuses[sessionId] = status as SessionStatus;
        const sessIdx = state.sessions.findIndex((s) => s.id === sessionId);
        if (sessIdx !== -1 && state.sessions[sessIdx].closedAt) {
          state.sessions[sessIdx] = { ...state.sessions[sessIdx], closedAt: undefined };
        }
        changed = true;
      }

      for (const sessionId of Object.keys(state.statuses)) {
        if (!(sessionId in statuses)) {
          delete state.statuses[sessionId];
          changed = true;
        }
      }

      const questionsBySession: Record<string, PendingQuestion[]> = {};
      for (const q of questions) {
        if (!questionsBySession[q.sessionID]) questionsBySession[q.sessionID] = [];
        questionsBySession[q.sessionID].push(q);
        this.markSessionOpen(workspaceId, q.sessionID);
      }
      const prevQJson = JSON.stringify(state.pendingQuestions);
      const nextQJson = JSON.stringify(questionsBySession);
      if (prevQJson !== nextQJson) {
        state.pendingQuestions = questionsBySession;
        changed = true;
      }

      for (const sessionId of Object.keys(state.errorMessages)) {
        if (state.statuses[sessionId]?.type !== 'retry') {
          delete state.errorMessages[sessionId];
        }
      }


      if (changed) {
        this.emit({ type: 'agent_state_snapshot', workspaces: this.getSnapshot() });
      }
    } catch {
      // Non-fatal — SSE events will keep state fresh going forward.
    }
  }

  private findWorkspaceIdForSession(sessionId: string): string | null {
    for (const [workspaceId, state] of this.workspaceStates) {
      if (state.sessions.some((session) => session.id === sessionId)) {
        return workspaceId;
      }
    }
    return null;
  }
}

export const defaultAgentEventManager = new AgentEventManager(defaultOpenCodeRuntimeManager);
