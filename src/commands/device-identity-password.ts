import os from 'os';
import { promptConfirm, promptPassword } from '../utils/prompts.js';
import { generateAndSaveKeypair, keypairExists } from '../core/identity.js';
import { NoIdentityError, SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { readPasswordFromStdin } from '../utils/password-stdin.js';

export interface DeviceIdentityPasswordContext {
  resolved: boolean;
  password: string | null;
  passwordStdin: boolean;
  stdinPasswordPromise: Promise<string> | null;
}

export function createDeviceIdentityPasswordContext(
  options: { passwordStdin?: boolean } = {},
): DeviceIdentityPasswordContext {
  return {
    resolved: false,
    password: null,
    passwordStdin: Boolean(options.passwordStdin),
    stdinPasswordPromise: null,
  };
}

function getSharedPasswordContext(
  context: DeviceIdentityPasswordContext | undefined,
  options: { passwordStdin?: boolean },
): DeviceIdentityPasswordContext | undefined {
  if (!context && !options.passwordStdin) {
    return undefined;
  }

  const sharedContext = context ?? createDeviceIdentityPasswordContext(options);
  sharedContext.passwordStdin ||= Boolean(options.passwordStdin);
  return sharedContext;
}

async function resolvePasswordInput(
  prompt: string,
  context: DeviceIdentityPasswordContext | undefined,
): Promise<{ password: string | null; fromStdin: boolean }> {
  if (context?.passwordStdin) {
    context.stdinPasswordPromise ??= readPasswordFromStdin();
    return {
      password: await context.stdinPasswordPromise,
      fromStdin: true,
    };
  }

  return {
    password: await promptPassword(prompt),
    fromStdin: false,
  };
}

export async function ensureDeviceIdentityPassword(
  options: { yes?: boolean; passwordStdin?: boolean } = {},
  context?: DeviceIdentityPasswordContext,
): Promise<string | null> {
  const sharedContext = getSharedPasswordContext(context, options);
  if (sharedContext?.resolved) {
    return sharedContext.password;
  }

  const remember = (password: string | null): string | null => {
    if (sharedContext) {
      sharedContext.resolved = true;
      sharedContext.password = password;
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

    const { password, fromStdin } = await resolvePasswordInput(
      'Create password for local device identity:',
      sharedContext,
    );
    if (!password) {
      return remember(null);
    }

    if (!fromStdin) {
      const confirmPassword = await promptPassword('Confirm local identity password:');
      if (password !== confirmPassword) {
        throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
      }
    }

    await generateAndSaveKeypair(password, os.hostname());
    logger.success('Created local device identity');
    return remember(password);
  }

  const { password } = await resolvePasswordInput(
    'Enter password to unlock identity:',
    sharedContext,
  );
  return remember(password);
}
