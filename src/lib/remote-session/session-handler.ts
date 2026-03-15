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
import {
  cancelPreparedProjectForSession,
  createProjectForSession,
  createWorkspaceForSession,
  deleteProjectForSession,
  finalizePreparedProjectForSession,
  listGithubReposForSession,
  listLinearIssuesForSession,
  listRemoteBranchesForSession,
  prepareProjectForSession,
} from '../../core/session-lifecycle.js';

// Import review operations
import { executeLocalReviewOperation } from "../../core/review-executor.js";
import type { ReviewOperation, ReviewResult } from "../../types/review.js";
import { getNotificationConfig, updateNotificationConfig } from "../../core/config";
import {
  getBundleRefreshPlan,
  applyBundleRefreshSubmission,
  getBundleConfigState,
  applyBundleConfigSubmission,
} from '../../core/bundle-refresh.js';
import { buildSessionName } from '../../session/session-name.js';
import { buildWorkspaceSessionHooks } from '../../session/workspace-shell-hooks.js';
import { matchesWorkspaceId, toCanonicalWorkspaceId } from '../../utils/workspace-id.js';

// Process & events imports
import { parseProcessSessionName } from "../processes/names.js";
import { readWorkspaceSnapshots } from "../events/reader.js";
import { resolveWorkspaceRef } from "../events/paths.js";
import { loadSavedEventFilters } from "../events/filters.js";
import { getProcessSpecs, startProcessInstance, stopProcessInstance } from "../processes/manager.js";
import { autostartProcesses } from "../processes/autostart.js";
import { startProcessScheduler } from "../processes/scheduler.js";
import {
  loadProcessesConfigWithDiagnostics,
  loadProcessesConfig,
  getProcessDefinition,
} from "../processes/config.js";
import { normalizeProcessInstanceCount } from "../processes/instances.js";
import { readProjectConfig } from "../../core/config.js";
import { existsSync } from "fs";

import { logger } from "../../utils/logger.js";
import {
  createOpenCodeBasicAuthHeader,
  defaultOpenCodeRuntimeManager,
  type OpenCodeRuntimeManager,
} from '../../agents/opencode-runtime.js';
import { buildOpenCodeUrl } from '../../agents/opencode-bridge.js';
import { consumeSseStream } from '../../agents/opencode-sse.js';
import { defaultOpenCodeCoordinator, type AgentWorkspaceTarget } from '../../agents/opencode-coordinator.js';

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
  /** Attached tmux-lite session ID (set after attach_session) */
  attachedSessionId?: string;
  /** Path to tmux-lite session socket (set after attach_session) */
  sessionSocketPath?: string;
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

const MUTATING_REVIEW_OPERATIONS = new Set<ReviewOperation['op']>([
  'create_thread',
  'add_reply',
  'update_thread',
  'update_comment',
  'delete_comment',
  'import_github',
  'push_github',
]);

function isMutatingReviewOperation(operation: ReviewOperation): boolean {
  return MUTATING_REVIEW_OPERATIONS.has(operation.op);
}

function normalizeWorkspaceIdToken(workspaceId: string): string {
  return workspaceId.includes(':') ? workspaceId.split(':').pop() ?? workspaceId : workspaceId;
}

function matchesWorkspaceIdToken(parsedWorkspaceId: string, workspaceId: string): boolean {
  return normalizeWorkspaceIdToken(parsedWorkspaceId) === normalizeWorkspaceIdToken(workspaceId);
}

export interface RemoteSessionHandlerOptions {
  processHostDomain?: string;
  onProcessesChanged?: (workspacePath: string) => void | Promise<void>;
  openCodeRuntimeManager?: OpenCodeRuntimeManager;
}

/**
 * Remote session handler
 */
export class RemoteSessionHandler {
  private tmuxLiteAvailable = false;
  private processSchedulers = new Map<string, NodeJS.Timer>();
  private pendingAttachRuns = new Map<string, AbortController>();
  private processHostDomain?: string;
  private onProcessesChanged?: (workspacePath: string) => void | Promise<void>;
  private openCodeRuntimeManager: OpenCodeRuntimeManager;
  private openCodeStreams = new Map<string, AbortController>();

  constructor(options: RemoteSessionHandlerOptions = {}) {
    this.processHostDomain = options.processHostDomain;
    this.onProcessesChanged = options.onProcessesChanged;
    this.openCodeRuntimeManager = options.openCodeRuntimeManager ?? defaultOpenCodeRuntimeManager;
  }

  /**
   * Initialize - check if tmux-lite is available
   */
  async initialize(): Promise<void> {
    try {
      await this.openCodeRuntimeManager.initialize();
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

      case "list_projects":
        await this.handleListProjects(session, sendResponse);
        break;

      case 'list_github_repos':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to list repositories'
          );
          return;
        }
        await this.handleListGithubRepos(session, msg.org, sendResponse);
        break;

