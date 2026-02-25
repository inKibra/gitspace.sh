/**
 * Cloud lifecycle command tests: stop, resume, destroy.
 *
 * Uses a real temporary control store (SQLite in tmpdir) and
 * INJECTED mock providers (no mock.module) to verify orchestration:
 *   – workspace lookup (missing workspace → error)
 *   – provider call dispatched with correct providerWorkspaceId
 *   – control store status updated after provider call
 *   – event logged for every operation
 *   – provider errors propagate correctly
 *   – destroy is best-effort (tombstones even if provider call fails)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudLifecycleDependencies, CloudLifecycleProvider } from '../cloud.js';
import { cloudDestroy, cloudResume, cloudStop } from '../cloud.js';
import {
  bindControlOwner,
  ensureControlStore,
  getCloudWorkspace,
  listCloudEvents,
  upsertCloudWorkspace,
} from '../../relay/control/store.js';
import type { CloudWorkspaceStatus } from '../../relay/control/types.js';

const OWNER_ID = 'owner-lifecycle-test-001';
const TEST_RELAY_INFO = {
  relayUrl: 'wss://relay.test/ws',
  relaySigningPublicKey: 'A'.repeat(64),
  relayFingerprint: 'fp:AAAAAAAA',
};

const TEST_WORKSPACE_IDENTITY = {
  id: 'machine-lifecycle-test',
  signingPublicKey: 'B'.repeat(64),
  signingSecretKey: 'C'.repeat(128),
  keyExchangePublicKey: 'D'.repeat(64),
  keyExchangePrivateKey: 'E'.repeat(64),
  createdAt: Date.now(),
};

const lifecycleDeps: CloudLifecycleDependencies = {
  identityId: OWNER_ID,
  relayInfo: TEST_RELAY_INFO,
  workspaceIdentity: TEST_WORKSPACE_IDENTITY,
  createEnrollmentInvite: async (workspaceId) => ({
    token: `invite-${workspaceId}`,
    inviteId: `invite-id-${workspaceId}`,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }),
};

// ── mock provider factory ─────────────────────────────────────────────────────

function makeMockProvider(overrides: Partial<{
  stop: (id: string) => Promise<{ providerWorkspaceId: string; status: CloudWorkspaceStatus; rawState: string }>;
  resume: (id: string) => Promise<{ providerWorkspaceId: string; status: CloudWorkspaceStatus; rawState: string }>;
  exec: (id: string, options: { command: string[]; env?: Record<string, string>; dir?: string }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  destroy: (id: string) => Promise<void>;
}> = {}): CloudLifecycleProvider {
  return {
    stopWorkspace: overrides.stop ?? (async (id) => ({ providerWorkspaceId: id, status: 'hibernated', rawState: 'stopped' })),
    resumeWorkspace: overrides.resume ?? (async (id) => ({ providerWorkspaceId: id, status: 'ready', rawState: 'started' })),
    execWorkspaceCommand: overrides.exec ?? (async () => ({ exitCode: 0, stdout: 'ok', stderr: '' })),
    destroyWorkspace: overrides.destroy ?? (async () => {}),
  };
}

// ── env setup ─────────────────────────────────────────────────────────────────

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let testDir: string;

function setup() {
  originalHome = process.env.HOME;
  originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-lifecycle-'));
  process.env.HOME = testDir;
  process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
  ensureControlStore();
  bindControlOwner(OWNER_ID);
}

function teardown() {
  if (originalHome === undefined) { delete process.env.HOME; } else { process.env.HOME = originalHome; }
  if (originalControlDir === undefined) { delete process.env.GITSPACE_CONTROL_DIR; } else { process.env.GITSPACE_CONTROL_DIR = originalControlDir; }
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

function seedWorkspace(id: string, status: CloudWorkspaceStatus = 'ready') {
  upsertCloudWorkspace({
    id,
    provider: 'sprites',
    providerWorkspaceId: `sprite-${id}`,
    repo: 'owner/repo',
    branch: 'main',
    status,
  });
}

function seedWorkspaceWithIdentity(id: string, status: CloudWorkspaceStatus = 'ready') {
  seedWorkspace(id, status);
}

// ── stop ──────────────────────────────────────────────────────────────────────

describe('cloudStop', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('throws for unknown workspace id', async () => {
    await expect(cloudStop('nonexistent', makeMockProvider(), lifecycleDeps)).rejects.toThrow(/not found/i);
  });

  test('calls provider stopWorkspace with providerWorkspaceId', async () => {
    const stopCalls: string[] = [];
    const provider = makeMockProvider({
      stop: async (id) => { stopCalls.push(id); return { providerWorkspaceId: id, status: 'hibernated', rawState: 'stopped' }; },
    });

    seedWorkspace('ws-a');
    await cloudStop('ws-a', provider, lifecycleDeps);

    expect(stopCalls).toHaveLength(1);
    expect(stopCalls[0]).toBe('sprite-ws-a');
  });

  test('updates workspace status to hibernated in control store', async () => {
    seedWorkspace('ws-b');
    await cloudStop('ws-b', makeMockProvider(), lifecycleDeps);
    const ws = getCloudWorkspace('ws-b');
    expect(ws?.status).toBe('hibernated');
  });

  test('logs a workspace_stopped event', async () => {
    seedWorkspace('ws-c');
    await cloudStop('ws-c', makeMockProvider(), lifecycleDeps);
    const events = listCloudEvents({ workspaceId: 'ws-c' });
    expect(events.some((e) => e.eventType === 'workspace_stopped')).toBe(true);
  });

  test('sets workspace status to error when provider call fails', async () => {
    seedWorkspace('ws-d');
    const provider = makeMockProvider({ stop: async () => { throw new Error('sprites api down'); } });
    try { await cloudStop('ws-d', provider, lifecycleDeps); } catch {}
    const ws = getCloudWorkspace('ws-d');
    expect(ws?.status).toBe('error');
  });

  test('propagates provider errors wrapped in SpacesError', async () => {
    seedWorkspace('ws-e');
    const provider = makeMockProvider({ stop: async () => { throw new Error('quota exceeded'); } });
    await expect(cloudStop('ws-e', provider, lifecycleDeps)).rejects.toThrow(/quota exceeded/i);
  });
});

// ── resume ────────────────────────────────────────────────────────────────────

describe('cloudResume', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('throws for unknown workspace id', async () => {
    await expect(cloudResume('nonexistent', makeMockProvider(), lifecycleDeps)).rejects.toThrow(/not found/i);
  });

  test('calls provider resumeWorkspace with providerWorkspaceId', async () => {
    const resumeCalls: string[] = [];
    const provider = makeMockProvider({
      resume: async (id) => { resumeCalls.push(id); return { providerWorkspaceId: id, status: 'ready', rawState: 'started' }; },
    });

    await seedWorkspaceWithIdentity('ws-f', 'hibernated');
    await cloudResume('ws-f', provider, lifecycleDeps);

    expect(resumeCalls).toHaveLength(1);
    expect(resumeCalls[0]).toBe('sprite-ws-f');
  });

  test('sets workspace to bootstrapping after wake and exec', async () => {
    await seedWorkspaceWithIdentity('ws-g', 'hibernated');
    await cloudResume('ws-g', makeMockProvider(), lifecycleDeps);
    const ws = getCloudWorkspace('ws-g');
    expect(ws?.status).toBe('bootstrapping');
  });

  test('logs a workspace_resumed event', async () => {
    await seedWorkspaceWithIdentity('ws-h', 'hibernated');
    await cloudResume('ws-h', makeMockProvider(), lifecycleDeps);
    const events = listCloudEvents({ workspaceId: 'ws-h' });
    expect(events.some((e) => e.eventType === 'workspace_resumed')).toBe(true);
  });

  test('issues unlock token event on resume', async () => {
    await seedWorkspaceWithIdentity('ws-h2', 'hibernated');
    await cloudResume('ws-h2', makeMockProvider(), lifecycleDeps);
    const events = listCloudEvents({ workspaceId: 'ws-h2' });
    expect(events.some((e) => e.eventType === 'unlock_token_issued')).toBe(true);
  });

  test('runs bootstrap exec command after resume', async () => {
    const execCalls: Array<{ id: string; options: { command: string[]; env?: Record<string, string>; dir?: string } }> = [];
    const provider = makeMockProvider({
      exec: async (id, options) => {
        execCalls.push({ id, options });
        return { exitCode: 0, stdout: 'started', stderr: '' };
      },
    });

    await seedWorkspaceWithIdentity('ws-r1', 'hibernated');
    await cloudResume('ws-r1', provider, lifecycleDeps);

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].id).toBe('sprite-ws-r1');
    expect(execCalls[0].options.command[0]).toBe('bash');
    expect(execCalls[0].options.command[1]).toBe('-lc');
    expect(execCalls[0].options.env?.GSSH_WORKSPACE_ID).toBe('ws-r1');
    expect(execCalls[0].options.env?.GSSH_RELAY_URL).toContain('wss://');
    expect(execCalls[0].options.env?.GSSH_RELAY_PUBKEY?.length).toBeGreaterThan(5);
  });

  test('logs resume_exec_succeeded after bootstrap exec success', async () => {
    await seedWorkspaceWithIdentity('ws-r2', 'hibernated');
    await cloudResume('ws-r2', makeMockProvider(), lifecycleDeps);
    const events = listCloudEvents({ workspaceId: 'ws-r2' });
    expect(events.some((e) => e.eventType === 'resume_exec_succeeded')).toBe(true);
  });

  test('treats non-zero bootstrap exec exit code as failure', async () => {
    await seedWorkspaceWithIdentity('ws-r2b', 'hibernated');
    const provider = makeMockProvider({
      exec: async () => ({ exitCode: 127, stdout: '', stderr: 'gssh not found' }),
    });

    await expect(cloudResume('ws-r2b', provider, lifecycleDeps)).rejects.toThrow(/exited with code 127/i);

    const ws = getCloudWorkspace('ws-r2b');
    expect(ws?.status).toBe('error');

    const events = listCloudEvents({ workspaceId: 'ws-r2b' });
    expect(events.some((e) => e.eventType === 'resume_exec_failed')).toBe(true);
  });

  test('sets workspace status to error when resume exec fails', async () => {
    await seedWorkspaceWithIdentity('ws-r3', 'hibernated');
    const provider = makeMockProvider({
      exec: async () => {
        throw new Error('bootstrap command failed');
      },
    });

    await expect(cloudResume('ws-r3', provider, lifecycleDeps)).rejects.toThrow(/bootstrap command failed/i);

    const ws = getCloudWorkspace('ws-r3');
    expect(ws?.status).toBe('error');
  });

  test('logs resume_exec_failed when bootstrap exec fails', async () => {
    await seedWorkspaceWithIdentity('ws-r4', 'hibernated');
    const provider = makeMockProvider({
      exec: async () => {
        throw new Error('could not start gssh machine serve');
      },
    });

    try {
      await cloudResume('ws-r4', provider, lifecycleDeps);
    } catch {
      // expected
    }

    const events = listCloudEvents({ workspaceId: 'ws-r4' });
    expect(events.some((e) => e.eventType === 'resume_exec_failed')).toBe(true);
  });

  test('sets workspace status to error when provider call fails', async () => {
    await seedWorkspaceWithIdentity('ws-i', 'hibernated');
    const provider = makeMockProvider({ resume: async () => { throw new Error('vm wake failed'); } });
    try { await cloudResume('ws-i', provider, lifecycleDeps); } catch {}
    const ws = getCloudWorkspace('ws-i');
    expect(ws?.status).toBe('error');
  });
});

// ── destroy ───────────────────────────────────────────────────────────────────

describe('cloudDestroy', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('throws for unknown workspace id', async () => {
    await expect(cloudDestroy('nonexistent', makeMockProvider(), lifecycleDeps)).rejects.toThrow(/not found/i);
  });

  test('calls provider destroyWorkspace with providerWorkspaceId', async () => {
    const destroyCalls: string[] = [];
    const provider = makeMockProvider({
      destroy: async (id) => { destroyCalls.push(id); },
    });

    seedWorkspace('ws-j');
    await cloudDestroy('ws-j', provider, lifecycleDeps);

    expect(destroyCalls).toHaveLength(1);
    expect(destroyCalls[0]).toBe('sprite-ws-j');
  });

  test('tombstones the workspace in control store (status=destroyed)', async () => {
    seedWorkspace('ws-k');
    await cloudDestroy('ws-k', makeMockProvider(), lifecycleDeps);
    const ws = getCloudWorkspace('ws-k');
    expect(ws?.status).toBe('destroyed');
  });

  test('logs a workspace_destroyed event', async () => {
    seedWorkspace('ws-l');
    await cloudDestroy('ws-l', makeMockProvider(), lifecycleDeps);
    const events = listCloudEvents({ workspaceId: 'ws-l' });
    expect(events.some((e) => e.eventType === 'workspace_destroyed')).toBe(true);
  });

  test('tombstones workspace even when provider call fails (best-effort)', async () => {
    seedWorkspace('ws-m');
    const provider = makeMockProvider({ destroy: async () => { throw new Error('404 not found'); } });
    // Should NOT throw — destroy is best-effort
    await cloudDestroy('ws-m', provider, lifecycleDeps);
    const ws = getCloudWorkspace('ws-m');
    expect(ws?.status).toBe('destroyed');
  });
});
