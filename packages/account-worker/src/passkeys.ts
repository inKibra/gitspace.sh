import { ed25519 } from '@noble/curves/ed25519.js';
import {
  BROWSER_GRANT_CAPABILITIES,
  credentialProtocolBase64,
  decodeBase64Url,
  decodeStepUpProof,
  deviceHasCapability,
  deviceInvitePayload,
  encodeBase64Url,
  parseAuthenticatorData,
  passkeyChallengePayload,
  passkeyChallengeSchema,
  signedPasskeyRegistrationSchema,
  STEP_UP_TTL_MS,
  verifyPasskeyRegistration,
  verifyWebAuthnAssertion,
  verifyWebAuthnRegistration,
  type DeviceBinding,
  type DeviceCapability,
  type DeviceGrantRecord,
  type DeviceInvite,
  type PasskeyChallenge,
  type SignedDeviceInvite,
  type SignedPasskeyRegistration,
  type StepUpAction,
  type VerifiedDevice,
} from '@gitspace/protocol';
import {
  passkeyChallengeRequestSchema,
  passkeyListRequestSchema,
  passkeyRegisterRequestSchema,
  passkeyRevokeRequestSchema,
  type PasskeyChallengeView,
  type PasskeyListView,
  type PasskeyOperation,
  type PasskeySignInOptions,
  type PasskeyView,
} from '@gitspace/protocol/passkey-access';
import { z } from 'zod';
import type { passkeySignInOptionsRequestSchema, passkeySignInRequestSchema } from '@gitspace/protocol/passkey-access';
import type { CredentialVaultResult } from './application.js';

/**
 * Passkeys in the credential vault (docs/PASSKEYS-DESIGN.md): the registered passkeys, the one-time ceremony
 * challenges, the step-up check every sensitive action runs (`consumeStepUp`), and passkey sign-in, which enrolls a new
 * browser on an invite the passkey signs. The vault signs nothing here: a passkey's registration is signed by the
 * browser that enrolled it, and a passkey-certified browser's invite by the passkey.
 */
export const PASSKEY_TABLES = `
  CREATE TABLE IF NOT EXISTS passkeys (
    credential_id TEXT PRIMARY KEY, registration_json TEXT NOT NULL, sign_count INTEGER NOT NULL,
    last_used_at INTEGER, revoked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS passkey_challenges (
    challenge_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, payload_json TEXT NOT NULL, challenge TEXT NOT NULL,
    expires_at INTEGER NOT NULL, used_at INTEGER
  );
`;

/** Purposes an account with no active passkey may perform without a step-up: enrolling its first passkey, and the
 * browser invitation links accounts used before passkeys existed. */
const BOOTSTRAP_PURPOSES: Readonly<Record<string, true>> = { 'passkey.enroll': true, 'browser-invitation.create': true };
const OPEN_CHALLENGES_PER_DEVICE = 16;
const REGISTRATION_CLOCK_SKEW_MS = 60_000;
const SIGN_IN_KEY_INFO = 'gitspace/passkey-sign-in/v1';

/** How a step-up was satisfied; `bootstrap` when none was due. */
export type StepUpGrant = { method: 'passkey'; credentialId: string } | { method: 'root' | 'bootstrap'; credentialId: null };

interface PasskeyRow extends Record<string, SqlStorageValue> {
  credential_id: string;
  registration_json: string;
  sign_count: number;
  last_used_at: number | null;
  revoked_at: number | null;
}
interface ChallengeRow extends Record<string, SqlStorageValue> {
  challenge_id: string;
  device_id: string;
  payload_json: string;
  challenge: string;
  expires_at: number;
  used_at: number | null;
}

/** What the vault lends this module. */
export interface PasskeyVaultHost {
  storage: DurableObjectStorage;
  accountUrl: string;
  config(): { user_id: string; root_public_key: string; vault_key: string } | undefined;
  deviceGrant(deviceId: string): DeviceGrantRecord | null;
  currentDevice(deviceId: string): VerifiedDevice | null;
  /** A request signed by a current, account-wide browser holding `capabilities`. */
  authorizeBrowser(input: { header: string | null; target: string; body: Uint8Array; capabilities: DeviceCapability[] }): CredentialVaultResult<{ deviceId: string }>;
  /** Records a verified device grant (`CredentialVaultDO.admitDevice`). */
  admitDevice(input: { invite: SignedDeviceInvite; binding: DeviceBinding }): CredentialVaultResult<{ deviceId: string; expiresAt: number | null }>;
}

