/**
 * Secure secrets management using Bun.secrets API
 * Stores secrets in the OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager)
 *
 * All project secrets are stored in a single keychain entry per project (as JSON).
 * All global secrets are stored in a single keychain entry (as JSON).
 * This ensures only ONE keychain prompt per operation, regardless of how many secrets are needed.
 */

const SERVICE_NAME = 'com.gitspace';

// Keychain entry names
const PROJECT_SECRETS_PREFIX = 'project:';
const GLOBAL_SECRETS_KEY = 'global';

// In-memory cache for loaded secret blobs
// Maps keychain entry name -> parsed secrets object
const secretsBlobCache = new Map<string, Record<string, string>>();

/**
 * Clear the in-memory secrets cache
 * Useful for long-running processes that need fresh values
 */
export function clearSecretsCache(): void {
  secretsBlobCache.clear();
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

/**
 * Load the secrets blob for a project from keychain (or cache)
 * This is the only function that accesses the keychain for project secrets
 */
async function loadProjectSecretsBlob(projectName: string): Promise<Record<string, string>> {
  const keychainKey = getProjectSecretsKey(projectName);

  // Check cache first
  if (secretsBlobCache.has(keychainKey)) {
    return secretsBlobCache.get(keychainKey)!;
  }

  // Load from keychain (triggers one OS prompt)
  const raw = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: keychainKey,
  });

  // Parse JSON or return empty object
  let secrets: Record<string, string> = {};
  if (raw) {
    try {
      secrets = JSON.parse(raw);
    } catch {
      // Invalid JSON, start fresh
      secrets = {};
    }
  }

  // Cache the loaded blob
  secretsBlobCache.set(keychainKey, secrets);
  return secrets;
}

/**
 * Save the secrets blob for a project to keychain
 */
async function saveProjectSecretsBlob(
  projectName: string,
  secrets: Record<string, string>
): Promise<void> {
  const keychainKey = getProjectSecretsKey(projectName);

  // Update cache
  secretsBlobCache.set(keychainKey, secrets);

  // Save to keychain
  if (Object.keys(secrets).length === 0) {
    // Delete the entry if no secrets remain
    await Bun.secrets.delete({
      service: SERVICE_NAME,
      name: keychainKey,
    });
  } else {
    await Bun.secrets.set({
      service: SERVICE_NAME,
      name: keychainKey,
      value: JSON.stringify(secrets),
    });
  }
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
  const secrets = await loadProjectSecretsBlob(projectName);

  // Found in new format
  if (secrets[key] !== undefined) {
    return secrets[key];
  }

  // Try old format: ${projectName}:${key}
  const oldKeychainName = `${projectName}:${key}`;
  const oldValue = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: oldKeychainName,
  });

  if (oldValue) {
    // Migrate to new format automatically
    secrets[key] = oldValue;
    await saveProjectSecretsBlob(projectName, secrets);

    // Delete old entry
    await Bun.secrets.delete({
      service: SERVICE_NAME,
      name: oldKeychainName,
    });

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
  const secrets = await loadProjectSecretsBlob(projectName);
  const result: Record<string, string> = {};

  for (const key of keys) {
    if (key in secrets) {
      result[key] = secrets[key];
    }
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
  const keychainKey = getProjectSecretsKey(projectName);
  secretsBlobCache.delete(keychainKey);
  await Bun.secrets.delete({
    service: SERVICE_NAME,
    name: keychainKey,
  });
}

// ============================================================================
// Global Secrets (stored as single JSON blob)
// ============================================================================

/**
 * Load the global secrets blob from keychain (or cache)
 * This is the only function that accesses the keychain for global secrets
 */
async function loadGlobalSecretsBlob(): Promise<Record<string, string>> {
  // Check cache first
  if (secretsBlobCache.has(GLOBAL_SECRETS_KEY)) {
    return secretsBlobCache.get(GLOBAL_SECRETS_KEY)!;
  }

  // Load from keychain (triggers one OS prompt)
  const raw = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: GLOBAL_SECRETS_KEY,
  });

  // Parse JSON or return empty object
  let secrets: Record<string, string> = {};
  if (raw) {
    try {
      secrets = JSON.parse(raw);
    } catch {
      // Invalid JSON, start fresh
      secrets = {};
    }
  }

  // Cache the loaded blob
  secretsBlobCache.set(GLOBAL_SECRETS_KEY, secrets);
  return secrets;
}

/**
 * Save the global secrets blob to keychain
 */
async function saveGlobalSecretsBlob(secrets: Record<string, string>): Promise<void> {
  // Update cache
  secretsBlobCache.set(GLOBAL_SECRETS_KEY, secrets);

  // Save to keychain
  if (Object.keys(secrets).length === 0) {
    // Delete the entry if no secrets remain
    await Bun.secrets.delete({
      service: SERVICE_NAME,
      name: GLOBAL_SECRETS_KEY,
    });
  } else {
    await Bun.secrets.set({
      service: SERVICE_NAME,
      name: GLOBAL_SECRETS_KEY,
      value: JSON.stringify(secrets),
    });
  }
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
  const secrets = await loadGlobalSecretsBlob();

  // Found in new format
  if (secrets[key] !== undefined) {
    return secrets[key];
  }

  // Try old format: direct key name
  const oldValue = await Bun.secrets.get({
    service: SERVICE_NAME,
    name: key,
  });

  if (oldValue) {
    // Migrate to new format automatically
    secrets[key] = oldValue;
    await saveGlobalSecretsBlob(secrets);

    // Delete old entry
    await Bun.secrets.delete({
      service: SERVICE_NAME,
      name: key,
    });

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
