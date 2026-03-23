import { afterEach, describe, expect, mock, test } from 'bun:test';

describe('device identity password context', () => {
  afterEach(() => {
    mock.restore();
  });

  test('shares one password-stdin read across repeated calls with the same context', async () => {
    const promptPasswordMock = mock(async () => null as string | null);
    const promptConfirmMock = mock(async () => true);
    const keypairExistsMock = mock(() => true);
    const generateAndSaveKeypairMock = mock(async () => undefined);
    const readPasswordFromStdinMock = mock(async () => 'stdin-password');

    mock.module('../../utils/prompts.js', () => ({
      promptPassword: promptPasswordMock,
      promptConfirm: promptConfirmMock,
    }));

    mock.module('../../core/identity.js', () => ({
      keypairExists: keypairExistsMock,
      generateAndSaveKeypair: generateAndSaveKeypairMock,
    }));

    mock.module('../../utils/password-stdin.js', () => ({
      readPasswordFromStdin: readPasswordFromStdinMock,
    }));

    const {
      createDeviceIdentityPasswordContext,
      ensureDeviceIdentityPassword,
    } = await import(`../device-identity-password.js?test=${Date.now()}`);

    const devicePasswordContext = createDeviceIdentityPasswordContext({ passwordStdin: true });

    const [firstPassword, secondPassword] = await Promise.all([
      ensureDeviceIdentityPassword({}, devicePasswordContext),
      ensureDeviceIdentityPassword({}, devicePasswordContext),
    ]);

    expect(firstPassword).toBe('stdin-password');
    expect(secondPassword).toBe('stdin-password');
    expect(readPasswordFromStdinMock).toHaveBeenCalledTimes(1);
    expect(promptPasswordMock).not.toHaveBeenCalled();
  });

  test('uses env password without skipping first-run identity creation', async () => {
    const promptPasswordMock = mock(async () => null as string | null);
    const promptConfirmMock = mock(async () => true);
    const keypairExistsMock = mock(() => false);
    const generateAndSaveKeypairMock = mock(async () => undefined);

    mock.module('../../utils/prompts.js', () => ({
      promptPassword: promptPasswordMock,
      promptConfirm: promptConfirmMock,
    }));

    mock.module('../../core/identity.js', () => ({
      keypairExists: keypairExistsMock,
      generateAndSaveKeypair: generateAndSaveKeypairMock,
    }));

    mock.module('../../utils/password-stdin.js', () => ({
      readPasswordFromStdin: mock(async () => 'stdin-password'),
    }));

    mock.module('../local-store-password.js', () => ({
      getLocalStorePasswordFromEnv: () => 'env-password',
    }));

    const { ensureDeviceIdentityPassword } = await import(`../device-identity-password.js?test=${Date.now()}`);

    const password = await ensureDeviceIdentityPassword({ yes: true });

    expect(password).toBe('env-password');
    expect(generateAndSaveKeypairMock).toHaveBeenCalledWith('env-password', expect.any(String));
    expect(promptPasswordMock).not.toHaveBeenCalled();
  });

  test('resolved shared context still creates a keypair when missing', async () => {
    const promptPasswordMock = mock(async () => null as string | null);
    const promptConfirmMock = mock(async () => true);
    const keypairExistsMock = mock(() => false);
    const generateAndSaveKeypairMock = mock(async () => undefined);

    mock.module('../../utils/prompts.js', () => ({
      promptPassword: promptPasswordMock,
      promptConfirm: promptConfirmMock,
    }));

    mock.module('../../core/identity.js', () => ({
      keypairExists: keypairExistsMock,
      generateAndSaveKeypair: generateAndSaveKeypairMock,
    }));

    mock.module('../../utils/password-stdin.js', () => ({
      readPasswordFromStdin: mock(async () => 'stdin-password'),
    }));

    mock.module('../local-store-password.js', () => ({
      getLocalStorePasswordFromEnv: () => null,
    }));

    const {
      ensureDeviceIdentityPassword,
      createDeviceIdentityPasswordContext,
    } = await import(`../device-identity-password.js?test=${Date.now()}`);

    const context = createDeviceIdentityPasswordContext();
    context.password = 'seeded-password';
    context.resolved = true;

    const password = await ensureDeviceIdentityPassword({ yes: true }, context);

    expect(password).toBe('seeded-password');
    expect(generateAndSaveKeypairMock).toHaveBeenCalledWith('seeded-password', expect.any(String));
  });

  test('prompts for the existing identity password during legacy migration', async () => {
    const promptPasswordMock = mock(async () => 'legacy-password');
    const promptConfirmMock = mock(async () => true);
    const keypairExistsMock = mock(() => true);
    const generateAndSaveKeypairMock = mock(async () => undefined);

    mock.module('../../utils/prompts.js', () => ({
      promptPassword: promptPasswordMock,
      promptConfirm: promptConfirmMock,
    }));

    mock.module('../../core/identity.js', () => ({
      keypairExists: keypairExistsMock,
      generateAndSaveKeypair: generateAndSaveKeypairMock,
    }));

    mock.module('../../core/local-secure-store.js', () => ({
      localSecureStoreExists: () => false,
    }));

    mock.module('../../utils/password-stdin.js', () => ({
      readPasswordFromStdin: mock(async () => 'stdin-password'),
    }));

    mock.module('../local-store-password.js', () => ({
      getLocalStorePasswordFromEnv: () => null,
    }));

    const { ensureDeviceIdentityPassword } = await import(`../device-identity-password.js?test=${Date.now()}`);

    const password = await ensureDeviceIdentityPassword();

    expect(password).toBe('legacy-password');
    expect(promptPasswordMock).toHaveBeenCalledWith(
      'Enter your existing device identity password to migrate it into the new local secure store:',
    );
    expect(promptConfirmMock).not.toHaveBeenCalled();
  });
});