function refuse(code: string, message: string): CredentialVaultResult<never> {
  return { status: 'error', error: { code, message } };
}

/** A signature counter that is kept must move forward; an authenticator that keeps none answers 0 every time. A
 * counter that went backwards marks a cloned authenticator. */
function counterAdvances(row: PasskeyRow, signCount: number): boolean {
  return (signCount === 0 && row.sign_count === 0) || signCount > row.sign_count;
}

export class PasskeyVault {
  constructor(private readonly host: PasskeyVaultHost) {}

  /** The relying party passkeys are bound to: the account host, and the origin its pages run on. */
  private relyingParty(): { rpId: string; origin: string } {
    const url = new URL(this.host.accountUrl);
    return { rpId: url.hostname, origin: url.origin };
  }

  private passkey(credentialId: string): PasskeyRow | null {
    return this.host.storage.sql.exec<PasskeyRow>('SELECT * FROM passkeys WHERE credential_id = ?', credentialId).toArray()[0] ?? null;
  }

  private registration(row: PasskeyRow): SignedPasskeyRegistration {
    return signedPasskeyRegistrationSchema.parse(JSON.parse(row.registration_json));
  }

  private view(row: PasskeyRow): PasskeyView {
    const { registration, signer } = this.registration(row);
    return {
      credentialId: row.credential_id, label: registration.label, algorithm: registration.algorithm, backupEligible: registration.backupEligible,
      transports: registration.transports, createdAt: registration.createdAt, enrolledBy: signer.deviceId, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at,
    };
  }

  /** `POST /v1/passkeys/<operation>` from a signed-in, account-wide browser. */
  async request(input: { operation: PasskeyOperation; header: string | null; stepUp: string | null; target: string; body: Uint8Array; accountName: string }): Promise<CredentialVaultResult<PasskeyListView | PasskeyChallengeView | PasskeyView>> {
    const config = this.host.config();
    if (!config) return refuse('VAULT_UNCONFIGURED', 'Vault is not configured');
    const raw: unknown = JSON.parse(new TextDecoder().decode(input.body));
    // Any account-wide browser may ask for a step-up; the action it confirms checks its own authority.
    const authorized = this.host.authorizeBrowser({ header: input.header, target: input.target, body: input.body, capabilities: input.operation === 'list' || input.operation === 'challenge' ? ['rpc.read'] : ['devices.manage'] });
    if (authorized.status === 'error') return authorized;
    const { deviceId } = authorized.value;
    const account = z.looseObject({ userId: z.string() }).safeParse(raw);
    if (!account.success || account.data.userId !== config.user_id) return refuse('INVALID_PASSKEY_REQUEST', 'Passkey request belongs to another account');
    if (input.operation === 'list') {
      passkeyListRequestSchema.parse(raw);
      const rows = this.host.storage.sql.exec<PasskeyRow>('SELECT * FROM passkeys ORDER BY rowid').toArray();
      return { status: 'ok', value: { passkeys: rows.map((row) => this.view(row)), rpId: this.relyingParty().rpId } };
    }
    if (input.operation === 'challenge') return this.challenge(config.user_id, deviceId, passkeyChallengeRequestSchema.parse(raw), input.accountName);
    if (input.operation === 'register') return this.register(config, deviceId, passkeyRegisterRequestSchema.parse(raw), input.stepUp);
    const { credentialId } = passkeyRevokeRequestSchema.parse(raw);
    const row = this.passkey(credentialId);
    if (!row) return refuse('PASSKEY_NOT_FOUND', 'No such passkey is enrolled on this account');
    if (row.revoked_at !== null) return { status: 'ok', value: this.view(row) };
    return this.host.storage.transactionSync((): CredentialVaultResult<PasskeyView> => {
      const stepped = this.consumeStepUp({ deviceId, action: { purpose: 'passkey.revoke', targets: [credentialId] }, proof: input.stepUp });
      if (stepped.status === 'error') return stepped;
      this.host.storage.sql.exec('UPDATE passkeys SET revoked_at = ? WHERE credential_id = ?', Date.now(), credentialId);
      return { status: 'ok', value: this.view(this.passkey(credentialId)!) };
    });
  }

