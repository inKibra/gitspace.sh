import { expect, test } from 'bun:test';
import { credentialProtocolBase64 } from '../src/credential-vault.js';
import { signServiceAssertion, verifyServiceAssertion } from '../src/service-access.js';

test('service assertions bind tenant, exact host, machine, caller, method, target, and expiry', async () => {
  const keys = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
  const publicKey = credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
  const now = Date.now();
  const body = { version: 1 as const, accountId: 'account-a', hostname: 'web--space--test-srv.gssh.dev', machineId: 'machine-a', caller: { kind: 'device' as const, accountId: 'account-a', deviceId: 'machine-b' }, method: 'POST', target: '/private?q=1', issuedAt: now, expiresAt: now + 30_000, nonce: crypto.randomUUID() };
  const header = await signServiceAssertion(body, keys.privateKey);
  const input = { header, publicKey, accountId: body.accountId, hostname: body.hostname, machineId: body.machineId, method: body.method, target: body.target, now };
  expect(verifyServiceAssertion(input)?.caller).toEqual(body.caller);
  for (const change of [{ accountId: 'account-b' }, { hostname: 'other--space--test-srv.gssh.dev' }, { machineId: 'machine-b' }, { method: 'GET' }, { target: '/private?q=2' }, { now: now + 30_000 }]) expect(verifyServiceAssertion({ ...input, ...change })).toBeNull();
  const wrongCaller = await signServiceAssertion({ ...body, caller: { ...body.caller, accountId: 'account-b' } }, keys.privateKey);
  expect(verifyServiceAssertion({ ...input, header: wrongCaller })).toBeNull();
});
