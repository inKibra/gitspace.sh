import { useEffect, useState } from 'react';
import type { DecodeResult } from 'result-rpc';
import { z } from 'zod';
import { inferenceCredentialPaths } from '@gitspace/protocol/inference';

/**
 * This browser's saved copy of what the app showed last, so a reload or a workspace switch paints before any request
 * answers. One IndexedDB database per origin, owned by one enrolled user: another owner, sign-out and device
 * revocation erase it. Values are stored in their wire form and decoded with the same codec the RPC client uses, so a
 * copy written by an older bundle that no longer decodes is ignored. Without IndexedDB nothing is saved or read.
 */

/** How a value is stored: an RPC wire codec, or a Zod schema for JSON the app already validates. */
export interface StoredForm<T> {
  encode(value: T): DecodeResult<unknown>;
  decode(value: unknown): DecodeResult<T>;
}

export interface SavedCopy<T> {
  /** The saved value when it is already in memory (the account and the opened workspace are read before first paint). */
  read(): T | undefined;
  /** The saved value, read from IndexedDB when it is not in memory yet. */
  load(): Promise<T | undefined>;
  /** Saves `value` within a second; repeated writes in that second save only the last. */
  write(value: T): void;
}

/** The account's shell: settings, inference profiles, the directory and its status rows. Never evicted. */
export const ACCOUNT_GROUP = 'account';
/** Every saved copy together, at most; least recently opened workspaces are evicted first. */
export const FIRST_PAINT_BUDGET_BYTES = 24 * 1024 * 1024;
/** One saved value, at most; a larger one is not saved. */
const ENTRY_BYTES = 4 * 1024 * 1024;
const WRITE_DELAY_MS = 1000;
const DATABASE = 'gitspace-first-paint';
const ENTRIES = 'entries';
const SIZES = 'sizes';
const GROUPS = 'groups';
const META = 'meta';
const OWNER = 'owner';

const entrySchema = z.object({ key: z.string(), group: z.string(), value: z.unknown() });
const sizeSchema = z.object({ key: z.string(), group: z.string(), bytes: z.number() });
const groupSchema = z.object({ group: z.string(), openedAt: z.number() });
const encoder = new TextEncoder();

let database: Promise<IDBDatabase> | null = null;
let owner: string | null = null;
const memory = new Map<string, unknown>();
const pending = new Map<string, { group: string; encode(): DecodeResult<unknown> }>();
let timer: number | undefined;

export function workspaceGroup(projectId: string, workspaceId: string): string {
  return JSON.stringify([projectId, workspaceId]);
}

export function schemaForm<T>(schema: z.ZodType<T>): StoredForm<T> {
  return {
    encode: (value) => ({ ok: true, value }),
    decode: (value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: [] };
    },
  };
}

function requested<T>(request: IDBRequest<T>): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}

function completed(transaction: IDBTransaction): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error('Saved copy transaction aborted'));
  return promise;
}

function openDatabase(): Promise<IDBDatabase> {
  database ??= (async () => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ENTRIES, { keyPath: 'key' }).createIndex('group', 'group');
      request.result.createObjectStore(SIZES, { keyPath: 'key' });
      request.result.createObjectStore(GROUPS, { keyPath: 'group' });
      request.result.createObjectStore(META);
    };
    return requested(request);
  })().catch((error: unknown) => {
    database = null;
    throw error;
  });
  return database;
}

function erase(db: IDBDatabase): Promise<void> {
  const transaction = db.transaction([ENTRIES, SIZES, GROUPS, META], 'readwrite');
  for (const store of [ENTRIES, SIZES, GROUPS, META]) transaction.objectStore(store).clear();
  return completed(transaction);
}

/**
 * Opens the saved copies of `nextOwner` and reads `groups` into memory. A database owned by anyone else is erased
 * first. Resolves without saved copies when IndexedDB is unavailable or fails.
 */
