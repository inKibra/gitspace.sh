/**
 * Secure secrets management using Bun.secrets API.
 *
 * Current format: a SINGLE unified keychain entry containing both global
 * and project-scoped secret maps.
 *
 * Legacy formats still supported for reads/migration:
 * - project blobs: project:<name>
 * - global blob: global
 * - very old per-secret keys: <project>:<key> and <key>
 */

const SERVICE_NAME = 'com.gitspace';

// Keychain entry names
const UNIFIED_SECRETS_KEY = 'secrets';
const PROJECT_SECRETS_PREFIX = 'project:';
const GLOBAL_SECRETS_KEY = 'global';

interface UnifiedSecretsBlob {
  global: Record<string, string>;
  projects: Record<string, Record<string, string>>;
  metadata: {
    schemaVersion: number;
    legacyMigrationComplete: boolean;
    legacyEntriesRetained: boolean;
  };
}

const UNIFIED_SECRETS_SCHEMA_VERSION = 2;

// In-memory cache for unified secrets blob
let unifiedSecretsCache: UnifiedSecretsBlob | null = null;

// Process-level marker used for reminders about legacy cleanup.
let legacyEntriesDetected = false;
const legacyProjectBlobChecked = new Set<string>();
let legacyGlobalBlobChecked = false;

function createEmptyBlob(): UnifiedSecretsBlob {
  return {
    global: {},
    projects: {},
    metadata: {
      schemaVersion: UNIFIED_SECRETS_SCHEMA_VERSION,
      legacyMigrationComplete: false,
      legacyEntriesRetained: false,
    },
  };
}

function normalizeRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object') {
    return {};
  }

  const output: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') {
      output[key] = raw;
    }
  }
  return output;
}

function parseUnifiedSecretsBlob(raw: string | null): UnifiedSecretsBlob {
  if (!raw) {
    return createEmptyBlob();
  }

  try {
    const parsed = JSON.parse(raw) as {
      global?: unknown;
      projects?: unknown;
      metadata?: unknown;
    };

    const projects: Record<string, Record<string, string>> = {};
    if (parsed.projects && typeof parsed.projects === 'object') {
      for (const [projectName, projectSecrets] of Object.entries(parsed.projects as Record<string, unknown>)) {
        projects[projectName] = normalizeRecord(projectSecrets);
      }
    }

    const metadata =
      parsed.metadata && typeof parsed.metadata === 'object'
        ? (parsed.metadata as {
            schemaVersion?: unknown;
            legacyMigrationComplete?: unknown;
            legacyEntriesRetained?: unknown;
          })
        : {};

    return {
      global: normalizeRecord(parsed.global),
      projects,
      metadata: {
        schemaVersion:
          typeof metadata.schemaVersion === 'number' && Number.isFinite(metadata.schemaVersion)
            ? metadata.schemaVersion
            : UNIFIED_SECRETS_SCHEMA_VERSION,
        legacyMigrationComplete: metadata.legacyMigrationComplete === true,
        legacyEntriesRetained: metadata.legacyEntriesRetained === true,
      },
    };
  } catch {
    return createEmptyBlob();
  }
}

function isLegacyMigrationComplete(blob: UnifiedSecretsBlob): boolean {
  return blob.metadata.legacyMigrationComplete === true;
}

async function loadUnifiedSecretsBlob(): Promise<UnifiedSecretsBlob> {
  if (unifiedSecretsCache) {
    return unifiedSecretsCache;
  }

  const raw = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: UNIFIED_SECRETS_KEY,
  });

  unifiedSecretsCache = parseUnifiedSecretsBlob(raw);
  if (unifiedSecretsCache.metadata.legacyMigrationComplete) {
    legacyEntriesDetected = unifiedSecretsCache.metadata.legacyEntriesRetained;
  }
  return unifiedSecretsCache;
}

