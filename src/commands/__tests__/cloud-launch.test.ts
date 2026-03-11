import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudLaunchDependencies, CloudLaunchProvider } from '../cloud.js';
import { cloudLaunch } from '../cloud.js';
import { writeRelayConfig } from '../../core/identity.js';
import {
  bindControlRelayIdentity,
  bindControlOwner,
  ensureControlStore,
  getCloudWorkspace,
  listCloudEvents,
} from '../../relay/control/store.js';

const TEST_OWNER_ID = 'owner-launch-test-001';
const TEST_RELAY_INFO = {
  relayUrl: 'wss://relay.test/ws',
  relaySigningPublicKey: 'A'.repeat(64),
  relayFingerprint: 'fp:AAAAAAAA',
};

const TEST_WORKSPACE_IDENTITY = {
  id: 'machine-launch-test',
  signingPublicKey: 'B'.repeat(64),
  signingSecretKey: 'C'.repeat(128),
  keyExchangePublicKey: 'D'.repeat(64),
  keyExchangePrivateKey: 'E'.repeat(64),
  createdAt: Date.now(),
};

let mockCreateWorkspaceImpl: (opts: Record<string, unknown>) => Promise<{ providerWorkspaceId: string; rawState: string }> =
  async () => ({ providerWorkspaceId: 'sprite-123', rawState: 'running' });
let mockExecImpl: (id: string, opts: Record<string, unknown>) => Promise<{ exitCode: number; stdout: string; stderr: string }> =
  async () => ({ exitCode: 0, stdout: 'started', stderr: '' });
let mockWriteImpl: (id: string, opts: Record<string, unknown>) => Promise<{ path: string; size: number; mode?: string }> =
  async (_id, opts) => ({ path: String(opts.path ?? '/tmp/bootstrap.mjs'), size: 1, mode: '0644' });

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let testDir: string;

function makeLaunchProvider(): CloudLaunchProvider {
  return {
    async createWorkspace(opts) {
      return mockCreateWorkspaceImpl(opts as Record<string, unknown>);
    },
    async execWorkspaceCommand(id, opts) {
      return mockExecImpl(id, opts as Record<string, unknown>);
    },
    async writeWorkspaceFile(id, opts) {
      return mockWriteImpl(id, opts as Record<string, unknown>);
    },
  };
}

