import { describe, expect, test } from "bun:test";
import type { ProcessInstanceSpec } from "../../types/processes.js";
import { reconcileProcessRestarts, type ProcessWatchdogDeps } from "./watchdog.js";

function buildSpec(name: string, policy: "never" | "on-failure" | "always"): ProcessInstanceSpec {
  return {
    name,
    instance: 1,
    definition: {
      name,
      command: "echo",
      restart: {
        policy,
        maxAttempts: 3,
        backoffMs: 10,
        maxBackoffMs: 100,
      },
    },
  };
}

describe("process watchdog", () => {
  test("does not restart when never started", async () => {
    const spec = buildSpec("never-started", "always");
    const started: string[] = [];

    const deps: ProcessWatchdogDeps = {
      listSessions: async () => [],
      startProcessInstance: async (_workspace, target) => {
        started.push(`${target.name}:${target.instance}`);
        return { sessionId: "s1", created: true };
      },
      isProcessRestartDisabled: () => false,
      hasProcessStarted: () => false,
    };

    await reconcileProcessRestarts("/tmp/workspace", [spec], deps);
    expect(started.length).toBe(0);
  });

  test("restarts missing session when started and exit was non-zero", async () => {
    const spec = buildSpec("crashed-process", "on-failure");
    const started: string[] = [];

    const deps: ProcessWatchdogDeps = {
      listSessions: async () => [],
      startProcessInstance: async (_workspace, target) => {
        started.push(`${target.name}:${target.instance}`);
        return { sessionId: "s2", created: true };
      },
      isProcessRestartDisabled: () => false,
      hasProcessStarted: () => true,
      readProcessExit: () => ({ exitCode: 1, exitedAt: 123 }),
      now: () => 1000,
    };

    await reconcileProcessRestarts("/tmp/workspace", [spec], deps);
    expect(started).toEqual(["crashed-process:1"]);
  });

  test("does not restart on-failure when last exit was clean", async () => {
    const spec = buildSpec("clean-exit", "on-failure");
    const started: string[] = [];

    const deps: ProcessWatchdogDeps = {
      listSessions: async () => [],
      startProcessInstance: async (_workspace, target) => {
        started.push(`${target.name}:${target.instance}`);
        return { sessionId: "s3", created: true };
      },
      isProcessRestartDisabled: () => false,
      hasProcessStarted: () => true,
      readProcessExit: () => ({ exitCode: 0, exitedAt: 456 }),
    };

    await reconcileProcessRestarts("/tmp/workspace", [spec], deps);
    expect(started.length).toBe(0);
  });
});
