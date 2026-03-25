import { afterEach, describe, expect, mock, test } from 'bun:test';

describe('ensureUserRootIdentityWithRecovery', () => {
  afterEach(() => {
    mock.restore();
  });

  test('skips auth login side effects when login is disallowed and recovery may be skipped', async () => {
    const promptConfirmMock = mock(async () => true);
    const promptPasswordMock = mock(async () => 'unused');
    const getSecretMock = mock(async () => null as string | null);
    const loadUserRootIdentityMock = mock(async () => null);
    const authLoginMock = mock(async () => undefined);
    const recoverUserRootFromCloudBackupMock = mock(async () => null);

    const realPrompts = await import('../../utils/prompts.js');
    mock.module('../../utils/prompts.js', () => ({
      ...realPrompts,
      promptConfirm: promptConfirmMock,
      promptPassword: promptPasswordMock,
    }));

    mock.module('../../utils/secrets.js', () => ({
      getSecret: getSecretMock,
    }));

    mock.module('../../core/user-identity.js', () => ({
      loadUserRootIdentity: loadUserRootIdentityMock,
    }));

    mock.module('../../core/identity-backup.js', () => ({
      recoverUserRootFromCloudBackup: recoverUserRootFromCloudBackupMock,
    }));

    mock.module('../auth.js', () => ({
      authLogin: authLoginMock,
    }));

    const { ensureUserRootIdentityWithRecovery } = await import(`../identity-recovery.js?test=${Date.now()}`);

    const result = await ensureUserRootIdentityWithRecovery({
      context: 'relay startup owner binding',
      yes: true,
      allowSkip: true,
      allowAuthLogin: false,
    });

    expect(result).toBeNull();
    expect(authLoginMock).not.toHaveBeenCalled();
    expect(recoverUserRootFromCloudBackupMock).not.toHaveBeenCalled();
  });
});
