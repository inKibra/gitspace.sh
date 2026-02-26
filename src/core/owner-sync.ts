import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { LinearTeamInfo, NotificationConfig, ProjectConfig } from '../types/config.js';
import type { SyncCategory } from '../relay/protocol.js';
import { createDeviceCertificate } from '../lib/tmux-lite/crypto/device-cert.js';
import { open, seal } from '../lib/tmux-lite/crypto/secretbox.js';
import { signMessage } from '../relay/signing.js';
import {
  nodeRelaySocketAdapter,
  RelayRequestClient,
  RelayRequestError,
} from '../relay-client/index.js';
import {
  exportConfigForOwnerSyncSnapshot,
  getGitspaceDir,
  readGlobalConfig,
  writeGlobalConfig,
  writeProjectConfig,
} from './config.js';
import {
  exportSecretsForOwnerSyncSnapshot,
  importSecretsFromOwnerSyncSnapshot,
} from '../utils/secrets.js';
import { readRelayConfig } from './identity.js';
import { loadUserRootIdentity } from './user-identity.js';
import { setOwnerSyncWriteHandler } from './owner-sync-events.js';
import { logger } from '../utils/logger.js';

const OWNER_SYNC_CATEGORIES: SyncCategory[] = [
  'fundamental',
  'integrations',
  'project/workspace',
  'preferences',
];

const OWNER_SYNC_STATE_PATH = join(getGitspaceDir(), '.owner-sync-state.json');
const OWNER_SYNC_STATE_VERSION = 1;
const OWNER_SYNC_MIGRATION_VERSION = 1;
const OWNER_SYNC_KEY_INFO = new TextEncoder().encode('gssh-owner-sync-envelope-v1');
const LOCK_TTL_MS = 15_000;
const LOCK_RETRY_DELAY_MS = 200;
const MAX_PUSH_RETRIES = 3;

const FUNDAMENTAL_SECRET_KEYS = new Set([
  'USER_ROOT_IDENTITY',
  'GITSPACE_TOKEN',
  'relay:signingPrivateKey',
]);

interface TimestampedEntry {
  updatedAt: number;
  value: unknown;
}

interface CategoryEnvelope {
  version: 1;
  values: Record<string, TimestampedEntry>;
}

interface OwnerSyncMigrationState {
  version: number;
  status: 'pending' | 'complete';
  completedCategories: SyncCategory[];
  lastAttemptAt?: number;
  lastError?: string;
}

interface OwnerSyncStateFile {
  version: number;
  revisions: Partial<Record<SyncCategory, number>>;
  dirtyCategories: SyncCategory[];
  localEnvelopes: Partial<Record<SyncCategory, CategoryEnvelope>>;
  migration: OwnerSyncMigrationState;
}

interface InitializedOwnerSyncContext {
  relayUrl: string;
  clientIdentityId: string;
  deviceCertificate: string;
  writerId: string;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  encrypt: (plaintext: Uint8Array) => { ciphertext: string; checksum: string };
  decrypt: (ciphertext: string) => Uint8Array | null;
}

function createWriterId(clientIdentityId: string): string {
  const digest = createHash('sha256').update(clientIdentityId).digest('hex').slice(0, 16);
  return `owner-sync:${digest}:${randomUUID()}`;
}

interface OwnerSyncCompareResult {
  type: 'owner_sync_compare_result';
  serverRevisions: Record<SyncCategory, number>;
  changedCategories: SyncCategory[];
}

interface OwnerSyncPullRecord {
  category: SyncCategory;
  revision: number;
  ciphertext: string;
}

interface OwnerSyncPullResult {
  type: 'owner_sync_pull_result';
  records: OwnerSyncPullRecord[];
}

interface OwnerSyncLockGranted {
  type: 'owner_sync_lock_granted';
  lockId: string;
}

interface OwnerSyncPushResult {
  type: 'owner_sync_push_result';
  revision: number;
}

let initialized = false;
let initializePromise: Promise<void> | null = null;
let syncContext: InitializedOwnerSyncContext | null = null;
let pushQueue: Promise<void> = Promise.resolve();
let relayUnavailableWarningShown = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function deepCloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isSyncCategory(value: unknown): value is SyncCategory {
  return typeof value === 'string' && OWNER_SYNC_CATEGORIES.includes(value as SyncCategory);
}

