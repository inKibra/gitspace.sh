/**
 * Remote session handler - processes browse and PTY commands
 *
 * Handles the encrypted messages between client and machine after X3DH handshake.
 */

import { createFrame, openFrame } from "../tmux-lite/crypto/frames.js";
import {
  parseRemoteMessage,
  serializeRemoteMessage,
  type ClientToMachineMessage,
  type MachineToClientMessage,
  type SessionInfo,
} from "./protocol.js";
import { scanWorkspaces } from "./workspace-scanner.js";
import { parseProcessSessionName } from "../processes/names.js";
import type { SessionKeys, AccessType } from "../../types/identity.js";

// Import tmux-lite API for session management
import {
  listSessions,
  createSession,
  killSession,
  isServerRunning,
  ensureServer,
  getInbox,
  clearInbox,
  markInboxRead,
  type Session,
} from "../tmux-lite/cli.js";

// Import project loading
import { loadProjects } from "../../tui/state.js";

// Import workspace operations
import { deleteWorkspaceCore } from "../../core/workspace.js";
import { readProjectConfig } from "../../core/config.js";
import { readWorkspaceSnapshots } from "../events/reader.js";
import { resolveWorkspaceRef } from "../events/paths.js";
import { loadSavedEventFilters } from "../events/filters.js";
import { getProcessSpecs, startProcessInstance, stopProcessInstance } from "../processes/manager.js";
import { autostartProcesses } from "../processes/autostart.js";
import { startProcessScheduler } from "../processes/scheduler.js";
import { loadProcessesConfig } from "../processes/config.js";
import { existsSync } from "fs";

// Import script execution
import { runWorkspaceScripts } from "../../utils/run-workspace-scripts.js";
import { logger } from "../../utils/logger.js";

/**
 * Session state for a connected client
 */
export type ClientState = "browsing" | "attached";

export interface RemoteClientSession {
  connectionId: string;
  state: ClientState;
  sessionKeys: SessionKeys;
  /** Access type granted to this client */
  accessType?: AccessType;
  /** For session-invite: the specific session ID access was granted to */
  grantedSessionId?: string;
  /** Attached tmux-lite session ID (set after attach_session) */
  attachedSessionId?: string;
  /** Path to tmux-lite session socket (set after attach_session) */
  sessionSocketPath?: string;
}

export interface RemoteSessionHandlerOptions {
  processHostDomain?: string;
  onProcessesChanged?: (workspacePath: string) => void | Promise<void>;
}

// ============================================================================
// Permission Helpers
// ============================================================================

/**
 * Check if access type grants management permission
 */
function canManage(accessType: AccessType | undefined): boolean {
  return accessType === 'full';
}

/**
 * Check if client can attach to a specific session
 */
function canAttachSession(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  targetSessionId: string
): boolean {
  if (accessType === 'full') return true;
  if (accessType === 'session-invite') {
    return grantedSessionId === targetSessionId;
  }
  return false;
}

/**
 * Remote session handler
 */
export class RemoteSessionHandler {
  private tmuxLiteAvailable = false;
  private processSchedulers = new Map<string, NodeJS.Timer>();
  private processHostDomain?: string;
  private onProcessesChanged?: (workspacePath: string) => void | Promise<void>;

  constructor(options: RemoteSessionHandlerOptions = {}) {
    this.processHostDomain = options.processHostDomain;
    this.onProcessesChanged = options.onProcessesChanged;
  }

  /**
   * Initialize - check if tmux-lite is available
   */
  async initialize(): Promise<void> {
    try {
      this.tmuxLiteAvailable = await isServerRunning();
      if (!this.tmuxLiteAvailable) {
        // Try to start the server
        await ensureServer();
        this.tmuxLiteAvailable = true;
      }
    } catch (e) {
      console.warn("[remote-session] tmux-lite not available:", e);
      this.tmuxLiteAvailable = false;
    }
  }

