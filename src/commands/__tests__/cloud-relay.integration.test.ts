import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import type { Server, Subprocess } from 'bun';
import { spawn } from 'bun';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cloudDestroy,
  cloudLaunch,
  type CloudLaunchDependencies,
} from '../cloud.js';
import { SpritesProvider } from '../../relay/control/sprites-provider.js';
import {
  bindPersistedOwnerIdentity,
  ensureControlStore,
  getCloudWorkspace,
  listCloudEvents,
  setVaultMeta,
} from '../../relay/control/store.js';
import { getSpritesToken } from '../../relay/control/provider-config.js';
import { generateRelayIdentity } from '../../relay/identity.js';
import { startRelayServer } from '../../relay/__tests__/helpers/ports.js';
import { generateMnemonic, mnemonicToUserIdentity } from '../../lib/tmux-lite/crypto/user-identity.js';
import { createRootInviteToken, parseRootInviteToken } from '../../lib/tmux-lite/crypto/root-invites.js';
import { registerRootInvite } from '../../relay/auth/store.js';
import { generateIdentity, serializeIdentity } from '../../lib/tmux-lite/crypto/identity.js';

const RUN_RELAY_LIVE = process.env.SPRITES_RELAY_E2E === '1';
const envToken = process.env.SPRITES_TOKEN?.trim() ?? '';
const keychainToken = RUN_RELAY_LIVE && !envToken ? await getSpritesToken() : null;
const SPRITES_TOKEN = envToken || keychainToken || '';
const relayDescribe = RUN_RELAY_LIVE && Boolean(SPRITES_TOKEN) ? describe : describe.skip;

const TEST_OWNER_USER_ROOT = mnemonicToUserIdentity(generateMnemonic());
const OWNER_USER_ROOT_ID = TEST_OWNER_USER_ROOT.id;
const OWNER_ID = OWNER_USER_ROOT_ID;
const SPRITES_APP_ID = process.env.SPRITES_APP_ID ?? `gssh-live-relay-${Date.now().toString(36)}`;

setDefaultTimeout(900_000);

let originalHome: string | undefined;
let originalControlDir: string | undefined;
let testDir = '';

let relayServer: Server<any> | null = null;
let cloudflaredProcess: Subprocess<'ignore', 'pipe', 'pipe'> | null = null;
let relayUrl = '';
let relaySigningPublicKey = '';

function uniqueWorkspaceId(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `ws-relay-${Date.now().toString(36)}-${rand}`;
}

async function createTestEnrollmentInvite(
  workspaceId: string,
  relayUrl: string,
  machineSigningKey: string,
  machineKeyExchangeKey: string,
  expiresAtIso: string,
): Promise<{ token: string; inviteId: string; expiresAt: string }> {
  const expiresAtMs = Date.parse(expiresAtIso);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('Invalid enrollment invite expiry value');
  }

  const token = createRootInviteToken({
    type: 'relay-machine',
    owner: TEST_OWNER_USER_ROOT,
    relayUrl,
    targetMachineSigningKey: machineSigningKey,
    targetMachineKeyExchangeKey: machineKeyExchangeKey,
    expiresAt: expiresAtMs,
    maxUses: 1,
    label: `cloud:${workspaceId}`,
  });

  const parsed = parseRootInviteToken(token);
  if (!parsed || parsed.type !== 'relay-machine') {
    throw new Error('Failed to parse generated relay-machine invite token');
  }

  registerRootInvite({
    inviteId: parsed.inviteId,
    ownerUserRootId: parsed.ownerUserRootId,
    inviteType: parsed.type,
    relayUrl: parsed.relayUrl,
    token,
    maxUses: parsed.maxUses,
    expiresAt: new Date(parsed.expiresAt).toISOString(),
    label: parsed.label,
    machineId: parsed.targetMachineId,
    targetMachineSigningKey: parsed.targetMachineSigningKey,
    targetMachineKeyExchangeKey: parsed.targetMachineKeyExchangeKey,
  });

  return {
    token,
    inviteId: parsed.inviteId,
    expiresAt: new Date(parsed.expiresAt).toISOString(),
  };
}

