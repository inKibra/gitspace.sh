/**
 * AgentEventManager
 *
 * Machine-side singleton that:
 * - Subscribes to each workspace's OpenCode /event SSE stream
 * - Aggregates SessionStatus, pending permissions, and last-message previews
 * - Pushes AgentStateUpdateDelta to registered handlers (relay broadcast + local UI)
 *
 * Clients never open /event SSE themselves for notification purposes.
 * The raw /event SSE is only used when a user explicitly opens OpenCode web.
 */

import type { OpenCodeRuntimeInfo } from '../agents/opencode-runtime.js';
import { createOpenCodeBasicAuthHeader, defaultOpenCodeRuntimeManager, OpenCodeRuntimeManager } from '../agents/opencode-runtime.js';
import { consumeSseStream } from '../agents/opencode-sse.js';
import {
  parseOpenCodeEvent,
  type SessionStatus,
  type Permission,
} from '../agents/opencode-event-types.js';
import { markStoredSessionClosed, replaceStoredSessions, upsertStoredSession } from '../agents/opencode-store.js';

// ============================================================================
// Shared agent state types (used by both machine and client)
// ============================================================================

export interface AgentSessionSummary {
  id: string;
  title: string;
}

export interface WorkspaceAgentState {
  workspaceId: string;
  sessions: AgentSessionSummary[];
  /** sessionId → current status */
  statuses: Record<string, SessionStatus>;
  /** sessionId → array of pending permissions */
  pendingPermissions: Record<string, Permission[]>;
  /** sessionId → last ~120 chars of most recent assistant text */
  lastMessages: Record<string, string>;
}

export type AgentStateUpdateDelta =
  | { type: 'agent_state_snapshot'; workspaces: Record<string, WorkspaceAgentState> }
  | { type: 'agent_session_status'; workspaceId: string; sessionId: string; status: SessionStatus }
  | { type: 'agent_permission_added'; workspaceId: string; sessionId: string; permission: Permission }
  | { type: 'agent_permission_removed'; workspaceId: string; sessionId: string; permissionId: string }
  | { type: 'agent_session_error'; workspaceId: string; sessionId: string; errorMessage: string }
  | { type: 'agent_last_message'; workspaceId: string; sessionId: string; preview: string }
  | { type: 'agent_session_created'; workspaceId: string; sessionId: string; title: string }
  | { type: 'agent_session_updated'; workspaceId: string; sessionId: string; title: string }
  | { type: 'agent_session_deleted'; workspaceId: string; sessionId: string };

// ============================================================================
// AgentEventManager
// ============================================================================

const LAST_MESSAGE_MAX_CHARS = 120;
const LAST_MESSAGE_DEBOUNCE_MS = 300;

export class AgentEventManager {
  private readonly runtimeManager: OpenCodeRuntimeManager;
  private readonly workspaceStates = new Map<string, WorkspaceAgentState>();
  private readonly eventAbortControllers = new Map<string, AbortController>();
  private readonly handlers = new Set<(delta: AgentStateUpdateDelta) => void>();
  /** Per-session debounce timer for last-message updates */
  private readonly lastMessageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Accumulator for streaming text per session (reset on new assistant message) */
  private readonly textAccumulators = new Map<string, string>();
  /** Track previously-seen status to detect busy→idle transitions */
  private readonly previousStatuses = new Map<string, SessionStatus>();
  private readonly workspacePaths = new Map<string, string>();
  private readonly persistedWriteChains = new Map<string, Promise<void>>();

  constructor(runtimeManager: OpenCodeRuntimeManager) {
    this.runtimeManager = runtimeManager;
    runtimeManager.onRuntimeStarted((info) => { void this.subscribeWorkspace(info); });
    runtimeManager.onRuntimeStopped((workspaceId) => { this.unsubscribeWorkspace(workspaceId); });
  }

  /**
   * Initialize from already-running runtimes. Call eagerly at startup.
   */
  async initialize(): Promise<void> {
    const runtimes = this.runtimeManager.listRuntimes();
    await Promise.allSettled(runtimes.map((info) => this.subscribeWorkspace(info)));
  }

