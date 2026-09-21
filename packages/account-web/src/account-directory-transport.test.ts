import { afterEach, expect, it, vi } from 'vitest';
import { decodeSignedRpcHeader, deviceProtocolBase64, rpcSignaturePayload } from '@gitspace/protocol/device-grant';
import type { AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import { createAccountDirectorySource } from './account-directory-transport.js';
import type { BrowserDevice } from './device.js';
import { SynchronizationOwner } from './synchronization.js';

const keyPair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']) as CryptoKeyPair;
const device: BrowserDevice = {
  deviceId: '123e4567-e89b-42d3-a456-426614174001', label: 'Browser', publicKey: '', keyPair, enrolledAt: 0,
  userId: 'user', enrollUrl: 'https://account.test', canDelegate: false,
};
const value: AccountDirectorySnapshot = { projects: [], workspaces: [], placements: [], machines: [], projectRevisions: {} };
class Socket extends EventTarget {
  readyState = 0;
  constructor(readonly url: string) { super(); }
  close = vi.fn(() => { this.readyState = 3; });
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  message(data: unknown) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
  end(code = 1006, reason = '') { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code, reason })); }
}
function fixture() {
  let current: BrowserDevice | null = device;
  const rejected = vi.fn(() => { current = null; });
  const sockets: Socket[] = [];
  const source = createAccountDirectorySource({
    currentDevice: async () => current, onRejected: rejected, origin: () => 'https://account.test',
    openSocket: (url) => { const socket = new Socket(url); sockets.push(socket); return socket as unknown as WebSocket; },
  });
  return { source, sockets, rejected, replace: (replacement: BrowserDevice) => { current = replacement; }, current: () => current };
}
const controllers: AbortController[] = [];
const owners: SynchronizationOwner[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const owner of owners.splice(0)) owner.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('signs the resume cursor and accepts only validated directory frames', async () => {
  const scene = fixture();
  const controller = new AbortController();
  controllers.push(controller);
  const stream = scene.source(37, controller.signal)[Symbol.asyncIterator]();
  const next = stream.next();
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(1));
  const socket = scene.sockets[0]!;
  const url = new URL(socket.url);
  expect(url.protocol).toBe('wss:');
  const auth = decodeSignedRpcHeader(url.searchParams.get('auth')!);
  expect(auth).not.toBeNull();
  url.searchParams.delete('auth');
  const payload = rpcSignaturePayload({ ...auth!, method: 'GET', path: `${url.pathname}${url.search}`, body: new Uint8Array() });
  expect(await crypto.subtle.verify('Ed25519', keyPair.publicKey, Uint8Array.from(deviceProtocolBase64.decode(auth!.signature)).buffer, Uint8Array.from(payload).buffer)).toBe(true);
  expect(url.searchParams.get('after')).toBe('37');
  socket.open();
  socket.message(JSON.stringify({ type: 'change', resource: 'account-directory', cursor: 38, revision: 38, previous: 37, value }));
  expect(await next).toMatchObject({ done: false, value: { status: 'ok', value: { cursor: 38, previous: 37, value } } });
  const invalid = stream.next();
  socket.message(JSON.stringify({ type: 'snapshot', resource: 'account-directory', cursor: 39, revision: 39, previous: null, value: { ...value, workspaces: [{ id: 'incomplete' }] } }));
  expect(await invalid).toMatchObject({ done: false, value: { status: 'error', error: expect.any(Error) } });
  expect(socket.close).toHaveBeenCalledOnce();
  await stream.return?.();
});

it('finishes cancellation during signing without opening a late socket', async () => {
  const scene = fixture();
  const signing = Promise.withResolvers<ArrayBuffer>();
  const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementationOnce(() => signing.promise);
  const controller = new AbortController();
  controllers.push(controller);
  const stream = scene.source(null, controller.signal)[Symbol.asyncIterator]();
  const next = stream.next();
  await vi.waitFor(() => expect(sign).toHaveBeenCalledOnce());
  controller.abort();
  expect(await next).toMatchObject({ done: true });
  signing.resolve(new ArrayBuffer(64));
  await Promise.resolve();
  expect(scene.sockets).toEqual([]);
});

