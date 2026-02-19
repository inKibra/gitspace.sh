/**
 * Workspace CRUD tests for the control store.
 *
 * Tests are written first (test-first approach). The functions they import
 * (upsertCloudWorkspace, updateCloudWorkspaceStatus, logCloudEvent,
 * tombstoneCloudWorkspace, getCloudWorkspace) do not yet exist in store.ts —
 * they will fail to compile until implemented.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureControlStore,
  getCloudWorkspace,
  listCloudWorkspaces,
  logCloudEvent,
  tombstoneCloudWorkspace,
  upsertCloudWorkspace,
  updateCloudWorkspaceStatus,
  listCloudEvents,
} from './store.js';

let originalHome: string | undefined;
let originalControlDirOverride: string | undefined;
let testHomeDir: string;

function makeTestWorkspace(overrides: Partial<{
  id: string;
  providerWorkspaceId: string;
  repo: string;
  branch: string;
}> = {}) {
  return {
    id: overrides.id ?? 'ws-test-1',
    provider: 'sprites' as const,
    providerWorkspaceId: overrides.providerWorkspaceId ?? 'sprite-abc123',
    repo: overrides.repo ?? 'owner/repo',
    branch: overrides.branch ?? 'main',
    status: 'provisioning' as const,
  };
}

describe('workspace CRUD', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-workspace-crud-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
    ensureControlStore();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalControlDirOverride === undefined) {
      delete process.env.GITSPACE_CONTROL_DIR;
    } else {
      process.env.GITSPACE_CONTROL_DIR = originalControlDirOverride;
    }

    if (testHomeDir && existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  test('upsert creates a new workspace record', () => {
    const ws = makeTestWorkspace();
    upsertCloudWorkspace(ws);

    const workspaces = listCloudWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe('ws-test-1');
    expect(workspaces[0].provider).toBe('sprites');
    expect(workspaces[0].providerWorkspaceId).toBe('sprite-abc123');
    expect(workspaces[0].repo).toBe('owner/repo');
    expect(workspaces[0].branch).toBe('main');
    expect(workspaces[0].status).toBe('provisioning');
    expect(workspaces[0].createdAt.length).toBeGreaterThan(0);
    expect(workspaces[0].updatedAt.length).toBeGreaterThan(0);
  });

  test('upsert updates existing workspace record fields', () => {
    const ws = makeTestWorkspace();
    upsertCloudWorkspace(ws);

    // Update with machine info
    upsertCloudWorkspace({
      ...ws,
      machineId: 'machine-xyz',
      machinePublicKey: 'pubkey-abc',
      status: 'bootstrapping',
    });

    const workspaces = listCloudWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].machineId).toBe('machine-xyz');
    expect(workspaces[0].machinePublicKey).toBe('pubkey-abc');
    expect(workspaces[0].status).toBe('bootstrapping');
  });

  test('getCloudWorkspace retrieves a specific workspace by id', () => {
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-a' }));
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-b' }));

    const ws = getCloudWorkspace('ws-a');
    expect(ws).not.toBeUndefined();
    expect(ws!.id).toBe('ws-a');
  });

  test('getCloudWorkspace returns undefined for unknown id', () => {
    const ws = getCloudWorkspace('nonexistent');
    expect(ws).toBeUndefined();
  });

  test('updateCloudWorkspaceStatus changes status and sets updatedAt', async () => {
    upsertCloudWorkspace(makeTestWorkspace());

    // Small delay so updatedAt timestamp changes
    await new Promise((r) => setTimeout(r, 10));

    updateCloudWorkspaceStatus('ws-test-1', 'ready');

    const ws = getCloudWorkspace('ws-test-1');
    expect(ws).not.toBeUndefined();
    expect(ws!.status).toBe('ready');
  });

  test('updateCloudWorkspaceStatus can record an error message', () => {
    upsertCloudWorkspace(makeTestWorkspace());
    updateCloudWorkspaceStatus('ws-test-1', 'error', 'provision failed: quota exceeded');

    const ws = getCloudWorkspace('ws-test-1');
    expect(ws!.status).toBe('error');
    expect(ws!.error).toBe('provision failed: quota exceeded');
  });

  test('updateCloudWorkspaceStatus clears error when status becomes ready', () => {
    upsertCloudWorkspace(makeTestWorkspace());
    updateCloudWorkspaceStatus('ws-test-1', 'error', 'transient failure');
    updateCloudWorkspaceStatus('ws-test-1', 'ready');

    const ws = getCloudWorkspace('ws-test-1');
    expect(ws!.status).toBe('ready');
    expect(ws!.error).toBeUndefined();
  });

  test('tombstoneCloudWorkspace sets status to destroyed', () => {
    upsertCloudWorkspace(makeTestWorkspace());
    tombstoneCloudWorkspace('ws-test-1');

    const ws = getCloudWorkspace('ws-test-1');
    expect(ws!.status).toBe('destroyed');
  });

  test('tombstoned workspaces still appear in listCloudWorkspaces', () => {
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-live' }));
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-dead' }));
    tombstoneCloudWorkspace('ws-dead');

    const all = listCloudWorkspaces();
    expect(all).toHaveLength(2);

    const ids = all.map((w) => w.id);
    expect(ids).toContain('ws-live');
    expect(ids).toContain('ws-dead');
  });

  test('multiple workspaces list in descending updatedAt order', async () => {
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-first' }));
    await new Promise((r) => setTimeout(r, 15));
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-second' }));

    const workspaces = listCloudWorkspaces();
    expect(workspaces[0].id).toBe('ws-second');
    expect(workspaces[1].id).toBe('ws-first');
  });
});

describe('cloud events log', () => {
  beforeEach(() => {
    originalHome = process.env.HOME;
    originalControlDirOverride = process.env.GITSPACE_CONTROL_DIR;
    testHomeDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-events-'));
    process.env.HOME = testHomeDir;
    process.env.GITSPACE_CONTROL_DIR = join(testHomeDir, '.relay', 'control');
    ensureControlStore();
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalControlDirOverride === undefined) {
      delete process.env.GITSPACE_CONTROL_DIR;
    } else {
      process.env.GITSPACE_CONTROL_DIR = originalControlDirOverride;
    }

    if (testHomeDir && existsSync(testHomeDir)) {
      rmSync(testHomeDir, { recursive: true, force: true });
    }
  });

  test('logCloudEvent records a global event (no workspaceId)', () => {
    logCloudEvent({ eventType: 'system_start', message: 'Control plane started' });

    const events = listCloudEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe('system_start');
    expect(events[0].message).toBe('Control plane started');
    expect(events[0].workspaceId).toBeUndefined();
    expect(events[0].createdAt.length).toBeGreaterThan(0);
  });

  test('logCloudEvent records a workspace-scoped event', () => {
    upsertCloudWorkspace(makeTestWorkspace());
    logCloudEvent({
      workspaceId: 'ws-test-1',
      eventType: 'provisioning_started',
      message: 'Sprites VM created',
      metadata: { spriteId: 'sprite-abc123' },
    });

    const events = listCloudEvents({ workspaceId: 'ws-test-1' });
    expect(events).toHaveLength(1);
    expect(events[0].workspaceId).toBe('ws-test-1');
    expect(events[0].eventType).toBe('provisioning_started');
    expect(events[0].metadata).toMatchObject({ spriteId: 'sprite-abc123' });
  });

  test('listCloudEvents filters by workspaceId', () => {
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-a' }));
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-b' }));

    logCloudEvent({ workspaceId: 'ws-a', eventType: 'provisioning_started' });
    logCloudEvent({ workspaceId: 'ws-b', eventType: 'provisioning_started' });
    logCloudEvent({ workspaceId: 'ws-a', eventType: 'ready' });

    const eventsA = listCloudEvents({ workspaceId: 'ws-a' });
    expect(eventsA).toHaveLength(2);
    for (const e of eventsA) {
      expect(e.workspaceId).toBe('ws-a');
    }
  });

  test('listCloudEvents returns all events when no filter is provided', () => {
    upsertCloudWorkspace(makeTestWorkspace({ id: 'ws-x' }));
    logCloudEvent({ eventType: 'system_start' });
    logCloudEvent({ workspaceId: 'ws-x', eventType: 'provisioning_started' });

    const all = listCloudEvents();
    expect(all.length).toBeGreaterThanOrEqual(2);
  });

  test('listCloudEvents respects limit option', () => {
    for (let i = 0; i < 10; i++) {
      logCloudEvent({ eventType: 'tick', message: `tick-${i}` });
    }

    const limited = listCloudEvents({ limit: 3 });
    expect(limited).toHaveLength(3);
  });
});