  /**
   * Subscribe to state updates. Returns an unsubscribe function.
   */
  subscribe(handler: (delta: AgentStateUpdateDelta) => void): () => void {
    this.handlers.add(handler);
    return () => { this.handlers.delete(handler); };
  }

  /**
   * Get a full snapshot of current state for all workspaces.
   */
  getSnapshot(): Record<string, WorkspaceAgentState> {
    const result: Record<string, WorkspaceAgentState> = {};
    for (const [workspaceId, state] of this.workspaceStates) {
      result[workspaceId] = state;
    }
    return result;
  }

  // ============================================================================
  // Private helpers
  // ============================================================================

  private emit(delta: AgentStateUpdateDelta): void {
    for (const handler of this.handlers) {
      try {
        handler(delta);
      } catch {
        // never let a handler error crash the manager
      }
    }
  }

  private queuePersistedWrite(workspaceId: string, operation: () => Promise<void>): void {
    const previous = this.persistedWriteChains.get(workspaceId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(operation)
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[agent-event-manager] failed to persist session history for ${workspaceId}: ${message}`);
      });
    this.persistedWriteChains.set(workspaceId, next);
  }

  private getOrCreateState(workspaceId: string): WorkspaceAgentState {
    let state = this.workspaceStates.get(workspaceId);
    if (!state) {
      state = { workspaceId, sessions: [], statuses: {}, pendingPermissions: {}, lastMessages: {} };
      this.workspaceStates.set(workspaceId, state);
    }
    return state;
  }

  private async subscribeWorkspace(info: OpenCodeRuntimeInfo): Promise<void> {
    const { workspaceId } = info;
    this.workspacePaths.set(workspaceId, info.workspacePath);

    // Abort any previous subscription for this workspace
    this.eventAbortControllers.get(workspaceId)?.abort();

    const controller = new AbortController();
    this.eventAbortControllers.set(workspaceId, controller);

    // Fetch initial session list + statuses
    try {
      await this.fetchInitialState(info);
    } catch {
      // Non-fatal — we'll get updates from SSE anyway
    }

    // Start SSE loop with reconnect
    void this.runSseLoop(info, controller);
  }

  private async fetchInitialState(info: OpenCodeRuntimeInfo): Promise<void> {
    const authHeader = createOpenCodeBasicAuthHeader(info);

    const [sessionsResp, statusesResp] = await Promise.all([
      fetch(`${info.baseUrl}/session`, { headers: { authorization: authHeader } }),
      fetch(`${info.baseUrl}/session/status`, { headers: { authorization: authHeader } }),
    ]);

    const state = this.getOrCreateState(info.workspaceId);

    if (sessionsResp.ok) {
      const sessions = (await sessionsResp.json()) as Array<{ id: string; title?: string; directory?: string; parentID?: string; time?: { updated?: number } }>;
      const filtered = sessions.filter(
        (session) => session.directory === info.workspacePath && !session.parentID,
      );
      state.sessions = filtered.map((s) => ({ id: s.id, title: s.title ?? s.id }));
      this.queuePersistedWrite(
        info.workspaceId,
        () => replaceStoredSessions(
          info.workspaceId,
          filtered.map((session) => ({
            id: session.id,
            title: session.title ?? session.id,
            rawTitle: session.title,
            parentID: session.parentID,
            updatedAt: typeof session.time?.updated === 'number' ? new Date(session.time.updated).toISOString() : undefined,
          })),
        ),
      );
    }

    if (statusesResp.ok) {
      const statuses = (await statusesResp.json()) as Record<string, SessionStatus>;
      const allowedSessionIds = new Set(state.sessions.map((session) => session.id));
      state.statuses = Object.fromEntries(
        Object.entries(statuses).filter(([sessionId]) => allowedSessionIds.has(sessionId)),
      );
      for (const [sessionId, status] of Object.entries(state.statuses)) {
        this.previousStatuses.set(`${info.workspaceId}:${sessionId}`, status);
      }
    }
  }

  private async runSseLoop(info: OpenCodeRuntimeInfo, controller: AbortController): Promise<void> {
    const { workspaceId } = info;
    const authHeader = createOpenCodeBasicAuthHeader(info);

    while (!controller.signal.aborted) {
      try {
        const response = await fetch(`${info.baseUrl}/event`, {
          headers: {
            accept: 'text/event-stream',
            authorization: authHeader,
          },
          signal: controller.signal,
        });

        if (!response.ok || !response.body) {
          // Wait before retrying
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 3000);
            controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
          });
          continue;
        }

        await consumeSseStream(response.body, async (parsed) => {
          if (!parsed.data || parsed.data === '[DONE]') return;
          const evt = parseOpenCodeEvent(parsed.data);
          if (evt) {
            this.handleOpenCodeEvent(workspaceId, evt);
          }
        });
      } catch (error) {
        if (controller.signal.aborted) break;
        // Connection dropped — wait 2s then retry
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2000);
          controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    }
  }

  private unsubscribeWorkspace(workspaceId: string): void {
    this.eventAbortControllers.get(workspaceId)?.abort();
    this.eventAbortControllers.delete(workspaceId);
    this.workspaceStates.delete(workspaceId);
    this.workspacePaths.delete(workspaceId);
  }

  private handleOpenCodeEvent(workspaceId: string, event: NonNullable<ReturnType<typeof parseOpenCodeEvent>>): void {
    const state = this.getOrCreateState(workspaceId);
    // Use a raw object cast since the OpenCodeEvent union has a catch-all and
    // TypeScript can't narrow discriminants against it reliably.
    const raw = event as { type: string; properties: Record<string, unknown> };

    switch (raw.type) {
      case 'session.status': {
        const props = raw.properties as { sessionID: string; status: SessionStatus };
        const { sessionID, status } = props;
        if (!state.sessions.some((session) => session.id === sessionID)) {
          break;
        }
        const prevKey = `${workspaceId}:${sessionID}`;
        const prev = this.previousStatuses.get(prevKey);
        state.statuses[sessionID] = status;
        this.previousStatuses.set(prevKey, status);
        this.emit({ type: 'agent_session_status', workspaceId, sessionId: sessionID, status });
        const existingSession = state.sessions.find((session) => session.id === sessionID);
        if (existingSession) {
          this.queuePersistedWrite(workspaceId, () => upsertStoredSession(workspaceId, {
            id: sessionID,
            title: existingSession.title,
            rawTitle: existingSession.title,
            lastKnownStatus: status.type,
          }));
        }

        // Reset text accumulator on new busy turn so each turn gets a fresh preview
        if (status.type === 'busy') {
          this.textAccumulators.delete(`${workspaceId}:${sessionID}`);
        }

        // busy→idle transition: also emit the last accumulated message preview
        if (prev?.type === 'busy' && status.type === 'idle') {
          const preview = state.lastMessages[sessionID] ?? '';
          if (preview) {
            this.emit({ type: 'agent_last_message', workspaceId, sessionId: sessionID, preview });
          }
        }
        break;
      }

      case 'permission.updated': {
        const permission = raw.properties as unknown as Permission;
        const sessionID = permission.sessionID;
        if (!state.sessions.some((session) => session.id === sessionID)) {
          break;
        }
        if (!state.pendingPermissions[sessionID]) {
          state.pendingPermissions[sessionID] = [];
        }
        const existing = state.pendingPermissions[sessionID].findIndex((p) => p.id === permission.id);
        if (existing === -1) {
          // New permission — add to cache and notify
          state.pendingPermissions[sessionID].push(permission);
          this.emit({ type: 'agent_permission_added', workspaceId, sessionId: sessionID, permission });
        } else {
          // Update to existing permission — update cache only, no duplicate notification
          state.pendingPermissions[sessionID][existing] = permission;
        }
        break;
      }

      case 'permission.replied': {
        const props = raw.properties as { sessionID: string; permissionID: string; response: string };
        const { sessionID, permissionID } = props;
        if (!state.sessions.some((sessionItem) => sessionItem.id === sessionID)) {
          break;
        }
        if (state.pendingPermissions[sessionID]) {
          state.pendingPermissions[sessionID] = state.pendingPermissions[sessionID].filter(
            (p) => p.id !== permissionID,
          );
        }
        this.emit({ type: 'agent_permission_removed', workspaceId, sessionId: sessionID, permissionId: permissionID });
        break;
      }

      case 'session.error': {
        const props = raw.properties as { sessionID?: string; error?: { data?: { message?: string } } };
        if (!props.sessionID) break;
        if (!state.sessions.some((session) => session.id === props.sessionID)) {
          break;
        }
        const errorMsg = props.error?.data?.message ?? 'Unknown error';
        this.emit({ type: 'agent_session_error', workspaceId, sessionId: props.sessionID, errorMessage: errorMsg });
        break;
      }

      case 'session.created': {
        const props = raw.properties as { info: { id: string; title?: string; directory?: string; parentID?: string } };
        if (props.info.directory && props.info.directory !== this.workspacePaths.get(workspaceId)) {
          break;
        }
        if (props.info.parentID) {
          break;
        }
        const { id, title } = props.info;
        const titleOrId = title ?? id;
        if (!state.sessions.some((s) => s.id === id)) {
          state.sessions.push({ id, title: titleOrId });
        }
        this.emit({ type: 'agent_session_created', workspaceId, sessionId: id, title: titleOrId });
        this.queuePersistedWrite(workspaceId, () => upsertStoredSession(workspaceId, { id, title: titleOrId, rawTitle: title, parentID: props.info.parentID }));
        break;
      }

      case 'session.updated': {
        const props = raw.properties as { info: { id: string; title?: string; directory?: string; parentID?: string } };
        if (props.info.directory && props.info.directory !== this.workspacePaths.get(workspaceId)) {
          break;
        }
        if (props.info.parentID) {
          break;
        }
        const { id, title } = props.info;
        const titleOrId = title ?? id;
        const idx = state.sessions.findIndex((s) => s.id === id);
        if (idx !== -1) state.sessions[idx] = { id, title: titleOrId };
        if (idx === -1) state.sessions.push({ id, title: titleOrId });
        this.emit({ type: 'agent_session_updated', workspaceId, sessionId: id, title: titleOrId });
        this.queuePersistedWrite(workspaceId, () => upsertStoredSession(workspaceId, { id, title: titleOrId, rawTitle: title, parentID: props.info.parentID }));
        break;
      }

      case 'session.deleted': {
        const props = raw.properties as { info: { id: string } };
        const { id } = props.info;
        state.sessions = state.sessions.filter((s) => s.id !== id);
        delete state.statuses[id];
        delete state.pendingPermissions[id];
        delete state.lastMessages[id];
        this.previousStatuses.delete(`${workspaceId}:${id}`);
        this.textAccumulators.delete(`${workspaceId}:${id}`);
        this.emit({ type: 'agent_session_deleted', workspaceId, sessionId: id });
        this.queuePersistedWrite(workspaceId, () => markStoredSessionClosed(workspaceId, id));
        break;
      }

      case 'message.part.updated': {
        const props = raw.properties as {
          part: { sessionID: string; type: string };
          delta?: string;
        };
        const { part, delta } = props;
        if (part.type !== 'text' || !delta) break;
        if (!state.sessions.some((session) => session.id === part.sessionID)) {
          break;
        }
        const accKey = `${workspaceId}:${part.sessionID}`;
        const current = this.textAccumulators.get(accKey) ?? '';
        const updated = (current + delta).slice(-LAST_MESSAGE_MAX_CHARS);
        this.textAccumulators.set(accKey, updated);
        state.lastMessages[part.sessionID] = updated;

        // Debounce the last_message emit
        const existingTimer = this.lastMessageTimers.get(accKey);
        if (existingTimer) clearTimeout(existingTimer);
        this.lastMessageTimers.set(
          accKey,
          setTimeout(() => {
            this.lastMessageTimers.delete(accKey);
            this.emit({ type: 'agent_last_message', workspaceId, sessionId: part.sessionID, preview: updated });
          }, LAST_MESSAGE_DEBOUNCE_MS),
        );
        break;
      }

      default:
        break;
    }
  }
}

export const defaultAgentEventManager = new AgentEventManager(defaultOpenCodeRuntimeManager);
