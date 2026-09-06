import { describe, expect, it } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest, verifyDeviceGrantRecord,
  type DeviceInvite, type SignedDeviceInvite,
} from '@gitspace/protocol';
import type { CredentialVaultDO } from '../src/index.js';

interface TestAccount {
  userId: string;
  handle: string;
  deviceId: string;
  vault: DurableObjectStub<CredentialVaultDO>;
}
interface InvitationValue {
  inviteId: string;
  expiresAt: number;
  status: 'pending' | 'redeemed' | 'cancelled' | 'expired';
  deviceId: string | null;
}

const rootKey = new Uint8Array(32).fill(71);
const browserKey = new Uint8Array(32).fill(72);
const newBrowserKey = new Uint8Array(32).fill(73);
const capabilities: DeviceInvite['capabilities'] = ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'];
const basePath = '/v1/devices/browser-invitations/';

async function account(rights: Partial<Pick<DeviceInvite, 'kind' | 'scope' | 'capabilities' | 'canDelegate' | 'grantTtlMs'>> = {}): Promise<TestAccount> {
  const userId = `u-${crypto.randomUUID().replaceAll('-', '')}`;
  const handle = `browser-${crypto.randomUUID().slice(0, 8)}`;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(74)) });
  await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId, handle });
  await env.ACCOUNTS.getByName('global').markActive({ userId, release: null });
  const invite = signDeviceInvite({
    version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities, canDelegate: true, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null,
    enrollUrl: 'https://api.gitspace.sh/v1/devices/enroll', ...rights,
  }, rootKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Existing browser', boundAt: Date.now(), signingPrivateKey: browserKey });
  expect(await vault.enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  return { userId, handle, vault, deviceId: binding.deviceId };
}

function delegated(owner: TestAccount, overrides: Partial<DeviceInvite> = {}): SignedDeviceInvite {
  const issuedAt = Date.now();
  return signDeviceInvite({
    version: 1, userId: owner.userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities, canDelegate: true, issuedAt, expiresAt: issuedAt + 300_000, grantTtlMs: null,
    enrollUrl: `https://${owner.handle}.gitspace.sh/v1/devices/enroll`, ...overrides,
  }, browserKey, { kind: 'device', deviceId: owner.deviceId });
}

function signedRequest(owner: TestAccount, operation: string, payload: Record<string, unknown>, signingPrivateKey = browserKey): Request {
  const body = new TextEncoder().encode(JSON.stringify({ userId: owner.userId, ...payload }));
  const path = `${basePath}${operation}`;
  return new Request(`https://${owner.handle}.gitspace.sh${path}`, { method: 'POST', headers: {
    'content-type': 'application/json', 'x-gitspace-user': owner.userId,
    'x-gitspace-device': signRpcRequest({ deviceId: owner.deviceId, signingPrivateKey, method: 'POST', path, body }),
  }, body });
}

async function register(owner: TestAccount, invite = delegated(owner)): Promise<SignedDeviceInvite> {
  const response = await SELF.fetch(signedRequest(owner, 'create', { invite }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'ok', value: { inviteId: invite.invite.inviteId, expiresAt: invite.invite.expiresAt, status: 'pending', deviceId: null } });
  return invite;
}

async function redeem(invite: SignedDeviceInvite, origin = new URL(invite.invite.enrollUrl).origin): Promise<Response> {
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(newBrowserKey)), label: 'New browser', boundAt: Date.now(), signingPrivateKey: newBrowserKey });
  return SELF.fetch(`${origin}/v1/devices/enroll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite, binding }) });
}

async function status(owner: TestAccount, invite: SignedDeviceInvite): Promise<InvitationValue> {
  const response = await SELF.fetch(signedRequest(owner, 'status', { inviteId: invite.invite.inviteId }));
  expect(response.status).toBe(200);
  return (await response.json() as { value: InvitationValue }).value;
}

describe('registered browser invitations', () => {
  it('authenticates signed bytes, rejects replay and prevents unsigned account or target substitution', async () => {
    const owner = await account();
    const invite = delegated(owner);
    const request = signedRequest(owner, 'create', { invite });
    const replay = request.clone();
    const unsigned = request.clone();
    unsigned.headers.delete('x-gitspace-device');
    expect((await SELF.fetch(unsigned)).status).toBe(403);
    const wrongKey = signedRequest(owner, 'create', { invite }, newBrowserKey);
    expect((await SELF.fetch(wrongKey)).status).toBe(403);
    const substituted = signDeviceInvite({ ...invite.invite, label: 'Substituted' }, browserKey, invite.issuer);
    expect((await SELF.fetch(new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify({ userId: owner.userId, invite: substituted }) }))).status).toBe(403);
    expect((await SELF.fetch(request)).status).toBe(200);
    expect(await (await SELF.fetch(replay)).json()).toMatchObject({ error: { code: 'REQUEST_REPLAY' } });
    const changedTarget = signedRequest(owner, 'status', { inviteId: invite.invite.inviteId });
    expect((await SELF.fetch(new Request(changedTarget.url.replace('/status', '/cancel'), changedTarget))).status).toBe(403);
    const changedAccount = signedRequest(owner, 'status', { inviteId: invite.invite.inviteId });
    changedAccount.headers.set('x-gitspace-user', `u-${'0'.repeat(32)}`);
    expect((await SELF.fetch(changedAccount)).status).toBe(400);
    expect((await status(owner, invite)).status).toBe('pending');
  });

  it.each([
    { kind: 'client' as const },
    { canDelegate: false },
    { capabilities: ['rpc.read'] as DeviceInvite['capabilities'] },
    { scope: { kind: 'project' as const, projectId: 'project-a' } },
  ])('requires an account-wide delegating browser with devices.manage: %j', async (rights) => {
    const owner = await account(rights);
    const response = await SELF.fetch(signedRequest(owner, 'create', { invite: delegated(owner) }));
    expect(await response.json()).toMatchObject({ error: { code: 'RPC_FORBIDDEN' } });
  });

  it('bounds account, issuer, scope, capabilities and both invitation and grant lifetimes', async () => {
    const owner = await account({ capabilities: ['rpc.read', 'devices.manage'], grantTtlMs: 3_600_000 });
    const valid = delegated(owner, { capabilities: ['rpc.read', 'devices.manage'], grantTtlMs: 60_000 });
    const invalid = [
      signDeviceInvite(valid.invite, rootKey),
      signDeviceInvite(valid.invite, browserKey, { kind: 'device', deviceId: crypto.randomUUID() }),
      signDeviceInvite(valid.invite, newBrowserKey, valid.issuer),
      delegated(owner, { ...valid.invite, userId: `u-${'1'.repeat(32)}` }),
      delegated(owner, { ...valid.invite, kind: 'client' }),
      delegated(owner, { ...valid.invite, scope: { kind: 'workspace', workspaceId: 'workspace-a' } }),
      delegated(owner, { ...valid.invite, capabilities: ['rpc.read', 'fleet.control'] }),
      delegated(owner, { ...valid.invite, expiresAt: valid.invite.issuedAt + 300_001 }),
      delegated(owner, { ...valid.invite, issuedAt: Date.now() + 120_000, expiresAt: Date.now() + 180_000 }),
      delegated(owner, { ...valid.invite, grantTtlMs: null }),
      delegated(owner, { ...valid.invite, grantTtlMs: 3_600_000 }),
    ];
    for (const invite of invalid) {
      expect(await (await SELF.fetch(signedRequest(owner, 'create', { invite }))).json()).toMatchObject({ error: { code: 'INVALID_DEVICE_INVITE' } });
    }
    const expired = delegated(owner, { ...valid.invite, issuedAt: Date.now() - 300_000, expiresAt: Date.now() - 1 });
    expect(await (await SELF.fetch(signedRequest(owner, 'create', { invite: expired }))).json()).toMatchObject({ error: { code: 'DEVICE_INVITE_EXPIRED' } });
    await register(owner, valid);
    expect((await redeem(valid)).status).toBe(200);
  });

  it('rejects unregistered browser links and replacement grants under a registered invite id', async () => {
    const owner = await account();
    const invite = delegated(owner);
    expect(await (await redeem(invite)).json()).toMatchObject({ error: { code: 'BROWSER_INVITATION_UNREGISTERED' } });
    await register(owner, invite);
    const replacement = signDeviceInvite({ ...invite.invite, label: 'Different signed grant' }, browserKey, invite.issuer);
    expect(await (await redeem(replacement)).json()).toMatchObject({ error: { code: 'INVALID_DEVICE_INVITE' } });
    expect((await redeem(invite)).status).toBe(200);
  });

  it('redeems only once under contention and cancellation after redemption does not revoke access', async () => {
    const owner = await account();
    const invite = await register(owner);
    const attempts = await Promise.all([redeem(invite), redeem(invite)]);
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 400]);
    const redeemed = (await attempts.find((response) => response.status === 200)!.json() as { value: { deviceId: string } }).value;
    expect(await status(owner, invite)).toMatchObject({ status: 'redeemed', deviceId: redeemed.deviceId });
    const cancelled = await SELF.fetch(signedRequest(owner, 'cancel', { inviteId: invite.invite.inviteId }));
    expect(await cancelled.json()).toMatchObject({ value: { status: 'redeemed', deviceId: redeemed.deviceId } });
    const records = await owner.vault.listDeviceGrants();
    const record = records.find((candidate) => candidate.binding.deviceId === redeemed.deviceId)!;
    expect(verifyDeviceGrantRecord(record, ed25519.getPublicKey(rootKey), Date.now(), (id) => records.find((candidate) => candidate.binding.deviceId === id) ?? null)?.deviceId).toBe(redeemed.deviceId);
  });

  it('cancels copied links permanently and resolves cancel versus redeem to one terminal outcome', async () => {
    const owner = await account();
    const invite = await register(owner);
    expect(await (await SELF.fetch(signedRequest(owner, 'cancel', { inviteId: invite.invite.inviteId }))).json()).toMatchObject({ value: { status: 'cancelled', deviceId: null } });
    expect(await (await redeem(invite)).json()).toMatchObject({ error: { code: 'DEVICE_INVITE_CANCELLED' } });
    expect(await (await SELF.fetch(signedRequest(owner, 'create', { invite }))).json()).toMatchObject({ error: { code: 'DEVICE_INVITE_EXISTS' } });
    expect((await status(owner, invite)).status).toBe('cancelled');
    const raced = await register(owner);
    const [cancel, enrollment] = await Promise.all([
      SELF.fetch(signedRequest(owner, 'cancel', { inviteId: raced.invite.inviteId })), redeem(raced),
    ]);
    const terminal = await status(owner, raced);
    expect(await cancel.json()).toMatchObject({ value: terminal });
    if (terminal.status === 'cancelled') {
      expect(enrollment.status).toBe(400);
      expect((await owner.vault.listDeviceGrants()).some((record) => record.invite.invite.inviteId === raced.invite.inviteId)).toBe(false);
    } else {
      expect(terminal.status).toBe('redeemed');
      expect(enrollment.status).toBe(200);
      expect(await enrollment.json()).toMatchObject({ value: { deviceId: terminal.deviceId } });
    }
  });

  it('expires persisted pending registrations without cancelling or revoking redeemed devices', async () => {
    const owner = await account();
    const invite = await register(owner);
    const used = await register(owner);
    const enrollment = await redeem(used);
    expect(enrollment.status).toBe(200);
    const { value: enrolled } = await enrollment.json() as { value: { deviceId: string } };
    await runInDurableObject(owner.vault, async (_instance, state) => {
      state.storage.sql.exec('UPDATE browser_invitations SET expires_at = ? WHERE invite_id IN (?, ?)', Date.now() - 1, invite.invite.inviteId, used.invite.inviteId);
    });
    expect((await status(owner, invite)).status).toBe('expired');
    expect(await (await redeem(invite)).json()).toMatchObject({ error: { code: 'DEVICE_INVITE_EXPIRED' } });
    expect(await (await SELF.fetch(signedRequest(owner, 'cancel', { inviteId: invite.invite.inviteId }))).json()).toMatchObject({ value: { status: 'expired', deviceId: null } });
    expect(await status(owner, used)).toMatchObject({ status: 'redeemed', deviceId: enrolled.deviceId });
  });

  it('denies foreign browsers, account host substitution, revoked issuers and suspended accounts', async () => {
    const owner = await account();
    const other = await account();
    const invite = await register(owner);
    expect((await SELF.fetch(signedRequest(other, 'status', { inviteId: invite.invite.inviteId }))).status).toBe(403);
    const foreignBrowser = { ...owner, deviceId: other.deviceId };
    expect((await SELF.fetch(signedRequest(foreignBrowser, 'cancel', { inviteId: invite.invite.inviteId }))).status).toBe(403);
    const secondBrowser = signDeviceInvite(delegated(owner).invite, rootKey);
    const secondEnrollment = await redeem(secondBrowser);
    expect(secondEnrollment.status).toBe(200);
    const secondDevice = (await secondEnrollment.json() as { value: { deviceId: string } }).value;
    const sameAccountBrowser = { ...owner, deviceId: secondDevice.deviceId };
    for (const operation of ['status', 'cancel']) {
      expect(await (await SELF.fetch(signedRequest(sameAccountBrowser, operation, { inviteId: invite.invite.inviteId }, newBrowserKey))).json()).toMatchObject({ error: { code: 'BROWSER_INVITATION_UNAVAILABLE' } });
    }
    const mismatchedHost = signedRequest(owner, 'status', { inviteId: invite.invite.inviteId });
    expect(await (await SELF.fetch(new Request(mismatchedHost.url.replace(owner.handle, other.handle), mismatchedHost))).json()).toMatchObject({ error: { code: 'ACCOUNT_HOST_MISMATCH' } });
    expect(await (await redeem(invite, `https://${other.handle}.gitspace.sh`)).json()).toMatchObject({ error: { code: 'ACCOUNT_HOST_MISMATCH' } });
    await owner.vault.revokeDeviceGrant(owner.deviceId);
    expect((await SELF.fetch(signedRequest(owner, 'status', { inviteId: invite.invite.inviteId }))).status).toBe(403);
    expect((await SELF.fetch(signedRequest(owner, 'create', { invite: delegated(owner) }))).status).toBe(403);
    expect(await (await redeem(invite)).json()).toMatchObject({ error: { code: 'INVALID_DEVICE_INVITE' } });
    const suspended = await register(other);
    await env.ACCOUNTS.getByName('global').setStatus({ userId: other.userId, status: 'suspended', reason: 'security test', actor: 'operator', action: 'suspend' });
    expect(await (await SELF.fetch(signedRequest(other, 'cancel', { inviteId: suspended.invite.inviteId }))).json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
    expect(await (await redeem(suspended)).json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
  });
});
