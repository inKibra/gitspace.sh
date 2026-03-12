import { logger } from '../utils/logger.js';
import { promptConfirm, promptPassword } from '../utils/prompts.js';
import { getSecret } from '../utils/secrets.js';
import { loadUserRootIdentity } from '../core/user-identity.js';
import { recoverUserRootFromCloudBackup } from '../core/identity-backup.js';
import type { UserRootIdentity } from '../types/identity.js';
import { SpacesError } from '../types/errors.js';
import { authLogin } from './auth.js';
import {
  createDeviceIdentityPasswordContext,
  type DeviceIdentityPasswordContext,
} from './device-identity-password.js';

export interface EnsureUserRootIdentityWithRecoveryOptions {
  devicePasswordContext?: DeviceIdentityPasswordContext;
  yes?: boolean;
  passwordStdin?: boolean;
  context: string;
  allowSkip?: boolean;
  force?: boolean;
}

function canPromptInteractively(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function missingIdentityError(context: string): SpacesError {
  return new SpacesError(
    `User root identity is required for ${context}.\n\nRun:\n  gssh user identity recover --cloud`,
    'USER_ERROR',
    1,
  );
}

/**
 * Ensure a local user root identity exists, optionally guiding recovery from
 * cloud backup when missing.
 */
export async function ensureUserRootIdentityWithRecovery(
  options: EnsureUserRootIdentityWithRecoveryOptions,
): Promise<UserRootIdentity | null> {
  const devicePasswordContext = options.devicePasswordContext
    ?? createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });

  let userRoot = await loadUserRootIdentity();
  if (userRoot) {
    return userRoot;
  }

  const interactive = canPromptInteractively();
  if (!interactive && !options.yes) {
    if (options.allowSkip) {
      return null;
    }
    throw missingIdentityError(options.context);
  }

  const shouldRecover = options.yes || await promptConfirm(
    `No user root identity found for ${options.context}. Recover from GitSpace cloud backup now?`,
    true,
  );
  if (!shouldRecover) {
    if (options.allowSkip) {
      return null;
    }
    throw missingIdentityError(options.context);
  }

  let token = await getSecret('GITSPACE_TOKEN');
  if (!token) {
    const shouldLogin = options.yes || await promptConfirm(
      'You are not logged in to gitspace.sh. Run login now?',
      true,
    );

    if (!shouldLogin) {
      if (options.allowSkip) {
        return null;
      }
      throw missingIdentityError(options.context);
    }

    try {
      await authLogin({
        devicePasswordContext,
        yes: options.yes,
        interactiveHostSync: false,
        showHostSyncSummary: false,
      });
    } catch (error) {
      if (options.allowSkip) {
        logger.warning(
          `Login failed while attempting cloud recovery (${error instanceof Error ? error.message : String(error)}). Continuing without recovery.`,
        );
        return null;
      }
      throw error;
    }
    token = await getSecret('GITSPACE_TOKEN');
    if (!token) {
      if (options.allowSkip) {
        return null;
      }
      throw new SpacesError(
        'Login did not produce an auth token. Cannot recover identity from cloud backup.',
        'USER_ERROR',
        1,
      );
    }
  }

  if (!interactive) {
    if (options.allowSkip) {
      return null;
    }

    throw new SpacesError(
      `User root identity recovery for ${options.context} requires an interactive terminal. Run:\n  gssh user identity recover --cloud`,
      'USER_ERROR',
      1,
    );
  }

  const backupPassword = await promptPassword('Enter your identity backup password:');
  if (!backupPassword) {
    if (options.allowSkip) {
      return null;
    }
    throw new SpacesError('Identity recovery cancelled.', 'USER_ERROR', 1);
  }

  try {
    userRoot = await recoverUserRootFromCloudBackup(backupPassword, {
      force: options.force,
    });
    logger.success('Recovered user root identity from cloud backup');
    return userRoot;
  } catch (error) {
    if (options.allowSkip) {
      logger.warning(
        `Cloud identity recovery failed (${error instanceof Error ? error.message : String(error)}). Continuing without recovery.`,
      );
      return null;
    }
    throw error;
  }
}
