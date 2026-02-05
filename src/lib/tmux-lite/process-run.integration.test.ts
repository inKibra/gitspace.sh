import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawn } from "bun";
import { existsSync, mkdirSync, rmSync, unlinkSync } from "fs";
import { dirname, join } from "path";
import {
  encodeRouterMessage,
  decodeRouterMessages,
  encodeControl,
  parseFrames,
  decodeControl,
  FrameType,
} from "./protocol";

const TEST_SOCKET = "/tmp/tmux-lite-test.sock";
const TEST_SESSION_DIR = "/tmp/tmux-lite-test";
const TEST_PID_FILE = "/tmp/tmux-lite-test.pid";
const SERVER_SCRIPT = join(import.meta.dir, "server.ts");
const SESSION_NAME = "proc:wide-events:sample-events:1";
const SAMPLE_SCRIPT = join(import.meta.dir, "../../../scripts/sample-events.ts");
const BUN_PATH = "/opt/homebrew/bin/bun";

function getTestSessionSocketPath(id: string): string {
  return join(TEST_SESSION_DIR, `tmux-lite-${id}.sock`);
}

function cleanup(): void {
  try { unlinkSync(TEST_SOCKET); } catch {}
  try { unlinkSync(TEST_PID_FILE); } catch {}
  try { rmSync(TEST_SESSION_DIR, { recursive: true, force: true }); } catch {}
}

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await Bun.sleep(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

async function startServer(): Promise<void> {
  spawn({
    cmd: ["bun", "run", SERVER_SCRIPT, "--test"],
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      TMUX_LITE_SOCKET: TEST_SOCKET,
      TMUX_LITE_SESSION_DIR: TEST_SESSION_DIR,
      TMUX_LITE_PID_FILE: TEST_PID_FILE,
    },
  });

  await waitFor(async () => existsSync(TEST_SOCKET));
}

async function sendRouterCommand(command: Record<string, unknown>) {
  return await new Promise<any>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let socketRef: any;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socketRef?.end();
      reject(new Error(`Router timeout for command ${String(command.type)}`));
    }, 3000);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socketRef?.end();
      fn();
    };

    Bun.connect({
      unix: TEST_SOCKET,
      socket: {
        open(socket) {
          socketRef = socket;
          socket.write(encodeRouterMessage(command as any));
        },
        data(_socket, data) {
          buffer = Buffer.concat([buffer, Buffer.from(data)]);
          try {
            const decoded = decodeRouterMessages(buffer);
            buffer = Buffer.from(decoded.remaining as Buffer);
            if (decoded.messages.length > 0) {
              finish(() => resolve(decoded.messages[0]));
            }
          } catch (err) {
            finish(() => reject(err));
          }
        },
        close() {
          finish(() => reject(new Error("Router socket closed before response")));
        },
        error(_socket, err) {
          finish(() => reject(err));
        },
        connectError(_socket, err) {
          finish(() => reject(err));
        },
        drain() {},
      },
    }).catch((err) => finish(() => reject(err)));
  });
}

async function attachAndWaitForEvent(socketPath: string): Promise<{ output: string }> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let output = "";
    let attached = false;
    let settled = false;
    let socketRef: any;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      socketRef?.end();
      reject(new Error(`Timed out waiting for @event output. Collected output: ${output.slice(-500)}`));
    }, 2000);

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socketRef?.end();
      fn();
    };

    const connectOnce = () => {
    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          socketRef = socket;
          socket.write(encodeControl({ type: "attach-init", cols: 80, rows: 24, clientType: "cli" }));
        },

          data(_socket, data) {
            buffer = Buffer.concat([buffer, Buffer.from(data)]);
            try {
              const parsed = parseFrames(buffer);
              buffer = Buffer.from(parsed.remaining as Buffer);
            for (const frame of parsed.frames) {
              if (frame.type === FrameType.CONTROL) {
                const msg = decodeControl(frame.payload);
                if (msg.type === "attached") {
                  attached = true;
                }
                if (msg.type === "wide_event") {
                  output += JSON.stringify(msg.event);
                  if (attached) {
                    finish(() => resolve({ output }));
                  }
                }
              } else if (frame.type === FrameType.PTY) {
                const text = frame.payload.toString("utf-8");
                output += text;
                if (attached && output.includes("[event:")) {
                  finish(() => resolve({ output }));
                }
              }
            }

            } catch (err) {
              finish(() => reject(err));
            }
          },
          close() {
            finish(() => reject(new Error("Session socket closed before output")));
          },
          error(_socket, err) {
            finish(() => reject(err));
          },
          connectError(_socket, err) {
            if ((err as { code?: string }).code === "ENOENT") {
              if (!settled) {
                setTimeout(connectOnce, 50);
              }
              return;
            }
            finish(() => reject(err));
          },
          drain() {},
        },
      }).catch((err) => {
        if ((err as { code?: string }).code === "ENOENT") {
          if (!settled) {
            setTimeout(connectOnce, 50);
          }
          return;
        }
        finish(() => reject(err));
      });
    };

    connectOnce();
  });
}

describe("tmux-lite process execution", () => {
  beforeEach(() => {
    cleanup();
    mkdirSync(TEST_SESSION_DIR, { recursive: true });
  });

  afterEach(async () => {
    try {
      if (existsSync(TEST_SOCKET)) {
        await waitWithTimeout(sendRouterCommand({ type: "kill-server" }), 2000, "kill-server");
      }
    } catch (err) {
      console.warn("Failed to kill test server:", err);
    }
    await Bun.sleep(200);
    cleanup();
  });

  test("starts process session and streams output", async () => {
    await startServer();

    if (!existsSync(BUN_PATH)) {
      throw new Error(`bun not found at ${BUN_PATH}`);
    }

    const response = await sendRouterCommand({
      type: "new",
      name: SESSION_NAME,
      cwd: join(import.meta.dir, "../../.."),
      command: process.execPath,
      args: [
        join(import.meta.dir, "../../index.ts"),
        "--internal-process-runner",
        "--workspace",
        join(import.meta.dir, "../../.."),
        "--process",
        "sample-events",
        "--instance",
        "1",
      ],
    });

    if (response.type !== "session") {
      throw new Error(`Expected session response, got: ${JSON.stringify(response)}`);
    }

    const socketPath = getTestSessionSocketPath(response.session.id);
    const { output } = await waitWithTimeout(attachAndWaitForEvent(socketPath), 8000, "attachAndWaitForEvent");
    expect(output).toContain("[event:");

  }, 10000);
});
