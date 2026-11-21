# Passkeys for GitSpace browsers

Issue #238, step 1. Passkeys certify browsers and confirm sensitive actions. OAuth for MCP clients (steps 2 and 3) builds on the step-up described here.

## Model

- A **passkey** is a WebAuthn credential on the account host (`rpId` = the account's hostname, e.g. `alice.gitspace.sh`; ceremonies run on its origin). It can be a platform passkey (iCloud Keychain, Google Password Manager, Windows Hello) or a FIDO2 security key (YubiKey over USB or NFC). GitSpace asks for discoverable credentials (`residentKey: 'required'`) and user verification (`userVerification: 'required'`: biometric or the key's PIN). It accepts ES256, EdDSA (Ed25519) and RS256, and asks for no attestation.
- A passkey does three things: **signs a new browser in** (it certifies that browser's device key), **steps up** (confirms one sensitive action), and is listed and revocable in Settings → Connections → Passkeys.
- The **recovery key** (`gsr_…`, the account root private key) still works: it enrolls a browser, and it can answer any step-up in place of a passkey. GitSpace never stores it and cannot tell whether you kept it.

## Trust chain

Everything that can mint a device is a signature GitSpace's servers do not hold: the root key, a delegating browser's device key, or a passkey.

```
root key ──signs──▶ browser invite ◀──binds── browser device key
browser device key ──signs──▶ passkey registration (credential id, COSE public key, rpId, origin, label, createdAt)
passkey ──WebAuthn assertion over SHA-256(invite)──▶ invite naming the new browser's device key ◀──binds── new device key
```

- **Registration** (`PasskeyRegistration` in `protocol/src/device-grant.ts`) is signed with Ed25519 by the enrolling browser's device key. That browser must be an account-wide, delegating browser with `devices.manage`. The vault also checks the authenticator's `create()` response against a one-time `passkey.register` challenge issued to that browser, and that the registration matches the key the authenticator made (`verifyWebAuthnRegistration`).
- **Passkey-certified invite**: the issuer is `{ kind: 'passkey', credentialId, registration, authenticatorData, clientDataJSON }` and the invite's `signature` is the WebAuthn signature (base64url). The invite names the new device key (`deviceSigningPublicKey`); the binding must carry that key. The WebAuthn challenge is `SHA-256(canonical JSON of the invite)`.
- **Verification** happens wherever grants are verified today (`verifyDeviceGrantRecord`: the vault, every isolate's `DeviceVerifier`, machines' `DeviceRegistry`, offline issuer chains). The registration and assertion travel inside the grant record, so verifiers need no new data: they check the registration's signature against the enrolling browser's record (resolved like a delegating issuer) and the assertion against the registered public key, origin and `rpId` hash, with user presence and verification.
- **Time of judgement.** A registration is judged as of its `createdAt`: revoking the browser that enrolled a passkey leaves the passkey working (it is how you recover from losing that browser). A passkey-certified browser keeps working after the passkey is revoked, until it is revoked itself. Unlike a delegating browser, neither link is a live dependency.
- **What only the vault enforces.** A revoked passkey's new sign-ins are refused by the vault (`/v1/passkeys/sign-in/complete` requires an active passkey and an invite the vault MACed). Offline verifiers do not see passkey revocations; as with withheld device revocations, a vault that misbehaves can only accept signatures it cannot forge.
- The general enrollment route (`/v1/devices/enroll`) refuses passkey invites (`PASSKEY_SIGN_IN_REQUIRED`); passkey sign-in is the only way in for them.

## Step-up (API for the OAuth task)

A step-up is a WebAuthn assertion over a one-time server challenge naming the exact action: purpose and target ids, for one signed-in browser, expiring two minutes after issue, spent on first use. It is strict: every action asks again.

### Challenge

`POST /v1/passkeys/challenge` (signed by the browser, `x-gitspace-device`; any account-wide browser) with `{ userId, purpose, targets }` answers `PasskeyChallengeView` (`protocol/src/passkey-access.ts`):

- `{ required: false }` when no step-up is due (see Bootstrap below), or
- `{ required: true, challengeId, payload, challenge, rpId, expiresAt, allowCredentials, registration: null }`.

`payload` is a `PasskeyChallenge` (`protocol/src/device-grant.ts`):

```ts
{ version: 1, userId, challengeId, deviceId, purpose, targets, issuedAt, expiresAt, nonce }
```

`challenge` = base64url(SHA-256(canonical JSON of `payload`)) is what the authenticator signs; the recovery key signs the canonical JSON itself (`passkeyChallengePayload`).

### Proof

The browser sends the action with header `x-gitspace-step-up` (`STEP_UP_HEADER`) = base64url JSON of `StepUpProof`:

```ts
{ challengeId, proof: { kind: 'passkey', credentialId, authenticatorData, clientDataJSON, signature } }
{ challengeId, proof: { kind: 'root', signature } }   // Ed25519 over passkeyChallengePayload(payload)
```

### Server function

`CredentialVaultDO.consumeStepUp({ deviceId, action: { purpose, targets }, proof }): CredentialVaultResult<StepUpGrant>` (`account-worker/src/passkeys.ts`, `PasskeyVault.consumeStepUp`). It is synchronous inside the vault, so vault actions spend the step-up in the same transaction as the action; code outside the vault calls it over DO RPC (secure input does). Refusals: `STEP_UP_REQUIRED`, `STEP_UP_ENROLL_REQUIRED` (no active passkey: enroll one or use the recovery key), `STEP_UP_INVALID` (another action, target, browser or challenge; unknown or revoked passkey; bad signature, origin, `rpId` or user verification; counter went backwards), `STEP_UP_EXPIRED`, `STEP_UP_USED`. Success answers `{ method: 'passkey', credentialId } | { method: 'root' | 'bootstrap', credentialId: null }`.

### Web helper

`requestStepUp(action): Promise<StepUp>` (`account-web/src/passkeys.ts`) fetches the challenge. `StepUp.withPasskey()` runs `navigator.credentials.get()` and `StepUp.withRecoveryKey(key)` signs with the recovery key; both answer the header value (null when not required). Safari runs WebAuthn only inside a user gesture, so fetch the challenge first and call `withPasskey()` first thing in the click handler. `StepUpPrompt` (`account-web/src/StepUpPrompt.tsx`) is the UI for it.

### Purposes

| Purpose | Target | Used by |
|---|---|---|
| `passkey.enroll` | the registration challenge id | registering a passkey once one exists |
| `passkey.revoke` | the credential id | revoking a passkey |
| `browser-invitation.create` | the invite id | registering a browser invitation link |
| `secure-input.open` | the secure-input request id | `view` on `/api/secure-input` |
| `secure-input.answer` | the secure-input request id | `submit` and `useSaved` (`decline` needs none) |
| `mcp-oauth.grant` | the OAuth authorization request id | allowing an MCP client Decide as you, Account administration, Lifecycle control, Device management or Deployment on the OAuth consent page; spent in the same vault transaction that records the grant (docs/GITSPACE-MCP-CAPABILITY-MATRIX.md, "Connect with OAuth") |

`MCP_OAUTH_STEP_UP_CAPABILITIES` (`protocol/src/mcp-authorization.ts`) lists the permissions that need it; other permissions need only the signed-in browser.

### Bootstrap

An account with no active passkey may enroll its first passkey and create browser invitations with no step-up (`required: false`); every other purpose still needs one, which only the recovery key can give until a passkey is enrolled. Secure input and granting an MCP client powerful permissions therefore need an enrolled passkey (or the recovery key).

## Passkey sign-in

1. The new browser makes its non-extractable Ed25519 device key and calls `POST /v1/passkeys/sign-in/options` with `{ deviceSigningPublicKey }` (no credential).
2. The vault answers an invite (full browser grant, account scope, delegating, valid two minutes) naming that key, the challenge `SHA-256(invite)`, and a ticket: HMAC-SHA-256 of the invite under a key derived from the vault key (HKDF, `gitspace/passkey-sign-in/v1`). Nothing is stored.
3. The browser runs `navigator.credentials.get()` with no `allowCredentials` (discoverable), signs a binding with its device key and calls `POST /v1/passkeys/sign-in/complete` with `{ invite, ticket, credentialId, assertion, binding }`.
4. The vault checks the ticket, the expiry, that the passkey is active and its counter advanced, assembles the passkey-issued grant and records it exactly as other enrollments (first bind wins on the invite id).

## Storage (credential vault)

- `passkeys(credential_id, registration_json, sign_count, last_used_at, revoked_at)`: the signed registration, the last signature counter, and revocation. Revoked rows stay so their history and the credential id stay reserved.
- `passkey_challenges(challenge_id, device_id, payload_json, challenge, expires_at, used_at)`: one-time challenges, at most 16 open per browser; rows two minutes past expiry are deleted when new ones are issued.
- Passkey-certified browsers are ordinary `device_grants` rows whose `record_json` carries the registration and assertion.

## Recovery

- Lost a browser: sign in on another one with a passkey (synced, or a security key).
- Lost every passkey: connect a browser with the recovery key, then revoke the lost passkeys and enroll new ones, answering their step-ups with the recovery key.
- Lost every passkey, every browser and the recovery key: no way back in. Settings nudges accounts with one passkey to add a second, preferably from another provider (a security key, or another platform), or to keep the recovery key.

## Signup

Out of scope here. Signup today creates the root key in the page and shows `gsr_…`. To offer a passkey instead of, or as well as, the recovery key, signup would enroll the first browser (as now), then run passkey registration from it before leaving the page; making the recovery key optional also means signup must not require confirming the pasted `gsr_` key when a passkey was enrolled.

## Not verified by tests

Unit and worker tests use a software authenticator (Web Crypto and noble keys, byte-built authenticator and client data). Real authenticators need live checks: Mac Touch ID (platform, synced via iCloud), iPhone Face ID (step-up and sign-in on the phone, and cross-device QR sign-in from a desktop), and a YubiKey over USB and over NFC on iPhone (discoverable credential with PIN, EdDSA or ES256).