async function saveUnifiedSecretsBlob(blob: UnifiedSecretsBlob): Promise<void> {
  const normalized: UnifiedSecretsBlob = {
    global: { ...blob.global },
    projects: { ...blob.projects },
    metadata: {
      schemaVersion: UNIFIED_SECRETS_SCHEMA_VERSION,
      legacyMigrationComplete: blob.metadata.legacyMigrationComplete === true,
      legacyEntriesRetained: blob.metadata.legacyEntriesRetained === true,
    },
  };
  unifiedSecretsCache = normalized;

  await Bun.secrets.set({
    service: SERVICE_NAME,
    name: UNIFIED_SECRETS_KEY,
    value: JSON.stringify(normalized),
  });
}

/**
 * Clear the in-memory secrets cache
 * Useful for long-running processes that need fresh values
 */
export function clearSecretsCache(): void {
  unifiedSecretsCache = null;
  legacyProjectBlobChecked.clear();
  legacyGlobalBlobChecked = false;
  legacyEntriesDetected = false;
}

// ============================================================================
// Project Secrets (stored as single JSON blob per project)
// ============================================================================

/**
 * Get the keychain entry name for a project's secrets blob
 */
function getProjectSecretsKey(projectName: string): string {
  return `${PROJECT_SECRETS_PREFIX}${projectName}`;
}

async function loadLegacyProjectBlob(projectName: string): Promise<{
  hasLegacyEntry: boolean;
  secrets: Record<string, string>;
}> {
  legacyProjectBlobChecked.add(projectName);
  const raw = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: getProjectSecretsKey(projectName),
  });

  if (!raw) {
    return { hasLegacyEntry: false, secrets: {} };
  }

  legacyEntriesDetected = true;
  try {
    return { hasLegacyEntry: true, secrets: normalizeRecord(JSON.parse(raw)) };
  } catch {
    return { hasLegacyEntry: true, secrets: {} };
  }
}

async function loadLegacyGlobalBlob(): Promise<{
  hasLegacyEntry: boolean;
  secrets: Record<string, string>;
}> {
  legacyGlobalBlobChecked = true;
  const raw = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: GLOBAL_SECRETS_KEY,
  });

  if (!raw) {
    return { hasLegacyEntry: false, secrets: {} };
  }

  legacyEntriesDetected = true;
  try {
    return { hasLegacyEntry: true, secrets: normalizeRecord(JSON.parse(raw)) };
  } catch {
    return { hasLegacyEntry: true, secrets: {} };
  }
}

function mergeSecrets(
  existing: Record<string, string>,
  legacy: Record<string, string>
): Record<string, string> {
  // New-format values win if both are present.
  return { ...legacy, ...existing };
}

/**
 * Load project secrets from the unified blob.
 */
async function loadProjectSecretsBlob(projectName: string): Promise<Record<string, string>> {
  const blob = await loadUnifiedSecretsBlob();
  return { ...(blob.projects[projectName] || {}) };
}

/**
 * Save the secrets blob for a project to keychain
 */
async function saveProjectSecretsBlob(
  projectName: string,
  secrets: Record<string, string>
): Promise<void> {
  const blob = await loadUnifiedSecretsBlob();
  if (Object.keys(secrets).length === 0) {
    delete blob.projects[projectName];
  } else {
    blob.projects[projectName] = { ...secrets };
  }
  await saveUnifiedSecretsBlob(blob);
}

/**
 * Store a secret for a project
 */
export async function setProjectSecret(
  projectName: string,
  key: string,
  value: string
): Promise<void> {
  const secrets = await loadProjectSecretsBlob(projectName);
  secrets[key] = value;
  await saveProjectSecretsBlob(projectName, secrets);
}

/**
 * Retrieve a secret for a project
 *
 * Checks the consolidated blob first, then falls back to old per-secret
 * format for seamless migration from older versions.
 */
