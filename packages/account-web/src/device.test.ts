import { afterEach, expect, it, vi } from 'vitest';
import { createDeviceSignedFetch, type BrowserDevice } from './device.js';

const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair;
const device: BrowserDevice = {
  deviceId: '123e4567-e89b-42d3-a456-426614174001', label: 'Browser', publicKey: '', keyPair, enrolledAt: 0,
  userId: 'user', enrollUrl: 'https://account.test', canDelegate: false,
};

afterEach(() => vi.unstubAllGlobals());

it('keeps enrollment on a proxy 401 but clears an explicitly rejected current device', async () => {
  let current: BrowserDevice | null = device;
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response('Authentication service unavailable', { status: 401 }))
    .mockResolvedValueOnce(Response.json({ error: { code: 'RPC_DEVICE_UNKNOWN' } }, { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const signed = createDeviceSignedFetch(async () => current, () => { current = null; });
  const response = await signed('https://account.test/rpc', { method: 'POST', body: 'request' });
  expect(response.status).toBe(401);
  expect(await response.text()).toBe('Authentication service unavailable');
  expect(current).toBe(device);
  await signed('https://account.test/rpc', { method: 'POST', body: 'request' });
  expect(current).toBeNull();
});

it('does not revoke a replacement enrollment when an old signed request finishes late', async () => {
  let current: BrowserDevice | null = device;
  const pending = Promise.withResolvers<Response>();
  const fetcher = vi.fn(async () => pending.promise);
  vi.stubGlobal('fetch', fetcher);
  const signed = createDeviceSignedFetch(async () => current, () => { current = null; });
  const request = signed('https://account.test/rpc', { method: 'POST', body: 'request' });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  const replacement = { ...device, deviceId: '123e4567-e89b-42d3-a456-426614174002' };
  current = replacement;
  pending.resolve(Response.json({ error: { code: 'RPC_DEVICE_UNKNOWN' } }, { status: 401 }));
  expect((await request).status).toBe(401);
  expect(current).toBe(replacement);
});
