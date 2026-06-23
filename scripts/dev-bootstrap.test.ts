import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  clearSandboxBootstrapMetadata,
  createSandboxSecretsStore,
  validateSandboxBootstrap,
  writeSandboxSecretsFile,
  type SandboxBootstrapPaths,
} from './dev-bootstrap.js';

const tempDirs: string[] = [];

function createSandboxPaths(machineId = 'machine-current'): SandboxBootstrapPaths {
  const dir = mkdtempSync(join(tmpdir(), 'gssh-dev-bootstrap-'));
  tempDirs.push(dir);

  const identityDir = join(dir, 'identity');
  mkdirSync(identityDir, { recursive: true });

  const paths: SandboxBootstrapPaths = {
    keypairPath: join(identityDir, 'keypair.json'),
    secretsPath: join(dir, 'secrets.json'),
    devIdentityPath: join(dir, 'dev-browser-identity.json'),
    machineIdentityPath: join(identityDir, 'machine.json'),
    relayConfigPath: join(identityDir, 'relay.json'),
  };

  writeFileSync(paths.keypairPath, JSON.stringify({ id: machineId }));
  writeFileSync(paths.secretsPath, JSON.stringify({
    entries: {
      'com.gitspace:secrets': JSON.stringify({
        global: { USER_ROOT_IDENTITY: JSON.stringify({ mnemonic: 'test mnemonic' }) },
      }),
    },
  }));
  writeFileSync(paths.devIdentityPath, JSON.stringify({ id: 'browser-device' }));

  return paths;
}

function readUnifiedSecrets(secretsPath: string): {
  global: Record<string, string>;
  projects: Record<string, Record<string, string>>;
} {
  const store = JSON.parse(readFileSync(secretsPath, 'utf-8')) as { entries: Record<string, string> };
  return JSON.parse(store.entries['com.gitspace:secrets']);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('validateSandboxBootstrap', () => {
  test('accepts matching persisted machine metadata', () => {
    const paths = createSandboxPaths('machine-current');
    writeFileSync(paths.machineIdentityPath, JSON.stringify({ machineId: 'machine-current' }));
    writeFileSync(paths.relayConfigPath, JSON.stringify({ machineId: 'machine-current' }));

    expect(validateSandboxBootstrap(paths)).toEqual({ valid: true });
  });

  test('rejects stale machine identity bound to a different keypair id', () => {
    const paths = createSandboxPaths('machine-current');
    writeFileSync(paths.machineIdentityPath, JSON.stringify({ machineId: 'machine-stale' }));

    expect(validateSandboxBootstrap(paths)).toEqual({
      valid: false,
      reason: 'machine.json machineId does not match keypair id',
    });
  });

  test('rejects stale relay config bound to a different keypair id', () => {
    const paths = createSandboxPaths('machine-current');
    writeFileSync(paths.relayConfigPath, JSON.stringify({ machineId: 'machine-stale' }));

    expect(validateSandboxBootstrap(paths)).toEqual({
      valid: false,
      reason: 'relay.json machineId does not match keypair id',
    });
  });
});

describe('clearSandboxBootstrapMetadata', () => {
  test('removes stale machine-bound metadata before regeneration', () => {
    const paths = createSandboxPaths('machine-current');
    writeFileSync(paths.machineIdentityPath, JSON.stringify({ machineId: 'machine-stale' }));
    writeFileSync(paths.relayConfigPath, JSON.stringify({ machineId: 'machine-stale' }));

    clearSandboxBootstrapMetadata(paths);

    expect(existsSync(paths.machineIdentityPath)).toBe(false);
    expect(existsSync(paths.relayConfigPath)).toBe(false);
  });
});

describe('createSandboxSecretsStore', () => {
  test('preserves project and non-identity global secrets while replacing repaired identity', () => {
    const paths = createSandboxPaths('machine-current');
    writeFileSync(paths.secretsPath, JSON.stringify({
      entries: {
        'com.gitspace:secrets': JSON.stringify({
          global: {
            USER_ROOT_IDENTITY: JSON.stringify({ mnemonic: 'stale mnemonic' }),
            GITSPACE_TOKEN: 'token-1',
          },
          projects: {
            projectA: { API_KEY: 'project-secret' },
          },
          metadata: { schemaVersion: 2, legacyMigrationComplete: true, legacyEntriesRetained: false },
        }),
      },
    }));

    writeSandboxSecretsFile(paths.secretsPath, createSandboxSecretsStore(paths.secretsPath, { mnemonic: 'fresh mnemonic' }));

    const unified = readUnifiedSecrets(paths.secretsPath);
    expect(JSON.parse(unified.global.USER_ROOT_IDENTITY)).toEqual({ mnemonic: 'fresh mnemonic' });
    expect(unified.global.GITSPACE_TOKEN).toBe('token-1');
    expect(unified.projects).toEqual({ projectA: { API_KEY: 'project-secret' } });
  });

  test('falls back to a fresh identity blob when stale secrets are malformed', () => {
    const paths = createSandboxPaths('machine-current');
    writeFileSync(paths.secretsPath, '{not-json');

    writeSandboxSecretsFile(paths.secretsPath, createSandboxSecretsStore(paths.secretsPath, { mnemonic: 'fresh mnemonic' }));

    const unified = readUnifiedSecrets(paths.secretsPath);
    expect(JSON.parse(unified.global.USER_ROOT_IDENTITY)).toEqual({ mnemonic: 'fresh mnemonic' });
    expect(unified.projects).toEqual({});
  });
});
