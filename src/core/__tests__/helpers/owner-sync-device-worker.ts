import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createDefaultProjectConfig,
  DEFAULT_NOTIFICATION_CONFIG,
  type NotificationConfig,
  type ProjectConfig,
} from '../../../types/config.js';
import {
  deleteProjectSecret,
  exportSecretsForOwnerSyncSnapshot,
  setProjectSecret,
} from '../../../utils/secrets.js';
import { getGitspaceDir, readGlobalConfig, readProjectConfig, writeGlobalConfig, writeProjectConfig } from '../../config.js';
import { writeRelayConfig } from '../../identity.js';
import { initializeOwnerSync, resetOwnerSyncForTests } from '../../owner-sync.js';
import { initFromMnemonic, loadUserRootIdentity } from '../../user-identity.js';

type WorkerAction =
  | {
      type: 'write_preferences';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      notificationsEnabled: boolean;
      currentProject?: string | null;
    }
  | {
      type: 'write_project';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      projectName: string;
      repository: string;
      linearTeams?: string[];
    }
  | {
      type: 'set_project_secret';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      projectName: string;
      key: string;
      value: string;
    }
  | {
      type: 'delete_project_secret';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      projectName: string;
      key: string;
    }
  | {
      type: 'hydrate';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      projectName?: string;
    }
  | {
      type: 'stage_preferences_conflict';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      notificationsEnabled: boolean;
      currentProject?: string | null;
    }
  | {
      type: 'stage_project_conflict';
      mnemonic: string;
      relayUrl: string;
      machineId: string;
      projectName: string;
      repository: string;
      linearTeams?: string[];
      forceStaleRevision?: boolean;
    };

interface WorkerResult {
  dirtyCategories: string[];
  migrationStatus: string;
  globalConfig: ReturnType<typeof readGlobalConfig>;
  projectConfig: ProjectConfig | null;
  projectSecrets: Record<string, string>;
}

interface OwnerSyncStateShape {
  version?: unknown;
  revisions?: unknown;
  dirtyCategories?: unknown;
  localEnvelopes?: unknown;
  migration?: {
    version?: unknown;
    status?: unknown;
    completedCategories?: unknown;
    lastAttemptAt?: unknown;
    lastError?: unknown;
  };
}

const SYNC_CATEGORIES = ['fundamental', 'integrations', 'project/workspace', 'preferences'] as const;

type SyncCategory = (typeof SYNC_CATEGORIES)[number];

interface MutableOwnerSyncState {
  version: number;
  revisions: Partial<Record<SyncCategory, number>>;
  dirtyCategories: SyncCategory[];
  localEnvelopes: Record<string, unknown>;
  migration: {
    version: number;
    status: 'pending' | 'complete';
    completedCategories: SyncCategory[];
    lastAttemptAt?: number;
    lastError?: string;
  };
}

function isSyncCategory(value: unknown): value is SyncCategory {
  return typeof value === 'string' && (SYNC_CATEGORIES as readonly string[]).includes(value);
}

function loadOwnerSyncStateMutable(): MutableOwnerSyncState {
  const statePath = join(getGitspaceDir(), '.owner-sync-state.json');
  if (!existsSync(statePath)) {
    return {
      version: 1,
      revisions: {},
      dirtyCategories: [],
      localEnvelopes: {},
      migration: {
        version: 1,
        status: 'pending',
        completedCategories: [],
      },
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as OwnerSyncStateShape;

    const revisions: Partial<Record<SyncCategory, number>> = {};
    if (parsed.revisions && typeof parsed.revisions === 'object') {
      for (const category of SYNC_CATEGORIES) {
        const value = (parsed.revisions as Record<string, unknown>)[category];
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
          revisions[category] = value;
        }
      }
    }

    const dirtyCategories = Array.isArray(parsed.dirtyCategories)
      ? parsed.dirtyCategories.filter(isSyncCategory)
      : [];

    const completedCategories = Array.isArray(parsed.migration?.completedCategories)
      ? parsed.migration!.completedCategories.filter(isSyncCategory)
      : [];

    return {
      version: typeof parsed.version === 'number' ? parsed.version : 1,
      revisions,
      dirtyCategories,
      localEnvelopes:
        parsed.localEnvelopes && typeof parsed.localEnvelopes === 'object'
          ? (parsed.localEnvelopes as Record<string, unknown>)
          : {},
      migration: {
        version: typeof parsed.migration?.version === 'number' ? parsed.migration.version : 1,
        status: parsed.migration?.status === 'complete' ? 'complete' : 'pending',
        completedCategories,
        lastAttemptAt:
          typeof parsed.migration?.lastAttemptAt === 'number' ? parsed.migration.lastAttemptAt : undefined,
        lastError: typeof parsed.migration?.lastError === 'string' ? parsed.migration.lastError : undefined,
      },
    };
  } catch {
    return {
      version: 1,
      revisions: {},
      dirtyCategories: [],
      localEnvelopes: {},
      migration: {
        version: 1,
        status: 'pending',
        completedCategories: [],
      },
    };
  }
}

function writeOwnerSyncStateMutable(state: MutableOwnerSyncState): void {
  const statePath = join(getGitspaceDir(), '.owner-sync-state.json');
  writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
}

function readOwnerSyncState(): { dirtyCategories: string[]; migrationStatus: string } {
  const parsed = loadOwnerSyncStateMutable();
  return {
    dirtyCategories: [...parsed.dirtyCategories],
    migrationStatus: parsed.migration.status,
  };
}

