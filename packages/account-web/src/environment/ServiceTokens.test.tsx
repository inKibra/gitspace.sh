// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ServiceTokensViewSchema } from '@gitspace/protocol-environment';
import { ServiceTokens } from './ServiceTokens.js';

const rpc = vi.hoisted(() => ({ mint: vi.fn(), rotate: vi.fn(), revoke: vi.fn(), refetch: vi.fn(), view: { current: undefined as unknown } }));
vi.mock('../rpc-client.js', () => ({
  rpcClient: { environment: { serviceTokens: 'serviceTokens', mintServiceToken: rpc.mint, rotateServiceTokenKey: rpc.rotate, revokeServiceToken: rpc.revoke } },
}));
vi.mock('result-rpc/react', () => ({
  useResultQuery: () => rpc.view.current ? { state: 'success', value: rpc.view.current, fetch: 'idle', refetch: rpc.refetch } : { state: 'pending', fetch: 'idle', refetch: rpc.refetch },
}));

const url = 'https://api--workspace--test-srv.gssh.dev';
const view = ServiceTokensViewSchema.parse({
  service: 'api',
  urls: [{ port: 'http', url }],
  keys: [
    { fingerprint: 'olderkeyfingerprint0000000000000000000000000', createdAt: '2026-11-01T09:00:00.000Z', signsUntil: '2026-11-08T09:00:00.000Z', verifiesUntil: '2026-11-08T17:00:00.000Z' },
    { fingerprint: 'newerkeyfingerprint1111111111111111111111111', createdAt: '2026-11-08T09:00:00.000Z', signsUntil: '2026-11-15T09:00:00.000Z', verifiesUntil: '2026-11-15T17:00:00.000Z' },
  ],
  tokens: [
    { id: 'tok-1', url, subject: 'ios-dev/brad', issuedAt: '2026-11-13T08:00:00.000Z', expiresAt: '2026-11-13T16:00:00.000Z', lastUsedAt: null, revokedAt: null, refreshable: true },
    { id: 'tok-2', url, subject: 'ci/nightly', issuedAt: '2026-11-13T07:00:00.000Z', expiresAt: '2026-11-13T15:00:00.000Z', lastUsedAt: '2026-11-13T07:30:00.000Z', revokedAt: '2026-11-13T07:45:00.000Z', refreshable: false },
  ],
});
const grant = { service: 'api', port: 'http', url, subject: 'ios-dev/brad', header: 'GitSpace-Ingress', token: 'eyJhbGciOiJFUzI1NiJ9.minted.signature', expiresAt: '2026-11-13T13:00:00.000Z', refreshToken: 'refresh-secret', refreshExpiresAt: '2026-11-20T09:00:00.000Z', refreshUrl: `${url}/__gitspace/token` };

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  for (const mock of [rpc.mint, rpc.rotate, rpc.revoke, rpc.refetch]) mock.mockReset();
  rpc.refetch.mockResolvedValue(undefined);
  rpc.view.current = view;
  await act(async () => root.render(<ServiceTokens spaceId="workspace" service="api" />));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(item => item.textContent === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
}
const click = (label: string, scope?: ParentNode) => act(async () => button(label, scope).click());
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

