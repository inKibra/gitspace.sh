import { getAllProjectNames } from '../core/config.js';
import { logger } from '../utils/logger.js';
import { promptConfirm } from '../utils/prompts.js';
import { cleanupLegacySecretEntries } from '../utils/secrets.js';

export interface CleanupLegacyOptions {
  yes?: boolean;
}

export async function migrateCleanupLegacy(
  options: CleanupLegacyOptions = {}
): Promise<void> {
  const projectNames = getAllProjectNames();

  if (!options.yes) {
    const confirmed = await promptConfirm(
      'Delete legacy keychain entries (project:* and global)? Unified secrets are kept.',
      false
    );

    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const result = await cleanupLegacySecretEntries(projectNames);

  if (result.errors.length > 0) {
    logger.warning(`Legacy cleanup completed with ${result.errors.length} error(s).`);
    for (const error of result.errors) {
      logger.error(`  ${error}`);
    }
  }

  logger.success(
    `Legacy cleanup complete. Deleted ${result.deleted} entries (${result.missing} already absent).`
  );
}
