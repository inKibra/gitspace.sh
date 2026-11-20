import { ed25519 } from '@noble/curves/ed25519.js';
import { encodeStepUpProof, passkeyChallengePayload, passkeyRegistrationPayload, deviceProtocolBase64, STEP_UP_HEADER, type PasskeyRegistration, type StepUpAction } from '@gitspace/protocol/device-grant';
import { decodeBase64Url, encodeBase64Url, PASSKEY_ALGORITHMS, verifyWebAuthnRegistration, type WebAuthnAssertion } from '@gitspace/protocol/passkey';
import {
  passkeyChallengeViewSchema,
  passkeyListViewSchema,
  passkeySignInOptionsSchema,
  passkeyViewSchema,
  type PasskeyChallengeView,
  type PasskeyListView,
  type PasskeyOperation,
  type PasskeyView,
} from '@gitspace/protocol/passkey-access';
import { z } from 'zod';
import { bindDevice, createDeviceSignedFetch, DeviceEnrollmentError, generateDeviceKey, type BrowserDevice } from './device.js';
import { currentDevice, deviceRejected } from './device-session.js';
import { parseRecoveryKey } from './recovery-key.js';

/**
 * Passkeys on GitSpace browsers (docs/PASSKEYS-DESIGN.md): enroll and revoke them, sign a new browser in with one, and
 * the step-up every sensitive action asks for. WebAuthn ceremonies run only on the account's own origin, and Safari
 * runs them only inside a click: each flow fetches its challenge first, then exposes the ceremony as a function to call
 * straight from the click handler.
 */

export class PasskeyError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PasskeyError';
  }
}

/** This browser can run WebAuthn ceremonies. */
export function passkeysSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.PublicKeyCredential === 'function' && typeof navigator.credentials?.get === 'function';
}

async function answer<T extends z.ZodType>(response: Response, schema: T): Promise<z.infer<T>> {
  const body: unknown = await response.json().catch(() => null);
  const failure = z.object({ status: z.literal('error'), error: z.object({ code: z.string(), message: z.string() }) }).safeParse(body);
  if (failure.success) throw new PasskeyError(failure.data.error.code, failure.data.error.message);
  const ok = z.object({ status: z.literal('ok'), value: z.unknown() }).safeParse(body);
  const value = ok.success ? schema.safeParse(ok.data.value) : null;
  if (!value?.success) throw new PasskeyError('PASSKEY_FAILED', `GitSpace did not answer (HTTP ${response.status}).`);
  return value.data;
}

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

async function passkeyRoute<T extends z.ZodType>(operation: PasskeyOperation, body: object, schema: T, stepUp: string | null = null): Promise<z.infer<T>> {
  const device = await currentDevice();
  if (!device) throw new PasskeyError('NOT_ENROLLED', 'Reconnect this browser first.');
  const response = await signedFetch(new URL(`/v1/passkeys/${operation}`, window.location.origin), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(stepUp ? { [STEP_UP_HEADER]: stepUp } : {}) },
    body: JSON.stringify({ userId: device.userId, ...body }),
  });
  return answer(response, schema);
}

/** A WebAuthn ceremony the person cancelled, or one the browser refused (no gesture, wrong origin, timeout). */
function ceremonyError(cause: unknown): PasskeyError {
  if (cause instanceof DOMException && cause.name === 'NotAllowedError') return new PasskeyError('PASSKEY_CANCELLED', 'The passkey request was cancelled or timed out. Try again.');
  if (cause instanceof DOMException && cause.name === 'InvalidStateError') return new PasskeyError('PASSKEY_EXISTS', 'This authenticator already holds a passkey for this account.');
  if (cause instanceof DOMException && cause.name === 'SecurityError') return new PasskeyError('PASSKEY_ORIGIN', 'Passkeys work only on your account’s own address.');
  return new PasskeyError('PASSKEY_FAILED', cause instanceof Error ? cause.message : 'The passkey request failed.');
}

