// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type * as FirstPaintCache from './first-paint-cache.js';

const text = z.object({ text: z.string() });

/** A page load: module state starts empty, IndexedDB keeps what earlier pages saved. Imported dynamically because the
 * test is the module boundary: each load must evaluate the module afresh. */
async function reload(): Promise<typeof FirstPaintCache> {
  vi.resetModules();
  return import('./first-paint-cache.js');
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('reads a saved copy back on the next page load before anything is requested', async () => {
  let cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).write({ text: 'saved settings' });
  await cache.flushFirstPaintCache();

  cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  expect(cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).read()).toEqual({ text: 'saved settings' });
});

it('never shows one account’s saved copies to another account or user', async () => {
  let cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).write({ text: 'private to a' });
  await cache.flushFirstPaintCache();

  cache = await reload();
  await cache.openFirstPaintCache('account-b', [cache.ACCOUNT_GROUP]);
  const copy = cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text));
  expect(copy.read()).toBeUndefined();
  expect(await copy.load()).toBeUndefined();

  // Opening as someone else erased it: the first owner does not get it back either.
  cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  expect(cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).read()).toBeUndefined();
});

it('erases every saved copy when this browser signs out or its device is revoked', async () => {
  let cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP, cache.workspaceGroup('project', 'workspace')]);
  cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).write({ text: 'settings' });
  cache.savedCopy(cache.workspaceGroup('project', 'workspace'), 'transcript', cache.schemaForm(text)).write({ text: 'rows' });
  await cache.flushFirstPaintCache();
  // The sign-out path of this page load, sharing its freshly evaluated cache module.
  const { deviceRejected } = await import('./device-session.js');
  const listener = vi.fn();
  window.addEventListener('gitspace:device-rejected', listener);
  deviceRejected('SIGNED_OUT');
  window.removeEventListener('gitspace:device-rejected', listener);
  expect(listener).toHaveBeenCalledOnce();
  // Nothing saved is shown after sign-out, even before the erase reaches IndexedDB.
  expect(cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).read()).toBeUndefined();

  await vi.waitFor(async () => {
    cache = await reload();
    await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP, cache.workspaceGroup('project', 'workspace')]);
    expect(cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text)).read()).toBeUndefined();
    expect(cache.savedCopy(cache.workspaceGroup('project', 'workspace'), 'transcript', cache.schemaForm(text)).read()).toBeUndefined();
  });
});

it('evicts the least recently opened workspaces once saved copies pass the byte budget', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  let cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  const large = 'x'.repeat(3_700_000);
  const groups = Array.from({ length: 7 }, (_, index) => cache.workspaceGroup('project', `workspace-${index}`));
  for (const [index, group] of groups.entries()) {
    vi.setSystemTime(1_000 + index);
    cache.touchFirstPaintGroup(group);
    cache.savedCopy(group, 'transcript', cache.schemaForm(text)).write({ text: large });
  }
  await cache.flushFirstPaintCache();
  expect(7 * large.length).toBeGreaterThan(cache.FIRST_PAINT_BUDGET_BYTES);

  cache = await reload();
  await cache.openFirstPaintCache('account-a', groups);
  const kept = groups.map((group) => cache.savedCopy(group, 'transcript', cache.schemaForm(text)).read() !== undefined);
  expect(kept).toEqual([false, true, true, true, true, true, true]);
});

it('never writes a value that carries a credential', async () => {
  let cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  const credential = cache.schemaForm(z.object({ provider: z.string(), apiKey: z.string() }));
  cache.savedCopy(cache.ACCOUNT_GROUP, 'inference', credential).write({ provider: 'openai', apiKey: 'sk-live-secret' });
  await cache.flushFirstPaintCache();

  cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  expect(cache.savedCopy(cache.ACCOUNT_GROUP, 'inference', credential).read()).toBeUndefined();
});

it('runs without IndexedDB: nothing is saved and nothing fails', async () => {
  vi.stubGlobal('indexedDB', undefined);
  const cache = await reload();
  await cache.openFirstPaintCache('account-a', [cache.ACCOUNT_GROUP]);
  const copy = cache.savedCopy(cache.ACCOUNT_GROUP, 'settings', cache.schemaForm(text));
  copy.write({ text: 'not saved' });
  await cache.flushFirstPaintCache();
  expect(copy.read()).toBeUndefined();
  expect(await copy.load()).toBeUndefined();
});
