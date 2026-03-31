#!/usr/bin/env bun
/**
 * tmux-lite CLI and API
 *
 * CLI Commands:
 *   tl new [name]     Create new session
 *   tl a|attach [id]  Attach to session
 *   tl ls|list        List sessions
 *   tl kill <id>      Kill a session
 *   tl kill-server    Stop the server
 *
 * API: Import and use the exported functions
 */

import { spawn } from "bun";
import { existsSync, readFileSync, unlinkSync } from "fs";
import { select } from "@inquirer/prompts";
import { createBufferedSocketWriter } from "../../utils/bun-socket-writer";
import {
  applyTmuxLiteSandboxEnvironment,
  getRouterSocket,
  getPidFile,
  PROTOCOL_VERSION,
  PACKAGE_VERSION,
  type Command,
  type Response,
  type AgentWorkspaceTargetPayload,
  type AgentSessionSummaryPayload,
  type Session,
  type SessionEvent,
  type InboxItem,
  type ReplayInfo,
  type ReplayStatus,
  type TerminalSnapshot,
  type SessionCreateHooks,
  encodeRouterMessage,
  decodeRouterMessages,
  encodeControl,
  encodePTY,
  parseFrames,
  decodeControl,
  FrameType,
} from "./protocol";

// Re-export types
export type { Session, InboxItem, Command, Response, ReplayInfo, ReplayStatus, TerminalSnapshot };

// Re-export constants
export { PROTOCOL_VERSION, PACKAGE_VERSION, getRouterSocket, getPidFile };

/** Status response from server */
export interface ServerStatus {
  version: string;
  protocol: number;
  pid: number;
  uptime: number;
  sessions: number;
  attached: number;
}

export interface AttachPrepareOptions {
  sessionId?: string;
  workspaceId?: string;
  sessionName?: string;
  scriptPolicy?: 'auto' | 'skip';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  viewOnly?: boolean;
  onRequestId?: (requestId: string) => void;
  onScriptOutput?: (event: Extract<Response, { type: 'attach-script-output' }>) => void;
}

// Terminal reset - RIS (Reset to Initial State) resets everything
const TERM_RESET = "\x1bc";

const SERVER_SCRIPT = `${import.meta.dir}/server.ts`;

function parseOptionValue(args: string[], optionName: string): { value?: string; consumedNextArg: boolean; invalid: boolean } {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === optionName) {
      const next = args[index + 1];
      if (!next || next.trim().length === 0 || next.startsWith("-")) {
        return { consumedNextArg: false, invalid: true };
      }
      return { value: next, consumedNextArg: true, invalid: false };
    }
    if (arg?.startsWith(`${optionName}=`)) {
      const value = arg.slice(optionName.length + 1);
      return { value, consumedNextArg: false, invalid: value.trim().length === 0 };
    }
  }
  return { consumedNextArg: false, invalid: false };
}

