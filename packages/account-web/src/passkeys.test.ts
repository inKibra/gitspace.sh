import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  BROWSER_GRANT_CAPABILITIES, decodeStepUpProof, deviceInvitePayload, deviceProtocolBase64, passkeyChallengePayload, passkeyRegistrationPayload, STEP_UP_HEADER,
  type DeviceInvite, type PasskeyChallenge,
} from '@gitspace/protocol/device-grant';
import { decodeBase64Url, encodeBase64Url, verifyWebAuthnAssertion, verifyWebAuthnRegistration } from '@gitspace/protocol/passkey';
import { passkeyRegisterRequestSchema, passkeySignInRequestSchema, type PasskeyChallengeView } from '@gitspace/protocol/passkey-access';
import { softwareAuthenticator, type SoftwareAuthenticator } from '../../protocol/test/software-authenticator.js';
import type { BrowserDevice } from './device.js';
import { currentDevice } from './device-session.js';
import { preparePasskeyEnrollment, preparePasskeySignIn, requestStepUp } from './passkeys.js';

vi.mock('./device-session.js', () => ({ currentDevice: vi.fn(), deviceRejected: vi.fn() }));

const ORIGIN = 'https://alice.gitspace.sh';
const RP = { rpId: 'alice.gitspace.sh', origin: ORIGIN };
const rootKey = new Uint8Array(32).fill(7);
const recoveryKey = `gsr_${deviceProtocolBase64.encode(rootKey).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')}`;

/** What a browser hands back from WebAuthn, as `passkeys.ts` recognises it. */
class TestAssertionResponse {
  constructor(readonly authenticatorData: ArrayBuffer, readonly clientDataJSON: ArrayBuffer, readonly signature: ArrayBuffer) {}
}
class TestAttestationResponse {
  constructor(readonly attestationObject: ArrayBuffer, readonly clientDataJSON: ArrayBuffer) {}
  getTransports(): string[] { return ['usb', 'nfc']; }
}
class TestCredential {
  constructor(readonly rawId: ArrayBuffer, readonly response: TestAssertionResponse | TestAttestationResponse) {}
}
function buffer(base64Url: string): ArrayBuffer {
  return Uint8Array.from(decodeBase64Url(base64Url)).buffer;
}

/** The authenticator behind `navigator.credentials`, answering the challenge the test served. */
function credentials(authenticator: SoftwareAuthenticator, challenge: () => Uint8Array) {
  const get = vi.fn(async () => {
    const assertion = await authenticator.assert({ challenge: challenge(), ...RP });
    return new TestCredential(buffer(authenticator.credentialId), new TestAssertionResponse(buffer(assertion.authenticatorData), buffer(assertion.clientDataJSON), buffer(assertion.signature)));
  });
  const create = vi.fn(async () => {
    const attestation = await authenticator.register({ challenge: challenge(), ...RP });
    return new TestCredential(buffer(authenticator.credentialId), new TestAttestationResponse(buffer(attestation.attestationObject), buffer(attestation.clientDataJSON)));
  });
  vi.stubGlobal('navigator', { credentials: { get, create } });
  return { get, create };
}

async function device(userId: string): Promise<BrowserDevice> {
  const keyPair = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify']);
  const publicKey = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));
  return { deviceId: crypto.randomUUID(), label: 'Laptop', publicKey, keyPair, enrolledAt: Date.now(), userId, enrollUrl: ORIGIN, canDelegate: true };
}

async function challengeView(payload: Omit<PasskeyChallenge, 'version' | 'challengeId' | 'issuedAt' | 'expiresAt' | 'nonce'>, registration: boolean): Promise<Extract<PasskeyChallengeView, { required: true }>> {
  const now = Date.now();
  const full: PasskeyChallenge = { version: 1, challengeId: crypto.randomUUID(), issuedAt: now, expiresAt: now + 120_000, nonce: encodeBase64Url(new Uint8Array(32)), ...payload };
  return {
    required: true, challengeId: full.challengeId, payload: full, challenge: encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(passkeyChallengePayload(full))))),
    rpId: RP.rpId, expiresAt: full.expiresAt, allowCredentials: registration ? [] : [{ id: 'credential-id-0000', transports: ['usb'] }],
    registration: registration ? { user: { id: encodeBase64Url(new TextEncoder().encode(payload.userId)), name: RP.rpId, displayName: 'GitSpace' }, excludeCredentials: [] } : null,
  };
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('window', { location: { origin: ORIGIN, href: `${ORIGIN}/` } });
  vi.stubGlobal('PublicKeyCredential', TestCredential);
  vi.stubGlobal('AuthenticatorAssertionResponse', TestAssertionResponse);
  vi.stubGlobal('AuthenticatorAttestationResponse', TestAttestationResponse);
});
afterEach(() => { vi.unstubAllGlobals(); vi.mocked(currentDevice).mockReset(); });

