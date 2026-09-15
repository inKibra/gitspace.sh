import { env, SELF } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { HttpResponse, http } from 'msw';
import { createRelayAuthorization, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { expect, it } from 'vitest';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

it('recovers the tenant account without provisioning, but rejects foreign keys and platform-suspended accounts', async () => {
  const privateKey = tenantRootPrivateKey;
  const publicKey = ed25519.getPublicKey(privateKey);
  const userId = env.ACCOUNT_ID;
  const handle = env.TENANT_ID;
  await env.CREDENTIALS.getByName(userId).bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(publicKey), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const path = '/v1/accounts/recover';
  const recover = (signer = privateKey, origin = `https://${handle}.gitspace.sh`) => SELF.fetch(`${origin}${path}`, {
    method: 'POST',
    headers: { authorization: createRelayAuthorization(signer, path), 'content-type': 'application/json' },
    body: JSON.stringify({ rootPublicKey: credentialProtocolBase64.encode(publicKey), handle }),
  });
  const recovered = await recover();
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({
    status: 'ok',
    value: { userId, handle, accountUrl: `https://${handle}.gitspace.sh`, apiUrl: `https://${handle}.gitspace.sh`, relayUrl: env.RELAY_URL },
  });
  expect(await (await recover(privateKey, 'https://another-account.gitspace.sh')).json()).toMatchObject({ error: { code: 'ACCOUNT_HOST_MISMATCH' } });
  expect((await recover(ed25519.utils.randomSecretKey())).status).toBe(401);
  network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'suspended' } })));
  const suspended = await recover();
  expect(suspended.status).toBe(403);
  expect(await suspended.json()).toMatchObject({ error: { code: 'ACCOUNT_UNAVAILABLE' } });
});

it('denies revoked and superseded machine grants at the relay authority', async () => {
  const root = tenantRootPrivateKey;
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(root)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
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
  network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => HttpResponse.json({ control: { status: 'suspended' } })));
  expect((await authorize(signCredentialAuthorityGrant({ ...grant.grant, generation: 3 }, root))).status).toBe(401);
});
