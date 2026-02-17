import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAllProjectNames, getSpacesDir, readProjectConfig } from './config.js';
import { logger } from '../utils/logger.js';
import { preloadAllSecrets } from '../utils/secrets.js';
import { SpacesError } from '../types/errors.js';

interface SecretRuntimeState {
  ignoreKeychainAndSkipSecrets: boolean;
  projectsWithSecrets: Set<string>;
  legacyEntriesDetected: boolean;
  legacyReminderConsumed: boolean;
}

export interface SecretMigrationInputs {
  projectNames: string[];
  projectSecretKeys: Record<string, string[]>;
  globalSecretKeys: string[];
}

function readHostSubdomains(): string[] {
  const hostPath = join(getSpacesDir(), 'host.json');
  if (!existsSync(hostPath)) {
    return [];
  }

  try {
    const parsed = JSON.parse(readFileSync(hostPath, 'utf-8')) as {
      subdomain?: unknown;
      subdomains?: unknown;
    };

    const found = new Set<string>();
    if (typeof parsed.subdomain === 'string' && parsed.subdomain.length > 0) {
      found.add(parsed.subdomain);
    }

    if (Array.isArray(parsed.subdomains)) {
      for (const candidate of parsed.subdomains) {
        if (typeof candidate === 'string' && candidate.length > 0) {
          found.add(candidate);
        }
      }
    }

    return [...found];
  } catch {
    return [];
  }
}

export function getSecretMigrationInputs(): SecretMigrationInputs {
  const projectNames = getAllProjectNames();
  const projectSecretKeys: Record<string, string[]> = {};
  const globalSecretKeys = new Set<string>([
    'GITSPACE_TOKEN',
    'linear-api-key',
    'relay:signingPrivateKey',
  ]);

  for (const projectName of projectNames) {
    globalSecretKeys.add(`linear-api-key-${projectName}`);

    try {
      const config = readProjectConfig(projectName);
      const keys = [...new Set(config.bundleSecretKeys ?? [])];
      if (keys.length > 0) {
        projectSecretKeys[projectName] = keys;
      }
    } catch (error) {
      logger.debug(
        `[secrets] Failed reading project config for ${projectName}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  for (const subdomain of readHostSubdomains()) {
    globalSecretKeys.add(`TUNNEL_TOKEN_${subdomain}`);
  }

  return {
    projectNames,
    projectSecretKeys,
    globalSecretKeys: [...globalSecretKeys],
  };
}

const state: SecretRuntimeState = {
  ignoreKeychainAndSkipSecrets: false,
  projectsWithSecrets: new Set<string>(),
  legacyEntriesDetected: false,
  legacyReminderConsumed: false,
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
  state.legacyEntriesDetected = false;
  state.legacyReminderConsumed = false;

  const projectsWithSecrets = collectProjectsWithSecrets();
  state.projectsWithSecrets = new Set(projectsWithSecrets.map((entry) => entry.projectName));
  const migrationInputs = getSecretMigrationInputs();

  if (ignore) {
    if (projectsWithSecrets.length > 0) {
      logger.warning(
        'Ignoring keychain and skipping secret-dependent scripts (use with caution).'
      );
    }
    return;
  }

  try {
    const preloadResult = await preloadAllSecrets(migrationInputs.projectNames, {
      projectLegacyKeys: migrationInputs.projectSecretKeys,
      globalLegacyKeys: migrationInputs.globalSecretKeys,
    });
    state.legacyEntriesDetected = preloadResult.legacyEntriesDetected;
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

export function consumeLegacyCleanupReminderForTui(): string | null {
  if (!state.legacyEntriesDetected || state.legacyReminderConsumed) {
    return null;
  }

  state.legacyReminderConsumed = true;
  return 'Legacy keychain entries are still present. Run `gssh migrate cleanup-legacy` once you are confident the unified keychain storage is stable.';
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