async function waitForNoDirtyCategories(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readOwnerSyncState();
    if (state.dirtyCategories.length === 0) {
      return;
    }

    await Bun.sleep(50);
  }

  const state = readOwnerSyncState();
  throw new Error(`Timed out waiting for dirty categories to clear: [${state.dirtyCategories.join(', ')}]`);
}

function buildNotificationConfig(enabled: boolean): NotificationConfig {
  return {
    ...DEFAULT_NOTIFICATION_CONFIG,
    enabled,
    toast: {
      ...DEFAULT_NOTIFICATION_CONFIG.toast,
      enabled,
    },
    types: {
      ...DEFAULT_NOTIFICATION_CONFIG.types,
      bell: enabled,
    },
  };
}

async function ensureDeviceReady(mnemonic: string, relayUrl: string, machineId: string): Promise<void> {
  const existing = await loadUserRootIdentity();
  if (!existing) {
    await initFromMnemonic(mnemonic);
  }

  writeRelayConfig({
    relayUrl,
    machineId,
    savedAt: Date.now(),
  });

  await initializeOwnerSync();
}

function readProjectConfigOrNull(projectName: string | undefined): ProjectConfig | null {
  if (!projectName) {
    return null;
  }

  try {
    return readProjectConfig(projectName);
  } catch {
    return null;
  }
}

async function readProjectSecretsOrEmpty(projectName: string | undefined): Promise<Record<string, string>> {
  if (!projectName) {
    return {};
  }

  const snapshot = await exportSecretsForOwnerSyncSnapshot();
  return { ...(snapshot.projects[projectName] ?? {}) };
}

async function executeAction(action: WorkerAction): Promise<WorkerResult> {
  await ensureDeviceReady(action.mnemonic, action.relayUrl, action.machineId);

  if (action.type === 'write_preferences') {
    const globalConfig = readGlobalConfig();
    globalConfig.notifications = buildNotificationConfig(action.notificationsEnabled);
    if (action.currentProject !== undefined) {
      globalConfig.currentProject = action.currentProject;
    }
    writeGlobalConfig(globalConfig);
    await waitForNoDirtyCategories();
  }

  if (action.type === 'write_project') {
    let projectConfig: ProjectConfig;
    try {
      projectConfig = readProjectConfig(action.projectName);
    } catch {
      projectConfig = createDefaultProjectConfig(action.projectName, action.repository, 'main');
    }

    projectConfig.repository = action.repository;
    projectConfig.linearTeams = action.linearTeams ?? [];
    projectConfig.lastAccessed = new Date().toISOString();
    writeProjectConfig(action.projectName, projectConfig);
    await waitForNoDirtyCategories();
  }

  if (action.type === 'set_project_secret') {
    await setProjectSecret(action.projectName, action.key, action.value);
    await waitForNoDirtyCategories();
  }

  if (action.type === 'delete_project_secret') {
    await deleteProjectSecret(action.projectName, action.key);
    await waitForNoDirtyCategories();
  }

  if (action.type === 'stage_preferences_conflict') {
    const globalConfig = readGlobalConfig();
    globalConfig.notifications = buildNotificationConfig(action.notificationsEnabled);
    if (action.currentProject !== undefined) {
      globalConfig.currentProject = action.currentProject;
    }

    // Stop automatic sync so we can persist a stale local write and force
    // conflict resolution on the next startup sync run.
    resetOwnerSyncForTests();
    writeGlobalConfig(globalConfig);

    const state = loadOwnerSyncStateMutable();
    if (!state.dirtyCategories.includes('preferences')) {
      state.dirtyCategories.push('preferences');
    }
    writeOwnerSyncStateMutable(state);
  }

  if (action.type === 'stage_project_conflict') {
    let projectConfig: ProjectConfig;
    try {
      projectConfig = readProjectConfig(action.projectName);
    } catch {
      projectConfig = createDefaultProjectConfig(action.projectName, action.repository, 'main');
    }

    projectConfig.repository = action.repository;
    projectConfig.linearTeams = action.linearTeams ?? [];
    projectConfig.lastAccessed = new Date().toISOString();

    // Stop automatic sync so we can persist a stale local write and force
    // conflict resolution on the next startup sync run.
    resetOwnerSyncForTests();
    writeProjectConfig(action.projectName, projectConfig);

    const state = loadOwnerSyncStateMutable();
    if (!state.dirtyCategories.includes('project/workspace')) {
      state.dirtyCategories.push('project/workspace');
    }

    if (action.forceStaleRevision === true) {
      const currentRevision = state.revisions['project/workspace'];
      if (typeof currentRevision === 'number' && currentRevision > 0) {
        state.revisions['project/workspace'] = currentRevision - 1;
      }
    }

    writeOwnerSyncStateMutable(state);
  }

  if (action.type === 'hydrate') {
    await waitForNoDirtyCategories();
  }

  const state = readOwnerSyncState();
  const projectName = 'projectName' in action ? action.projectName : undefined;
  return {
    dirtyCategories: state.dirtyCategories,
    migrationStatus: state.migrationStatus,
    globalConfig: readGlobalConfig(),
    projectConfig: readProjectConfigOrNull(projectName),
    projectSecrets: await readProjectSecretsOrEmpty(projectName),
  };
}

async function main(): Promise<void> {
  const raw = process.argv[2];
  if (!raw) {
    throw new Error('Missing worker action payload');
  }

  const action = JSON.parse(raw) as WorkerAction;
  const result = await executeAction(action);
  process.stdout.write(JSON.stringify(result));
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
