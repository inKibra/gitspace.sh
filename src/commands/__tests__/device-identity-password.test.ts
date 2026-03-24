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
});
