// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRetainedRead } from './useRetainedRead.js';

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
function View({ query, identity }: { query: Query; identity: string | null }) {
  const read = useRetainedRead(query, identity);
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
