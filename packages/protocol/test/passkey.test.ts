import { describe, expect, it } from 'bun:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  BROWSER_GRANT_CAPABILITIES,
  createDeviceBinding,
  deviceInvitePayload,
  deviceProtocolBase64,
  passkeyRegistrationPayload,
  signDeviceInvite,
  verifyDeviceGrantRecord,
  type DeviceGrantRecord,
  type DeviceInvite,
  type PasskeyRegistration,
  type SignedPasskeyRegistration,
} from '../src/device-grant.js';
import { verifyWebAuthnAssertion, verifyWebAuthnRegistration, type PasskeyAlgorithm } from '../src/passkey.js';
import { softwareAuthenticator, type SoftwareAuthenticator } from './software-authenticator.js';

const RP = { rpId: 'alice.gitspace.sh', origin: 'https://alice.gitspace.sh' };
const NOW = 1_800_000_000_000;
const rootPrivate = new Uint8Array(32).fill(7);
const rootPublic = ed25519.getPublicKey(rootPrivate);
const browserPrivate = new Uint8Array(32).fill(9);
const newDevicePrivate = new Uint8Array(32).fill(11);
const challenge = sha256(new TextEncoder().encode('challenge'));
const ALGORITHMS: PasskeyAlgorithm[] = [-7, -8, -257];

async function registered(authenticator: SoftwareAuthenticator) {
  const key = verifyWebAuthnRegistration(await authenticator.register({ challenge, ...RP }), { challenge, ...RP });
  if (!key) throw new Error('Registration did not verify');
  return key;
}

describe('WebAuthn registration', () => {
  for (const algorithm of ALGORITHMS) {
    it(`accepts a user-verified ${algorithm} credential for this challenge, relying party and origin`, async () => {
      const authenticator = await softwareAuthenticator(algorithm);
      const response = await authenticator.register({ challenge, backupEligible: true, ...RP });
      expect(verifyWebAuthnRegistration(response, { challenge, ...RP })).toMatchObject({ credentialId: authenticator.credentialId, algorithm, backupEligible: true, signCount: 0 });
    });
  }

  it('refuses another challenge, origin or relying party, an unverified user, and an assertion posing as a registration', async () => {
    const authenticator = await softwareAuthenticator();
    const expected = { challenge, ...RP };
    expect(verifyWebAuthnRegistration(await authenticator.register({ ...expected }), { ...expected, challenge: sha256(challenge) })).toBeNull();
    expect(verifyWebAuthnRegistration(await authenticator.register({ ...expected, origin: 'https://evil.example' }), expected)).toBeNull();
    expect(verifyWebAuthnRegistration(await authenticator.register({ ...expected, rpId: 'evil.example' }), expected)).toBeNull();
    expect(verifyWebAuthnRegistration(await authenticator.register({ ...expected, userVerified: false }), expected)).toBeNull();
    expect(verifyWebAuthnRegistration(await authenticator.register({ ...expected, type: 'webauthn.get' }), expected)).toBeNull();
  });
});

describe('WebAuthn assertions', () => {
  for (const algorithm of ALGORITHMS) {
    it(`verifies a ${algorithm} assertion and answers its counter`, async () => {
      const authenticator = await softwareAuthenticator(algorithm);
      const key = { ...(await registered(authenticator)), ...RP };
      expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP }), challenge)).toEqual({ signCount: 1 });
      expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP }), challenge)).toEqual({ signCount: 2 });
      // Another key of the same algorithm, and a signature over other bytes.
      expect(verifyWebAuthnAssertion(key, await (await softwareAuthenticator(algorithm)).assert({ challenge, ...RP }), challenge)).toBeNull();
      const valid = await authenticator.assert({ challenge, ...RP });
      const other = await authenticator.assert({ challenge: sha256(challenge), ...RP });
      expect(verifyWebAuthnAssertion(key, { ...valid, signature: other.signature }, challenge)).toBeNull();
    });
  }

  it('refuses a wrong challenge, origin or relying party, a cross-origin frame, an unverified user, a registration type, tampering and another key', async () => {
    const authenticator = await softwareAuthenticator();
    const key = { ...(await registered(authenticator)), ...RP };
    const valid = await authenticator.assert({ challenge, ...RP });
    expect(verifyWebAuthnAssertion(key, valid, challenge)).not.toBeNull();
    expect(verifyWebAuthnAssertion(key, valid, sha256(challenge))).toBeNull();
    expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP, origin: 'https://evil.example' }), challenge)).toBeNull();
    expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP, rpId: 'evil.example' }), challenge)).toBeNull();
    expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP, crossOrigin: true }), challenge)).toBeNull();
    expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP, userVerified: false }), challenge)).toBeNull();
    expect(verifyWebAuthnAssertion(key, await authenticator.assert({ challenge, ...RP, type: 'webauthn.create' }), challenge)).toBeNull();
    expect(verifyWebAuthnAssertion({ ...key, origin: 'https://bob.gitspace.sh' }, valid, challenge)).toBeNull();
    expect(verifyWebAuthnAssertion({ ...key, rpId: 'bob.gitspace.sh' }, valid, challenge)).toBeNull();
    const counter = valid.authenticatorData.slice(0, -1) + (valid.authenticatorData.endsWith('A') ? 'B' : 'A');
    expect(verifyWebAuthnAssertion(key, { ...valid, authenticatorData: counter }, challenge)).toBeNull();
    const other = await softwareAuthenticator();
    expect(verifyWebAuthnAssertion(key, await other.assert({ challenge, ...RP }), challenge)).toBeNull();
  });
});

