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
import type { MachineSnapshot } from "../tmux-lite/machine/protocol.js";
import { applyMachineEventToSnapshot } from '../tmux-lite/machine/snapshot-patch.js';
import type { SessionKeys, AccessType } from "../../types/identity.js";

// Import tmux-lite API for session management
import {
  listSessions,
  getMachineSnapshot,
  send as sendTmuxCommand,
  prepareAttachSession,
  cancelPrepareAttachSession,
  deleteTmuxWorkspace,
  createSession,
  isServerRunning,
  ensureServer,
  watchMachineEvents,
  type Session,
} from "../tmux-lite/cli";
import {
  listReplaysOffline,
  getReplayFrameOffline,
  getReplayTimelineOffline,
  dismissReplayOffline,
  undismissReplayOffline,
} from '../tmux-lite/replay/service.js';
import type { ReplayFrame } from '../tmux-lite/replay/types.js';
import { readReplayManifest } from '../tmux-lite/replay/store.js';

// Import project loading
import { listProjectSummaries } from "../../core/project-catalog";

// Import workspace operations
import { deleteWorkspaceCore } from "../../core/workspace";
import { prepareWorkspaceForSession } from "../../core/workspace-lifecycle";

// Process imports
import { getProcessSpecs } from "../processes/manager.js";

import { logger } from "../../utils/logger.js";
import type { Command as TmuxCommand, Response as TmuxResponse } from '../tmux-lite/protocol.js';

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
  /** For view: the specific session ID access was granted to */
  grantedSessionId?: string;
  /** Attached tmux-lite session ID (set after attach_session target resolution) */
  attachedSessionId?: string;
  /** Human-readable session name for attach lifecycle events */
  attachedSessionName?: string;
  /** Path to tmux-lite session socket (set after attach_session) */
  sessionSocketPath?: string;
  /** Initial terminal size requested by the client before attach-init is sent */
  initialCols?: number;
  initialRows?: number;
  streamId?: number;
  /** When true, PTY writes from this client are blocked server-side */
  viewOnly?: boolean;
}

type ReplaySessionAccessTarget = {
  sessionId: string;
};

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
  if (accessType === 'view') {
    return grantedSessionId === targetSessionId;
  }
  return false;
}

export function canAccessReplayForSession(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  replay: ReplaySessionAccessTarget,
): boolean {
  return canAttachSession(accessType, grantedSessionId, replay.sessionId);
}

export function filterReplaysForSessionAccess<T extends ReplaySessionAccessTarget>(
  accessType: AccessType | undefined,
  grantedSessionId: string | undefined,
  replays: T[],
): T[] {
  if (accessType === 'full') {
    return replays;
  }
  if (accessType !== 'view') {
    return [];
  }
  if (!grantedSessionId) {
    return [];
  }
  return replays.filter((replay) => replay.sessionId === grantedSessionId);
}

function isAgentReplay(replay: { sessionName: string }): boolean {
  return replay.sessionName.startsWith('agent:');
}

function normalizeWorkspaceIdToken(workspaceId: string): string {
  return workspaceId.includes(':') ? workspaceId.split(':').pop() ?? workspaceId : workspaceId;
}

function matchesWorkspaceIdToken(parsedWorkspaceId: string, workspaceId: string): boolean {
  return normalizeWorkspaceIdToken(parsedWorkspaceId) === normalizeWorkspaceIdToken(workspaceId);
}

/**
 * Remote session handler
 */
export class RemoteSessionHandler {
  private tmuxLiteAvailable = false;
  private processSchedulers = new Map<string, NodeJS.Timer>();
  private pendingAttachRuns = new Map<string, string>();

  // Machine snapshot push state
  private latestMachineSnapshot: MachineSnapshot | null = null;
  private machineWatchUnsubscribe: (() => void) | null = null;
  /** connectionId → async send function for unsolicited machine snapshot pushes */
  private machineSnapshotWatchers = new Map<string, (msg: MachineToClientMessage) => Promise<void>>();
  /** Periodic timer that re-broadcasts the latest snapshot for client reconciliation */
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;


