/**
 * tmux-lite daemon management commands
 *
 * Commands:
 *   gssh tmux start       - Start the tmux-lite server daemon
 *   gssh tmux stop        - Stop the tmux-lite server daemon
 *   gssh tmux status      - Show server status
 *   gssh tmux list        - List sessions
 *   gssh tmux new [name]  - Create and attach to a new session
 *   gssh tmux attach <id> - Attach to a session
 *   gssh tmux kill <id>   - Kill a session
 */

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

/**
 * Start the tmux-lite server daemon
 */
export async function startTmux(): Promise<void> {
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
export async function stopTmux(options: { force?: boolean } = {}): Promise<void> {
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
export async function statusTmux(): Promise<void> {
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
      `Run: \x1b[36mgssh tmux start\x1b[0m`,
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
export async function listTmux(): Promise<void> {
  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (!(await isServerRunning())) {
    logger.info("tmux-lite server not running");
    logger.dim("Run: gssh tmux start");
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
export async function newTmux(name?: string): Promise<void> {
  // Check for nested session
  if (isNested()) {
    logger.error("Already inside a tmux-lite session");
    logger.dim("Detach first with Ctrl+Esc");
    return;
  }

  // Clean up any stale PID file first
  cleanupStalePidFile();

  // Ensure server is running
  if (!(await isServerRunning())) {
    logger.log("Starting tmux-lite server...");
    await ensureServer();
  }

  const cwd = process.cwd();
  const session = await createSession(name || "session", cwd);

  logger.log(`Created session: ${session.name} (id: ${session.id})`);
  logger.dim("Ctrl+Esc to detach\n");

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
export async function attachTmux(id: string, options: { force?: boolean } = {}): Promise<void> {
  // Check for nested session
  if (isNested()) {
    logger.error("Already inside a tmux-lite session");
    logger.dim("Detach first with Ctrl+Esc");
    return;
  }

  // Clean up any stale PID file first
  cleanupStalePidFile();

  if (!(await isServerRunning())) {
    logger.error("tmux-lite server not running");
    logger.dim("Run: gssh tmux start");
    return;
  }

  const sessions = await listSessions();
  const session = sessions.find((s) => s.id === id || s.name === id);

  if (!session) {
    logger.error(`Session not found: ${id}`);
    logger.dim("Run: gssh tmux list");
    return;
  }

  if (session.attached && !options.force) {
    logger.warning(`Session ${session.name} is attached elsewhere`);
    logger.dim("Use --force to take over");
    return;
  }

  logger.log(`Attaching to: ${session.name} (id: ${session.id})`);
  logger.dim("Ctrl+Esc to detach\n");

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
export async function killTmux(id: string): Promise<void> {
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
    logger.dim("Run: gssh tmux list");
    return;
  }

  await killSession(session.id);
  logger.success(`Killed session: ${session.name} (id: ${session.id})`);
}
