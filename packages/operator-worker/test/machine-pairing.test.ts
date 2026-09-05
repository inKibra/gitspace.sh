import { describe, expect, it } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createDeviceBinding, credentialAuthorityGrantPayload, credentialProtocolBase64, signDeviceInvite, signRpcRequest,
  verifyCredentialAuthorityGrant, type CredentialAuthorityGrant, type DeviceGrantRecord, type SignedCredentialAuthorityGrant,
} from '@gitspace/protocol';
import type { CredentialVaultDO } from '../src/index.js';

interface TestAccount {
  userId: string;
  deviceId: string;
  vault: DurableObjectStub<CredentialVaultDO>;
}
interface CreatedPairing { pairingId: string; token: string; expiresAt: number }

const rootKey = new Uint8Array(32).fill(11);
const browserKey = new Uint8Array(32).fill(22);
const machineKey = new Uint8Array(32).fill(33);
const otherKey = new Uint8Array(32).fill(44);
const base = 'https://auth.test/v1/machine-pairings/';

async function account(): Promise<TestAccount> {
  const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
  const handle = `pair-${crypto.randomUUID().slice(0, 8)}`;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(55)) });
  await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle });
  await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
  const settings = env.USER_SETTINGS.getByName(userId);
  const current = await settings.get('pairing-test');
  await settings.setHandle('pairing-test', current.revision, handle);
  const invite = signDeviceInvite({
    version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: 'Browser', scope: { kind: 'user' },
    capabilities: ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'],
    canDelegate: true, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: 3_600_000, enrollUrl: 'https://auth.test/v1/devices/enroll',
  }, rootKey);
  const deviceId = crypto.randomUUID();
  await vault.enrollDevice({ invite, binding: createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId, signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: browserKey }) });
  return { userId, vault, deviceId };
}

