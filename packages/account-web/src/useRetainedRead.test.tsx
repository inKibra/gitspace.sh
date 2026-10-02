// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRetainedRead, type ReadProvenance } from './useRetainedRead.js';

type Value = { name: string };
type Query = { state: 'pending' } | { state: 'success'; value: Value; fetch?: 'fetching' | 'idle' } | { state: 'failure'; error: Error; previous?: Value };
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function View({ query, identity, provenance }: { query: Query; identity: string | null; provenance?: ReadProvenance }) {
  const read = useRetainedRead(query, identity, provenance);
  return <>{read.value ? <section aria-label="Known panel"><strong>{read.value.name}</strong><input defaultValue="Keep my draft" /></section> : <p>No accepted data</p>}{read.initialLoading ? <p>Initial loading</p> : null}{read.refreshing ? <p>Refreshing</p> : null}{read.stale ? <p>Stale</p> : null}{read.error ? <p role="alert">{read.error.message}</p> : null}</>;
}
it('keeps the mounted panel and draft during background loading and failure, then accepts recovery', async () => {
  const first = { name: 'Known machine' };
  await act(() => root.render(<View identity="account-a" query={{ state: 'success', value: first }} />));
  const panel = container.querySelector('section');
  const input = container.querySelector('input')!;
  input.value = 'Unsaved change';
  await act(() => root.render(<View identity="account-a" query={{ state: 'pending' }} />));
  expect(container.querySelector('section')).toBe(panel);
  expect(container.textContent).toContain('Refreshing');
  expect(container.textContent).not.toContain('Initial loading');
  await act(() => root.render(<View identity="account-a" query={{ state: 'failure', error: new Error('Connection interrupted') }} />));
  expect(container.querySelector('section')).toBe(panel);
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Connection interrupted');
  expect(container.textContent).toContain('Stale');
  expect(input.value).toBe('Unsaved change');
  await act(() => root.render(<View identity="account-a" query={{ state: 'success', value: { name: 'Updated machine' } }} />));
  expect(container.querySelector('section')).toBe(panel);
  expect(container.textContent).toContain('Updated machine');
  expect(container.querySelector('[role=alert]')).toBeNull();
});
it('revokes old data on identity changes and authorization failure without letting previous data revive it', async () => {
  const first = { name: 'Private workspace' };
  await act(() => root.render(<View identity="lease-a" query={{ state: 'success', value: first }} />));
  await act(() => root.render(<View identity="lease-b" query={{ state: 'pending' }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity="lease-b" query={{ state: 'success', value: { name: 'New workspace' } }} />));
  await act(() => root.render(<View identity="lease-b" query={{ state: 'failure', error: new Error('Forbidden: access revoked'), previous: first }} />));
  expect(container.querySelector('section')).toBeNull();
  expect(container.querySelector('[role=alert]')?.textContent).toContain('Forbidden');
  await act(() => root.render(<View identity="lease-b" query={{ state: 'pending' }} />));
  expect(container.querySelector('section')).toBeNull();
});

it('accepts a matching cached result when first enabled and after an unchanged refetch', async () => {
  const cached = { name: 'Default catalog' };
  const provenance = { key: 'providers:default', updatedAt: 10 };
  await act(() => root.render(<View identity={null} provenance={provenance} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity={provenance.key} provenance={provenance} query={{ state: 'success', value: cached, fetch: 'fetching' }} />));
  expect(container.querySelector('strong')?.textContent).toBe(cached.name);
  await act(() => root.render(<View identity={provenance.key} provenance={{ ...provenance, updatedAt: 20 }} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('strong')?.textContent).toBe(cached.name);
});

it('isolates query identities without rejecting the cached catalog when returning to a profile', async () => {
  const first = { name: 'Private profile catalog' };
  const second = { name: 'Other profile catalog' };
  await act(() => root.render(<View identity="profile-a" provenance={{ key: 'profile-a', updatedAt: 10 }} query={{ state: 'success', value: first }} />));
  await act(() => root.render(<View identity="profile-b" provenance={{ key: 'profile-a', updatedAt: 10 }} query={{ state: 'success', value: first }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity="profile-b" provenance={{ key: 'profile-b', updatedAt: 5 }} query={{ state: 'success', value: second }} />));
  expect(container.querySelector('strong')?.textContent).toBe(second.name);
  await act(() => root.render(<View identity="profile-a" provenance={{ key: 'profile-a', updatedAt: 10 }} query={{ state: 'success', value: first }} />));
  expect(container.querySelector('strong')?.textContent).toBe(first.name);
});

it('requires a newer successful read after null or authorization revocation, even across profiles', async () => {
  const cached = { name: 'Private catalog' };
  const provenance = { key: 'profile-a', updatedAt: 10 };
  await act(() => root.render(<View identity={provenance.key} provenance={provenance} query={{ state: 'success', value: cached }} />));
  await act(() => root.render(<View identity={null} provenance={provenance} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity={provenance.key} provenance={provenance} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  const refreshed = { ...provenance, updatedAt: 20 };
  await act(() => root.render(<View identity={provenance.key} provenance={refreshed} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('strong')?.textContent).toBe(cached.name);
  await act(() => root.render(<View identity={provenance.key} provenance={refreshed} query={{ state: 'failure', error: new Error('Forbidden'), previous: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity="profile-b" provenance={{ key: 'profile-b', updatedAt: 30 }} query={{ state: 'success', value: { name: 'Other catalog' } }} />));
  await act(() => root.render(<View identity={provenance.key} provenance={refreshed} query={{ state: 'failure', error: new Error('Connection interrupted'), previous: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity={provenance.key} provenance={refreshed} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity={provenance.key} provenance={{ ...provenance, updatedAt: 40 }} query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('strong')?.textContent).toBe(cached.name);
});

it('does not treat a generic lease key as proof that a fixed query result belongs to the new lease', async () => {
  const cached = { name: 'Previous owner workspace' };
  await act(() => root.render(<View identity="lease-a" query={{ state: 'success', value: cached }} />));
  await act(() => root.render(<View identity="lease-b" query={{ state: 'success', value: cached }} />));
  expect(container.querySelector('section')).toBeNull();
  await act(() => root.render(<View identity="lease-b" query={{ state: 'failure', error: new Error('Connection interrupted'), previous: cached }} />));
  expect(container.querySelector('section')).toBeNull();
});
