/**
 * E2E tests for tmux-lite server lifecycle
 *
 * Tests server start, stop, and restart scenarios including
 * proper cleanup of socket files.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { spawn } from "bun";
import { existsSync, unlinkSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { applyTmuxLiteSandboxEnvironment, getTmuxLitePathsForSandbox } from "./protocol";
import { createSession, killServer, listSessions } from "./cli";

// Use the same paths as --test mode in cli.ts and server.ts
const TEST_SOCKET = "/tmp/tmux-lite-test.sock";
const TEST_SESSION_DIR = "/tmp/tmux-lite-test";
const CLI_SCRIPT = join(import.meta.dir, "cli.ts");
const TMUX_ENV_KEYS = [
  "TMUX_LITE_SANDBOX",
  "TMUX_LITE_SOCKET",
  "TMUX_LITE_SESSION_DIR",
  "TMUX_LITE_PID_FILE",
] as const;

function captureTmuxEnv(): Record<(typeof TMUX_ENV_KEYS)[number], string | undefined> {
  return Object.fromEntries(TMUX_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<(typeof TMUX_ENV_KEYS)[number], string | undefined>;
}

function restoreTmuxEnv(env: Record<(typeof TMUX_ENV_KEYS)[number], string | undefined>): void {
  for (const key of TMUX_ENV_KEYS) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function cleanupSandbox(name: string): void {
  const paths = getTmuxLitePathsForSandbox(name);
  try { unlinkSync(paths.routerSocket); } catch {}
  try { unlinkSync(paths.pidFile); } catch {}
  try { rmSync(paths.sessionDir, { recursive: true, force: true }); } catch {}
}

/**
 * Helper to run CLI commands in test mode
 */
