import { getAllProjectNames, readProjectConfig } from './config.js';
import { logger } from '../utils/logger.js';
import { preloadProjectSecrets } from '../utils/secrets.js';
import { SpacesError } from '../types/errors.js';

interface SecretRuntimeState {
  ignoreKeychainAndSkipSecrets: boolean;
  initialized: boolean;
  projectsWithSecrets: Set<string>;
}

const state: SecretRuntimeState = {
  ignoreKeychainAndSkipSecrets: false,
  initialized: false,
  projectsWithSecrets: new Set<string>(),
};

function collectProjectsWithSecrets(): Array<{ projectName: string; keys: string[] }> {
  const projects = getAllProjectNames();
  const result: Array<{ projectName: string; keys: string[] }> = [];

  for (const projectName of projects) {
    try {
      const config = readProjectConfig(projectName);
      const keys = config.bundleSecretKeys ?? [];
      if (keys.length > 0) {
        result.push({ projectName, keys });
      }
    } catch (error) {
      logger.debug(
        `[secrets] Failed reading project config for ${projectName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return result;
}

export interface InitializeSecretRuntimeOptions {
  ignoreKeychainAndSkipSecrets?: boolean;
}

export async function initializeSecretRuntime(
  options: InitializeSecretRuntimeOptions = {}
): Promise<void> {
  const ignore = options.ignoreKeychainAndSkipSecrets ?? false;
  state.ignoreKeychainAndSkipSecrets = ignore;

  const projectsWithSecrets = collectProjectsWithSecrets();
  state.projectsWithSecrets = new Set(projectsWithSecrets.map((entry) => entry.projectName));

  if (ignore) {
    state.initialized = true;
    if (projectsWithSecrets.length > 0) {
      logger.warning(
        'Ignoring keychain and skipping secret-dependent scripts (use with caution).'
      );
    }
    return;
  }

  if (projectsWithSecrets.length === 0) {
    state.initialized = true;
    return;
  }

  try {
    for (const entry of projectsWithSecrets) {
      await preloadProjectSecrets(entry.projectName, entry.keys);
    }
    state.initialized = true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SpacesError(
      `Failed to preload keychain secrets at startup: ${message}\n\n` +
        'Unlock keychain access and retry, or run with --ignore-keychain-and-skip-secrets to continue without secret-dependent scripts.',
      'USER_ERROR',
      1
    );
  }
}

export function shouldSkipSecretDependentScripts(
  projectName: string,
  configuredSecretKeys?: string[]
): boolean {
  if (!state.ignoreKeychainAndSkipSecrets) {
    return false;
  }

  if (configuredSecretKeys && configuredSecretKeys.length > 0) {
    return true;
  }

  if (state.projectsWithSecrets.has(projectName)) {
    return true;
  }

  try {
    const config = readProjectConfig(projectName);
    return (config.bundleSecretKeys ?? []).length > 0;
  } catch {
    return true;
  }
}
