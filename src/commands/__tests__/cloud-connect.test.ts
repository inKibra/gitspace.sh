import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudConnect } from '../cloud.js';
import { ensureControlStore, upsertCloudWorkspace } from '../../relay/control/store.js';

let envLock: Promise<void> = Promise.resolve();

async function withIsolatedEnv(run: () => Promise<void>): Promise<void> {
  const previous = envLock;
  let release!: () => void;
  envLock = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;

  const originalHome = process.env.HOME;
  const originalControlDir = process.env.GITSPACE_CONTROL_DIR;
  const testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-connect-'));

  try {
    process.env.HOME = testDir;
    process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');
    ensureControlStore();
    await run();
  } finally {
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

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    release();
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
  test('throws when workspace has no machine id', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready');

      await expect(
        cloudConnect('ws-test', { relay: 'wss://relay.test/ws' })
      ).rejects.toThrow(/does not have an attached machine identity/i);
    });
  });

  test('throws when workspace is hibernated', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('hibernated', 'machine-hib');

      await expect(
        cloudConnect('ws-test', { relay: 'wss://relay.test/ws' })
      ).rejects.toThrow(/is hibernated/i);
    });
  });

  test('throws when workspace is bootstrapping', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('bootstrapping', 'machine-boot');

      await expect(
        cloudConnect('ws-test', { relay: 'wss://relay.test/ws' })
      ).rejects.toThrow(/currently 'bootstrapping'/i);
    });
  });

  test('delegates to connectToRemote when workspace is ready', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');

      let calledTarget: string | undefined;
      let calledOptions: { relay?: string; yes?: boolean; passwordStdin?: boolean } | undefined;
      await cloudConnect(
        'ws-test',
        { relay: 'wss://relay.test/ws', yes: true, passwordStdin: true },
        {
          connectToRemote: async (target, options) => {
            calledTarget = target;
            calledOptions = {
              relay: options?.relay,
              yes: options?.yes,
              passwordStdin: options?.passwordStdin,
            };
          },
        },
      );

      expect(calledTarget).toBe('machine-ready');
      expect(calledOptions).toEqual({
        relay: 'wss://relay.test/ws',
        yes: true,
        passwordStdin: true,
      });
    });
  });
});
