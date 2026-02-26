import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Server } from 'bun';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearAllRegistries } from './registries';
import { generateRelayIdentity } from './identity';
import { startRelayServer } from './__tests__/helpers/ports';
import {
  connectClient,
  getSigningKeyBase64,
  signChallenge,
  signClientMessage,
  sendAndWait,
  waitForMessage,
} from './__tests__/helpers/auth';
import {
  createTestIdentity,
  toPublicIdentity,
} from '../lib/tmux-lite/crypto/__tests__/helpers/test-identities';
import { createDeviceCertificate } from '../lib/tmux-lite/crypto/device-cert';
import { createRootInviteToken, parseRootInviteToken } from '../lib/tmux-lite/crypto/root-invites';
import { ensureControlStore, removeVaultCategory, setVaultMeta } from './control/store';
import { generateMnemonic, mnemonicToUserIdentity } from '../lib/tmux-lite/crypto/user-identity';
import type { Identity, UserRootIdentity } from '../types/identity';

const TEST_HOST = '127.0.0.1';

const relayIdentity = generateRelayIdentity('test-relay');
const ownerMachine = createTestIdentity('Owner Machine');
const inviteMachine = createTestIdentity('Invite Machine');
const unauthorizedMachine = createTestIdentity('Unauthorized Machine');
const ownerClientIdentity = createTestIdentity('Owner Client');
const outsiderClientIdentity = createTestIdentity('Outsider Client');
const ownerUserRoot = mnemonicToUserIdentity(generateMnemonic());
const outsiderUserRoot = mnemonicToUserIdentity(generateMnemonic());

let relayUrl = '';
let relayHttpBase = '';
let server: Server<any>;
let tempControlDir: string;
let previousControlDir: string | undefined;

function buildDeviceCertificate(identity: Identity, userRoot: UserRootIdentity): string {
  const cert = createDeviceCertificate(
    userRoot,
    identity.signing.publicKey,
    identity.keyExchange.publicKey,
  );
  return JSON.stringify(cert);
}

async function connectAndRegisterMachine(
  identity: Identity,
  options: {
    label?: string;
    enrollmentToken?: string;
  } = {},
): Promise<WebSocket> {
  const url = new URL(relayUrl);
  url.searchParams.set('role', 'machine');

  const ws = new WebSocket(url.toString());
  ws.binaryType = 'arraybuffer';

  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('Machine WebSocket connection failed'));
    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });

  const relayIdentityMsg = await waitForMessage<{ challenge: string }>(ws, 'relay_identity');
  const challenge = Buffer.from(relayIdentityMsg.challenge, 'base64');
  const signature = signChallenge(challenge, identity.signing.secretKey);
  const publicIdentity = toPublicIdentity(identity);

  const registerMessage: Record<string, unknown> = {
    type: 'register_machine',
    machineId: identity.id,
    signingKey: publicIdentity.signingPublicKey,
    keyExchangeKey: publicIdentity.keyExchangePublicKey,
    challengeResponse: signature,
    label: options.label ?? identity.label,
  };

  if (options.enrollmentToken) {
    registerMessage.enrollmentToken = options.enrollmentToken;
  }

  const registeredPromise = waitForMessage(ws, 'registered');
  ws.send(JSON.stringify(registerMessage));
  await registeredPromise;

  return ws;
}

