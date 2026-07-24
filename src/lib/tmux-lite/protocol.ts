/**
 * tmux-lite protocol
 */

import { SpacesError } from '../../types/errors.js';
import { logger } from '../../utils/logger.js';


/** Protocol version - increment when making breaking changes */
export const PROTOCOL_VERSION = 1;

/** Package version - should match package.json */
import { VERSION } from '../../version.generated.js';
// Single source of truth: generated from package.json by scripts/build.ts.
export const PACKAGE_VERSION = VERSION;

export const TMUX_LITE_SANDBOX_ENV = "TMUX_LITE_SANDBOX";
const DEFAULT_ROUTER_SOCKET = "/tmp/tmux-lite.sock";
const DEFAULT_PID_FILE = "/tmp/tmux-lite.pid";
const DEFAULT_SESSION_DIR = "/tmp";
const MAX_UNIX_SOCKET_PATH_LENGTH = 108;

export interface TmuxLitePaths {
  routerSocket: string;
  pidFile: string;
  sessionDir: string;
  replayDir: string;
}

function normalizeSessionDir(dir: string): string {
  return dir.endsWith("/") ? dir.slice(0, -1) : dir;
}

function assertUnixSocketPathLength(path: string): void {
  const pathBytes = Buffer.byteLength(path);
  if (pathBytes > MAX_UNIX_SOCKET_PATH_LENGTH) {
    throw new Error(`tmux-lite socket path exceeds ${MAX_UNIX_SOCKET_PATH_LENGTH} bytes (${pathBytes}): ${path}`);
  }
}

export function normalizeTmuxLiteSandboxName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || !/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(trimmed)) {
    throw new Error(`Invalid tmux-lite sandbox name: ${name}`);
  }
  return trimmed;
}

export function getTmuxLiteSandbox(): string | undefined {
  const raw = process.env[TMUX_LITE_SANDBOX_ENV]?.trim();
  if (!raw) {
    return undefined;
  }
  return normalizeTmuxLiteSandboxName(raw);
}

export function getTmuxLitePathsForSandbox(sandbox: string): TmuxLitePaths {
  const normalized = normalizeTmuxLiteSandboxName(sandbox);
  const base = `/tmp/tmux-lite-${normalized}`;
  const routerSocket = `${base}.sock`;
  assertUnixSocketPathLength(routerSocket);
  return {
    routerSocket,
    pidFile: `${base}.pid`,
    sessionDir: base,
    replayDir: `${base}/replays`,
  };
}

export function getTmuxLitePaths(): TmuxLitePaths {
  const explicitSessionDir = process.env.TMUX_LITE_SESSION_DIR?.trim();
  const explicitReplayDir = process.env.TMUX_LITE_REPLAY_DIR?.trim();
  const explicitRouterSocket = process.env.TMUX_LITE_SOCKET?.trim();
  const explicitPidFile = process.env.TMUX_LITE_PID_FILE?.trim();
  const sandbox = getTmuxLiteSandbox();

  if (sandbox) {
    const sandboxPaths = getTmuxLitePathsForSandbox(sandbox);
    const routerSocket = explicitRouterSocket || sandboxPaths.routerSocket;
    assertUnixSocketPathLength(routerSocket);
    return {
      routerSocket,
      pidFile: explicitPidFile || sandboxPaths.pidFile,
      sessionDir: normalizeSessionDir(explicitSessionDir || sandboxPaths.sessionDir),
      replayDir: explicitReplayDir || sandboxPaths.replayDir,
    };
  }

  const sessionDir = normalizeSessionDir(explicitSessionDir || DEFAULT_SESSION_DIR);
  const routerSocket = explicitRouterSocket || DEFAULT_ROUTER_SOCKET;
  assertUnixSocketPathLength(routerSocket);
  return {
    routerSocket,
    pidFile: explicitPidFile || DEFAULT_PID_FILE,
    sessionDir,
    replayDir: explicitReplayDir || `${sessionDir}/tmux-lite-replays`,
  };
}

export function applyTmuxLiteSandboxEnvironment(
  sandbox: string,
  options: { preserveExplicit?: boolean } = {}
): TmuxLitePaths {
  const normalized = normalizeTmuxLiteSandboxName(sandbox);
  const paths = getTmuxLitePathsForSandbox(normalized);
  const preserveExplicit = options.preserveExplicit === true;
  process.env[TMUX_LITE_SANDBOX_ENV] = normalized;
  if (!preserveExplicit || !process.env.TMUX_LITE_SOCKET?.trim()) {
    process.env.TMUX_LITE_SOCKET = paths.routerSocket;
  }
  if (!preserveExplicit || !process.env.TMUX_LITE_PID_FILE?.trim()) {
    process.env.TMUX_LITE_PID_FILE = paths.pidFile;
  }
  if (!preserveExplicit || !process.env.TMUX_LITE_SESSION_DIR?.trim()) {
    process.env.TMUX_LITE_SESSION_DIR = paths.sessionDir;
  }
  if (!preserveExplicit || !process.env.TMUX_LITE_REPLAY_DIR?.trim()) {
    process.env.TMUX_LITE_REPLAY_DIR = paths.replayDir;
  }
  return paths;
}