export async function openFirstPaintCache(nextOwner: string, groups: readonly string[]): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openDatabase();
    const stored = await requested(db.transaction(META).objectStore(META).get(OWNER));
    if (stored !== nextOwner) {
      memory.clear();
      await erase(db);
      const transaction = db.transaction(META, 'readwrite');
      transaction.objectStore(META).put(nextOwner, OWNER);
      await completed(transaction);
    }
    const index = db.transaction(ENTRIES).objectStore(ENTRIES).index('group');
    const rows = await Promise.all(groups.map((group) => requested(index.getAll(group))));
    for (const row of rows.flat()) {
      const entry = entrySchema.safeParse(row);
      if (entry.success) memory.set(entry.data.key, entry.data.value);
    }
    owner = nextOwner;
    // Copies written in the last second before a reload are saved as the page goes.
    window.addEventListener('pagehide', () => { void flushFirstPaintCache(); }, { once: true });
  } catch {
    owner = null;
    memory.clear();
  }
}

/** Erases every saved copy: sign-out and device revocation. */
export async function clearFirstPaintCache(): Promise<void> {
  owner = null;
  memory.clear();
  pending.clear();
  window.clearTimeout(timer);
  timer = undefined;
  if (typeof indexedDB === 'undefined') return;
  try { await erase(await openDatabase()); } catch { /* Nothing was saved where IndexedDB fails. */ }
}

/** Marks `group` as the workspace opened last, so it is evicted last. */
export function touchFirstPaintGroup(group: string): void {
  const current = owner;
  if (current === null) return;
  void openDatabase().then((db) => {
    if (owner !== current) return;
    const transaction = db.transaction(GROUPS, 'readwrite');
    transaction.objectStore(GROUPS).put({ group, openedAt: Date.now() });
    return completed(transaction);
  }).catch(() => undefined);
}

/** Erases one workspace's saved copies: it no longer exists where it was saved. */
export function forgetFirstPaintGroup(group: string): void {
  for (const key of [...pending.keys()]) if (pending.get(key)?.group === group) pending.delete(key);
  const current = owner;
  if (current === null) return;
  void openDatabase().then(async (db) => {
    if (owner !== current) return;
    await deleteGroups(db, [group]);
  }).catch(() => undefined);
}

async function deleteGroups(db: IDBDatabase, groups: readonly string[]): Promise<void> {
  const doomed = new Set(groups);
  const sizes = await requested(db.transaction(SIZES).objectStore(SIZES).getAll());
  const transaction = db.transaction([ENTRIES, SIZES, GROUPS], 'readwrite');
  for (const row of sizes) {
    const size = sizeSchema.safeParse(row);
    if (!size.success || !doomed.has(size.data.group)) continue;
    transaction.objectStore(ENTRIES).delete(size.data.key);
    transaction.objectStore(SIZES).delete(size.data.key);
    memory.delete(size.data.key);
  }
  for (const group of doomed) transaction.objectStore(GROUPS).delete(group);
  await completed(transaction);
}

/** Evicts whole workspaces, least recently opened first, until every saved copy fits the budget. */
async function evict(db: IDBDatabase): Promise<void> {
  const read = db.transaction([SIZES, GROUPS]);
  const [sizeRows, groupRows] = await Promise.all([requested(read.objectStore(SIZES).getAll()), requested(read.objectStore(GROUPS).getAll())]);
  const bytes = new Map<string, number>();
  let total = 0;
  for (const row of sizeRows) {
    const size = sizeSchema.safeParse(row);
    if (!size.success) continue;
    total += size.data.bytes;
    bytes.set(size.data.group, (bytes.get(size.data.group) ?? 0) + size.data.bytes);
  }
  if (total <= FIRST_PAINT_BUDGET_BYTES) return;
  const opened = new Map<string, number>();
  for (const row of groupRows) {
    const group = groupSchema.safeParse(row);
    if (group.success) opened.set(group.data.group, group.data.openedAt);
  }
  const candidates = [...bytes.keys()].filter((group) => group !== ACCOUNT_GROUP).sort((a, b) => (opened.get(a) ?? 0) - (opened.get(b) ?? 0));
  // The workspace opened last stays: it is the one on screen.
  candidates.pop();
  const doomed: string[] = [];
  for (const group of candidates) {
    if (total <= FIRST_PAINT_BUDGET_BYTES) break;
    doomed.push(group);
    total -= bytes.get(group) ?? 0;
  }
  if (doomed.length > 0) await deleteGroups(db, doomed);
}

