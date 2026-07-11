/**
 * Shared error handling for CLI commands
 *
 * @module cli/error
 */

import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';

/**
 * Handle an error from a CLI command action.
 * Logs the error and exits the process.
 */
export function handleError(error: unknown): never {
  if (error instanceof SpacesError) {
    logger.error(error.message);
    process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    logger.error(`Unexpected error: ${error.message}`);
    logger.debug(error.stack || '');
    process.exit(1);
  }

  logger.error('An unexpected error occurred');
  process.exit(1);
}

/**
 * Wrap a CLI action handler with first-time setup check and error handling.
 *
 * @param handler - The async action handler
 * @param opts - Options: skipSetupCheck to skip first-time setup
 * @returns Wrapped handler
 */
export function withErrorHandler<T extends unknown[]>(
  handler: (...args: T) => Promise<void>,
  opts?: { skipSetupCheck?: boolean },
): (...args: T) => Promise<void> {
  return async (...args: T): Promise<void> => {
    if (!opts?.skipSetupCheck) {
      const { checkFirstTimeSetup } = await import('./setup.js');
      await checkFirstTimeSetup();
    }
    try {
      await handler(...args);
    } catch (error) {
      handleError(error);
    }
    // Goal writes queue a fire-and-forget daemon notify — flush it before
    // the process exits. Bounded and best-effort; a no-op for commands that
    // didn't touch goal state. Never affects the command's exit status.
    try {
      const { flushGoalChangeNotify } = await import('../core/goal-notify.js');
      await flushGoalChangeNotify();
    } catch {
      // fire-and-forget
    }
  };
}
