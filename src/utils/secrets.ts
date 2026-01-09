/**
 * Secure secrets management using Bun.secrets API
 * Stores secrets in the OS keychain (macOS Keychain, Linux libsecret, Windows Credential Manager)
 */

const SERVICE_NAME = 'com.gitspace';

/**
 * Build the secret name for a project's secret key
 */
function buildSecretName(projectName: string, key: string): string {
  return `${projectName}:${key}`;
}

/**
 * Store a secret for a project
 */
export async function setProjectSecret(
  projectName: string,
  key: string,
  value: string
): Promise<void> {
  await Bun.secrets.set({
    service: SERVICE_NAME,
    name: buildSecretName(projectName, key),
    value,
  });
}

/**
 * Retrieve a secret for a project
 */
export async function getProjectSecret(
  projectName: string,
  key: string
): Promise<string | null> {
  return Bun.secrets.get({
    service: SERVICE_NAME,
    name: buildSecretName(projectName, key),
  });
}

/**
 * Delete a secret for a project
 */
export async function deleteProjectSecret(
  projectName: string,
  key: string
): Promise<boolean> {
  return Bun.secrets.delete({
    service: SERVICE_NAME,
    name: buildSecretName(projectName, key),
  });
}

/**
 * Get all secrets for a project given a list of secret keys
 * Returns a record of key -> value for all found secrets
 */
export async function getProjectSecrets(
  projectName: string,
  keys: string[]
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};

  for (const key of keys) {
    const value = await getProjectSecret(projectName, key);
    if (value !== null) {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Delete all secrets for a project given a list of secret keys
 */
export async function deleteProjectSecrets(
  projectName: string,
  keys: string[]
): Promise<void> {
  for (const key of keys) {
    await deleteProjectSecret(projectName, key);
  }
}

// ============================================================================
// Global Secrets (not project-scoped)
// ============================================================================

/**
 * Store a global secret (not project-scoped)
 * Used for: GITSPACE_TOKEN, TUNNEL_TOKEN_{subdomain}
 */
export async function setSecret(key: string, value: string): Promise<void> {
  await Bun.secrets.set({
    service: SERVICE_NAME,
    name: key,
    value,
  });
}

/**
 * Retrieve a global secret
 */
export async function getSecret(key: string): Promise<string | null> {
  return Bun.secrets.get({
    service: SERVICE_NAME,
    name: key,
  });
}

/**
 * Delete a global secret
 */
export async function deleteSecret(key: string): Promise<boolean> {
  return Bun.secrets.delete({
    service: SERVICE_NAME,
    name: key,
  });
}
