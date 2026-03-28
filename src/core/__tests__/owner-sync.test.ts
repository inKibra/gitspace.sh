import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Server } from 'bun';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { GlobalConfig, NotificationConfig, ProjectConfig } from '../../types/config.js';
import { seal } from '../../lib/tmux-lite/crypto/secretbox.js';

interface OwnerSyncSecretsSnapshot {
  global: Record<string, string>;
  projects: Record<string, Record<string, string>>;
}

let secretsSnapshot: OwnerSyncSecretsSnapshot = {
  global: {},
  projects: {},
};

const mockGitspaceDir = mkdtempSync(join(tmpdir(), 'gssh-owner-sync-gitspace-'));

let mockGlobalConfig: GlobalConfig = {
  currentProject: null,
  projectsDir: mockGitspaceDir,
  defaultBaseBranch: 'main',
  staleDays: 30,
};

let mockProjectConfigs: Record<string, ProjectConfig> = {};

function resetMockConfigState(): void {
  mockGlobalConfig = {
    currentProject: null,
    projectsDir: mockGitspaceDir,
    defaultBaseBranch: 'main',
    staleDays: 30,
  };
  mockProjectConfigs = {};
}

function cloneSecretsSnapshot(snapshot: OwnerSyncSecretsSnapshot): OwnerSyncSecretsSnapshot {
  const projects: Record<string, Record<string, string>> = {};
  for (const [projectName, values] of Object.entries(snapshot.projects)) {
    projects[projectName] = { ...values };
  }

  return {
    global: { ...snapshot.global },
    projects,
  };
}

mock.module('../../utils/secrets.js', () => ({
  getSecret: async (key: string): Promise<string | null> => {
    return secretsSnapshot.global[key] ?? null;
  },
  setSecret: async (key: string, value: string): Promise<void> => {
    secretsSnapshot.global[key] = value;
  },
  deleteSecret: async (key: string): Promise<boolean> => {
    if (!(key in secretsSnapshot.global)) {
      return false;
    }

    delete secretsSnapshot.global[key];
    return true;
  },
  exportSecretsForOwnerSyncSnapshot: async (): Promise<OwnerSyncSecretsSnapshot> => {
    return cloneSecretsSnapshot(secretsSnapshot);
  },
  importSecretsFromOwnerSyncSnapshot: async (snapshot: OwnerSyncSecretsSnapshot): Promise<void> => {
    secretsSnapshot = cloneSecretsSnapshot(snapshot);
  },
}));

mock.module('../../core/config.js', () => ({
  getGitspaceDir: (): string => mockGitspaceDir,
  getSpacesDir: (): string => mockGitspaceDir,
  readGlobalConfig: (): GlobalConfig => {
    return JSON.parse(JSON.stringify(mockGlobalConfig)) as GlobalConfig;
  },
  writeGlobalConfig: (config: GlobalConfig): void => {
    mockGlobalConfig = JSON.parse(JSON.stringify(config)) as GlobalConfig;
  },
  writeProjectConfig: (projectName: string, config: ProjectConfig): void => {
    mockProjectConfigs[projectName] = JSON.parse(JSON.stringify(config)) as ProjectConfig;
  },
  exportConfigForOwnerSyncSnapshot: () => {
    const projectConfigs: Record<string, ProjectConfig> = {};
    for (const [projectName, config] of Object.entries(mockProjectConfigs)) {
      projectConfigs[projectName] = JSON.parse(JSON.stringify(config)) as ProjectConfig;
    }

    return {
      globalConfig: JSON.parse(JSON.stringify(mockGlobalConfig)) as GlobalConfig,
      projectConfigs,
    };
  },
}));

const { initializeOwnerSync, resetOwnerSyncForTests } = await import('../owner-sync.js');
const { generateNewMnemonic, initFromMnemonic } = await import('../user-identity.js');
const {
  readGlobalConfig,
  writeGlobalConfig,
  writeProjectConfig,
} = await import('../config.js');
const { getConfigRoot } = await import('../paths.js');
const { writeRelayConfig } = await import('../identity.js');
const { generateRelayIdentity } = await import('../../relay/identity.js');
const { startRelayServer } = await import('../../relay/__tests__/helpers/ports.js');
const {
  ensureControlStore,
  getVaultCategory,
  setVaultMeta,
  upsertVaultCategory,
} = await import('../../relay/control/store.js');
const { clearAllRegistries } = await import('../../relay/registries.js');
const { notifyOwnerSyncCategoryDirty } = await import('../owner-sync-events.js');

