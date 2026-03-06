import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudConnect } from '../cloud.js';
import { ensureControlStore, upsertCloudWorkspace } from '../../relay/control/store.js';

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let testDir: string;

function setupEnv() {
  originalHome = process.env.HOME;
  originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-connect-'));
  process.env.HOME = testDir;
  process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
  ensureControlStore();
}

function teardownEnv() {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }

  if (originalControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = originalControlDir;
  }

  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

function seedWorkspace(status: 'ready' | 'hibernated' | 'bootstrapping' | 'error' | 'destroyed', machineId?: string) {
  upsertCloudWorkspace({
    id: 'ws-test',
    provider: 'sprites',
    providerWorkspaceId: 'sprite-test',
    machineId,
    machinePublicKey: machineId ? 'machine-pub-test' : undefined,
    repo: 'owner/repo',
    branch: 'main',
    status,
  });
}

describe('cloudConnect', () => {
  beforeEach(setupEnv);
  afterEach(teardownEnv);

  test('throws when workspace has no machine id', async () => {
    seedWorkspace('ready');

    await expect(
      cloudConnect('ws-test', { relay: 'wss://relay.test/ws' })
    ).rejects.toThrow(/does not have an attached machine identity/i);
  });

  test('throws when workspace is hibernated', async () => {
    seedWorkspace('hibernated', 'machine-hib');

    await expect(
      cloudConnect('ws-test', { relay: 'wss://relay.test/ws' })
    ).rejects.toThrow(/is hibernated/i);
  });

  test('throws when workspace is bootstrapping', async () => {
    seedWorkspace('bootstrapping', 'machine-boot');

    await expect(
      cloudConnect('ws-test', { relay: 'wss://relay.test/ws' })
    ).rejects.toThrow(/currently 'bootstrapping'/i);
  });

  test('throws when relay is missing and no local config exists', async () => {
    seedWorkspace('ready', 'machine-ready');

    await expect(
      cloudConnect('ws-test', {}, {
        resolveRelayUrl: () => {
          throw new Error('Relay URL is required. Pass --relay <url> or start machine serve once to save relay config.');
        },
      })
    ).rejects.toThrow(/Relay URL is required/i);
  });

  test('delegates to connectToRemote when workspace is ready', async () => {
    seedWorkspace('ready', 'machine-ready');

    let calledTarget: string | undefined;
    let calledOptions: { relay?: string; yes?: boolean } | undefined;
    await cloudConnect(
      'ws-test',
      { relay: 'wss://relay.test/ws', yes: true },
      {
        connectToRemote: async (target, options) => {
          calledTarget = target;
          calledOptions = { relay: options?.relay, yes: options?.yes };
        },
      },
    );

    expect(calledTarget).toBe('machine-ready');
    expect(calledOptions).toEqual({
      relay: 'wss://relay.test/ws',
      yes: true,
    });
  });
});
