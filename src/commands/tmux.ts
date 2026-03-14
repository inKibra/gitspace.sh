/**
 * tmux-lite daemon management commands
 *
 * Commands:
 *   gssh machine tmux start       - Start the tmux-lite server daemon
 *   gssh machine tmux stop        - Stop the tmux-lite server daemon
 *   gssh machine tmux status      - Show server status
 *   gssh machine tmux list        - List sessions
 *   gssh machine tmux new [name]  - Create and attach to a new session
 *   gssh machine tmux attach <id> - Attach to a session
 *   gssh machine tmux kill <id>   - Kill a session
 */

import chalk from "chalk";
import { logger } from "../utils/logger.js";
import {
  ensureServer,
  isServerRunning,
  getServerPid,
  isProcessRunning,
  cleanupStalePidFile,
  getStatus,
  killServer,
  listSessions,
  createSession,
  killSession,
  attach,
  isNested,
  getRouterSocket,
  getPidFile,
  PACKAGE_VERSION,
  type Session,
} from "../lib/tmux-lite/cli.js";
import { applyTmuxLiteSandboxEnvironment } from '../lib/tmux-lite/protocol.js';
import {
  listReplaysOffline,
  resolveReplayOffline,
  getReplayTextOffline,
  screenshotReplayOffline,
  dismissReplayOffline,
  undismissReplayOffline,
  deleteReplayOffline,
  type ReplayInfo,
} from '../lib/tmux-lite/replay/service.js';

interface TmuxCommandOptions {
  sandbox?: string;
}

function applyTmuxSandbox(options?: TmuxCommandOptions): void {
  if (options?.sandbox) {
    applyTmuxLiteSandboxEnvironment(options.sandbox);
  }
}

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

