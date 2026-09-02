import { describe, expect, it } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createDeviceBinding,
  createSignedControlRequest,
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
  signDeviceInvite,
  verifyDeviceGrantRecord,
  type DeviceGrantRecord,
  type SignedDeviceInvite,
} from '@gitspace/protocol';

const rootPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const machinePrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
const browserPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 90);

async function bootstrapUser(): Promise<string> {
  const userId = `user-devices-${crypto.randomUUID()}`;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({
    userId,
    rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
    vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)),
  });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'machine-a',
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machinePrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(5))),
    capabilities: ['space.control'], generation: 1,
  }, rootPrivateKey));
  return userId;
}

function invite(userId: string, expiresAt = Date.now() + 60_000) {
  return signDeviceInvite({
    version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: ['rpc.read', 'rpc.write', 'session.prompt', 'devices.manage'], canDelegate: true, issuedAt: Date.now(), expiresAt, grantTtlMs: null, enrollUrl: 'https://auth.test',
  }, rootPrivateKey);
}

async function enroll(signedInvite: SignedDeviceInvite, privateKey = browserPrivateKey): Promise<Response> {
  const binding = createDeviceBinding({
    inviteId: signedInvite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(privateKey)),
    label: 'Chrome', boundAt: Date.now(), signingPrivateKey: privateKey,
  });
  return SELF.fetch('https://auth.test/v1/devices/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: signedInvite, binding }) });
}

async function control(userId: string, operation: 'devices.list' | 'devices.revoke', payload: Record<string, unknown>): Promise<Response> {
  const request = createSignedControlRequest({ userId, machineId: 'machine-a', operation, payload, signingPrivateKey: machinePrivateKey });
  return SELF.fetch('https://auth.test/v1/control', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
}

describe('device grants', () => {
  it('redeems an invite once, lists a verifiable record, and revokes it', async () => {
    const userId = await bootstrapUser();
    const signedInvite = invite(userId);
    const enrolled = await enroll(signedInvite);
    expect(enrolled.status).toBe(200);
    const { value } = await enrolled.json() as { value: { deviceId: string; expiresAt: number | null } };
    expect(value.expiresAt).toBeNull();

    const replay = await enroll(signedInvite, Uint8Array.from({ length: 32 }, (_, index) => index + 120));
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ error: { code: 'DEVICE_INVITE_USED' } });

    const listed = await control(userId, 'devices.list', {});
    expect(listed.status).toBe(200);
    const records = (await listed.json() as { value: DeviceGrantRecord[] }).value;
    expect(records).toHaveLength(1);
    const verified = verifyDeviceGrantRecord(records[0]!, ed25519.getPublicKey(rootPrivateKey));
    expect(verified).toMatchObject({ deviceId: value.deviceId, kind: 'browser', label: 'Chrome', capabilities: ['rpc.read', 'rpc.write', 'session.prompt', 'devices.manage'] });

    const revoked = await control(userId, 'devices.revoke', { deviceId: value.deviceId });
    expect(revoked.status).toBe(200);
    const after = (await (await control(userId, 'devices.list', {})).json() as { value: DeviceGrantRecord[] }).value;
    expect(after[0]).toMatchObject({ generation: 2 });
    expect(after[0]?.revokedAt).not.toBeNull();
    expect(verifyDeviceGrantRecord(after[0]!, ed25519.getPublicKey(rootPrivateKey))).toBeNull();
  });

  it('rejects expired invites, foreign roots, and mismatched bindings', async () => {
    const userId = await bootstrapUser();
    const expired = await enroll(invite(userId, Date.now() - 1));
    expect(await expired.json()).toMatchObject({ error: { code: 'DEVICE_INVITE_EXPIRED' } });

    const foreign = signDeviceInvite({ ...invite(userId).invite, inviteId: crypto.randomUUID() }, Uint8Array.from({ length: 32 }, () => 42));
    expect(await (await enroll(foreign)).json()).toMatchObject({ error: { code: 'INVALID_DEVICE_INVITE' } });

    const signedInvite = invite(userId);
    const binding = createDeviceBinding({
      inviteId: crypto.randomUUID(), deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserPrivateKey)),
      label: 'Chrome', boundAt: Date.now(), signingPrivateKey: browserPrivateKey,
    });
    const mismatched = await SELF.fetch('https://auth.test/v1/devices/enroll', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: signedInvite, binding }) });
    expect(await mismatched.json()).toMatchObject({ error: { code: 'INVALID_DEVICE_BINDING' } });
  });

  it('enrolls a client delegated by an enrolled browser and refuses escalation', async () => {
    const userId = await bootstrapUser();
    const browserInvite = invite(userId);
    const browser = await enroll(browserInvite);
    const { value: browserDevice } = await browser.json() as { value: { deviceId: string } };
    const clientPrivateKey = Uint8Array.from({ length: 32 }, (_, index) => index + 140);
    const delegated = (capabilities: Array<'rpc.read' | 'fleet.control'>) => signDeviceInvite({
      version: 1, userId, inviteId: crypto.randomUUID(), kind: 'client', label: 'CI', scope: { kind: 'user' },
      capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: 3_600_000, enrollUrl: 'https://auth.test',
    }, browserPrivateKey, { kind: 'device', deviceId: browserDevice.deviceId });
    const enrolled = await enroll(delegated(['rpc.read']), clientPrivateKey);
    expect(enrolled.status).toBe(200);
    const escalated = await enroll(delegated(['rpc.read', 'fleet.control']), clientPrivateKey);
    expect(await escalated.json()).toMatchObject({ error: { code: 'INVALID_DEVICE_INVITE' } });
    const records = (await (await control(userId, 'devices.list', {})).json() as { value: DeviceGrantRecord[] }).value;
    const resolve = (deviceId: string) => records.find((record) => record.binding.deviceId === deviceId) ?? null;
    const client = records.find((record) => record.invite.invite.kind === 'client')!;
    expect(verifyDeviceGrantRecord(client, ed25519.getPublicKey(rootPrivateKey), Date.now(), resolve)).toMatchObject({ kind: 'client', capabilities: ['rpc.read'] });
    // Revoking the browser silently invalidates the key it minted.
    await control(userId, 'devices.revoke', { deviceId: browserDevice.deviceId });
    const after = (await (await control(userId, 'devices.list', {})).json() as { value: DeviceGrantRecord[] }).value;
    const resolveAfter = (deviceId: string) => after.find((record) => record.binding.deviceId === deviceId) ?? null;
    expect(verifyDeviceGrantRecord(after.find((record) => record.invite.invite.kind === 'client')!, ed25519.getPublicKey(rootPrivateKey), Date.now(), resolveAfter)).toBeNull();
  });
});
