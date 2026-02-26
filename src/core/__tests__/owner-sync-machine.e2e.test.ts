import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateRelayIdentity } from '../../relay/identity.js';
import { startRelayServer } from '../../relay/__tests__/helpers/ports.js';
import {
  connectClient,
  connectMachineWithAuth,
  getSigningKeyBase64,
  sendAndWait,
  signClientMessage,
} from '../../relay/__tests__/helpers/auth.js';
import { ensureControlStore, getVaultCategory, setVaultMeta } from '../../relay/control/store.js';
import { clearAllRegistries } from '../../relay/registries.js';
import { createDeviceCertificate } from '../../lib/tmux-lite/crypto/device-cert.js';
import { createTestIdentity } from '../../lib/tmux-lite/crypto/__tests__/helpers/test-identities.js';
import { generateIdentity } from '../../lib/tmux-lite/crypto/identity.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../../lib/tmux-lite/crypto/user-identity.js';
import type { GlobalConfig, ProjectConfig } from '../../types/config.js';

interface WorkerActionBase {
  mnemonic: string;
  relayUrl: string;
  machineId: string;
}

type WorkerAction =
  | (WorkerActionBase & {
      type: 'write_preferences';
      notificationsEnabled: boolean;
      currentProject?: string | null;
    })
  | (WorkerActionBase & {
      type: 'write_project';
      projectName: string;
      repository: string;
      linearTeams?: string[];
    })
  | (WorkerActionBase & {
      type: 'set_project_secret';
      projectName: string;
      key: string;
      value: string;
    })
  | (WorkerActionBase & {
      type: 'delete_project_secret';
      projectName: string;
      key: string;
    })
  | (WorkerActionBase & {
      type: 'hydrate';
      projectName?: string;
    })
  | (WorkerActionBase & {
      type: 'stage_preferences_conflict';
      notificationsEnabled: boolean;
      currentProject?: string | null;
    })
  | (WorkerActionBase & {
      type: 'stage_project_conflict';
      projectName: string;
      repository: string;
      linearTeams?: string[];
      forceStaleRevision?: boolean;
    });

interface WorkerResult {
  dirtyCategories: string[];
  migrationStatus: string;
  globalConfig: GlobalConfig;
  projectConfig: ProjectConfig | null;
  projectSecrets: Record<string, string>;
}

const RUN_MACHINE_E2E = process.env.OWNER_SYNC_MACHINE_E2E === '1';
const machineE2EDescribe = RUN_MACHINE_E2E ? describe : describe.skip;
const TEST_HOST = '127.0.0.1';
const WORKER_PATH = join(import.meta.dir, 'helpers', 'owner-sync-device-worker.ts');

let previousControlDir: string | undefined;
let tempControlDir = '';
let deviceAHome = '';
let deviceBHome = '';
let relayUrl = '';
let ownerMnemonic = '';
let ownerUserRootId = '';
let machineIdentity = generateIdentity('owner-sync-machine-e2e');
let machineWs: WebSocket | null = null;
let relayServer: Server<any> | null = null;

async function runWorkerAction(homeDir: string, action: WorkerAction): Promise<WorkerResult> {
  const secretsFile = join(homeDir, '.gssh-test-secrets.json');
  const processEnv = {
    ...process.env,
    HOME: homeDir,
    GSSH_TEST_SECRETS_FILE: secretsFile,
    GSSH_ENABLE_TEST_SECRETS_BACKEND: '1',
    GSSH_TEST_RUNTIME: '1',
  } as Record<string, string>;

  const subprocess = Bun.spawn({
    cmd: [process.execPath, WORKER_PATH, JSON.stringify(action)],
    env: processEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`worker failed (${exitCode}): ${stderr || stdout}`);
  }

  return JSON.parse(stdout) as WorkerResult;
}

function buildDeviceCertificate(identity: ReturnType<typeof createTestIdentity>, mnemonic: string): string {
  const ownerUserRoot = mnemonicToUserIdentity(mnemonic);
  return JSON.stringify(
    createDeviceCertificate(
      ownerUserRoot,
      identity.signing.publicKey,
      identity.keyExchange.publicKey,
      { label: 'owner-sync-e2e-client' },
    ),
  );
}