// ── Passkeys in the device trust chain ──

const BROWSER_ID = '22222222-2222-4222-8222-222222222222';
const NEW_DEVICE_ID = '33333333-3333-4333-8333-333333333333';

function rootBrowser(overrides: Partial<DeviceInvite> & { revokedAt?: number | null } = {}): DeviceGrantRecord {
  const { revokedAt = null, ...invite } = overrides;
  const signed = signDeviceInvite({
    version: 1, userId: 'user-a', inviteId: '11111111-1111-4111-8111-111111111111', kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true, issuedAt: NOW - 60_000, expiresAt: NOW, grantTtlMs: null, enrollUrl: RP.origin, ...invite,
  }, rootPrivate);
  const binding = createDeviceBinding({ inviteId: signed.invite.inviteId, deviceId: BROWSER_ID, signingPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(browserPrivate)), label: 'Laptop', boundAt: NOW - 50_000, signingPrivateKey: browserPrivate });
  return { invite: signed, binding, generation: 1, revokedAt };
}

async function enrolled(authenticator: SoftwareAuthenticator, overrides: Partial<PasskeyRegistration> = {}, signingKey = browserPrivate): Promise<SignedPasskeyRegistration> {
  const key = await registered(authenticator);
  const registration: PasskeyRegistration = {
    version: 1, userId: 'user-a', credentialId: key.credentialId, publicKey: key.publicKey, algorithm: key.algorithm, label: 'YubiKey',
    rpId: RP.rpId, origin: RP.origin, backupEligible: false, transports: ['usb', 'nfc'], createdAt: NOW - 40_000, ...overrides,
  };
  return { registration, signer: { kind: 'device', deviceId: BROWSER_ID }, signature: deviceProtocolBase64.encode(ed25519.sign(passkeyRegistrationPayload(registration), signingKey)) };
}

/** A new browser's grant, its invite signed by `signer` (by default the registered passkey) over the invite's hash. */
async function certified(registration: SignedPasskeyRegistration, signer: SoftwareAuthenticator, options: { invite?: Partial<DeviceInvite>; bindingKey?: Uint8Array; credentialId?: string } = {}): Promise<DeviceGrantRecord> {
  const invite: DeviceInvite = {
    version: 1, userId: 'user-a', inviteId: '44444444-4444-4444-8444-444444444444', kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true, issuedAt: NOW - 1_000, expiresAt: NOW + 60_000, grantTtlMs: null, enrollUrl: RP.origin,
    deviceSigningPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(newDevicePrivate)), ...options.invite,
  };
  const assertion = await signer.assert({ challenge: sha256(deviceInvitePayload(invite)), ...RP });
  const bindingKey = options.bindingKey ?? newDevicePrivate;
  const binding = createDeviceBinding({ inviteId: invite.inviteId, deviceId: NEW_DEVICE_ID, signingPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(bindingKey)), label: 'Phone', boundAt: NOW, signingPrivateKey: bindingKey });
  return {
    invite: { invite, signature: assertion.signature, issuer: { kind: 'passkey', credentialId: options.credentialId ?? registration.registration.credentialId, registration, authenticatorData: assertion.authenticatorData, clientDataJSON: assertion.clientDataJSON } },
    binding, generation: 1, revokedAt: null,
  };
}