describe('step-up', () => {
  it('answers the challenge it was given with this browser\'s passkey, as the header the account checks', async () => {
    const laptop = await device('u-alice');
    vi.mocked(currentDevice).mockResolvedValue(laptop);
    const view = await challengeView({ userId: laptop.userId, deviceId: laptop.deviceId, purpose: 'secure-input.open', targets: ['request'] }, false);
    const requests: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => { requests.push(new Request(input, init)); return Response.json({ status: 'ok', value: view }); }));
    const authenticator = await softwareAuthenticator();
    const { get } = credentials(authenticator, () => decodeBase64Url(view.challenge));
    const stepUp = await requestStepUp({ purpose: 'secure-input.open', targets: ['request'] });
    expect(await requests[0]!.json()).toEqual({ userId: 'u-alice', purpose: 'secure-input.open', targets: ['request'] });
    expect(stepUp).toMatchObject({ required: true, passkeyAvailable: true, expiresAt: view.expiresAt });
    const proof = decodeStepUpProof((await stepUp.withPasskey())!);
    expect(get).toHaveBeenCalledWith({ publicKey: expect.objectContaining({ rpId: RP.rpId, userVerification: 'required' }) });
    if (proof?.proof.kind !== 'passkey') throw new Error('Expected a passkey proof');
    expect(proof).toMatchObject({ challengeId: view.challengeId, proof: { credentialId: authenticator.credentialId } });
    const key = verifyWebAuthnRegistration(await authenticator.register({ challenge: new Uint8Array(32), ...RP }), { challenge: new Uint8Array(32), ...RP })!;
    expect(verifyWebAuthnAssertion({ ...key, ...RP }, proof.proof, decodeBase64Url(view.challenge))).not.toBeNull();
  });

  it('signs with the recovery key only for its own account', async () => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(ed25519.getPublicKey(rootKey))));
    const userId = `u-${Array.from(digest.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const laptop = await device(userId);
    vi.mocked(currentDevice).mockResolvedValue(laptop);
    const mine = await challengeView({ userId, deviceId: laptop.deviceId, purpose: 'passkey.revoke', targets: ['credential'] }, false);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', value: mine })));
    const proof = decodeStepUpProof((await (await requestStepUp({ purpose: 'passkey.revoke', targets: ['credential'] })).withRecoveryKey(recoveryKey))!);
    if (proof?.proof.kind !== 'root') throw new Error('Expected a recovery-key proof');
    expect(ed25519.verify(deviceProtocolBase64.decode(proof.proof.signature), passkeyChallengePayload(mine.payload), ed25519.getPublicKey(rootKey))).toBe(true);
    const theirs = await challengeView({ userId: 'u-someone-else', deviceId: laptop.deviceId, purpose: 'passkey.revoke', targets: ['credential'] }, false);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'ok', value: theirs })));
    await expect((await requestStepUp({ purpose: 'passkey.revoke', targets: ['credential'] })).withRecoveryKey(recoveryKey)).rejects.toMatchObject({ code: 'ACCOUNT_MISMATCH' });
  });
});

describe('passkey enrollment', () => {
  it('registers what the authenticator created, signed by this browser\'s device key, with the step-up proof', async () => {
    const laptop = await device(`u-${'a'.repeat(32)}`);
    vi.mocked(currentDevice).mockResolvedValue(laptop);
    const register = await challengeView({ userId: laptop.userId, deviceId: laptop.deviceId, purpose: 'passkey.register', targets: [] }, true);
    const enroll = await challengeView({ userId: laptop.userId, deviceId: laptop.deviceId, purpose: 'passkey.enroll', targets: [register.challengeId] }, false);
    const registered: Request[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith('/register')) { registered.push(request); return Response.json({ status: 'error', error: { code: 'STOP', message: 'captured' } }); }
      const body: unknown = await request.json();
      return Response.json({ status: 'ok', value: JSON.stringify(body).includes('passkey.register') ? register : enroll });
    }));
    const authenticator = await softwareAuthenticator(-8);
    credentials(authenticator, () => decodeBase64Url(register.challenge));
    const enrollment = await preparePasskeyEnrollment();
    expect(enrollment.stepUp).toMatchObject({ action: { purpose: 'passkey.enroll', targets: [register.challengeId] } });
    await expect(enrollment.create(' YubiKey ', 'step-up-proof')).rejects.toMatchObject({ code: 'STOP' });
    expect(registered[0]!.headers.get(STEP_UP_HEADER)).toBe('step-up-proof');
    const body = passkeyRegisterRequestSchema.parse(await registered[0]!.json());
    expect(body).toMatchObject({ challengeId: register.challengeId, registration: { signer: { kind: 'device', deviceId: laptop.deviceId }, registration: { credentialId: authenticator.credentialId, label: 'YubiKey', rpId: RP.rpId, origin: ORIGIN, transports: ['usb', 'nfc'] } } });
    const signature = deviceProtocolBase64.decode(body.registration.signature);
    expect(await crypto.subtle.verify('Ed25519', laptop.keyPair.publicKey, Uint8Array.from(signature), Uint8Array.from(passkeyRegistrationPayload(body.registration.registration)))).toBe(true);
    expect(verifyWebAuthnRegistration(body.attestation, { challenge: decodeBase64Url(register.challenge), ...RP })).toMatchObject({ credentialId: authenticator.credentialId, publicKey: body.registration.registration.publicKey });
  });
});

describe('passkey sign-in', () => {
  it('makes this browser\'s key, has the passkey sign the invite naming it, and keeps the enrolled browser', async () => {
    const authenticator = await softwareAuthenticator();
    let invite: DeviceInvite | null = null;
    let challenge = new Uint8Array();
    const completed: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body: unknown = await request.json();
      if (request.url.endsWith('/v1/passkeys/sign-in/options')) {
        const named = typeof body === 'object' && body !== null && 'deviceSigningPublicKey' in body && typeof body.deviceSigningPublicKey === 'string' ? body.deviceSigningPublicKey : '';
        invite = { version: 1, userId: 'u-alice', inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true,
          issuedAt: Date.now(), expiresAt: Date.now() + 120_000, grantTtlMs: null, enrollUrl: `${ORIGIN}/v1/devices/enroll`, deviceSigningPublicKey: named };
        challenge = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(deviceInvitePayload(invite))));
        return Response.json({ status: 'ok', value: { invite, ticket: 'a'.repeat(43), challenge: encodeBase64Url(challenge), rpId: RP.rpId, timeoutMs: 120_000 } });
      }
      completed.push(body);
      return Response.json({ status: 'ok', value: { deviceId: crypto.randomUUID(), expiresAt: null } });
    }));
    const { get } = credentials(authenticator, () => challenge);
    const prepared = await preparePasskeySignIn(ORIGIN);
    const signedIn = await prepared.signIn();
    expect(get).toHaveBeenCalledWith({ publicKey: expect.objectContaining({ rpId: RP.rpId, userVerification: 'required', allowCredentials: [] }) });
    const sent = passkeySignInRequestSchema.parse(completed[0]);
    expect(sent.binding.signingPublicKey).toBe(sent.invite.deviceSigningPublicKey);
    expect(sent).toMatchObject({ ticket: 'a'.repeat(43), credentialId: authenticator.credentialId, invite: invite! });
    expect(signedIn).toMatchObject({ deviceId: sent.binding.deviceId, publicKey: sent.binding.signingPublicKey, userId: 'u-alice', canDelegate: true });
    const key = verifyWebAuthnRegistration(await authenticator.register({ challenge: new Uint8Array(32), ...RP }), { challenge: new Uint8Array(32), ...RP })!;
    expect(verifyWebAuthnAssertion({ ...key, ...RP }, sent.assertion, challenge)).not.toBeNull();
  });
});