export async function getProjectSecret(
  projectName: string,
  key: string
): Promise<string | null> {
  const blob = await loadUnifiedSecretsBlob();
  const current = blob.projects[projectName] || {};

  // Found in new format
  if (current[key] !== undefined) {
    return current[key];
  }

  if (isLegacyMigrationComplete(blob)) {
    return null;
  }

  // Try legacy project blob format: project:<name>
  if (!legacyProjectBlobChecked.has(projectName)) {
    const legacyBlob = await loadLegacyProjectBlob(projectName);
    if (legacyBlob.hasLegacyEntry) {
      blob.projects[projectName] = mergeSecrets(current, legacyBlob.secrets);
      await saveUnifiedSecretsBlob(blob);
      if (blob.projects[projectName][key] !== undefined) {
        return blob.projects[projectName][key];
      }
    }
  }

  // Try old format: ${projectName}:${key}
  const oldKeychainName = `${projectName}:${key}`;
  const oldValue = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: oldKeychainName,
  });

  if (oldValue) {
    legacyEntriesDetected = true;
    blob.projects[projectName] = {
      ...(blob.projects[projectName] || {}),
      [key]: oldValue,
    };
    await saveUnifiedSecretsBlob(blob);

    return oldValue;
  }

  return null;
}

/**
 * Delete a secret for a project
 */
export async function deleteProjectSecret(
  projectName: string,
  key: string
): Promise<boolean> {
  const secrets = await loadProjectSecretsBlob(projectName);
  if (!(key in secrets)) {
    return false;
  }
  delete secrets[key];
  await saveProjectSecretsBlob(projectName, secrets);
  return true;
}

/**
 * Get all secrets for a project given a list of secret keys
 * Returns a record of key -> value for all found secrets
 */
export async function getProjectSecrets(
  projectName: string,
  keys: string[]
): Promise<Record<string, string>> {
  const blob = await loadUnifiedSecretsBlob();
  let secrets = blob.projects[projectName] || {};
  let changed = false;

  if (!isLegacyMigrationComplete(blob) && !legacyProjectBlobChecked.has(projectName)) {
    const legacyBlob = await loadLegacyProjectBlob(projectName);
    if (legacyBlob.hasLegacyEntry) {
      secrets = mergeSecrets(secrets, legacyBlob.secrets);
      blob.projects[projectName] = secrets;
      changed = true;
    }
  }

  const result: Record<string, string> = {};

  for (const key of keys) {
    if (key in secrets) {
      result[key] = secrets[key];
      continue;
    }

    if (isLegacyMigrationComplete(blob)) {
      continue;
    }

    // Legacy per-secret fallback (very old format)
    const oldKeychainName = `${projectName}:${key}`;
    const oldValue = await Bun.secrets.get({
      service: SERVICE_NAME,
      name: oldKeychainName,
    });

    if (oldValue) {
      legacyEntriesDetected = true;
      result[key] = oldValue;
      blob.projects[projectName] = {
        ...(blob.projects[projectName] || {}),
        [key]: oldValue,
      };
      changed = true;
    }
  }

  if (changed) {
    await saveUnifiedSecretsBlob(blob);
  }

  return result;
}

/**
 * Preload project secrets into the cache
 * Call this early in an operation to trigger a single keychain prompt,
 * then subsequent getProjectSecret calls will use cached values.
 */
export async function preloadProjectSecrets(
  projectName: string,
  keys: string[]
): Promise<Record<string, string>> {
  return getProjectSecrets(projectName, keys);
}

/**
 * Delete all secrets for a project given a list of secret keys
 */
export async function deleteProjectSecrets(
  projectName: string,
  keys: string[]
): Promise<void> {
  const secrets = await loadProjectSecretsBlob(projectName);
  for (const key of keys) {
    delete secrets[key];
  }
  await saveProjectSecretsBlob(projectName, secrets);
}

/**
 * Delete the entire secrets blob for a project
 * Used when removing a project entirely
 */
