/**
 * Control socket round-trip tests.
 *
 * Spins up a real Bun Unix domain socket server (startStatusServer) in-process
 * against a temporary control store, then exercises every control command
 * through the real client helpers.
 *
 * We override GITSPACE_CONTROL_DIR so the store writes to a temp dir and
 * GITSPACE_SERVE_DIR so the socket lands next to it.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  bindControlOwner,
  ensureControlStore,
  upsertCloudWorkspace,
} from '../../relay/control/store.js';
import {
  queryControlMeta,
  sendAssertOwnerCommand,
  sendListCloudWorkspacesCommand,
  startStatusServer,
  stopStatusServer,
  setDaemonState,
  getServeSocketPath,
} from '../../serve/daemon.js';

// ── env override helpers ─────────────────────────────────────────────────────

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let originalServeDaemonDir: string | undefined;
let testDir: string;

function setupTestEnv() {
  originalHome = process.env.HOME;
  originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  originalServeDaemonDir = process.env.GITSPACE_SERVE_DAEMON_DIR;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-ctrl-socket-'));
  process.env.HOME = testDir;
  process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
  process.env.GITSPACE_SERVE_DAEMON_DIR = join(testDir, '.serve');
}

function teardownTestEnv() {
  if (originalHome === undefined) { delete process.env.HOME; } else { process.env.HOME = originalHome; }
  if (originalControlDir === undefined) { delete process.env.GITSPACE_CONTROL_DIR; } else { process.env.GITSPACE_CONTROL_DIR = originalControlDir; }
  if (originalServeDaemonDir === undefined) { delete process.env.GITSPACE_SERVE_DAEMON_DIR; } else { process.env.GITSPACE_SERVE_DAEMON_DIR = originalServeDaemonDir; }
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Send a raw JSON message over the Unix socket and collect the response. */
async function rawSocketRoundtrip(message: object, timeoutMs = 2000): Promise<object> {
  const socketPath = getServeSocketPath();
  return new Promise<object>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket roundtrip timed out')), timeoutMs);
    Bun.connect({
      unix: socketPath,
      socket: {
        data(_socket, data) {
          clearTimeout(timer);
          try {
            resolve(JSON.parse(data.toString()) as object);
          } catch {
            reject(new Error('invalid JSON response'));
          }
        },
        error(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
        connectError(_socket, err) {
          clearTimeout(timer);
          reject(err);
        },
        open(socket) {
          socket.write(JSON.stringify(message));
        },
      },
    }).catch(reject);
  });
}

// ── test suite ───────────────────────────────────────────────────────────────

describe('control socket – control_meta command', () => {
  beforeEach(() => {
    setupTestEnv();
    ensureControlStore();
    setDaemonState({
      version: '0.0.0-test',
      startTime: Date.now(),
      relay: { url: 'ws://test', status: 'connected' },
      clients: 0,
    });
    startStatusServer();
  });

  afterEach(() => {
    stopStatusServer();
    teardownTestEnv();
  });

  test('returns control_meta with unbound owner when no owner is set', async () => {
    const response = await queryControlMeta();
    expect(response).not.toBeNull();
    expect(response!.schemaVersion).toBe(2);
    expect(response!.ownerIdentityId).toBeUndefined();
    expect(response!.updatedAt.length).toBeGreaterThan(0);
  });

  test('returns control_meta with ownerIdentityId after owner is bound', async () => {
    bindControlOwner('test-owner-id');

    const response = await queryControlMeta();
    expect(response).not.toBeNull();
    expect(response!.ownerIdentityId).toBe('test-owner-id');
  });
});

describe('control socket – assert_owner command', () => {
  beforeEach(() => {
    setupTestEnv();
    ensureControlStore();
    setDaemonState({
      version: '0.0.0-test',
      startTime: Date.now(),
      relay: { url: 'ws://test', status: 'connected' },
      clients: 0,
    });
    startStatusServer();
  });

  afterEach(() => {
    stopStatusServer();
    teardownTestEnv();
  });

  test('assert_owner returns error when no owner is bound', async () => {
    const result = await sendAssertOwnerCommand('anyone');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not initialized/i);
  });

  test('assert_owner returns ok for the correct owner', async () => {
    bindControlOwner('real-owner');
    const result = await sendAssertOwnerCommand('real-owner');
    expect(result.success).toBe(true);
  });

  test('assert_owner returns error for a different identity', async () => {
    bindControlOwner('real-owner');
    const result = await sendAssertOwnerCommand('impostor');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch/i);
  });
});

describe('control socket – list_cloud_workspaces command', () => {
  beforeEach(() => {
    setupTestEnv();
    ensureControlStore();
    setDaemonState({
      version: '0.0.0-test',
      startTime: Date.now(),
      relay: { url: 'ws://test', status: 'connected' },
      clients: 0,
    });
    startStatusServer();
  });

  afterEach(() => {
    stopStatusServer();
    teardownTestEnv();
  });

  test('list_cloud_workspaces returns error when called by non-owner identity', async () => {
    bindControlOwner('owner-id');
    const result = await sendListCloudWorkspacesCommand('impostor-id');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mismatch/i);
  });

  test('list_cloud_workspaces returns empty list for owner when no workspaces exist', async () => {
    bindControlOwner('owner-id');
    const result = await sendListCloudWorkspacesCommand('owner-id');
    expect(result.success).toBe(true);
    expect(result.workspaces).toEqual([]);
  });

  test('list_cloud_workspaces returns workspaces for owner', async () => {
    bindControlOwner('owner-id');
    upsertCloudWorkspace({
      id: 'ws-socket-test',
      provider: 'sprites',
      providerWorkspaceId: 'sprite-xyz',
      repo: 'owner/repo',
      branch: 'main',
      status: 'ready',
    });

    const result = await sendListCloudWorkspacesCommand('owner-id');
    expect(result.success).toBe(true);
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces![0].id).toBe('ws-socket-test');
    expect(result.workspaces![0].status).toBe('ready');
  });
});

describe('control socket – unknown command', () => {
  beforeEach(() => {
    setupTestEnv();
    ensureControlStore();
    setDaemonState({
      version: '0.0.0-test',
      startTime: Date.now(),
      relay: { url: 'ws://test', status: 'connected' },
      clients: 0,
    });
    startStatusServer();
  });

  afterEach(() => {
    stopStatusServer();
    teardownTestEnv();
  });

  test('returns error response for unknown command type', async () => {
    const response = await rawSocketRoundtrip({ type: 'totally_unknown_command' }) as { type: string; message?: string };
    expect(response.type).toBe('error');
    expect(response.message).toMatch(/unknown/i);
  });
});