async function waitForTryCloudflareUrl(process: Subprocess<'ignore', 'pipe', 'pipe'>, timeoutMs = 90_000): Promise<string> {
  const urlPattern = /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i;

  return await new Promise<string>((resolve, reject) => {
    let settled = false;
    let recent = '';
    const decoder = new TextDecoder();

    const finish = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => reject(new Error('Timed out waiting for cloudflared quick tunnel URL')));
    }, timeoutMs);

    const onText = (text: string): void => {
      recent += text;
      if (recent.length > 16_000) {
        recent = recent.slice(-8_000);
      }

      const match = recent.match(urlPattern);
      if (match?.[1]) {
        finish(() => resolve(match[1]));
      }
    };

    const pump = async (stream: ReadableStream<Uint8Array> | null): Promise<void> => {
      if (!stream) {
        return;
      }

      const reader = stream.getReader();
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) {
            break;
          }
          onText(decoder.decode(result.value, { stream: true }));
        }
      } catch (error) {
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    };

    void pump(process.stdout);
    void pump(process.stderr);

    process.exited.then((exitCode) => {
      if (!settled) {
        finish(() => reject(new Error(`cloudflared exited before URL discovery (code ${exitCode})`)));
      }
    }).catch((error) => {
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    });
  });
}

async function startQuickTunnel(localRelayPort: number): Promise<string> {
  cloudflaredProcess = spawn({
    cmd: [
      'cloudflared',
      'tunnel',
      '--url',
      `http://127.0.0.1:${localRelayPort}`,
      '--no-autoupdate',
    ],
    stdout: 'pipe',
    stderr: 'pipe',
  });

  return await waitForTryCloudflareUrl(cloudflaredProcess);
}

async function waitForMachineRegistration(workspaceId: string, timeoutMs = 420_000): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const workspace = getCloudWorkspace(workspaceId);
    const events = listCloudEvents({ workspaceId });
    const registered = events.some((event) => event.eventType === 'machine_registered');

    if (registered && workspace?.status === 'ready' && workspace.machineId) {
      return;
    }

    await Bun.sleep(5_000);
  }

  const finalWorkspace = getCloudWorkspace(workspaceId);
  const finalEvents = listCloudEvents({ workspaceId }).map((event) => event.eventType).join(', ');
  throw new Error(
    `Timed out waiting for relay machine registration. status=${finalWorkspace?.status ?? 'missing'} events=[${finalEvents}]`
  );
}