it('shows the workspace URL, the current key with its signing expiry and the earlier key with its verify expiry, and issued tokens', () => {
  expect(container.querySelector('[aria-label="Workspace URLs"]')?.textContent).toContain(url);
  const newer = container.querySelector('[aria-label="Key newerkeyfingerprint1111111111111111111111111"]')!;
  expect(newer.querySelector('code')?.getAttribute('title')).toBe('newerkeyfingerprint1111111111111111111111111');
  expect(newer.querySelector('code')?.textContent).toBe('newerkeyfing…');
  expect(newer.textContent).toContain(`signs until ${new Date('2026-11-15T09:00:00.000Z').toLocaleString()}`);
  const older = container.querySelector('[aria-label="Key olderkeyfingerprint0000000000000000000000000"]')!;
  expect(older.textContent).toContain(`verifies its tokens until ${new Date('2026-11-08T17:00:00.000Z').toLocaleString()}`);
  const keys = [...container.querySelectorAll('[aria-label="Managed keys"] li')].map(item => item.getAttribute('aria-label'));
  expect(keys).toEqual(['Key newerkeyfingerprint1111111111111111111111111', 'Key olderkeyfingerprint0000000000000000000000000']);
  const active = container.querySelector('[aria-label="Token ios-dev/brad"]')!;
  expect(active.textContent).toContain('Never used');
  expect(active.textContent).not.toContain('Revoked');
  const revoked = container.querySelector('[aria-label="Token ci/nightly"]')!;
  expect(revoked.textContent).toContain('Revoked');
  expect(revoked.textContent).toContain(`last used ${new Date('2026-11-13T07:30:00.000Z').toLocaleString()}`);
  expect(revoked.querySelector('button')).toBeNull();
});

it('copies an app token with the chosen subject, lifetime and refresh token, shows it once with a QR code, and discards it on close', async () => {
  rpc.mint.mockResolvedValue({ status: 'ok', value: grant });
  await click('Copy app token', container);
  const subject = dialog()!.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(subject, 'has space'); subject.dispatchEvent(new Event('input', { bubbles: true })); });
  expect(button('Copy app token', dialog()!).disabled).toBe(true);
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(subject, 'ios-dev/brad'); subject.dispatchEvent(new Event('input', { bubbles: true })); });
  const lifetime = dialog()!.querySelector<HTMLSelectElement>('select[aria-label="Lifetime"]')!;
  expect(lifetime.value).toBe('28800');
  await act(async () => { lifetime.value = '3600'; lifetime.dispatchEvent(new Event('change', { bubbles: true })); });
  await act(async () => dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click());
  await click('Copy app token', dialog()!);
  expect(rpc.mint).toHaveBeenCalledWith({ spaceId: 'workspace', service: 'api', port: 'http', subject: 'ios-dev/brad', ttlSeconds: 3600, refresh: true });
  expect(rpc.refetch).toHaveBeenCalled();
  const shown = dialog()!.querySelector('[aria-label="App token"]')!;
  expect(shown.textContent).toContain(grant.token);
  expect(shown.textContent).toContain('refresh-secret');
  expect(shown.textContent).toContain(grant.refreshUrl);
  expect(shown.textContent).toContain('GitSpace-Ingress');
  expect(shown.querySelector('svg title')?.textContent).toBe('Scan to load this app token on a phone');
  expect(shown.querySelector('svg path')).not.toBeNull();
  await click('Done', dialog()!);
  expect(document.body.textContent).not.toContain(grant.token);
  await click('Copy app token', container);
  expect(dialog()!.textContent).not.toContain(grant.token);
  expect(dialog()!.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!.value).toBe('');
});

it('rotates the key only after the confirmation that earlier keys stop', async () => {
  rpc.rotate.mockResolvedValue({ status: 'ok', value: view });
  await click('Rotate now', container);
  expect(rpc.rotate).not.toHaveBeenCalled();
  expect(dialog()!.textContent).toContain('ends every token signed by earlier keys');
  await click('Rotate key', dialog()!);
  expect(rpc.rotate).toHaveBeenCalledWith({ spaceId: 'workspace', service: 'api' });
  expect(rpc.refetch).toHaveBeenCalled();
});

it('revokes an issued token by its URL and id, and shows a failure', async () => {
  rpc.revoke.mockResolvedValue({ status: 'error', error: new Error('Token store unavailable') });
  await click('Revoke', container.querySelector('[aria-label="Token ios-dev/brad"]')!);
  expect(rpc.revoke).toHaveBeenCalledWith({ spaceId: 'workspace', service: 'api', url, tokenId: 'tok-1' });
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Token store unavailable');
});
