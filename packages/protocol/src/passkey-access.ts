import { z } from 'zod';
import {
  deviceBindingSchema,
  deviceInviteSchema,
  passkeyCeremonyPurposeSchema,
  passkeyChallengeSchema,
  signedPasskeyRegistrationSchema,
  stepUpActionSchema,
} from './device-grant.js';
import { base64UrlSchema, passkeyAlgorithmSchema, webAuthnAssertionSchema, webAuthnAttestationSchema } from './passkey.js';

/**
 * The account's passkey routes (docs/PASSKEYS-DESIGN.md). `POST /v1/passkeys/{list,challenge,register,revoke}` are
 * signed by a signed-in, account-wide browser (`x-gitspace-device`); `register` and `revoke` carry a step-up
 * (`x-gitspace-step-up`). `POST /v1/passkeys/sign-in/{options,complete}` take no credential: a new browser signs in
 * with a passkey there.
 */
export type PasskeyOperation = 'list' | 'challenge' | 'register' | 'revoke';

const userIdSchema = z.string().regex(/^u-[a-f0-9]{32}$/u);
const credentialIdSchema = base64UrlSchema.min(16).max(1_366);

export const passkeyListRequestSchema = z.strictObject({ userId: userIdSchema });
/** A ceremony challenge: `passkey.register` for a new passkey's `create()`, any other purpose for a step-up. */
export const passkeyChallengeRequestSchema = z.strictObject({ userId: userIdSchema, purpose: passkeyCeremonyPurposeSchema, targets: stepUpActionSchema.shape.targets });
export const passkeyRegisterRequestSchema = z.strictObject({
  userId: userIdSchema,
  /** The `passkey.register` challenge the authenticator answered. */
  challengeId: z.uuid(),
  registration: signedPasskeyRegistrationSchema,
  attestation: webAuthnAttestationSchema,
});
export const passkeyRevokeRequestSchema = z.strictObject({ userId: userIdSchema, credentialId: credentialIdSchema });
/** A new browser does not know the account id; the account host it signs in on names the account. */
export const passkeySignInOptionsRequestSchema = z.strictObject({ deviceSigningPublicKey: z.string().min(40).max(64) });
export const passkeySignInRequestSchema = z.strictObject({
  /** The invite and ticket from `options`, unchanged. */
  invite: deviceInviteSchema,
  ticket: base64UrlSchema.length(43),
  credentialId: credentialIdSchema,
  assertion: webAuthnAssertionSchema,
  binding: deviceBindingSchema,
});

export const passkeyViewSchema = z.object({
  credentialId: credentialIdSchema,
  label: z.string(),
  algorithm: passkeyAlgorithmSchema,
  backupEligible: z.boolean(),
  transports: z.array(z.string()),
  createdAt: z.number(),
  /** The browser that enrolled it. */
  enrolledBy: z.uuid(),
  lastUsedAt: z.number().nullable(),
  revokedAt: z.number().nullable(),
});
export type PasskeyView = z.infer<typeof passkeyViewSchema>;

export const passkeyListViewSchema = z.object({ passkeys: z.array(passkeyViewSchema), rpId: z.string() });
export type PasskeyListView = z.infer<typeof passkeyListViewSchema>;

const credentialDescriptorSchema = z.object({ id: credentialIdSchema, transports: z.array(z.string()) });

/** `required: false`: no step-up is due (the account has no active passkey and the action may bootstrap one). */
export const passkeyChallengeViewSchema = z.discriminatedUnion('required', [
  z.object({ required: z.literal(false) }),
  z.object({
    required: z.literal(true),
    challengeId: z.uuid(),
    /** What the challenge commits to; the recovery key signs its canonical JSON. */
    payload: passkeyChallengeSchema,
    /** The WebAuthn challenge, base64url: SHA-256 of the payload's canonical JSON. */
    challenge: base64UrlSchema,
    rpId: z.string(),
    expiresAt: z.number(),
    /** Active passkeys a step-up may use; empty when the account has none (only the recovery key can answer). */
    allowCredentials: z.array(credentialDescriptorSchema),
    /** Registration only: the WebAuthn user and the credentials to exclude. */
    registration: z.object({ user: z.object({ id: base64UrlSchema, name: z.string(), displayName: z.string() }), excludeCredentials: z.array(credentialDescriptorSchema) }).nullable(),
  }),
]);
export type PasskeyChallengeView = z.infer<typeof passkeyChallengeViewSchema>;

export const passkeySignInOptionsSchema = z.object({
  invite: deviceInviteSchema,
  /** The vault's MAC over the invite: proof it issued this invite, so a passkey cannot sign one made elsewhere. */
  ticket: base64UrlSchema.length(43),
  /** SHA-256 of the invite's canonical JSON, base64url. */
  challenge: base64UrlSchema,
  rpId: z.string(),
  timeoutMs: z.number(),
});
export type PasskeySignInOptions = z.infer<typeof passkeySignInOptionsSchema>;

export const passkeySignInResultSchema = z.object({ deviceId: z.uuid(), expiresAt: z.number().nullable() });
export type PasskeySignInResult = z.infer<typeof passkeySignInResultSchema>;
