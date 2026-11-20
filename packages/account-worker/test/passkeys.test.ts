import { describe, expect, it } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  BROWSER_GRANT_CAPABILITIES, createDeviceBinding, credentialProtocolBase64, decodeBase64Url, deviceInvitePayload, encodeBase64Url, encodeStepUpProof,
  passkeyChallengePayload, signDeviceInvite, signRpcRequest, STEP_UP_HEADER, verifyDeviceGrantRecord,
  type DeviceInvite, type SignedDeviceInvite, type StepUpAction,
} from '@gitspace/protocol';
import { passkeySignInOptionsSchema, type PasskeySignInOptions } from '@gitspace/protocol/passkey-access';
import { z } from 'zod';
import type { CredentialVaultDO } from '../src/index.js';
import { softwareAuthenticator, type CeremonyOptions, type SoftwareAuthenticator } from '../../protocol/test/software-authenticator.js';
import { answerSchema, browser, enrollPasskey as enroll, passkeyChallenge as challenge, passkeyPost as post, passkeyProof, RP, vault } from './fixtures/passkeys.js';
import { tenantRootPrivateKey as rootKey } from './setup.js';

describe('passkey enrollment', () => {
  it('enrolls the first passkey from a full-access browser, lists it, and needs a step-up from it for the next', async () => {
    const laptop = await browser();
    const yubikey = await softwareAuthenticator(-7);
    const first = await enroll(laptop, yubikey);
    expect(first).toMatchObject({ status: 200, json: { value: { credentialId: yubikey.credentialId, label: 'YubiKey', enrolledBy: laptop.deviceId, revokedAt: null } } });
    const phone = await softwareAuthenticator(-8);
    expect(await enroll(laptop, phone)).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_REQUIRED' } } });
    const second = await enroll(laptop, phone, { label: 'Phone', stepUp: (challengeId) => passkeyProof(laptop, yubikey, { purpose: 'passkey.enroll', targets: [challengeId] }) });
    expect(second).toMatchObject({ status: 200, json: { value: { credentialId: phone.credentialId, label: 'Phone' } } });
    const listed = await post(laptop, 'list', {});
    expect(listed.json.value).toMatchObject({ rpId: RP.rpId, passkeys: [{ credentialId: yubikey.credentialId }, { credentialId: phone.credentialId }] });
    // The step-up names the registration it was given for.
    const third = await softwareAuthenticator(-257);
    const misdirected = await enroll(laptop, third, { stepUp: async () => passkeyProof(laptop, yubikey, { purpose: 'passkey.enroll', targets: [crypto.randomUUID()] }) });
    expect(misdirected).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_INVALID' } } });
  });

  it('refuses a registration not signed by a trusted full-access browser, or not matching what the authenticator made', async () => {
    const laptop = await browser();
    expect(await enroll(laptop, await softwareAuthenticator(), { signingKey: crypto.getRandomValues(new Uint8Array(32)) })).toMatchObject({ status: 403, json: { error: { code: 'INVALID_PASSKEY' } } });
    expect(await enroll(laptop, await softwareAuthenticator(), { ceremony: { origin: 'https://evil.example' } })).toMatchObject({ status: 403, json: { error: { code: 'INVALID_PASSKEY' } } });
    expect(await enroll(laptop, await softwareAuthenticator(), { ceremony: { rpId: 'evil.example' } })).toMatchObject({ status: 403, json: { error: { code: 'INVALID_PASSKEY' } } });
    expect(await enroll(laptop, await softwareAuthenticator(), { ceremony: { userVerified: false } })).toMatchObject({ status: 403, json: { error: { code: 'INVALID_PASSKEY' } } });
    const limited = await browser({ canDelegate: false });
    expect(await post(limited, 'challenge', { purpose: 'passkey.register', targets: [] })).toMatchObject({ status: 403, json: { error: { code: 'RPC_FORBIDDEN' } } });
    expect((await post(laptop, 'list', {})).json.value).toMatchObject({ passkeys: [] });
  });
});

/** A step-up as `deviceId` presents it: the refusal's code, or how it was satisfied. */
async function consumeStepUp(deviceId: string, action: StepUpAction, proof: string | null) {
  const result = await vault().consumeStepUp({ deviceId, action, proof });
  return result.status === 'error' ? result.error.code : result.value;
}