export function getRouterSocket(): string {
  return getTmuxLitePaths().routerSocket;
}

export function getPidFile(): string {
  return getTmuxLitePaths().pidFile;
}

export function getSessionDir(): string {
  return getTmuxLitePaths().sessionDir;
}

export function getReplayDir(): string {
  return getTmuxLitePaths().replayDir;
}

/**
 * Pattern for valid session IDs - alphanumeric, hyphens, underscores only
 * Security: Prevents path traversal attacks via session IDs
 */
const VALID_SESSION_ID_PATTERN = /^[a-zA-Z0-9\-_]+$/;

/**
 * Validate a session ID to prevent path traversal
 */
export function isValidSessionId(id: string): boolean {
  if (!id || id.length === 0 || id.length > 256) {
    return false;
  }
  return VALID_SESSION_ID_PATTERN.test(id);
}

export function getSessionSocketPath(id: string): string {
  // Security: Validate session ID to prevent path traversal
  if (!isValidSessionId(id)) {
    throw new Error(`Invalid session ID: ${id}`);
  }
  const normalizedDir = getSessionDir();
  const socketPath = `${normalizedDir}/tmux-lite-${id}.sock`;
  assertUnixSocketPathLength(socketPath);
  return socketPath;
}

// This is a LOCAL IPC unix-socket cap (daemon ↔ CLI / serve-runtime), not a
// network limit — the 4-byte length header supports up to 4 GiB. 32 MiB was too
// tight: a large machine snapshot / agent-state / transcript response can exceed
// it, and encodeRouterMessage throwing inside the socket 'data' handler took the
// whole daemon down (clients then saw "Disconnected"). 128 MiB gives real
// headroom; sendRouterResponse now also degrades gracefully rather than crashing
// if a response somehow still exceeds it. (A response this large is itself a
// bloat smell worth slimming at the source — see machine snapshot build.)
export const MAX_ROUTER_MESSAGE_SIZE = 128 * 1024 * 1024;


const ROUTER_FRAME_HEADER_BYTES = 4;

export function encodeRouterMessage(msg: Command | Response): Buffer {
  const json = JSON.stringify(msg);
  const len = Buffer.byteLength(json);
  if (len > MAX_ROUTER_MESSAGE_SIZE) {
    const message = `Router message size ${len} exceeds maximum ${MAX_ROUTER_MESSAGE_SIZE}`;
    logger.error(message);
    throw new SpacesError(message, 'SYSTEM_ERROR', 2);
  }
  const buf = Buffer.alloc(ROUTER_FRAME_HEADER_BYTES + len);
  buf.writeUInt32BE(len, 0);
  buf.write(json, ROUTER_FRAME_HEADER_BYTES);
  return buf;
}

export function decodeRouterMessages(buffer: Buffer): {
  messages: Array<Command | Response>;
  remaining: Buffer;
} {
  const messages: Array<Command | Response> = [];
  let offset = 0;

  while (offset + ROUTER_FRAME_HEADER_BYTES <= buffer.length) {
    const len = buffer.readUInt32BE(offset);
    if (len > MAX_ROUTER_MESSAGE_SIZE) {
      const message = `Router message size ${len} exceeds maximum ${MAX_ROUTER_MESSAGE_SIZE}`;
      logger.error(message);
      throw new SpacesError(message, 'SYSTEM_ERROR', 2);
    }
    const frameEnd = offset + ROUTER_FRAME_HEADER_BYTES + len;
    if (frameEnd > buffer.length) {
      break;
    }
    const json = buffer.subarray(offset + ROUTER_FRAME_HEADER_BYTES, frameEnd).toString();
    messages.push(JSON.parse(json));
    offset = frameEnd;
  }

  return {
    messages,
    remaining: buffer.subarray(offset),
  };
}

// Router commands
export interface SessionCreateHooks {
  /** Environment variables injected into spawned shell process */
  env?: Record<string, string>;
  /** Optional shell init snippets (run once after shell starts) */
  shellInit?: {
    /** Runs for all shells */
    all?: string;
    /** Runs for bash shells */
    bash?: string;
    /** Runs for zsh shells */
    zsh?: string;
    /** Runs for sh shells */
    sh?: string;
  };
}

export type SessionKind = 'shell' | 'agent';

export type { ReplayInfo, ReplayStatus, TerminalSnapshot } from './replay/types.js';


/** Daemon-unification P1 (docs/DAEMON-UNIFICATION.md): the activator passes
 *  the DECRYPTED identity over the same-user 0600 unix socket — the same
 *  trust domain as the encrypted keyfile + keychain password. Keys are
 *  base64; the server reconstructs Uint8Arrays. */