export async function deleteAllProjectSecrets(projectName: string): Promise<void> {
  const blob = await loadUnifiedSecretsBlob();
  delete blob.projects[projectName];
  await saveUnifiedSecretsBlob(blob);
}

// ============================================================================
// Global Secrets (stored as single JSON blob)
// ============================================================================

/**
 * Load global secrets from the unified blob.
 */
async function loadGlobalSecretsBlob(): Promise<Record<string, string>> {
  const blob = await loadUnifiedSecretsBlob();
  return { ...blob.global };
}

/**
 * Save the global secrets blob to keychain
 */
async function saveGlobalSecretsBlob(secrets: Record<string, string>): Promise<void> {
  const blob = await loadUnifiedSecretsBlob();
  blob.global = { ...secrets };
  await saveUnifiedSecretsBlob(blob);
}

/**
 * Store a global secret (not project-scoped)
 * Used for: GITSPACE_TOKEN, TUNNEL_TOKEN_{subdomain}, etc.
 */
export async function setSecret(key: string, value: string): Promise<void> {
  const secrets = await loadGlobalSecretsBlob();
  secrets[key] = value;
  await saveGlobalSecretsBlob(secrets);
}

/**
 * Retrieve a global secret
 *
 * Checks the consolidated blob first, then falls back to old per-secret
 * format for seamless migration from older versions.
 */
export async function getSecret(key: string): Promise<string | null> {
  const blob = await loadUnifiedSecretsBlob();
  const secrets = blob.global;

  // Found in new format
  if (secrets[key] !== undefined) {
    return secrets[key];
  }

  if (isLegacyMigrationComplete(blob)) {
    return null;
  }

  // Try legacy global blob format: global
  if (!legacyGlobalBlobChecked) {
    const legacyBlob = await loadLegacyGlobalBlob();
    if (legacyBlob.hasLegacyEntry) {
      blob.global = mergeSecrets(blob.global, legacyBlob.secrets);
      await saveUnifiedSecretsBlob(blob);
      if (blob.global[key] !== undefined) {
        return blob.global[key];
      }
    }
  }

  // Try old format: direct key name
  const oldValue = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: key,
  });

  if (oldValue) {
    legacyEntriesDetected = true;
    blob.global[key] = oldValue;
    await saveUnifiedSecretsBlob(blob);

    return oldValue;
  }

  return null;
}

/**
 * Delete a global secret
 */
export async function deleteSecret(key: string): Promise<boolean> {
  const secrets = await loadGlobalSecretsBlob();
  if (!(key in secrets)) {
    return false;
  }
  delete secrets[key];
  await saveGlobalSecretsBlob(secrets);
  return true;
}

export interface PreloadAllSecretsResult {
  legacyEntriesDetected: boolean;
  importedLegacyProjectEntries: number;
  importedLegacyGlobalEntry: boolean;
}

export interface PreloadAllSecretsOptions {
  globalLegacyKeys?: string[];
  projectLegacyKeys?: Record<string, string[]>;
}

/**
 * Preload all secrets for the process into memory.
 * This is intended to be called once at startup (serve + TUI).
 */
