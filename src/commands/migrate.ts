import { getSecretMigrationInputs } from '../core/secret-runtime.js';
import { logger } from '../utils/logger.js';
import { promptConfirm } from '../utils/prompts.js';
import { cleanupLegacySecretEntries, preloadAllSecrets } from '../utils/secrets.js';

export interface CleanupLegacyOptions {
  yes?: boolean;
}

export async function migrateCleanupLegacy(
  options: CleanupLegacyOptions = {}
): Promise<void> {
  const migrationInputs = getSecretMigrationInputs();

  if (!options.yes) {
    const confirmed = await promptConfirm(
      'Delete legacy keychain entries (project:*, global, and old per-key entries)? Unified secrets are kept.',
      false
    );

    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  // Ensure legacy entries are copied into unified storage before cleanup.
  await preloadAllSecrets(migrationInputs.projectNames, {
    projectLegacyKeys: migrationInputs.projectSecretKeys,
    globalLegacyKeys: migrationInputs.globalSecretKeys,
  });

  const result = await cleanupLegacySecretEntries(migrationInputs.projectNames, {
    projectLegacyKeys: migrationInputs.projectSecretKeys,
    globalLegacyKeys: migrationInputs.globalSecretKeys,
  });

  if (result.errors.length > 0) {
    logger.warning(`Legacy cleanup completed with ${result.errors.length} error(s).`);
    for (const error of result.errors) {
      logger.error(`  ${error}`);
    }
    logger.info(
      `Legacy cleanup finished with issues. Deleted ${result.deleted} entries (${result.missing} already absent).`
    );
    return;
  }

  logger.success(
    `Legacy cleanup complete. Deleted ${result.deleted} entries (${result.missing} already absent).`
  );
}
