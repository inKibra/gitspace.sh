import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createRelayAuthorization, credentialProtocolBase64 } from '@gitspace/protocol';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { HttpResponse, http } from 'msw';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { network } from './network.js';

let operatorPrivateKey: CryptoKey;
let operatorPublicKey: JsonWebKey;

async function operatorHeaders(email = 'operator@example.com', audience = 'test-access-audience'): Promise<Record<string, string>> {
  const token = await new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'operator-test-key' })
    .setIssuer('https://gitspace-test.cloudflareaccess.com')
    .setAudience(audience)
    .setSubject('operator-subject')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(operatorPrivateKey);
  return { 'cf-access-jwt-assertion': token };
}

beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  operatorPrivateKey = keys.privateKey;
  operatorPublicKey = await exportJWK(keys.publicKey);
});

beforeEach(() => {
  network.use(http.get('https://gitspace-test.cloudflareaccess.com/cdn-cgi/access/certs', () => HttpResponse.json({
    keys: [{ ...operatorPublicKey, kid: 'operator-test-key', alg: 'RS256', use: 'sig' }],
  })));
});

async function createInvite(note: string) {
  const response = await SELF.fetch('https://gitspace.sh/v1/operator/invites', {
    method: 'POST',
    headers: { ...await operatorHeaders(), 'content-type': 'application/json' },
    body: JSON.stringify({ note, expiresInDays: 7 }),
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{
    status: 'ok';
    value: { token: string; signupUrl: string; invite: { id: string; status: string } };
  }>;
}

describe('operator invitation admission', () => {
  it('requires a valid Cloudflare Access operator identity', async () => {
    const unauthorized = await SELF.fetch('https://gitspace.sh/v1/operator/session');
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toMatchObject({ status: 'error', error: { code: 'OPERATOR_UNAUTHORIZED' } });

    const wrongEmail = await SELF.fetch('https://gitspace.sh/v1/operator/session', { headers: await operatorHeaders('someone@example.com') });
    expect(wrongEmail.status).toBe(401);

    const wrongAudience = await SELF.fetch('https://gitspace.sh/v1/operator/session', { headers: await operatorHeaders('operator@example.com', 'another-application') });
    expect(wrongAudience.status).toBe(401);

    const authorized = await SELF.fetch('https://gitspace.sh/v1/operator/session', { headers: await operatorHeaders() });
    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({ status: 'ok', value: { authenticated: true, email: 'operator@example.com' } });
  });

  it('issues raw tokens once and enforces reservation, release, consumption, and revocation', async () => {
    const created = await createInvite(`invite-${crypto.randomUUID()}`);
    expect(created.value.token).toMatch(/^gsi_[A-Za-z0-9_-]{43}$/u);
    expect(created.value.signupUrl).toContain(encodeURIComponent(created.value.token));

    const listed = await SELF.fetch('https://gitspace.sh/v1/operator/invites', { headers: await operatorHeaders() });
    expect(listed.status).toBe(200);
    const listedText = await listed.text();
    expect(listedText).not.toContain(created.value.token);
    expect(JSON.parse(listedText)).toMatchObject({ status: 'ok', value: { invites: expect.arrayContaining([expect.objectContaining({ id: created.value.invite.id, status: 'available' })]) } });

    const registry = env.INVITES.getByName('global');
    expect(await registry.reserve({ token: created.value.token, userId: 'user-a', handle: 'alpha' })).toEqual({ status: 'reserved' });
    expect(await registry.reserve({ token: created.value.token, userId: 'user-b', handle: 'bravo' })).toEqual({ status: 'invalid', reason: 'reserved' });
    await registry.release({ token: created.value.token, userId: 'user-a' });
    expect(await registry.reserve({ token: created.value.token, userId: 'user-b', handle: 'bravo' })).toEqual({ status: 'reserved' });
    expect(await registry.consume({ token: created.value.token, userId: 'user-b', handle: 'bravo' })).toEqual({ consumed: true });
    expect(await registry.reserve({ token: created.value.token, userId: 'user-b', handle: 'bravo' })).toEqual({ status: 'already-consumed' });
    expect(await registry.reserve({ token: created.value.token, userId: 'user-c', handle: 'charlie' })).toEqual({ status: 'invalid', reason: 'consumed' });

    const revocable = await createInvite(`revoke-${crypto.randomUUID()}`);
    const revoked = await SELF.fetch(`https://gitspace.sh/v1/operator/invites/${revocable.value.invite.id}`, { method: 'DELETE', headers: await operatorHeaders() });
    expect(revoked.status).toBe(200);
    expect(await registry.reserve({ token: revocable.value.token, userId: 'user-d', handle: 'delta' })).toEqual({ status: 'invalid', reason: 'revoked' });
  });

  it('rejects public and invalid-invite account bootstrap before provisioning', async () => {
    const rootPrivateKey = ed25519.utils.randomSecretKey();
    const path = '/v1/accounts/bootstrap';
    const account = {
      handle: `closed-${crypto.randomUUID().slice(0, 8)}`,
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))),
    };
    const headers = { authorization: createRelayAuthorization(rootPrivateKey, path), 'content-type': 'application/json' };

    const publicSignup = await SELF.fetch(`https://gitspace.sh${path}`, { method: 'POST', headers, body: JSON.stringify(account) });
    expect(publicSignup.status).toBe(400);
    expect(await publicSignup.json()).toMatchObject({ status: 'error', error: { code: 'INVALID_BOOTSTRAP' } });

    const invalidInvite = await SELF.fetch(`https://gitspace.sh${path}`, { method: 'POST', headers, body: JSON.stringify({ ...account, invite: 'gsi_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) });
    expect(invalidInvite.status).toBe(403);
    expect(await invalidInvite.json()).toMatchObject({ status: 'error', error: { code: 'INVITE_INVALID' } });
  });
});
