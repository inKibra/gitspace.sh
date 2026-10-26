import { expect, test } from 'bun:test';
import { BROWSER_STORAGE_VALUE_CHARS, browserStorageExpression } from './browser-power-rules.js';

/** A page's localStorage, as the page script reads and changes it. */
class PageStorage {
  private items = new Map<string, string>();
  get length() { return this.items.size; }
  key(index: number) { return [...this.items.keys()][index] ?? null; }
  getItem(key: string) { return this.items.get(key) ?? null; }
  setItem(key: string, value: string) { this.items.set(key, value); }
  removeItem(key: string) { this.items.delete(key); }
  clear() { this.items.clear(); }
}

/** Runs a storage step's page script as `Runtime.evaluate` does, on a page at `href` with `storage` as its localStorage. */
async function evaluate(expression: string, href: string, storage: PageStorage): Promise<unknown> {
  const page = new Function('location', 'localStorage', 'sessionStorage', 'indexedDB', `return ${expression};`);
  return page(new URL(href), storage, new PageStorage(), undefined);
}

test('a storage step reads, sets and clears only the storage of the site its tab shows, values cut for the agent', async () => {
  const storage = new PageStorage();
  storage.setItem('session', 'x'.repeat(BROWSER_STORAGE_VALUE_CHARS + 50));
  storage.setItem('theme', 'dark');
  const read = await evaluate(browserStorageExpression({ op: 'get', kind: 'localStorage', site: 'app.example' }), 'https://app.example/home', storage);
  expect(read).toEqual({ total: 2, entries: [{ key: 'session', value: `${'x'.repeat(BROWSER_STORAGE_VALUE_CHARS)}…` }, { key: 'theme', value: 'dark' }] });
  await evaluate(browserStorageExpression({ op: 'set', kind: 'localStorage', site: 'app.example', name: 'flag', value: 'on' }), 'https://app.example/', storage);
  expect(storage.getItem('flag')).toBe('on');
  await evaluate(browserStorageExpression({ op: 'clear', kind: 'localStorage', site: 'app.example', name: 'theme' }), 'https://app.example/', storage);
  expect([storage.getItem('theme'), storage.length]).toEqual([null, 2]);
  // A tab that moved to another site, or a name that tries to break out of the script, reaches nothing.
  await expect(evaluate(browserStorageExpression({ op: 'clear', kind: 'localStorage', site: 'app.example' }), 'https://evil.example/', storage)).rejects.toThrow('This tab shows evil.example, not app.example');
  await evaluate(browserStorageExpression({ op: 'set', kind: 'localStorage', site: 'app.example', name: '"});localStorage.clear();({"', value: '`${1}`' }), 'https://app.example/', storage);
  expect([storage.length, storage.getItem('"});localStorage.clear();({"')]).toEqual([3, '`${1}`']);
});
