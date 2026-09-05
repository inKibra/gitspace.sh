import { describe, expect, it } from 'bun:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import {
  createDeviceBinding, signDeviceInvite, credentialProtocolBase64, credentialAuthorityGrantPayload,
  signCredentialAuthorityGrant, verifyCredentialAuthorityGrant, encodeMachinePairingToken, decodeMachinePairingToken,
  type DeviceGrantRecord, type SignedCredentialAuthorityGrant,
} from '../src/index.js';

const now = 1_800_000_000_000;
const rootKey = new Uint8Array(32).fill(1);
const browserKey = new Uint8Array(32).fill(2);
const machineKey = new Uint8Array(32).fill(3);
const userId = 'u-0123456789abcdef0123456789abcdef';
const deviceId = '11111111-1111-4111-8111-111111111111';
const rootPublicKey = ed25519.getPublicKey(rootKey);

function issuer(): DeviceGrantRecord {
  const invite = signDeviceInvite({
    version: 1, userId, inviteId: '22222222-2222-4222-8222-222222222222', kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: ['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control'],
    canDelegate: true, issuedAt: now - 1_000, expiresAt: now + 60_000, grantTtlMs: 3_600_000, enrollUrl: 'https://api.gitspace.sh/v1/devices/enroll',
  }, rootKey);
  return { invite, binding: createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId,
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: now, signingPrivateKey: browserKey }), generation: 1, revokedAt: null };
}

function machineGrant(record = issuer()): SignedCredentialAuthorityGrant {
  const grant = { version: 1 as const, userId, machineId: 'laptop',
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineKey)),
    capabilities: ['storage.access', 'space.control', 'credential.access', 'credential.manage'] as const,
    generation: 1, issuerDeviceId: deviceId, expiresAt: now + 3_600_000 };
  const mutable = { ...grant, capabilities: [...grant.capabilities] };
  return { grant: mutable, issuerChain: [record], signature: credentialProtocolBase64.encode(ed25519.sign(credentialAuthorityGrantPayload(mutable), browserKey)) };
}

describe('delegated machine credential authority', () => {
  it('verifies root/device proof offline but gives canonical issuer revocation precedence', () => {
    const record = issuer();
    const signed = machineGrant(record);
    expect(verifyCredentialAuthorityGrant(signed, rootPublicKey, now)?.machineId).toBe('laptop');
    expect(verifyCredentialAuthorityGrant(signed, rootPublicKey, now, () => ({ ...record, revokedAt: now, generation: 2 }))).toBeNull();
    expect(verifyCredentialAuthorityGrant(signed, rootPublicKey, now, () => null)).toBeNull();
    expect(verifyCredentialAuthorityGrant(signed, rootPublicKey, now + 3_600_000)).toBeNull();
    expect(verifyCredentialAuthorityGrant({ ...signed, issuerChain: undefined }, rootPublicKey, now)).toBeNull();
    expect(verifyCredentialAuthorityGrant({ ...signed, grant: { ...signed.grant, exchangePublicKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(8)) } }, rootPublicKey, now)).toBeNull();
  });

  it('refuses delegation without account release authority or a matching account scope', () => {
    const record = issuer();
    for (const invite of [
      { ...record.invite.invite, capabilities: record.invite.invite.capabilities.filter((capability) => capability !== 'deployment.control') },
      { ...record.invite.invite, canDelegate: false },
      { ...record.invite.invite, userId: 'another-account' },
      { ...record.invite.invite, scope: { kind: 'project' as const, projectId: 'project-a' } },
    ]) {
      const limited = { ...record, invite: signDeviceInvite(invite, rootKey) };
      expect(verifyCredentialAuthorityGrant(machineGrant(limited), rootPublicKey, now)).toBeNull();
    }
  });

  it('keeps root-signed machine grants valid without allowing a forged device issuer attachment', () => {
    const { issuerDeviceId: _issuer, expiresAt: _expires, ...grant } = machineGrant().grant;
    const signed = signCredentialAuthorityGrant(grant, rootKey);
    expect(verifyCredentialAuthorityGrant(signed, rootPublicKey, now)?.machineId).toBe('laptop');
    expect(verifyCredentialAuthorityGrant({ ...signed, issuerChain: [issuer()] }, rootPublicKey, now)).toBeNull();
  });
});

describe('machine pairing command tokens', () => {
  it('bounds lifetime and rejects redirects to insecure or credential-bearing origins', () => {
    const input = { version: 1 as const, userId, pairingId: deviceId, token: 'a'.repeat(43), operatorUrl: 'https://api.gitspace.sh', expiresAt: now + 600_000 };
    const encoded = encodeMachinePairingToken(input, now);
    expect(decodeMachinePairingToken(encoded, now)).toEqual(input);
    expect(decodeMachinePairingToken(encoded, now + 600_000)).toBeNull();
    expect(() => encodeMachinePairingToken({ ...input, expiresAt: now + 600_001 }, now)).toThrow();
    for (const operatorUrl of ['http://api.gitspace.sh', 'https://user:password@api.gitspace.sh', 'https://api.gitspace.sh/path', 'https://api.gitspace.sh?redirect=other']) {
      expect(() => encodeMachinePairingToken({ ...input, operatorUrl }, now)).toThrow();
    }
    expect(decodeMachinePairingToken(encodeMachinePairingToken({ ...input, operatorUrl: 'http://127.0.0.1:8787' }, now), now)?.operatorUrl).toBe('http://127.0.0.1:8787');
  });
});
