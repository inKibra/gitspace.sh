import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { decodeRouterMessages, encodeRouterMessage } from "./protocol";
import { findPngRasterizer, readPngDimensions, writeReplayScreenshot } from "./replay/screenshot.js";
import {
  deleteReplay,
  dismissReplay,
  listReplayCheckpoints,
  listReplayInfos,
  readReplayEvents,
  readReplayManifest,
  undismissReplay,
} from "./replay/store.js";
import { getReplayTextOffline, listReplaysOffline, screenshotReplayOffline } from './replay/service.js';

const SERVER_SCRIPT = join(import.meta.dir, "server.ts");

let testSocket = "/tmp/tmux-lite-test.sock";
let testSessionDir = "/tmp/tmux-lite-test";
let testPidFile = "/tmp/tmux-lite-test.pid";

function cleanupSocketArtifacts(): void {
  try { unlinkSync(testSocket); } catch {}
  try { unlinkSync(testPidFile); } catch {}
  try { rmSync(testSessionDir, { recursive: true, force: true }); } catch {}
}

async function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) {
      return;
    }
    await Bun.sleep(intervalMs);
  }
  throw new Error("Timed out waiting for condition");
}

async function startServer(replayRoot: string): Promise<Subprocess> {
  const proc = spawn({
    cmd: ["bun", "run", SERVER_SCRIPT, "--test"],
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      TMUX_LITE_SOCKET: testSocket,
      TMUX_LITE_SESSION_DIR: testSessionDir,
      TMUX_LITE_PID_FILE: testPidFile,
      TMUX_LITE_REPLAY_DIR: replayRoot,
    },
  });

  await waitFor(() => existsSync(testSocket));
  return proc;
}

async function sendRouterCommand(command: Record<string, unknown>): Promise<any> {
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;
    let socketRef: any;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      socketRef?.end();
      reject(new Error(`Router timeout for command ${String(command.type)}`));
    }, 3000);

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socketRef?.end();
      callback();
    };

    Bun.connect({
      unix: testSocket,
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
          } catch (error) {
            finish(() => reject(error));
          }
        },
        close() {
          finish(() => reject(new Error("Router socket closed before response")));
        },
        error(_socket, error) {
          finish(() => reject(error));
        },
        connectError(_socket, error) {
          finish(() => reject(error));
        },
        drain() {},
      },
    }).catch((error) => finish(() => reject(error)));
  });
}

