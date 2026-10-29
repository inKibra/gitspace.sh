import { env } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';
import { createRuntimeImages } from '../src/runtime-images.js';

const origin = `https://${env.TENANT_ID}.gitspace.sh`;
const get = (path: string) => worker.fetch(new Request(new URL(path, origin)), env);
/** A PNG's signature and header: 640x480. */
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 128, 0, 0, 1, 224, 8, 6, 0, 0, 0]);

afterEach(() => { vi.useRealTimers(); });

it('stores an image once by its bytes, with the dimensions its header declares, and serves it by a URL that holds for its window and is refused once altered or expired', async () => {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 9, 29, 12, 10));
  const images = await createRuntimeImages(env, 'ws-images');
  const image = await images.store({ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') });
  expect(image).toEqual({ type: 'image', mimeType: 'image/png', data: `gs-image:v1:ws-images:${png.byteLength}:640x480:${Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex')}` });
  expect(await images.store(image)).toEqual(image);
  // A codemode script gets the stored image's bytes back; another workspace's image is not this one's to read.
  expect(await images.load(image)).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') });
  await expect(images.load({ ...image, data: image.data.replace('ws-images', 'ws-other') })).rejects.toThrow("is not this workspace's");

  const url = images.url(`${image.data};image/png`);
  vi.setSystemTime(Date.UTC(2026, 9, 29, 12, 50));
  expect(images.url(`${image.data};image/png`)).toBe(url);
  const served = await get(url);
  expect(served.status).toBe(200);
  expect(served.headers.get('content-type')).toBe('image/png');
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);

  const signature = url.slice(url.lastIndexOf('/') + 1);
  expect((await get(`${url.slice(0, url.lastIndexOf('/') + 1)}${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`)).status).toBe(404);
  expect((await get(url.replace('/ws-images/', '/ws-other/'))).status).toBe(404);
  // Another workspace's image is not this one's to name.
  expect(images.url(`${image.data.replace('ws-images', 'ws-other')};image/png`)).toBe(`${image.data.replace('ws-images', 'ws-other')};image/png`);

  vi.setSystemTime(Date.UTC(2026, 9, 29, 15, 0));
  expect((await get(url)).status).toBe(404);
});