async function runCli(args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = spawn({
    cmd: ["bun", "run", CLI_SCRIPT, ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      TMUX_LITE: "",
    },
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  // Give server time to initialize after CLI returns
  await Bun.sleep(500);

  return { stdout, stderr, exitCode };
}

/**
 * Helper to check if server is running by checking socket exists and responds
 */
async function isServerRunning(): Promise<boolean> {
  if (!existsSync(TEST_SOCKET)) return false;

  try {
    const result = await runCli(["list", "--test"]);
    // If we can list sessions, server is running
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Helper to wait for a condition with timeout
 */
async function waitFor(
  condition: () => Promise<boolean>,
  timeoutMs: number = 5000,
  intervalMs: number = 100
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/**
 * Force cleanup any leftover test artifacts
 */
function forceCleanup(): void {
  try { unlinkSync(TEST_SOCKET); } catch {}
  try { rmSync(TEST_SESSION_DIR, { recursive: true, force: true }); } catch {}
}

describe("tmux-lite server lifecycle", () => {
  beforeEach(() => {
    // Ensure clean state before each test
    forceCleanup();
    mkdirSync(TEST_SESSION_DIR, { recursive: true });
  });

  afterEach(async () => {
    // Kill server if still running and cleanup
    try {
      await runCli(["kill-server", "--test"]);
      await Bun.sleep(200); // Wait for cleanup
    } catch {}
    forceCleanup();
  });

  describe("server start", () => {
    it("should start server and create socket file", async () => {
      // Socket should not exist initially
      expect(existsSync(TEST_SOCKET)).toBe(false);

      // Start server by running any command (list auto-starts)
      const result = await runCli(["list", "--test"]);

      // Wait for server to be ready
      const started = await waitFor(async () => existsSync(TEST_SOCKET));
      expect(started).toBe(true);

      // Server should be running
      const running = await isServerRunning();
      expect(running).toBe(true);
    });

    it("should not fail if server is already running", async () => {
      // Start server first time
      await runCli(["list", "--test"]);
      await waitFor(async () => existsSync(TEST_SOCKET));

      // Run another command - should not fail
      const result = await runCli(["list", "--test"]);
      expect(result.exitCode).toBe(0);
    });
  });

  describe("server stop", () => {
    it("should stop server and remove socket file", async () => {
      // Start server
      await runCli(["list", "--test"]);
      await waitFor(async () => existsSync(TEST_SOCKET));
      expect(existsSync(TEST_SOCKET)).toBe(true);

      // Stop server
      await runCli(["kill-server", "--test"]);

      // Wait for socket to be cleaned up
      const cleaned = await waitFor(async () => !existsSync(TEST_SOCKET), 2000);
      expect(cleaned).toBe(true);

      // Socket file should be removed
      expect(existsSync(TEST_SOCKET)).toBe(false);
    });

    it("should not fail if server is not running", async () => {
      // Ensure server is not running
      expect(existsSync(TEST_SOCKET)).toBe(false);

      // Stop should handle gracefully
      const result = await runCli(["kill-server", "--test"]);
      // CLI shows "Server not running" but exits cleanly
      expect(result.exitCode).toBe(0);
    });
  });

  describe("server restart cycle", () => {
    it("should successfully restart after stop (socket cleanup regression test)", async () => {
      // This is the main regression test for the socket cleanup fix

      // Start server
      await runCli(["list", "--test"]);
      const started1 = await waitFor(async () => existsSync(TEST_SOCKET));
      expect(started1).toBe(true);

      // Stop server
      await runCli(["kill-server", "--test"]);
      const stopped = await waitFor(async () => !existsSync(TEST_SOCKET), 2000);
      expect(stopped).toBe(true);

      // Start server again - THIS WAS FAILING before the fix
      // because the socket file wasn't being cleaned up
      await runCli(["list", "--test"]);
      const started2 = await waitFor(async () => existsSync(TEST_SOCKET));
      expect(started2).toBe(true);

      // Verify server is actually running
      const running = await isServerRunning();
      expect(running).toBe(true);
    });

    it("should handle multiple restart cycles", async () => {
      for (let i = 0; i < 3; i++) {
        // Start
        await runCli(["list", "--test"]);
        const started = await waitFor(async () => existsSync(TEST_SOCKET));
        expect(started).toBe(true);

        // Verify running
        const running = await isServerRunning();
        expect(running).toBe(true);

        // Stop
        await runCli(["kill-server", "--test"]);
        const stopped = await waitFor(async () => !existsSync(TEST_SOCKET), 2000);
        expect(stopped).toBe(true);
      }
    }, 15000); // Increase timeout for 3 cycles
  });

  describe("stale socket handling", () => {
    it("should clean up stale socket on server start", async () => {
      // Create a stale socket file (simulating crashed server)
      Bun.write(TEST_SOCKET, "stale");
      expect(existsSync(TEST_SOCKET)).toBe(true);

      // Start server - should clean up stale socket and start fresh
      await runCli(["list", "--test"]);
      const started = await waitFor(async () => {
        // Socket exists AND server responds
        return await isServerRunning();
      });
      expect(started).toBe(true);
    });
  });

  describe("sandbox isolation", () => {
    it("should start isolated servers for different sandboxes", async () => {
      const sandboxA = "lifecycle-a";
      const sandboxB = "lifecycle-b";
      const pathsA = getTmuxLitePathsForSandbox(sandboxA);
      const pathsB = getTmuxLitePathsForSandbox(sandboxB);

      cleanupSandbox(sandboxA);
      cleanupSandbox(sandboxB);

      try {
        await runCli(["list", `--sandbox=${sandboxA}`]);
        await runCli(["list", `--sandbox=${sandboxB}`]);

        const started = await waitFor(async () => existsSync(pathsA.routerSocket) && existsSync(pathsB.routerSocket));
        expect(started).toBe(true);
        expect(pathsA.routerSocket).not.toBe(pathsB.routerSocket);
        expect(pathsA.sessionDir).not.toBe(pathsB.sessionDir);
      } finally {
        try { await runCli(["kill-server", `--sandbox=${sandboxA}`]); } catch {}
        try { await runCli(["kill-server", `--sandbox=${sandboxB}`]); } catch {}
        cleanupSandbox(sandboxA);
        cleanupSandbox(sandboxB);
      }
    });
  });

  describe("session socket cleanup", () => {
    it("should remove the per-session socket after process exit", async () => {
      const sandbox = "session-cleanup";
      const previousEnv = captureTmuxEnv();
      cleanupSandbox(sandbox);
      applyTmuxLiteSandboxEnvironment(sandbox);

      try {
        const session = await createSession("cleanup-check", process.cwd(), {
          command: "/bin/sh",
          args: ["-lc", "printf 'cleanup-check'; exit 0"],
        });

        const created = await waitFor(async () => existsSync(session.socketPath));
        expect(created).toBe(true);

        const removed = await waitFor(async () => !existsSync(session.socketPath), 5000);
        expect(removed).toBe(true);
        expect(await listSessions()).toEqual([]);
      } finally {
        try { await killServer(); } catch {}
        cleanupSandbox(sandbox);
        restoreTmuxEnv(previousEnv);
      }
    });
  });
});