async function assertMachineConnectionFlow(): Promise<void> {
  if (!machineWs) {
    throw new Error('Machine websocket is not connected');
  }
  const machineSocket = machineWs;

  const clientIdentity = createTestIdentity('owner-sync-machine-check');
  const ownerWs = await connectClient(relayUrl);

  const machineConnectedPromise = new Promise<{ connectionId: string }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      machineSocket.removeEventListener('message', handler);
      reject(new Error('Timed out waiting for machine client_connected message'));
    }, 5000);

    const handler = (event: MessageEvent) => {
      try {
        const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
        const msg = JSON.parse(data) as { type?: string; connectionId?: string };
        if (msg.type === 'client_connected' && typeof msg.connectionId === 'string') {
          clearTimeout(timeout);
          machineSocket.removeEventListener('message', handler);
          resolve({ connectionId: msg.connectionId });
        }
      } catch {
        // Ignore parse errors
      }
    };

    machineSocket.addEventListener('message', handler);
  });

  const established = await sendAndWait<{ type: string; connectionId: string }>(
    ownerWs,
    signClientMessage(
      {
        type: 'connect_to_machine',
        machineId: machineIdentity.id,
        clientIdentityId: clientIdentity.id,
        deviceCertificate: buildDeviceCertificate(clientIdentity, ownerMnemonic),
      },
      clientIdentity,
    ),
    'connection_established',
  );

  const machineConnected = await machineConnectedPromise;
  expect(machineConnected.connectionId).toBe(established.connectionId);
  ownerWs.close();
}

beforeEach(async () => {
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;
  tempControlDir = mkdtempSync(join(tmpdir(), 'gssh-owner-sync-machine-control-'));
  deviceAHome = mkdtempSync(join(tmpdir(), 'gssh-owner-sync-machine-device-a-'));
  deviceBHome = mkdtempSync(join(tmpdir(), 'gssh-owner-sync-machine-device-b-'));
  process.env.GITSPACE_CONTROL_DIR = tempControlDir;

  ownerMnemonic = generateMnemonic();
  ownerUserRootId = mnemonicToUserIdentity(ownerMnemonic).id;
  machineIdentity = generateIdentity('owner-sync-machine-e2e');

  clearAllRegistries();
  ensureControlStore();
  setVaultMeta('vault_initialized', '1');
  setVaultMeta('owner_user_root_id', ownerUserRootId);

  relayServer = startRelayServer({
    bind: TEST_HOST,
    hostname: TEST_HOST,
    disableRateLimit: true,
    identity: generateRelayIdentity('owner-sync-machine-e2e-relay'),
    preAuthorizedMachines: new Set([getSigningKeyBase64(machineIdentity)]),
  });

  relayUrl = `ws://${TEST_HOST}:${relayServer.port}/ws`;
  machineWs = await connectMachineWithAuth(relayUrl, machineIdentity, {
    timeoutMs: 8000,
    label: 'owner-sync-machine-e2e',
  });

  await assertMachineConnectionFlow();
});

afterEach(() => {
  machineWs?.close();
  machineWs = null;

  relayServer?.stop(true);
  relayServer = null;

  clearAllRegistries();

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  if (tempControlDir) {
    rmSync(tempControlDir, { recursive: true, force: true });
  }

  if (deviceAHome) {
    rmSync(deviceAHome, { recursive: true, force: true });
  }

  if (deviceBHome) {
    rmSync(deviceBHome, { recursive: true, force: true });
  }
});

