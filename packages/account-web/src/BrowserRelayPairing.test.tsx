// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BrowserRelayStatus } from '@gitspace/protocol';
import { BrowserRelayWalkthrough } from './SettingsPage.js';
import { rpcClient } from './rpc-client.js';
import { ok } from 'result-rpc';
vi.mock('./rpc-client.js', () => ({ rpcClient: { runtime: { browserTrust: vi.fn() } } }));
let root: Root;
let container: HTMLDivElement;
const relay: BrowserRelayStatus = { machineId: 'authenticated-machine', state: 'waiting', installed: true, pairingCode: 'temporary-code', extensionPath: '/extension', chromeExtensionPath: '/extension', owned: true, endpoint: 'http://127.0.0.1:9224', browserName: null, browserVersion: null, message: null };
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); container = document.createElement('div'); document.body.append(container); root = createRoot(container); vi.clearAllMocks(); });
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
function button(label: string) { const result = [...document.querySelectorAll('button')].find(item => item.textContent === label); if (!result) throw new Error(`Missing ${label}`); return result; }
it('gets the account trust pin only after a human gesture and invalidates JSON when the ephemeral code changes', async () => {
  const trust = { accountId: 'signed-in-account', algorithm: 'Ed25519' as const, publicKey: 'authenticated-cloud-root' };
  vi.mocked(rpcClient.runtime.browserTrust).mockResolvedValue(ok(trust));
  const noop = async () => {};
  await act(() => root.render(<BrowserRelayWalkthrough open onOpenChange={() => {}} relay={relay} onSetup={noop} onStart={noop} onTest={noop} onUnpair={noop} />));
  expect(rpcClient.runtime.browserTrust).not.toHaveBeenCalled();
  await act(() => button('Get pairing JSON').click());
  const json = [...document.querySelectorAll('code')].map(item => item.textContent ?? '').find(text => text.startsWith('{'));
  expect(JSON.parse(json!)).toEqual({ code: 'temporary-code', machineId: 'authenticated-machine', trust });
  await act(() => root.render(<BrowserRelayWalkthrough open onOpenChange={() => {}} relay={{ ...relay, pairingCode: 'replacement-code' }} onSetup={noop} onStart={noop} onTest={noop} onUnpair={noop} />));
  expect(document.body.textContent).not.toContain('authenticated-cloud-root');
  expect([...document.querySelectorAll('button')].some(item => item.textContent === 'Copy pairing JSON')).toBe(false);
});
it('does not offer pairing JSON when authenticated cloud trust is unavailable', async () => {
  vi.mocked(rpcClient.runtime.browserTrust).mockRejectedValue(new Error('Sign in again'));
  const noop = async () => {};
  await act(() => root.render(<BrowserRelayWalkthrough open onOpenChange={() => {}} relay={relay} onSetup={noop} onStart={noop} onTest={noop} onUnpair={noop} />));
  await act(() => button('Get pairing JSON').click());
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Sign in again');
  expect([...document.querySelectorAll('button')].some(item => item.textContent === 'Copy pairing JSON')).toBe(false);
});
it('shows the fingerprint and keeps Forget disabled until completion, surfacing failures', async () => {
  const pending = Promise.withResolvers<void>(); const noop = async () => {};
  const unpair = vi.fn(() => pending.promise);
  await act(() => root.render(<BrowserRelayWalkthrough open onOpenChange={() => {}} relay={{ ...relay, pairingCode: null, pairedKeyFingerprint: 'abc123' }} onSetup={noop} onStart={noop} onTest={noop} onUnpair={unpair} />));
  expect(document.body.textContent).toContain('SHA-256 abc123');
  await act(() => button('Forget paired browser').click());
  expect(button('Forget paired browser').disabled).toBe(true);
  await act(async () => { pending.reject(new Error('Could not remove saved identity')); });
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Could not remove saved identity');
  expect(button('Forget paired browser').disabled).toBe(false);
  expect(unpair).toHaveBeenCalledTimes(1);
});
