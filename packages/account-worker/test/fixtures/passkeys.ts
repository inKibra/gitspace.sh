import { expect } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  BROWSER_GRANT_CAPABILITIES, createDeviceBinding, credentialProtocolBase64, decodeBase64Url, encodeStepUpProof, passkeyRegistrationPayload, signDeviceInvite,
  signRpcRequest, STEP_UP_HEADER, verifyWebAuthnRegistration, type DeviceInvite, type PasskeyRegistration, type StepUpAction,
} from '@gitspace/protocol';
import { passkeyChallengeViewSchema, type PasskeyChallengeView } from '@gitspace/protocol/passkey-access';
import { z } from 'zod';
import type { CredentialVaultDO } from '../../src/index.js';
import type { CeremonyOptions, SoftwareAuthenticator } from '../../../protocol/test/software-authenticator.js';
import { tenantRootPrivateKey } from '../setup.js';

/** The account's relying party: passkeys are bound to its host and their ceremonies run on its origin. */
const ACCOUNT = new URL(env.ACCOUNT_URL);
export const RP = { rpId: ACCOUNT.hostname, origin: ACCOUNT.origin };
export const answerSchema = z.object({ status: z.string(), value: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string() }).optional() });

export interface TestBrowser { deviceId: string; key: Uint8Array }

export function vault(): DurableObjectStub<CredentialVaultDO> {
  return env.CREDENTIALS.getByName(env.ACCOUNT_ID);
}

/** An account-wide browser enrolled by the root key, with full browser rights unless `rights` narrows them; the first
 * call also bootstraps the vault. */
export async function browser(rights: Partial<Pick<DeviceInvite, 'canDelegate' | 'capabilities'>> = {}): Promise<TestBrowser> {
  await vault().bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(74)) });
  const key = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({
    version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: [...BROWSER_GRANT_CAPABILITIES],
    canDelegate: true, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: env.ACCOUNT_URL, ...rights,
  }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Laptop', boundAt: Date.now(), signingPrivateKey: key });
  expect(await vault().enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  return { deviceId: binding.deviceId, key };
}

/** `POST /v1/passkeys/<operation>` signed by `from`, with a step-up header when given. */
export async function passkeyPost(from: TestBrowser, operation: string, payload: object, stepUp: string | null = null) {
  const path = `/v1/passkeys/${operation}`;
  const body = new TextEncoder().encode(JSON.stringify({ userId: env.ACCOUNT_ID, ...payload }));
  const headers: Record<string, string> = {
    'content-type': 'application/json', 'x-gitspace-user': env.ACCOUNT_ID,
    'x-gitspace-device': signRpcRequest({ deviceId: from.deviceId, signingPrivateKey: from.key, method: 'POST', path, body }),
  };
  if (stepUp) headers[STEP_UP_HEADER] = stepUp;
  const response = await SELF.fetch(new URL(path, env.ACCOUNT_URL), { method: 'POST', headers, body });
  return { status: response.status, json: answerSchema.parse(await response.json()) };
}

export async function passkeyChallenge(from: TestBrowser, purpose: string, targets: string[]): Promise<PasskeyChallengeView> {
  const answered = await passkeyPost(from, 'challenge', { purpose, targets });
  expect(answered.status).toBe(200);
  return passkeyChallengeViewSchema.parse(answered.json.value);
}

/** Registers what `authenticator` creates, with the registration signed by `from` (or by `signingKey`, standing in for a
 * forger); `ceremony` bends what the authenticator answers. */
export async function enrollPasskey(from: TestBrowser, authenticator: SoftwareAuthenticator, options: { stepUp?: (challengeId: string) => Promise<string | null>; signingKey?: Uint8Array; ceremony?: Partial<CeremonyOptions>; label?: string } = {}) {
  const view = await passkeyChallenge(from, 'passkey.register', []);
  if (!view.required) throw new Error('A registration always takes a challenge');
  const ceremony = { challenge: decodeBase64Url(view.challenge), ...RP };
  const attestation = await authenticator.register({ ...ceremony, ...options.ceremony });
  // The key itself, read from an honest registration by the same authenticator.
  const key = verifyWebAuthnRegistration(await authenticator.register(ceremony), ceremony);
  if (!key) throw new Error('Software registration did not verify');
  const registration: PasskeyRegistration = {
    version: 1, userId: env.ACCOUNT_ID, credentialId: key.credentialId, publicKey: key.publicKey, algorithm: key.algorithm, label: options.label ?? 'YubiKey',
    rpId: RP.rpId, origin: RP.origin, backupEligible: key.backupEligible, transports: ['usb', 'nfc'], createdAt: Date.now(),
  };
  const signature = credentialProtocolBase64.encode(ed25519.sign(passkeyRegistrationPayload(registration), options.signingKey ?? from.key));
  const stepUp = options.stepUp ? await options.stepUp(view.challengeId) : null;
  return passkeyPost(from, 'register', { challengeId: view.challengeId, registration: { registration, signer: { kind: 'device', deviceId: from.deviceId }, signature }, attestation }, stepUp);
}

/** A step-up proof by `authenticator` for `action`, issued to `from`; `ceremony` bends what the authenticator signs. */
export async function passkeyProof(from: TestBrowser, authenticator: SoftwareAuthenticator, action: StepUpAction, ceremony: Partial<CeremonyOptions> = {}): Promise<string> {
  const view = await passkeyChallenge(from, action.purpose, action.targets);
  if (!view.required) throw new Error('No step-up was due');
  const assertion = await authenticator.assert({ challenge: decodeBase64Url(view.challenge), ...RP, ...ceremony });
  return encodeStepUpProof({ challengeId: view.challengeId, proof: { kind: 'passkey', credentialId: authenticator.credentialId, ...assertion } });
}