machineE2EDescribe('owner sync config flow with live relay/client/machine', () => {
  test('preferences write-through syncs from device A to device B', async () => {
    const machineId = machineIdentity.id;

    const writerResult = await runWorkerAction(deviceAHome, {
      type: 'write_preferences',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      notificationsEnabled: false,
      currentProject: 'project-alpha',
    });

    expect(writerResult.migrationStatus).toBe('complete');
    expect(writerResult.dirtyCategories).toHaveLength(0);

    const hydrateResult = await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
    });

    expect(hydrateResult.migrationStatus).toBe('complete');
    expect(hydrateResult.dirtyCategories).toHaveLength(0);
    expect(hydrateResult.globalConfig.currentProject).toBe('project-alpha');
    expect(hydrateResult.globalConfig.notifications?.enabled).toBe(false);
  });

  test('project/workspace config syncs bidirectionally between devices', async () => {
    const machineId = machineIdentity.id;

    await runWorkerAction(deviceAHome, {
      type: 'write_project',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName: 'alpha',
      repository: 'https://example.com/acme/alpha.git',
      linearTeams: ['ENG'],
    });

    const hydratedOnB = await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName: 'alpha',
    });

    expect(hydratedOnB.projectConfig).toBeTruthy();
    expect(hydratedOnB.projectConfig?.repository).toBe('https://example.com/acme/alpha.git');
    expect(hydratedOnB.projectConfig?.linearTeams).toEqual(['ENG']);

    await runWorkerAction(deviceBHome, {
      type: 'write_project',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName: 'alpha',
      repository: 'https://example.com/acme/alpha.git',
      linearTeams: ['OPS'],
    });

    const hydratedOnA = await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName: 'alpha',
    });

    expect(hydratedOnA.projectConfig).toBeTruthy();
    expect(hydratedOnA.projectConfig?.linearTeams).toEqual(['OPS']);
    expect(hydratedOnA.dirtyCategories).toHaveLength(0);
  });

  test('project secret deletion converges across devices', async () => {
    const machineId = machineIdentity.id;
    const projectName = 'alpha';

    await runWorkerAction(deviceAHome, {
      type: 'set_project_secret',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
      key: 'API_KEY',
      value: 'secret-from-a',
    });

    const hydratedOnB = await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    expect(hydratedOnB.projectSecrets.API_KEY).toBe('secret-from-a');

    await runWorkerAction(deviceBHome, {
      type: 'delete_project_secret',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
      key: 'API_KEY',
    });

    const hydratedOnA = await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    expect(hydratedOnA.projectSecrets.API_KEY).toBeUndefined();
    expect(hydratedOnA.projectSecrets).toEqual({});
    expect(hydratedOnA.dirtyCategories).toHaveLength(0);
  });

  test('stale local preferences conflict converges and clears dirty state', async () => {
    const machineId = machineIdentity.id;

    await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
    });

    await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
    });

    const baseline = getVaultCategory('preferences');
    expect(baseline).not.toBeNull();

    const stagedCurrentProject = 'device-b-staged';
    const staged = await runWorkerAction(deviceBHome, {
      type: 'stage_preferences_conflict',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      notificationsEnabled: false,
      currentProject: stagedCurrentProject,
    });

    expect(staged.migrationStatus).toBe('complete');
    expect(staged.dirtyCategories).toContain('preferences');

    await Bun.sleep(25);
    await runWorkerAction(deviceAHome, {
      type: 'write_preferences',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      notificationsEnabled: true,
      currentProject: 'device-a-remote',
    });

    const afterAWrite = getVaultCategory('preferences');
    expect(afterAWrite).not.toBeNull();
    expect(afterAWrite!.revision).toBeGreaterThan(baseline!.revision);

    const resolvedOnB = await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
    });

    expect(resolvedOnB.dirtyCategories).toHaveLength(0);
    expect(['device-a-remote', stagedCurrentProject, null] as Array<string | null>).toContain(
      resolvedOnB.globalConfig.currentProject,
    );

    const afterBResolve = getVaultCategory('preferences');
    expect(afterBResolve).not.toBeNull();
    expect(afterBResolve!.revision).toBeGreaterThan(afterAWrite!.revision);

    const hydratedOnA = await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
    });

    expect(hydratedOnA.globalConfig.currentProject).toBe(resolvedOnB.globalConfig.currentProject);
    expect(hydratedOnA.globalConfig.notifications?.enabled).toBe(
      resolvedOnB.globalConfig.notifications?.enabled,
    );
    expect(hydratedOnA.dirtyCategories).toHaveLength(0);
  });

  test('stale local project/workspace conflict converges and clears dirty state', async () => {
    const machineId = machineIdentity.id;
    const projectName = 'conflict-project';

    await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    const baseline = getVaultCategory('project/workspace');
    expect(baseline).not.toBeNull();

    const stagedRepository = 'https://example.com/acme/staged-local.git';
    const stagedOnB = await runWorkerAction(deviceBHome, {
      type: 'stage_project_conflict',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
      repository: stagedRepository,
      linearTeams: ['LOCAL'],
    });

    expect(stagedOnB.migrationStatus).toBe('complete');
    expect(stagedOnB.dirtyCategories).toContain('project/workspace');

    await Bun.sleep(100);
    const remoteRepository = 'https://example.com/acme/remote-latest.git';
    await runWorkerAction(deviceAHome, {
      type: 'write_project',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
      repository: remoteRepository,
      linearTeams: ['REMOTE'],
    });

    const afterAWrite = getVaultCategory('project/workspace');
    expect(afterAWrite).not.toBeNull();
    expect(afterAWrite!.revision).toBeGreaterThan(baseline!.revision);

    const resolvedOnB = await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    expect(resolvedOnB.dirtyCategories).toHaveLength(0);
    expect([remoteRepository, stagedRepository] as string[]).toContain(
      resolvedOnB.projectConfig?.repository ?? '',
    );

    const afterBResolve = getVaultCategory('project/workspace');
    expect(afterBResolve).not.toBeNull();
    expect(afterBResolve!.revision).toBeGreaterThan(afterAWrite!.revision);

    const hydratedOnA = await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    expect(hydratedOnA.projectConfig).toBeTruthy();
    expect([remoteRepository, stagedRepository] as string[]).toContain(
      hydratedOnA.projectConfig?.repository ?? '',
    );
    expect([
      JSON.stringify(['REMOTE']),
      JSON.stringify(['LOCAL']),
    ] as string[]).toContain(JSON.stringify(hydratedOnA.projectConfig?.linearTeams ?? []));
    expect(hydratedOnA.dirtyCategories).toHaveLength(0);
    expect(resolvedOnB.dirtyCategories).toHaveLength(0);
  });

  test('project/workspace conflict merges per-key by timestamp', async () => {
    const machineId = machineIdentity.id;
    const projectName = 'key-merge-project';
    const baselineRepository = 'https://example.com/acme/baseline.git';
    const localRepository = 'https://example.com/acme/local-wins.git';
    const remoteCurrentProject = 'remote-current-project';

    // Seed baseline values for both currentProject and projectConfigs keys.
    await runWorkerAction(deviceAHome, {
      type: 'write_project',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
      repository: baselineRepository,
      linearTeams: ['BASE'],
    });

    await runWorkerAction(deviceAHome, {
      type: 'write_preferences',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      notificationsEnabled: true,
      currentProject: remoteCurrentProject,
    });

    await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    const beforeConflict = getVaultCategory('project/workspace');
    expect(beforeConflict).not.toBeNull();

    // Stage local project config change and force stale expected revision.
    const stagedOnB = await runWorkerAction(deviceBHome, {
      type: 'stage_project_conflict',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
      repository: localRepository,
      linearTeams: ['LOCAL'],
      forceStaleRevision: true,
    });

    expect(stagedOnB.dirtyCategories).toContain('project/workspace');

    const resolvedOnB = await runWorkerAction(deviceBHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    // Key-level expectation:
    // - currentProject comes from later remote write
    // - project config comes from later local staged write
    expect(resolvedOnB.globalConfig.currentProject).toBe(remoteCurrentProject);
    expect(resolvedOnB.projectConfig?.repository).toBe(localRepository);
    expect(resolvedOnB.projectConfig?.linearTeams).toEqual(['LOCAL']);
    expect(resolvedOnB.dirtyCategories).toHaveLength(0);

    const afterResolve = getVaultCategory('project/workspace');
    expect(afterResolve).not.toBeNull();
    expect(afterResolve!.revision).toBeGreaterThan(beforeConflict!.revision);

    const hydratedOnA = await runWorkerAction(deviceAHome, {
      type: 'hydrate',
      mnemonic: ownerMnemonic,
      relayUrl,
      machineId,
      projectName,
    });

    expect(hydratedOnA.globalConfig.currentProject).toBe(remoteCurrentProject);
    expect(hydratedOnA.projectConfig?.repository).toBe(localRepository);
    expect(hydratedOnA.projectConfig?.linearTeams).toEqual(['LOCAL']);
    expect(hydratedOnA.dirtyCategories).toHaveLength(0);
  });
});
