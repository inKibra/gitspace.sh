import { afterEach, describe, expect, mock, test } from 'bun:test';

describe('local store password prompts', () => {
  afterEach(() => {
    mock.restore();
  });

  test('uses the existing device identity password during legacy migration', async () => {
    const promptPasswordMock = mock(async () => 'legacy-password');
    const promptConfirmMock = mock(async () => true);

    mock.module('../../utils/prompts.js', () => ({
      promptPassword: promptPasswordMock,
      promptConfirm: promptConfirmMock,
    }));

    mock.module('../../core/local-secure-store.js', () => ({
      localSecureStoreExists: () => false,
    }));

    mock.module('../../core/identity.js', () => ({
      keypairExists: () => true,
    }));

    const { ensureLocalStorePassword } = await import(`../local-store-password.js?test=${Date.now()}`);

    const password = await ensureLocalStorePassword();

    expect(password).toBe('legacy-password');
    expect(promptPasswordMock).toHaveBeenCalledWith(
      'Enter your existing device identity password to migrate it into the new local secure store:',
    );
    expect(promptConfirmMock).not.toHaveBeenCalled();
  });

  test('still creates and confirms a new password for fresh installs', async () => {
    const promptPasswordMock = mock(async (prompt: string) => (
      prompt === 'Confirm local secure store password:' ? 'new-password' : 'new-password'
    ));
    const promptConfirmMock = mock(async () => true);

    mock.module('../../utils/prompts.js', () => ({
      promptPassword: promptPasswordMock,
      promptConfirm: promptConfirmMock,
    }));

    mock.module('../../core/local-secure-store.js', () => ({
      localSecureStoreExists: () => false,
    }));

    mock.module('../../core/identity.js', () => ({
      keypairExists: () => false,
    }));

    const { ensureLocalStorePassword } = await import(`../local-store-password.js?test=${Date.now()}`);

    const password = await ensureLocalStorePassword();

    expect(password).toBe('new-password');
    expect(promptConfirmMock).toHaveBeenCalledWith(
      'No local secure store password is configured. Create one now?',
      true,
    );
    expect(promptPasswordMock).toHaveBeenNthCalledWith(1, 'Create password for local secure store:');
    expect(promptPasswordMock).toHaveBeenNthCalledWith(2, 'Confirm local secure store password:');
  });
});
