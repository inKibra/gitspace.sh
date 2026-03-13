import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

describe('authLogin identity bootstrap', () => {
  const originalStdoutIsTTY = process.stdout.isTTY;
  const originalStdinIsTTY = process.stdin.isTTY;
  const originalSshClient = process.env.SSH_CLIENT;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    process.env.SSH_CLIENT = '1';
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutIsTTY, configurable: true });
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinIsTTY, configurable: true });
    if (originalSshClient === undefined) {
      delete process.env.SSH_CLIENT;
    } else {
      process.env.SSH_CLIENT = originalSshClient;
    }
    globalThis.fetch = originalFetch;
    mock.restore();
  });

  test('creates a missing user root identity after login and offers cloud backup', async () => {
    const ensureDeviceIdentityPasswordMock = mock(async () => 'device-password');
    const loadKeypairMock = mock(async () => ({ signing: { secretKey: new Uint8Array(64) } }));
    const signMock = mock(() => new Uint8Array([1, 2, 3]));
    const serializeIdentityMock = mock(() => ({ signingPublicKey: 'device-pubkey' }));
    const setSecretMock = mock(async () => undefined);
    const syncHostConfigMock = mock(async () => ({ ok: true }));
    const printHostSyncReportMock = mock(() => undefined);
    const loadUserRootIdentityMock = mock(async () => null);
    const initFromMnemonicMock = mock(async () => ({
      id: 'user-root-1',
      signing: { publicKey: new Uint8Array(32) },
      keyExchange: { publicKey: new Uint8Array(32) },
      createdAt: Date.now(),
    }));
    const getCloudIdentityBackupStatusMock = mock(async () => ({ enabled: false }));
    const backupCurrentUserRootToCloudMock = mock(async () => ({
      ownerUserRootId: 'user-root-1',
      updatedAt: Date.now(),
    }));
    const promptConfirmMock = mock(async () => true);
    const promptPasswordMock = mock(async () => 'backup-password');

    mock.module('../../utils/secrets.js', () => ({
      getSecret: mock(async () => null),
      setSecret: setSecretMock,
      deleteSecret: mock(async () => true),
    }));

    mock.module('../../core/identity.js', () => ({
      loadKeypair: loadKeypairMock,
      getPublicKeyWithoutPassword: mock(() => null),
    }));

    mock.module('../../lib/tmux-lite/crypto/identity.js', () => ({
      sign: signMock,
      serializeIdentity: serializeIdentityMock,
    }));

    mock.module('../host.js', () => ({
      syncHostConfig: syncHostConfigMock,
      printHostSyncReport: printHostSyncReportMock,
    }));

    mock.module('../device-identity-password.js', () => ({
      createDeviceIdentityPasswordContext: mock(() => ({ passwordStdin: false })),
      ensureDeviceIdentityPassword: ensureDeviceIdentityPasswordMock,
    }));

    mock.module('../../core/user-identity.js', () => ({
      formatFingerprint: mock(() => 'aa:bb:cc:dd'),
      generateNewMnemonic: mock(() => 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega'),
      initFromMnemonic: initFromMnemonicMock,
      loadUserRootIdentity: loadUserRootIdentityMock,
    }));

    mock.module('../../core/identity-backup.js', () => ({
      getCloudIdentityBackupStatus: getCloudIdentityBackupStatusMock,
      backupCurrentUserRootToCloud: backupCurrentUserRootToCloudMock,
    }));

    mock.module('../../lib/tmux-lite/crypto/user-identity.js', () => ({
      formatUserRootPublicKey: mock(() => 'gssh-user:PUBLICKEY'),
    }));

    mock.module('../identity.js', () => ({
      logRecoveryPhrase: mock(() => undefined),
      logIdentityInfo: mock(() => undefined),
    }));

    mock.module('../../utils/prompts.js', () => ({
      promptConfirm: promptConfirmMock,
      promptPassword: promptPasswordMock,
    }));

    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

      if (url.endsWith('/config')) {
        return Response.json({ github_client_id: 'client-id' });
      }

      if (url === 'https://github.com/login/device/code') {
        return Response.json({
          device_code: 'device-code',
          user_code: 'CODE-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 0,
        });
      }

      if (url === 'https://github.com/login/oauth/access_token') {
        return Response.json({ access_token: 'github-token' });
      }

      if (url.endsWith('/auth/github/device')) {
        return Response.json({
          token: 'gitspace-token',
          user: {
            id: 'user-1',
            github_username: 'bradleat',
            email: 'bradleat@example.com',
            name: 'Brad',
            avatar_url: null,
          },
        });
      }

      throw new Error(`Unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const { authLogin } = await import(`../auth.js?test=${Date.now()}`);

    await authLogin({ yes: false, interactiveHostSync: false, showHostSyncSummary: false });

    expect(initFromMnemonicMock).toHaveBeenCalledTimes(1);
    expect(backupCurrentUserRootToCloudMock).toHaveBeenCalledWith('backup-password');
    expect(syncHostConfigMock).toHaveBeenCalledWith(false);
    expect(setSecretMock).toHaveBeenCalledWith('GITSPACE_TOKEN', 'gitspace-token');
  });
});