export async function preloadAllSecrets(
  projectNames: string[],
  options: PreloadAllSecretsOptions = {}
): Promise<PreloadAllSecretsResult> {
  const blob = await loadUnifiedSecretsBlob();

  if (isLegacyMigrationComplete(blob)) {
    legacyEntriesDetected = blob.metadata.legacyEntriesRetained;
    return {
      legacyEntriesDetected,
      importedLegacyProjectEntries: 0,
      importedLegacyGlobalEntry: false,
    };
  }

  let importedLegacyProjectEntries = 0;
  let importedLegacyGlobalEntry = false;
  let changed = false;
  let detectedLegacyEntries = false;

  const projectLegacyKeys = options.projectLegacyKeys ?? {};
  const globalLegacyKeys = [...new Set(options.globalLegacyKeys ?? [])];

  const projectNamesToCheck = [...new Set([...projectNames, ...Object.keys(projectLegacyKeys)])];

  for (const projectName of projectNamesToCheck) {
    const legacyProject = await loadLegacyProjectBlob(projectName);
    if (!legacyProject.hasLegacyEntry) {
      // continue with per-key migration below
    } else {
      detectedLegacyEntries = true;
      importedLegacyProjectEntries += 1;
      const current = blob.projects[projectName] || {};
      const merged = mergeSecrets(current, legacyProject.secrets);
      if (JSON.stringify(current) !== JSON.stringify(merged)) {
        blob.projects[projectName] = merged;
        changed = true;
      }
    }

    const oldKeys = [...new Set(projectLegacyKeys[projectName] ?? [])];
    for (const key of oldKeys) {
      const oldValue = await Bun.secrets.get({
        service: SERVICE_NAME,
        name: `${projectName}:${key}`,
      });

      if (!oldValue) {
        continue;
      }

      detectedLegacyEntries = true;
      const currentProjectSecrets = blob.projects[projectName] || {};
      if (currentProjectSecrets[key] !== oldValue) {
        blob.projects[projectName] = {
          ...currentProjectSecrets,
          [key]: oldValue,
        };
        changed = true;
      }
    }
  }

  const legacyGlobal = await loadLegacyGlobalBlob();
  if (legacyGlobal.hasLegacyEntry) {
    detectedLegacyEntries = true;
    importedLegacyGlobalEntry = true;
    const merged = mergeSecrets(blob.global, legacyGlobal.secrets);
    if (JSON.stringify(blob.global) !== JSON.stringify(merged)) {
      blob.global = merged;
      changed = true;
    }
  }

  for (const key of globalLegacyKeys) {
    const oldValue = await Bun.secrets.get({
      service: SERVICE_NAME,
      name: key,
    });

    if (!oldValue) {
      continue;
    }

    detectedLegacyEntries = true;
    if (blob.global[key] !== oldValue) {
      blob.global[key] = oldValue;
      changed = true;
    }
  }

  blob.metadata.legacyMigrationComplete = true;
  blob.metadata.legacyEntriesRetained = detectedLegacyEntries;
  changed = true;

  legacyEntriesDetected = detectedLegacyEntries;

  if (changed) {
    await saveUnifiedSecretsBlob(blob);
  }

  return {
    legacyEntriesDetected,
    importedLegacyProjectEntries,
    importedLegacyGlobalEntry,
  };
}

export function hasLegacyEntriesInProcess(): boolean {
  return legacyEntriesDetected;
}

export interface CleanupLegacySecretsResult {
  deleted: number;
  missing: number;
  errors: string[];
}

export interface CleanupLegacySecretsOptions {
  globalLegacyKeys?: string[];
  projectLegacyKeys?: Record<string, string[]>;
}

/**
 * Remove legacy keychain entries now that unified secrets are in use.
 * This only removes legacy blob entries (`project:*`, `global`).
 *
 * TODO(v0.3+): remove legacy blob reads and this cleanup path once
 * unified secrets storage has been stable for several releases.
 */