beforeAll(async () => {
  previousControlDir = process.env.GITSPACE_CONTROL_DIR;
  tempControlDir = mkdtempSync(join(tmpdir(), 'gssh-relay-server-test-'));
  process.env.GITSPACE_CONTROL_DIR = tempControlDir;

  ensureControlStore();
  setVaultMeta('vault_initialized', '1');
  setVaultMeta('owner_user_root_id', ownerUserRoot.id);

  server = startRelayServer({
    bind: TEST_HOST,
    hostname: TEST_HOST,
    disableRateLimit: true,
    identity: relayIdentity,
    preAuthorizedMachines: new Set([getSigningKeyBase64(ownerMachine)]),
  });

  relayUrl = `ws://${TEST_HOST}:${server.port}/ws`;
  relayHttpBase = `http://${TEST_HOST}:${server.port}`;

  const deadline = Date.now() + 3000;
  while (true) {
    try {
      const res = await fetch(`${relayHttpBase}/health`);
      if (res.ok) {
        break;
      }
    } catch {
      // retry until deadline
    }
    if (Date.now() > deadline) {
      throw new Error('Relay server did not become healthy in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

afterAll(() => {
  server.stop(true);

  if (previousControlDir === undefined) {
    delete process.env.GITSPACE_CONTROL_DIR;
  } else {
    process.env.GITSPACE_CONTROL_DIR = previousControlDir;
  }

  rmSync(tempControlDir, { recursive: true, force: true });
});

beforeEach(() => {
  clearAllRegistries();
  removeVaultCategory('fundamental');
  removeVaultCategory('integrations');
  removeVaultCategory('project/workspace');
  removeVaultCategory('preferences');
});

describe('relay basics', () => {
  test('serves health endpoint', async () => {
    const res = await fetch(`${relayHttpBase}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(typeof body.machineCount).toBe('number');
    expect(typeof body.connectedClients).toBe('number');
  });

  test('rejects unknown endpoint', async () => {
    const res = await fetch(`${relayHttpBase}/unknown`);
    expect(res.status).toBe(404);
  });
});

describe('machine registration', () => {
  test('registers a pre-authorized machine via challenge-response', async () => {
    const ws = await connectAndRegisterMachine(ownerMachine);
    ws.close();
  });

  test('rejects an unauthorized machine without enrollment invite', async () => {
    await expect(connectAndRegisterMachine(unauthorizedMachine)).rejects.toThrow(/not authorized/i);
  });

  test('registers a machine with valid relay-machine enrollment token', async () => {
    const ownerWs = await connectClient(relayUrl);

    const enrollmentToken = createRootInviteToken({
      type: 'relay-machine',
      owner: ownerUserRoot,
      relayUrl,
      targetMachineSigningKey: Buffer.from(inviteMachine.signing.publicKey).toString('base64'),
      targetMachineKeyExchangeKey: Buffer.from(inviteMachine.keyExchange.publicKey).toString('base64'),
      expiresAt: Date.now() + 60_000,
      maxUses: 1,
      label: 'enroll-test',
    });

    const created = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'create_root_invite',
        clientIdentityId: ownerClientIdentity.id,
        inviteToken: enrollmentToken,
        deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
      }, ownerClientIdentity),
      'root_invite_created',
    );
    expect(created.type).toBe('root_invite_created');

    const machineWs = await connectAndRegisterMachine(inviteMachine, {
      enrollmentToken,
    });

    machineWs.close();
    ownerWs.close();
  });
});

describe('invite management', () => {
  test('create/list/revoke flow supports relay-machine invites', async () => {
    const ownerWs = await connectClient(relayUrl);

    const inviteToken = createRootInviteToken({
      type: 'relay-machine',
      owner: ownerUserRoot,
      relayUrl,
      targetMachineSigningKey: Buffer.from(inviteMachine.signing.publicKey).toString('base64'),
      targetMachineKeyExchangeKey: Buffer.from(inviteMachine.keyExchange.publicKey).toString('base64'),
      expiresAt: Date.now() + 60_000,
      maxUses: 2,
      label: 'list-revoke-test',
    });
    const parsed = parseRootInviteToken(inviteToken);
    expect(parsed).not.toBeNull();

    const created = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'create_root_invite',
        clientIdentityId: ownerClientIdentity.id,
        inviteToken,
        deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
      }, ownerClientIdentity),
      'root_invite_created',
    );
    expect(created.inviteId).toBe(parsed!.inviteId);

    const listed = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'list_root_invites',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
      }, ownerClientIdentity),
      'root_invite_list',
    );
    expect(Array.isArray(listed.invites)).toBe(true);
    expect(listed.invites.some((invite: { inviteId: string; inviteType: string }) => (
      invite.inviteId === parsed!.inviteId && invite.inviteType === 'relay-machine'
    ))).toBe(true);

    const revoked = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'revoke_root_invite',
        clientIdentityId: ownerClientIdentity.id,
        inviteId: parsed!.inviteId,
        deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
      }, ownerClientIdentity),
      'root_invite_revoked',
    );
    expect(revoked.inviteId).toBe(parsed!.inviteId);

    ownerWs.close();
  });

  test('rejects legacy accept_root_invite client message', async () => {
    const clientWs = await connectClient(relayUrl);

    const legacyMessage = signClientMessage({
      type: 'accept_root_invite',
      clientIdentityId: ownerClientIdentity.id,
      inviteToken: 'gssh-invite:invalid',
      deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
    }, ownerClientIdentity);

    const error = await sendAndWait<any>(clientWs, legacyMessage, 'error');
    expect(error.code).toBe('INVALID_REQUEST');

    clientWs.close();
  });
});

describe('owner-only authorization', () => {
  test('list_machines returns machines only for owner identity', async () => {
    const machineWs = await connectAndRegisterMachine(ownerMachine);

    const ownerWs = await connectClient(relayUrl);
    const ownerList = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'list_machines',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
      }, ownerClientIdentity),
      'machine_list',
    );
    expect(ownerList.machines.some((m: { machineId: string }) => m.machineId === ownerMachine.id)).toBe(true);

    const outsiderWs = await connectClient(relayUrl);
    const outsiderList = await sendAndWait<any>(
      outsiderWs,
      signClientMessage({
        type: 'list_machines',
        clientIdentityId: outsiderClientIdentity.id,
        deviceCertificate: buildDeviceCertificate(outsiderClientIdentity, outsiderUserRoot),
      }, outsiderClientIdentity),
      'machine_list',
    );
    expect(outsiderList.machines).toHaveLength(0);

    machineWs.close();
    ownerWs.close();
    outsiderWs.close();
  });

  test('owner can connect_to_machine, outsider is denied', async () => {
    const machineWs = await connectAndRegisterMachine(ownerMachine);

    const machineConnectedPromise = waitForMessage<any>(machineWs, 'client_connected');

    const ownerWs = await connectClient(relayUrl);
    const established = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'connect_to_machine',
        machineId: ownerMachine.id,
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: buildDeviceCertificate(ownerClientIdentity, ownerUserRoot),
      }, ownerClientIdentity),
      'connection_established',
    );
    expect(established.machineId).toBe(ownerMachine.id);

    const machineConnected = await machineConnectedPromise;
    expect(machineConnected.connectionId).toBe(established.connectionId);

    const outsiderWs = await connectClient(relayUrl);
    const denied = await sendAndWait<any>(
      outsiderWs,
      signClientMessage({
        type: 'connect_to_machine',
        machineId: ownerMachine.id,
        clientIdentityId: outsiderClientIdentity.id,
        deviceCertificate: buildDeviceCertificate(outsiderClientIdentity, outsiderUserRoot),
      }, outsiderClientIdentity),
      'error',
    );
    expect(denied.code).toBe('FORBIDDEN');

    machineWs.close();
    ownerWs.close();
    outsiderWs.close();
  });
});

describe('relay unlock authorization', () => {
  test('rejects unlock_relay when signer does not match claimed owner key', async () => {
    const clientWs = await connectClient(relayUrl);

    const message = signClientMessage({
      type: 'unlock_relay',
      userRootPublicKey: Buffer.from(ownerUserRoot.signing.publicKey).toString('base64'),
      proof: Buffer.from('invalid-proof').toString('base64'),
    }, outsiderClientIdentity);

    const error = await sendAndWait<any>(clientWs, message, 'error');
    expect(error.code).toBe('INVALID_SIGNATURE');

    clientWs.close();
  });
});

describe('owner sync protocol', () => {
  test('owner compare/lock/push/pull/unlock flow works', async () => {
    const ownerWs = await connectClient(relayUrl);
    const ownerDeviceCertificate = buildDeviceCertificate(ownerClientIdentity, ownerUserRoot);

    const initialCompare = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_compare',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        localRevisions: {
          fundamental: 0,
          integrations: 0,
          'project/workspace': 0,
          preferences: 0,
        },
      }, ownerClientIdentity),
      'owner_sync_compare_result',
    );
    expect(initialCompare.serverRevisions.preferences).toBe(0);
    expect(initialCompare.changedCategories).toHaveLength(0);

    const lockGranted = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_lock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        scope: 'global',
        writerId: 'owner-device-a',
        ttlMs: 15_000,
      }, ownerClientIdentity),
      'owner_sync_lock_granted',
    );
    expect(lockGranted.scope).toBe('global');
    expect(typeof lockGranted.lockId).toBe('string');

    const pushed = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_push',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        lockId: lockGranted.lockId,
        record: {
          category: 'preferences',
          expectedRevision: 0,
          updatedAt: Date.now(),
          writerId: 'owner-device-a',
          checksum: 'sha256:test-1',
          ciphertext: Buffer.from('encrypted-payload-1').toString('base64'),
        },
      }, ownerClientIdentity),
      'owner_sync_push_result',
    );
    expect(pushed.category).toBe('preferences');
    expect(pushed.revision).toBe(1);

    const pulled = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_pull',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        categories: ['preferences'],
      }, ownerClientIdentity),
      'owner_sync_pull_result',
    );
    expect(Array.isArray(pulled.records)).toBe(true);
    expect(pulled.records).toHaveLength(1);
    expect(pulled.records[0]?.category).toBe('preferences');
    expect(pulled.records[0]?.revision).toBe(1);

    const driftCompare = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_compare',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        localRevisions: {
          fundamental: 0,
          integrations: 0,
          'project/workspace': 0,
          preferences: 0,
        },
      }, ownerClientIdentity),
      'owner_sync_compare_result',
    );
    expect(driftCompare.serverRevisions.preferences).toBe(1);
    expect(driftCompare.changedCategories).toContain('preferences');

    const unlocked = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_unlock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        lockId: lockGranted.lockId,
      }, ownerClientIdentity),
      'owner_sync_unlock_result',
    );
    expect(unlocked.released).toBe(true);

    ownerWs.close();
  });

  test('rejects stale expected revision with CONFLICT', async () => {
    const ownerWs = await connectClient(relayUrl);
    const ownerDeviceCertificate = buildDeviceCertificate(ownerClientIdentity, ownerUserRoot);

    const lockGranted = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_lock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        scope: 'global',
        writerId: 'owner-device-b',
      }, ownerClientIdentity),
      'owner_sync_lock_granted',
    );

    await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_push',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        lockId: lockGranted.lockId,
        record: {
          category: 'integrations',
          expectedRevision: 0,
          updatedAt: Date.now(),
          writerId: 'owner-device-b',
          checksum: 'sha256:v1',
          ciphertext: Buffer.from('encrypted-v1').toString('base64'),
        },
      }, ownerClientIdentity),
      'owner_sync_push_result',
    );

    const conflict = await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_push',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        lockId: lockGranted.lockId,
        record: {
          category: 'integrations',
          expectedRevision: 0,
          updatedAt: Date.now(),
          writerId: 'owner-device-b',
          checksum: 'sha256:v2',
          ciphertext: Buffer.from('encrypted-v2').toString('base64'),
        },
      }, ownerClientIdentity),
      'error',
    );
    expect(conflict.code).toBe('CONFLICT');

    await sendAndWait<any>(
      ownerWs,
      signClientMessage({
        type: 'owner_sync_unlock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        lockId: lockGranted.lockId,
      }, ownerClientIdentity),
      'owner_sync_unlock_result',
    );

    ownerWs.close();
  });

  test('enforces lock ownership and owner identity checks', async () => {
    const ownerWs1 = await connectClient(relayUrl);
    const ownerWs2 = await connectClient(relayUrl);
    const outsiderWs = await connectClient(relayUrl);
    const ownerDeviceCertificate = buildDeviceCertificate(ownerClientIdentity, ownerUserRoot);

    const lockGranted = await sendAndWait<any>(
      ownerWs1,
      signClientMessage({
        type: 'owner_sync_lock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        scope: 'global',
        writerId: 'owner-device-c',
      }, ownerClientIdentity),
      'owner_sync_lock_granted',
    );

    const lockedError = await sendAndWait<any>(
      ownerWs2,
      signClientMessage({
        type: 'owner_sync_lock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        scope: 'global',
        writerId: 'owner-device-d',
      }, ownerClientIdentity),
      'error',
    );
    expect(lockedError.code).toBe('LOCKED');

    const outsiderError = await sendAndWait<any>(
      outsiderWs,
      signClientMessage({
        type: 'owner_sync_compare',
        clientIdentityId: outsiderClientIdentity.id,
        deviceCertificate: buildDeviceCertificate(outsiderClientIdentity, outsiderUserRoot),
      }, outsiderClientIdentity),
      'error',
    );
    expect(outsiderError.code).toBe('FORBIDDEN');

    await sendAndWait<any>(
      ownerWs1,
      signClientMessage({
        type: 'owner_sync_unlock',
        clientIdentityId: ownerClientIdentity.id,
        deviceCertificate: ownerDeviceCertificate,
        lockId: lockGranted.lockId,
      }, ownerClientIdentity),
      'owner_sync_unlock_result',
    );

    ownerWs1.close();
    ownerWs2.close();
    outsiderWs.close();
  });
});
