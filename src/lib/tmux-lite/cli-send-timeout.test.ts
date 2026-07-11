/**
 * Tests for the CLI send() deadline (ticket #4: bound every client RPC).
 *
 * A wedged daemon accepts the router-socket connection but never replies.
 * send() must reject with a named TmuxCliTimeoutError (command type + socket
 * path + operator hint) instead of hanging forever. isServerRunning() must
 * propagate the timeout instead of reporting "not running" (which would make
 * ensureServer() spawn a duplicate daemon on top of the wedged one).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  send,
  isServerRunning,
  TmuxCliTimeoutError,
  DEFAULT_SEND_TIMEOUT_MS,
} from "./cli";
import { encodeRouterMessage, type Response } from "./protocol";

const TMUX_ENV_KEYS = [
  "TMUX_LITE_SANDBOX",
  "TMUX_LITE_SOCKET",
  "TMUX_LITE_SESSION_DIR",
  "TMUX_LITE_PID_FILE",
] as const;

let savedEnv: Record<string, string | undefined>;
let testDir: string;
let socketPath: string;
let server: ReturnType<typeof Bun.listen> | null = null;

beforeEach(() => {
  savedEnv = Object.fromEntries(TMUX_ENV_KEYS.map((key) => [key, process.env[key]]));
  testDir = join(tmpdir(), `tl-send-timeout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(testDir, { recursive: true });
  socketPath = join(testDir, "router.sock");
  delete process.env.TMUX_LITE_SANDBOX;
  process.env.TMUX_LITE_SOCKET = socketPath;
  process.env.TMUX_LITE_SESSION_DIR = testDir;
  process.env.TMUX_LITE_PID_FILE = join(testDir, "router.pid");
});

afterEach(() => {
  server?.stop(true);
  server = null;
  try { unlinkSync(socketPath); } catch { /* already gone */ }
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
  for (const key of TMUX_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A unix-socket server that accepts connections but never replies — the
 *  observable behavior of a SIGSTOPped / event-loop-wedged daemon. */
function listenSilently(): void {
  server = Bun.listen({
    unix: socketPath,
    socket: {
      data() { /* swallow everything, never respond */ },
    },
  });
}

/** A server that replies to any router message with a canned response. */
function listenWithReply(response: Response): void {
  server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket) {
        socket.write(encodeRouterMessage(response));
      },
    },
  });
}

describe("send() deadline", () => {
  it("rejects with TmuxCliTimeoutError naming the command and socket when the daemon never replies", async () => {
    listenSilently();

    const startedAt = Date.now();
    let caught: unknown;
    try {
      await send({ type: "list" }, { timeoutMs: 250 });
    } catch (err) {
      caught = err;
    }
    const elapsed = Date.now() - startedAt;

    expect(caught).toBeInstanceOf(TmuxCliTimeoutError);
    const error = caught as TmuxCliTimeoutError;
    expect(error.message).toContain("'list'");
    expect(error.message).toContain(socketPath);
    expect(error.message).toContain("daemon wedged?");
    expect(error.message).toContain("gssh machine tmux status");
    expect(error.commandType).toBe("list");
    expect(error.socketPath).toBe(socketPath);
    expect(error.timeoutMs).toBe(250);
    // Fired at the deadline, not the default 15s
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(DEFAULT_SEND_TIMEOUT_MS);
  });

  it("resolves normally when the daemon replies before the deadline", async () => {
    listenWithReply({ type: "sessions", sessions: [] });

    const res = await send({ type: "list" }, { timeoutMs: 5000 });
    expect(res.type).toBe("sessions");
  });

  it("uses the default deadline when none is passed", async () => {
    // Only assert wiring (no 15s wait): a quick reply resolves under defaults.
    listenWithReply({ type: "sessions", sessions: [] });
    const res = await send({ type: "list" });
    expect(res.type).toBe("sessions");
  });

  it("still rejects fast on connection errors (no daemon at socket)", async () => {
    // No server listening — connect fails immediately rather than timing out.
    const startedAt = Date.now();
    await expect(send({ type: "list" }, { timeoutMs: 5000 })).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });
});

describe("isServerRunning() with a wedged daemon", () => {
  it("propagates the timeout instead of returning false", async () => {
    listenSilently();

    // Shrink the default deadline (GSSH_TMUX_SEND_TIMEOUT_MS) so the real
    // isServerRunning() path runs fast. A wedged daemon must surface as an
    // error, not as "not running" — the latter would make ensureServer()
    // spawn a duplicate daemon and mask the failure.
    const savedTimeoutEnv = process.env.GSSH_TMUX_SEND_TIMEOUT_MS;
    process.env.GSSH_TMUX_SEND_TIMEOUT_MS = "250";
    try {
      const error = await isServerRunning().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(TmuxCliTimeoutError);
    } finally {
      if (savedTimeoutEnv === undefined) delete process.env.GSSH_TMUX_SEND_TIMEOUT_MS;
      else process.env.GSSH_TMUX_SEND_TIMEOUT_MS = savedTimeoutEnv;
    }
  });

  it("returns false when nothing listens on the socket", async () => {
    // Socket file does not exist → short-circuits to false.
    expect(await isServerRunning()).toBe(false);
  });
});
