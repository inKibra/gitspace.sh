import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { createRelayAuthorization, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { expect, it } from 'vitest';

it('recovers an active account without another invite or provisioning, but rejects foreign keys and suspended accounts', async () => {
  const privateKey = ed25519.utils.randomSecretKey();
  const publicKey = ed25519.getPublicKey(privateKey);
  const userId = `u-${Array.from(sha256(publicKey).subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const handle = `recover-${crypto.randomUUID().slice(0, 8)}`;
  await env.CREDENTIALS.getByName(userId).bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(publicKey), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const accounts = env.ACCOUNTS.getByName('global');
  await accounts.upsertProvisioning({ userId, handle });
  await accounts.markActive({ userId, release: 'existing-release' });
  const path = '/v1/accounts/recover';
  const recover = (signer = privateKey) => SELF.fetch(`https://gitspace.sh${path}`, {
    method: 'POST',
    headers: { authorization: createRelayAuthorization(signer, path), 'content-type': 'application/json' },
    body: JSON.stringify({ rootPublicKey: credentialProtocolBase64.encode(publicKey), handle }),
  });
  const recovered = await recover();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({ status: 'ok', value: { userId, handle, accountUrl: `https://${handle}.gitspace.sh`, relayUrl: `https://${handle}.gssh.dev` } });
  expect((await accounts.get(userId))?.tenantRelease).toBe('existing-release');
  expect((await recover(ed25519.utils.randomSecretKey())).status).toBe(401);
  await accounts.setStatus({ userId, status: 'suspended', reason: 'beta hold', actor: 'operator', action: 'suspend' });
  expect((await recover()).status).toBe(409);
  expect((await accounts.get(userId))?.status).toBe('suspended');
});

it('denies revoked and superseded machine grants at the relay authority', async () => {
  const root = ed25519.utils.randomSecretKey();
  const userId = `relay-${crypto.randomUUID()}`;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(root)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const accounts = env.ACCOUNTS.getByName('global');
  await accounts.upsertProvisioning({ userId, handle: `relay-${crypto.randomUUID().slice(0, 8)}` });
  await accounts.markActive({ userId, release: null });
  const grant = signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'machine',
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(ed25519.utils.randomSecretKey())),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(x25519.utils.randomSecretKey())),
    capabilities: ['space.control', 'storage.access'], generation: 1,
  }, root);
  await vault.registerDevice(grant);
  const authorize = (candidate = grant) => SELF.fetch('https://api.gitspace.sh/v1/relay/authorize', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant: candidate, capability: 'storage.access' }),
  });
  expect((await authorize()).status).toBe(200);
  const rotated = signCredentialAuthorityGrant({ ...grant.grant, generation: 2 }, root);
  await vault.registerDevice(rotated);
  expect((await authorize()).status).toBe(401);
  expect((await authorize(rotated)).status).toBe(200);
  await vault.removeManagedDevice('machine');
  expect((await authorize(rotated)).status).toBe(401);
  await vault.registerDevice(signCredentialAuthorityGrant({ ...grant.grant, generation: 3 }, root));
  await accounts.setStatus({ userId, status: 'suspended', reason: 'hold', actor: 'operator', action: 'suspend' });
  expect((await authorize(signCredentialAuthorityGrant({ ...grant.grant, generation: 3 }, root))).status).toBe(401);
});