/** `navigator.credentials.get()` for a challenge, as the assertion the account verifies and the credential's id. */
async function getAssertion(options: { challenge: string; rpId: string; allowCredentials: ReadonlyArray<{ id: string; transports: string[] }>; timeoutMs: number }): Promise<{ credentialId: string; assertion: WebAuthnAssertion }> {
  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({ publicKey: {
      challenge: Uint8Array.from(decodeBase64Url(options.challenge)),
      rpId: options.rpId,
      userVerification: 'required',
      timeout: options.timeoutMs,
      allowCredentials: options.allowCredentials.map((descriptor) => ({ type: 'public-key', id: Uint8Array.from(decodeBase64Url(descriptor.id)), transports: descriptor.transports.filter(isTransport) })),
    } });
  } catch (cause) {
    throw ceremonyError(cause);
  }
  if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAssertionResponse)) throw new PasskeyError('PASSKEY_FAILED', 'The browser returned no passkey.');
  return {
    credentialId: encodeBase64Url(new Uint8Array(credential.rawId)),
    assertion: {
      authenticatorData: encodeBase64Url(new Uint8Array(credential.response.authenticatorData)),
      clientDataJSON: encodeBase64Url(new Uint8Array(credential.response.clientDataJSON)),
      signature: encodeBase64Url(new Uint8Array(credential.response.signature)),
    },
  };
}

const TRANSPORTS: Readonly<Record<string, true>> = { ble: true, hybrid: true, internal: true, nfc: true, usb: true, 'smart-card': true };
function isTransport(value: string): value is AuthenticatorTransport {
  return TRANSPORTS[value] === true;
}

export function listPasskeys(): Promise<PasskeyListView> {
  return passkeyRoute('list', {}, passkeyListViewSchema);
}

/**
 * A step-up challenge for one action. `required: false` when none is due (the account has no active passkey and the
 * action may bootstrap one); `passkeyAvailable: false` when the account has no active passkey, so only the recovery
 * key can answer. Each proof function answers the `x-gitspace-step-up` header value to send with the action, or null
 * when no step-up is due.
 */
export interface StepUp {
  action: StepUpAction;
  required: boolean;
  passkeyAvailable: boolean;
  expiresAt: number | null;
  /** Runs `navigator.credentials.get()`: call it straight from a click. */
  withPasskey(): Promise<string | null>;
  /** Signs the challenge with the account's recovery key (`gsr_…`) instead; the key stays in this page. */
  withRecoveryKey(recoveryKey: string): Promise<string | null>;
}

function stepUpFor(action: StepUpAction, view: PasskeyChallengeView): StepUp {
  if (!view.required) {
    return { action, required: false, passkeyAvailable: false, expiresAt: null, withPasskey: async () => null, withRecoveryKey: async () => null };
  }
  return {
    action,
    required: true,
    passkeyAvailable: view.allowCredentials.length > 0,
    expiresAt: view.expiresAt,
    async withPasskey() {
      const { credentialId, assertion } = await getAssertion({ challenge: view.challenge, rpId: view.rpId, allowCredentials: view.allowCredentials, timeoutMs: Math.max(1_000, view.expiresAt - Date.now()) });
      return encodeStepUpProof({ challengeId: view.challengeId, proof: { kind: 'passkey', credentialId, ...assertion } });
    },
    async withRecoveryKey(recoveryKey) {
      const root = await parseRecoveryKey(recoveryKey);
      try {
        if (root.userId !== view.payload.userId) throw new PasskeyError('ACCOUNT_MISMATCH', 'That recovery key belongs to another account.');
        return encodeStepUpProof({ challengeId: view.challengeId, proof: { kind: 'root', signature: deviceProtocolBase64.encode(ed25519.sign(passkeyChallengePayload(view.payload), root.privateKey)) } });
      } finally {
        root.privateKey.fill(0);
      }
    },
  };
}

/** The one web step-up helper: asks the account for a challenge naming `action` (purpose and target ids), valid two
 * minutes and spendable once by this browser. */
export async function requestStepUp(action: StepUpAction): Promise<StepUp> {
  return stepUpFor(action, await passkeyRoute('challenge', action, passkeyChallengeViewSchema));
}

/**
 * A passkey enrollment in progress. `stepUp` is the `passkey.enroll` step-up an existing passkey (or the recovery key)
 * must give first; null when this is the account's first passkey.
 */
export interface PasskeyEnrollment {
  stepUp: StepUp | null;
  expiresAt: number;
  /** Runs `navigator.credentials.create()` (call it straight from a click), signs the registration with this browser's
   * device key, and registers it with `stepUpProof`. */
  create(label: string, stepUpProof: string | null): Promise<PasskeyView>;
}

