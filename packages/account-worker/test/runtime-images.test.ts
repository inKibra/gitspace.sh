import { env } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { ed25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index.js';
import { tenantRootPrivateKey } from './setup.js';
import { createRuntimeImages, storedImages } from '../src/runtime-images.js';
import { mintUploadLink } from '../src/upload-link.js';
import { DriveFiles } from '../src/drive-files.js';
import { tenantStore } from '../src/tenant-store.js';
import { readWorkspaceImage } from '../src/image-reader.js';

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
  // generate_image gets the stored image's bytes back; another workspace's image is not this one's to read.
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

it('reads a workspace\'s stored image through its reader', async () => {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const images = await createRuntimeImages(env, 'ws-reader');
  const stored = await images.store({ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') });
  const reader = exports.ImageReader({ props: { workspaceId: 'ws-reader' } });
  expect(new Uint8Array(await new Response(await reader.read(stored.data)).arrayBuffer())).toEqual(png);
  // A reader made for another workspace refuses the reference, whatever it names.
  await expect(readWorkspaceImage(env, 'ws-other', stored.data)).rejects.toThrow("is not this workspace's");
});

it('an image upload link stores exactly the declared image and answers its reference, which the workspace admits; other bytes are refused', async () => {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex');
  const declared = { kind: 'image' as const, workspaceId: 'ws-upload', sha256, size: png.byteLength, mimeType: 'image/png' as const };
  const put = async (link: string, bytes: Uint8Array<ArrayBuffer>) => worker.fetch(new Request(`${link}/parts/1`, { method: 'PUT', body: bytes, headers: { 'content-length': String(bytes.byteLength) } }), env);
  const reply = await put(await mintUploadLink(env, declared), png);
  expect(reply.status).toBe(200);
  const reference = `gs-image:v1:ws-upload:${png.byteLength}:640x480:${sha256}`;
  expect(await reply.json()).toEqual({ status: 'ok', value: { reference } });
  const images = storedImages(env, 'ws-upload');
  expect(await images.load({ type: 'image', mimeType: 'image/png', data: reference })).toEqual({ type: 'image', mimeType: 'image/png', data: Buffer.from(png).toString('base64') });
  // Bytes that are not the declared image store nothing.
  const other = png.slice(); other[20] = 3;
  const refused = await put(await mintUploadLink(env, declared), other);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toMatchObject({ status: 'error', error: { message: 'The image does not match its declared SHA-256' } });
});

it('admits a client\'s reference only once its bytes are stored in the workspace, measuring them itself', async () => {
  await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const sha256 = Buffer.from(await crypto.subtle.digest('SHA-256', png)).toString('hex');
  const images = storedImages(env, 'ws-admit');
  const unmeasured = { type: 'image' as const, mimeType: 'image/png', data: `gs-image:v1:ws-admit:${png.byteLength}:0x0:${sha256}` };
  await expect(images.store(unmeasured)).rejects.toThrow('is not stored');
  // A client (a machine, a browser session) stored the bytes itself, under their digest in the workspace's scope.
  await new DriveFiles(tenantStore(env), env.ACCOUNT_ID).put('space:ws-admit', png);
  expect(await images.store(unmeasured)).toEqual({ ...unmeasured, data: `gs-image:v1:ws-admit:${png.byteLength}:640x480:${sha256}` });
  await expect(images.store({ ...unmeasured, data: unmeasured.data.replace(`:${png.byteLength}:`, ':999:') })).rejects.toThrow('is not stored');
  await expect(images.store({ ...unmeasured, data: unmeasured.data.replace('ws-admit', 'ws-other') })).rejects.toThrow("is not this workspace's");
});