it('closes an opening socket on unmount and discards late delivery', async () => {
  const scene = fixture();
  const controller = new AbortController();
  controllers.push(controller);
  const stream = scene.source(null, controller.signal)[Symbol.asyncIterator]();
  const next = stream.next();
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(1));
  controller.abort();
  expect(await next).toMatchObject({ done: true });
  expect(scene.sockets[0]!.close).toHaveBeenCalledOnce();
  scene.sockets[0]!.message(JSON.stringify({ type: 'snapshot', resource: 'account-directory', cursor: 1, revision: 1, previous: null, value }));
  expect(await stream.next()).toMatchObject({ done: true });
});

it('shares a single socket, resumes its durable cursor, and accepts an explicit authority reset', async () => {
  const scene = fixture();
  const owner = new SynchronizationOwner();
  owners.push(owner);
  const first = owner.channel('account-directory', scene.source);
  const second = owner.channel('account-directory', scene.source);
  const stopFirst = first.subscribe(() => {});
  const stopSecond = second.subscribe(() => {});
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(1));
  scene.sockets[0]!.open();
  scene.sockets[0]!.message(JSON.stringify({ type: 'snapshot', resource: 'account-directory', cursor: 8, revision: 8, previous: null, value }));
  await vi.waitFor(() => expect(second.snapshot().cursor).toBe(8));
  stopFirst();
  expect(scene.sockets[0]!.close).not.toHaveBeenCalled();
  vi.useFakeTimers();
  scene.sockets[0]!.end();
  await vi.advanceTimersByTimeAsync(250);
  vi.useRealTimers();
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(2));
  const resumed = scene.sockets[1]!;
  expect(new URL(resumed.url).searchParams.get('after')).toBe('8');
  resumed.open();
  resumed.message(JSON.stringify({ type: 'resync', resource: 'account-directory', cursor: 2, revision: 2, reason: 'cursor-ahead' }));
  resumed.message(JSON.stringify({ type: 'snapshot', resource: 'account-directory', cursor: 2, revision: 2, previous: null, value: { ...value, projectRevisions: { reset: 2 } } }));
  await vi.waitFor(() => expect(second.snapshot()).toMatchObject({ cursor: 2, resync: false, value: { projectRevisions: { reset: 2 } } }));
  stopSecond();
  expect(resumed.close).toHaveBeenCalledOnce();
});

it('only clears a confirmed current device rejection, never a replacement or generic outage', async () => {
  const scene = fixture();
  const fetcher = vi.fn().mockResolvedValue(new Response('Authority unavailable', { status: 401 }));
  vi.stubGlobal('fetch', fetcher);
  const controller = new AbortController();
  controllers.push(controller);
  const first = scene.source(null, controller.signal)[Symbol.asyncIterator]();
  const failed = first.next();
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(1));
  scene.sockets[0]!.end();
  expect(await failed).toMatchObject({ value: { status: 'error' } });
  expect(fetcher).toHaveBeenCalledOnce();
  expect(scene.current()).toBe(device);
  await first.return?.();
  const second = scene.source(null, controller.signal)[Symbol.asyncIterator]();
  const replaced = second.next();
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(2));
  const replacement = { ...device, deviceId: '123e4567-e89b-42d3-a456-426614174002' };
  scene.replace(replacement);
  scene.sockets[1]!.open();
  scene.sockets[1]!.end(4401, 'RPC_DEVICE_UNKNOWN');
  expect(await replaced).toMatchObject({ value: { status: 'error' } });
  expect(scene.current()).toBe(replacement);
  expect(scene.rejected).not.toHaveBeenCalled();
  await second.return?.();
  const third = scene.source(null, controller.signal)[Symbol.asyncIterator]();
  const rejected = third.next();
  await vi.waitFor(() => expect(scene.sockets).toHaveLength(3));
  scene.sockets[2]!.open();
  scene.sockets[2]!.end(4401, 'RPC_DEVICE_UNKNOWN');
  expect(await rejected).toMatchObject({ value: { status: 'error' } });
  expect(scene.current()).toBeNull();
  expect(scene.rejected).toHaveBeenCalledOnce();
  await third.return?.();
});
