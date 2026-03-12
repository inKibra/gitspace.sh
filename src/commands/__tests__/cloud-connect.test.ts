import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cloudConnect } from '../cloud.js';
import { bindControlRelayIdentity, ensureControlStore, upsertCloudWorkspace } from '../../relay/control/store.js';

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

  test('delegates pinned relay pubkey when using saved relay selection', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');
      bindControlRelayIdentity({
        relayIdentityId: 'relay-cloud-connect-test',
        relaySigningPublicKey: 'relay-pubkey-b64',
        relayFingerprint: 'relay-fingerprint-test',
      });

      let calledTarget: string | undefined;
      let calledOptions: { relay?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean } | undefined;
      await cloudConnect(
        'ws-test',
        { yes: true, passwordStdin: true },
        {
          resolveRelayUrl: () => 'wss://relay.test/ws',
          connectToRemote: async (target, options) => {
            calledTarget = target;
            calledOptions = {
              relay: options?.relay,
              relayPubkey: options?.relayPubkey,
              yes: options?.yes,
              passwordStdin: options?.passwordStdin,
            };
          },
        },
      );

      expect(calledTarget).toBe('machine-ready');
      expect(calledOptions).toEqual({
        relay: 'wss://relay.test/ws',
        relayPubkey: 'relay-pubkey-b64',
        yes: true,
        passwordStdin: true,
      });
    });
  });

  test('does not force pinned relay pubkey for explicit relay overrides', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');
      bindControlRelayIdentity({
        relayIdentityId: 'relay-cloud-connect-test',
        relaySigningPublicKey: 'relay-pubkey-b64',
        relayFingerprint: 'relay-fingerprint-test',
      });

      let calledOptions: { relay?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean } | undefined;
      await cloudConnect(
        'ws-test',
        { relay: 'wss://override.test/ws', yes: true, passwordStdin: true },
        {
          connectToRemote: async (_target, options) => {
            calledOptions = {
              relay: options?.relay,
              relayPubkey: options?.relayPubkey,
              yes: options?.yes,
              passwordStdin: options?.passwordStdin,
            };
          },
        },
      );

      expect(calledOptions).toEqual({
        relay: 'wss://override.test/ws',
        relayPubkey: undefined,
        yes: true,
        passwordStdin: true,
      });
    });
  });

  test('passes explicit relay pubkey for relay overrides', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');

      let calledOptions: { relay?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean } | undefined;
      await cloudConnect(
        'ws-test',
        { relay: 'wss://override.test/ws', relayPubkey: 'override-pubkey-b64', yes: true, passwordStdin: true },
        {
          connectToRemote: async (_target, options) => {
            calledOptions = {
              relay: options?.relay,
              relayPubkey: options?.relayPubkey,
              yes: options?.yes,
              passwordStdin: options?.passwordStdin,
            };
          },
        },
      );

      expect(calledOptions).toEqual({
        relay: 'wss://override.test/ws',
        relayPubkey: 'override-pubkey-b64',
        yes: true,
        passwordStdin: true,
      });
    });
  });

  test('throws when saved relay selection has no pinned relay identity metadata', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');

      await expect(
        cloudConnect('ws-test', {}, { resolveRelayUrl: () => 'wss://relay.test/ws' })
      ).rejects.toThrow(/relay identity is not pinned yet/i);
    });
  });

  test('allows explicit relay overrides without pinned relay identity metadata', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');

      let calledOptions: { relay?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean } | undefined;
      await cloudConnect(
        'ws-test',
        { relay: 'wss://override.test/ws', yes: true },
        {
          connectToRemote: async (_target, options) => {
            calledOptions = {
              relay: options?.relay,
              relayPubkey: options?.relayPubkey,
              yes: options?.yes,
              passwordStdin: options?.passwordStdin,
            };
          },
        },
      );

      expect(calledOptions).toEqual({
        relay: 'wss://override.test/ws',
        relayPubkey: undefined,
        yes: true,
        passwordStdin: undefined,
      });
    });
  });

  test('treats whitespace relay overrides as absent and still requires pinned relay metadata', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');

      await expect(
        cloudConnect('ws-test', { relay: '   ' }, { resolveRelayUrl: () => 'wss://relay.test/ws' })
      ).rejects.toThrow(/relay identity is not pinned yet/i);
    });
  });

  test('rejects explicit relay overrides that are not cloud-reachable', async () => {
    await withIsolatedEnv(async () => {
      seedWorkspace('ready', 'machine-ready');

      await expect(
        cloudConnect('ws-test', { relay: 'ws://127.0.0.1:4480/ws' })
      ).rejects.toThrow(/cloud-reachable relay url/i);
    });
  });

  test('rejects unexpected workspace statuses by default', async () => {
    await withIsolatedEnv(async () => {
      upsertCloudWorkspace({
        id: 'ws-test',
        provider: 'sprites',
        providerWorkspaceId: 'sprite-test',
        machineId: 'machine-ready',
        machinePublicKey: 'machine-pub-test',
        repo: 'owner/repo',
        branch: 'main',
        status: 'mystery' as never,
      } as never);

      await expect(
        cloudConnect('ws-test', {}, { resolveRelayUrl: () => 'wss://relay.test/ws' })
      ).rejects.toThrow(/currently 'mystery'/i);
    });
  });
});