async function flush(): Promise<void> {
  timer = undefined;
  const current = owner;
  const writes = [...pending];
  pending.clear();
  if (current === null || writes.length === 0) return;
  const rows: { key: string; group: string; value: unknown; bytes: number }[] = [];
  const dropped: string[] = [];
  for (const [key, write] of writes) {
    const encoded = write.encode();
    if (!encoded.ok) { dropped.push(key); continue; }
    let json: string;
    try { json = JSON.stringify(encoded.value); } catch { dropped.push(key); continue; }
    const bytes = encoder.encode(json).byteLength;
    // Credentials are never written to disk; a value carrying one is not saved at all.
    if (bytes > ENTRY_BYTES || inferenceCredentialPaths(encoded.value).length > 0) { dropped.push(key); continue; }
    rows.push({ key, group: write.group, value: encoded.value, bytes });
  }
  try {
    const db = await openDatabase();
    if (owner !== current) return;
    const transaction = db.transaction([ENTRIES, SIZES], 'readwrite');
    for (const row of rows) {
      transaction.objectStore(ENTRIES).put({ key: row.key, group: row.group, value: row.value });
      transaction.objectStore(SIZES).put({ key: row.key, group: row.group, bytes: row.bytes });
      memory.set(row.key, row.value);
    }
    for (const key of dropped) {
      transaction.objectStore(ENTRIES).delete(key);
      transaction.objectStore(SIZES).delete(key);
      memory.delete(key);
    }
    await completed(transaction);
    await evict(db);
  } catch { /* A copy that cannot be saved is read from the server next time. */ }
}

/** Saves pending copies now; tests and page hide. */
export function flushFirstPaintCache(): Promise<void> {
  window.clearTimeout(timer);
  return flush();
}

export function savedCopy<T>(group: string, part: string, form: StoredForm<T>): SavedCopy<T> {
  const key = JSON.stringify([group, part]);
  let decoded: { stored: unknown; value: T | undefined } | null = null;
  const read = (): T | undefined => {
    if (owner === null) return undefined;
    const stored = memory.get(key);
    if (decoded === null || decoded.stored !== stored) {
      const result = stored === undefined ? null : form.decode(stored);
      decoded = { stored, value: result?.ok ? result.value : undefined };
    }
    return decoded.value;
  };
  return {
    read,
    async load() {
      const current = owner;
      if (current === null || memory.has(key)) return read();
      try {
        const db = await openDatabase();
        const entry = entrySchema.safeParse(await requested(db.transaction(ENTRIES).objectStore(ENTRIES).get(key)));
        if (owner === current && entry.success && !memory.has(key)) memory.set(key, entry.data.value);
      } catch { /* Read from the server instead. */ }
      return read();
    },
    write(value) {
      if (owner === null) return;
      pending.set(key, { group, encode: () => form.encode(value) });
      timer ??= window.setTimeout(() => { void flush(); }, WRITE_DELAY_MS);
    },
  };
}

/** `live` once it exists, else this browser's saved copy; every new `live` value is saved. */
export function useSavedCopy<T>(copy: SavedCopy<T> | null, live: T | undefined): T | undefined {
  const [loaded, setLoaded] = useState<{ copy: SavedCopy<T> | null; value: T | undefined }>(() => ({ copy, value: copy?.read() }));
  const saved = loaded.copy === copy ? loaded.value : copy?.read();
  useEffect(() => {
    if (!copy || saved !== undefined) return;
    let active = true;
    void copy.load().then((value) => { if (active && value !== undefined) setLoaded({ copy, value }); });
    return () => { active = false; };
  }, [copy]);
  useEffect(() => { if (copy && live !== undefined) copy.write(live); }, [copy, live]);
  return live ?? saved;
}