function uniqueCategories(categories: SyncCategory[]): SyncCategory[] {
  return [...new Set(categories)];
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(',')}]`;
  }

  const objectValue = value as Record<string, unknown>;
  const keys = Object.keys(objectValue).sort((a, b) => a.localeCompare(b));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(objectValue[key])}`).join(',')}}`;
}

function mergeTimestampedValues(
  base: Record<string, TimestampedEntry>,
  incoming: Record<string, TimestampedEntry>,
): Record<string, TimestampedEntry> {
  const merged: Record<string, TimestampedEntry> = { ...base };
  const keys = Object.keys(incoming).sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    const candidate = incoming[key];
    const current = merged[key];
    if (!candidate) {
      continue;
    }

    if (!current) {
      merged[key] = candidate;
      continue;
    }

    if (candidate.updatedAt > current.updatedAt) {
      merged[key] = candidate;
      continue;
    }

    if (candidate.updatedAt < current.updatedAt) {
      continue;
    }

    const candidateSerialized = stableSerialize(candidate.value);
    const currentSerialized = stableSerialize(current.value);
    if (candidateSerialized.localeCompare(currentSerialized) > 0) {
      merged[key] = candidate;
    }
  }

  return merged;
}

function createDefaultMigrationState(): OwnerSyncMigrationState {
  return {
    version: OWNER_SYNC_MIGRATION_VERSION,
    status: 'pending',
    completedCategories: [],
  };
}

function normalizeEnvelope(raw: unknown): CategoryEnvelope | null {
  if (!isRecord(raw)) {
    return null;
  }

  if (raw.version !== 1) {
    return null;
  }

  if (!isRecord(raw.values)) {
    return null;
  }

  const values: Record<string, TimestampedEntry> = {};
  for (const [key, entry] of Object.entries(raw.values)) {
    if (!isRecord(entry)) {
      continue;
    }

    const updatedAt = entry.updatedAt;
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
      continue;
    }

    values[key] = {
      updatedAt,
      value: entry.value,
    };
  }

  return {
    version: 1,
    values,
  };
}

function normalizeMigrationState(raw: unknown): OwnerSyncMigrationState {
  if (!isRecord(raw)) {
    return createDefaultMigrationState();
  }

  if (raw.version !== OWNER_SYNC_MIGRATION_VERSION) {
    return createDefaultMigrationState();
  }

  const status = raw.status === 'complete' ? 'complete' : 'pending';
  const completedCategories = Array.isArray(raw.completedCategories)
    ? uniqueCategories(raw.completedCategories.filter(isSyncCategory))
    : [];

  return {
    version: OWNER_SYNC_MIGRATION_VERSION,
    status,
    completedCategories,
    lastAttemptAt:
      typeof raw.lastAttemptAt === 'number' && Number.isFinite(raw.lastAttemptAt)
        ? raw.lastAttemptAt
        : undefined,
    lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
  };
}

function normalizeStateFile(raw: unknown): OwnerSyncStateFile {
  const normalized: OwnerSyncStateFile = {
    version: OWNER_SYNC_STATE_VERSION,
    revisions: {},
    dirtyCategories: [],
    localEnvelopes: {},
    migration: createDefaultMigrationState(),
  };

  if (!isRecord(raw)) {
    return normalized;
  }

  if (isRecord(raw.revisions)) {
    for (const category of OWNER_SYNC_CATEGORIES) {
      const revision = raw.revisions[category];
      if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 0) {
        normalized.revisions[category] = revision;
      }
    }
  }

  if (Array.isArray(raw.dirtyCategories)) {
    normalized.dirtyCategories = uniqueCategories(raw.dirtyCategories.filter(isSyncCategory));
  }

  if (isRecord(raw.localEnvelopes)) {
    for (const category of OWNER_SYNC_CATEGORIES) {
      const envelope = normalizeEnvelope(raw.localEnvelopes[category]);
      if (envelope) {
        normalized.localEnvelopes[category] = envelope;
      }
    }
  }

  normalized.migration = normalizeMigrationState(raw.migration);
  return normalized;
}

function readStateFile(): OwnerSyncStateFile {
  if (!existsSync(OWNER_SYNC_STATE_PATH)) {
    return normalizeStateFile(null);
  }

  try {
    const parsed = JSON.parse(readFileSync(OWNER_SYNC_STATE_PATH, 'utf-8'));
    return normalizeStateFile(parsed);
  } catch {
    return normalizeStateFile(null);
  }
}

function writeStateFile(state: OwnerSyncStateFile): void {
  const directory = dirname(OWNER_SYNC_STATE_PATH);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
  }

  writeFileSync(OWNER_SYNC_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function addDirtyCategory(state: OwnerSyncStateFile, category: SyncCategory): void {
  if (!state.dirtyCategories.includes(category)) {
    state.dirtyCategories.push(category);
  }
}

function clearDirtyCategory(state: OwnerSyncStateFile, category: SyncCategory): void {
  state.dirtyCategories = state.dirtyCategories.filter((existing) => existing !== category);
}

function parseErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isRelayErrorCode(error: unknown, code: string): boolean {
  return error instanceof RelayRequestError && error.code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function noteRelayUnavailable(error: unknown, context: string): void {
  if (!relayUnavailableWarningShown) {
    logger.warning('Owner sync relay unavailable. Continuing with local state; sync will retry later.');
    relayUnavailableWarningShown = true;
  }

  logger.debug(`[owner-sync] ${context}: ${parseErrorMessage(error)}`);
}

function isFundamentalSecretKey(key: string): boolean {
  return FUNDAMENTAL_SECRET_KEYS.has(key) || key.startsWith('TUNNEL_TOKEN_');
}

function parseLinearTeamInfoArray(value: unknown): LinearTeamInfo[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const teams: LinearTeamInfo[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    if (
      typeof item.id === 'string' &&
      typeof item.key === 'string' &&
      typeof item.name === 'string'
    ) {
      teams.push({ id: item.id, key: item.key, name: item.name });
    }
  }

  return teams;
}

function isNotificationConfigLike(value: unknown): value is NotificationConfig {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.enabled !== 'boolean' || typeof value.minCommandDurationMs !== 'number') {
    return false;
  }

  if (!isRecord(value.types) || !isRecord(value.toast)) {
    return false;
  }

  return (
    typeof value.types.exit === 'boolean' &&
    typeof value.types.idle === 'boolean' &&
    typeof value.types.bell === 'boolean' &&
    typeof value.types.title === 'boolean' &&
    typeof value.types.osc === 'boolean' &&
    typeof value.toast.enabled === 'boolean' &&
    typeof value.toast.holdWhenIdleMs === 'number'
  );
}

function isProjectConfigLike(value: unknown): value is ProjectConfig {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.name === 'string' &&
    typeof value.repository === 'string' &&
    typeof value.baseBranch === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.lastAccessed === 'string'
  );
}

function parseServerRevisions(raw: unknown): Record<SyncCategory, number> {
  const revisions = {
    fundamental: 0,
    integrations: 0,
    'project/workspace': 0,
    preferences: 0,
  } satisfies Record<SyncCategory, number>;

  if (!isRecord(raw)) {
    return revisions;
  }

  for (const category of OWNER_SYNC_CATEGORIES) {
    const revision = raw[category];
    if (typeof revision === 'number' && Number.isInteger(revision) && revision >= 0) {
      revisions[category] = revision;
    }
  }

  return revisions;
}

function parseChangedCategories(raw: unknown): SyncCategory[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return uniqueCategories(raw.filter(isSyncCategory));
}

function parsePullRecords(raw: unknown): OwnerSyncPullRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const records: OwnerSyncPullRecord[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      continue;
    }

    if (!isSyncCategory(item.category)) {
      continue;
    }

    if (
      typeof item.revision !== 'number' ||
      !Number.isInteger(item.revision) ||
      item.revision < 0 ||
      typeof item.ciphertext !== 'string'
    ) {
      continue;
    }

    records.push({
      category: item.category,
      revision: item.revision,
      ciphertext: item.ciphertext,
    });
  }

  return records;
}

function buildEnvelopeFromRawValues(
  rawValues: Record<string, unknown>,
  previous?: CategoryEnvelope,
): CategoryEnvelope {
  const now = Date.now();
  const values: Record<string, TimestampedEntry> = {};
  const keys = Object.keys(rawValues).sort((a, b) => a.localeCompare(b));

  for (const key of keys) {
    const nextValue = rawValues[key] === undefined ? null : rawValues[key];
    const previousEntry = previous?.values[key];
    const updatedAt =
      previousEntry && stableSerialize(previousEntry.value) === stableSerialize(nextValue)
        ? previousEntry.updatedAt
        : now;

    values[key] = {
      updatedAt,
      value: nextValue,
    };
  }

  return {
    version: 1,
    values,
  };
}

function mergeEnvelopes(base: CategoryEnvelope, incoming: CategoryEnvelope): CategoryEnvelope {
  return {
    version: 1,
    values: mergeTimestampedValues(base.values, incoming.values),
  };
}

function createZeroRevisions(): Record<SyncCategory, number> {
  return {
    fundamental: 0,
    integrations: 0,
    'project/workspace': 0,
    preferences: 0,
  };
}

function serializeEnvelope(envelope: CategoryEnvelope): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(envelope));
}

function parseEnvelopeBytes(bytes: Uint8Array): CategoryEnvelope | null {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return normalizeEnvelope(parsed);
  } catch {
    return null;
  }
}

async function initializeContext(): Promise<InitializedOwnerSyncContext | null> {
  const relayUrl = readRelayConfig()?.relayUrl;
  if (!relayUrl) {
    return null;
  }

  const userRoot = await loadUserRootIdentity();
  if (!userRoot) {
    return null;
  }

  const cert = createDeviceCertificate(
    userRoot,
    userRoot.signing.publicKey,
    userRoot.keyExchange.publicKey,
    { label: 'owner-sync' },
  );

  const keyMaterial = userRoot.signing.secretKey.slice(0, 32);
  const salt = new TextEncoder().encode(userRoot.id);
  const envelopeKey = hkdf(sha256, keyMaterial, salt, OWNER_SYNC_KEY_INFO, 32);

  return {
    relayUrl,
    clientIdentityId: userRoot.id,
    deviceCertificate: JSON.stringify(cert),
    writerId: createWriterId(userRoot.id),
    signingPrivateKey: userRoot.signing.secretKey.slice(0, 32),
    signingPublicKey: userRoot.signing.publicKey,
    encrypt: (plaintext) => {
      const checksum = createHash('sha256').update(plaintext).digest('hex');
      const ciphertext = Buffer.from(seal(plaintext, envelopeKey)).toString('base64');
      return { ciphertext, checksum };
    },
    decrypt: (ciphertext) => {
      try {
        const opened = open(Buffer.from(ciphertext, 'base64'), envelopeKey);
        return opened ? new Uint8Array(opened) : null;
      } catch {
        return null;
      }
    },
  };
}

async function requestRelay<T>(
  context: InitializedOwnerSyncContext,
  createPayload: () => Record<string, unknown>,
  onMessage: (msg: Record<string, unknown>) => T | null,
): Promise<T> {
  const client = new RelayRequestClient({
    relayUrl: context.relayUrl,
    socketAdapter: nodeRelaySocketAdapter,
  });

  return client.sendRequest(
    () => {
      const payload = createPayload();
      return signMessage(
        payload,
        context.signingPrivateKey,
        context.signingPublicKey,
      ) as unknown as Record<string, unknown>;
    },
    onMessage,
  );
}

async function compareOwnerSync(
  context: InitializedOwnerSyncContext,
  localRevisions: Partial<Record<SyncCategory, number>>,
): Promise<OwnerSyncCompareResult> {
  return requestRelay(
    context,
    () => ({
      type: 'owner_sync_compare',
      clientIdentityId: context.clientIdentityId,
      deviceCertificate: context.deviceCertificate,
      localRevisions,
    }),
    (msg) => {
      if (msg.type !== 'owner_sync_compare_result') {
        return null;
      }

      return {
        type: 'owner_sync_compare_result',
        serverRevisions: parseServerRevisions(msg.serverRevisions),
        changedCategories: parseChangedCategories(msg.changedCategories),
      };
    },
  );
}

async function pullOwnerSyncCategories(
  context: InitializedOwnerSyncContext,
  categories: SyncCategory[],
): Promise<OwnerSyncPullRecord[]> {
  const result = await requestRelay(
    context,
    () => ({
      type: 'owner_sync_pull',
      clientIdentityId: context.clientIdentityId,
      deviceCertificate: context.deviceCertificate,
      categories,
    }),
    (msg) => {
      if (msg.type !== 'owner_sync_pull_result') {
        return null;
      }

      return {
        type: 'owner_sync_pull_result',
        records: parsePullRecords(msg.records),
      } satisfies OwnerSyncPullResult;
    },
  );

  return result.records;
}

async function lockAndPushCategory(
  context: InitializedOwnerSyncContext,
  category: SyncCategory,
  expectedRevision: number,
  envelope: CategoryEnvelope,
): Promise<number> {
  const lock = await requestRelay(
    context,
    () => ({
      type: 'owner_sync_lock',
      clientIdentityId: context.clientIdentityId,
      deviceCertificate: context.deviceCertificate,
      scope: 'global',
      writerId: context.writerId,
      ttlMs: LOCK_TTL_MS,
    }),
    (msg) => {
      if (msg.type !== 'owner_sync_lock_granted' || typeof msg.lockId !== 'string') {
        return null;
      }

      return {
        type: 'owner_sync_lock_granted',
        lockId: msg.lockId,
      } satisfies OwnerSyncLockGranted;
    },
  );

  const payload = serializeEnvelope(envelope);
  const encrypted = context.encrypt(payload);

  try {
    const pushed = await requestRelay(
      context,
      () => ({
        type: 'owner_sync_push',
        clientIdentityId: context.clientIdentityId,
        deviceCertificate: context.deviceCertificate,
        lockId: lock.lockId,
        record: {
          category,
          expectedRevision,
          updatedAt: Date.now(),
          writerId: context.writerId,
          checksum: encrypted.checksum,
          ciphertext: encrypted.ciphertext,
        },
      }),
      (msg) => {
        if (
          msg.type !== 'owner_sync_push_result' ||
          typeof msg.revision !== 'number' ||
          !Number.isInteger(msg.revision) ||
          msg.revision < 0
        ) {
          return null;
        }

        return {
          type: 'owner_sync_push_result',
          revision: msg.revision,
        } satisfies OwnerSyncPushResult;
      },
    );

    return pushed.revision;
  } finally {
    try {
      await requestRelay(
        context,
        () => ({
          type: 'owner_sync_unlock',
          clientIdentityId: context.clientIdentityId,
          deviceCertificate: context.deviceCertificate,
          lockId: lock.lockId,
        }),
        (msg) => {
          if (msg.type !== 'owner_sync_unlock_result') {
            return null;
          }

          return { type: 'owner_sync_unlock_result' };
        },
      );
    } catch {
      // best effort
    }
  }
}

async function pullCategoryRecord(
  context: InitializedOwnerSyncContext,
  category: SyncCategory,
): Promise<OwnerSyncPullRecord | null> {
  const records = await pullOwnerSyncCategories(context, [category]);
  return records.find((record) => record.category === category) ?? null;
}

async function buildCategoryEnvelopeFromLocal(
  category: SyncCategory,
  previousEnvelope?: CategoryEnvelope,
): Promise<CategoryEnvelope> {
  const configSnapshot = exportConfigForOwnerSyncSnapshot();
  const secretsSnapshot = await exportSecretsForOwnerSyncSnapshot();

  if (category === 'preferences') {
    const rawValues = {
      notifications: deepCloneJson(configSnapshot.globalConfig.notifications ?? null),
    };
    return buildEnvelopeFromRawValues(rawValues, previousEnvelope);
  }

  if (category === 'fundamental') {
    const globalSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(secretsSnapshot.global)) {
      if (isFundamentalSecretKey(key)) {
        globalSecrets[key] = value;
      }
    }

    return buildEnvelopeFromRawValues(
      {
        globalSecrets,
      },
      previousEnvelope,
    );
  }

  if (category === 'integrations') {
    const linearProjectTeams: Record<string, string[]> = {};
    for (const [projectName, projectConfig] of Object.entries(configSnapshot.projectConfigs)) {
      if (Array.isArray(projectConfig.linearTeams)) {
        linearProjectTeams[projectName] = [...projectConfig.linearTeams];
      }
    }

    const integrationSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(secretsSnapshot.global)) {
      if (key.startsWith('linear-api-key')) {
        integrationSecrets[key] = value;
      }
    }

    return buildEnvelopeFromRawValues(
      {
        linearGlobal: {
          linearTeams: deepCloneJson(configSnapshot.globalConfig.linearTeams ?? []),
          linearDefaultTeam: configSnapshot.globalConfig.linearDefaultTeam ?? null,
        },
        linearProjects: linearProjectTeams,
        integrationSecrets,
      },
      previousEnvelope,
    );
  }

  return buildEnvelopeFromRawValues(
    {
      currentProject: configSnapshot.globalConfig.currentProject ?? null,
      projectConfigs: deepCloneJson(configSnapshot.projectConfigs),
      projectSecrets: deepCloneJson(secretsSnapshot.projects),
    },
    previousEnvelope,
  );
}

async function applyCategoryValues(
  category: SyncCategory,
  values: Record<string, TimestampedEntry>,
): Promise<void> {
  if (category === 'preferences') {
    const entry = values.notifications;
    if (!entry) {
      return;
    }

    const globalConfig = readGlobalConfig();
    if (isNotificationConfigLike(entry.value)) {
      globalConfig.notifications = deepCloneJson(entry.value);
    } else {
      globalConfig.notifications = undefined;
    }
    writeGlobalConfig(globalConfig, { notifySync: false });
    return;
  }

  if (category === 'fundamental') {
    const entry = values.globalSecrets;
    if (!entry || !isRecord(entry.value)) {
      return;
    }

    const secrets = await exportSecretsForOwnerSyncSnapshot();
    for (const key of Object.keys(secrets.global)) {
      if (isFundamentalSecretKey(key)) {
        delete secrets.global[key];
      }
    }

    for (const [key, value] of Object.entries(entry.value)) {
      if (typeof value === 'string' && isFundamentalSecretKey(key)) {
        secrets.global[key] = value;
      }
    }

    await importSecretsFromOwnerSyncSnapshot(secrets);
    return;
  }

  if (category === 'integrations') {
    const globalEntry = values.linearGlobal;
    if (globalEntry && isRecord(globalEntry.value)) {
      const globalConfig = readGlobalConfig();
      globalConfig.linearTeams = parseLinearTeamInfoArray(globalEntry.value.linearTeams);
      globalConfig.linearDefaultTeam =
        typeof globalEntry.value.linearDefaultTeam === 'string'
          ? globalEntry.value.linearDefaultTeam
          : undefined;
      writeGlobalConfig(globalConfig, { notifySync: false });
    }

    const projectEntry = values.linearProjects;
    if (projectEntry && isRecord(projectEntry.value)) {
      for (const [projectName, projectTeams] of Object.entries(projectEntry.value)) {
        if (!Array.isArray(projectTeams)) {
          continue;
        }

        const allConfig = exportConfigForOwnerSyncSnapshot();
        const projectConfig = allConfig.projectConfigs[projectName];
        if (!projectConfig) {
          continue;
        }

        projectConfig.linearTeams = projectTeams.filter(
          (teamKey): teamKey is string => typeof teamKey === 'string',
        );
        writeProjectConfig(projectName, projectConfig, { notifySync: false });
      }
    }

    const secretsEntry = values.integrationSecrets;
    if (secretsEntry && isRecord(secretsEntry.value)) {
      const secrets = await exportSecretsForOwnerSyncSnapshot();
      for (const key of Object.keys(secrets.global)) {
        if (key.startsWith('linear-api-key')) {
          delete secrets.global[key];
        }
      }

      for (const [key, value] of Object.entries(secretsEntry.value)) {
        if (typeof value === 'string' && key.startsWith('linear-api-key')) {
          secrets.global[key] = value;
        }
      }

      await importSecretsFromOwnerSyncSnapshot(secrets);
    }

    return;
  }

  const currentProjectEntry = values.currentProject;
  if (currentProjectEntry) {
    const globalConfig = readGlobalConfig();
    globalConfig.currentProject = typeof currentProjectEntry.value === 'string'
      ? currentProjectEntry.value
      : null;
    writeGlobalConfig(globalConfig, { notifySync: false });
  }

  const projectConfigsEntry = values.projectConfigs;
  if (projectConfigsEntry && isRecord(projectConfigsEntry.value)) {
    for (const [projectName, config] of Object.entries(projectConfigsEntry.value)) {
      if (!isProjectConfigLike(config)) {
        continue;
      }

      writeProjectConfig(projectName, deepCloneJson(config), { notifySync: false });
    }
  }

  const projectSecretsEntry = values.projectSecrets;
  if (projectSecretsEntry && isRecord(projectSecretsEntry.value)) {
    const secrets = await exportSecretsForOwnerSyncSnapshot();
    const nextProjects: Record<string, Record<string, string>> = {};
    for (const [projectName, projectValues] of Object.entries(projectSecretsEntry.value)) {
      if (!isRecord(projectValues)) {
        continue;
      }

      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(projectValues)) {
        if (typeof value === 'string') {
          next[key] = value;
        }
      }

      nextProjects[projectName] = next;
    }

    secrets.projects = nextProjects;

    await importSecretsFromOwnerSyncSnapshot(secrets);
  }
}

async function pullAndApplyCategory(
  context: InitializedOwnerSyncContext,
  state: OwnerSyncStateFile,
  category: SyncCategory,
): Promise<void> {
  const record = await pullCategoryRecord(context, category);
  if (!record) {
    state.revisions[category] = 0;
    delete state.localEnvelopes[category];
    clearDirtyCategory(state, category);
    return;
  }

  const plaintext = context.decrypt(record.ciphertext);
  if (!plaintext) {
    throw new Error(`Failed to decrypt owner sync category: ${category}`);
  }

  const envelope = parseEnvelopeBytes(plaintext);
  if (!envelope) {
    throw new Error(`Failed to parse owner sync category envelope: ${category}`);
  }

  await applyCategoryValues(category, envelope.values);
  state.revisions[category] = record.revision;
  state.localEnvelopes[category] = envelope;
  clearDirtyCategory(state, category);
}

async function seedMigrationCategory(
  context: InitializedOwnerSyncContext,
  state: OwnerSyncStateFile,
  category: SyncCategory,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt += 1) {
    const localEnvelope = await buildCategoryEnvelopeFromLocal(category, state.localEnvelopes[category]);
    try {
      const revision = await lockAndPushCategory(context, category, 0, localEnvelope);
      state.revisions[category] = revision;
      state.localEnvelopes[category] = localEnvelope;
      clearDirtyCategory(state, category);
      return;
    } catch (error) {
      if (isRelayErrorCode(error, 'CONFLICT')) {
        await pullAndApplyCategory(context, state, category);
        return;
      }

      if (isRelayErrorCode(error, 'LOCKED')) {
        await delay(LOCK_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error(`Failed to seed owner sync category: ${category}`);
}

function markMigrationCategoryComplete(state: OwnerSyncStateFile, category: SyncCategory): void {
  if (!state.migration.completedCategories.includes(category)) {
    state.migration.completedCategories.push(category);
  }
}

function isMigrationComplete(state: OwnerSyncStateFile): boolean {
  return OWNER_SYNC_CATEGORIES.every((category) =>
    state.migration.completedCategories.includes(category)
  );
}

async function runMigration(
  context: InitializedOwnerSyncContext,
  state: OwnerSyncStateFile,
): Promise<void> {
  if (state.migration.version !== OWNER_SYNC_MIGRATION_VERSION) {
    state.migration = createDefaultMigrationState();
  }

  if (state.migration.status === 'complete' && isMigrationComplete(state)) {
    return;
  }

  state.migration.status = 'pending';
  state.migration.lastAttemptAt = Date.now();
  state.migration.lastError = undefined;
  writeStateFile(state);

  let compareResult: OwnerSyncCompareResult;
  try {
    compareResult = await compareOwnerSync(context, createZeroRevisions());
  } catch (error) {
    state.migration.lastError = parseErrorMessage(error);
    writeStateFile(state);
    throw error;
  }

  for (const category of OWNER_SYNC_CATEGORIES) {
    if (state.migration.completedCategories.includes(category)) {
      continue;
    }

    try {
      const serverRevision = compareResult.serverRevisions[category] ?? 0;
      if (serverRevision > 0) {
        await pullAndApplyCategory(context, state, category);
      } else {
        await seedMigrationCategory(context, state, category);
      }

      markMigrationCategoryComplete(state, category);
      writeStateFile(state);
    } catch (error) {
      state.migration.lastError = parseErrorMessage(error);
      writeStateFile(state);
      throw error;
    }
  }

  if (isMigrationComplete(state)) {
    state.migration.status = 'complete';
    state.migration.lastError = undefined;
  }

  writeStateFile(state);
}

async function pushDirtyCategory(
  context: InitializedOwnerSyncContext,
  state: OwnerSyncStateFile,
  category: SyncCategory,
): Promise<boolean> {
  let expectedRevision = state.revisions[category] ?? 0;
  let pendingEnvelope = await buildCategoryEnvelopeFromLocal(category, state.localEnvelopes[category]);

  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt += 1) {
    try {
      const revision = await lockAndPushCategory(context, category, expectedRevision, pendingEnvelope);
      state.revisions[category] = revision;
      state.localEnvelopes[category] = pendingEnvelope;
      clearDirtyCategory(state, category);
      return true;
    } catch (error) {
      if (isRelayErrorCode(error, 'CONFLICT')) {
        const remoteRecord = await pullCategoryRecord(context, category);
        if (!remoteRecord) {
          expectedRevision = 0;
          continue;
        }

        const remotePayload = context.decrypt(remoteRecord.ciphertext);
        if (!remotePayload) {
          throw new Error(`Failed to decrypt remote sync category for merge: ${category}`);
        }

        const remoteEnvelope = parseEnvelopeBytes(remotePayload);
        if (!remoteEnvelope) {
          throw new Error(`Failed to parse remote sync envelope for merge: ${category}`);
        }

        pendingEnvelope = mergeEnvelopes(remoteEnvelope, pendingEnvelope);
        await applyCategoryValues(category, pendingEnvelope.values);
        state.localEnvelopes[category] = pendingEnvelope;
        expectedRevision = remoteRecord.revision;
        continue;
      }

      if (isRelayErrorCode(error, 'LOCKED')) {
        await delay(LOCK_RETRY_DELAY_MS * attempt);
        continue;
      }

      throw error;
    }
  }

  logger.warning(`Owner sync conflict unresolved for category "${category}"; local changes remain pending.`);
  return false;
}

async function flushDirtyCategories(
  context: InitializedOwnerSyncContext,
  state: OwnerSyncStateFile,
): Promise<void> {
  for (const category of [...state.dirtyCategories]) {
    await pushDirtyCategory(context, state, category);
    writeStateFile(state);
  }
}

async function runRegularSync(
  context: InitializedOwnerSyncContext,
  state: OwnerSyncStateFile,
): Promise<void> {
  await flushDirtyCategories(context, state);

  const compareResult = await compareOwnerSync(context, state.revisions);
  const dirtySet = new Set(state.dirtyCategories);
  const changedSet = new Set(compareResult.changedCategories);
  const synchronizedCategories = new Set<SyncCategory>();
  const categoriesToPull = compareResult.changedCategories.filter((category) => !dirtySet.has(category));

  if (categoriesToPull.length > 0) {
    const pulled = await pullOwnerSyncCategories(context, categoriesToPull);
    const pulledByCategory = new Map<SyncCategory, OwnerSyncPullRecord>();
    for (const record of pulled) {
      pulledByCategory.set(record.category, record);
    }

    for (const category of categoriesToPull) {
      const record = pulledByCategory.get(category);
      if (!record) {
        state.revisions[category] = compareResult.serverRevisions[category];
        delete state.localEnvelopes[category];
        synchronizedCategories.add(category);
        continue;
      }

      const payload = context.decrypt(record.ciphertext);
      if (!payload) {
        logger.warning(`Failed to decrypt owner sync category "${category}" during pull; keeping local value.`);
        continue;
      }

      const envelope = parseEnvelopeBytes(payload);
      if (!envelope) {
        logger.warning(`Failed to parse owner sync category "${category}" during pull; keeping local value.`);
        continue;
      }

      await applyCategoryValues(category, envelope.values);
      state.localEnvelopes[category] = envelope;
      state.revisions[category] = record.revision;
      clearDirtyCategory(state, category);
      synchronizedCategories.add(category);
    }
  }

  for (const category of OWNER_SYNC_CATEGORIES) {
    if (
      !dirtySet.has(category) &&
      (!changedSet.has(category) || synchronizedCategories.has(category))
    ) {
      state.revisions[category] = compareResult.serverRevisions[category];
    }
  }

  writeStateFile(state);
}

async function performStartupSync(context: InitializedOwnerSyncContext): Promise<void> {
  const state = readStateFile();

  if (state.migration.status !== 'complete' || !isMigrationComplete(state)) {
    await runMigration(context, state);
  }

  await runRegularSync(context, state);
  relayUnavailableWarningShown = false;
}

async function onCategoryDirty(category: SyncCategory): Promise<void> {
  const state = readStateFile();
  addDirtyCategory(state, category);
  writeStateFile(state);

  if (!syncContext) {
    return;
  }

  pushQueue = pushQueue
    .catch(() => {
      // ignore previous queued failure
    })
    .then(async () => {
      if (!syncContext) {
        return;
      }

      const latest = readStateFile();
      await flushDirtyCategories(syncContext, latest);
      writeStateFile(latest);
      relayUnavailableWarningShown = false;
    })
    .catch((error) => {
      noteRelayUnavailable(error, `write-through sync (${category})`);
    });

  await pushQueue;
}

export async function initializeOwnerSync(): Promise<void> {
  if (initialized) {
    return;
  }

  if (initializePromise) {
    await initializePromise;
    return;
  }

  initializePromise = (async () => {
    setOwnerSyncWriteHandler((category) => onCategoryDirty(category));

    syncContext = await initializeContext();
    if (!syncContext) {
      initialized = true;
      return;
    }

    try {
      await performStartupSync(syncContext);
    } catch (error) {
      noteRelayUnavailable(error, 'startup sync');
    }

    initialized = true;
  })();

  try {
    await initializePromise;
  } finally {
    initializePromise = null;
  }
}

export function resetOwnerSyncForTests(): void {
  initialized = false;
  initializePromise = null;
  syncContext = null;
  pushQueue = Promise.resolve();
  relayUnavailableWarningShown = false;
  setOwnerSyncWriteHandler(null);
}