export interface ServeActivatePayload {
  relayUrl: string;
  /** Pinned by the activator's interactive trust check. */
  relayPubkey: string;
  machineId: string;
  ownerUserRootId?: string;
  identity: {
    id: string;
    label?: string;
    createdAt: number;
    signingPublicKey: string;
    signingSecretKey: string;
    keyExchangePublicKey: string;
    keyExchangeSecretKey: string;
  };
  publicIdentity: { id: string; signingPublicKey: string; keyExchangePublicKey: string; label?: string };
  bootstrapToken?: string;
  registerPermit?: string;
  enrollmentToken?: string;
  deviceCertificate?: string;
}

export interface AgentWorkspaceTargetPayload {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  projectName: string;
}

export interface AgentPromptImage {
  /** Raw base64 image data (not a data URL) */
  data: string;
  /** MIME type, e.g. "image/png", "image/jpeg" */
  mimeType: string;
}

export interface AgentSessionSummaryPayload {
  id: string;
  workspaceId: string;
  title: string;
  updatedAt?: string;
  closedAt?: string;
  archivedAt?: string;
}

export interface WorkspaceRuntimeAgentSummary {
  sessionCount: number;
  busyCount: number;
  waitingCount: number;
  needsPermissionCount: number;
  errorCount: number;
  closedCount: number;
  archivedCount: number;
}

export interface WorkspaceRuntimeTerminalSummary {
  sessionCount: number;
  attachedCount: number;
  runningCount: number;
  failedCount: number;
}

export interface WorkspaceRuntimeProcessSummary {
  configuredCount: number;
  runningCount: number;
  failedCount: number;
}

export interface WorkspaceRuntimeRecord {
  id: string;
  name: string;
  path: string;
  projectName: string;
  branch?: string;
  sessionCount: number;
  isStale?: boolean;
  serveDomain?: string;
  processes?: import('../../types/processes.js').RuntimeProcessDefinition[];
  processConfigError?: string;
  status?: import('../../types/config.js').WorkspacePhase;
  notesSummary?: import('../../types/workspace.js').WorkspaceNotesSummary;
  terminals: WorkspaceRuntimeTerminalSummary;
  agents: WorkspaceRuntimeAgentSummary;
  processSummary: WorkspaceRuntimeProcessSummary;
}

export type {
  MachineAgentSessionFilter,
  MachineProjectFilter,
  MachineRequest,
  MachineResponse,
  MachineTerminalSessionFilter,
  MachineWorkspaceFilter,
  MachineEvent,
  MachineSnapshot,
} from './machine/protocol.js';