  /**
   * Initialize - check if tmux-lite is available and start machine event watch
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

    if (this.tmuxLiteAvailable) {
      await this.startMachineWatch();
      // Re-broadcast the current snapshot every 30 s so clients that missed
      // an update can reconcile without needing an explicit poll.
      this.reconciliationTimer = setInterval(() => {
        if (this.latestMachineSnapshot) {
          void this.broadcastMachineSnapshot({ type: 'machine_snapshot', snapshot: this.latestMachineSnapshot });
        }
      }, 30000);
    }  // end if (this.tmuxLiteAvailable)
  }

  /**
   * Start watching machine events from tmux-lite.
   * Keeps the latest snapshot and broadcasts to all watching remote clients.
   */
  private async startMachineWatch(): Promise<void> {
    try {
      const unsubscribe = await watchMachineEvents({
        onSnapshot: (snapshot) => {
          this.latestMachineSnapshot = snapshot;
          void this.broadcastMachineSnapshot({ type: 'machine_snapshot', snapshot });
        },
        onEvent: (event) => {
          if (event.type === 'snapshot-replaced') {
            this.latestMachineSnapshot = event.snapshot;
          } else if (this.latestMachineSnapshot) {
            this.latestMachineSnapshot = applyMachineEventToSnapshot(this.latestMachineSnapshot, event);
          }
          if (this.latestMachineSnapshot) {
            void this.broadcastMachineSnapshot({
              type: 'machine_snapshot',
              snapshot: this.latestMachineSnapshot,
            });
          }
        },
        onError: (error) => {
          console.warn('[remote-session] Machine watch error:', error.message);
          this.machineWatchUnsubscribe = null;
          if (this.machineSnapshotWatchers.size > 0) {
            setTimeout(() => {
              if (!this.machineWatchUnsubscribe && this.machineSnapshotWatchers.size > 0) {
                void this.startMachineWatch();
              }
            }, 250);
          }
        },
      });
      this.machineWatchUnsubscribe = unsubscribe;
    } catch (e) {
      console.warn('[remote-session] Could not start machine watch:', e);
    }
  }

  /**
   * Register a browsing client to receive unsolicited machine snapshot pushes.
   * Immediately sends the current snapshot if available.
   */
  async onClientEntersBrowsing(
    connectionId: string,
    sendMessage: (msg: MachineToClientMessage) => Promise<void>,
  ): Promise<void> {
    this.machineSnapshotWatchers.set(connectionId, sendMessage);
    // Push current snapshot immediately so the client doesn't need to poll
    if (this.latestMachineSnapshot) {
      try {
        await sendMessage({ type: 'machine_snapshot', snapshot: this.latestMachineSnapshot });
      } catch {
        // Non-fatal — client may disconnect
      }
    }
  }

  /**
   * Unregister a client from machine snapshot pushes.
   */
  onClientLeavesBrowsing(connectionId: string): void {
    this.machineSnapshotWatchers.delete(connectionId);
  }

