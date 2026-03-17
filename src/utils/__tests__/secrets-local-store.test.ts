import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'gssh-secrets-local-store-'));
process.env.HOME = testDir;
process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = '1';
process.env.GSSH_TEST_SECRETS_FILE = join(testDir, 'test-secrets.json');

const {
  clearSecretsCache,
  getProjectSecret,
  getSecret,
  setProjectSecret,
  setSecret,
} = await import('../secrets.js');
const { unlockLocalSecureStore, readLocalStoreSecretJson, lockLocalSecureStore } = await import('../../core/local-secure-store.js');

afterAll(() => {
  clearSecretsCache();
  lockLocalSecureStore();
  delete process.env.GSSH_TEST_SECRETS_FILE;
  delete process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND;
  if (existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

describe('secrets local secure store migration', () => {
  test('stores non-root secrets in control db and keeps root mnemonic in keychain backend', async () => {
    await unlockLocalSecureStore('test-password');

    await setSecret('GITSPACE_TOKEN', 'token-123');
    await setProjectSecret('demo', 'BUNDLE_TOKEN', 'bundle-456');
    await setSecret('USER_ROOT_IDENTITY', 'root-secret');

    expect(await getSecret('GITSPACE_TOKEN')).toBe('token-123');
    expect(await getProjectSecret('demo', 'BUNDLE_TOKEN')).toBe('bundle-456');
    expect(await getSecret('USER_ROOT_IDENTITY')).toBe('root-secret');

    const stored = readLocalStoreSecretJson<{
      global: Record<string, string>;
      projects: Record<string, Record<string, string>>;
    }>('secrets', 'unified');

    expect(stored?.global.GITSPACE_TOKEN).toBe('token-123');
    expect(stored?.projects.demo?.BUNDLE_TOKEN).toBe('bundle-456');
    expect(stored?.global.USER_ROOT_IDENTITY).toBeUndefined();

    const testSecretsFile = process.env.GSSH_TEST_SECRETS_FILE!;
    const rawBackend = JSON.parse(readFileSync(testSecretsFile, 'utf-8')) as {
      entries?: Record<string, string>;
    };

    expect(rawBackend.entries?.['com.gitspace:USER_ROOT_IDENTITY']).toBe('root-secret');
  });
});