export type Command =
  | { type: "list" }
  | { type: "list-replays"; workspaceId?: string; sessionId?: string; status?: import('./replay/types.js').ReplayStatus[] }
  | { type: "replay-snapshot"; replayId: string; atMs?: number; scrollbackLines?: number }
  | {
      type: "replay-text";
      replayId: string;
      atMs?: number;
      scrollbackLines?: number;
      includeScrollback?: boolean;
      trimTrailingBlankRows?: boolean;
    }
  | {
      type: "replay-markdown";
      replayId: string;
      atMs?: number;
      scrollbackLines?: number;
      includeScrollback?: boolean;
      trimTrailingBlankRows?: boolean;
    }
  | { type: "create-checkpoint"; id: string }
  | {
      type: "new";
      name?: string;
      cwd: string;
      hooks?: SessionCreateHooks;
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      kind?: SessionKind;
      hidden?: boolean;
      recordReplay?: boolean;
      metadata?: Record<string, string>;
    }
  | {
      type: 'new-virtual';
      name?: string;
      cwd: string;
      cols?: number;
      rows?: number;
      kind?: SessionKind;
      hidden?: boolean;
      metadata?: Record<string, string>;
    }
  | { type: 'virtual-resize'; id: string; cols: number; rows: number }
  | {
      type: 'attach-prepare';
      requestId: string;
      sessionId?: string;
      workspaceId?: string;
      sessionName?: string;
      scriptPolicy?: 'auto' | 'skip';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      viewOnly?: boolean;
    }
  | { type: 'attach-cancel'; requestId: string }
  | { type: "attach"; id: string; force?: boolean }
  | { type: "terminate"; id: string; mode?: "graceful" | "force"; graceMs?: number }
  | { type: 'agent-state' }
  | { type: 'agent-watch' }
  | { type: 'machine-snapshot' } // legacy tmux router alias for getMachineSnapshot
  | { type: 'machine-watch' }    // legacy tmux router alias for watchMachineEvents
  /** Force a full snapshot rebuild from sources (client-detected nonce gap
   *  or explicit reconciliation). Replies with a machine-snapshot response. */
  | { type: 'machine-resync' }
  /** Fire-and-forget notify from the space CLI after a goal.json write: the
   *  daemon re-reads that project's goals and emits scoped machine deltas. */
  | { type: 'goal-changed'; projectName: string; workspaceName?: string }
  | {
      type: 'workspace-set-phase';
      projectName: string;
      workspaceName: string;
      phase: import('../../types/config.js').WorkspacePhase;
      cascade?: boolean;
    }
  | { type: 'agent-sessions'; target: AgentWorkspaceTargetPayload; mode?: 'known' | 'live' }
  | { type: 'agent-create'; target: AgentWorkspaceTargetPayload; title?: string }
  | { type: 'agent-abort'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-interrupt'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-close'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-archive'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-restore'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-attach'; target: AgentWorkspaceTargetPayload; agentSessionId: string; cols?: number; rows?: number }
  | { type: 'agent-prompt'; target: AgentWorkspaceTargetPayload; agentSessionId: string; text: string; images?: AgentPromptImage[]; streamingBehavior?: 'steer' | 'followUp' }
  | { type: 'agent-queue-remove'; target: AgentWorkspaceTargetPayload; agentSessionId: string; kind: 'steering' | 'followUp'; index: number }
  | { type: 'agent-stage-upload'; target: AgentWorkspaceTargetPayload; fileName: string; data: string; mimeType: string }
  | { type: 'agent-list-commands'; target: AgentWorkspaceTargetPayload }
  | { type: 'agent-transcript-range'; target: AgentWorkspaceTargetPayload; agentSessionId: string; before?: string; limit: number }
  | { type: 'agent-control-info'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-set-model'; target: AgentWorkspaceTargetPayload; agentSessionId: string; provider: string; modelId: string }
  | { type: 'agent-set-thinking-level'; target: AgentWorkspaceTargetPayload; agentSessionId: string; level: string }
  | { type: 'agent-set-approval-mode'; target: AgentWorkspaceTargetPayload; agentSessionId: string; mode: string }
  | { type: 'agent-auth-providers' }
  | { type: 'agent-remove-account'; provider: string; credentialId: number }
  | { type: 'agent-set-api-key'; provider: string; key: string }
  | { type: 'agent-get-settings' }
  | { type: 'agent-set-setting'; path: string; value: string | number | boolean | string[] }
  | { type: 'agent-oauth-login'; provider: string; flowId: string }
  | { type: 'agent-oauth-respond'; flowId: string; value: string }
  | { type: 'agent-settings-schema' }
  | { type: 'agent-tools'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-list-agents'; target: AgentWorkspaceTargetPayload }
  | { type: 'agent-compact'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-cycle-role'; target: AgentWorkspaceTargetPayload; agentSessionId: string; direction: 'forward' | 'backward' }
  | { type: 'agent-apply-role'; target: AgentWorkspaceTargetPayload; agentSessionId: string; role: string }
  | { type: 'agent-history'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-tree'; target: AgentWorkspaceTargetPayload; agentSessionId: string }
  | { type: 'agent-navigate-history'; target: AgentWorkspaceTargetPayload; agentSessionId: string; entryId: string; mode?: 'redo' | 'jump' }
  | { type: 'artifact-list'; uriPrefix: string }
  | { type: 'artifact-read'; uri: string }
  | { type: 'artifact-write'; uri: string; contentBase64: string; message?: string; cap?: string }
  | { type: 'project-artifacts-status'; projectName: string }
  | { type: 'project-artifacts-remote-set'; projectName: string; url: string }
  | { type: 'project-artifacts-sync'; projectName: string }
  | { type: 'project-artifacts-provision'; projectName: string }
  | { type: 'serve-activate'; config: ServeActivatePayload }
  | { type: 'serve-deactivate' }
  | { type: 'serve-status' }
  | { type: 'project-artifacts-rollup'; projectName: string; workspace: string; removeBranch?: boolean }
  | { type: 'report-problem'; note: string; clientBundleJson: string; fileIssue?: boolean; projectName?: string }
  | { type: 'artifact-share-mint'; uri: string; ttlMs?: number; maxUses?: number; live?: boolean }
  | { type: 'artifact-share-revoke'; tokenId: string }
  | { type: 'artifact-share-list' }
  | { type: 'favorites-list'; uriPrefix: string }
  | { type: 'favorites-toggle'; uri: string }
  | { type: 'favorites-merge'; uriPrefix: string; paths: string[] }
  | { type: 'trigger-save'; target: AgentWorkspaceTargetPayload; trigger: import('../../core/triggers.js').TriggerRecord }
  | { type: 'trigger-run-now'; target: AgentWorkspaceTargetPayload; triggerId: string }
  | { type: 'repo-tree'; target: AgentWorkspaceTargetPayload }
  | { type: 'repo-read'; target: AgentWorkspaceTargetPayload; path: string }
  | { type: 'repo-commit'; target: AgentWorkspaceTargetPayload; message: string }
  | { type: 'repo-search'; target: AgentWorkspaceTargetPayload; query: string; caseSensitive?: boolean }
  | { type: 'workspace-editors-list'; target: AgentWorkspaceTargetPayload }
  | { type: 'workspace-editor-open'; target: AgentWorkspaceTargetPayload; editorId: import('../../utils/open-editor.js').WorkspaceEditorId }
  | { type: 'agent-file-suggestions'; target: AgentWorkspaceTargetPayload; prefix: string; limit?: number }
  | { type: 'service-start'; workspaceId: string; processName: string; instance?: number }
  | { type: 'service-stop'; workspaceId: string; processName: string }
  | { type: 'service-resolve-port-conflict'; conflict: import('../processes/port-conflicts.js').PortConflictInfo }
  | { type: 'github-repos'; org?: string }
  | { type: 'remote-branches'; projectName: string }
  | { type: 'linear-issues'; projectName: string }
  | { type: 'project-create'; repository: string; projectName?: string; baseBranch?: string; setCurrent?: boolean; scratch?: boolean }
  | { type: 'project-prepare'; repository: string; projectName?: string; baseBranch?: string; setCurrent?: boolean }
  | { type: 'project-finalize'; projectName: string; repository: string; baseBranch: string; bundle?: import('../../types/bundle.js').SpacesBundle; inputValues?: Record<string, string>; secretValues?: Record<string, string>; confirmResults?: Record<string, import('../../types/bundle.js').ConfirmStepResult>; setCurrent?: boolean }
  | { type: 'project-cancel'; projectName: string }
  | { type: 'workspace-create'; projectName: string; workspaceName: string; branchName?: string; baseBranch?: string; parentWorkspaceName?: string; workspaceSource?: import('../../types/lifecycle.js').WorkspaceSource; linearIssue?: import('../../types/lifecycle.js').SessionLinearIssueSummary; githubIssueNumber?: number }
  | { type: 'project-delete'; projectName: string }
  | { type: 'workspace-delete'; requestId: string; projectName: string; workspaceId: string; scriptPolicy?: 'auto' | 'skip' }
  | { type: 'workspace-phase-preview'; projectName: string; workspaceName: string; phase: import('../../types/config.js').WorkspacePhase }
  | { type: 'workspace-notes-list'; projectName: string; workspaceName: string }
  | { type: 'workspace-note-add'; projectName: string; workspaceName: string; body: string }
  | { type: 'workspace-note-update'; projectName: string; workspaceName: string; noteId: string; body: string }
  | { type: 'workspace-note-remove'; projectName: string; workspaceName: string; noteId: string }
  | { type: 'goal-update'; projectName: string; goalId: string; updates: import('../../types/goals.js').GoalUpdateInput }
  | { type: 'goal-add-near-workspace'; projectName: string; workspaceName: string; title: string; position: 'before' | 'after' }
  /** List the project's chains projected for the create-goal UI (chain title +
   *  ordered goals with effective phases). Workspace-free chain picker. */
  | { type: 'goal-chains-list'; projectName: string }
  /** Chain-centric planned-goal creation (no workspace): seed a new chain or
   *  insert into an existing one at a legal position. */
  | { type: 'goal-add-planned'; projectName: string; input: import('../../core/goal-chain.js').AddPlannedGoalToChainInput }
  | { type: 'goal-reorder'; projectName: string; sourceToken: string; targetToken: string; position: 'before' | 'after' }
  | { type: 'goal-stack-status'; projectName: string; workspaceName: string }
  /** Cold detail fetch for one goal (ticket #42): the connect snapshot ships a
   *  slim goal projection; the full doc + validation (evidence/reviews/events)
   *  are pulled on demand when a detail view opens. Mirrors
   *  agent-transcript-range's lazy-load shape. */
  | { type: 'goal-detail'; projectName: string; goalId: string }
  /** HUMAN-ONLY gate waive (goal-rubric-workflow interconnect): reachable
   *  only through the UI — the CLI has no waive flag. Appends a timeline
   *  event kind 'gate' with the reason and actor 'human/ui'. */
  | { type: 'goal-gate-waive'; projectName: string; goalId: string; phase: string; reason: string }
  | { type: 'bundle-refresh-plan'; projectName: string; workspaceId: string }
  | { type: 'bundle-refresh-apply'; projectName: string; workspaceId: string; submission: import('../../types/bundle-refresh.js').BundleRefreshSubmission }
  | { type: 'bundle-config-state'; projectName: string; workspaceId: string }
  | { type: 'bundle-config-apply'; projectName: string; workspaceId: string; submission: import('../../types/bundle-config.js').BundleConfigSubmission }
  | { type: 'review-request'; requestId: string; operation: import('../../types/review.js').ReviewOperation }
  | {
      type: 'events-request';
      workspacePath: string;
      filter?: import('../../types/events.js').WideEventFilter;
      limit?: number;
      sinceMs?: number;
    }
  | {
      type: 'agent-permission';
      target: AgentWorkspaceTargetPayload;
      agentSessionId: string;
      permissionId: string;
      response: 'allow' | 'deny';
    }
  | {
      type: 'agent-dialog-response';
      dialogId: string;
      dialogType: import('./agents/host-ui-bridge.js').HostUIDialogResponseType;
      value: import('./agents/host-ui-bridge.js').HostUIDialogResponseValue;
    }
  | { type: "kill-server" }
  | { type: "inbox" }
  | { type: "inbox-clear"; id?: string }  // Clear one or all
  | { type: "inbox-read"; id: string }    // Mark as read
  | { type: 'notification-config-get' }
  | { type: 'notification-config-update'; config: import('../../notifications/types.js').NotificationConfig }
  | { type: "version" }                   // Get server version info
  | { type: "status" };                   // Get server status (version + stats)

export type Response =
  | { type: "sessions"; sessions: Session[] }
  | {
      type: 'agent-state';
      workspaces: import('./agent-event-manager.js').WorkspaceAgentState[];
    }
  | {
      type: 'machine-snapshot';
      snapshot: import('./machine/protocol.js').MachineSnapshot;
    }
  | {
      type: 'agent-state-update';
      delta: import('./agent-event-manager.js').AgentStateUpdateDelta;
    }
  | {
      type: 'machine-event';
      event: import('./machine/protocol.js').MachineEvent;
    }
  | { type: 'agent-watch-started' }
  | { type: 'machine-watch-started' }
  | { type: 'agent-sessions'; sessions: AgentSessionSummaryPayload[] }
  | { type: 'agent-bool'; ok: boolean }
  | { type: 'agent-queued-message'; message: string | null }
  | { type: 'agent-staged'; stagedPath: string }
  | { type: 'agent-commands'; commands: Array<{ name: string; description: string; kind: 'file' | 'custom' | 'extension' }> }
  | { type: 'agent-transcript-range'; blocks: unknown[]; oldestCursor: string | null; hasMore: boolean }
  | { type: 'agent-control-info'; info: import('../../agents/agent-runtime-types.js').AgentControlInfo }
  | { type: 'agent-set-model'; ok: boolean }
  | { type: 'agent-auth-providers'; providers: Array<{ provider: string; hasAuth: boolean; accounts?: Array<{ id: number; type: string; label: string; disabled: boolean }> }> }
  | { type: 'agent-remove-account'; ok: boolean }
  | { type: 'agent-settings'; settings: Array<{ path: string; label: string; kind: 'boolean' | 'enum'; value: string | boolean | null; options?: string[] }> }
  | { type: 'agent-settings-schema'; schema: import('../../agents/agent-runtime-types.js').AgentSettingSchemaItem[] }
  | { type: 'agent-tools'; tools: import('../../agents/agent-runtime-types.js').AgentToolInfo[] }
  | { type: 'agent-list-agents'; agents: import('../../agents/agent-runtime-types.js').AgentDefinitionInfo[] }
  | { type: 'agent-history'; entries: import('../../agents/agent-runtime-types.js').AgentHistoryEntry[] }
  | { type: 'agent-tree'; nodes: import('../../agents/agent-runtime-types.js').AgentTreeNode[] }
  | { type: 'artifact-list'; entries: import('../../core/artifacts.js').ArtifactListEntry[] }
  | { type: 'artifact-read'; base64: string; size: number; truncated: boolean }
  | { type: 'artifact-write'; commit: string }
  | { type: 'project-artifacts-status'; repoPath: string; remote: string | null; branches: string[]; pointerCommitted?: boolean }
  | { type: 'project-artifacts-sync'; pushed: boolean; fastForwarded: boolean }
  | { type: 'project-artifacts-provision'; slug: string; url: string; created: boolean; blobsUploaded: number; collaboratorsCopied: number }
  | { type: 'serve-status'; status: { active: boolean; relayUrl?: string; relayStatus?: string; clients?: number; machineId?: string; startedAt?: number } }
  | { type: 'project-artifacts-rollup'; mergeCommit: string }
  | { type: 'report-problem'; path: string; issueUrl?: string; issueNumber?: number }
  | { type: 'artifact-share-mint'; url: string; tokenId: string; expiresAt: number }
  | { type: 'artifact-share-revoke'; revoked: boolean }
  | { type: 'artifact-share-list'; shares: import('./artifact-share.js').ShareLedgerEntry[] }
  | { type: 'favorites'; favorites: string[]; snapshotSkipped?: string[] }
  | { type: 'trigger-save'; trigger: import('../../core/triggers.js').TriggerRecord }
  | { type: 'trigger-run-now'; sessionId: string }
  | { type: 'repo-tree'; entries: import('../../core/git.js').RepoFileEntry[] }
  | { type: 'repo-read'; base64: string | null; size: number; truncated: boolean }
  | { type: 'repo-commit'; commit: string | null }
  | { type: 'repo-search'; hits: import('../../core/git.js').RepoSearchHit[]; truncated: boolean }
  | { type: 'agent-navigate'; ok: boolean; editorText?: string }
  | { type: 'workspace-editors'; editors: import('../../utils/open-editor.js').WorkspaceEditorOption[] }
  | { type: 'agent-file-suggestions'; suggestions: Array<{ path: string; isDirectory: boolean }> }
  | {
      type: 'agent-dialog-request';
      request: import('./agents/host-ui-bridge.js').HostUIDialogRequest;
    }
  | {
      type: 'agent-ui-event';
      event: import('./agents/host-ui-bridge.js').HostUIEvent;
    }
  | { type: 'attach-script-output'; requestId: string; phase: 'pre' | 'setup' | 'select'; data: string; done?: boolean; error?: string }
  | { type: 'attach-prepared'; requestId: string; session: Session; workspaceId?: string; viewOnly?: boolean }
  | { type: 'service-started'; workspaceId: string; processName: string; sessionId: string; sessionIds: string[] }
  | { type: 'service-stopped'; workspaceId: string; processName: string }
  | { type: 'github-repos'; repos: string[] }
  | { type: 'remote-branches'; projectName: string; branches: string[] }
  | { type: 'linear-issues'; projectName: string; issues: import('../../types/lifecycle.js').SessionLinearIssueSummary[] }
  | { type: 'project-created'; projectName: string; repository: string; baseBranch: string }
  | { type: 'project-prepared'; result: import('../../session/backend.js').PreparedProjectResult }
  | { type: 'project-cancelled'; projectName: string }
  | { type: 'workspace-created'; projectName: string; workspaceId: string; workspaceName: string; branchName: string }
  | { type: 'project-deleted'; projectName: string }
  | { type: 'workspace-delete-output'; requestId: string; data: string; done?: boolean; error?: string }
  | { type: 'workspace-deleted'; requestId: string; workspaceId: string }
  | { type: 'workspace-notes'; notes: import('../../types/workspace.js').WorkspaceNote[] }
  | { type: 'workspace-phase-preview'; preview: import('../../types/goals.js').WorkspacePhaseChangePreview }
  | { type: 'workspace-note'; note: import('../../types/workspace.js').WorkspaceNote }
  | { type: 'goal'; goal: import('../../types/goals.js').GoalRecord }
  | { type: 'goal-detail'; doc: import('../../types/goals.js').GoalDoc; validation: import('../../types/goals.js').GoalValidation }
  | { type: 'goal-chain'; chain: import('../../types/goals.js').GoalChain }
  | { type: 'goal-chains'; chains: import('../../types/goals.js').GoalChainSummary[] }
  | { type: 'goal-stack-status'; status: import('../../types/goals.js').ChainStackStatus }
  | { type: 'bundle-refresh-plan'; plan: import('../../types/bundle-refresh.js').BundleRefreshPlan }
  | { type: 'bundle-refresh-applied'; projectName: string; workspaceId: string }
  | { type: 'bundle-config-state'; state: import('../../types/bundle-config.js').BundleConfigState }
  | { type: 'bundle-config-applied'; projectName: string; workspaceId: string }
  | { type: 'review-response'; requestId: string; result?: import('../../types/review.js').ReviewResult; error?: { code: string; message: string } }
  | { type: 'events-list'; workspaceId: string; events: import('../../types/events.js').WideEvent[]; liveEventIds: string[]; savedEventFilters?: import('../../types/events.js').SavedEventFilter[] }
  | { type: "replays"; replays: import('./replay/types.js').ReplayInfo[] }
  | { type: "replay-snapshot"; snapshot: import('./replay/types.js').TerminalSnapshot }
  | { type: "replay-text"; text: string }
  | { type: "replay-markdown"; markdown: string }
  | { type: "session"; session: Session }
  | { type: "already-attached"; session: Session }
  | { type: "ok" }
  | { type: "error"; message: string; code?: string; processName?: string; portConflicts?: import('../processes/port-conflicts.js').PortConflictInfo[] }
  | { type: "inbox"; items: InboxItem[] }
  | { type: 'notification-config'; config: import('../../notifications/types.js').NotificationConfig }
  | { type: "version"; version: string; protocol: number; codeVersion: string | null }
  | { type: "status"; version: string; protocol: number; pid: number; uptime: number; sessions: number; attached: number; codeVersion: string | null };

export interface Session {
  id: string;
  name: string;
  socketPath: string;
  pid: number;
  attached: boolean;
  cwd: string;
  createdAt: number;
  exitCode?: number;  // undefined = running, number = exited
  processTitle?: string;  // Title set by running process (e.g., vim, npm run dev)
  terminalTitle?: string;
  lastAlertKind?: InboxItem['type'];
  lastAlertPreview?: string;
  lastAlertAt?: number;
  unreadAlertCount?: number;
  kind?: SessionKind;
  hidden?: boolean;
  metadata?: Record<string, string>;
}

// Inbox item - things that need attention
export interface InboxItem {
  id: string;
  sessionId: string;
  sessionName: string;
  type: 'bell' | 'exit' | 'title' | 'idle' | 'osc'
      | 'agent_permission' | 'agent_idle' | 'agent_error';
  timestamp: number;
  exitCode?: number;
  context: string;  // The actual message/output
  processTitle?: string;  // What process was running (e.g., "claude", "npm run dev")
  read: boolean;
  /** Present only for agent_* item types — carries routing metadata for the app layer */
  agentAction?: {
    workspaceId: string;
    agentSessionId: string;    // agent runtime session ID
    permissionId?: string;     // only for agent_permission
    permissionTitle?: string;
    messagePreview?: string;   // for agent_idle
  };
}

// ============================================================================
// Session Framed Protocol
// ============================================================================
//
// All session socket communication uses length-prefixed framing:
//   [type:1 byte][len:4 bytes BE][payload:len bytes]
//
// Frame types:
//   0x00 = PTY data (raw bytes, passthrough)
//   0x01 = CONTROL message (JSON)
//
// This replaces the old CTRL_MAGIC scanning approach which had collision
// issues with OSC 99 (Kitty notifications).

/** Frame types for the session protocol */
export const FrameType = {
  PTY: 0x00,      // Raw PTY data
  CONTROL: 0x01,  // JSON control message
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/** Session control messages (client → server) */
export type SessionCtrl =
  | { type: "attach-init"; cols: number; rows: number; clientType?: "cli" | "web" }
  | { type: "resize"; cols: number; rows: number }
  | { type: "detach" };

/** Session events (server → client) */
export type SessionEvent =
  | { type: "attached" }
  | {
      type: 'session-meta';
      sessionName: string;
      processTitle?: string;
      terminalTitle?: string;
      lastAlertKind?: InboxItem['type'];
      lastAlertPreview?: string;
      lastAlertAt?: number;
      unreadAlertCount?: number;
    }
  | { type: "exited"; code: number }
  | { type: "kicked" }
  | { type: "wide_event"; event: Record<string, unknown> };

/** A decoded frame from the session socket */
export interface SessionFrame {
  type: FrameTypeValue;
  payload: Buffer;
}

/** Result of parsing frames from a buffer */
export interface FrameParseResult {
  frames: SessionFrame[];
  remaining: Buffer;
}

// Frame header: 1 byte type + 4 bytes length
const FRAME_HEADER_LEN = 5;

// Maximum frame size (1MB) - security limit to prevent DoS
// Matches relay protocol limit for consistency across all transport paths
export const MAX_FRAME_SIZE = 1024 * 1024;

// Valid frame types for sanity checking (helps detect protocol desync)
const VALID_FRAME_TYPES = new Set([FrameType.PTY, FrameType.CONTROL]);

/**
 * Encode data into a frame
 * @param type - FrameType.PTY or FrameType.CONTROL
 * @param payload - Raw bytes to send
 */
export function encodeFrame(type: FrameTypeValue, payload: Buffer | Uint8Array): Buffer {
  const payloadBuf = Buffer.from(payload);
  const buf = Buffer.alloc(FRAME_HEADER_LEN + payloadBuf.length);
  buf.writeUInt8(type, 0);
  buf.writeUInt32BE(payloadBuf.length, 1);
  payloadBuf.copy(buf, FRAME_HEADER_LEN);
  return buf;
}

/**
 * Encode raw PTY data into a frame
 */
export function encodePTY(data: Buffer | Uint8Array): Buffer {
  return encodeFrame(FrameType.PTY, data);
}

/**
 * Encode a control message (SessionCtrl or SessionEvent) into a frame
 */
export function encodeControl(msg: SessionCtrl | SessionEvent): Buffer {
  const json = JSON.stringify(msg);
  return encodeFrame(FrameType.CONTROL, Buffer.from(json));
}

/**
 * Parse frames from a buffer (handles partial frames)
 *
 * @param buffer - Buffer containing one or more frames
 * @returns Parsed frames and any remaining bytes (incomplete frame)
 */
export function parseFrames(buffer: Buffer): FrameParseResult {
  const frames: SessionFrame[] = [];
  let offset = 0;

  while (offset + FRAME_HEADER_LEN <= buffer.length) {
    const type = buffer.readUInt8(offset) as FrameTypeValue;
    const length = buffer.readUInt32BE(offset + 1);

    // Security: Validate frame type (helps detect protocol desync)
    if (!VALID_FRAME_TYPES.has(type)) {
      throw new Error(`Invalid frame type 0x${type.toString(16).padStart(2, '0')} at offset ${offset} (possible protocol desync)`);
    }

    // Security: Reject oversized frames
    if (length > MAX_FRAME_SIZE) {
      throw new Error(`Frame size ${length} exceeds maximum ${MAX_FRAME_SIZE} (type=0x${type.toString(16).padStart(2, '0')}, offset=${offset})`);
    }

    const frameEnd = offset + FRAME_HEADER_LEN + length;
    if (frameEnd > buffer.length) {
      // Incomplete frame, need more data
      break;
    }

    // Copy payload data - subarray references become invalid when Bun reuses socket buffers
    const payload = Buffer.from(buffer.subarray(offset + FRAME_HEADER_LEN, frameEnd));
    frames.push({ type, payload });
    offset = frameEnd;
  }

  return {
    frames,
    // Copy remaining bytes - subarray references become invalid when Bun reuses socket buffers
    remaining: Buffer.from(buffer.subarray(offset)),
  };
}

/**
 * Decode a control message from a frame payload
 */
export function decodeControl(payload: Buffer): SessionCtrl | SessionEvent {
  return JSON.parse(payload.toString());
}