export async function preparePasskeyEnrollment(): Promise<PasskeyEnrollment> {
  const device = await currentDevice();
  if (!device) throw new PasskeyError('NOT_ENROLLED', 'Reconnect this browser first.');
  const view = await passkeyRoute('challenge', { purpose: 'passkey.register', targets: [] }, passkeyChallengeViewSchema);
  if (!view.required || !view.registration) throw new PasskeyError('PASSKEY_FAILED', 'GitSpace did not issue a registration challenge.');
  const { registration } = view;
  const stepUp = stepUpFor({ purpose: 'passkey.enroll', targets: [view.challengeId] }, await passkeyRoute('challenge', { purpose: 'passkey.enroll', targets: [view.challengeId] }, passkeyChallengeViewSchema));
  return {
    stepUp: stepUp.required ? stepUp : null,
    expiresAt: view.expiresAt,
    // `navigator.credentials.create()` is the first thing this does: Safari needs it inside the click.
    async create(label, stepUpProof) {
      const challenge = decodeBase64Url(view.challenge);
      let credential: Credential | null;
      try {
        credential = await navigator.credentials.create({ publicKey: {
          rp: { id: view.rpId, name: 'GitSpace' },
          user: { id: Uint8Array.from(decodeBase64Url(registration.user.id)), name: registration.user.name, displayName: registration.user.displayName },
          challenge: Uint8Array.from(challenge),
          pubKeyCredParams: PASSKEY_ALGORITHMS.map((alg) => ({ type: 'public-key', alg })),
          timeout: Math.max(1_000, view.expiresAt - Date.now()),
          attestation: 'none',
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
          excludeCredentials: registration.excludeCredentials.map((descriptor) => ({ type: 'public-key', id: Uint8Array.from(decodeBase64Url(descriptor.id)), transports: descriptor.transports.filter(isTransport) })),
        } });
      } catch (cause) {
        throw ceremonyError(cause);
      }
      if (!(credential instanceof PublicKeyCredential) || !(credential.response instanceof AuthenticatorAttestationResponse)) throw new PasskeyError('PASSKEY_FAILED', 'The browser created no passkey.');
      const attestation = { attestationObject: encodeBase64Url(new Uint8Array(credential.response.attestationObject)), clientDataJSON: encodeBase64Url(new Uint8Array(credential.response.clientDataJSON)) };
      const key = verifyWebAuthnRegistration(attestation, { challenge, rpId: view.rpId, origin: window.location.origin });
      if (!key) throw new PasskeyError('PASSKEY_FAILED', 'The authenticator’s answer did not verify.');
      const record: PasskeyRegistration = {
        version: 1, userId: device.userId, credentialId: key.credentialId, publicKey: key.publicKey, algorithm: key.algorithm, label: label.trim(),
        rpId: view.rpId, origin: window.location.origin, backupEligible: key.backupEligible, transports: credential.response.getTransports().slice(0, 8), createdAt: Date.now(),
      };
      const signature = deviceProtocolBase64.encode(new Uint8Array(await crypto.subtle.sign('Ed25519', device.keyPair.privateKey, Uint8Array.from(passkeyRegistrationPayload(record)))));
      return passkeyRoute('register', { challengeId: view.challengeId, registration: { registration: record, signer: { kind: 'device', deviceId: device.deviceId }, signature }, attestation }, passkeyViewSchema, stepUpProof);
    },
  };
}

/** Revokes a passkey with its `passkey.revoke` step-up proof. Devices it certified keep working until revoked themselves. */
export function revokePasskey(credentialId: string, stepUpProof: string | null): Promise<PasskeyView> {
  return passkeyRoute('revoke', { credentialId }, passkeyViewSchema, stepUpProof);
}

/** Passkey sign-in on a new browser, prepared: this browser's device key and the invite naming it. */
export interface PasskeySignIn {
  expiresAt: number;
  /** Runs `navigator.credentials.get()` (call it straight from a click), then enrolls this browser. */
  signIn(): Promise<BrowserDevice>;
}

/** Makes this browser's device key and asks the account (`accountOrigin`) for the invite a passkey will sign. */
export async function preparePasskeySignIn(accountOrigin: string): Promise<PasskeySignIn> {
  const key = await generateDeviceKey();
  const options = await answer(await fetch(new URL('/v1/passkeys/sign-in/options', accountOrigin), {
    method: 'POST', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceSigningPublicKey: key.publicKey }),
  }), passkeySignInOptionsSchema);
  return {
    expiresAt: options.invite.expiresAt,
    async signIn() {
      const { credentialId, assertion } = await getAssertion({ challenge: options.challenge, rpId: options.rpId, allowCredentials: [], timeoutMs: options.timeoutMs });
      try {
        return await bindDevice(key, options.invite, (binding) => fetch(new URL('/v1/passkeys/sign-in/complete', accountOrigin), {
          method: 'POST', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ invite: options.invite, ticket: options.ticket, credentialId, assertion, binding }),
        }));
      } catch (cause) {
        if (cause instanceof DeviceEnrollmentError) throw new PasskeyError(cause.code, cause.message);
        throw cause;
      }
    },
  };
}
