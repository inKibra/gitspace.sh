import os from 'os';
import { promptConfirm, promptPassword } from '../utils/prompts.js';
import { generateAndSaveKeypair, keypairExists } from '../core/identity.js';
import { NoIdentityError, SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { readPasswordFromStdin } from '../utils/password-stdin.js';

export interface DeviceIdentityPasswordContext {
  resolved: boolean;
  password: string | null;
}

export function createDeviceIdentityPasswordContext(): DeviceIdentityPasswordContext {
  return {
    resolved: false,
    password: null,
  };
}

export async function ensureDeviceIdentityPassword(
  options: { yes?: boolean; passwordStdin?: boolean } = {},
  context?: DeviceIdentityPasswordContext,
): Promise<string | null> {
  if (context?.resolved) {
    return context.password;
  }

  const remember = (password: string | null): string | null => {
    if (context) {
      context.resolved = true;
      context.password = password;
    }

    return password;
  };

  if (!keypairExists()) {
    const shouldCreate = options.yes || await promptConfirm(
      'No local device identity found. Create one now?',
      true,
    );
    if (!shouldCreate) {
      throw new NoIdentityError();
    }

    const stdinPassword = options.passwordStdin ? await readPasswordFromStdin() : null;
    const password = stdinPassword ?? await promptPassword('Create password for local device identity:');
    if (!password) {
      return remember(null);
    }

    if (!stdinPassword) {
      const confirmPassword = await promptPassword('Confirm local identity password:');
      if (password !== confirmPassword) {
        throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
      }
    }

    await generateAndSaveKeypair(password, os.hostname());
    logger.success('Created local device identity');
    return remember(password);
  }

  const stdinPassword = options.passwordStdin ? await readPasswordFromStdin() : null;
  return remember(stdinPassword ?? await promptPassword('Enter password to unlock identity:'));
}