function signedRequest(operation: string, body: Record<string, unknown>, deviceId: string, signingPrivateKey: Uint8Array) {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const path = `/v1/machine-pairings/${operation}`;
  return new Request(`${base}${operation}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-gitspace-device': signRpcRequest({ deviceId, signingPrivateKey, method: 'POST', path, body: bytes }),
  }, body: bytes });
}

async function created(owner: TestAccount): Promise<CreatedPairing> {
  const response = await SELF.fetch(signedRequest('create', { userId: owner.userId }, owner.deviceId, browserKey));
  expect(response.status).toBe(200);
  return (await response.json() as { value: { pairingId: string; token: string; expiresAt: number } }).value;
}

function claimBody(userId: string, pairing: CreatedPairing, signingKey = machineKey) {
  return { userId, pairingId: pairing.pairingId, token: pairing.token, machineId: `physical-${pairing.pairingId}`, label: 'My laptop',
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingKey)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(66))) };
}

async function approved(owner: TestAccount, pairing: CreatedPairing) {
  expect((await SELF.fetch(signedRequest('claim', claimBody(owner.userId, pairing), pairing.pairingId, machineKey))).status).toBe(200);
  const inspected = await SELF.fetch(signedRequest('inspect', { userId: owner.userId, pairingId: pairing.pairingId }, owner.deviceId, browserKey));
  const { value } = await inspected.json() as { value: { grant: CredentialAuthorityGrant; issuerChain: DeviceGrantRecord[] } };
  const grant: SignedCredentialAuthorityGrant = { grant: value.grant, issuerChain: value.issuerChain, signature: credentialProtocolBase64.encode(ed25519.sign(credentialAuthorityGrantPayload(value.grant), browserKey)) };
  expect((await SELF.fetch(signedRequest('approve', { userId: owner.userId, pairingId: pairing.pairingId, grant }, owner.deviceId, browserKey))).status).toBe(200);
  return grant;
}

describe('browser-approved machine pairing', () => {
  it('requires authentic browser requests and rejects replay and body substitution', async () => {
    const owner = await account();
    expect((await SELF.fetch(new Request(`${base}create`, { method: 'POST', body: JSON.stringify({ userId: owner.userId }) }))).status).toBe(403);
    const request = signedRequest('create', { userId: owner.userId }, owner.deviceId, browserKey);
    const replay = request.clone();
    expect((await SELF.fetch(request)).status).toBe(200);
    expect(await (await SELF.fetch(replay)).json()).toMatchObject({ error: { code: 'REQUEST_REPLAY' } });
    const altered = signedRequest('create', { userId: owner.userId }, owner.deviceId, browserKey);
    expect((await SELF.fetch(new Request(altered.url, { method: 'POST', headers: altered.headers, body: JSON.stringify({ userId: owner.userId, extra: 'not signed' }) }))).status).toBe(403);
  });

  it('binds the token once, permits exact signed retry, and discloses nothing before approval', async () => {
    const owner = await account();
    const pairing = await created(owner);
    const body = claimBody(owner.userId, pairing);
    const forgedProof = signedRequest('claim', body, pairing.pairingId, otherKey);
    expect((await SELF.fetch(forgedProof)).status).toBe(403);
    expect((await SELF.fetch(signedRequest('claim', body, pairing.pairingId, machineKey))).status).toBe(200);
    expect((await SELF.fetch(signedRequest('claim', body, pairing.pairingId, machineKey))).status).toBe(200);
    expect((await SELF.fetch(signedRequest('claim', claimBody(owner.userId, pairing, otherKey), pairing.pairingId, otherKey))).status).toBe(403);
    const poll = { userId: owner.userId, pairingId: pairing.pairingId };
    expect(await (await SELF.fetch(signedRequest('poll', poll, pairing.pairingId, machineKey))).json()).toEqual({ status: 'ok', value: { state: 'pending' } });
    expect((await SELF.fetch(signedRequest('poll', poll, pairing.pairingId, otherKey))).status).toBe(403);
  });

  it('returns relay-compatible scoped config retryably and enforces canonical issuer revocation', async () => {
    const owner = await account();
    const pairing = await created(owner);
    const grant = await approved(owner, pairing);
    expect(verifyCredentialAuthorityGrant(grant, ed25519.getPublicKey(rootKey))?.machineId).toBe(grant.grant.machineId);
    const body = { userId: owner.userId, pairingId: pairing.pairingId };
    const first = await SELF.fetch(signedRequest('poll', body, pairing.pairingId, machineKey));
    expect(first.status).toBe(200);
    const delivered = await first.json() as { value: Record<string, unknown> };
    expect(delivered.value).toMatchObject({ state: 'enrolled', machineId: grant.grant.machineId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootKey)), grant });
    expect(delivered.value).not.toHaveProperty('rootPrivateKey');
    expect(delivered.value).not.toHaveProperty('vaultKey');
    expect(await (await SELF.fetch(signedRequest('poll', body, pairing.pairingId, machineKey))).json()).toEqual(delivered);
    expect(await owner.vault.authorizeBroker(grant.grant.machineId, 1)).toBe(true);
    await owner.vault.revokeDeviceGrant(owner.deviceId);
    expect((await SELF.fetch(signedRequest('poll', body, pairing.pairingId, machineKey))).status).toBe(403);
    expect(await owner.vault.authorizeRelayGrant(grant, 'space.control')).toMatchObject({ status: 'error' });
    expect(await owner.vault.authorizeBroker(grant.grant.machineId, 1)).toBe(false);
  });

  it('rejects cross-account, cancelled, expired and revoked-machine delivery', async () => {
    const owner = await account();
    const other = await account();
    const pairing = await created(owner);
    expect((await SELF.fetch(signedRequest('inspect', { userId: other.userId, pairingId: pairing.pairingId }, other.deviceId, browserKey))).status).toBe(403);
    expect((await SELF.fetch(signedRequest('cancel', { userId: owner.userId, pairingId: pairing.pairingId }, owner.deviceId, browserKey))).status).toBe(200);
    expect((await SELF.fetch(signedRequest('claim', claimBody(owner.userId, pairing), pairing.pairingId, machineKey))).status).toBe(403);
    const expired = await created(owner);
    await runInDurableObject(owner.vault, async (_instance, state) => {
      state.storage.sql.exec('UPDATE machine_pairings SET expires_at = ? WHERE pairing_id = ?', Date.now() - 1, expired.pairingId);
    });
    expect((await SELF.fetch(signedRequest('claim', claimBody(owner.userId, expired), expired.pairingId, machineKey))).status).toBe(403);
    const revoked = await created(owner);
    const grant = await approved(owner, revoked);
    await owner.vault.removeManagedDevice(grant.grant.machineId);
    expect((await SELF.fetch(signedRequest('poll', { userId: owner.userId, pairingId: revoked.pairingId }, revoked.pairingId, machineKey))).status).toBe(403);
  });
});