export async function cleanupLegacySecretEntries(
  projectNames: string[],
  options: CleanupLegacySecretsOptions = {}
): Promise<CleanupLegacySecretsResult> {
  const result: CleanupLegacySecretsResult = {
    deleted: 0,
    missing: 0,
    errors: [],
  };

  const projectLegacyKeys = options.projectLegacyKeys ?? {};
  const globalLegacyKeys = options.globalLegacyKeys ?? [];

  const entries = new Set<string>([
    GLOBAL_SECRETS_KEY,
    ...[...new Set(projectNames)].map((name) => getProjectSecretsKey(name)),
    ...globalLegacyKeys,
  ]);

  for (const [projectName, keys] of Object.entries(projectLegacyKeys)) {
    for (const key of keys) {
      entries.add(`${projectName}:${key}`);
    }
  }

  for (const name of entries) {
    try {
      const deleted = await Bun.secrets.delete({
        service: SERVICE_NAME,
        name,
      });
      if (deleted) {
        result.deleted += 1;
      } else {
        result.missing += 1;
      }
    } catch (error) {
      result.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}

// ============================================================================
// Migration from old format (one keychain entry per secret)
// ============================================================================

/**
 * Read a secret in the OLD format directly from keychain
 * Old format: project secrets were stored as `${projectName}:${key}`
 * Old format: global secrets were stored directly as `${key}`
 */
async function getOldFormatSecret(keychainName: string): Promise<string | null> {
  return Bun.secrets.get({
    service: SERVICE_NAME,
    name: keychainName,
  });
}

/**
 * Delete a secret in the OLD format from keychain
 */
async function deleteOldFormatSecret(keychainName: string): Promise<boolean> {
  return Bun.secrets.delete({
    service: SERVICE_NAME,
    name: keychainName,
  });
}

/**
 * Migrate secrets from old format to new consolidated format
 *
 * Old format:
 * - Project secrets: `${projectName}:${key}` per secret
 * - Global secrets: `${key}` per secret
 *
 * New format:
 * - Project secrets: `project:${projectName}` containing JSON blob
 * - Global secrets: `global` containing JSON blob
 *
 * @param projects - Map of project name -> array of secret keys
 * @param globalKeys - Array of global secret keys to migrate
 * @param deleteOld - Whether to delete old entries after migration
 * @returns Migration report
 */
export async function migrateSecrets(
  projects: Record<string, string[]>,
  globalKeys: string[],
  deleteOld: boolean = false
): Promise<{
  projectSecretsMigrated: number;
  globalSecretsMigrated: number;
  oldEntriesDeleted: number;
  errors: string[];
}> {
  const result = {
    projectSecretsMigrated: 0,
    globalSecretsMigrated: 0,
    oldEntriesDeleted: 0,
    errors: [] as string[],
  };

  // Migrate project secrets
  for (const [projectName, keys] of Object.entries(projects)) {
    const newSecrets: Record<string, string> = {};

    for (const key of keys) {
      const oldKeychainName = `${projectName}:${key}`;
      try {
        const value = await getOldFormatSecret(oldKeychainName);
        if (value) {
          newSecrets[key] = value;
          result.projectSecretsMigrated++;

          if (deleteOld) {
            await deleteOldFormatSecret(oldKeychainName);
            result.oldEntriesDeleted++;
          }
        }
      } catch (err) {
        result.errors.push(`Failed to migrate ${oldKeychainName}: ${err}`);
      }
    }

    // Save consolidated blob if we found any secrets
    if (Object.keys(newSecrets).length > 0) {
      // Merge with any existing secrets in new format
      const existing = await loadProjectSecretsBlob(projectName);
      const merged = { ...existing, ...newSecrets };
      await saveProjectSecretsBlob(projectName, merged);
    }
  }

  // Migrate global secrets
  const newGlobalSecrets: Record<string, string> = {};

  for (const key of globalKeys) {
    try {
      const value = await getOldFormatSecret(key);
      if (value) {
        newGlobalSecrets[key] = value;
        result.globalSecretsMigrated++;

        if (deleteOld) {
          await deleteOldFormatSecret(key);
          result.oldEntriesDeleted++;
        }
      }
    } catch (err) {
      result.errors.push(`Failed to migrate global secret ${key}: ${err}`);
    }
  }

  // Save consolidated global blob if we found any secrets
  if (Object.keys(newGlobalSecrets).length > 0) {
    // Merge with any existing secrets in new format
    const existing = await loadGlobalSecretsBlob();
    const merged = { ...existing, ...newGlobalSecrets };
    await saveGlobalSecretsBlob(merged);
  }

  return result;
}