  /**
   * A ceremony challenge for `deviceId`: `passkey.register` for a new passkey's `create()`, any other purpose for a
   * step-up. `required: false` when the account has no active passkey and the purpose may bootstrap one.
   */
  private async challenge(userId: string, deviceId: string, request: { purpose: PasskeyChallenge['purpose']; targets: string[] }, accountName: string): Promise<CredentialVaultResult<PasskeyChallengeView>> {
    const register = request.purpose === 'passkey.register';
    const device = this.host.currentDevice(deviceId);
    if (register && (request.targets.length > 0 || !device?.canDelegate || !deviceHasCapability(device, 'devices.manage'))) {
      return refuse('RPC_FORBIDDEN', 'Only a browser with full account access may enroll a passkey');
    }
    const rows = this.host.storage.sql.exec<PasskeyRow>('SELECT * FROM passkeys ORDER BY rowid').toArray();
    const active = rows.filter((row) => row.revoked_at === null);
    if (!register && active.length === 0 && BOOTSTRAP_PURPOSES[request.purpose]) return { status: 'ok', value: { required: false } };
    const now = Date.now();
    const payload: PasskeyChallenge = {
      version: 1, userId, challengeId: crypto.randomUUID(), deviceId, purpose: request.purpose, targets: request.targets,
      issuedAt: now, expiresAt: now + STEP_UP_TTL_MS, nonce: encodeBase64Url(crypto.getRandomValues(new Uint8Array(32))),
    };
    const challenge = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(passkeyChallengePayload(payload)))));
    // The limit check and the insert run with no await between them.
    const { sql } = this.host.storage;
    sql.exec('DELETE FROM passkey_challenges WHERE expires_at <= ?', now - STEP_UP_TTL_MS);
    const open = sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM passkey_challenges WHERE device_id = ? AND used_at IS NULL AND expires_at > ?', deviceId, now).one().count;
    if (open >= OPEN_CHALLENGES_PER_DEVICE) return refuse('PASSKEY_CHALLENGE_LIMIT', 'Too many confirmations are waiting; finish or let them expire');
    sql.exec('INSERT INTO passkey_challenges(challenge_id, device_id, payload_json, challenge, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)', payload.challengeId, deviceId, JSON.stringify(payload), challenge, payload.expiresAt);
    const descriptor = (row: PasskeyRow) => ({ id: row.credential_id, transports: this.registration(row).registration.transports });
    return {
      status: 'ok',
      value: {
        required: true, challengeId: payload.challengeId, payload, challenge, rpId: this.relyingParty().rpId, expiresAt: payload.expiresAt,
        allowCredentials: register ? [] : active.map(descriptor),
        registration: register ? { user: { id: encodeBase64Url(new TextEncoder().encode(userId)), name: accountName, displayName: `GitSpace (${accountName})` }, excludeCredentials: rows.map(descriptor) } : null,
      },
    };
  }

  /**
   * Registers a passkey: the authenticator's answer to this browser's `passkey.register` challenge, the registration
   * this browser signed over it, and (once the account has an active passkey) a `passkey.enroll` step-up naming the
   * challenge.
   */
  private register(config: { user_id: string; root_public_key: string }, deviceId: string, request: z.infer<typeof passkeyRegisterRequestSchema>, stepUp: string | null): CredentialVaultResult<PasskeyView> {
    const now = Date.now();
    if (!this.host.currentDevice(deviceId)?.canDelegate) return refuse('RPC_FORBIDDEN', 'Only a browser with full account access may enroll a passkey');
    const row = this.host.storage.sql.exec<ChallengeRow>('SELECT * FROM passkey_challenges WHERE challenge_id = ?', request.challengeId).toArray()[0];
    const payload = row ? passkeyChallengeSchema.safeParse(JSON.parse(row.payload_json)) : null;
    if (!row || !payload?.success || payload.data.purpose !== 'passkey.register' || row.device_id !== deviceId) return refuse('INVALID_PASSKEY', 'The registration challenge is not this browser’s');
    if (row.used_at !== null) return refuse('PASSKEY_CHALLENGE_USED', 'This registration was already completed; start again');
    if (row.expires_at <= now) return refuse('PASSKEY_CHALLENGE_EXPIRED', 'This registration expired; start again');
    const { registration, signer } = request.registration;
    const relyingParty = this.relyingParty();
    const key = verifyWebAuthnRegistration(request.attestation, { challenge: decodeBase64Url(row.challenge), ...relyingParty });
    if (!key || key.credentialId !== registration.credentialId || key.publicKey !== registration.publicKey || key.algorithm !== registration.algorithm || key.backupEligible !== registration.backupEligible) {
      return refuse('INVALID_PASSKEY', 'The registration does not match what the authenticator created');
    }
    if (registration.userId !== config.user_id || registration.rpId !== relyingParty.rpId || registration.origin !== relyingParty.origin
      || signer.deviceId !== deviceId || Math.abs(registration.createdAt - now) > REGISTRATION_CLOCK_SKEW_MS) {
      return refuse('INVALID_PASSKEY', 'The registration is not for this account, host and browser');
    }
    if (!verifyPasskeyRegistration(request.registration, credentialProtocolBase64.decode(config.root_public_key), (id) => this.host.deviceGrant(id))) {
      return refuse('INVALID_PASSKEY', 'The registration is not signed by a browser with full account access');
    }
    if (this.passkey(registration.credentialId)) return refuse('PASSKEY_EXISTS', 'This passkey is already registered');
    return this.host.storage.transactionSync((): CredentialVaultResult<PasskeyView> => {
      const stepped = this.consumeStepUp({ deviceId, action: { purpose: 'passkey.enroll', targets: [request.challengeId] }, proof: stepUp });
      if (stepped.status === 'error') return stepped;
      this.host.storage.sql.exec('UPDATE passkey_challenges SET used_at = ? WHERE challenge_id = ?', now, request.challengeId);
      this.host.storage.sql.exec('INSERT INTO passkeys(credential_id, registration_json, sign_count, last_used_at, revoked_at) VALUES (?, ?, ?, NULL, NULL)',
        registration.credentialId, JSON.stringify(request.registration), key.signCount);
      return { status: 'ok', value: this.view(this.passkey(registration.credentialId)!) };
    });
  }

  /**
   * The step-up check (docs/PASSKEYS-DESIGN.md). `proof` is the `x-gitspace-step-up` header: an assertion by an active
   * passkey of this account, or a recovery-key signature, over a challenge this vault issued to `deviceId` for exactly
   * `action`, unexpired and unused. Spends the challenge. Synchronous, so callers spend it in the same transaction as
   * the action it authorizes. With no active passkey, the bootstrap purposes pass without a proof.
   */
  consumeStepUp(input: { deviceId: string; action: StepUpAction; proof: string | null }): CredentialVaultResult<StepUpGrant> {
    const config = this.host.config();
    if (!config) return refuse('VAULT_UNCONFIGURED', 'Vault is not configured');
    const now = Date.now();
    const anyActive = this.host.storage.sql.exec('SELECT 1 FROM passkeys WHERE revoked_at IS NULL LIMIT 1').toArray().length > 0;
    if (!anyActive && BOOTSTRAP_PURPOSES[input.action.purpose]) return { status: 'ok', value: { method: 'bootstrap', credentialId: null } };
    const decoded = input.proof ? decodeStepUpProof(input.proof) : null;
    if (!decoded) {
      return anyActive ? refuse('STEP_UP_REQUIRED', 'Confirm this with your passkey') : refuse('STEP_UP_ENROLL_REQUIRED', 'Enroll a passkey on this account, or use your recovery key, to confirm this');
    }
    const row = this.host.storage.sql.exec<ChallengeRow>('SELECT * FROM passkey_challenges WHERE challenge_id = ?', decoded.challengeId).toArray()[0];
    const payload = row ? passkeyChallengeSchema.safeParse(JSON.parse(row.payload_json)) : null;
    if (!row || !payload?.success || payload.data.userId !== config.user_id || row.device_id !== input.deviceId
      || payload.data.purpose !== input.action.purpose || JSON.stringify(payload.data.targets) !== JSON.stringify(input.action.targets)) {
      return refuse('STEP_UP_INVALID', 'This confirmation was issued for another action or browser');
    }
    if (row.used_at !== null) return refuse('STEP_UP_USED', 'This confirmation was already used; confirm again');
    if (row.expires_at <= now) return refuse('STEP_UP_EXPIRED', 'This confirmation expired; confirm again');
    const { proof } = decoded;
    let grant: StepUpGrant = { method: 'root', credentialId: null };
    if (proof.kind === 'root') {
      let signed = false;
      try {
        signed = ed25519.verify(credentialProtocolBase64.decode(proof.signature), passkeyChallengePayload(payload.data), credentialProtocolBase64.decode(config.root_public_key));
      } catch {
        signed = false;
      }
      if (!signed) return refuse('STEP_UP_INVALID', 'The recovery key did not sign this confirmation');
    } else {
      const passkey = this.passkey(proof.credentialId);
      if (!passkey || passkey.revoked_at !== null) return refuse('STEP_UP_INVALID', 'That passkey is not enrolled on this account, or was revoked');
      const verified = verifyWebAuthnAssertion(this.registration(passkey).registration, proof, decodeBase64Url(row.challenge));
      if (!verified || !counterAdvances(passkey, verified.signCount)) return refuse('STEP_UP_INVALID', 'The passkey signature did not verify');
      this.host.storage.sql.exec('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?', verified.signCount, now, proof.credentialId);
      grant = { method: 'passkey', credentialId: proof.credentialId };
    }
    if (this.host.storage.sql.exec('UPDATE passkey_challenges SET used_at = ? WHERE challenge_id = ? AND used_at IS NULL', now, row.challenge_id).rowsWritten !== 1) {
      return refuse('STEP_UP_USED', 'This confirmation was already used; confirm again');
    }
    return { status: 'ok', value: grant };
  }

  /** The key MACing sign-in invites, derived from the vault key for this use only. */
  private async signInKey(vaultKey: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', Uint8Array.from(credentialProtocolBase64.decode(vaultKey)), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode(SIGN_IN_KEY_INFO) }, base, { name: 'HMAC', hash: 'SHA-256', length: 256 }, false, ['sign', 'verify']);
  }

  /**
   * Passkey sign-in, first step: an invite naming the new browser's device key, valid two minutes, the challenge a
   * passkey signs (the invite's SHA-256) and a MAC proving this vault issued it. Nothing is stored.
   */
  async signInOptions(request: z.infer<typeof passkeySignInOptionsRequestSchema>): Promise<CredentialVaultResult<PasskeySignInOptions>> {
    const config = this.host.config();
    if (!config) return refuse('VAULT_UNCONFIGURED', 'Vault is not configured');
    if (credentialProtocolBase64.decode(request.deviceSigningPublicKey).byteLength !== 32) return refuse('INVALID_PASSKEY_SIGN_IN', 'Device key is invalid');
    const now = Date.now();
    const invite: DeviceInvite = {
      version: 1, userId: config.user_id, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
      capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true, issuedAt: now, expiresAt: now + STEP_UP_TTL_MS, grantTtlMs: null,
      enrollUrl: new URL('/v1/devices/enroll', this.host.accountUrl).href, deviceSigningPublicKey: request.deviceSigningPublicKey,
    };
    const bytes = Uint8Array.from(deviceInvitePayload(invite));
    const ticket = encodeBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', await this.signInKey(config.vault_key), bytes)));
    const challenge = encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    return { status: 'ok', value: { invite, ticket, challenge, rpId: this.relyingParty().rpId, timeoutMs: STEP_UP_TTL_MS } };
  }

  /**
   * Passkey sign-in, second step: the invite this vault issued, signed by an active passkey of the account, and the new
   * browser's binding. The grant records the passkey's registration and assertion, so every verifier checks the passkey
   * signature itself. The invite id is single use (first bind wins).
   */
  async signIn(request: z.infer<typeof passkeySignInRequestSchema>): Promise<CredentialVaultResult<{ deviceId: string; expiresAt: number | null }>> {
    const config = this.host.config();
    if (!config) return refuse('VAULT_UNCONFIGURED', 'Vault is not configured');
    const issued = await crypto.subtle.verify('HMAC', await this.signInKey(config.vault_key), Uint8Array.from(decodeBase64Url(request.ticket)), Uint8Array.from(deviceInvitePayload(request.invite)));
    if (!issued) return refuse('INVALID_PASSKEY_SIGN_IN', 'This sign-in was not issued by this account; start again');
    if (request.invite.expiresAt <= Date.now()) return refuse('PASSKEY_SIGN_IN_EXPIRED', 'This sign-in expired; start again');
    const passkey = this.passkey(request.credentialId);
    if (!passkey || passkey.revoked_at !== null) return refuse('PASSKEY_UNKNOWN', 'This passkey is not enrolled on this account, or was revoked');
    const data = parseAuthenticatorData(decodeBase64Url(request.assertion.authenticatorData));
    if (!data || !counterAdvances(passkey, data.signCount)) return refuse('INVALID_PASSKEY_SIGN_IN', 'The passkey signature did not verify');
    const admitted = this.host.admitDevice({
      invite: { invite: request.invite, signature: request.assertion.signature, issuer: { kind: 'passkey', credentialId: request.credentialId, registration: this.registration(passkey), authenticatorData: request.assertion.authenticatorData, clientDataJSON: request.assertion.clientDataJSON } },
      binding: request.binding,
    });
    if (admitted.status === 'error') return admitted;
    this.host.storage.sql.exec('UPDATE passkeys SET sign_count = ?, last_used_at = ? WHERE credential_id = ?', data.signCount, Date.now(), request.credentialId);
    return admitted;
  }
}
