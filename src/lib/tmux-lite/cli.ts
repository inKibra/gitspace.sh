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
  getRouterSocket,
  getPidFile,
  PROTOCOL_VERSION,
  PACKAGE_VERSION,
  type Command,
  type Response,
  type Session,
  type SessionEvent,
  type InboxItem,
  encodeRouterMessage,
  decodeRouterMessages,
  encodeControl,
  encodePTY,
  parseFrames,
  decodeControl,
  FrameType,
} from "./protocol";

// Re-export types
export type { Session, InboxItem, Command, Response };

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

// Terminal reset - RIS (Reset to Initial State) resets everything
const TERM_RESET = "\x1bc";

const SERVER_SCRIPT = `${import.meta.dir}/server.ts`;

// CLI args
const rawArgs = process.argv.slice(2);
const isTestMode = rawArgs.includes("--test");
const args = rawArgs.filter(arg => arg !== "--test");
const cmd = args[0] || "list";

if (isTestMode) {
  process.env.TMUX_LITE_SOCKET = "/tmp/tmux-lite-test.sock";
  process.env.TMUX_LITE_SESSION_DIR = "/tmp/tmux-lite-test";
}

const getServerCommand = (): string[] => (
  isTestMode ? ["bun", "run", SERVER_SCRIPT, "--test"] : ["bun", "run", SERVER_SCRIPT]
);

// Check if we're already inside a tmux-lite session
export function isNested(): boolean {
  return !!process.env.TMUX_LITE;
}

function checkNested(): boolean {
  if (isNested()) {
    console.error("Error: Already inside tmux-lite session " + process.env.TMUX_LITE);
    console.error("Nested sessions are not supported. Detach first with Ctrl+Esc.");
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
export async function ensureServer(): Promise<void> {
  if (await isServerRunning()) return;

  spawn({
    cmd: getServerCommand(),
    stdout: "ignore",
    stderr: "ignore",
  });

  for (let i = 0; i < 30; i++) {
    await Bun.sleep(100);
    if (await isServerRunning()) return;
  }
  throw new Error("Failed to start tmux-lite server");
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

// === API convenience functions ===

export async function listSessions(): Promise<Session[]> {
  await ensureServer();
  const res = await send({ type: "list" });
  if (res.type === "sessions") return res.sessions;
  throw new Error("Unexpected response");
}

export async function createSession(name: string, cwd: string): Promise<Session> {
  await ensureServer();
  const res = await send({ type: "new", name, cwd });
  if (res.type === "session") return res.session;
  if (res.type === "error") throw new Error(res.message);
  throw new Error("Unexpected response");
}

export async function killSession(id: string): Promise<void> {
  await ensureServer();
  const res = await send({ type: "kill", id });
  if (res.type === "error") throw new Error(res.message);
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

export async function getUnreadCount(): Promise<number> {
  const items = await getInbox();
  return items.filter(i => !i.read).length;
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

// Ctrl+Esc sequences (different terminals send different formats)
const CTRL_ESC_CSI_U = Buffer.from([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x35, 0x75]); // ESC [ 27;5u
const CTRL_ESC_XTERM = Buffer.from([0x1b, 0x5b, 0x32, 0x37, 0x3b, 0x35, 0x3b, 0x32, 0x37, 0x7e]); // ESC [ 27;5;27 ~
const BRACKETED_PASTE_START = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x30, 0x7e]); // ESC [ 200 ~
const BRACKETED_PASTE_END = Buffer.from([0x1b, 0x5b, 0x32, 0x30, 0x31, 0x7e]); // ESC [ 201 ~

function containsCtrlEsc(buf: Buffer): number {
  const idx1 = buf.indexOf(CTRL_ESC_CSI_U);
  const idx2 = buf.indexOf(CTRL_ESC_XTERM);
  if (idx1 === -1) return idx2;
  if (idx2 === -1) return idx1;
  return Math.min(idx1, idx2);
}

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
    console.log("Ctrl+Esc to detach\n");
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
        data(socket, data) {
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

    // Forward stdin with Ctrl+Esc detection
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
          : [BRACKETED_PASTE_START, BRACKETED_PASTE_END, CTRL_ESC_CSI_U, CTRL_ESC_XTERM]
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
          if (matched === CTRL_ESC_CSI_U || matched === CTRL_ESC_XTERM) {
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
  // Start server if not running
  if (!(await isServerRunning())) {
    if (cmd === "kill-server") {
      console.log("Server not running");
      return;
    }
    console.log("Starting server...");
    spawn({
      cmd: getServerCommand(),
      // Use "ignore" so server doesn't inherit CLI's stdout/stderr
      // This allows CLI to exit cleanly when piped
      stdout: "ignore",
      stderr: "ignore",
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
  Ctrl+Esc          Detach
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
