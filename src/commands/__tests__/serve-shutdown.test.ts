import { describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRelayConfigPath, readRelayConfig, writeRelayConfig } from '../../core/identity.js';
import { cleanupServeFiles, ensureServeDaemonDir, getServePidFile, getServeSocketPath } from '../../serve/daemon.js';
import { performServeShutdown } from '../serve.js';

let envLock: Promise<void> = Promise.resolve();

async function withIsolatedEnv(run: () => void | Promise<void>): Promise<void> {
  const previous = envLock;
  let release!: () => void;
  envLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const originalHome = process.env.HOME;
  const originalServeDir = process.env.GITSPACE_SERVE_DAEMON_DIR;
  const testDir = mkdtempSync(join(tmpdir(), 'gssh-serve-shutdown-'));

  try {
    process.env.HOME = testDir;
    process.env.GITSPACE_SERVE_DAEMON_DIR = join(testDir, '.serve');
    cleanupServeFiles();
    await run();
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalServeDir === undefined) {
      delete process.env.GITSPACE_SERVE_DAEMON_DIR;
    } else {
      process.env.GITSPACE_SERVE_DAEMON_DIR = originalServeDir;
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    release();
  }
}

describe('performServeShutdown', () => {
  test('preserves cached relay config on normal daemon shutdown', async () => {
    await withIsolatedEnv(async () => {
      writeRelayConfig({
        relayUrl: 'ws://127.0.0.1:4480/ws',
        cloudRelayUrl: 'wss://example.gitspace.sh/ws',
        machineId: 'machine-1',
        savedAt: Date.now(),
      });

      ensureServeDaemonDir();
      writeFileSync(getServePidFile(), '12345');
      writeFileSync(getServeSocketPath(), '');

      const cleanup = mock(() => {});
      const sessionCleanup = mock(async () => {});
      const exit = mock((code: number) => {
        throw new Error(`EXIT:${code}`);
      }) as unknown as (code: number) => never;

      await expect(performServeShutdown({ cleanup: sessionCleanup }, { isDaemon: true, cleanup, exit })).rejects.toThrow('EXIT:0');

      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(sessionCleanup).toHaveBeenCalledTimes(1);
      expect(readRelayConfig()).toEqual(expect.objectContaining({ machineId: 'machine-1' }));
      expect(existsSync(getRelayConfigPath())).toBe(true);
      expect(existsSync(getServePidFile())).toBe(false);
      expect(existsSync(getServeSocketPath())).toBe(false);
    });
  });
});
