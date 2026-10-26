// Import-free: the Chrome extension bundles this file, and checks each DevTools command of a debug or storage step on
// your Chrome against exactly what these build. `browser-powers.ts` re-exports it for everyone else.

/** The powers a project can give agents on one of your Chromes (`browser-powers.ts`). */
export const BROWSER_POWERS = ['record', 'debug', 'storage'] as const;
/** Everything lasts this long from when you allow it. */
export const BROWSER_EVERYTHING_MS = 60 * 60_000;

type PowerGrant = { powers?: readonly string[]; everything?: { expiresAt: string } };
/** Whether Everything is on in a grant at `now`: until its signed expiry. */
export function browserEverythingActive(grant: PowerGrant, now: number): boolean {
  return grant.everything !== undefined && Date.parse(grant.everything.expiresAt) > now;
}
/** Whether a grant allows `power` at `now`: it carries the power, or Everything is on. */
export function browserGrantPower(grant: PowerGrant, power: (typeof BROWSER_POWERS)[number], now: number): boolean {
  return (grant.powers ?? []).includes(power) || browserEverythingActive(grant, now);
}
/** `Everything · 52 min left` until `expiresAt`, rounded up to the minute. */
export function browserEverythingLabel(expiresAt: string, now: number): string {
  return `Everything · ${Math.max(1, Math.ceil((Date.parse(expiresAt) - now) / 60_000))} min left`;
}
/** A page a tab may show or load while Everything is on: about:blank or any http(s) page. Every other scheme reaches
 * Chrome's own pages, other extensions (this one too) or your disk, which Everything never opens. */
export function browserEverythingDestination(url: string | undefined): boolean {
  if (url === 'about:blank') return true;
  const parsed = url ? URL.parse(url) : null;
  return parsed !== null && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
}

// Debug steps record through the Tracing domain, the one profiler Chrome opens to extensions: CPU samples come as the
// trace's `ProfileChunk` events. The trace streams back through `IO.read`.

const CPU_CATEGORIES = ['disabled-by-default-v8.cpu_profiler', 'v8.execute', 'toplevel', 'disabled-by-default-devtools.timeline'];
const TIMELINE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame', 'toplevel', 'v8.execute', 'blink.user_timing', 'loading', 'latencyInfo', 'disabled-by-default-v8.cpu_profiler'];
/** `Tracing.start`'s parameters for a CPU profile or a performance trace. */
export function browserTraceStart(kind: 'profile' | 'trace') {
  return { transferMode: 'ReturnAsStream', streamFormat: 'json', traceConfig: { recordMode: 'recordAsMuchAsPossible', includedCategories: kind === 'profile' ? CPU_CATEGORIES : TIMELINE_CATEGORIES } };
}
/** Each `IO.read` of a trace stream asks for this many bytes. */
export const BROWSER_TRACE_READ_BYTES = 1024 * 1024;

// Storage steps: cookies through the Network domain, by the site's URL; a page's storage through a page script on a
// tab showing that site.

/** Each value the agent reads is cut to this many characters, and a read lists at most this many entries. */
export const BROWSER_STORAGE_VALUE_CHARS = 1000;
export const BROWSER_STORAGE_ENTRIES = 200;
/** The URL a site's cookies are set and deleted by (`Network.setCookie`, `Network.deleteCookies`). */
export function browserCookieUrl(site: string): string { return `https://${site}/`; }
/** `Network.getCookies`' parameters: the site's cookies over https and http. */
export function browserCookieRead(site: string) { return { urls: [`https://${site}/`, `http://${site}/`] }; }

type StorageStep = { op: 'get' | 'set' | 'clear'; kind: 'cookies' | 'localStorage' | 'sessionStorage' | 'indexedDB'; site: string; name?: string; store?: string; key?: string; value?: string };
/** The page script a localStorage, sessionStorage or IndexedDB step runs (`Runtime.evaluate` with `returnByValue` and
 * `awaitPromise`) on a tab showing `site`; it refuses any other page. Its answer is JSON, values cut in the page. */
