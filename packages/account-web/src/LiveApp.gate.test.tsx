// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://example.gitspace.sh/"}
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BROWSER_GRANT_CAPABILITIES, decodeSignedRpcHeader, RPC_DEVICE_HEADER, type DeviceInvite } from '@gitspace/protocol/device-grant';
import { bindDevice, DEVICE_STORAGE_TIMEOUT_MS, generateDeviceKey, loadDevice, type BrowserDevice } from './device.js';

// The account directory socket never opens in these tests: the gate's outcome may not wait for it.
vi.mock('./account-directory-transport.js', () => ({ accountDirectorySource: async function* (): AsyncGenerator<never> { await Promise.withResolvers<void>().promise; } }));

const ORIGIN = 'https://example.gitspace.sh';
let root: Root | null = null;
let container: HTMLDivElement;
/** Every request the page sends; `answer` decides each reply. */
let requests: Request[] = [];
let answer: (request: Request) => Promise<Response> = () => Promise.withResolvers<Response>().promise;

/** A browser that enrolled earlier: its device sits in IndexedDB as enrollment stored it. */
async function enrolled(): Promise<BrowserDevice> {
  const now = Date.now();
  const invite: DeviceInvite = {
    version: 1, userId: `u-${'a'.repeat(32)}`, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' },
    capabilities: [...BROWSER_GRANT_CAPABILITIES], canDelegate: true, issuedAt: now, expiresAt: now + 60_000, grantTtlMs: null, enrollUrl: ORIGIN,
  };
  return bindDevice(await generateDeviceKey(), invite, async () => Response.json({ status: 'ok' }));
}

/** A page load: the app's modules evaluate afresh, holding only what IndexedDB kept. Imported dynamically because each
 * test is a new page load of the same module graph. */
async function load(): Promise<void> {
  vi.resetModules();
  const { LiveApp } = await import('./LiveApp.js');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<LiveApp />); });
}

/** Device ids the page signed requests with. */
const signedBy = () => requests.map((request) => decodeSignedRpcHeader(request.headers.get(RPC_DEVICE_HEADER) ?? '')?.deviceId).filter((id) => id !== undefined);

vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {});
  if (!Element.prototype.getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  Object.defineProperty(navigator, 'credentials', { configurable: true, value: { get: async () => null, create: async () => null } });
  requests = [];
  answer = () => Promise.withResolvers<Response>().promise;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(new URL(input instanceof Request ? input.url : input, ORIGIN), input instanceof Request ? input : init);
    requests.push(request);
    return answer(request);
  }));
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('opens a healthy device’s app without waiting for any reply, and keeps the device', async () => {
  const device = await enrolled();
  await load();
  await vi.waitFor(() => expect(signedBy()).toContain(device.deviceId), { timeout: 10_000 });
  expect(container.textContent).not.toContain('Checking this browser');
  expect(container.textContent).not.toContain('Connect this browser');
  expect((await loadDevice())?.deviceId).toBe(device.deviceId);
});

it('drops a revoked device and shows passkey sign-in within seconds', async () => {
  const device = await enrolled();
  answer = async () => Response.json({ status: 'error', error: { code: 'RPC_DEVICE_UNKNOWN', message: 'Device grant is unknown, expired or revoked' } }, { status: 401 });
  await load();
  await vi.waitFor(() => expect(container.textContent).toContain('This browser’s access ended'), { timeout: 5_000 });
  expect(signedBy()).toContain(device.deviceId);
  expect(container.textContent).toContain('Sign in with a passkey');
  await vi.waitFor(async () => expect(await loadDevice()).toBeNull());
});

it('ends the check with a retry when IndexedDB never answers, and the retry reads it again', async () => {
  const device = await enrolled();
  const working = indexedDB;
  vi.stubGlobal('indexedDB', { open: () => ({}) });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await load();
  expect(container.textContent).toContain('Checking this browser');
  await act(async () => { await vi.advanceTimersByTimeAsync(DEVICE_STORAGE_TIMEOUT_MS); });
  await vi.waitFor(() => expect(container.textContent).toContain('This browser’s storage did not answer'));
  expect(container.textContent).not.toContain('Checking this browser');
  vi.useRealTimers();

  vi.stubGlobal('indexedDB', working);
  const retry = [...container.querySelectorAll('button')].find((button) => button.textContent === 'Try again');
  await act(async () => { retry?.click(); });
  await vi.waitFor(() => expect(signedBy()).toContain(device.deviceId), { timeout: 10_000 });
  expect(container.textContent).not.toContain('Connect this browser');
});