describe('passkey-certified devices', () => {
  it('accepts a browser whose invite a registered passkey signed, offline, through the browser that enrolled the passkey', async () => {
    const authenticator = await softwareAuthenticator();
    const browser = rootBrowser();
    const record = await certified(await enrolled(authenticator), authenticator);
    expect(verifyDeviceGrantRecord(record, rootPublic, NOW, (id) => (id === BROWSER_ID ? browser : null))).toMatchObject({ deviceId: NEW_DEVICE_ID, kind: 'browser', canDelegate: true });
    // The enrolling browser is needed to trust the passkey at all.
    expect(verifyDeviceGrantRecord(record, rootPublic, NOW)).toBeNull();
  });

  it('keeps a passkey when its enrolling browser is revoked later, but not one enrolled after that revocation', async () => {
    const authenticator = await softwareAuthenticator();
    const record = await certified(await enrolled(authenticator), authenticator);
    const revokedLater = rootBrowser({ revokedAt: NOW - 10_000 });
    expect(verifyDeviceGrantRecord(record, rootPublic, NOW, () => revokedLater)?.deviceId).toBe(NEW_DEVICE_ID);
    const revokedBefore = rootBrowser({ revokedAt: NOW - 45_000 });
    expect(verifyDeviceGrantRecord(record, rootPublic, NOW, () => revokedBefore)).toBeNull();
  });

  it('refuses a registration not signed by a trusted full-access browser of the account', async () => {
    const authenticator = await softwareAuthenticator();
    const browser = rootBrowser();
    const forgedSignature = await certified(await enrolled(authenticator, {}, new Uint8Array(32).fill(13)), authenticator);
    expect(verifyDeviceGrantRecord(forgedSignature, rootPublic, NOW, () => browser)).toBeNull();
    const valid = await certified(await enrolled(authenticator), authenticator);
    for (const signer of [rootBrowser({ kind: 'client' }), rootBrowser({ scope: { kind: 'project', projectId: 'p' } }), rootBrowser({ capabilities: ['rpc.read', 'rpc.write'] }), rootBrowser({ canDelegate: false }), rootBrowser({ userId: 'user-b' })]) {
      expect(verifyDeviceGrantRecord(valid, rootPublic, NOW, () => signer)).toBeNull();
    }
    // A registration dated before its signer was enrolled.
    expect(verifyDeviceGrantRecord(await certified(await enrolled(authenticator, { createdAt: NOW - 55_000 }), authenticator), rootPublic, NOW, () => browser)).toBeNull();
  });

  it('refuses a forged or unregistered passkey, a key other than the one the invite names, and a changed invite', async () => {
    const authenticator = await softwareAuthenticator();
    const browser = rootBrowser();
    const resolve = () => browser;
    const registration = await enrolled(authenticator);
    // Another authenticator signs while presenting the registered passkey's registration.
    expect(verifyDeviceGrantRecord(await certified(registration, await softwareAuthenticator()), rootPublic, NOW, resolve)).toBeNull();
    // The issuer names a credential the registration is not for.
    expect(verifyDeviceGrantRecord(await certified(registration, authenticator, { credentialId: (await softwareAuthenticator()).credentialId }), rootPublic, NOW, resolve)).toBeNull();
    expect(verifyDeviceGrantRecord(await certified(registration, authenticator, { bindingKey: new Uint8Array(32).fill(12) }), rootPublic, NOW, resolve)).toBeNull();
    expect(verifyDeviceGrantRecord(await certified(registration, authenticator, { invite: { deviceSigningPublicKey: undefined } }), rootPublic, NOW, resolve)).toBeNull();
    expect(verifyDeviceGrantRecord(await certified(registration, authenticator, { invite: { issuedAt: NOW - 41_000 } }), rootPublic, NOW, resolve)).toBeNull();
    const widened = await certified(registration, authenticator, { invite: { capabilities: ['rpc.read'] } });
    widened.invite.invite.capabilities = [...BROWSER_GRANT_CAPABILITIES];
    expect(verifyDeviceGrantRecord(widened, rootPublic, NOW, resolve)).toBeNull();
  });

  it('holds root and device invites to the device key they name', () => {
    const named = rootBrowser({ deviceSigningPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(newDevicePrivate)) });
    expect(verifyDeviceGrantRecord(named, rootPublic, NOW)).toBeNull();
    expect(verifyDeviceGrantRecord(rootBrowser({ deviceSigningPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(browserPrivate)) }), rootPublic, NOW)?.deviceId).toBe(BROWSER_ID);
  });
});