describe("tmux-lite replay capture", () => {
  let replayRoot: string;
  let serverProc: Subprocess | null = null;
  const originalReplayDir = process.env.TMUX_LITE_REPLAY_DIR;

  beforeEach(() => {
    const runId = `${Date.now()}-${Math.round(Math.random() * 1_000_000)}`;
    testSocket = `/tmp/tmux-lite-test-${runId}.sock`;
    testSessionDir = `/tmp/tmux-lite-test-${runId}`;
    testPidFile = `/tmp/tmux-lite-test-${runId}.pid`;
    cleanupSocketArtifacts();
    replayRoot = mkdtempSync(join(tmpdir(), "gitspace-replay-integration-"));
    process.env.TMUX_LITE_REPLAY_DIR = replayRoot;
  });

  afterEach(async () => {
    try {
      if (existsSync(testSocket)) {
        await sendRouterCommand({ type: "kill-server" });
        await Bun.sleep(200);
      }
    } catch {}
    try {
      serverProc?.kill();
    } catch {}
    serverProc = null;

    cleanupSocketArtifacts();
    rmSync(replayRoot, { recursive: true, force: true });
    if (originalReplayDir === undefined) {
      delete process.env.TMUX_LITE_REPLAY_DIR;
    } else {
      process.env.TMUX_LITE_REPLAY_DIR = originalReplayDir;
    }
  });

  test("captures replay output and exit metadata for completed sessions", async () => {
    serverProc = await startServer(replayRoot);

    const response = await sendRouterCommand({
      type: "new",
      name: "replay-test-session",
      cwd: join(import.meta.dir, "../../.."),
      command: "/bin/sh",
      args: ["-lc", "printf 'hello replay'; exit 7"],
    });

    expect(response.type).toBe("session");

    await waitFor(() => listReplayInfos().some((info) => info.status === "closed"), 5000);

    const replayInfo = listReplayInfos()[0];
    expect(replayInfo.status).toBe("closed");
    expect(replayInfo.exitCode).toBe(7);

    const manifest = readReplayManifest(replayInfo.replayId);
    expect(manifest).not.toBeNull();
    expect(manifest?.status).toBe("closed");
    expect(manifest?.metadata.exitCode).toBe(7);
    expect(manifest?.stats.eventCount).toBeGreaterThanOrEqual(2);
    expect(manifest?.stats.checkpointCount).toBeGreaterThanOrEqual(1);
    expect(listReplayCheckpoints(replayInfo.replayId).length).toBeGreaterThanOrEqual(1);

    const replayListResponse = await sendRouterCommand({ type: 'list-replays' });
    expect(replayListResponse.type).toBe('replays');
    expect(replayListResponse.replays).toHaveLength(1);

    const snapshotResponse = await sendRouterCommand({
      type: 'replay-snapshot',
      replayId: replayInfo.replayId,
    });
    expect(snapshotResponse.type).toBe('replay-snapshot');
    expect(snapshotResponse.snapshot.screen.visible.some((line: string) => line.includes('hello replay'))).toBe(true);

    const textResponse = await sendRouterCommand({
      type: 'replay-text',
      replayId: replayInfo.replayId,
    });
    expect(textResponse.type).toBe('replay-text');
    expect(textResponse.text).toContain('hello replay');

    const markdownResponse = await sendRouterCommand({
      type: 'replay-markdown',
      replayId: replayInfo.replayId,
    });
    expect(markdownResponse.type).toBe('replay-markdown');
    expect(markdownResponse.markdown).toContain('```terminal');

    const events = readReplayEvents(replayInfo.replayId);
    const outputEvent = events.find((event) => event.type === "output");
    const exitEvent = events.find((event) => event.type === "exit");
    expect(outputEvent?.type).toBe("output");
    expect(outputEvent && outputEvent.type === "output"
      ? Buffer.from(outputEvent.data, "base64").toString("utf-8")
      : "").toContain("hello replay");
    expect(exitEvent).toEqual(expect.objectContaining({ type: "exit", code: 7 }));
  }, 10000);

  test("reconciles running replays as crashed after abrupt server termination", async () => {
    serverProc = await startServer(replayRoot);

    const response = await sendRouterCommand({
      type: "new",
      name: "replay-crash-session",
      cwd: join(import.meta.dir, "../../.."),
      command: "/bin/sh",
      args: ["-lc", "printf 'still running'; sleep 30"],
    });

    expect(response.type).toBe("session");

    await waitFor(() => listReplayInfos({ status: ["running"] }).length === 1, 5000);

    const replayId = listReplayInfos({ status: ["running"] })[0].replayId;
    process.kill(serverProc.pid, "SIGKILL");
    serverProc = null;
    await Bun.sleep(300);

    const runningManifest = readReplayManifest(replayId);
    expect(runningManifest?.status).toBe("running");

    await startServer(replayRoot);
    await waitFor(() => listReplayInfos({ status: ["crashed"] }).some((info) => info.replayId === replayId), 5000);

    const reconciledManifest = readReplayManifest(replayId);
    expect(reconciledManifest?.status).toBe("crashed");
    expect(reconciledManifest?.endedAt).toBeDefined();
  }, 10000);

  test.if(findPngRasterizer() !== null)("captures replay text and png snapshots across timepoints", async () => {
    serverProc = await startServer(replayRoot);

    const response = await sendRouterCommand({
      type: "new",
      name: "replay-timeline-session",
      cwd: join(import.meta.dir, "../../.."),
      command: "/bin/sh",
      args: [
        "-lc",
        "printf '\\033[2J\\033[Hframe zero'; sleep 0.35; printf '\\033[2J\\033[Hframe one'; sleep 0.35; printf '\\033[2J\\033[Hframe two'; exit 0",
      ],
    });

    expect(response.type).toBe("session");

    await waitFor(() => listReplayInfos().some((info) => info.status === "closed" && info.sessionName === "replay-timeline-session"), 5000);

    const replayInfo = listReplayInfos().find((info) => info.sessionName === "replay-timeline-session");
    expect(replayInfo).toBeDefined();

    const checkpointsDir = mkdtempSync(join(tmpdir(), 'gitspace-replay-png-'));
    try {
      const earlyTextResponse = await sendRouterCommand({
        type: 'replay-text',
        replayId: replayInfo!.replayId,
        atMs: 150,
      });
      expect(earlyTextResponse.type).toBe('replay-text');
      expect(earlyTextResponse.text).toContain('frame zero');

      const middleTextResponse = await sendRouterCommand({
        type: 'replay-text',
        replayId: replayInfo!.replayId,
        atMs: 500,
      });
      expect(middleTextResponse.type).toBe('replay-text');
      expect(middleTextResponse.text).toContain('frame one');

      const lateTextResponse = await sendRouterCommand({
        type: 'replay-text',
        replayId: replayInfo!.replayId,
        atMs: 850,
      });
      expect(lateTextResponse.type).toBe('replay-text');
      expect(lateTextResponse.text).toContain('frame two');

      const earlyPng = await writeReplayScreenshot(replayInfo!.replayId, {
        outputPath: join(checkpointsDir, 'frame-zero.png'),
        atMs: 150,
      });
      const middlePng = await writeReplayScreenshot(replayInfo!.replayId, {
        outputPath: join(checkpointsDir, 'frame-one.png'),
        atMs: 500,
      });
      const latePng = await writeReplayScreenshot(replayInfo!.replayId, {
        outputPath: join(checkpointsDir, 'frame-two.png'),
        atMs: 850,
      });

      for (const pngPath of [earlyPng, middlePng, latePng]) {
        expect(existsSync(pngPath)).toBe(true);
        expect(statSync(pngPath).size).toBeGreaterThan(0);
        const dimensions = readPngDimensions(pngPath);
        expect(dimensions.width).toBeGreaterThan(300);
        expect(dimensions.height).toBeGreaterThan(60);
      }
    } finally {
      rmSync(checkpointsDir, { recursive: true, force: true });
    }
  }, 10000);

  test.if(findPngRasterizer() !== null)('keeps replay history available after tmux-lite shutdown', async () => {
    serverProc = await startServer(replayRoot);

    const response = await sendRouterCommand({
      type: 'new',
      name: 'replay-offline-history',
      cwd: join(import.meta.dir, '../../..'),
      command: '/bin/sh',
      args: ['-lc', "printf 'offline replay works'; exit 0"],
    });

    expect(response.type).toBe('session');
    await waitFor(() => listReplayInfos().some((info) => info.sessionName === 'replay-offline-history' && info.status === 'closed'));

    const replay = listReplayInfos().find((info) => info.sessionName === 'replay-offline-history');
    expect(replay).toBeDefined();

    await sendRouterCommand({ type: 'kill-server' });
    await Bun.sleep(200);
    serverProc = null;

    const offlineList = listReplaysOffline();
    expect(offlineList.some((info) => info.replayId === replay!.replayId)).toBe(true);

    const offlineText = await getReplayTextOffline(replay!.replayId);
    expect(offlineText).toContain('offline replay works');

    const screenshotPath = await screenshotReplayOffline(replay!.replayId, {
      outputPath: join(tmpdir(), `offline-replay-${Date.now()}.png`),
    });
    try {
      expect(existsSync(screenshotPath)).toBe(true);
      expect(statSync(screenshotPath).size).toBeGreaterThan(0);
    } finally {
      rmSync(screenshotPath, { force: true });
    }
  }, 10000);

  test('dismisses, restores, and deletes replay lifecycle from durable store', async () => {
    serverProc = await startServer(replayRoot);

    const response = await sendRouterCommand({
      type: 'new',
      name: 'replay-dismiss-lifecycle',
      cwd: join(import.meta.dir, '../../..'),
      command: '/bin/sh',
      args: ['-lc', "printf 'dismiss me'; exit 0"],
    });

    expect(response.type).toBe('session');
    await waitFor(() => listReplayInfos().some((info) => info.sessionName === 'replay-dismiss-lifecycle' && info.status === 'closed'));

    const replay = listReplayInfos().find((info) => info.sessionName === 'replay-dismiss-lifecycle');
    expect(replay).toBeDefined();

    dismissReplay(replay!.replayId, 'integration-test');
    expect(listReplaysOffline().some((info) => info.replayId === replay!.replayId)).toBe(false);

    const hidden = listReplaysOffline({ includeDismissed: true }).find((info) => info.replayId === replay!.replayId);
    expect(hidden?.dismissedBy).toBe('integration-test');
    expect(hidden?.dismissedAt).toBeDefined();

    undismissReplay(replay!.replayId);
    expect(listReplaysOffline().some((info) => info.replayId === replay!.replayId)).toBe(true);

    deleteReplay(replay!.replayId);
    expect(listReplaysOffline({ includeDismissed: true }).some((info) => info.replayId === replay!.replayId)).toBe(false);
    expect(readReplayManifest(replay!.replayId)).toBeNull();
  }, 10000);

  test('does not record replays when recordReplay is false', async () => {
    serverProc = await startServer(replayRoot);

    const response = await sendRouterCommand({
      type: 'new',
      name: 'agent:no-replay',
      cwd: join(import.meta.dir, '../../..'),
      command: '/bin/sh',
      args: ['-lc', 'printf no-replay-test; sleep 1'],
      kind: 'agent',
      hidden: true,
      recordReplay: false,
      metadata: { workspaceId: 'demo:ws-1', agentSessionId: 'agent-1' },
    });

    expect(response.type).toBe('session');
    await Bun.sleep(1500);
    expect(listReplayInfos()).toEqual([]);

    const replayListResponse = await sendRouterCommand({ type: 'list-replays' });
    expect(replayListResponse.type).toBe('replays');
    expect(replayListResponse.replays).toEqual([]);
  }, 10000);
});