  private async broadcastMachineSnapshot(msg: { type: 'machine_snapshot'; snapshot: MachineSnapshot }): Promise<void> {
    const promises: Promise<void>[] = [];
    for (const sendFn of this.machineSnapshotWatchers.values()) {
      promises.push(sendFn(msg).catch(() => undefined));
    }
    await Promise.allSettled(promises);
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
      case 'list_replays':
        await this.handleListReplays(session, msg.workspaceId, msg.includeDismissed, sendResponse);
        break;

      case 'get_replay_frame':
        await this.handleGetReplayFrame(session, msg.replayId, msg.requestId, msg.atMs, msg.atSeq, sendResponse);
        break;

      case 'get_replay_timeline':
        await this.handleGetReplayTimeline(session, msg.replayId, sendResponse);
        break;

      case 'dismiss_replay':
        await this.handleDismissReplay(session, msg.replayId, sendResponse);
        break;

      case 'undismiss_replay':
        await this.handleUndismissReplay(session, msg.replayId, sendResponse);
        break;

      case "attach_session":
        // Permission check for attach_session is done in handleAttachSession
        // because it depends on whether creating new session or attaching existing
        await this.handleAttachSession(session, msg, sendResponse);
        break;

      case 'cancel_pending_attach':
        await this.handleCancelPendingAttach(session, sendResponse);
        break;

      // Note: resize, detach, and pty_input are handled in attached mode
      // via client-session-manager using tmux-lite's SessionCtrl protocol,
      // not through this JSON-RPC handler.

      case "delete_workspace":
        // Security: Requires management permission
        if (!canManage(session.accessType)) {
          const normalizedWorkspaceId = msg.workspaceId.startsWith(`${msg.projectName}:`)
            ? msg.workspaceId.slice(msg.projectName.length + 1)
            : msg.workspaceId;
          await this.sendError(
            session,
            sendResponse,
            "PERMISSION_DENIED",
            "Requires full access to delete workspaces",
            { workspaceId: `${msg.projectName}:${normalizedWorkspaceId}`, requestId: msg.requestId }
          );
          return;
        }
        await this.handleDeleteWorkspace(
          session,
          msg.requestId,
          msg.projectName,
          msg.workspaceId,
          msg.scriptPolicy,
          sendResponse
        );
        break;

      case 'list_github_repos':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'github-repos',
          org: msg.org,
        }, sendResponse);
        break;

      case 'list_remote_branches':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'remote-branches',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'list_linear_issues':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'linear-issues',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'create_project':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'project-create',
          repository: msg.repository,
          projectName: msg.projectName,
          baseBranch: msg.baseBranch,
          setCurrent: msg.setCurrent,
        }, sendResponse);
        break;

      case 'prepare_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'project-prepare',
          repository: msg.repository,
          projectName: msg.projectName,
          baseBranch: msg.baseBranch,
          setCurrent: msg.setCurrent,
        }, sendResponse);
        break;

      case 'finalize_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'project-finalize',
          projectName: msg.projectName,
          repository: msg.repository,
          baseBranch: msg.baseBranch,
          bundle: msg.bundle,
          inputValues: msg.inputValues,
          secretValues: msg.secretValues,
          confirmResults: msg.confirmResults,
          setCurrent: msg.setCurrent,
        }, sendResponse);
        break;

      case 'cancel_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'project-cancel',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'delete_project':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'project-delete',
          projectName: msg.projectName,
        }, sendResponse);
        break;

      case 'create_workspace':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'workspace-create',
          projectName: msg.projectName,
          workspaceName: msg.workspaceName,
          branchName: msg.branchName,
          baseBranch: msg.baseBranch,
          workspaceSource: msg.workspaceSource,
          linearIssue: msg.linearIssue,
        }, sendResponse);
        break;

      case 'set_workspace_phase':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'workspace-set-phase',
          projectName: msg.projectName,
          workspaceName: msg.workspaceName,
          phase: msg.phase,
        }, sendResponse);
        break;

      case 'kill_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'kill',
          id: msg.sessionId,
        }, sendResponse);
        break;

      case 'start_process':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'service-start',
          workspaceId: msg.workspaceId,
          processName: msg.processName,
          instance: msg.instance,
        }, sendResponse);
        break;

      case 'stop_process':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'service-stop',
          workspaceId: msg.workspaceId,
          processName: msg.processName,
        }, sendResponse);
        break;

      case 'request_events':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'events-request',
          workspacePath: msg.workspacePath,
          filter: msg.filter,
          limit: msg.limit,
          sinceMs: msg.sinceMs,
        }, sendResponse);
        break;

      case 'get_bundle_refresh_plan':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-refresh-plan',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
        }, sendResponse);
        break;

      case 'apply_bundle_refresh':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-refresh-apply',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          submission: msg.submission,
        }, sendResponse);
        break;

      case 'get_bundle_config_state':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-config-state',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
        }, sendResponse);
        break;

      case 'apply_bundle_config':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'bundle-config-apply',
          projectName: msg.projectName,
          workspaceId: msg.workspaceId,
          submission: msg.submission,
        }, sendResponse);
        break;

      case 'request_review':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'review-request',
          requestId: msg.requestId,
          operation: msg.operation,
        }, sendResponse);
        break;

      case 'get_inbox':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'inbox',
        }, sendResponse);
        break;

      case 'clear_inbox':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'inbox-clear',
          id: msg.id,
        }, sendResponse);
        break;

      case 'mark_inbox_read':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'inbox-read',
          id: msg.id,
        }, sendResponse);
        break;

      case 'get_notification_config':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'notification-config-get',
        }, sendResponse);
        break;

      case 'update_notification_config':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'notification-config-update',
          config: msg.config,
        }, sendResponse);
        break;

      case 'list_agent_sessions':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-sessions',
          target: msg.target,
          mode: msg.mode,
        }, sendResponse);
        break;

      case 'create_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-create',
          target: msg.target,
          title: msg.title,
        }, sendResponse);
        break;

      case 'abort_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-abort',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'interrupt_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to interrupt agent sessions', { requestId: msg.requestId });
          return;
        }
        // Note: Pi SDK session.abort() means "interrupt current turn", not kill the session
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-interrupt',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'close_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-close',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'archive_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-archive',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'restore_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-restore',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
        }, sendResponse);
        break;

      case 'attach_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-attach',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          cols: msg.cols,
          rows: msg.rows,
        }, sendResponse);
        break;

      case 'prompt_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-prompt',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          text: msg.text,
          images: msg.images,
          streamingBehavior: msg.streamingBehavior,
        }, sendResponse);
        break;

      case 'stage_agent_upload':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-stage-upload',
          target: msg.target,
          fileName: msg.fileName,
          data: msg.data,
          mimeType: msg.mimeType,
        }, sendResponse);
        break;

      case 'respond_agent_dialog':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-dialog-response',
          dialogId: msg.dialogId,
          dialogType: msg.dialogType,
          value: msg.value,
        }, sendResponse);
        break;

      case 'respond_agent_permission':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-permission',
          target: msg.target,
          agentSessionId: msg.agentSessionId,
          permissionId: msg.permissionId,
          response: msg.response,
        }, sendResponse);
        break;

      case 'list_agent_commands':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-list-commands',
          target: msg.target,
        }, sendResponse);
        break;

      case 'get_agent_file_suggestions':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access', { requestId: msg.requestId });
          return;
        }
        await this.handleTypedCommand(session, msg.requestId, {
          type: 'agent-file-suggestions',
          target: msg.target,
          prefix: msg.prefix,
          limit: msg.limit,
        }, sendResponse);
        break;

      default: {
        // Exhaustiveness check - log unknown message types
        const unknownMsg = msg as { type: string };
        console.warn("[remote-session] Unknown message type:", unknownMsg.type);
      }
    }
  }

  private async handleTypedCommand(
    session: RemoteClientSession,
    requestId: string,
    tmuxCommand: TmuxCommand,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    try {
      await ensureServer();
      const response = await sendTmuxCommand(tmuxCommand);
      await this.sendMessage(session, sendResponse, {
        type: 'command_response',
        requestId,
        response,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendMessage(session, sendResponse, {
        type: 'command_response',
        requestId,
        response: { type: 'error', message },
      });
    }
  }

  private async handleListReplays(
    session: RemoteClientSession,
    workspaceId: string | undefined,
    includeDismissed: boolean | undefined,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const replays = filterReplaysForSessionAccess(
      session.accessType,
      session.grantedSessionId,
      listReplaysOffline({ workspaceId, includeDismissed: includeDismissed ?? false }),
    ).filter((replay) => !isAgentReplay(replay));
    await this.sendMessage(session, sendResponse, {
      type: 'replay_list',
      replays,
    });
  }

  private async handleGetReplayFrame(
    session: RemoteClientSession,
    replayId: string,
    requestId: string,
    atMs: number | undefined,
    atSeq: number | undefined,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`, { requestId });
      return;
    }

    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay', { requestId });
      return;
    }

    const frame = getReplayFrameOffline(replayId, { atMs, atSeq });

    const maxPayloadBytes = 900_000;
    const buildPayload = (
      events: ReplayFrame['events'],
      chunkIndex: number,
      totalChunks: number,
      checkpoint: ReplayFrame['checkpoint'] | null,
    ) => ({
      type: 'replay_frame' as const,
      replayId,
      requestId,
      frame: {
        replayId,
        checkpoint,
        events,
      },
      chunkIndex,
      totalChunks,
    });

    const chunks: ReplayFrame['events'][] = [];
    const eventJsonSizes = frame.events.map((event) => Buffer.byteLength(JSON.stringify(event)));
    const basePayloadSize = (checkpoint: ReplayFrame['checkpoint'] | null) => Buffer.byteLength(JSON.stringify(buildPayload([], 0, 1, checkpoint)));
    let chunk: ReplayFrame['events'] = [];
    let chunkSizeBytes = basePayloadSize(frame.checkpoint);
    for (const [index, event] of frame.events.entries()) {
      const eventSizeBytes = eventJsonSizes[index] ?? 0;
      let hasEventsBeforePush = chunk.length > 0;
      let candidateSize = chunkSizeBytes + eventSizeBytes + (hasEventsBeforePush ? 1 : 0);
      if (candidateSize > maxPayloadBytes && chunk.length > 0) {
        chunks.push(chunk);
        chunk = [];
        chunkSizeBytes = basePayloadSize(null);
        hasEventsBeforePush = false;
        candidateSize = chunkSizeBytes + eventSizeBytes;
      }

      chunk.push(event);
      chunkSizeBytes += eventSizeBytes + (hasEventsBeforePush ? 1 : 0);
    }

    if (chunk.length > 0 || chunks.length === 0) {
      chunks.push(chunk);
    }

    const totalChunks = chunks.length;
    for (let i = 0; i < totalChunks; i += 1) {
      await this.sendMessage(session, sendResponse, buildPayload(chunks[i] ?? [], i, totalChunks, i === 0 ? frame.checkpoint : null));
    }
  }

  private async handleGetReplayTimeline(
    session: RemoteClientSession,
    replayId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`);
      return;
    }

    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay');
      return;
    }

    const timeline = getReplayTimelineOffline(replayId);
    await this.sendMessage(session, sendResponse, {
      type: 'replay_timeline',
      replayId,
      timeline,
    });
  }

  private async handleDismissReplay(
    session: RemoteClientSession,
    replayId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    if (!canManage(session.accessType)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to dismiss replays');
      return;
    }
    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`);
      return;
    }
    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay');
      return;
    }
    if (manifest.status === 'running') {
      await this.sendError(session, sendResponse, 'USER_ERROR', 'Running replays cannot be dismissed');
      return;
    }

    dismissReplayOffline(replayId);
    await this.sendMessage(session, sendResponse, { type: 'replay_dismissed', replayId });
  }

  private async handleUndismissReplay(
    session: RemoteClientSession,
    replayId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    if (!canManage(session.accessType)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to restore replays');
      return;
    }

    const manifest = readReplayManifest(replayId);
    if (!manifest) {
      await this.sendError(session, sendResponse, 'NOT_FOUND', `Replay not found: ${replayId}`);
      return;
    }
    if (!canAccessReplayForSession(session.accessType, session.grantedSessionId, manifest)) {
      await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Not authorized to access this replay');
      return;
    }

    undismissReplayOffline(replayId);
    await this.sendMessage(session, sendResponse, { type: 'replay_undismissed', replayId });
  }

  private async handleCancelPendingAttach(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    if (!canManage(session.accessType)) {
      await this.sendError(
        session,
        sendResponse,
        'PERMISSION_DENIED',
        'Requires full access to cancel pending attach runs'
      );
      return;
    }

    const pending = this.pendingAttachRuns.get(session.connectionId);
    if (!pending) {
      return;
    }

    await cancelPrepareAttachSession(pending).catch(() => undefined);
    this.pendingAttachRuns.delete(session.connectionId);
  }

  /**
   * Handle attach_session request
   */
  private async handleAttachSession(
    session: RemoteClientSession,
    msg: {
      streamId: number;
      sessionId?: string;
      workspaceId?: string;
      sessionName?: string;
      cols: number;
      rows: number;
      scriptPolicy?: 'auto' | 'skip';
      viewOnly?: boolean;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
    },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    console.log("[remote-session] handleAttachSession:", JSON.stringify(msg));

    if (!this.tmuxLiteAvailable) {
      await this.sendError(session, sendResponse, "UNAVAILABLE", "Session manager not available");
      return;
    }

    try {
      const existingAttachRun = this.pendingAttachRuns.get(session.connectionId);
      if (existingAttachRun) {
        await cancelPrepareAttachSession(existingAttachRun).catch(() => undefined);
        this.pendingAttachRuns.delete(session.connectionId);
      }

      let targetSession: Session | null = null;

      // If no session ID, create new session in workspace
      if (!msg.sessionId && msg.workspaceId) {
        // Security: Creating new sessions requires full/manage access
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to create sessions");
          return;
        }
        let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
        try {
          console.log('[remote-session] prepareAttachSession starting', { workspaceId: msg.workspaceId, sessionName: msg.sessionName, scriptPolicy: msg.scriptPolicy });
          const prepared = await prepareAttachSession({
            workspaceId: msg.workspaceId,
            sessionName: msg.sessionName,
            command: msg.command,
            args: msg.args,
            env: msg.env,
            scriptPolicy: msg.scriptPolicy,
            viewOnly: msg.viewOnly,
            onRequestId: (requestId) => {
              this.pendingAttachRuns.set(session.connectionId, requestId);
            },
            onScriptOutput: (event) => {
              currentPhase = event.phase;
              void this.sendMessage(session, sendResponse, {
                type: 'script_output',
                phase: event.phase,
                data: event.data,
                done: event.done,
                error: event.error,
              }).catch((error) => {
                logger.debug(`[remote-session] Failed to stream script output: ${error instanceof Error ? error.message : String(error)}`);
              });
            },
          });
          this.pendingAttachRuns.delete(session.connectionId);
          console.log('[remote-session] prepareAttachSession completed', { sessionId: prepared.session.id, sessionName: prepared.session.name, workspaceId: prepared.workspaceId, scriptPolicy: msg.scriptPolicy });
          targetSession = prepared.session;
        } catch (error) {
          console.error('[remote-session] prepareAttachSession failed', { workspaceId: msg.workspaceId, sessionName: msg.sessionName, scriptPolicy: msg.scriptPolicy, error: error instanceof Error ? error.message : String(error) });
          this.pendingAttachRuns.delete(session.connectionId);
          const typedError = error instanceof Error ? error as Error & { code?: string } : undefined;
          if (!msg.command) {
            await this.sendMessage(session, sendResponse, {
              type: 'script_output',
              phase: currentPhase,
              data: '',
              done: true,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          await this.sendError(
            session,
            sendResponse,
            typedError?.code ?? 'ATTACH_FAILED',
            error instanceof Error ? error.message : String(error),
          );
          return;
        }
      } else if (msg.sessionId) {
        // Security: Check if client can attach to this session
        if (!canAttachSession(session.accessType, session.grantedSessionId, msg.sessionId)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Not authorized to attach to this session");
          return;
        }

        // Resolve target session. Prefer the cached machine snapshot to avoid
        // a Unix-socket round-trip to tmux-lite on every attach. Fall back to
        // a live listSessions() only if the session isn't in the snapshot yet
        // (e.g. it was just created and the snapshot hasn't propagated).
        const cachedRecord = this.latestMachineSnapshot?.terminalSessionsById[msg.sessionId];
        if (cachedRecord) {
          targetSession = {
            id: cachedRecord.id,
            name: cachedRecord.name,
            socketPath: cachedRecord.socketPath,
            pid: 0,
            attached: cachedRecord.attached,
            cwd: cachedRecord.cwd,
            createdAt: cachedRecord.createdAt,
            exitCode: cachedRecord.exitCode,
            kind: cachedRecord.kind === 'agent' ? 'agent' : 'shell',
            hidden: cachedRecord.hidden,
          };
        } else {
          const sessions = await listSessions();
          targetSession = sessions.find(s => s.id === msg.sessionId) ?? null;
        }
      }

      if (!targetSession) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Session not found");
        return;
      }

      session.state = "attached";
      session.attachedSessionId = targetSession.id;
      session.streamId = msg.streamId;
      session.attachedSessionName = targetSession.name;
      session.sessionSocketPath = targetSession.socketPath;
      session.initialCols = msg.cols;
      session.initialRows = msg.rows;
      session.viewOnly = msg.viewOnly ?? false;

      // ClientSessionManager now owns the real PTY attach handshake.
      // This step only resolves which tmux session to connect to.
    } catch (e) {
      console.error("[remote-session] Failed to attach session:", e);
      const typedError = e instanceof Error ? e as Error & { code?: string } : undefined;
      const detail = typedError?.message ?? String(e);
      await this.sendError(
        session,
        sendResponse,
        typedError?.code ?? "ATTACH_FAILED",
        `Failed to attach to session: ${detail}`
      );
    }
  }

  /**
   * Handle delete_workspace request
   */
  private async handleDeleteWorkspace(
    session: RemoteClientSession,
    requestId: string | undefined,
    projectName: string,
    workspaceId: string,
    scriptPolicy: 'auto' | 'skip' | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.startsWith(`${projectName}:`)
      ? workspaceId.slice(projectName.length + 1)
      : workspaceId;
    const canonicalWorkspaceId = `${projectName}:${normalizedWorkspaceId}`;
    try {
      await deleteTmuxWorkspace({
        projectName,
        workspaceId: normalizedWorkspaceId,
        scriptPolicy,
        onScriptOutput: (event) => {
          void this.sendMessage(session, sendResponse, {
            type: 'script_output',
            phase: 'remove',
            data: event.data,
            done: event.done,
            error: event.error,
            workspaceId: canonicalWorkspaceId,
          }).catch((error) => {
            logger.debug(`[remote-session] Failed to stream remove script output: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
      });

      await this.sendMessage(session, sendResponse, {
        type: "workspace_deleted",
        requestId,
        workspaceId: canonicalWorkspaceId,
      });
    } catch (e) {
      console.error("[remote-session] Failed to delete workspace:", e);
      const typedError = e instanceof Error ? e as Error & { code?: string } : undefined;
      const message = typedError?.message ?? String(e);
      await this.sendError(session, sendResponse, typedError?.code ?? "DELETE_FAILED", message, {
        workspaceId: canonicalWorkspaceId,
        requestId,
      });
    }
  }

  // ============================================================================
  // Review Request Handling
  // ============================================================================

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
    message: string,
    options?: { workspaceId?: string; projectName?: string; requestId?: string }
  ): Promise<void> {
    await this.sendMessage(session, sendResponse, {
      type: "error",
      code,
      message,
      workspaceId: options?.workspaceId,
      projectName: options?.projectName,
      requestId: options?.requestId,
    });
  }

  /**
   * Cleanup
   */
  cleanupConnection(connectionId: string): void {
    const pending = this.pendingAttachRuns.get(connectionId);
    if (pending) {
      void cancelPrepareAttachSession(pending).catch(() => undefined);
      this.pendingAttachRuns.delete(connectionId);
    }
    this.onClientLeavesBrowsing(connectionId);
  }

  async cleanup(): Promise<void> {
    // Stop machine event watch
    this.machineWatchUnsubscribe?.();
    this.machineWatchUnsubscribe = null;
    this.machineSnapshotWatchers.clear();
    // Stop periodic reconciliation timer
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

    // Clean up process schedulers
    for (const timer of this.processSchedulers.values()) {
      clearInterval(timer);
    }
    this.processSchedulers.clear();
    this.tmuxLiteAvailable = false;
  }
}
