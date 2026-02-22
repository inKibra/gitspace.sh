/**
 * First-time setup check, extracted from index.ts
 *
 * @module cli/setup
 */

import { isFirstTimeSetup, initializeSpaces } from '../core/config.js';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { ensureDependencies } from '../utils/deps.js';

/**
 * Check if this is a first-time setup and initialize if needed.
 */
export async function checkFirstTimeSetup(): Promise<void> {
  if (isFirstTimeSetup()) {
    logger.bold('Welcome to GitSpace CLI!\n');
    logger.log('Initializing gitspace directory...\n');

    try {
      await ensureDependencies();
    } catch (error) {
      if (error instanceof SpacesError) {
        logger.error(error.message);
        process.exit(error.exitCode);
      }
      throw error;
    }

    initializeSpaces();

    logger.success('GitSpace initialized!\n');
    logger.log('Get started by adding a project:');
    logger.command('  gssh project add\n');
  }
}