const OWNER_SYNC_INFO = new TextEncoder().encode('gssh-owner-sync-envelope-v1');
const HOST = '127.0.0.1';

let previousControlDir: string | undefined;
let tempControlDir = '';
let server: Server<any> | null = null;

function stateFilePath(): string {
  return join(getConfigRoot(), '.owner-sync-state.json');
}

function readOwnerSyncState(): {
  migration: { status: string; completedCategories: string[]; lastError?: string };
  dirtyCategories: string[];
} {
  return JSON.parse(readFileSync(stateFilePath(), 'utf-8')) as {
    migration: { status: string; completedCategories: string[]; lastError?: string };
    dirtyCategories: string[];
  };
}

function makeNotificationConfig(enabled: boolean): NotificationConfig {
  return {
    enabled,
    minCommandDurationMs: 1000,
    types: {
      exit: true,
      idle: true,
      bell: false,
      title: true,
      osc: false,
    },
    toast: {
      enabled,
      holdWhenIdleMs: 5000,
    },
  };
}

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const candidate = createServer();
    candidate.once('error', reject);
    candidate.listen(0, HOST, () => {
      const address = candidate.address();
      if (!address || typeof address === 'string') {
        candidate.close();
        reject(new Error('Failed to reserve TCP port'));
        return;
      }

      const port = address.port;
      candidate.close((closeError) => {
        if (closeError) {
          reject(closeError);
          return;
        }

        resolve(port);
      });
    });
  });
}

function startRelay(ownerUserRootId: string, port?: number): string {
  const relayIdentity = generateRelayIdentity('owner-sync-test-relay');
  server = startRelayServer({
    bind: HOST,
    hostname: HOST,
    disableRateLimit: true,
    identity: relayIdentity,
    preAuthorizedMachines: new Set<string>(),
    port,
  });

  setVaultMeta('vault_initialized', '1');
  setVaultMeta('owner_user_root_id', ownerUserRootId);

  return `ws://${HOST}:${server.port}/ws`;
}

function stopRelay(): void {
  if (server) {
    server.stop(true);
    server = null;
  }
}

function buildRemoteEnvelopeCiphertext(
  userRootId: string,
  signingSecretKey: Uint8Array,
  values: Record<string, unknown>,
): { ciphertext: string; checksum: string } {
  const keyMaterial = signingSecretKey.slice(0, 32);
  const salt = new TextEncoder().encode(userRootId);
  const envelopeKey = hkdf(sha256, keyMaterial, salt, OWNER_SYNC_INFO, 32);
  const payload = new TextEncoder().encode(JSON.stringify({
    version: 1,
    values,
  }));
  const ciphertext = Buffer.from(seal(payload, envelopeKey)).toString('base64');
  const checksum = createHash('sha256').update(payload).digest('hex');
  return { ciphertext, checksum };
}

async function waitForCondition(
  predicate: () => boolean,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const intervalMs = options.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error('Timed out waiting for condition');
}

beforeEach(() => {
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;
  tempControlDir = mkdtempSync(join(tmpdir(), 'gssh-owner-sync-control-'));
  process.env.GITSPACE_CONTROL_DIR = tempControlDir;

  rmSync(mockGitspaceDir, { recursive: true, force: true });
  mkdirSync(mockGitspaceDir, { recursive: true });

  resetMockConfigState();
  secretsSnapshot = { global: {}, projects: {} };
  clearAllRegistries();
  ensureControlStore();
  resetOwnerSyncForTests();
});