function stripOption(args: string[], optionName: string): string[] {
  const stripped: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === optionName) {
      if (parseOptionValue(args.slice(index, index + 2), optionName).consumedNextArg) {
        index += 1;
      }
      continue;
    }
    if (arg?.startsWith(`${optionName}=`)) {
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

function parseCliContext(rawArgs: string[]) {
  const isTestMode = rawArgs.includes("--test");
  const sandboxOption = parseOptionValue(rawArgs, "--sandbox");
  if (sandboxOption.invalid) {
    throw new Error("--sandbox requires a non-empty value");
  }
  const args = stripOption(rawArgs.filter(arg => arg !== "--test"), "--sandbox");
  return {
    args,
    cmd: args[0] || "list",
    isTestMode,
    sandboxName: sandboxOption.value,
  };
}

function initializeCliEnvironment(context: { sandboxName?: string; isTestMode: boolean }): void {
  if (context.sandboxName) {
    applyTmuxLiteSandboxEnvironment(context.sandboxName);
  }
  if (context.isTestMode) {
    applyTmuxLiteSandboxEnvironment("test", { preserveExplicit: true });
  }
}

const getServerCommand = (options: { testMode?: boolean } = {}): string[] => {
  // Detect if we're running as a compiled binary (not bun)
  const isCompiled = !process.execPath.endsWith('bun');
  const testMode = options.testMode === true;

  if (isCompiled) {
    // Use the binary with internal flag
    return testMode
      ? [process.execPath, '--internal-tmux-server', '--test']
      : [process.execPath, '--internal-tmux-server'];
  }

  // Dev mode: invoke the script directly. `bun run <file>` fans out into
  // multiple helper processes in development, which makes tmux-lite look like
  // several servers and complicates shutdown.
  return testMode
    ? ['bun', SERVER_SCRIPT, '--test']
    : ['bun', SERVER_SCRIPT];
};

// Check if we're already inside a tmux-lite session
export function isNested(): boolean {
  return !!process.env.TMUX_LITE;
}

function checkNested(): boolean {
  if (isNested()) {
    console.error("Error: Already inside tmux-lite session " + process.env.TMUX_LITE);
    console.error("Nested sessions are not supported. Detach first with Shift+Esc.");
    return true;
  }
  return false;
}

// Check if server is running
export async function isServerRunning(): Promise<boolean> {
  const routerSocket = getRouterSocket();
  if (!existsSync(routerSocket)) return false;
  try {
    await send({ type: "list" });
    return true;
  } catch {
    return false;
  }
}

// Start server if not running
let ensureServerPromise: Promise<void> | null = null;

async function refreshHostingAfterEnsure(): Promise<void> {
  const { refreshTmuxHosting } = await import('./hosting/supervisor.js');
  await refreshTmuxHosting().catch(() => undefined);
}

export async function ensureServer(): Promise<void> {
  if (ensureServerPromise) {
    return ensureServerPromise;
  }

  ensureServerPromise = (async () => {
    if (await isServerRunning()) {
      await send({ type: 'agent-state' });
      await refreshHostingAfterEnsure();
      return;
    }

    spawn({
      cmd: getServerCommand(),
      stdout: "ignore",
      stderr: "ignore",
      env: process.env as Record<string, string>,
    });

    for (let i = 0; i < 60; i++) {
      await Bun.sleep(100);
      if (await isServerRunning()) {
        await send({ type: 'agent-state' });
        await refreshHostingAfterEnsure();
        return;
      }
    }
    throw new Error("Failed to start tmux-lite server");
  })();

  try {
    await ensureServerPromise;
  } finally {
    ensureServerPromise = null;
  }
}

/**
 * Check if a process with given PID is running
 */
export function isProcessRunning(pid: number): boolean {
  try {
    // Signal 0 doesn't kill - just checks if process exists
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get server PID from PID file
 * Returns null if PID file doesn't exist or is invalid
 */
export function getServerPid(): number | null {
  const pidFile = getPidFile();
  if (!existsSync(pidFile)) return null;

  try {
    const content = readFileSync(pidFile, "utf-8").trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Clean up stale PID file if process is not running
 * Returns true if cleanup was needed
 */
export function cleanupStalePidFile(): boolean {
  const pid = getServerPid();
  if (pid === null) return false;

  if (!isProcessRunning(pid)) {
    // Process is dead, clean up stale files
    const pidFile = getPidFile();
    const routerSocket = getRouterSocket();
    try { unlinkSync(pidFile); } catch {}
    try { unlinkSync(routerSocket); } catch {}
    return true;
  }
  return false;
}

/**
 * Get server version info
 */
export async function getVersion(): Promise<{ version: string; protocol: number }> {
  await ensureServer();
  const res = await send({ type: "version" });
  if (res.type === "version") {
    return { version: res.version, protocol: res.protocol };
  }
  throw new Error("Unexpected response");
}

/**
 * Get server status (version + stats)
 */
export async function getStatus(): Promise<ServerStatus> {
  await ensureServer();
  const res = await send({ type: "status" });
  if (res.type === "status") {
    return {
      version: res.version,
      protocol: res.protocol,
      pid: res.pid,
      uptime: res.uptime,
      sessions: res.sessions,
      attached: res.attached,
    };
  }
  throw new Error("Unexpected response");
}

/**
 * Alias for killServer - stops the server daemon
 */
export const stopServer = killServer;

// Send command to server
export async function send(cmd: Command): Promise<Response> {
  return new Promise(async (resolve, reject) => {
    let buffer: Buffer = Buffer.alloc(0);
    let settled = false;
    let socketRef: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let socketWriter: ReturnType<typeof createBufferedSocketWriter> | null = null;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      socketRef?.end();
      reject(err);
    };

    try {
      const routerSocket = getRouterSocket();
      const socket = await Bun.connect({
        unix: routerSocket,
        socket: {
          drain() {
            socketWriter?.flush();
          },
          data(socket, data) {
            if (settled) return;
            buffer = Buffer.concat([buffer, Buffer.from(data)]);
            let decoded;
            try {
              decoded = decodeRouterMessages(buffer);
            } catch (err) {
              fail(err instanceof Error ? err : new Error("Invalid response"));
              return;
            }
            buffer = decoded.remaining as Buffer;
            if (decoded.messages.length > 0) {
              settled = true;
              resolve(decoded.messages[0] as Response);
              socket.end();
            }
          },
          close() {
            if (!settled) {
              fail(new Error("Connection closed before response"));
            }
          },
          error(_, e) { fail(e); },
          connectError(_, e) { fail(e); }
        }
      });
      socketRef = socket;
      socketWriter = createBufferedSocketWriter(socket);
      socketWriter.write(encodeRouterMessage(cmd));
    } catch (e) {
      fail(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export async function prepareAttachSession(options: AttachPrepareOptions): Promise<Extract<Response, { type: 'attach-prepared' }>> {
  await ensureServer();
  return new Promise((resolve, reject) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const requestId = crypto.randomUUID();
    options.onRequestId?.(requestId);
    let socketRef: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let writer: ReturnType<typeof createBufferedSocketWriter> | null = null;
    const cleanup = () => {
      try { writer?.flush(); } catch {}
      try { socketRef?.end(); } catch {}
    };

    void Bun.connect({
      unix: getRouterSocket(),
      socket: {
        open(socket) {
          socketRef = socket;
          writer = createBufferedSocketWriter(socket);
          writer.write(encodeRouterMessage({ type: 'attach-prepare', requestId, ...options }));
        },
        data(_socket, chunk) {
          if (settled) return;
          buffer = Buffer.concat([buffer, Buffer.from(chunk)] as Buffer[]);
          try {
            const decoded = decodeRouterMessages(buffer);
            buffer = decoded.remaining;
            for (const message of decoded.messages) {
              const response = message as Response;
              if (response.type === 'attach-script-output' && response.requestId === requestId) {
                options.onScriptOutput?.(response);
                continue;
              }
              if (response.type === 'attach-prepared' && response.requestId === requestId) {
                settled = true;
                cleanup();
                resolve(response);
                return;
              }
              if (response.type === 'error') {
                settled = true;
                cleanup();
                const error = Object.assign(new Error(response.message), response.code ? { code: response.code } : {});
                reject(error);
                return;
              }
            }
          } catch (error) {
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        error(_socket, error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        close() {
          if (settled) return;
          settled = true;
          reject(new Error('Router socket closed during attach prepare'));
        },
      },
    }).catch((error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export async function cancelPrepareAttachSession(requestId: string): Promise<void> {
  await ensureServer();
  const res = await send({ type: 'attach-cancel', requestId });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function sendTmuxReviewRequest(
  operation: import('../../types/review.js').ReviewOperation,
): Promise<Extract<Response, { type: 'review-response' }>> {
  await ensureServer();
  const requestId = crypto.randomUUID();
  const res = await send({ type: 'review-request', requestId, operation });
  if (res.type === 'review-response') return res;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function requestTmuxEvents(options: {
  workspacePath: string;
  filter?: import('../../types/events.js').WideEventFilter;
  limit?: number;
  sinceMs?: number;
}): Promise<Extract<Response, { type: 'events-list' }>> {
  await ensureServer();
  const res = await send({ type: 'events-request', ...options });
  if (res.type === 'events-list') return res;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function setTmuxWorkspacePhase(
  projectName: string,
  workspaceName: string,
  phase: import('../../types/config.js').WorkspacePhase,
): Promise<void> {
  const res = await send({ type: 'workspace-set-phase', projectName, workspaceName, phase });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function killTmuxSession(id: string): Promise<void> {
  const res = await send({ type: 'kill', id });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function getTmuxInbox(): Promise<Extract<Response, { type: 'inbox' }>> {
  const res = await send({ type: 'inbox' });
  if (res.type === 'inbox') return res;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function clearTmuxInbox(id?: string): Promise<void> {
  const res = await send({ type: 'inbox-clear', id });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function markTmuxInboxRead(id: string): Promise<void> {
  const res = await send({ type: 'inbox-read', id });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function getTmuxNotificationConfig(): Promise<Extract<Response, { type: 'notification-config' }>> {
  const res = await send({ type: 'notification-config-get' });
  if (res.type === 'notification-config') return res;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function updateTmuxNotificationConfig(
  config: import('../../notifications/types.js').NotificationConfig,
): Promise<Extract<Response, { type: 'notification-config' }>> {
  const res = await send({ type: 'notification-config-update', config });
  if (res.type === 'notification-config') return res;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function listTmuxGithubRepos(org?: string): Promise<string[]> {
  const res = await send({ type: 'github-repos', org });
  if (res.type === 'github-repos') return res.repos;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function listTmuxRemoteBranches(projectName: string): Promise<string[]> {
  const res = await send({ type: 'remote-branches', projectName });
  if (res.type === 'remote-branches') return res.branches;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function listTmuxLinearIssues(projectName: string): Promise<import('../../types/lifecycle.js').SessionLinearIssueSummary[]> {
  const res = await send({ type: 'linear-issues', projectName });
  if (res.type === 'linear-issues') return res.issues;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function createTmuxProject(params: { repository: string; projectName?: string; baseBranch?: string; setCurrent?: boolean }): Promise<void> {
  const res = await send({ type: 'project-create', ...params });
  if (res.type === 'project-created') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function prepareTmuxProject(params: { repository: string; projectName?: string; baseBranch?: string; setCurrent?: boolean }): Promise<import('../../session/backend.js').PreparedProjectResult> {
  const res = await send({ type: 'project-prepare', ...params });
  if (res.type === 'project-prepared') return res.result;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function finalizeTmuxProject(params: { projectName: string; repository: string; baseBranch: string; bundle?: import('../../types/bundle.js').SpacesBundle; inputValues?: Record<string, string>; secretValues?: Record<string, string>; confirmResults?: Record<string, import('../../types/bundle.js').ConfirmStepResult>; setCurrent?: boolean }): Promise<void> {
  const res = await send({ type: 'project-finalize', ...params });
  if (res.type === 'project-created') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function cancelTmuxProjectCreation(projectName: string): Promise<void> {
  const res = await send({ type: 'project-cancel', projectName });
  if (res.type === 'project-cancelled') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function createTmuxWorkspace(params: { projectName: string; workspaceName: string; branchName?: string; baseBranch?: string; workspaceSource?: import('../../types/lifecycle.js').WorkspaceSource; linearIssue?: import('../../types/lifecycle.js').SessionLinearIssueSummary }): Promise<void> {
  const res = await send({ type: 'workspace-create', ...params });
  if (res.type === 'workspace-created') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function deleteTmuxProject(projectName: string): Promise<void> {
  const res = await send({ type: 'project-delete', projectName });
  if (res.type === 'project-deleted') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function getTmuxBundleRefreshPlan(projectName: string, workspaceId: string): Promise<import('../../types/bundle-refresh.js').BundleRefreshPlan> {
  const res = await send({ type: 'bundle-refresh-plan', projectName, workspaceId });
  if (res.type === 'bundle-refresh-plan') return res.plan;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function applyTmuxBundleRefresh(projectName: string, workspaceId: string, submission: import('../../types/bundle-refresh.js').BundleRefreshSubmission): Promise<void> {
  const res = await send({ type: 'bundle-refresh-apply', projectName, workspaceId, submission });
  if (res.type === 'bundle-refresh-applied') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function getTmuxBundleConfigState(projectName: string, workspaceId: string): Promise<import('../../types/bundle-config.js').BundleConfigState> {
  const res = await send({ type: 'bundle-config-state', projectName, workspaceId });
  if (res.type === 'bundle-config-state') return res.state;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function applyTmuxBundleConfig(projectName: string, workspaceId: string, submission: import('../../types/bundle-config.js').BundleConfigSubmission): Promise<void> {
  const res = await send({ type: 'bundle-config-apply', projectName, workspaceId, submission });
  if (res.type === 'bundle-config-applied') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function deleteTmuxWorkspace(options: {
  projectName: string;
  workspaceId: string;
  scriptPolicy?: 'auto' | 'skip';
  onScriptOutput?: (event: Extract<Response, { type: 'workspace-delete-output' }>) => void;
}): Promise<void> {
  await ensureServer();
  return new Promise((resolve, reject) => {
    let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let settled = false;
    const requestId = crypto.randomUUID();
    let socketRef: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let writer: ReturnType<typeof createBufferedSocketWriter> | null = null;
    const cleanup = () => {
      try { writer?.flush(); } catch {}
      try { socketRef?.end(); } catch {}
    };
    void Bun.connect({
      unix: getRouterSocket(),
      socket: {
        open(socket) {
          socketRef = socket;
          writer = createBufferedSocketWriter(socket);
          writer.write(encodeRouterMessage({ type: 'workspace-delete', requestId, projectName: options.projectName, workspaceId: options.workspaceId, scriptPolicy: options.scriptPolicy }));
        },
        data(_socket, chunk) {
          if (settled) return;
          buffer = Buffer.concat([buffer, Buffer.from(chunk)] as Buffer[]);
          try {
            const decoded = decodeRouterMessages(buffer);
            buffer = decoded.remaining;
            for (const message of decoded.messages) {
              const response = message as Response;
              if (response.type === 'workspace-delete-output' && response.requestId === requestId) {
                options.onScriptOutput?.(response);
                continue;
              }
              if (response.type === 'workspace-deleted' && response.requestId === requestId) {
                settled = true;
                cleanup();
                resolve();
                return;
              }
              if (response.type === 'error') {
                settled = true;
                cleanup();
                reject(new Error(response.message));
                return;
              }
            }
          } catch (error) {
            settled = true;
            cleanup();
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        },
        error(_socket, error) {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
        close() {
          if (settled) return;
          settled = true;
          reject(new Error('Router socket closed during workspace delete'));
        },
      },
    }).catch((error) => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

// === API convenience functions ===

export async function listSessionsFromRunningServer(): Promise<Session[]> {
  const res = await send({ type: "list" });
  if (res.type === "sessions") return res.sessions;
  throw new Error("Unexpected response");
}

export async function listSessions(): Promise<Session[]> {
  await ensureServer();
  return listSessionsFromRunningServer();
}

export async function listReplays(options: {
  workspaceId?: string;
  sessionId?: string;
  status?: ReplayStatus[];
} = {}): Promise<ReplayInfo[]> {
  await ensureServer();
  const res = await send({ type: "list-replays", ...options });
  if (res.type === "replays") return res.replays;
  if (res.type === "error") throw new Error(res.message);
  throw new Error("Unexpected response");
}

export async function getReplaySnapshot(
  replayId: string,
  options: {
    atMs?: number;
    scrollbackLines?: number;
  } = {}
): Promise<TerminalSnapshot> {
  await ensureServer();
  const res = await send({ type: "replay-snapshot", replayId, ...options });
  if (res.type === "replay-snapshot") return res.snapshot;
  if (res.type === "error") throw new Error(res.message);
  throw new Error("Unexpected response");
}

export async function getReplayText(
  replayId: string,
  options: {
    atMs?: number;
    scrollbackLines?: number;
    includeScrollback?: boolean;
    trimTrailingBlankRows?: boolean;
  } = {}
): Promise<string> {
  await ensureServer();
  const res = await send({ type: "replay-text", replayId, ...options });
  if (res.type === "replay-text") return res.text;
  if (res.type === "error") throw new Error(res.message);
  throw new Error("Unexpected response");
}

export async function getReplayMarkdown(
  replayId: string,
  options: {
    atMs?: number;
    scrollbackLines?: number;
    includeScrollback?: boolean;
    trimTrailingBlankRows?: boolean;
  } = {}
): Promise<string> {
  await ensureServer();
  const res = await send({ type: "replay-markdown", replayId, ...options });
  if (res.type === "replay-markdown") return res.markdown;
  if (res.type === "error") throw new Error(res.message);
  throw new Error("Unexpected response");
}

export async function createCheckpoint(id: string): Promise<void> {
  await ensureServer();
  const res = await send({ type: "create-checkpoint", id });
  if (res.type === "error") throw new Error(res.message);
}

export async function createSession(
  name: string,
  cwd: string,
  options?: {
    hooks?: SessionCreateHooks;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    kind?: import('./protocol.js').SessionKind;
    hidden?: boolean;
    recordReplay?: boolean;
    metadata?: Record<string, string>;
  }
): Promise<Session> {
  await ensureServer();
  const res = await send({
    type: "new",
    name,
    cwd,
    hooks: options?.hooks,
    command: options?.command,
    args: options?.args,
    env: options?.env,
    kind: options?.kind,
    hidden: options?.hidden,
    recordReplay: options?.recordReplay,
    metadata: options?.metadata,
  });
  if (res.type === "session") return res.session;
  if (res.type === "error") throw new Error(res.message);
  throw new Error("Unexpected response");
}

export async function createVirtualSession(
  name: string,
  cwd: string,
  options?: {
    kind?: import('./protocol.js').SessionKind;
    hidden?: boolean;
    metadata?: Record<string, string>;
  }
): Promise<Session> {
  await ensureServer();
  const res = await send({
    type: 'new-virtual',
    name,
    cwd,
    kind: options?.kind,
    hidden: options?.hidden,
    metadata: options?.metadata,
  });
  if (res.type === 'session') return res.session;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function killSession(id: string): Promise<void> {
  await ensureServer();
  const res = await send({ type: "kill", id });
  if (res.type === "error") throw new Error(res.message);
}

export async function getAgentState(): Promise<import('./agent-event-manager.js').WorkspaceAgentState[]> {
  await ensureServer();
  const res = await send({ type: 'agent-state' });
  if (res.type === 'agent-state') return res.workspaces;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}


export async function getMachineSnapshot(): Promise<import('./machine/protocol.js').MachineSnapshot> {
  await ensureServer();
  const res = await send({ type: 'machine-snapshot' });
  if (res.type === 'machine-snapshot') return res.snapshot;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function setWorkspacePhase(
  projectName: string,
  workspaceName: string,
  phase: import('../../types/config.js').WorkspacePhase,
): Promise<void> {
  await ensureServer();
  const res = await send({ type: 'workspace-set-phase', projectName, workspaceName, phase });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function listAgentSessions(
  target: AgentWorkspaceTargetPayload,
  mode: 'known' | 'live' = 'live',
): Promise<AgentSessionSummaryPayload[]> {
  await ensureServer();
  const res = await send({ type: 'agent-sessions', target, mode });
  if (res.type === 'agent-sessions') return res.sessions;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function createAgentSession(
  target: AgentWorkspaceTargetPayload,
  title?: string,
): Promise<AgentSessionSummaryPayload[]> {
  await ensureServer();
  const res = await send({ type: 'agent-create', target, title });
  if (res.type === 'agent-sessions') return res.sessions;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function abortAgentSession(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
): Promise<boolean> {
  await ensureServer();
  const res = await send({ type: 'agent-abort', target, agentSessionId });
  if (res.type === 'agent-bool') return res.ok;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function closeAgentSession(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
): Promise<AgentSessionSummaryPayload[]> {
  await ensureServer();
  const res = await send({ type: 'agent-close', target, agentSessionId });
  if (res.type === 'agent-sessions') return res.sessions;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function archiveAgentSession(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
): Promise<AgentSessionSummaryPayload[]> {
  await ensureServer();
  const res = await send({ type: 'agent-archive', target, agentSessionId });
  if (res.type === 'agent-sessions') return res.sessions;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function restoreAgentSession(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
): Promise<AgentSessionSummaryPayload[]> {
  await ensureServer();
  const res = await send({ type: 'agent-restore', target, agentSessionId });
  if (res.type === 'agent-sessions') return res.sessions;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function attachAgentSession(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
): Promise<Session> {
  await ensureServer();
  const res = await send({ type: 'agent-attach', target, agentSessionId });
  if (res.type === 'session') return res.session;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function promptAgentSession(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
  text: string,
): Promise<void> {
  await ensureServer();
  const res = await send({ type: 'agent-prompt', target, agentSessionId, text });
  if (res.type === 'ok') return;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function respondToAgentPermission(
  target: AgentWorkspaceTargetPayload,
  agentSessionId: string,
  permissionId: string,
  response: 'allow' | 'deny',
): Promise<boolean> {
  await ensureServer();
  const res = await send({ type: 'agent-permission', target, agentSessionId, permissionId, response });
  if (res.type === 'agent-bool') return res.ok;
  if (res.type === 'error') throw new Error(res.message);
  throw new Error('Unexpected response');
}

export async function watchAgentState(handlers: {
  onSnapshot?: (workspaces: import('./agent-event-manager.js').WorkspaceAgentState[]) => void;
  onUpdate?: (delta: import('./agent-event-manager.js').AgentStateUpdateDelta) => void;
  onDialogRequest?: (request: import('./agents/host-ui-bridge.js').HostUIDialogRequest) => void;
  onUIEvent?: (event: import('./agents/host-ui-bridge.js').HostUIEvent) => void;
  onError?: (error: Error) => void;
}): Promise<() => void> {
  await ensureServer();
  return new Promise<() => void>((resolve, reject) => {
    let started = false;
    let closedByCaller = false;
    let socketRef: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let buffer: Buffer = Buffer.alloc(0);

    const fail = (error: Error) => {
      if (!started) {
        try { socketRef?.end(); } catch {}
        reject(error);
        return;
      }
      handlers.onError?.(error);
    };

    try {
      void Bun.connect({
        unix: getRouterSocket(),
        socket: {
          open(sock) {
            const writer = createBufferedSocketWriter(sock);
            writer.write(encodeRouterMessage({ type: 'agent-watch' }));
          },
          data(sock, data) {
            buffer = Buffer.concat([buffer, Buffer.from(data)]);
            let decoded;
            try {
              decoded = decodeRouterMessages(buffer);
            } catch (error) {
              fail(error instanceof Error ? error : new Error('Invalid response'));
              return;
            }
            buffer = decoded.remaining as Buffer;
            for (const message of decoded.messages) {
              if (message.type === 'agent-watch-started') {
                if (!started) {
                  started = true;
                  resolve(() => {
                    closedByCaller = true;
                    try { sock.end(); } catch {}
                  });
                }
                continue;
              }
              if (message.type === 'agent-state' && 'workspaces' in message) {
                handlers.onSnapshot?.(message.workspaces);
                continue;
              }
              if (message.type === 'agent-state-update') {
                handlers.onUpdate?.(message.delta);
                continue;
              }
              if (message.type === 'agent-dialog-request') {
                handlers.onDialogRequest?.(message.request);
                continue;
              }
              if (message.type === 'agent-ui-event') {
                handlers.onUIEvent?.(message.event);
                continue;
              }
              if (message.type === 'error') {
                fail(new Error(message.message));
                return;
              }
            }
          },
          close() {
            if (!started) {
              reject(new Error('Connection closed before watch started'));
              return;
            }
            if (!closedByCaller) {
              handlers.onError?.(new Error('Agent watch connection closed'));
            }
          },
          error(_, error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          },
          connectError(_, error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        },
      }).then((socket) => {
        socketRef = socket;
      }).catch((error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function watchMachineEvents(handlers: {
  onSnapshot?: (snapshot: import('./machine/protocol.js').MachineSnapshot) => void;
  onEvent?: (event: import('./machine/protocol.js').MachineEvent) => void;
  onError?: (error: Error) => void;
}): Promise<() => void> {
  await ensureServer();
  return new Promise<() => void>((resolve, reject) => {
    let started = false;
    let closedByCaller = false;
    let socketRef: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let buffer: Buffer = Buffer.alloc(0);

    const fail = (error: Error) => {
      if (!started) {
        try { socketRef?.end(); } catch {}
        reject(error);
        return;
      }
      handlers.onError?.(error);
    };

    try {
      void Bun.connect({
        unix: getRouterSocket(),
        socket: {
          open(sock) {
            const writer = createBufferedSocketWriter(sock);
            writer.write(encodeRouterMessage({ type: 'machine-watch' }));
          },
          data(sock, data) {
            buffer = Buffer.concat([buffer, Buffer.from(data)]);
            let decoded;
            try {
              decoded = decodeRouterMessages(buffer);
            } catch (error) {
              fail(error instanceof Error ? error : new Error('Invalid response'));
              return;
            }
            buffer = decoded.remaining as Buffer;
            for (const message of decoded.messages) {
              if (message.type === 'machine-watch-started') {
                if (!started) {
                  started = true;
                  resolve(() => {
                    closedByCaller = true;
                    try { sock.end(); } catch {}
                  });
                }
                continue;
              }
              if (message.type === 'machine-snapshot' && 'snapshot' in message) {
                handlers.onSnapshot?.(message.snapshot);
                continue;
              }
              if (message.type === 'machine-event' && 'event' in message) {
                handlers.onEvent?.(message.event);
                continue;
              }
              if (message.type === 'error') {
                fail(new Error(message.message));
                return;
              }
            }
          },
          close() {
            if (!started) {
              reject(new Error('Connection closed before watch started'));
              return;
            }
            if (!closedByCaller) {
              handlers.onError?.(new Error('Machine watch connection closed'));
            }
          },
          error(_, error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          },
          connectError(_, error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          },
        },
      }).then((sock) => {
        socketRef = sock;
      }).catch((error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function killServer(): Promise<void> {
  if (!(await isServerRunning())) return;
  await send({ type: "kill-server" });
}

export async function getInbox(): Promise<InboxItem[]> {
  await ensureServer();
  const res = await send({ type: "inbox" });
  if (res.type === "inbox") return res.items;
  throw new Error("Unexpected response");
}

/**
 * Get count of unread inbox items, bounded by active sessions.
 * Returns the number of unique active sessions that have unread notifications,
 * not the total number of unread items. This prevents the count from growing
 * unboundedly and caps it at one per active session.
 */
export async function getUnreadCount(): Promise<number> {
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
  
  return activeSessionsWithUnread.size;
}

export async function clearInbox(id?: string): Promise<void> {
  await ensureServer();
  await send({ type: "inbox-clear", id });
}

export async function markInboxRead(id: string): Promise<void> {
  await ensureServer();
  await send({ type: "inbox-read", id });
}

// Format session for display
function formatSession(s: Session): string {
  const age = Math.floor((Date.now() - s.createdAt) / 1000);
  const ageStr = age < 60 ? `${age}s` : age < 3600 ? `${Math.floor(age/60)}m` : `${Math.floor(age/3600)}h`;
  const status = s.attached ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
  const title = s.processTitle ? ` \x1b[33m[${s.processTitle}]\x1b[0m` : "";
  return `${status} ${s.id}: ${s.name} (${ageStr})${title} ${s.cwd}`;
}

// Shift+Esc sequences (different terminals send different formats)
const SHIFT_ESC_CSI_U = Buffer.from([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x32, 0x75]); // ESC [ 27;2u
const SHIFT_ESC_XTERM = Buffer.from([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x32, 0x3b, 0x32, 0x37, 0x7e]); // ESC [ 27;2;27 ~
const BRACKETED_PASTE_START = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]); // ESC [ 200 ~
const BRACKETED_PASTE_END = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]); // ESC [ 201 ~

export type AttachResult =
  | { type: "detached" }
  | { type: "exited"; code: number }
  | { type: "kicked" }
  | { type: "error"; message: string };

/**
 * Attach to a session interactively.
 * Takes over stdin/stdout. Returns when session ends or user detaches.
 * @param session Session to attach to
 * @param quiet If true, don't print attach/detach messages
 */
export async function attach(session: Session, quiet: boolean = false): Promise<AttachResult> {
  if (!quiet) {
    console.log(`Attaching to ${session.name}...`);
    console.log("Shift+Esc to detach\n");
  }

  return new Promise(async (resolve) => {
    let buffer = Buffer.alloc(0);
    let pendingSeq = Buffer.alloc(0);
    let inBracketedPaste = false;
    let resolved = false;
    let stdinListener: ((chunk: Buffer) => void) | null = null;
    let socket: Awaited<ReturnType<typeof Bun.connect>> | null = null;
    let socketWriter: ReturnType<typeof createBufferedSocketWriter> | null = null;
    let onResize: (() => void) | null = null;
    let lastSize = { cols: 0, rows: 0 };

    const cleanup = (result: AttachResult) => {
      if (resolved) return;
      resolved = true;
      if (stdinListener) {
        process.stdin.removeListener("data", stdinListener);
      }
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write(TERM_RESET);
      if (onResize) {
        process.removeListener("SIGWINCH", onResize);
      }
      socket = null;
      socketWriter = null;
      if (!quiet) {
        if (result.type === "detached") console.log("\n[detached]");
        else if (result.type === "exited") console.log(`\n[exited: ${result.code}]`);
        else if (result.type === "kicked") console.log("\n[kicked - another client took over]");
        else if (result.type === "error") console.error("\n[error]", result.message);
      }
      resolve(result);
    };

    const getTermSize = () => {
      let cols = process.stdout.columns || 0;
      let rows = process.stdout.rows || 0;
      if (cols <= 0 || rows <= 0) {
        const size = (process.stdout as { getWindowSize?: () => number[] }).getWindowSize?.();
        if (Array.isArray(size) && size.length >= 2) {
          cols = size[0];
          rows = size[1];
        }
      }
      return {
        cols: cols > 0 ? cols : 80,
        rows: rows > 0 ? rows : 24,
      };
    };

    const sendResize = (force = false) => {
      if (!socket) return;
      const { cols, rows } = getTermSize();
      if (!force && cols === lastSize.cols && rows === lastSize.rows) {
        return;
      }
      lastSize = { cols, rows };
      const frame = encodeControl({ type: "resize", cols, rows });
      if (socketWriter) socketWriter.write(frame);
      else socket.write(frame);
    };

    const sendAttachInit = () => {
      if (!socket) return;
      const { cols, rows } = getTermSize();
      const frame = encodeControl({ type: "attach-init", cols, rows, clientType: "cli" });
      if (socketWriter) socketWriter.write(frame);
      else socket.write(frame);
    };

    socket = await Bun.connect({
      unix: session.socketPath,
      socket: {
        drain() {
          socketWriter?.flush();
        },
        data(_socket, data) {
          let buf = Buffer.from(data);

          if (buffer.length > 0) {
            buf = Buffer.concat([buffer, buf]);
          }

          // Parse frames from the buffer
          let frames;
          let remaining;
          try {
            const result = parseFrames(buf);
            frames = result.frames;
            remaining = result.remaining;
          } catch (err) {
            // Protocol error - likely desync or corrupted data
            const msg = err instanceof Error ? err.message : 'Frame parse error';
            console.error(`[attach] Frame parse error: ${msg}`);
            cleanup({ type: "error", message: msg });
            return;
          }
          buffer = Buffer.from(remaining);

          for (const frame of frames) {
            if (frame.type === FrameType.CONTROL) {
              const event = decodeControl(frame.payload) as SessionEvent;

              if (event.type === "attached") {
                // Send a single resize to ensure proper dimensions
                sendResize(true);
              } else if (event.type === "exited") {
                cleanup({ type: "exited", code: event.code });
                return;
              } else if (event.type === "kicked") {
                cleanup({ type: "kicked" });
                return;
              }
            } else if (frame.type === FrameType.PTY) {
              process.stdout.write(frame.payload);
            }
          }
        },

        close() {
          cleanup({ type: "detached" });
        },

        error(_, e) {
          cleanup({ type: "error", message: e.message });
        }
      }
    });
    socketWriter = createBufferedSocketWriter(socket);

    // Initial resize
    sendAttachInit();
    sendResize(true);

    onResize = () => {
      sendResize();
    };
    process.on("SIGWINCH", onResize);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    // Forward stdin with Shift+Esc detection
    stdinListener = (chunk: Buffer) => {
      const combined = pendingSeq.length > 0 ? Buffer.concat([pendingSeq, chunk]) : chunk;
      pendingSeq = Buffer.alloc(0);
      const out: Buffer[] = [];
      let offset = 0;

      const flushOut = () => {
        if (out.length > 0 && socket) {
          const frame = encodePTY(Buffer.concat(out));
          if (socketWriter) socketWriter.write(frame);
          else socket.write(frame);
          out.length = 0;
        }
      };

      const getSequences = () => (
        inBracketedPaste
          ? [BRACKETED_PASTE_START, BRACKETED_PASTE_END]
          : [BRACKETED_PASTE_START, BRACKETED_PASTE_END, SHIFT_ESC_CSI_U, SHIFT_ESC_XTERM]
      );

      while (offset < combined.length) {
        if (combined[offset] !== 0x1b) {
          const nextEsc = combined.indexOf(0x1b, offset + 1);
          if (nextEsc === -1) {
            out.push(combined.subarray(offset));
            offset = combined.length;
          } else {
            out.push(combined.subarray(offset, nextEsc));
            offset = nextEsc;
          }
          continue;
        }

        const sequences = getSequences();
        let matched: Buffer | null = null;
        for (const seq of sequences) {
          if (combined.length - offset >= seq.length &&
              combined.subarray(offset, offset + seq.length).equals(seq)) {
            matched = seq;
            break;
          }
        }

        if (matched) {
          if (matched === SHIFT_ESC_CSI_U || matched === SHIFT_ESC_XTERM) {
            flushOut();
            if (socket) {
              const frame = encodeControl({ type: "detach" });
              if (socketWriter) socketWriter.write(frame);
              else socket.write(frame);
            }
            cleanup({ type: "detached" });
            return;
          }

          out.push(combined.subarray(offset, offset + matched.length));
          if (matched === BRACKETED_PASTE_START) {
            inBracketedPaste = true;
          } else if (matched === BRACKETED_PASTE_END) {
            inBracketedPaste = false;
          }
          offset += matched.length;
          continue;
        }

        let possiblePrefix = false;
        for (const seq of sequences) {
          const remaining = combined.length - offset;
          if (remaining < seq.length &&
              seq.subarray(0, remaining).equals(combined.subarray(offset))) {
            possiblePrefix = true;
            break;
          }
        }

        if (possiblePrefix) {
          pendingSeq = Buffer.from(combined.subarray(offset));
          break;
        }

        out.push(combined.subarray(offset, offset + 1));
        offset += 1;
      }

      flushOut();
    };

    process.stdin.on("data", stdinListener);
  });
}

// Handle attach result and exit with appropriate code
function handleAttachResult(result: AttachResult): void {
  if (result.type === "exited") {
    process.exit(result.code);
  } else if (result.type === "error") {
    process.exit(1);
  }
  // detached and kicked exit cleanly
  process.exit(0);
}

// Main
async function main() {
  const context = parseCliContext(process.argv.slice(2));
  initializeCliEnvironment(context);
  const { args, cmd, isTestMode } = context;

  // Start server if not running
  if (!(await isServerRunning())) {
    if (cmd === "kill-server") {
      console.log("Server not running");
      return;
    }
    console.log("Starting server...");
    spawn({
      cmd: getServerCommand({ testMode: isTestMode }),
      // Use "ignore" so server doesn't inherit CLI's stdout/stderr
      // This allows CLI to exit cleanly when piped
      stdout: "ignore",
      stderr: "ignore",
      env: process.env as Record<string, string>,
    });
    await Bun.sleep(300);
    if (!(await isServerRunning())) {
      console.error("Failed to start server");
      process.exit(1);
    }
  }

  switch (cmd) {
    case "new": {
      if (checkNested()) process.exit(1);
      const name = args[1];
      const res = await send({ type: "new", name, cwd: process.cwd() });
      if (res.type === "session") {
        const result = await attach(res.session);
        handleAttachResult(result);
      } else if (res.type === "error") {
        console.error("Error:", res.message);
      }
      break;
    }

    case "a":
    case "attach": {
      if (checkNested()) process.exit(1);
      const id = args[1];
      if (id) {
        const res = await send({ type: "attach", id, force: args.includes("-f") });
        if (res.type === "session") {
          const result = await attach(res.session);
          handleAttachResult(result);
        } else if (res.type === "already-attached") {
          console.log(`Session ${id} is attached elsewhere.\n`);
          const choice = await select({
            message: "What to do?",
            choices: [
              { value: "force", name: "Take over" },
              { value: "cancel", name: "Cancel" },
            ]
          });
          if (choice === "force") {
            const res2 = await send({ type: "attach", id, force: true });
            if (res2.type === "session") {
              const result = await attach(res2.session);
              handleAttachResult(result);
            }
          }
        } else if (res.type === "error") {
          console.error("Error:", res.message);
        }
      } else {
        // No ID - show picker
        const res = await send({ type: "list" });
        if (res.type === "sessions") {
          if (res.sessions.length === 0) {
            console.log("No sessions. Create with: tl new");
          } else {
            const choice = await select({
              message: "Select session:",
              choices: res.sessions.map(s => ({
                value: s.id,
                name: formatSession(s)
              }))
            });
            const res2 = await send({ type: "attach", id: choice });
            if (res2.type === "session") {
              const result = await attach(res2.session);
              handleAttachResult(result);
            } else if (res2.type === "already-attached") {
              const force = await select({
                message: "Session attached. Take over?",
                choices: [
                  { value: true, name: "Yes" },
                  { value: false, name: "No" },
                ]
              });
              if (force) {
                const res3 = await send({ type: "attach", id: choice, force: true });
                if (res3.type === "session") {
                  const result = await attach(res3.session);
                  handleAttachResult(result);
                }
              }
            }
          }
        }
      }
      break;
    }

    case "ls":
    case "list": {
      const res = await send({ type: "list" });
      if (res.type === "sessions") {
        if (res.sessions.length === 0) {
          console.log("No sessions");
        } else {
          console.log("Sessions:");
          for (const s of res.sessions) {
            console.log("  " + formatSession(s));
          }
        }
      }
      break;
    }

    case "kill": {
      if (checkNested()) process.exit(1);
      const id = args[1];
      if (!id) {
        console.error("Usage: tl kill <id>");
        process.exit(1);
      }
      const res = await send({ type: "kill", id });
      if (res.type === "ok") {
        console.log(`Killed ${id}`);
      } else if (res.type === "error") {
        console.error("Error:", res.message);
      }
      break;
    }

    case "kill-server": {
      if (checkNested()) process.exit(1);
      await send({ type: "kill-server" });
      console.log("Server stopped");
      break;
    }

    case "inbox": {
      const res = await send({ type: "inbox" });
      if (res.type === "inbox") {
        if (res.items.length === 0) {
          console.log("Inbox empty");
        } else {
          console.log("Inbox:");
          for (const item of res.items) {
            const icon = item.type === 'exit'
              ? (item.exitCode === 0 ? '✓' : '✖')
              : '🔔';
            const status = item.read ? '' : ' (unread)';
            const time = new Date(item.timestamp).toLocaleTimeString();
            console.log(`  ${icon} [${time}] ${item.sessionName}${status}`);
            // Indent context lines
            const lines = item.context.split('\n').slice(0, 3);
            for (const line of lines) {
              console.log(`      ${line}`);
            }
          }
        }
      }
      break;
    }

    case "inbox-clear": {
      const id = args[1];
      await send({ type: "inbox-clear", id });
      console.log(id ? `Cleared inbox item ${id}` : "Inbox cleared");
      break;
    }

    default:
      console.log(`
tmux-lite

Commands:
  tl new [name]     Create session
  tl attach [id]    Attach (picker if no id)
  tl list           List sessions
  tl kill <id>      Kill session
  tl kill-server    Stop server
  tl inbox          Show inbox (bells, exits)
  tl inbox-clear    Clear inbox

In session:
  Shift+Esc         Detach
`);
  }
}

// Commands that are non-interactive and should exit immediately after completion
const NON_INTERACTIVE_COMMANDS = new Set([
  "list", "ls", "kill", "kill-server", "inbox", "inbox-clear", "status", "version"
]);

// Only run CLI when executed directly, not when imported as a module
if (import.meta.main) {
  main()
    .then(() => {
      const { cmd } = parseCliContext(process.argv.slice(2));
      // Force exit after non-interactive commands complete
      // Some socket references may keep the event loop alive otherwise
      if (NON_INTERACTIVE_COMMANDS.has(cmd)) {
        process.exit(0);
      }
    })
    .catch(e => {
      console.error(e.message);
      process.exit(1);
    });
}