describe('step-up', () => {
  it('is single use, bound to its action, browser and challenge, and refuses wrong origins, relying parties, expiry and revoked passkeys', async () => {
    const laptop = await browser();
    const other = await browser();
    const yubikey = await softwareAuthenticator();
    const open: StepUpAction = { purpose: 'secure-input.open', targets: ['a'] };
    expect(await consumeStepUp(laptop.deviceId, open, null)).toBe('STEP_UP_ENROLL_REQUIRED');
    expect((await enroll(laptop, yubikey)).status).toBe(200);
    expect(await consumeStepUp(laptop.deviceId, open, null)).toBe('STEP_UP_REQUIRED');
    const proof = await passkeyProof(laptop, yubikey, open);
    expect(await consumeStepUp(laptop.deviceId, { purpose: 'secure-input.open', targets: ['b'] }, proof)).toBe('STEP_UP_INVALID');
    expect(await consumeStepUp(laptop.deviceId, { purpose: 'secure-input.answer', targets: ['a'] }, proof)).toBe('STEP_UP_INVALID');
    expect(await consumeStepUp(other.deviceId, open, proof)).toBe('STEP_UP_INVALID');
    expect(await consumeStepUp(laptop.deviceId, open, proof)).toEqual({ method: 'passkey', credentialId: yubikey.credentialId });
    expect(await consumeStepUp(laptop.deviceId, open, proof)).toBe('STEP_UP_USED');
    // An assertion over another challenge, origin or relying party, or without user verification.
    const elsewhere = await challenge(laptop, open.purpose, open.targets);
    if (!elsewhere.required) throw new Error('Step-up expected');
    const signedOther = await yubikey.assert({ challenge: new Uint8Array(32), ...RP });
    expect(await consumeStepUp(laptop.deviceId, open, encodeStepUpProof({ challengeId: elsewhere.challengeId, proof: { kind: 'passkey', credentialId: yubikey.credentialId, ...signedOther } }))).toBe('STEP_UP_INVALID');
    for (const ceremony of [{ origin: 'https://evil.example' }, { rpId: 'evil.example' }, { userVerified: false }]) {
      expect(await consumeStepUp(laptop.deviceId, open, await passkeyProof(laptop, yubikey, open, ceremony))).toBe('STEP_UP_INVALID');
    }
    // A passkey of no account here.
    expect(await consumeStepUp(laptop.deviceId, open, await passkeyProof(laptop, await softwareAuthenticator(), open))).toBe('STEP_UP_INVALID');
    // Past its two minutes.
    const late = await passkeyProof(laptop, yubikey, open);
    await runInDurableObject(vault(), async (_instance: CredentialVaultDO, state) => { state.storage.sql.exec('UPDATE passkey_challenges SET expires_at = ? WHERE used_at IS NULL', Date.now() - 1); });
    expect(await consumeStepUp(laptop.deviceId, open, late)).toBe('STEP_UP_EXPIRED');
    // Revoked with its own step-up, it confirms nothing more.
    const revoke: StepUpAction = { purpose: 'passkey.revoke', targets: [yubikey.credentialId] };
    expect(await post(laptop, 'revoke', { credentialId: yubikey.credentialId })).toMatchObject({ status: 403, json: { error: { code: 'STEP_UP_REQUIRED' } } });
    expect(await post(laptop, 'revoke', { credentialId: yubikey.credentialId }, await passkeyProof(laptop, yubikey, revoke))).toMatchObject({ status: 200, json: { value: { credentialId: yubikey.credentialId, revokedAt: expect.any(Number) } } });
    const afterRevoke = await challenge(laptop, open.purpose, open.targets);
    if (!afterRevoke.required) throw new Error('Step-up expected');
    expect(afterRevoke.allowCredentials).toEqual([]);
    const assertion = await yubikey.assert({ challenge: decodeBase64Url(afterRevoke.challenge), ...RP });
    expect(await consumeStepUp(laptop.deviceId, open, encodeStepUpProof({ challengeId: afterRevoke.challengeId, proof: { kind: 'passkey', credentialId: yubikey.credentialId, ...assertion } }))).toBe('STEP_UP_INVALID');
  });

  it('takes the recovery key instead of a passkey, and only the account\'s own', async () => {
    const laptop = await browser();
    expect((await enroll(laptop, await softwareAuthenticator())).status).toBe(200);
    const action: StepUpAction = { purpose: 'secure-input.answer', targets: ['request'] };
    const rootProof = async (key: Uint8Array) => {
      const view = await challenge(laptop, action.purpose, action.targets);
      if (!view.required) throw new Error('Step-up expected');
      return encodeStepUpProof({ challengeId: view.challengeId, proof: { kind: 'root', signature: credentialProtocolBase64.encode(ed25519.sign(passkeyChallengePayload(view.payload), key)) } });
    };
    expect(await consumeStepUp(laptop.deviceId, action, await rootProof(crypto.getRandomValues(new Uint8Array(32))))).toBe('STEP_UP_INVALID');
    expect(await consumeStepUp(laptop.deviceId, action, await rootProof(rootKey))).toEqual({ method: 'root', credentialId: null });
  });

  it('asks for a step-up to register a browser invitation once the account has a passkey', async () => {
    const laptop = await browser();
    const invitation = (inviteId = crypto.randomUUID()) => signDeviceInvite({
      version: 1, userId: env.ACCOUNT_ID, inviteId, kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true,
      issuedAt: Date.now(), expiresAt: Date.now() + 300_000, grantTtlMs: null, enrollUrl: env.ACCOUNT_URL,
    }, laptop.key, { kind: 'device', deviceId: laptop.deviceId });
    const create = async (invite: SignedDeviceInvite, stepUp: string | null) => {
      const path = '/v1/devices/browser-invitations/create';
      const body = new TextEncoder().encode(JSON.stringify({ userId: env.ACCOUNT_ID, invite }));
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-gitspace-user': env.ACCOUNT_ID, 'x-gitspace-device': signRpcRequest({ deviceId: laptop.deviceId, signingPrivateKey: laptop.key, method: 'POST', path, body }) };
      if (stepUp) headers[STEP_UP_HEADER] = stepUp;
      return answerSchema.parse(await (await SELF.fetch(new URL(path, env.ACCOUNT_URL), { method: 'POST', headers, body })).json());
    };
    // No passkey yet: links work as before.
    expect(await create(invitation(), null)).toMatchObject({ status: 'ok' });
    const yubikey = await softwareAuthenticator();
    expect((await enroll(laptop, yubikey)).status).toBe(200);
    const invite = invitation();
    expect(await create(invite, null)).toMatchObject({ error: { code: 'STEP_UP_REQUIRED' } });
    expect(await create(invite, await passkeyProof(laptop, yubikey, { purpose: 'browser-invitation.create', targets: [crypto.randomUUID()] }))).toMatchObject({ error: { code: 'STEP_UP_INVALID' } });
    expect(await create(invite, await passkeyProof(laptop, yubikey, { purpose: 'browser-invitation.create', targets: [invite.invite.inviteId] }))).toMatchObject({ status: 'ok' });
  });
});

