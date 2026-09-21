import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'gssh-relay-identity-reset-'));
const previous = {
  home: process.env.GITSPACE_HOME,
  testRuntime: process.env.GSSH_TEST_RUNTIME,
  testBackend: process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND,
  testFile: process.env.GSSH_TEST_SECRETS_FILE,
};
process.env.GITSPACE_HOME = root;
process.env.GSSH_TEST_RUNTIME = '1';
process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = '1';
process.env.GSSH_TEST_SECRETS_FILE = join(root, 'secrets.json');

// The secrets backend captures its test file during module initialization, so
// this import intentionally happens after the isolated environment is installed.
const {
  generateRelayIdentity,
  getRelayIdentityPath,
  loadOrCreateRelayIdentity,
  resetRelayIdentity,
  saveRelayIdentity,
} = await import('./identity.js');

afterAll(() => {
  if (previous.home === undefined) delete process.env.GITSPACE_HOME;
  else process.env.GITSPACE_HOME = previous.home;
  if (previous.testRuntime === undefined) delete process.env.GSSH_TEST_RUNTIME;
  else process.env.GSSH_TEST_RUNTIME = previous.testRuntime;
  if (previous.testBackend === undefined) delete process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND;
  else process.env.GSSH_ENABLE_TEST_SECRETS_BACKEND = previous.testBackend;
  if (previous.testFile === undefined) delete process.env.GSSH_TEST_SECRETS_FILE;
  else process.env.GSSH_TEST_SECRETS_FILE = previous.testFile;
  rmSync(root, { recursive: true, force: true });
});

test('takeover removes both halves of the local relay identity before regeneration', async () => {
  const original = generateRelayIdentity('original');
  await saveRelayIdentity(original);
  expect(existsSync(getRelayIdentityPath())).toBe(true);

  await expect(resetRelayIdentity()).resolves.toBe(true);
  expect(existsSync(getRelayIdentityPath())).toBe(false);

  const replacement = await loadOrCreateRelayIdentity('replacement');
  expect(replacement.id).not.toBe(original.id);
  expect(replacement.signingPublicKey).not.toBe(original.signingPublicKey);
});