relayDescribe('cloud relay live integration', () => {
  beforeAll(async () => {
    originalHome = process.env.HOME;
    originalControlDir = process.env.GITSPACE_CONTROL_DIR;

    testDir = mkdtempSync(join(tmpdir(), 'gssh-cloud-relay-live-'));
    process.env.HOME = testDir;
    process.env.GITSPACE_CONTROL_DIR = join(testDir, '.relay', 'control');

    ensureControlStore();
    bindPersistedOwnerIdentity(OWNER_ID);
    setVaultMeta('vault_initialized', '1');
    setVaultMeta('owner_user_root_id', OWNER_USER_ROOT_ID);

    const relayIdentity = generateRelayIdentity('cloud-relay-live-test');
    relaySigningPublicKey = relayIdentity.signingPublicKey;
    relayServer = startRelayServer({
      bind: '127.0.0.1',
      disableRateLimit: true,
      identity: relayIdentity,
    });

    if (typeof relayServer.port !== 'number') {
      throw new Error('Relay server did not expose a listening port');
    }

    const publicBaseUrl = await startQuickTunnel(relayServer.port);
    relayUrl = `${publicBaseUrl.replace(/\/$/, '').replace(/^https:/, 'wss:')}/ws`;
  });

  afterAll(() => {
    if (cloudflaredProcess) {
      try {
        cloudflaredProcess.kill();
      } catch {
        // best effort
      }
      cloudflaredProcess = null;
    }

    if (relayServer) {
      relayServer.stop(true);
      relayServer = null;
    }

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
  });

  test('launch bootstrap registers machine with isolated test relay', async () => {
    const workspaceId = uniqueWorkspaceId();
    const provider = new SpritesProvider({ token: SPRITES_TOKEN, appId: SPRITES_APP_ID });
    const workspaceIdentity = serializeIdentity(generateIdentity(`cloud-${workspaceId}`));

    const dependencies: CloudLaunchDependencies = {
      identityId: OWNER_ID,
      token: SPRITES_TOKEN,
      provider,
      workspaceId,
      relayInfo: {
        relayUrl,
        relaySigningPublicKey,
        relayFingerprint: `fp:${relaySigningPublicKey.slice(0, 8)}`,
      },
      workspaceIdentity: {
        id: workspaceIdentity.id,
        signingPublicKey: workspaceIdentity.signingPublicKey,
        signingSecretKey: workspaceIdentity.signingSecretKey,
        keyExchangePublicKey: workspaceIdentity.keyExchangePublicKey,
        keyExchangePrivateKey: workspaceIdentity.keyExchangePrivateKey,
        createdAt: workspaceIdentity.createdAt,
      },
      createEnrollmentInvite: (
        createdWorkspaceId,
        relay,
        machineSigningKey,
        machineKeyExchangeKey,
        expiresAtIso,
      ) =>
        createTestEnrollmentInvite(
          createdWorkspaceId,
          relay.relayUrl,
          machineSigningKey,
          machineKeyExchangeKey,
          expiresAtIso,
        ),
    };

    try {
      await cloudLaunch(
        {
          repo: process.env.SPRITES_TEST_REPO ?? 'owner/repo',
          branch: process.env.SPRITES_TEST_BRANCH ?? 'main',
          image: process.env.SPRITES_TEST_IMAGE,
        },
        dependencies
      );

      const launched = getCloudWorkspace(workspaceId);
      if (!launched?.providerWorkspaceId) {
        throw new Error('Cloud launch did not persist providerWorkspaceId');
      }

      try {
        await waitForMachineRegistration(workspaceId);
      } catch (error) {
        let diagnosticsSuffix = '\nDiagnostics unavailable';
        try {
          const diagnostic = await provider.execWorkspaceCommand(launched.providerWorkspaceId, {
            command: [
              'bash',
              '-lc',
              [
                'set +e',
                'echo "--- gssh serve log ---"',
                'tail -n 200 /tmp/gssh-serve.log 2>/dev/null || true',
                'echo "--- process list ---"',
                'ps aux | grep "[g]ssh machine serve" || true',
                'ps aux | grep "gssh-cloud-bootstrap.mjs" || true',
              ].join('\n'),
            ],
          });
          diagnosticsSuffix = `\nDiagnostics stdout=${diagnostic.stdout.slice(0, 2000)}\nDiagnostics stderr=${diagnostic.stderr.slice(0, 2000)}`;
        } catch (diagnosticError) {
          const diagnosticMessage = diagnosticError instanceof Error ? diagnosticError.message : String(diagnosticError);
          diagnosticsSuffix = `\nDiagnostics unavailable: ${diagnosticMessage}`;
        }

        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(
          `${detail}${diagnosticsSuffix}`
        );
      }

      const workspace = getCloudWorkspace(workspaceId);
      const events = listCloudEvents({ workspaceId }).map((event) => event.eventType);

      expect(workspace).toBeTruthy();
      expect(workspace?.status).toBe('ready');
      expect(workspace?.machineId).toBeTruthy();
      expect(events).toContain('launch_started');
      expect(events).toContain('vm_created');
      expect(events).toContain('launch_exec_succeeded');
      expect(events).toContain('machine_registered');
    } finally {
      const existing = getCloudWorkspace(workspaceId);
      if (existing && existing.status !== 'destroyed') {
        try {
          if (existing.providerWorkspaceId) {
            await provider.execWorkspaceCommand(existing.providerWorkspaceId, {
              command: ['bash', '-lc', [
                'if command -v gssh >/dev/null 2>&1; then gssh machine serve stop >/dev/null 2>&1 || true; fi',
                'pkill -f "gssh-cloud-bootstrap.mjs" >/dev/null 2>&1 || true',
              ].join('\n')],
            });
          }
          await cloudDestroy(workspaceId, provider, { identityId: OWNER_ID });
        } catch {
          if (existing.providerWorkspaceId) {
            try {
              await provider.destroyWorkspace(existing.providerWorkspaceId);
            } catch {
              // best effort fallback cleanup
            }
          }
        }
      }
    }
  });
});