function makeDeps(overrides: Partial<CloudLaunchDependencies> = {}): CloudLaunchDependencies {
  return {
    identityId: TEST_OWNER_ID,
    token: 'tok-test',
    relayInfo: TEST_RELAY_INFO,
    workspaceIdentity: TEST_WORKSPACE_IDENTITY,
    provider: makeLaunchProvider(),
    createEnrollmentInvite: async (workspaceId) => ({
      token: `invite-${workspaceId}`,
      inviteId: `invite-id-${workspaceId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    ...overrides,
  };
}

function setup() {
  originalHome = process.env.HOME;
  originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-launch-'));
  process.env.HOME = testDir;
  process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
  ensureControlStore();
  bindControlOwner(TEST_OWNER_ID);

  mockCreateWorkspaceImpl = async () => ({ providerWorkspaceId: 'sprite-123', rawState: 'running' });
  mockExecImpl = async () => ({ exitCode: 0, stdout: 'started', stderr: '' });
  mockWriteImpl = async (_id, opts) => ({ path: String(opts.path ?? '/tmp/bootstrap.mjs'), size: 1, mode: '0644' });
}

function seedSavedRelayConfig(args: { relayUrl: string; cloudRelayUrl?: string }) {
  bindControlRelayIdentity({
    relayIdentityId: 'relay-cloud-launch-test',
    relaySigningPublicKey: TEST_RELAY_INFO.relaySigningPublicKey,
    relayFingerprint: TEST_RELAY_INFO.relayFingerprint,
  });

  writeRelayConfig({
    relayUrl: args.relayUrl,
    cloudRelayUrl: args.cloudRelayUrl,
    machineId: 'machine-saved-relay',
    savedAt: Date.now(),
  });
}

function teardown() {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = originalControlDir;
  }

  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

describe('cloudLaunch', () => {
  beforeEach(setup);
  afterEach(teardown);

  test('creates workspace record in bootstrapping state', async () => {
    let createdWorkspaceId: string | null = null;
    mockCreateWorkspaceImpl = async (opts) => {
      createdWorkspaceId = opts.name as string;
      return { providerWorkspaceId: 'sprite-happy-1', rawState: 'running' };
    };

    await cloudLaunch({ repo: 'owner/repo', branch: 'main' }, makeDeps());

    expect(createdWorkspaceId).toBeTruthy();
    const ws = getCloudWorkspace(createdWorkspaceId!);
    expect(ws?.repo).toBe('owner/repo');
    expect(ws?.branch).toBe('main');
    expect(ws?.provider).toBe('sprites');
    expect(ws?.status).toBe('bootstrapping');
  });

  test('creates machine-first workspace without repo or branch metadata', async () => {
    let createdWorkspaceId: string | null = null;
    let createOptions: Record<string, unknown> | null = null;
    mockCreateWorkspaceImpl = async (opts) => {
      createdWorkspaceId = opts.name as string;
      createOptions = opts;
      return { providerWorkspaceId: 'sprite-machine-first', rawState: 'running' };
    };

    await cloudLaunch({}, makeDeps());

    expect(createOptions).not.toBeNull();
    const resolvedCreateOptions = createOptions!;
    expect(resolvedCreateOptions.repo).toBeUndefined();
    expect(resolvedCreateOptions.branch).toBeUndefined();
    const ws = getCloudWorkspace(createdWorkspaceId!);
    expect(ws?.repo).toBeUndefined();
    expect(ws?.branch).toBeUndefined();
    const launchEvent = listCloudEvents({ workspaceId: createdWorkspaceId! }).find((event) => event.eventType === 'launch_started');
    expect(launchEvent?.message).toMatch(/machine-first workspace/i);
  });

  test('keeps repo metadata when branch is omitted', async () => {
    let createdWorkspaceId: string | null = null;
    let createOptions: Record<string, unknown> | null = null;
    mockCreateWorkspaceImpl = async (opts) => {
      createdWorkspaceId = opts.name as string;
      createOptions = opts;
      return { providerWorkspaceId: 'sprite-repo-only', rawState: 'running' };
    };

    await cloudLaunch({ repo: 'owner/repo' }, makeDeps());

    expect(createOptions).not.toBeNull();
    const resolvedCreateOptions = createOptions!;
    expect(resolvedCreateOptions.repo).toBe('owner/repo');
    expect(resolvedCreateOptions.branch).toBeUndefined();
    const ws = getCloudWorkspace(createdWorkspaceId!);
    expect(ws?.repo).toBe('owner/repo');
    expect(ws?.branch).toBeUndefined();
  });

  test('rejects branch metadata without repo metadata', async () => {
    await expect(cloudLaunch({ branch: 'main' }, makeDeps())).rejects.toThrow(/--branch.*requires.*--repo/i);
  });

  test('logs launch_started and vm_created events on success', async () => {
    let capturedId: string | null = null;
    mockCreateWorkspaceImpl = async (opts) => {
      capturedId = opts.name as string;
      return { providerWorkspaceId: 'sprite-ev-1', rawState: 'running' };
    };

    await cloudLaunch({ repo: 'owner/repo', branch: 'feature' }, makeDeps());

    const events = listCloudEvents({ workspaceId: capturedId! });
    const eventTypes = events.map((e) => e.eventType);
    expect(eventTypes).toContain('launch_started');
    expect(eventTypes).toContain('vm_created');
    expect(eventTypes).toContain('launch_exec_started');
    expect(eventTypes).toContain('launch_exec_succeeded');
  });

  test('bootstrap exec receives expected env variables', async () => {
    const execCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];
    mockExecImpl = async (id, opts) => {
      execCalls.push({ id, opts });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    await cloudLaunch({ repo: 'owner/repo', branch: 'main' }, makeDeps());

    expect(execCalls).toHaveLength(1);
    const env = execCalls[0].opts.env as Record<string, string>;
    expect(env.GSSH_RELAY_URL).toBe('wss://relay.test/ws');
    expect(env.GSSH_WORKSPACE_ID).toBeTruthy();
    expect(env.GSSH_ENROLLMENT_TOKEN).toBeTruthy();
    expect(env.GSSH_UNLOCK_TOKEN).toBeTruthy();
  });

  test('uploads bootstrap bundle to sprite before exec', async () => {
    const writeCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];
    mockWriteImpl = async (id, opts) => {
      writeCalls.push({ id, opts });
      return { path: String(opts.path ?? '/tmp/bootstrap.mjs'), size: 123, mode: '0644' };
    };

    await cloudLaunch({ repo: 'owner/repo', branch: 'main' }, makeDeps());

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]?.opts.path).toBe('/tmp/gssh-cloud-bootstrap.mjs');
    expect(typeof writeCalls[0]?.opts.contents).toBe('string');
  });

  test('throws SpacesError when no sprites token configured', async () => {
    await expect(
      cloudLaunch({ repo: 'owner/repo', branch: 'main' }, makeDeps({ token: '' }))
    ).rejects.toThrow(/sprites token/i);
  });

  test('prefers saved cloud relay URL over local relay URL', async () => {
    const execCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];
    mockExecImpl = async (id, opts) => {
      execCalls.push({ id, opts });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    seedSavedRelayConfig({
      relayUrl: 'ws://127.0.0.1:4480/ws',
      cloudRelayUrl: 'wss://relay.public.test/ws',
    });

    await cloudLaunch(
      { repo: 'owner/repo', branch: 'main' },
      makeDeps({ relayInfo: undefined }),
    );

    const env = execCalls[0]?.opts.env as Record<string, string>;
    expect(env.GSSH_RELAY_URL).toBe('wss://relay.public.test/ws');
  });

  test('falls back to legacy saved relay URL when it is already cloud reachable', async () => {
    const execCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];
    mockExecImpl = async (id, opts) => {
      execCalls.push({ id, opts });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    seedSavedRelayConfig({
      relayUrl: 'wss://relay.legacy.test/ws',
    });

    await cloudLaunch(
      { repo: 'owner/repo', branch: 'main' },
      makeDeps({ relayInfo: undefined }),
    );

    const env = execCalls[0]?.opts.env as Record<string, string>;
    expect(env.GSSH_RELAY_URL).toBe('wss://relay.legacy.test/ws');
  });

  test('ignores invalid saved cloud relay URL and falls back to public relay URL', async () => {
    const execCalls: Array<{ id: string; opts: Record<string, unknown> }> = [];
    mockExecImpl = async (id, opts) => {
      execCalls.push({ id, opts });
      return { exitCode: 0, stdout: 'ok', stderr: '' };
    };

    seedSavedRelayConfig({
      relayUrl: 'wss://relay.legacy.test/ws',
      cloudRelayUrl: 'ws://127.0.0.1:4480/ws',
    });

    await cloudLaunch(
      { repo: 'owner/repo', branch: 'main' },
      makeDeps({ relayInfo: undefined }),
    );

    const env = execCalls[0]?.opts.env as Record<string, string>;
    expect(env.GSSH_RELAY_URL).toBe('wss://relay.legacy.test/ws');
  });

  test('fails when only a local relay URL is saved', async () => {
    seedSavedRelayConfig({
      relayUrl: 'ws://127.0.0.1:4480/ws',
    });

    await expect(
      cloudLaunch(
        { repo: 'owner/repo', branch: 'main' },
        makeDeps({ relayInfo: undefined }),
      ),
    ).rejects.toThrow(/No cloud-reachable relay URL found/i);
  });

  test('leaves workspace in error state when VM creation fails', async () => {
    let capturedId: string | null = null;
    mockCreateWorkspaceImpl = async (opts) => {
      capturedId = opts.name as string;
      throw new Error('Sprites API unavailable');
    };

    await expect(cloudLaunch({ repo: 'owner/repo', branch: 'main' }, makeDeps())).rejects.toThrow(/sprites api unavailable/i);

    const ws = getCloudWorkspace(capturedId!);
    expect(ws?.status).toBe('error');
  });

  test('tombstones workspace when enrollment invite creation fails', async () => {
    const workspaceId = 'ws-enroll-fail';

    await expect(
      cloudLaunch(
        { repo: 'owner/repo', branch: 'main' },
        makeDeps({
          workspaceId,
          createEnrollmentInvite: async () => {
            throw new Error('User root identity is required');
          },
        })
      )
    ).rejects.toThrow(/user root identity/i);

    const ws = getCloudWorkspace(workspaceId);
    expect(ws?.status).toBe('destroyed');
  });
});