const STORAGE_FUNCTION = `async function(step, limits) {
  const cut = value => { let text; try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); } text = text === undefined ? String(value) : text; return text.length > limits.chars ? text.slice(0, limits.chars) + '…' : text; };
  if (location.hostname !== step.site) throw new Error('This tab shows ' + (location.hostname || location.href) + ', not ' + step.site + ': a site\\'s storage is reached through a tab showing it');
  if (step.kind === 'localStorage' || step.kind === 'sessionStorage') {
    const storage = step.kind === 'localStorage' ? localStorage : sessionStorage;
    if (step.op === 'get') {
      const keys = step.name !== undefined ? [step.name] : Array.from({ length: storage.length }, (_, index) => storage.key(index));
      return { total: storage.length, entries: keys.filter(key => key !== null && storage.getItem(key) !== null).slice(0, limits.entries).map(key => ({ key, value: cut(storage.getItem(key)) })) };
    }
    if (step.op === 'set') { if (step.name === undefined || step.value === undefined) throw new Error('set takes a name and a value'); storage.setItem(step.name, step.value); return { set: step.name }; }
    if (step.name !== undefined) { storage.removeItem(step.name); return { cleared: [step.name] }; }
    const count = storage.length; storage.clear(); return { cleared: count };
  }
  const settle = request => { const settled = Promise.withResolvers(); request.onsuccess = () => settled.resolve(request.result); request.onerror = () => settled.reject(request.error); return settled.promise; };
  const open = name => { const opened = Promise.withResolvers(), request = indexedDB.open(name); request.onsuccess = () => opened.resolve(request.result); request.onerror = () => opened.reject(request.error); request.onupgradeneeded = () => { request.transaction.abort(); opened.reject(new Error('No IndexedDB database ' + name + ' on ' + step.site)); }; return opened.promise; };
  const names = step.name !== undefined ? [step.name] : (await indexedDB.databases()).map(database => database.name).filter(name => typeof name === 'string');
  if (step.op === 'get') {
    const databases = [];
    for (const name of names.slice(0, 20)) {
      const database = await open(name);
      try {
        const stores = [];
        for (const storeName of Array.from(database.objectStoreNames).filter(storeName => step.store === undefined || storeName === step.store)) {
          const store = database.transaction(storeName, 'readonly').objectStore(storeName);
          const count = await settle(store.count());
          const records = [], wanted = step.store === undefined ? 5 : limits.entries;
          const read = Promise.withResolvers(), cursor = store.openCursor();
          cursor.onsuccess = () => { const current = cursor.result; if (!current || records.length >= wanted) { read.resolve(); return; } records.push({ key: cut(current.key), value: cut(current.value) }); current.continue(); };
          cursor.onerror = () => read.reject(cursor.error);
          await read.promise;
          stores.push({ name: storeName, keyPath: store.keyPath, count, records });
        }
        databases.push({ name, version: database.version, stores });
      } finally { database.close(); }
    }
    return { databases };
  }
  if (step.op === 'set') {
    if (step.name === undefined || step.store === undefined || step.value === undefined) throw new Error('IndexedDB set takes a name (the database), a store and a value');
    const parse = text => { try { return JSON.parse(text); } catch { return text; } };
    const database = await open(step.name);
    try {
      const transaction = database.transaction(step.store, 'readwrite'), store = transaction.objectStore(step.store);
      const done = Promise.withResolvers();
      transaction.oncomplete = done.resolve; transaction.onerror = () => done.reject(transaction.error); transaction.onabort = () => done.reject(transaction.error);
      const key = await settle(store.keyPath === null ? store.put(parse(step.value), step.key === undefined ? undefined : parse(step.key)) : store.put(parse(step.value)));
      await done.promise;
      return { set: cut(key) };
    } finally { database.close(); }
  }
  if (step.store !== undefined) {
    if (step.name === undefined) throw new Error('Clearing an object store takes its database as name');
    const database = await open(step.name);
    try { await settle(database.transaction(step.store, 'readwrite').objectStore(step.store).clear()); return { cleared: [step.name + '/' + step.store] }; }
    finally { database.close(); }
  }
  for (const name of names) await settle(indexedDB.deleteDatabase(name));
  return { cleared: names };
}`;
/** `Runtime.evaluate`'s expression for a localStorage, sessionStorage or IndexedDB step. */
export function browserStorageExpression(step: StorageStep): string {
  const fields = { op: step.op, kind: step.kind, site: step.site, name: step.name, store: step.store, key: step.key, value: step.value };
  return `(${STORAGE_FUNCTION})(${JSON.stringify(fields)}, ${JSON.stringify({ chars: BROWSER_STORAGE_VALUE_CHARS, entries: BROWSER_STORAGE_ENTRIES })})`;
}
