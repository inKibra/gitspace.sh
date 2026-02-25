import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudDestroy,
  cloudLaunch,
  cloudResume,
  cloudStop,
  type CloudLaunchDependencies,
  type CloudLaunchProvider,
  type CloudLifecycleDependencies,
  type CloudLifecycleProvider,
} from '../cloud.js';
import { SpritesProvider } from '../../relay/control/sprites-provider.js';
import {
  bindControlOwner,
  ensureControlStore,
  getCloudWorkspace,
  listCloudEvents,
} from '../../relay/control/store.js';
import { getSpritesToken } from '../../relay/control/provider-config.js';

const RUN_LIVE = process.env.SPRITES_E2E === '1';
const envToken = process.env.SPRITES_TOKEN?.trim() ?? '';
const keychainToken = RUN_LIVE && !envToken ? await getSpritesToken() : null;
const SPRITES_TOKEN = envToken || keychainToken || '';
const liveDescribe = RUN_LIVE && Boolean(SPRITES_TOKEN) ? describe : describe.skip;

const SPRITES_APP_ID = process.env.SPRITES_APP_ID ?? `gssh-live-cloud-${Date.now().toString(36)}`;
const SPRITES_BASE_URL = process.env.SPRITES_BASE_URL;

const OWNER_ID = 'owner-cloud-live-001';
const RELAY_INFO = {
  relayUrl: 'wss://relay.test/ws',
  relaySigningPublicKey: 'A'.repeat(64),
  relayFingerprint: 'fp:AAAAAAAA',
};
const WORKSPACE_IDENTITY = {
  id: 'machine-cloud-live',
  signingPublicKey: 'B'.repeat(64),
  signingSecretKey: 'C'.repeat(128),
  keyExchangePublicKey: 'D'.repeat(64),
  keyExchangePrivateKey: 'E'.repeat(64),
  createdAt: Date.now(),
};

const LIVE_TIMEOUT_MS = 300_000;
setDefaultTimeout(LIVE_TIMEOUT_MS);

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let testDir: string;

function setupEnv(): void {
  originalHome = process.env.HOME;
  originalControlDir = process.env.GITSPACE_CONTROL_DIR;

  testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-live-'));
  process.env.HOME = testDir;
  process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');

  ensureControlStore();
  bindControlOwner(OWNER_ID);
}

function teardownEnv(): void {
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

function uniqueWorkspaceId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `ws-live-${Date.now().toString(36)}-${rand}`;
}

type LiveCloudProvider = CloudLaunchProvider & CloudLifecycleProvider;

function createLifecycleDeps(): CloudLifecycleDependencies {
  return {
    identityId: OWNER_ID,
    relayInfo: RELAY_INFO,
    workspaceIdentity: WORKSPACE_IDENTITY,
    createEnrollmentInvite: async (workspaceId) => ({
      token: `invite-${workspaceId}`,
      inviteId: `invite-id-${workspaceId}`,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  };
}

liveDescribe('cloud live integration', () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  test('runs cloud launch + stop + resume + destroy with real Sprites', async () => {
    const realProvider = new SpritesProvider({
      token: SPRITES_TOKEN,
      appId: SPRITES_APP_ID,
      baseUrl: SPRITES_BASE_URL,
    });

    const workspaceId = uniqueWorkspaceId();
    const deps = createLifecycleDeps();

    const provider: LiveCloudProvider = {
      createWorkspace: (options) => realProvider.createWorkspace(options),
      // Keep cloud lifecycle deterministic while still using real provider VM state calls.
      execWorkspaceCommand: async () => ({ exitCode: 0, stdout: 'skipped-live-bootstrap', stderr: '' }),
      stopWorkspace: (id) => realProvider.stopWorkspace(id),
      resumeWorkspace: (id) => realProvider.resumeWorkspace(id),
      destroyWorkspace: (id) => realProvider.destroyWorkspace(id),
    };

    const launchDeps: CloudLaunchDependencies = {
      identityId: OWNER_ID,
      relayInfo: RELAY_INFO,
      workspaceIdentity: WORKSPACE_IDENTITY,
      createEnrollmentInvite: deps.createEnrollmentInvite,
      token: SPRITES_TOKEN,
      workspaceId,
      provider,
    };

    let providerWorkspaceId: string | null = null;

    try {
      await cloudLaunch({ repo: 'owner/repo', branch: 'main' }, launchDeps);

      const launched = getCloudWorkspace(workspaceId);
      expect(launched).toBeTruthy();
      expect(launched?.status).toBe('bootstrapping');
      expect(launched?.providerWorkspaceId).toBeTruthy();
      providerWorkspaceId = launched?.providerWorkspaceId ?? null;

      await cloudStop(workspaceId, provider, deps);
      const stopped = getCloudWorkspace(workspaceId);
      expect(['hibernated', 'offline', 'provisioning', 'ready']).toContain(stopped?.status ?? '');

      await cloudResume(workspaceId, provider, deps);
      const resumed = getCloudWorkspace(workspaceId);
      expect(['bootstrapping', 'provisioning', 'hibernated', 'ready', 'offline']).toContain(resumed?.status ?? '');

      await cloudDestroy(workspaceId, provider, deps);
      const destroyed = getCloudWorkspace(workspaceId);
      expect(destroyed?.status).toBe('destroyed');

      const eventTypes = listCloudEvents({ workspaceId }).map((event) => event.eventType);
      expect(eventTypes).toContain('launch_started');
      expect(eventTypes).toContain('vm_created');
      expect(eventTypes).toContain('launch_exec_succeeded');
      expect(eventTypes).toContain('workspace_stopped');
      expect(eventTypes).toContain('workspace_resumed');
      expect(eventTypes).toContain('resume_exec_succeeded');
      expect(eventTypes).toContain('workspace_destroyed');
    } finally {
      const workspace = getCloudWorkspace(workspaceId);
      const spriteId = workspace?.providerWorkspaceId ?? providerWorkspaceId;
      if (spriteId) {
        try {
          await realProvider.destroyWorkspace(spriteId);
        } catch {
          // best effort cleanup for live resources
        }
      }
    }
  });
});
