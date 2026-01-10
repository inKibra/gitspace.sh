/**
 * Remote session handler - processes browse and PTY commands
 *
 * Handles the encrypted messages between client and machine after X3DH handshake.
 */

import { createFrame, openFrame } from "../tmux-lite/crypto/frames";
import { scanWorkspaces } from "./workspace-scanner";
import {
  parseRemoteMessage,
  serializeRemoteMessage,
  type ClientToMachineMessage,
  type MachineToClientMessage,
  type SessionInfo,
} from "./protocol";
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
} from "../tmux-lite/cli";

// Import project loading
import { loadProjects } from "../../tui/state";

// Import workspace operations
import { deleteWorkspaceCore } from "../../core/workspace";
import { readProjectConfig } from "../../core/config";

// Import script execution
import { runWorkspaceScripts } from "../../utils/run-workspace-scripts";

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
          workspace.sessionCount = sessions.filter(s => s.cwd === workspace.path).length;
        }
      } catch {
        // Ignore errors - just use 0 session counts
      }
    }

    await this.sendMessage(session, sendResponse, {
      type: "workspace_list",
      workspaces,
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
            // Filter by workspace using cwd matching
            // Note: Session cwd is set once at creation time and does NOT change
            // as users navigate within the shell.
            const ws = workspacePathMap.get(s.cwd);
            return ws?.id === workspaceId;
          })
          .map(s => {
            // Find workspace info by cwd
            const ws = workspacePathMap.get(s.cwd);
            return {
              id: s.id,
              name: s.name,
              workspaceId: ws?.id ?? "unknown",
              attached: s.attached,
              createdAt: s.createdAt,
              processTitle: s.processTitle,
              exitCode: s.exitCode,
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
    msg: { sessionId?: string; workspaceId?: string; sessionName?: string; cols?: number; rows?: number },
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

        // Run setup or select scripts for the workspace
        const config = readProjectConfig(workspace.projectName);

        console.log(`[remote-session] Running workspace scripts for: ${workspace.id}`);
        const scriptResult = await runWorkspaceScripts({
          projectName: workspace.projectName,
          workspacePath: workspace.path,
          workspaceName: workspace.id,
          repository: config.repository,
          interactive: false, // Remote context - scripts can't prompt for input
        });

        if (!scriptResult.success) {
          console.error(`[remote-session] ${scriptResult.phase} scripts failed:`, scriptResult.error);
          await this.sendError(session, sendResponse, "SCRIPT_FAILED", `Workspace scripts failed during ${scriptResult.phase} phase: ${scriptResult.error}`);
          return;
        }

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

        targetSession = await createSession(sessionName, workspace.path);
        console.log(`[remote-session] Created session: ${targetSession.name} (id: ${targetSession.id})`)
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
   */
  private async handleGetInbox(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const items = await getInbox();
      const unreadCount = items.filter(i => !i.read).length;
      await this.sendMessage(session, sendResponse, {
        type: "inbox_list",
        items,
        unreadCount,
      });
    } catch (e) {
      console.error("[remote-session] Failed to get inbox:", e);
      await this.sendError(session, sendResponse, "INBOX_FAILED", "Failed to get inbox");
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
    this.tmuxLiteAvailable = false;
  }
}