describe('passkey sign-in', () => {
  async function signInOptions(deviceKey: Uint8Array) {
    const response = await SELF.fetch(new URL('/v1/passkeys/sign-in/options', env.ACCOUNT_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceSigningPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(deviceKey)) }) });
    expect(response.status).toBe(200);
    return passkeySignInOptionsSchema.parse(answerSchema.parse(await response.json()).value);
  }
  async function complete(body: object) {
    const response = await SELF.fetch(new URL('/v1/passkeys/sign-in/complete', env.ACCOUNT_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, json: answerSchema.parse(await response.json()) };
  }
  /** What a new browser sends: an assertion by `signer` over the options' challenge, and its binding by `bindingKey`. */
  async function signIn(signer: SoftwareAuthenticator, options: PasskeySignInOptions, bindingKey: Uint8Array, overrides: { credentialId?: string; invite?: DeviceInvite; ceremony?: Partial<CeremonyOptions> } = {}) {
    const assertion = await signer.assert({ challenge: decodeBase64Url(options.challenge), ...RP, ...overrides.ceremony });
    const binding = createDeviceBinding({ inviteId: options.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(bindingKey)), label: 'Phone', boundAt: Date.now(), signingPrivateKey: bindingKey });
    return complete({ invite: overrides.invite ?? options.invite, ticket: options.ticket, credentialId: overrides.credentialId ?? signer.credentialId, assertion, binding });
  }

  it('certifies a new browser with a registered passkey, verifiable from the records alone, once', async () => {
    const laptop = await browser();
    const yubikey = await softwareAuthenticator();
    expect((await enroll(laptop, yubikey)).status).toBe(200);
    const phoneKey = crypto.getRandomValues(new Uint8Array(32));
    const options = await signInOptions(phoneKey);
    expect(options).toMatchObject({ rpId: RP.rpId, invite: { kind: 'browser', scope: { kind: 'user' }, canDelegate: true, deviceSigningPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(phoneKey)) } });
    expect(options.challenge).toBe(encodeBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(deviceInvitePayload(options.invite))))));
    // A synced passkey keeps no signature counter, so only the invite's single use stops a replay.
    const assertion = await yubikey.assert({ challenge: decodeBase64Url(options.challenge), ...RP, signCount: 0 });
    const binding = createDeviceBinding({ inviteId: options.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(phoneKey)), label: 'Phone', boundAt: Date.now(), signingPrivateKey: phoneKey });
    const body = { invite: options.invite, ticket: options.ticket, credentialId: yubikey.credentialId, assertion, binding };
    expect(await complete(body)).toMatchObject({ status: 200, json: { value: { deviceId: binding.deviceId, expiresAt: null } } });
    // Any verifier holding the records checks the passkey's signature itself: machines, other isolates.
    const records = await vault().listDeviceGrants();
    const record = records.find((candidate) => candidate.binding.deviceId === binding.deviceId)!;
    expect(record.invite.issuer).toMatchObject({ kind: 'passkey', credentialId: yubikey.credentialId, registration: { signer: { deviceId: laptop.deviceId } } });
    expect(verifyDeviceGrantRecord(record, ed25519.getPublicKey(rootKey), Date.now(), (id) => records.find((candidate) => candidate.binding.deviceId === id) ?? null)?.deviceId).toBe(binding.deviceId);
    // The new browser signs its own requests.
    expect((await post({ deviceId: binding.deviceId, key: phoneKey }, 'list', {})).status).toBe(200);
    // A replayed assertion cannot enroll again.
    expect(await complete(body)).toMatchObject({ status: 400, json: { error: { code: 'DEVICE_INVITE_USED' } } });
    // The general enrollment route takes no passkey invite: only sign-in checks the passkey is still enrolled.
    expect(await (await SELF.fetch(new URL('/v1/devices/enroll', env.ACCOUNT_URL), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: record.invite, binding }) })).json()).toMatchObject({ error: { code: 'PASSKEY_SIGN_IN_REQUIRED' } });
  });

  it('refuses an unregistered or forged passkey, another device key, a changed invite and a wrong origin', async () => {
    const laptop = await browser();
    const yubikey = await softwareAuthenticator();
    expect((await enroll(laptop, yubikey)).status).toBe(200);
    const phoneKey = crypto.getRandomValues(new Uint8Array(32));
    const stranger = await softwareAuthenticator();
    expect(await signIn(stranger, await signInOptions(phoneKey), phoneKey)).toMatchObject({ status: 400, json: { error: { code: 'PASSKEY_UNKNOWN' } } });
    expect(await signIn(stranger, await signInOptions(phoneKey), phoneKey, { credentialId: yubikey.credentialId })).toMatchObject({ status: 400, json: { error: { code: 'INVALID_DEVICE_INVITE' } } });
    expect(await signIn(yubikey, await signInOptions(phoneKey), crypto.getRandomValues(new Uint8Array(32)))).toMatchObject({ status: 400, json: { error: { code: 'INVALID_DEVICE_INVITE' } } });
    expect(await signIn(yubikey, await signInOptions(phoneKey), phoneKey, { ceremony: { origin: 'https://evil.example' } })).toMatchObject({ status: 400, json: { error: { code: 'INVALID_DEVICE_INVITE' } } });
    const options = await signInOptions(phoneKey);
    expect(await signIn(yubikey, options, phoneKey, { invite: { ...options.invite, capabilities: ['rpc.read'] } })).toMatchObject({ status: 400, json: { error: { code: 'INVALID_PASSKEY_SIGN_IN' } } });
    expect(await signIn(yubikey, await signInOptions(phoneKey), phoneKey)).toMatchObject({ status: 200 });
  });

  it('stops a revoked passkey from signing in, while browsers it already certified keep working', async () => {
    const laptop = await browser();
    const yubikey = await softwareAuthenticator();
    expect((await enroll(laptop, yubikey)).status).toBe(200);
    const phoneKey = crypto.getRandomValues(new Uint8Array(32));
    const phone = await signIn(yubikey, await signInOptions(phoneKey), phoneKey);
    const phoneId = z.object({ deviceId: z.string() }).parse(phone.json.value).deviceId;
    expect((await post(laptop, 'revoke', { credentialId: yubikey.credentialId }, await passkeyProof(laptop, yubikey, { purpose: 'passkey.revoke', targets: [yubikey.credentialId] }))).status).toBe(200);
    const tabletKey = crypto.getRandomValues(new Uint8Array(32));
    expect(await signIn(yubikey, await signInOptions(tabletKey), tabletKey)).toMatchObject({ status: 400, json: { error: { code: 'PASSKEY_UNKNOWN' } } });
    expect((await post({ deviceId: phoneId, key: phoneKey }, 'list', {})).status).toBe(200);
  });
});
