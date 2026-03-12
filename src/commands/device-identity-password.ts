import os from 'os';
import { promptConfirm, promptPassword } from '../utils/prompts.js';
import { generateAndSaveKeypair, keypairExists } from '../core/identity.js';
import { NoIdentityError, SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { readPasswordFromStdin } from '../utils/password-stdin.js';

export async function ensureDeviceIdentityPassword(options: { yes?: boolean; passwordStdin?: boolean } = {}): Promise<string | null> {
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
      return null;
    }

    if (!stdinPassword) {
      const confirmPassword = await promptPassword('Confirm local identity password:');
      if (password !== confirmPassword) {
        throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
      }
    }

    await generateAndSaveKeypair(password, os.hostname());
    logger.success('Created local device identity');
    return password;
  }

  const stdinPassword = options.passwordStdin ? await readPasswordFromStdin() : null;
  return stdinPassword ?? await promptPassword('Enter password to unlock identity:');
}
