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

interface ControlledTimer {
  callback: () => void;
  cancelled: boolean;
}

interface ControlledTimers {
  advance(): void;
  restore(): void;
}

interface ControlledReplyServer {
  requestReceived: Promise<void>;
  reply(response: Response): void;
  close(): void;
}

function installControlledTimers(): ControlledTimers {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const timers = new Set<ControlledTimer>();

  globalThis.setTimeout = ((callback: () => void) => {
    const timer: ControlledTimer = { callback, cancelled: false };
    timers.add(timer);
    return timer as unknown as number;
  }) as typeof setTimeout;
  globalThis.clearTimeout = ((timer: unknown) => {
    if (typeof timer === "object" && timer !== null && timers.has(timer as ControlledTimer)) {
      (timer as ControlledTimer).cancelled = true;
    }
  }) as typeof clearTimeout;

  return {
    advance() {
      for (const timer of timers) {
        if (!timer.cancelled) {
          timer.cancelled = true;
          timer.callback();
        }
      }
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

/** A unix-socket server whose response is released by the test. */
function listenUntilReply(): ControlledReplyServer {
  let resolveRequest: (() => void) | undefined;
  const requestReceived = new Promise<void>((resolve) => {
    resolveRequest = resolve;
  });
  let reply: ((response: Response) => void) | undefined;
  let close: (() => void) | undefined;

  server = Bun.listen({
    unix: socketPath,
    socket: {
      data(socket) {
        reply = (response) => socket.write(encodeRouterMessage(response));
        close = () => socket.end();
        resolveRequest?.();
      },
    },
  });

  return {
    requestReceived,
    reply(response) {
      if (!reply) throw new Error("Expected a client request before replying");
      reply(response);
    },
    close() {
      if (!close) throw new Error("Expected a client request before closing");
      close();
    },
  };
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
    const timers = installControlledTimers();
    try {
      const control = listenUntilReply();
      const pending = send({ type: "list" }, { timeoutMs: 250 });
      await control.requestReceived;
      timers.advance();

      const caught = await pending.catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(TmuxCliTimeoutError);
      const error = caught as TmuxCliTimeoutError;
      expect(error.message).toContain("'list'");
      expect(error.message).toContain(socketPath);
      expect(error.message).toContain("daemon wedged?");
      expect(error.message).toContain("gssh machine tmux status");
      expect(error.commandType).toBe("list");
      expect(error.socketPath).toBe(socketPath);
      expect(error.timeoutMs).toBe(250);
    } finally {
      timers.restore();
    }
  });

  it("resolves normally when the daemon replies before the deadline", async () => {
    listenWithReply({ type: "sessions", sessions: [] });

    const res = await send({ type: "list" }, { timeoutMs: 5000 });
    expect(res).toEqual({ type: "sessions", sessions: [] });
  });

  it("waits for a response after a controlled ordinary deadline when timeoutMs is null", async () => {
    const timers = installControlledTimers();
    try {
      const control = listenUntilReply();
      const pending = send({ type: "list" }, { timeoutMs: null });
      await control.requestReceived;
      timers.advance();
      control.reply({ type: "sessions", sessions: [] });

      await expect(pending).resolves.toEqual({ type: "sessions", sessions: [] });
    } finally {
      timers.restore();
    }
  });

  it("rejects on socket close after a controlled ordinary deadline when timeoutMs is null", async () => {
    const timers = installControlledTimers();
    try {
      const control = listenUntilReply();
      const pending = send({ type: "list" }, { timeoutMs: null });
      await control.requestReceived;
      timers.advance();
      control.close();

      await expect(pending).rejects.toThrow("Connection closed before response");
    } finally {
      timers.restore();
    }
  });
});

describe("isServerRunning() with a wedged daemon", () => {
  it("propagates the timeout instead of returning false", async () => {
    const timers = installControlledTimers();
    try {
      const control = listenUntilReply();
      const pending = isServerRunning();
      await control.requestReceived;
      timers.advance();

      await expect(pending).rejects.toBeInstanceOf(TmuxCliTimeoutError);
    } finally {
      timers.restore();
    }
  });
});

