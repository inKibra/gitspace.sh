import { promptConfirm, promptPassword } from '../utils/prompts.js';
import { readPasswordFromStdin } from '../utils/password-stdin.js';
import { keypairExists } from '../core/identity.js';
import { localSecureStoreExists } from '../core/local-secure-store.js';
import { SpacesError } from '../types/errors.js';

export const LOCAL_STORE_PASSWORD_ENV = 'GITSPACE_LOCAL_STORE_PASSWORD';
const LEGACY_LOCAL_STORE_PASSWORD_ENV = 'GITSPACE_IDENTITY_PASSWORD';

export interface LocalStorePasswordContext {
  resolved: boolean;
  password: string | null;
  passwordStdin: boolean;
  stdinPasswordPromise: Promise<string> | null;
}

export function createLocalStorePasswordContext(
  options: { passwordStdin?: boolean } = {},
): LocalStorePasswordContext {
  return {
    resolved: false,
    password: null,
    passwordStdin: Boolean(options.passwordStdin),
    stdinPasswordPromise: null,
  };
}

export function getLocalStorePasswordFromEnv(): string | null {
  const explicit = process.env[LOCAL_STORE_PASSWORD_ENV]?.trim();
  if (explicit) {
    return explicit;
  }

  const legacy = process.env[LEGACY_LOCAL_STORE_PASSWORD_ENV]?.trim();
  return legacy || null;
}

async function resolvePasswordInput(
  prompt: string,
  context: LocalStorePasswordContext | undefined,
): Promise<{ password: string | null; fromStdin: boolean }> {
  if (typeof context?.password === 'string') {
    return {
      password: context.password,
      fromStdin: context.passwordStdin,
    };
  }

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

export async function ensureLocalStorePassword(
  options: { yes?: boolean; passwordStdin?: boolean } = {},
  context?: LocalStorePasswordContext,
): Promise<string | null> {
  const envPassword = getLocalStorePasswordFromEnv();
  const sharedContext = context ?? createLocalStorePasswordContext(options);
  sharedContext.passwordStdin ||= Boolean(options.passwordStdin);

  if (envPassword) {
    sharedContext.resolved = true;
    sharedContext.password = envPassword;
    return envPassword;
  }

  if (sharedContext.resolved) {
    return sharedContext.password;
  }

  const remember = (password: string | null): string | null => {
    sharedContext.resolved = true;
    sharedContext.password = password;
    return password;
  };

  const storeExists = localSecureStoreExists();
  if (!storeExists && keypairExists()) {
    const { password } = await resolvePasswordInput(
      'Enter your existing device identity password to migrate it into the new local secure store:',
      sharedContext,
    );
    return remember(password);
  }

  if (!storeExists) {
    const shouldCreate = options.yes || await promptConfirm(
      'No local secure store password is configured. Create one now?',
      true,
    );
    if (!shouldCreate) {
      throw new SpacesError('Cancelled', 'USER_ERROR', 1);
    }

    const { password, fromStdin } = await resolvePasswordInput(
      'Create password for local secure store:',
      sharedContext,
    );
    if (!password) {
      return remember(null);
    }

    if (!fromStdin) {
      const confirmPassword = await promptPassword('Confirm local secure store password:');
      if (password !== confirmPassword) {
        throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
      }
    }

    return remember(password);
  }

  const { password } = await resolvePasswordInput(
    'Enter password to unlock local secure store:',
    sharedContext,
  );
  return remember(password);
}
