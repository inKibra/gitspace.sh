import { env } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { createHash } from 'node:crypto';
import { createSignedControlRequest, credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { FleetCatalogDO } from '../src/fleet-catalog.js';
import { tenantRootPrivateKey } from './setup.js';

const signingPrivateKey = new Uint8Array(32).fill(71);
const attemptId = '7d1c1d39-5d0e-4a8e-9a43-1f0f6f1ad6a1';

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function enroll(): Promise<string> {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'publisher', generation: 1, capabilities: ['storage.access', 'space.control'],
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signingPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(72))),
  }, tenantRootPrivateKey));
  return userId;
}

function put(userId: string, key: string, bytes: Uint8Array<ArrayBuffer>, payload: Record<string, unknown> = {}, control?: string): Promise<Response> {
  const signed = createSignedControlRequest({ userId, machineId: 'publisher', operation: 'data.put', payload: { key, hash: sha256(bytes), size: bytes.byteLength, ...payload }, signingPrivateKey });
  return worker.fetch(new Request(`https://auth.test/v1/data/${key}`, {
    method: 'PUT',
    headers: { 'x-gitspace-control': control ?? btoa(JSON.stringify(signed)), 'x-gitspace-sync-attempt': attemptId, 'content-length': String(bytes.byteLength) },
    body: bytes,
  }), env);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('signed route failures', () => {
  it('answers a storage failure during data.put with a retryable 503 and logs its cause', async () => {
    const userId = await enroll();
    const key = 'releases/04f9280c/frontend/assets/csharp.js';
    const bytes = new TextEncoder().encode('export const csharp = 1;');
    vi.spyOn(env.DATA, 'put').mockRejectedValue(new TypeError('Network connection lost.'));
    const logged = vi.spyOn(console, 'info');
    const response = await put(userId, key, bytes);
    expect([response.status, await response.json()]).toEqual([503, { status: 'error', error: { code: 'DATA_STORAGE_FAILED', message: 'Storing the object failed; try again' } }]);
    const line = logged.mock.calls.map(([entry]) => String(entry)).find(entry => entry.includes('"outcome":"caught_error"'));
    expect(JSON.parse(line ?? '{}')).toMatchObject({
      event: 'artifact_sync_worker_request', attemptId, stage: 'r2.put', status: 503, error: { name: 'TypeError', message: 'Network connection lost.' },
    });
  });

  it('keeps requests the client must change at 400 with their own codes', async () => {
    const userId = await enroll();
    const key = 'releases/04f9280c/frontend/assets/app.js';
    const bytes = new TextEncoder().encode('export const app = 1;');
    const malformed = await put(userId, key, bytes, {}, 'not-a-signed-request');
    expect([malformed.status, await malformed.json()]).toMatchObject([400, { error: { code: 'INVALID_SIGNED_REQUEST' } }]);
    const mismatched = await put(userId, key, bytes, { key: 'releases/04f9280c/frontend/assets/other.js' });
    expect([mismatched.status, await mismatched.json()]).toMatchObject([400, { error: { code: 'SIGNED_REQUEST_MISMATCH' } }]);
    // Bytes that miss the signed SHA-256 are refused and never stored.
    const digest = await put(userId, key, bytes, { hash: sha256(new Uint8Array([1])) });
    expect([digest.status, await digest.json()]).toMatchObject([400, { error: { code: 'OBJECT_DIGEST_MISMATCH' } }]);
    expect(await env.DATA.head(`users/${userId}/${key}`)).toBeNull();
  });

  it('answers a control request whose Durable Object failed transiently with a retryable 503', async () => {
    const userId = await enroll();
    const control = () => worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId, machineId: 'publisher', operation: 'catalog.machine.list', payload: {}, signingPrivateKey })),
    }), env);
    const listing = vi.spyOn(FleetCatalogDO.prototype, 'listMachines').mockRejectedValueOnce(Object.assign(new Error('Durable Object reset because its code was updated.'), { retryable: true }));
    const reset = await control();
    expect([reset.status, await reset.json()]).toEqual([503, { status: 'error', error: { code: 'CONTROL_UNAVAILABLE', message: 'The control request failed; try again' } }]);
    // An error the object raised about the request itself stays a 400.
    listing.mockRejectedValueOnce(new Error('Unsupported catalog query'));
    const refused = await control();
    expect([refused.status, await refused.json()]).toEqual([400, { status: 'error', error: { code: 'BAD_REQUEST', message: 'Unsupported catalog query' } }]);
  });
});