      case 'list_remote_branches':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to list remote branches',
            { projectName: msg.projectName }
          );
          return;
        }
        await this.handleListRemoteBranches(session, msg.projectName, sendResponse);
        break;

      case 'list_linear_issues':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to list Linear issues',
            { projectName: msg.projectName }
          );
          return;
        }
        await this.handleListLinearIssues(session, msg.projectName, sendResponse);
        break;

      case 'create_project':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to create projects'
          );
          return;
        }
        await this.handleCreateProject(session, msg, sendResponse);
        break;

      case 'prepare_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to create projects'
          );
          return;
        }
        await this.handlePrepareProjectCreation(session, msg, sendResponse);
        break;

      case 'finalize_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to create projects',
            { projectName: msg.projectName }
          );
          return;
        }
        await this.handleFinalizeProjectCreation(session, msg, sendResponse);
        break;

      case 'cancel_project_creation':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to create projects',
            { projectName: msg.projectName }
          );
          return;
        }
        await this.handleCancelProjectCreation(session, msg.projectName, sendResponse);
        break;

      case 'create_workspace':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to create workspaces',
            { projectName: msg.projectName }
          );
          return;
        }
        await this.handleCreateWorkspace(session, msg, sendResponse);
        break;

      case 'delete_project':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to delete projects',
            { projectName: msg.projectName }
          );
          return;
        }
        await this.handleDeleteProject(session, msg.projectName, sendResponse);
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
          const normalizedWorkspaceId = msg.workspaceId.startsWith(`${msg.projectName}:`)
            ? msg.workspaceId.slice(msg.projectName.length + 1)
            : msg.workspaceId;
          await this.sendError(
            session,
            sendResponse,
            "PERMISSION_DENIED",
            "Requires full access to delete workspaces",
            { workspaceId: `${msg.projectName}:${normalizedWorkspaceId}` }
          );
          return;
        }
        await this.handleDeleteWorkspace(
          session,
          msg.projectName,
          msg.workspaceId,
          msg.scriptPolicy,
          sendResponse
        );
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

      case "get_notification_config":
        await this.handleGetNotificationConfig(session, sendResponse);
        break;

      case "update_notification_config":
        await this.handleUpdateNotificationConfig(session, msg.config, sendResponse);
        break;

      case 'get_bundle_refresh_plan':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to inspect bundle refresh requirements'
          );
          return;
        }
        await this.handleGetBundleRefreshPlan(
          session,
          msg.projectName,
          msg.workspaceId,
          sendResponse
        );
        break;

      case 'apply_bundle_refresh':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to apply bundle refresh'
          );
          return;
        }
        await this.handleApplyBundleRefresh(
          session,
          msg.projectName,
          msg.workspaceId,
          msg.submission,
          sendResponse
        );
        break;

      case 'get_bundle_config_state':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to inspect bundle configuration'
          );
          return;
        }
        await this.handleGetBundleConfigState(
          session,
          msg.projectName,
          msg.workspaceId,
          sendResponse
        );
        break;

      case 'apply_bundle_config_update':
        if (!canManage(session.accessType)) {
          await this.sendError(
            session,
            sendResponse,
            'PERMISSION_DENIED',
            'Requires full access to update bundle configuration'
          );
          return;
        }
        await this.handleApplyBundleConfigUpdate(
          session,
          msg.projectName,
          msg.workspaceId,
          msg.submission,
          sendResponse
        );
        break;

      case 'review_request':
        await this.handleReviewRequest(
          session,
          msg.requestId,
          msg.operation,
          sendResponse
        );
        break;

      case "get_events":
        await this.handleGetEvents(
          session,
          msg.workspacePath,
          msg.processName,
          undefined,
          msg.filter,
          msg.limit,
          msg.sinceMs,
          sendResponse
        );
        break;

      case "start_process":
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to start processes");
          return;
        }
        await this.handleStartProcess(session, msg.workspaceId, msg.processName, msg.instance, sendResponse);
        break;

      case "stop_process":
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to stop processes");
          return;
        }
        await this.handleStopProcess(session, msg.workspaceId, msg.processName, sendResponse);
        break;

      case 'opencode_request':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to proxy OpenCode requests');
          return;
        }
        await this.handleOpenCodeRequest(session, msg, sendResponse);
        break;

      case 'opencode_stream_open':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to proxy OpenCode streams');
          return;
        }
        await this.handleOpenCodeStreamOpen(session, msg, sendResponse);
        break;

      case 'opencode_stream_close':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to proxy OpenCode streams');
          return;
        }
        await this.handleOpenCodeStreamClose(session, msg.requestId, sendResponse);
        break;

      case 'get_opencode_runtime':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to access OpenCode runtime info');
          return;
        }
        await this.handleGetOpenCodeRuntime(session, msg.workspaceId, sendResponse);
        break;

      case 'attach_agent_session':
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, 'PERMISSION_DENIED', 'Requires full access to attach agent sessions');
          return;
        }
        await this.handleAttachAgentSession(session, msg.workspaceId, msg.agentSessionId, msg.viewOnly, sendResponse);
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
          const workspaceSessions = sessions.filter((s) => s.cwd === workspace.path && !(s.hidden || s.kind === 'agent'));
          workspace.sessionCount = workspaceSessions.length;

          // Load process config for the workspace
          const processConfig = loadProcessesConfigWithDiagnostics(workspace.path);
          workspace.processes = processConfig.config.processes.map((process) => ({
            name: process.name,
            instances: process.instances,
            ports: process.ports,
          }));
          workspace.processConfigError = processConfig.error ?? undefined;
        }
      } catch {
        // Ignore errors - just use 0 session counts
      }
    }

    // Attach serve domain if configured
    if (this.processHostDomain) {
      for (const workspace of workspaces) {
        workspace.serveDomain = this.processHostDomain;
      }
    }

    await this.sendMessage(session, sendResponse, {
      type: "workspace_list",
      workspaces: workspaces.map((workspace) => ({
        ...workspace,
        id: toCanonicalWorkspaceId(workspace),
      })),
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
          .filter((s) => !(s.hidden || s.kind === 'agent'))
          .filter(s => {
            if (!workspaceId) return true;
            // Try process session name first
            const parsed = parseProcessSessionName(s.name);
            if (parsed) return matchesWorkspaceIdToken(parsed.workspaceId, workspaceId);
            // Fall back to cwd matching
            const ws = workspacePathMap.get(s.cwd);
            return ws ? matchesWorkspaceId(ws, workspaceId) : false;
          })
          .map(s => {
            const parsed = parseProcessSessionName(s.name);
            let ws = workspacePathMap.get(s.cwd);
            if (!ws && parsed) {
              ws = workspaces.find(workspace => matchesWorkspaceId(workspace, parsed.workspaceId));
            }
            if (!ws) {
              ws = workspaces.find(workspace => s.cwd.startsWith(workspace.path));
            }
            return {
              id: s.id,
              name: s.name,
              workspaceId: ws ? toCanonicalWorkspaceId(ws) : (parsed?.workspaceId ?? "unknown"),
              attached: s.attached,
              createdAt: s.createdAt,
              processTitle: s.processTitle,
              exitCode: s.exitCode,
              processName: (s as any).processName ?? parsed?.processName,
              processInstance: (s as any).processInstance ?? parsed?.instance,
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

    pending.abort();
  }

  /**
   * Handle attach_session request
   */
  private async handleAttachSession(
    session: RemoteClientSession,
    msg: {
      sessionId?: string;
      workspaceId?: string;
      sessionName?: string;
      cols?: number;
      rows?: number;
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
        existingAttachRun.abort();
        this.pendingAttachRuns.delete(session.connectionId);
      }

      let targetSession: Session | null = null;

      // If no session ID, create new session in workspace
      if (!msg.sessionId && msg.workspaceId) {
        const requestedWorkspaceId = msg.workspaceId;
        // Security: Creating new sessions requires full/manage access
        if (!canManage(session.accessType)) {
          await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to create sessions");
          return;
        }

        // Find the workspace path
        const workspaces = await scanWorkspaces();
        const workspace = workspaces.find((w) => matchesWorkspaceId(w, requestedWorkspaceId));

        if (!workspace) {
          await this.sendError(session, sendResponse, "NOT_FOUND", "Workspace not found");
          return;
        }

        const sessions = await listSessions();
        const sessionName = buildSessionName({
          projectName: workspace.projectName,
          workspaceName: workspace.id,
          requestedName: msg.sessionName,
          sessions,
        });
        console.log(`[remote-session] Selected session name: ${sessionName}`);

        if (msg.command) {
          // Skip workspace scripts when a custom command is specified
          targetSession = await createSession(sessionName, workspace.path, {
            command: msg.command,
            args: msg.args,
            env: msg.env,
          });
          console.log(`[remote-session] Created session (custom cmd): ${targetSession.name} (id: ${targetSession.id})`);
        } else {
          // Run setup/select scripts for the workspace with output streaming.
          console.log(`[remote-session] Running workspace scripts for: ${workspace.id}`);

          // Track current phase for script_output messages
          let currentPhase: 'pre' | 'setup' | 'select' = 'pre';
          const attachAbortController = new AbortController();
          this.pendingAttachRuns.set(session.connectionId, attachAbortController);

          const scriptResult = await prepareWorkspaceForSession({
            projectName: workspace.projectName,
            workspacePath: workspace.path,
            workspaceName: workspace.id,
            interactiveScripts: false,
            bundleMode: 'error-if-changed',
            scriptPolicy: msg.scriptPolicy ?? 'auto',
            signal: attachAbortController.signal,
            onOutput: (data) => {
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
              const banner = Buffer.from(`\r\n==> ${phase} scripts...\r\n`);
              void this.sendMessage(session, sendResponse, {
                type: 'script_output',
                phase,
                data: banner.toString('base64'),
              }).catch((error) => {
                logger.debug(`[remote-session] Failed to send script phase banner: ${error instanceof Error ? error.message : String(error)}`);
              });
            },
          }).finally(() => {
            const pending = this.pendingAttachRuns.get(session.connectionId);
            if (pending === attachAbortController) {
              this.pendingAttachRuns.delete(session.connectionId);
            }
          });

          if (!scriptResult.success) {
            console.error(`[remote-session] ${scriptResult.phase} scripts failed:`, scriptResult.error);
            await this.sendMessage(session, sendResponse, {
              type: 'script_output',
              phase: scriptResult.phase,
              data: '',
              done: true,
              error: scriptResult.error,
            });
            const code =
              'bundleNeedsRefresh' in scriptResult && scriptResult.bundleNeedsRefresh
                ? 'BUNDLE_REFRESH_REQUIRED'
                : 'cancelled' in scriptResult && scriptResult.cancelled
                  ? 'SCRIPT_CANCELLED'
                : scriptResult.phase === 'setup'
                  ? 'SETUP_SCRIPT_FAILED'
                  : scriptResult.phase === 'select'
                    ? 'SELECT_SCRIPT_FAILED'
                    : 'PRE_SCRIPT_FAILED';
            await this.sendError(
              session,
              sendResponse,
              code,
              `Workspace scripts failed during ${scriptResult.phase} phase: ${scriptResult.error}`
            );
            return;
          }

          // Send final script_output indicating success
          await this.sendMessage(session, sendResponse, {
            type: 'script_output',
            phase: currentPhase,
            data: '',
            done: true,
          });

          targetSession = await createSession(sessionName, workspace.path, {
            hooks: buildWorkspaceSessionHooks(workspace.projectName, workspace.id),
          });
          console.log(`[remote-session] Created session: ${targetSession.name} (id: ${targetSession.id})`);
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
      session.viewOnly = msg.viewOnly ?? false;

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
      const detail = e instanceof Error ? e.message : String(e);
      await this.sendError(session, sendResponse, "ATTACH_FAILED", `Failed to attach to session: ${detail}`);
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
      const projects = listProjectSummaries();
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

  private async handleListGithubRepos(
    session: RemoteClientSession,
    org: string | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const repos = await listGithubReposForSession(org);
      await this.sendMessage(session, sendResponse, {
        type: 'github_repo_list',
        repos,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list GitHub repositories';
      await this.sendError(session, sendResponse, 'LIST_REPOS_FAILED', message);
    }
  }

  private async handleListRemoteBranches(
    session: RemoteClientSession,
    projectName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const branches = await listRemoteBranchesForSession(projectName);
      await this.sendMessage(session, sendResponse, {
        type: 'remote_branch_list',
        projectName,
        branches,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list remote branches';
      await this.sendError(session, sendResponse, 'LIST_REMOTE_BRANCHES_FAILED', message, {
        projectName,
      });
    }
  }

  private async handleListLinearIssues(
    session: RemoteClientSession,
    projectName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const issues = await listLinearIssuesForSession(projectName);
      await this.sendMessage(session, sendResponse, {
        type: 'linear_issue_list',
        projectName,
        issues,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to list Linear issues';
      await this.sendError(session, sendResponse, 'LIST_LINEAR_ISSUES_FAILED', message, {
        projectName,
      });
    }
  }

  private async handleCreateProject(
    session: RemoteClientSession,
    request: {
      repository: string;
      projectName?: string;
      baseBranch?: string;
      setCurrent?: boolean;
    },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const result = await createProjectForSession({
        repository: request.repository,
        projectName: request.projectName,
        baseBranch: request.baseBranch,
        setCurrent: request.setCurrent,
      });

      await this.sendMessage(session, sendResponse, {
        type: 'project_created',
        projectName: result.projectName,
        repository: result.repository,
        baseBranch: result.baseBranch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create project';
      await this.sendError(session, sendResponse, 'CREATE_PROJECT_FAILED', message, {
        projectName: request.projectName,
      });
    }
  }

  private async handlePrepareProjectCreation(
    session: RemoteClientSession,
    request: {
      repository: string;
      projectName?: string;
      baseBranch?: string;
      setCurrent?: boolean;
    },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const result = await prepareProjectForSession({
        repository: request.repository,
        projectName: request.projectName,
        baseBranch: request.baseBranch,
        setCurrent: request.setCurrent,
      });

      await this.sendMessage(session, sendResponse, {
        type: 'project_creation_prepared',
        projectName: result.projectName,
        repository: result.repository,
        baseBranch: result.baseBranch,
        bundle: result.bundle,
        confirmStatuses: result.confirmStatuses,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to prepare project creation';
      await this.sendError(session, sendResponse, 'CREATE_PROJECT_FAILED', message, {
        projectName: request.projectName,
      });
    }
  }

  private async handleFinalizeProjectCreation(
    session: RemoteClientSession,
    request: {
      projectName: string;
      repository: string;
      baseBranch: string;
      bundle?: import('../../types/bundle.js').SpacesBundle;
      inputValues?: Record<string, string>;
      secretValues?: Record<string, string>;
      confirmResults?: Record<string, import('../../types/bundle.js').ConfirmStepResult>;
      setCurrent?: boolean;
    },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const result = await finalizePreparedProjectForSession({
        projectName: request.projectName,
        repository: request.repository,
        baseBranch: request.baseBranch,
        bundle: request.bundle,
        inputValues: request.inputValues,
        secretValues: request.secretValues,
        confirmResults: request.confirmResults,
        setCurrent: request.setCurrent,
      });

      await this.sendMessage(session, sendResponse, {
        type: 'project_created',
        projectName: result.projectName,
        repository: result.repository,
        baseBranch: result.baseBranch,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to finalize project creation';
      await this.sendError(session, sendResponse, 'CREATE_PROJECT_FAILED', message, {
        projectName: request.projectName,
      });
    }
  }

  private async handleCancelProjectCreation(
    session: RemoteClientSession,
    projectName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      await cancelPreparedProjectForSession(projectName);
      await this.sendMessage(session, sendResponse, {
        type: 'project_creation_cancelled',
        projectName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to cancel project creation';
      await this.sendError(session, sendResponse, 'CREATE_PROJECT_FAILED', message, {
        projectName,
      });
    }
  }

  private async handleCreateWorkspace(
    session: RemoteClientSession,
    request: {
      projectName: string;
      workspaceName: string;
      branchName?: string;
      baseBranch?: string;
      workspaceSource?: import('../../types/lifecycle.js').WorkspaceSource;
      linearIssue?: import('../../types/lifecycle.js').SessionLinearIssueSummary;
    },
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const result = await createWorkspaceForSession({
        projectName: request.projectName,
        workspaceName: request.workspaceName,
        branchName: request.branchName,
        baseBranch: request.baseBranch,
        workspaceSource: request.workspaceSource,
        linearIssue: request.linearIssue,
      });

      await this.sendMessage(session, sendResponse, {
        type: 'workspace_created',
        projectName: result.projectName,
        workspaceId: result.workspaceId,
        workspaceName: result.workspaceName,
        branchName: result.branchName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create workspace';
      await this.sendError(session, sendResponse, 'CREATE_WORKSPACE_FAILED', message, {
        projectName: request.projectName,
      });
    }
  }

  private async handleDeleteProject(
    session: RemoteClientSession,
    projectName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      await deleteProjectForSession({ projectName });
      await this.sendMessage(session, sendResponse, {
        type: 'project_deleted',
        projectName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete project';
      await this.sendError(session, sendResponse, 'DELETE_PROJECT_FAILED', message, {
        projectName,
      });
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
      const workspaceId = workspace ? toCanonicalWorkspaceId(workspace) : "unknown";

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
    scriptPolicy: 'auto' | 'skip' | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    const normalizedWorkspaceId = workspaceId.startsWith(`${projectName}:`)
      ? workspaceId.slice(projectName.length + 1)
      : workspaceId;
    const canonicalWorkspaceId = `${projectName}:${normalizedWorkspaceId}`;
    let emittedDone = false;
    const emitDone = async (error?: string) => {
      await this.sendMessage(session, sendResponse, {
        type: 'script_output',
        phase: 'remove',
        data: '',
        done: true,
        error,
      });
      emittedDone = true;
    };

    try {
      const result = await deleteWorkspaceCore(projectName, normalizedWorkspaceId, {
        nonInteractive: true, // Remote context - scripts can't prompt for input
        removeScriptPolicy: scriptPolicy === 'skip' ? 'skip' : 'enforce',
        onScriptOutput: (data) => {
          void this.sendMessage(session, sendResponse, {
            type: 'script_output',
            phase: 'remove',
            data: data.toString('base64'),
          }).catch((error) => {
            logger.debug(`[remote-session] Failed to stream remove script output: ${error instanceof Error ? error.message : String(error)}`);
          });
        },
      });

      if (!result.success) {
        const message = result.error || 'Failed to delete workspace';
        await emitDone(message);

        if (result.errorCode === 'REMOVE_SCRIPT_FAILED') {
          await this.sendError(session, sendResponse, 'REMOVE_SCRIPT_FAILED', message, {
            workspaceId: canonicalWorkspaceId,
          });
          return;
        }

        const errorCode = result.errorCode === 'WORKSPACE_NOT_FOUND' || message.includes('not exist')
          ? 'NOT_FOUND'
          : 'DELETE_FAILED';
        await this.sendError(session, sendResponse, errorCode, message, {
          workspaceId: canonicalWorkspaceId,
        });
        return;
      }

      await emitDone();

      await this.sendMessage(session, sendResponse, {
        type: "workspace_deleted",
        workspaceId: canonicalWorkspaceId,
      });
    } catch (e) {
      console.error("[remote-session] Failed to delete workspace:", e);
      if (!emittedDone) {
        const message = e instanceof Error ? e.message : String(e);
        await emitDone(message);
      }
      await this.sendError(session, sendResponse, "DELETE_FAILED", "Failed to delete workspace", {
        workspaceId: canonicalWorkspaceId,
      });
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
      
      // Count unique sessions that have unread items AND are still active
      const activeSessionsWithUnread = new Set<string>();
      for (const item of items) {
        if (!item.read && activeSessionIds.has(item.sessionId)) {
          activeSessionsWithUnread.add(item.sessionId);
        }
      }
      
      await this.sendMessage(session, sendResponse, {
        type: "inbox_list",
        items,
        unreadCount: activeSessionsWithUnread.size,
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
   * Handle get_notification_config request
   */
  private async handleGetNotificationConfig(
    session: RemoteClientSession,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const config = getNotificationConfig();
      await this.sendMessage(session, sendResponse, {
        type: "notification_config",
        config,
      });
    } catch (e) {
      console.error("[remote-session] Failed to read notification config:", e);
      await this.sendError(session, sendResponse, "CONFIG_FAILED", "Failed to read notification config");
    }
  }

  /**
   * Handle update_notification_config request
   */
  private async handleUpdateNotificationConfig(
    session: RemoteClientSession,
    config: import("../../notifications/types.js").NotificationConfig,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    // Security: only full-access clients can change machine preferences.
    if (!canManage(session.accessType)) {
      await this.sendError(session, sendResponse, "PERMISSION_DENIED", "Requires full access to update settings");
      return;
    }

    try {
      const updated = updateNotificationConfig(config);
      await this.sendMessage(session, sendResponse, {
        type: "notification_config_updated",
        config: updated,
      });
    } catch (e) {
      console.error("[remote-session] Failed to update notification config:", e);
      await this.sendError(session, sendResponse, "CONFIG_FAILED", "Failed to update notification config");
    }
  }

  private async handleGetBundleRefreshPlan(
    session: RemoteClientSession,
    projectName: string,
    workspaceId: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspace = await this.resolveWorkspace(projectName, workspaceId);
      const plan = await getBundleRefreshPlan(projectName, workspace.path, `${projectName}:${workspace.id}`);
      await this.sendMessage(session, sendResponse, {
        type: 'bundle_refresh_plan',
        plan,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to build bundle refresh plan';
      await this.sendError(session, sendResponse, 'BUNDLE_REFRESH_PLAN_FAILED', message);
    }
  }

  private async handleApplyBundleRefresh(
    session: RemoteClientSession,
    projectName: string,
    workspaceId: string,
    submission: import('../../types/bundle-refresh.js').BundleRefreshSubmission,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspace = await this.resolveWorkspace(projectName, workspaceId);
      await applyBundleRefreshSubmission(projectName, workspace.path, submission);
      await this.sendMessage(session, sendResponse, {
        type: 'bundle_refresh_applied',
        projectName,
        workspaceId: `${projectName}:${workspace.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply bundle refresh';
      await this.sendError(session, sendResponse, 'BUNDLE_REFRESH_APPLY_FAILED', message);
    }
  }

  private async handleGetBundleConfigState(
    session: RemoteClientSession,
    projectName: string,
    workspaceId: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspace = await this.resolveWorkspace(projectName, workspaceId);
      const state = await getBundleConfigState(projectName, workspace.path, `${projectName}:${workspace.id}`);
      await this.sendMessage(session, sendResponse, {
        type: 'bundle_config_state',
        state,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load bundle configuration state';
      await this.sendError(session, sendResponse, 'BUNDLE_CONFIG_STATE_FAILED', message);
    }
  }

  private async handleApplyBundleConfigUpdate(
    session: RemoteClientSession,
    projectName: string,
    workspaceId: string,
    submission: import('../../types/bundle-config.js').BundleConfigSubmission,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspace = await this.resolveWorkspace(projectName, workspaceId);
      await applyBundleConfigSubmission(projectName, workspace.path, submission);
      await this.sendMessage(session, sendResponse, {
        type: 'bundle_config_updated',
        projectName,
        workspaceId: `${projectName}:${workspace.id}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to apply bundle configuration update';
      await this.sendError(session, sendResponse, 'BUNDLE_CONFIG_UPDATE_FAILED', message);
    }
  }

  // ============================================================================
  // Review Request Handling
  // ============================================================================

  /**
   * Handle a review_request message by dispatching to the appropriate
   * review operation and responding with a review_response.
   */
  private async handleReviewRequest(
    session: RemoteClientSession,
    requestId: string,
    operation: ReviewOperation,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    if (isMutatingReviewOperation(operation) && !canManage(session.accessType)) {
      await this.sendMessage(session, sendResponse, {
        type: 'review_response',
        requestId,
        error: {
          code: 'PERMISSION_DENIED',
          message: 'Requires full access to perform this review operation',
        },
      });
      return;
    }

    try {
      const result = await this.executeReviewOperation(operation);
      await this.sendMessage(session, sendResponse, {
        type: 'review_response',
        requestId,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.sendMessage(session, sendResponse, {
        type: 'review_response',
        requestId,
        error: { code: 'REVIEW_ERROR', message },
      });
    }
  }

  /**
   * Delegate to the shared executeLocalReviewOperation from review-executor.ts.
   * This is the single authoritative implementation used by both the remote
   * session handler and the local session backend.
   */
  private async executeReviewOperation(operation: ReviewOperation): Promise<ReviewResult> {
    return executeLocalReviewOperation(operation, scanWorkspaces);
  }

  private async resolveWorkspace(
    projectName: string,
    workspaceId: string
  ): Promise<{ id: string; path: string }> {
    const normalizedWorkspaceId = workspaceId.startsWith(`${projectName}:`)
      ? workspaceId.slice(projectName.length + 1)
      : workspaceId;

    const workspaces = await scanWorkspaces();
    const workspace = workspaces.find(
      (item) => item.projectName === projectName && item.id === normalizedWorkspaceId
    );

    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    return {
      id: workspace.id,
      path: workspace.path,
    };
  }

  private buildOpenCodeStreamKey(session: RemoteClientSession, requestId: string): string {
    return `${session.connectionId}:${requestId}`;
  }

  private async resolveAgentWorkspaceTarget(workspaceId: string): Promise<AgentWorkspaceTarget> {
    const workspaces = await scanWorkspaces();
    const workspace = workspaces.find((item) => matchesWorkspaceId(item, workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }
    return {
      workspaceId: toCanonicalWorkspaceId(workspace),
      workspaceName: workspace.id,
      workspacePath: workspace.path,
      projectName: workspace.projectName,
    };
  }

  private async ensureOpenCodeRuntime(workspaceId: string): Promise<{
    workspaceId: string;
    workspacePath: string;
    baseUrl: string;
    username: string;
    password: string;
    authHeader: string;
  }> {
    const workspaces = await scanWorkspaces();
    const workspace = workspaces.find((item) => matchesWorkspaceId(item, workspaceId));
    if (!workspace) {
      throw new Error(`Workspace not found: ${workspaceId}`);
    }

    const runtime = await this.openCodeRuntimeManager.ensureWorkspaceRuntime({
      workspaceId: toCanonicalWorkspaceId(workspace),
      workspacePath: workspace.path,
      projectName: workspace.projectName,
    });

    return {
      workspaceId: runtime.workspaceId,
      workspacePath: runtime.workspacePath,
      baseUrl: runtime.baseUrl,
      username: runtime.username,
      password: runtime.password,
      authHeader: createOpenCodeBasicAuthHeader(runtime),
    };
  }

  private async handleAttachAgentSession(
    session: RemoteClientSession,
    workspaceId: string,
    agentSessionId: string,
    viewOnly: boolean | undefined,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    try {
      const target = await this.resolveAgentWorkspaceTarget(workspaceId);
      const terminalSession = await defaultOpenCodeCoordinator.ensureAgentTerminalSession(target, agentSessionId);

      session.state = 'attached';
      session.attachedSessionId = terminalSession.id;
      session.sessionSocketPath = terminalSession.socketPath;
      session.viewOnly = viewOnly ?? false;

      await this.sendMessage(session, sendResponse, {
        type: 'attached',
        sessionId: terminalSession.id,
        sessionName: terminalSession.name,
        cols: 80,
        rows: 24,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      await this.sendError(session, sendResponse, 'ATTACH_FAILED', `Failed to attach agent session: ${detail}`);
    }
  }

  private async handleOpenCodeRequest(
    session: RemoteClientSession,
    msg: Extract<ClientToMachineMessage, { type: 'opencode_request' }>,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    try {
      const runtime = await this.ensureOpenCodeRuntime(msg.workspaceId);
      const url = buildOpenCodeUrl(runtime.baseUrl, msg.path, msg.query);
      const response = await fetch(url, {
        method: msg.method,
        headers: {
          ...(msg.headers ?? {}),
          authorization: runtime.authHeader,
        },
        body: msg.bodyBase64 ? Buffer.from(msg.bodyBase64, 'base64') : undefined,
        signal: AbortSignal.timeout(30_000),
      });

      const bodyBuffer = Buffer.from(await response.arrayBuffer());
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      await this.sendMessage(session, sendResponse, {
        type: 'opencode_response',
        requestId: msg.requestId,
        status: response.status,
        headers: responseHeaders,
        bodyBase64: bodyBuffer.length > 0 ? bodyBuffer.toString('base64') : undefined,
      });
    } catch (error) {
      await this.sendMessage(session, sendResponse, {
        type: 'opencode_response',
        requestId: msg.requestId,
        status: 502,
        bodyBase64: Buffer.from(JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })).toString('base64'),
      });
    }
  }

  private async handleOpenCodeStreamOpen(
    session: RemoteClientSession,
    msg: Extract<ClientToMachineMessage, { type: 'opencode_stream_open' }>,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const streamKey = this.buildOpenCodeStreamKey(session, msg.requestId);
    this.openCodeStreams.get(streamKey)?.abort();

    const controller = new AbortController();
    this.openCodeStreams.set(streamKey, controller);

    try {
      const runtime = await this.ensureOpenCodeRuntime(msg.workspaceId);
      const url = buildOpenCodeUrl(runtime.baseUrl, msg.path, msg.query);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(msg.headers ?? {}),
          authorization: runtime.authHeader,
        },
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(`OpenCode stream failed (${response.status})`);
      }

      const responseBody = response.body;

      await this.sendMessage(session, sendResponse, {
        type: 'opencode_stream_opened',
        requestId: msg.requestId,
      });

      // Detach stream consumption so it does not block the message-processing
      // loop for this client. Subsequent messages (resize, new requests, etc.)
      // can still be handled while the SSE stream is live.
      void (async () => {
        try {
          await consumeSseStream(responseBody, async (parsed) => {
            await this.sendMessage(session, sendResponse, {
              type: 'opencode_stream_event',
              requestId: msg.requestId,
              event: parsed.event,
              data: parsed.data,
              id: parsed.id,
            });
          });

          await this.sendMessage(session, sendResponse, {
            type: 'opencode_stream_closed',
            requestId: msg.requestId,
          });
        } catch (error) {
          if (!controller.signal.aborted) {
            await this.sendMessage(session, sendResponse, {
              type: 'opencode_stream_error',
              requestId: msg.requestId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        } finally {
          // Only delete if this controller is still the registered one (not replaced by a reopen)
          if (this.openCodeStreams.get(streamKey) === controller) {
            this.openCodeStreams.delete(streamKey);
          }
        }
      })();
    } catch (error) {
      // Send error to client BEFORE aborting so the condition isn't short-circuited
      await this.sendMessage(session, sendResponse, {
        type: 'opencode_stream_error',
        requestId: msg.requestId,
        message: error instanceof Error ? error.message : String(error),
      });
      controller.abort();
      if (this.openCodeStreams.get(streamKey) === controller) {
        this.openCodeStreams.delete(streamKey);
      }
    }
  }

  private async handleOpenCodeStreamClose(
    session: RemoteClientSession,
    requestId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    const streamKey = this.buildOpenCodeStreamKey(session, requestId);
    const controller = this.openCodeStreams.get(streamKey);
    if (controller) {
      controller.abort();
      this.openCodeStreams.delete(streamKey);
    }

    await this.sendMessage(session, sendResponse, {
      type: 'opencode_stream_closed',
      requestId,
    });
  }

  private async handleGetOpenCodeRuntime(
    session: RemoteClientSession,
    workspaceId: string,
    sendResponse: (data: Uint8Array) => void,
  ): Promise<void> {
    try {
      const runtime = await this.ensureOpenCodeRuntime(workspaceId);
      await this.sendMessage(session, sendResponse, {
        type: 'opencode_runtime',
        workspaceId: runtime.workspaceId,
        workspacePath: runtime.workspacePath,
        hostname: new URL(runtime.baseUrl).hostname,
        port: Number(new URL(runtime.baseUrl).port),
        baseUrl: runtime.baseUrl,
        username: runtime.username,
        password: runtime.password,
      });
    } catch (error) {
      await this.sendError(session, sendResponse, 'OPENCODE_RUNTIME_FAILED', error instanceof Error ? error.message : String(error), { workspaceId });
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
   * Handle get_events request
   */
  private async handleGetEvents(
    session: RemoteClientSession,
    workspacePath: string,
    processName: string | undefined,
    _processInstance: number | undefined,
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

      const savedEventFilters = loadSavedEventFilters(workspaceRef.workspacePath);

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
          if (sinceMs !== undefined && snapshot.updatedAt < sinceMs) return false;
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

      // Chunk responses to stay under payload limit
      const maxPayloadBytes = 900_000;
      const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      const buildPayload = (
        chunk: import("../../types/events.js").WideEvent[],
        chunkIndex: number,
        totalChunks: number,
      ) => ({
        type: "events_list" as const,
        workspaceId: workspaceRef.workspaceId,
        events: chunk,
        liveEventIds: [] as string[],
        savedEventFilters,
        requestId,
        chunkIndex,
        totalChunks,
      });

      const chunks: import("../../types/events.js").WideEvent[][] = [];
      let chunk: import("../../types/events.js").WideEvent[] = [];
      for (const event of events) {
        chunk.push(event);
        const payloadSize = Buffer.byteLength(JSON.stringify(buildPayload(chunk, 0, 1)));
        if (payloadSize > maxPayloadBytes) {
          if (chunk.length === 1) {
            chunks.push(chunk);
            chunk = [];
            continue;
          }
          const last = chunk.pop();
          chunks.push(chunk);
          chunk = last ? [last] : [];
        }
      }

      if (chunk.length > 0) {
        chunks.push(chunk);
      }

      if (chunks.length === 0) {
        chunks.push([]);
      }

      const totalChunks = chunks.length;
      for (let i = 0; i < totalChunks; i += 1) {
        await this.sendMessage(session, sendResponse, buildPayload(chunks[i], i, totalChunks));
      }
    } catch (e) {
      console.error("[remote-session] Failed to get events:", e);
      await this.sendError(session, sendResponse, "EVENTS_FAILED", "Failed to get events");
    }
  }

  /**
   * Handle start_process request
   */
  private async handleStartProcess(
    session: RemoteClientSession,
    workspaceId: string,
    processName: string,
    instance: number | undefined,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspaces = await scanWorkspaces();
      const workspace = workspaces.find((w) => matchesWorkspaceId(w, workspaceId));
      if (!workspace) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Workspace not found");
        return;
      }

      const processConfig = loadProcessesConfig(workspace.path);
      const processDefinition = getProcessDefinition(processConfig, processName);
      if (!processDefinition) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Process not found");
        return;
      }
      if (normalizeProcessInstanceCount(processDefinition.instances) === 0) {
        await this.sendError(session, sendResponse, "PROCESS_DISABLED", `Process is disabled (instances: 0): ${processName}`);
        return;
      }

      const specs = getProcessSpecs(workspace.path).filter(
        (spec) => spec.name === processName && (instance === undefined || spec.instance === instance)
      );
      if (specs.length === 0) {
        await this.sendError(session, sendResponse, "NOT_FOUND", "Process not found");
        return;
      }

      const sessions: string[] = [];
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
        sessionIds: sessions,
      });
    } catch (e) {
      console.error("[remote-session] Failed to start process:", e);
      await this.sendError(session, sendResponse, "PROCESS_FAILED", "Failed to start process");
    }
  }

  /**
   * Handle stop_process request
   */
  private async handleStopProcess(
    session: RemoteClientSession,
    workspaceId: string,
    processName: string,
    sendResponse: (data: Uint8Array) => void
  ): Promise<void> {
    try {
      const workspaces = await scanWorkspaces();
      const workspace = workspaces.find((w) => matchesWorkspaceId(w, workspaceId));
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
   * Cleanup
   */
  cleanupConnection(connectionId: string): void {
    for (const [key, controller] of this.openCodeStreams) {
      if (!key.startsWith(`${connectionId}:`)) {
        continue;
      }
      controller.abort();
      this.openCodeStreams.delete(key);
    }
  }

  async cleanup(): Promise<void> {
    for (const controller of this.openCodeStreams.values()) {
      controller.abort();
    }
    this.openCodeStreams.clear();

    // Clean up process schedulers
    for (const timer of this.processSchedulers.values()) {
      clearInterval(timer);
    }
    this.processSchedulers.clear();
    this.tmuxLiteAvailable = false;
  }
}