  /**
   * Handle an encrypted message from a client
   *
   * @param session - Client session info
   * @param encryptedData - Encrypted frame data
   * @param sendResponse - Callback to send encrypted response
   */
  async handleMessage(
    session: RemoteClientSession,
    encryptedData: Uint8Array,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      // Decrypt the frame
      const frame = await openFrame(encryptedData, session.sessionKeys.receiveKey);
      if (!frame) {
        console.error("[remote-session] Failed to decrypt frame");
        return;
      }

      // Parse as JSON message
      const json = new TextDecoder().decode(frame.data);
      const msg = parseRemoteMessage(json);

      if (!msg) {
        console.error("[remote-session] Failed to parse message");
        return;
      }

      // Handle based on message type
      await this.processMessage(session, msg as ClientToMachineMessage, sendResponse);
    } catch (e) {
      console.error("[remote-session] Error handling message:", e);
      await this.sendError(session, sendResponse, "INTERNAL_ERROR", "Failed to process message");
    }
  }

  /**
   * Process a client message
   */
  private async processMessage(
    session: RemoteClientSession,
    msg: ClientToMachineMessage,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    switch (msg.type) {
      case "list_workspaces":
        await this.handleListWorkspaces(session, sendResponse);
        break;

      case "list_sessions":
        await this.handleListSessions(session, msg.workspaceId, sendResponse);
        break;

      case "attach_session":
        // Permission check for attach_session is done in handleAttachSession
        // because it depends on whether creating new session or attaching existing
        await this.handleAttachSession(session, msg, sendResponse);
        break;

      // Note: resize, detach, and pty_input are handled in attached mode
      // via client-session-manager using tmux-lite's SessionCtrl protocol,
      // not through this JSON-RPC handler.

      case "list_projects":
        await this.handleListProjects(session, sendResponse);
        break;

      case "kill_session":
        // Security: Requires management permission
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to kill sessions");
          return;
        }
        await this.handleKillSession(session, msg.sessionId, sendResponse);
        break;

      case "delete_workspace":
        // Security: Requires management permission
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to delete workspaces");
          return;
        }
        await this.handleDeleteWorkspace(session, msg.projectName, msg.workspaceId, sendResponse);
        break;

      case "get_inbox":
        await this.handleGetInbox(session, sendResponse);
        break;

      case "get_events":
        await this.handleGetEvents(
          session,
          msg.workspacePath,
          msg.processName,
          msg.processInstance,
          msg.filter,
          msg.limit,
          msg.sinceMs,
          sendResponse
        );
        break;

      case "start_process":
        await this.handleStartProcess(session, msg.workspaceId, msg.processName, sendResponse);
        break;

      case "stop_process":
        await this.handleStopProcess(session, msg.workspaceId, msg.processName, sendResponse);
        break;

      case "clear_inbox":
        await this.handleClearInbox(session, msg.id, sendResponse);
        break;

      case "mark_inbox_read":
        await this.handleMarkInboxRead(session, msg.id, sendResponse);
        break;

      default: {
        // Exhaustiveness check - log unknown message types
        const unknownMsg = msg as { type: string };
        console.warn("[remote-session] Unknown message type:", unknownMsg.type);
      }
    }
  }

  /**
   * Handle list_workspaces request
   */
  private async handleListWorkspaces(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    const workspaces = await scanWorkspaces();

    // Add session counts from tmux-lite
    if (this.tmuxLiteAvailable) {
      try {
        const sessions = await listSessions();
        for (const workspace of workspaces) {
          // Count sessions for this workspace by matching cwd.
          // Note: Session cwd is set once at creation time and does NOT change
          // as users navigate within the shell. This is intentional - we want to
          // show sessions that were *created for* this workspace.
          const workspaceSessions = sessions.filter(s => s.cwd === workspace.path);
          workspace.sessionCount = workspaceSessions.length;

          const processConfig = loadProcessesConfig(workspace.path);
          workspace.processes = processConfig.processes.map((process) => ({
            name: process.name,
            instances: process.instances,
            ports: process.ports,
          }));
        }
      } catch {
        // Ignore errors - just use 0 session counts
      }
    }

    if (this.processHostDomain) {
      for (const workspace of workspaces) {
        workspace.serveDomain = this.processHostDomain;
      }
    }

     await this.sendMessage(session, sendResponse, {
       type: "workspace_list",
       workspaces,
       savedEventFilters: workspaces.length > 0 ? loadSavedEventFilters(workspaces[0].path) : [],
     });

  }

  /**
   * Handle list_sessions request
   */
  private async handleListSessions(
    session: RemoteClientSession,
    workspaceId: string | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    let sessions: SessionInfo[] = [];

    if (this.tmuxLiteAvailable) {
      try {
        const allSessions = await listSessions();
        const workspaces = await scanWorkspaces();

        // Build a map of workspace path -> workspace info
        const workspacePathMap = new Map(workspaces.map(w => [w.path, w]));

        sessions = allSessions
          .filter(s => {
            if (!workspaceId) return true;
            const parsed = parseProcessSessionName(s.name);
            if (parsed) return parsed.workspaceId === workspaceId;
            const ws = workspacePathMap.get(s.cwd);
            if (ws) return ws.id === workspaceId;
            return workspaces.some(workspace => s.cwd.startsWith(workspace.path));
          })
          .map(s => {
            const parsed = parseProcessSessionName(s.name);
            let ws = workspacePathMap.get(s.cwd);
            if (!ws && parsed) {
              ws = workspaces.find(workspace => workspace.id === parsed.workspaceId);
            }
            if (!ws) {
              ws = workspaces.find(workspace => s.cwd.startsWith(workspace.path));
            }
            return {
              id: s.id,
              name: s.name,
              workspaceId: ws?.id ?? parsed?.workspaceId ?? "unknown",
              attached: s.attached,
              createdAt: s.createdAt,
              processTitle: s.processTitle,
              exitCode: s.exitCode,
              processName: s.processName ?? parsed?.processName,
              processInstance: s.processInstance ?? parsed?.instance,
            };
          });
      } catch (e) {
        console.error("[remote-session] Failed to list sessions:", e);
      }
    }

    await this.sendMessage(session, sendResponse, {
      type: "session_list",
      sessions,
    });
  }

  /**
   * Handle attach_session request
   */
  private async handleAttachSession(
    session: RemoteClientSession,
    msg: { sessionId?: string; workspaceId?: string; sessionName?: string; command?: string; args?: string[]; env?: Record<string, string>; cols?: number; rows?: number },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    console.log("[remote-session] handleAttachSession:", JSON.stringify(msg));

    if (!this.tmuxLiteAvailable) {
      await this.sendError(session, sendResponse, "UNAVAILABLE", "Session manager not available");
      return;
    }

    try {
      let targetSession: Session | null = null;

      // If no session ID, create new session in workspace
      if (!msg.sessionId && msg.workspaceId) {
        // Security: Creating new sessions requires full/manage access
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to create sessions");
          return;
        }

        // Find the workspace path
        const workspaces = await scanWorkspaces();
        const workspace = workspaces.find(w => w.id === msg.workspaceId);

        if (!workspace) {
          await this.sendError(session, sendResponse, "NOT_FOUND", "Workspace not found");
          return;
        }

        // Run setup or select scripts for the workspace with output streaming
        const config = readProjectConfig(workspace.projectName);

        console.log(`[remote-session] Running workspace scripts for: ${workspace.id}`);

        // Track current phase for script_output messages
        let currentPhase: 'pre' | 'setup' | 'select' = 'pre';

        const scriptResult = await runWorkspaceScripts({
          projectName: workspace.projectName,
          workspacePath: workspace.path,
          workspaceName: workspace.id,
          repository: config.repository,
          interactive: false, // Remote context - scripts can't prompt for input
          onOutput: (data) => {
            // Stream script output to client (base64 encode for binary safety)
            // Use void + catch to avoid unhandled promise rejections since this callback isn't awaited
            void this.sendMessage(session, sendResponse, {
              type: 'script_output',
              phase: currentPhase,
              data: data.toString('base64'),
            }).catch((error) => {
              logger.debug(`[remote-session] Failed to stream script output: ${error instanceof Error ? error.message : String(error)}`);
            });
          },
          onPhaseStart: (phase) => {
            currentPhase = phase;
          },
        });

        if (!scriptResult.success) {
          console.error(`[remote-session] ${scriptResult.phase} scripts failed:`, scriptResult.error);
          // Send final script_output with error info
          await this.sendMessage(session, sendResponse, {
            type: 'script_output',
            phase: scriptResult.phase,
            data: '',
            done: true,
            error: scriptResult.error,
          });
          await this.sendError(session, sendResponse, "SCRIPT_FAILED", `Workspace scripts failed during ${scriptResult.phase} phase: ${scriptResult.error}`);
          return;
        }

        // Send final script_output indicating success
        await this.sendMessage(session, sendResponse, {
          type: 'script_output',
          phase: currentPhase,
          data: '',
          done: true,
        });

        // Create session name: use provided name or auto-generate
        let sessionName: string;
        if (msg.sessionName) {
          // Use provided name with project:workspace prefix
          sessionName = `${workspace.projectName}:${workspace.id}:${msg.sessionName}`;
          console.log(`[remote-session] Using provided session name: ${sessionName}`);
        } else {
          // Auto-generate: project:workspace:N
          const sessions = await listSessions();
          const existingCount = sessions.filter(s =>
            s.name.startsWith(`${workspace.projectName}:${workspace.id}:`)
          ).length;
          sessionName = `${workspace.projectName}:${workspace.id}:${existingCount + 1}`;
          console.log(`[remote-session] Auto-generated session name: ${sessionName}`);
        }

        targetSession = await createSession(sessionName, workspace.path, {
          command: msg.command,
          args: msg.args,
          env: msg.env,
        });
        console.log(`[remote-session] Created session: ${targetSession.name} (id: ${targetSession.id})`)

        const specs = getProcessSpecs(workspace.path)
        await autostartProcesses(workspace.path, specs)
        if (this.onProcessesChanged) {
          Promise.resolve(this.onProcessesChanged(workspace.path)).catch(() => undefined);
        }
        if (!this.processSchedulers.has(workspace.path)) {
          this.processSchedulers.set(workspace.path, startProcessScheduler(workspace.path))
        }
      } else if (msg.sessionId) {
        // Security: Check if client can attach to this session
        if (!canAttachSession(session.accessType, session.grantedSessionId, msg.sessionId)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Not authorized to attach to this session");
          return;
        }

        // Find existing session
        const sessions = await listSessions();
        targetSession = sessions.find(s => s.id === msg.sessionId) ?? null;
      }

      if (!targetSession) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Session not found");
        return;
      }

      session.state = "attached";
      session.attachedSessionId = targetSession.id;
      session.sessionSocketPath = targetSession.socketPath;

      // Send confirmation - ClientSessionManager will connect to the socket
      await this.sendMessage(session, sendResponse, {
        type: "attached",
        sessionId: targetSession.id,
        sessionName: targetSession.name,
        cols: msg.cols ?? 80,
        rows: msg.rows ?? 24,
      });
    } catch (e) {
      console.error("[remote-session] Failed to attach session:", e);
      await this.sendError(session, sendResponse, "ATTACH_FAILED", "Failed to attach to session");
    }
  }

  /**
   * Handle list_projects request
   */
  private async handleListProjects(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const projects = loadProjects();
      await this.sendMessage(session, sendResponse, {
        type: "project_list",
        projects: projects.map(p => ({
          name: p.name,
          repository: p.repository,
          workspaceCount: p.workspaceCount,
          isCurrent: p.isCurrent,
        })),
      });
    } catch (e) {
      console.error("[remote-session] Failed to list projects:", e);
      await this.sendError(session, sendResponse, "LIST_FAILED", "Failed to list projects");
    }
  }

  /**
   * Handle kill_session request
   */
  private async handleKillSession(
    session: RemoteClientSession,
    sessionId: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    if (!this.tmuxLiteAvailable) {
      await this.sendError(session, sendResponse, "UNAVAILABLE", "Session manager not available");
      return;
    }

    try {
      // Look up the session's workspaceId before killing
      const sessions = await listSessions();
      const workspaces = await scanWorkspaces();
      const workspacePathMap = new Map(workspaces.map(w => [w.path, w]));
      const targetSession = sessions.find(s => s.id === sessionId);
      const workspace = targetSession ? workspacePathMap.get(targetSession.cwd) : undefined;
      const workspaceId = workspace?.id ?? "unknown";

      await killSession(sessionId);
      // Wait a bit for the server to process the kill
      await new Promise(resolve => setTimeout(resolve, 100));
      await this.sendMessage(session, sendResponse, {
        type: "session_killed",
        sessionId,
        workspaceId,
      });
    } catch (e) {
      console.error("[remote-session] Failed to kill session:", e);
      await this.sendError(session, sendResponse, "KILL_FAILED", "Failed to kill session");
    }
  }

  /**
   * Handle delete_workspace request
   */
  private async handleDeleteWorkspace(
    session: RemoteClientSession,
    projectName: string,
    workspaceId: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const result = await deleteWorkspaceCore(projectName, workspaceId, {
        nonInteractive: true, // Remote context - scripts can't prompt for input
      });

      if (!result.success) {
        const errorCode = result.error?.includes("not found") ? "NOT_FOUND" : "DELETE_FAILED";
        await this.sendError(session, sendResponse, errorCode, result.error || "Failed to delete workspace");
        return;
      }

      await this.sendMessage(session, sendResponse, {
        type: "workspace_deleted",
        workspaceId,
      });
    } catch (e) {
      console.error("[remote-session] Failed to delete workspace:", e);
      await this.sendError(session, sendResponse, "DELETE_FAILED", "Failed to delete workspace");
    }
  }

  /**
   * Handle get_inbox request
   * Returns unread count bounded by active sessions (one per session max).
   */
  private async handleGetInbox(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const [items, activeSessions] = await Promise.all([
        getInbox(),
        listSessions(),
      ]);

      // Build a set of active session IDs
      const activeSessionIds = new Set(activeSessions.map(s => s.id));

      // Filter inbox items to active sessions only
      const filteredItems = items.filter(item => activeSessionIds.has(item.sessionId));

      // Count unique sessions with unread items
      const activeSessionsWithUnread = new Set<string>();
      for (const item of filteredItems) {
        if (!item.read && activeSessionIds.has(item.sessionId)) {
          activeSessionsWithUnread.add(item.sessionId);
        }
      }

      await this.sendMessage(session, sendResponse, {
        type: "inbox_list",
        items: filteredItems,
        unreadCount: activeSessionsWithUnread.size,
      });
    } catch (e) {
      console.error("[remote-session] Failed to get inbox:", e);
      await this.sendError(session, sendResponse, "INBOX_FAILED", "Failed to get inbox");
    }
  }

  /**
   * Handle get_events request
   */
  private async handleGetEvents(
    session: RemoteClientSession,
    workspacePath: string,
    processName: string | undefined,
    processInstance: number | undefined,
    filter: import("../../types/events.js").WideEventFilter | undefined,
    limit: number | undefined,
    sinceMs: number | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspaceRef = resolveWorkspaceRef(workspacePath);
      if (!workspaceRef || !existsSync(workspaceRef.workspacePath)) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Workspace not found");
        return;
      }

      const projectConfig = readProjectConfig(workspaceRef.projectName);
      const snapshots = readWorkspaceSnapshots(workspaceRef.workspacePath, {
        maxBytes: projectConfig.events?.snapshotCacheMaxBytes,
        maxTimeline: projectConfig.events?.maxTimeline,
      });

      const resolvedFilter = { ...filter };
      if (processName && !resolvedFilter.processName) {
        resolvedFilter.processName = processName;
      }

      const filtered = snapshots
        .filter((snapshot) => {
          if (!resolvedFilter) return true;
          if (resolvedFilter.processName && snapshot.processName !== resolvedFilter.processName) return false;
          if (resolvedFilter.level && snapshot.level !== resolvedFilter.level) return false;
          if (resolvedFilter.message && !snapshot.message.includes(resolvedFilter.message)) return false;
          if (resolvedFilter.eventName && snapshot.eventName !== resolvedFilter.eventName) return false;
          if (resolvedFilter.correlationId && snapshot.correlationId !== resolvedFilter.correlationId) return false;
          return true;
        })
        .slice(0, limit ?? 200);

      const events = filtered.map((snapshot) => ({
        eventId: snapshot.lastEventId,
        eventName: snapshot.eventName,
        level: snapshot.level,
        timestamp: new Date(snapshot.updatedAt).toISOString(),
        timestampMs: snapshot.updatedAt,
        message: snapshot.message,
        sessionId: '',
        workspaceId: workspaceRef.workspaceId,
        projectName: workspaceRef.projectName,
        processName: snapshot.processName,
        processInstance: snapshot.processInstance,
        raw: snapshot.raw ?? {},
        kind: 'wide' as const,
        correlationId: snapshot.correlationId,
        timeline: Object.values(snapshot.timelineMap),
        timelineMap: snapshot.timelineMap,
        timelineOrder: snapshot.timelineOrder,
      }));

      const maxPayloadBytes = 900_000;
      const buildPayload = (chunk: import("../../types/events.js").WideEvent[]) => ({
        type: "events_list" as const,
        workspaceId: workspaceRef.workspaceId,
        events: chunk,
        liveEventIds: [],
      });

      if (events.length === 0) {
        await this.sendMessage(session, sendResponse, buildPayload([]));
        return;
      }

      let chunk: import("../../types/events.js").WideEvent[] = [];
      for (const event of events) {
        chunk.push(event);
        const payloadSize = Buffer.byteLength(JSON.stringify(buildPayload(chunk)));
        if (payloadSize > maxPayloadBytes) {
          if (chunk.length === 1) {
            await this.sendMessage(session, sendResponse, buildPayload(chunk));
            chunk = [];
            continue;
          }
          const last = chunk.pop();
          await this.sendMessage(session, sendResponse, buildPayload(chunk));
          chunk = last ? [last] : [];
        }
      }

      if (chunk.length > 0) {
        await this.sendMessage(session, sendResponse, buildPayload(chunk));
      }
    } catch (e) {
      console.error("[remote-session] Failed to get events:", e);
      await this.sendError(session, sendResponse, "EVENTS_FAILED", "Failed to get events");
    }
  }

  private async handleStartProcess(
    session: RemoteClientSession,
    workspaceId: string,
    processName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspaces = await scanWorkspaces();
      const workspace = workspaces.find(w => w.id === workspaceId);
      if (!workspace) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Workspace not found");
        return;
      }

      const specs = getProcessSpecs(workspace.path).filter(spec => spec.name === processName);
      if (specs.length === 0) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Process not found");
        return;
      }

      const sessions = [] as string[];
      for (const spec of specs) {
        const result = await startProcessInstance(workspace.path, spec);
        sessions.push(result.sessionId);
      }
      if (this.onProcessesChanged) {
        Promise.resolve(this.onProcessesChanged(workspace.path)).catch(() => undefined);
      }
      if (!this.processSchedulers.has(workspace.path)) {
        this.processSchedulers.set(workspace.path, startProcessScheduler(workspace.path));
      }

      await this.sendMessage(session, sendResponse, {
        type: "process_started",
        workspaceId,
        processName,
        sessionId: sessions[0],
      });
    } catch (e) {
      console.error("[remote-session] Failed to start process:", e);
      await this.sendError(session, sendResponse, "PROCESS_FAILED", "Failed to start process");
    }
  }

  private async handleStopProcess(
    session: RemoteClientSession,
    workspaceId: string,
    processName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspaces = await scanWorkspaces();
      const workspace = workspaces.find(w => w.id === workspaceId);
      if (!workspace) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Workspace not found");
        return;
      }

      const specs = getProcessSpecs(workspace.path).filter(spec => spec.name === processName);
      if (specs.length === 0) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Process not found");
        return;
      }

      for (const spec of specs) {
        await stopProcessInstance(workspace.path, spec);
      }

      if (this.onProcessesChanged) {
        Promise.resolve(this.onProcessesChanged(workspace.path)).catch(() => undefined);
      }

      await this.sendMessage(session, sendResponse, {
        type: "process_stopped",
        workspaceId,
        processName,
      });
    } catch (e) {
      console.error("[remote-session] Failed to stop process:", e);
      await this.sendError(session, sendResponse, "PROCESS_FAILED", "Failed to stop process");
    }
  }

  /**
   * Handle clear_inbox request
   */
  private async handleClearInbox(
    session: RemoteClientSession,
    id: string | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      await clearInbox(id);
      await this.sendMessage(session, sendResponse, {
        type: "inbox_cleared",
        id,
      });
    } catch (e) {
      console.error("[remote-session] Failed to clear inbox:", e);
      await this.sendError(session, sendResponse, "INBOX_FAILED", "Failed to clear inbox");
    }
  }

  /**
   * Handle mark_inbox_read request
   */
  private async handleMarkInboxRead(
    session: RemoteClientSession,
    id: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      await markInboxRead(id);
      await this.sendMessage(session, sendResponse, {
        type: "inbox_marked_read",
        id,
      });
    } catch (e) {
      console.error("[remote-session] Failed to mark inbox read:", e);
      await this.sendError(session, sendResponse, "INBOX_FAILED", "Failed to mark inbox item as read");
    }
  }

  /**
   * Send an encrypted message to client
   */
  private async sendMessage(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    msg: MachineToClientMessage
  ): Promise<void> {
    const json = serializeRemoteMessage(msg);
    const data = new TextEncoder().encode(json);
    const frame = await createFrame(0, data, session.sessionKeys.sendKey);
    sendResponse(frame);
  }

  /**
   * Send an error message to client
   */
  private async sendError(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void,
    code: string,
    message: string
  ): Promise<void> {
    await this.sendMessage(session, sendResponse, {
      type: "error",
      code,
      message,
    });
  }

  /**
   * Cleanup
   */
  async cleanup(): Promise<void> {
    // No persistent connection to clean up with the new API
    for (const timer of this.processSchedulers.values()) {
      clearInterval(timer);
    }
    this.processSchedulers.clear();
    this.tmuxLiteAvailable = false;
  }
}