afterEach(() => {
  stopRelay();
  resetOwnerSyncForTests();
  clearAllRegistries();
  secretsSnapshot = { global: {}, projects: {} };

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  if (tempControlDir) {
    rmSync(tempControlDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(mockGitspaceDir, { recursive: true, force: true });
});

describe('owner sync migration', () => {
  test('first run migrates local state to relay and marks migration complete', async () => {
    const userRoot = await initFromMnemonic(generateNewMnemonic());
    const relayUrl = startRelay(userRoot.id);

    writeRelayConfig({
      relayUrl,
      machineId: 'test-machine',
      savedAt: Date.now(),
    });

    const globalConfig = readGlobalConfig();
    globalConfig.currentProject = 'alpha';
    globalConfig.linearDefaultTeam = 'ENG';
    globalConfig.linearTeams = [{ id: 'team-1', key: 'ENG', name: 'Engineering' }];
    globalConfig.notifications = makeNotificationConfig(true);
    writeGlobalConfig(globalConfig, { notifySync: false });

    writeProjectConfig('alpha', {
      name: 'alpha',
      repository: 'https://example.com/acme/alpha.git',
      baseBranch: 'main',
      linearTeams: ['ENG'],
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
    }, { notifySync: false });

    secretsSnapshot.global.GITSPACE_TOKEN = 'token-123';
    secretsSnapshot.global['linear-api-key'] = 'lin-123';
    secretsSnapshot.projects.alpha = { API_KEY: 'project-secret' };

    await initializeOwnerSync();

    const state = readOwnerSyncState();
    expect(state.migration.status).toBe('complete');
    expect(state.migration.completedCategories.sort()).toEqual([
      'fundamental',
      'integrations',
      'preferences',
      'project/workspace',
    ].sort());

    expect(getVaultCategory('fundamental')).not.toBeNull();
    expect(getVaultCategory('integrations')).not.toBeNull();
    expect(getVaultCategory('project/workspace')).not.toBeNull();
    expect(getVaultCategory('preferences')).not.toBeNull();
  });

  test('relay wins for existing category data during first migration', async () => {
    const userRoot = await initFromMnemonic(generateNewMnemonic());
    const relayUrl = startRelay(userRoot.id);

    writeRelayConfig({
      relayUrl,
      machineId: 'test-machine',
      savedAt: Date.now(),
    });

    const localConfig = readGlobalConfig();
    localConfig.notifications = makeNotificationConfig(false);
    writeGlobalConfig(localConfig, { notifySync: false });

    const remoteNotification = makeNotificationConfig(true);
    const { ciphertext, checksum } = buildRemoteEnvelopeCiphertext(
      userRoot.id,
      userRoot.signing.secretKey,
      {
        notifications: {
          updatedAt: Date.now(),
          value: remoteNotification,
        },
      },
    );

    upsertVaultCategory({
      category: 'preferences',
      encryptedEnvelope: ciphertext,
      writerId: 'remote-seed',
      checksum,
      expectedRevision: 0,
    });

    await initializeOwnerSync();

    const mergedConfig = readGlobalConfig();
    expect(mergedConfig.notifications).toEqual(remoteNotification);

    const state = readOwnerSyncState();
    expect(state.migration.status).toBe('complete');
    expect(state.migration.completedCategories).toContain('preferences');
  });

  test('relay project secret map replaces stale local project secret entries', async () => {
    const userRoot = await initFromMnemonic(generateNewMnemonic());
    const relayUrl = startRelay(userRoot.id);

    writeRelayConfig({
      relayUrl,
      machineId: 'test-machine',
      savedAt: Date.now(),
    });

    secretsSnapshot.projects = {
      alpha: { LOCAL_KEY: 'local-value' },
      beta: { STALE_KEY: 'stale-value' },
    };

    const { ciphertext, checksum } = buildRemoteEnvelopeCiphertext(
      userRoot.id,
      userRoot.signing.secretKey,
      {
        projectSecrets: {
          updatedAt: Date.now(),
          value: {
            alpha: {
              REMOTE_KEY: 'remote-value',
            },
          },
        },
      },
    );

    upsertVaultCategory({
      category: 'project/workspace',
      encryptedEnvelope: ciphertext,
      writerId: 'remote-seed',
      checksum,
      expectedRevision: 0,
    });

    await initializeOwnerSync();

    expect(secretsSnapshot.projects).toEqual({
      alpha: { REMOTE_KEY: 'remote-value' },
    });
  });

  test('offline migration stays pending and resumes when relay becomes available', async () => {
    const userRoot = await initFromMnemonic(generateNewMnemonic());
    const reservedPort = await reservePort();
    const relayUrl = `ws://${HOST}:${reservedPort}/ws`;

    writeRelayConfig({
      relayUrl,
      machineId: 'test-machine',
      savedAt: Date.now(),
    });

    const globalConfig = readGlobalConfig();
    globalConfig.notifications = makeNotificationConfig(true);
    globalConfig.currentProject = 'offline-project';
    writeGlobalConfig(globalConfig, { notifySync: false });

    await initializeOwnerSync();

    let state = readOwnerSyncState();
    expect(state.migration.status).toBe('pending');

    const updatedGlobal = readGlobalConfig();
    updatedGlobal.notifications = makeNotificationConfig(false);
    writeGlobalConfig(updatedGlobal);
    notifyOwnerSyncCategoryDirty('preferences');

    state = readOwnerSyncState();
    expect(state.dirtyCategories).toContain('preferences');

    stopRelay();
    const runningRelayUrl = startRelay(userRoot.id, reservedPort);
    expect(runningRelayUrl).toBe(relayUrl);

    resetOwnerSyncForTests();
    await initializeOwnerSync();

    state = readOwnerSyncState();
    expect(state.migration.status).toBe('complete');
    expect(state.dirtyCategories).toEqual([]);
    expect(getVaultCategory('preferences')).not.toBeNull();
  });

  test('conflict retries pull/merge/push and clears dirty category', async () => {
    const userRoot = await initFromMnemonic(generateNewMnemonic());
    const relayUrl = startRelay(userRoot.id);

    writeRelayConfig({
      relayUrl,
      machineId: 'test-machine',
      savedAt: Date.now(),
    });

    const initialConfig = readGlobalConfig();
    initialConfig.notifications = makeNotificationConfig(false);
    writeGlobalConfig(initialConfig, { notifySync: false });

    await initializeOwnerSync();

    const baseline = getVaultCategory('preferences');
    expect(baseline).not.toBeNull();

    const remoteNotification = makeNotificationConfig(true);
    const remoteSeed = buildRemoteEnvelopeCiphertext(
      userRoot.id,
      userRoot.signing.secretKey,
      {
        notifications: {
          updatedAt: Date.now() + 60_000,
          value: remoteNotification,
        },
      },
    );

    upsertVaultCategory({
      category: 'preferences',
      encryptedEnvelope: remoteSeed.ciphertext,
      writerId: 'external-writer',
      checksum: remoteSeed.checksum,
      expectedRevision: baseline!.revision,
    });

    const localNotification = makeNotificationConfig(false);
    localNotification.types.bell = true;
    const localConfig = readGlobalConfig();
    localConfig.notifications = localNotification;
    writeGlobalConfig(localConfig);
    notifyOwnerSyncCategoryDirty('preferences');

    await waitForCondition(() => {
      const state = readOwnerSyncState();
      const category = getVaultCategory('preferences');
      return (
        !state.dirtyCategories.includes('preferences') &&
        Boolean(category) &&
        category!.revision >= baseline!.revision + 2
      );
    });

    const finalState = readOwnerSyncState();
    expect(finalState.dirtyCategories).not.toContain('preferences');

    const finalConfig = readGlobalConfig();
    expect(finalConfig.notifications).toEqual(remoteNotification);
  });

  test('writer id is unique across owner-sync reinitialization', async () => {
    const userRoot = await initFromMnemonic(generateNewMnemonic());
    const relayUrl = startRelay(userRoot.id);

    writeRelayConfig({
      relayUrl,
      machineId: 'test-machine',
      savedAt: Date.now(),
    });

    const globalConfig = readGlobalConfig();
    globalConfig.notifications = makeNotificationConfig(false);
    writeGlobalConfig(globalConfig, { notifySync: false });

    await initializeOwnerSync();

    const firstRecord = getVaultCategory('preferences');
    expect(firstRecord).not.toBeNull();
    const firstWriterId = firstRecord!.writerId;

    resetOwnerSyncForTests();
    await initializeOwnerSync();

    const updatedConfig = readGlobalConfig();
    updatedConfig.notifications = makeNotificationConfig(true);
    writeGlobalConfig(updatedConfig, { notifySync: false });
    notifyOwnerSyncCategoryDirty('preferences');

    await waitForCondition(() => {
      const currentRecord = getVaultCategory('preferences');
      return Boolean(currentRecord) && currentRecord!.revision > firstRecord!.revision;
    });

    const secondRecord = getVaultCategory('preferences');
    expect(secondRecord).not.toBeNull();
    expect(secondRecord!.writerId).not.toBe(firstWriterId);
  });
});