function formatAge(timestamp: number): string {
  const age = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (age < 60) return `${age}s`;
  if (age < 3600) return `${Math.floor(age / 60)}m`;
  return `${Math.floor(age / 3600)}h`;
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function resolveReplay(ref: string): ReplayInfo {
  return resolveReplayOffline(ref);
}

/**
 * Start the tmux-lite server daemon
 */
export async function startTmux(options: TmuxCommandOptions = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (await isServerRunning()) {
    const pid = getServerPid();
    logger.info(`tmux-lite server already running${pid ? ` (pid ${pid})` : ""}`);
    return;
  }

  logger.log("Starting tmux-lite server...");
  await ensureServer();

  const pid = getServerPid();
  logger.success(`tmux-lite server started${pid ? ` (pid ${pid})` : ""}`);

  // Force exit since child process reference may keep event loop alive
  process.exit(0);
}

/**
 * Stop the tmux-lite server daemon
 */
export async function stopTmux(options: { force?: boolean; sandbox?: string } = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (!(await isServerRunning())) {
    logger.info("tmux-lite server not running");
    return;
  }

  // Check for active sessions
  try {
    const sessions = await listSessions();
    const activeSessions = sessions.filter((s) => !s.exitCode);

    if (activeSessions.length > 0 && !options.force) {
      logger.warning(
        `Warning: ${activeSessions.length} active session(s) will be terminated`
      );
      logger.log("Sessions:");
      for (const s of activeSessions) {
        const status = s.attached ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
        logger.log(`  ${status} ${s.id}: ${s.name}`);
      }
      logger.log("");
      logger.log("Use --force to stop anyway");
      return;
    }
  } catch {
    // Ignore errors listing sessions
  }

  logger.log("Stopping tmux-lite server...");
  await killServer();
  logger.success("tmux-lite server stopped");
}

/**
 * Show tmux-lite server status
 */
export async function statusTmux(options: TmuxCommandOptions = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Clean up any stale PID file first
  const wasStale = cleanupStalePidFile();
  if (wasStale) {
    logger.dim("(cleaned up stale PID file)");
  }

  const pid = getServerPid();
  const pidAlive = pid !== null && isProcessRunning(pid);
  const socketResponds = await isServerRunning();

  // Build status output
  const box = (lines: string[]) => {
    const width = 44;
    const top = "┌─ tmux-lite " + "─".repeat(width - 13) + "┐";
    const bottom = "└" + "─".repeat(width) + "┘";
    const padded = lines.map((l) => {
      const visible = l.replace(/\x1b\[[0-9;]*m/g, ""); // Strip ANSI for length calc
      const padding = width - visible.length;
      return "│ " + l + " ".repeat(Math.max(0, padding - 1)) + "│";
    });
    return [top, ...padded, bottom].join("\n");
  };

  if (!socketResponds) {
    // Server not running
    const lines = [
      `Status:   \x1b[90m○ not running\x1b[0m`,
      "",
      `Run: ${chalk.cyan("gssh machine tmux start")}`,
    ];
    logger.log(box(lines));
    return;
  }

  // Server is running - get detailed status
  try {
    const status = await getStatus();
    const statusIcon = "\x1b[32m●\x1b[0m"; // Green dot
    const attachedStr =
      status.attached > 0
        ? `(${status.attached} attached)`
        : "";

    const lines = [
      `Status:   ${statusIcon} running (pid ${status.pid})`,
      `Version:  ${status.version}`,
      `Socket:   ${getRouterSocket()}`,
      `Sessions: ${status.sessions} total ${attachedStr}`,
      `Uptime:   ${formatUptime(status.uptime)}`,
    ];
    logger.log(box(lines));
  } catch (err) {
    // Fallback if status query fails
    const lines = [
      `Status:   \x1b[32m●\x1b[0m running${pid ? ` (pid ${pid})` : ""}`,
      `Version:  ${PACKAGE_VERSION}`,
      `Socket:   ${getRouterSocket()}`,
    ];
    logger.log(box(lines));
  }
}

/**
 * List tmux-lite sessions
 */
export async function listTmux(options: TmuxCommandOptions = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (!(await isServerRunning())) {
    logger.info("tmux-lite server not running");
    logger.dim("Run: gssh machine tmux start");
    return;
  }

  const sessions = await listSessions();

  if (sessions.length === 0) {
    logger.log("No sessions");
    return;
  }

  logger.log("Sessions:");
  for (const s of sessions) {
    const age = Math.floor((Date.now() - s.createdAt) / 1000);
    const ageStr =
      age < 60
        ? `${age}s`
        : age < 3600
          ? `${Math.floor(age / 60)}m`
          : `${Math.floor(age / 3600)}h`;
    const status = s.attached ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m";
    const exited = s.exitCode !== undefined ? ` \x1b[31m(exited ${s.exitCode})\x1b[0m` : "";
    const title = s.processTitle ? ` \x1b[33m[${s.processTitle}]\x1b[0m` : "";
    logger.log(`  ${status} ${s.id}: ${s.name} (${ageStr})${title}${exited}`);
    logger.dim(`      ${s.cwd}`);
  }
}

/**
 * Create and attach to a new tmux-lite session
 */
export async function newTmux(name?: string, cwdOverride?: string, options: TmuxCommandOptions = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Check for nested session
  if (isNested()) {
    logger.error("Already inside a tmux-lite session");
    logger.dim("Detach first with Shift+Esc");
    return;
  }

  // Clean up any stale PID file first
  cleanupStalePidFile();

  // Ensure server is running
  if (!(await isServerRunning())) {
    logger.log("Starting tmux-lite server...");
    await ensureServer();
  }

  const cwd = cwdOverride ?? process.cwd();
  const session = await createSession(name || "session", cwd);

  logger.log(`Created session: ${session.name} (id: ${session.id})`);
  logger.dim("Shift+Esc to detach\n");

  const result = await attach(session, true);

  if (result.type === "exited") {
    process.exit(result.code);
  } else if (result.type === "error") {
    logger.error(result.message);
    process.exit(1);
  }
}

/**
 * Attach to an existing tmux-lite session
 */
export async function attachTmux(id: string, options: { force?: boolean; sandbox?: string } = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Check for nested session
  if (isNested()) {
    logger.error("Already inside a tmux-lite session");
    logger.dim("Detach first with Shift+Esc");
    return;
  }

  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (!(await isServerRunning())) {
    logger.error("tmux-lite server not running");
    logger.dim("Run: gssh machine tmux start");
    return;
  }

  const sessions = await listSessions();
  const session = sessions.find((s) => s.id === id || s.name === id);

  if (!session) {
    logger.error(`Session not found: ${id}`);
    logger.dim("Run: gssh machine tmux list");
    return;
  }

  if (session.attached && !options.force) {
    logger.warning(`Session ${session.name} is attached elsewhere`);
    logger.dim("Use --force to take over");
    return;
  }

  logger.log(`Attaching to: ${session.name} (id: ${session.id})`);
  logger.dim("Shift+Esc to detach\n");

  const result = await attach(session, true);

  if (result.type === "exited") {
    process.exit(result.code);
  } else if (result.type === "error") {
    logger.error(result.message);
    process.exit(1);
  }
}

/**
 * Kill a tmux-lite session
 */
export async function killTmux(id: string, options: TmuxCommandOptions = {}): Promise<void> {
  applyTmuxSandbox(options);
  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (!(await isServerRunning())) {
    logger.error("tmux-lite server not running");
    return;
  }

  const sessions = await listSessions();
  const session = sessions.find((s) => s.id === id || s.name === id);

  if (!session) {
    logger.error(`Session not found: ${id}`);
    logger.dim("Run: gssh machine tmux list");
    return;
  }

  await killSession(session.id);
  logger.success(`Killed session: ${session.name} (id: ${session.id})`);
}

export function listTmuxReplays(options: TmuxCommandOptions & { all?: boolean } = {}): void {
  applyTmuxSandbox(options);

  const replays = listReplaysOffline({ includeDismissed: options.all ?? false });
  if (replays.length === 0) {
    logger.log(options.all ? 'No replays' : 'No replays (use --all to include dismissed)');
    return;
  }

  logger.log('Replays:');
  for (const replay of replays) {
    const ended = replay.endedAt ? ` ${chalk.gray(`ended ${formatAge(replay.endedAt)} ago`)}` : '';
    const status = replay.status === 'crashed'
      ? chalk.red('crashed')
      : replay.status === 'running'
        ? chalk.green('running')
        : chalk.yellow('closed');
    const dismissed = replay.dismissedAt ? chalk.gray(' [dismissed]') : '';
    const label = replay.sessionName || replay.sessionId;
    const workspace = replay.workspaceName
      ? chalk.gray(` [${replay.projectName}/${replay.workspaceName}]`)
      : replay.projectName
        ? chalk.gray(` [${replay.projectName}]`)
        : '';
    logger.log(`  ${chalk.cyan(replay.replayId.slice(0, 20))} ${label}${workspace} ${chalk.gray(`(${formatDuration(replay.durationMs)})`)} ${status}${ended}${dismissed}`);
    logger.dim(`      ${replay.cwd}`);
  }
}

export async function showTmuxReplayText(
  ref: string,
  options: {
    atMs?: number;
    scrollbackLines?: number;
    includeScrollback?: boolean;
    sandbox?: string;
  } = {}
): Promise<void> {
  applyTmuxSandbox(options);

  const replay = resolveReplay(ref);
  const text = await getReplayTextOffline(replay.replayId, {
    atMs: options.atMs,
    scrollbackLines: options.scrollbackLines,
    includeScrollback: options.includeScrollback,
  });
  logger.log(text);
}

export async function screenshotTmuxReplay(
  ref: string,
  options: {
    output?: string;
    atMs?: number;
    scrollbackLines?: number;
    includeScrollback?: boolean;
    sandbox?: string;
  } = {}
): Promise<void> {
  applyTmuxSandbox(options);

  const replay = resolveReplay(ref);
  const suffix = options.atMs !== undefined ? `${options.atMs}ms` : 'latest';
  const outputPath = options.output ?? `replay-${replay.replayId}-${suffix}.png`;
  const writtenPath = await screenshotReplayOffline(replay.replayId, {
    outputPath,
    atMs: options.atMs,
    scrollbackLines: options.scrollbackLines,
    includeScrollback: options.includeScrollback,
  });

  logger.success(`Replay screenshot written: ${writtenPath}`);
}

export function dismissTmuxReplay(ref: string, options: TmuxCommandOptions = {}): void {
  applyTmuxSandbox(options);
  const replay = resolveReplay(ref);
  dismissReplayOffline(replay.replayId);
  logger.success(`Replay dismissed: ${replay.sessionName || replay.replayId}`);
  logger.dim('Use `gssh machine tmux replay undismiss` to restore it.');
}

export function undismissTmuxReplay(ref: string, options: TmuxCommandOptions = {}): void {
  applyTmuxSandbox(options);
  const replay = resolveReplayOffline(ref, { includeDismissed: true });
  undismissReplayOffline(replay.replayId);
  logger.success(`Replay restored: ${replay.sessionName || replay.replayId}`);
}

export function deleteTmuxReplay(ref: string, options: TmuxCommandOptions = {}): void {
  applyTmuxSandbox(options);
  const replay = resolveReplayOffline(ref, { includeDismissed: true });
  deleteReplayOffline(replay.replayId);
  logger.success(`Replay deleted: ${replay.sessionName || replay.replayId}`);
}
