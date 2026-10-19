/**
 * A Durable Object's storage breaker. It counts the rows the object writes and, past a budget, quarantines it: every
 * storage call then fails with `StorageQuarantinedError` until someone resumes it, so a runaway loop stops costing
 * money (on 2026-10-14 one workspace object wrote 360 million rows in an hour). Cloudflare cannot pause one object, so
 * the object pauses itself: its storage is patched in place, once, before any other code holds it.
 */

/** Rows an object may write within `STORAGE_BREAKER_WINDOW_MS` before it quarantines itself. */
export const STORAGE_BREAKER_ROWS = 2_000_000;
export const STORAGE_BREAKER_WINDOW_MS = 10 * 60_000;
const MINUTE_MS = 60_000;
const FLAG_TABLE = '_storage_breaker';

export class StorageQuarantinedError extends Error {
  constructor(readonly reason: string, readonly since: string) {
    super(`Storage quarantined since ${since}: ${reason}. Resume it to continue.`);
    this.name = 'StorageQuarantinedError';
  }
}

export interface StorageBreakerStatus {
  quarantined: boolean;
  reason: string | null;
  since: string | null;
  /** When the last quarantine was lifted, if one was. */
  resumedAt: string | null;
  /** Rows written within the current window. */
  rowsWritten: number;
  limit: number;
  windowMs: number;
}

export interface StorageBreaker {
  status(): StorageBreakerStatus;
  /** Quarantines the object now, as when its budget runs out. */
  quarantine(reason: string): StorageBreakerStatus;
  /** Lifts a quarantine and starts a fresh window. */
  resume(): StorageBreakerStatus;
}

interface BreakerCursor { readonly rowsWritten: number; toArray(): unknown[] }
interface BreakerSql { exec(query: string, ...bindings: unknown[]): BreakerCursor }
/** The parts of `DurableObjectStorage` the breaker counts and blocks. */
export interface BreakerStorage {
  readonly sql: BreakerSql;
  deleteAlarm(): Promise<void>;
}

export interface StorageBreakerOptions {
  limit?: number;
  now?(): number;
  /** Told once when the budget runs out (not for `quarantine`). */
  onTrip?(status: StorageBreakerStatus): void;
  /** While true, a quarantine refuses nothing (calls are still counted). */
  exempt?(): boolean;
}

/** Calls `method` on `target` with `args`; the result stays unknown. */
function call(method: unknown, target: object, args: unknown[]): unknown {
  if (typeof method !== 'function') throw new TypeError('Storage method is missing');
  return Reflect.apply(method, target, args);
}

/** Rows a key-value call writes: one per key. */
function keyRows(args: unknown[]): number {
  const [first] = args;
  if (Array.isArray(first)) return first.length;
  if (typeof first === 'object' && first !== null) return Object.keys(first).length;
  return 1;
}

export function installStorageBreaker(storage: BreakerStorage, options: StorageBreakerOptions = {}): StorageBreaker {
  const limit = options.limit ?? STORAGE_BREAKER_ROWS;
  const windowMs = STORAGE_BREAKER_WINDOW_MS;
  const now = options.now ?? Date.now;
  // A key-value-backed object has no SQL: its quarantine lasts until the object restarts.
  let sql: BreakerSql | null;
  try { sql = storage.sql; } catch { sql = null; }
  const rawExec = sql ? sql.exec.bind(sql) : null;
  // One row: the quarantine (`reason`, `since`) while held, and when the last one was lifted.
  if (rawExec) rawExec(`CREATE TABLE IF NOT EXISTS ${FLAG_TABLE}(singleton INTEGER PRIMARY KEY CHECK(singleton=1), reason TEXT, since TEXT, resumed_at TEXT)`);
  const flag: unknown = rawExec?.(`SELECT reason, since, resumed_at FROM ${FLAG_TABLE}`).toArray()[0];
  const stored = typeof flag === 'object' && flag !== null ? flag : {};
  let held: { reason: string; since: string } | null = 'reason' in stored && 'since' in stored && typeof stored.reason === 'string' && typeof stored.since === 'string'
    ? { reason: stored.reason, since: stored.since } : null;
  let resumedAt = 'resumed_at' in stored && typeof stored.resumed_at === 'string' ? stored.resumed_at : null;
  // Rows written per minute, newest last.
  let minutes: { minute: number; rows: number }[] = [];
  const windowRows = () => {
    const floor = Math.floor((now() - windowMs) / MINUTE_MS);
    minutes = minutes.filter(entry => entry.minute > floor);
    return minutes.reduce((sum, entry) => sum + entry.rows, 0);
  };
  const status = (): StorageBreakerStatus => ({ quarantined: held !== null, reason: held?.reason ?? null, since: held?.since ?? null, resumedAt, rowsWritten: windowRows(), limit, windowMs });
  const enter = (reason: string) => {
    held = { reason, since: new Date(now()).toISOString() };
    const entered = held;
    // Written after the call that tripped returns: inside a transaction that call's failure would roll it back.
    setTimeout(() => {
      if (held !== entered) return;
      rawExec?.(`INSERT OR REPLACE INTO ${FLAG_TABLE} VALUES(1, ?, ?, ?)`, entered.reason, entered.since, resumedAt);
      void rawDeleteAlarm().catch(() => {});
    }, 0);
  };
  const guard = () => { if (held && !options.exempt?.()) throw new StorageQuarantinedError(held.reason, held.since); };
  const count = (rows: number) => {
    if (rows <= 0) return;
    const minute = Math.floor(now() / MINUTE_MS);
    const last = minutes.at(-1);
    if (last?.minute === minute) last.rows += rows; else minutes.push({ minute, rows });
    const written = windowRows();
    if (written <= limit) return;
    enter(`wrote ${written.toLocaleString('en-US')} rows within ${windowMs / MINUTE_MS} minutes (limit ${limit.toLocaleString('en-US')})`);
    options.onTrip?.(status());
  };
  if (sql && rawExec) {
    const exec = rawExec;
    Object.defineProperty(sql, 'exec', {
      configurable: true, writable: true,
      value: (query: string, ...bindings: unknown[]) => {
        guard();
        const cursor = exec(query, ...bindings);
        count(cursor.rowsWritten);
        return cursor;
      },
    });
  }
  // Key-value calls write a row per key; reads are blocked too while quarantined. A transaction's own `tx` object
  // gets the same treatment.
  const patchKeyValue = (target: object) => {
    for (const name of ['put', 'delete', 'deleteAll', 'setAlarm', 'deleteAlarm']) {
      const method: unknown = Reflect.get(target, name);
      if (typeof method !== 'function') continue;
      Object.defineProperty(target, name, {
        configurable: true, writable: true,
        value: (...args: unknown[]) => { guard(); const result = call(method, target, args); count(name === 'put' || name === 'delete' ? keyRows(args) : 1); return result; },
      });
    }
    for (const name of ['get', 'list', 'getAlarm']) {
      const method: unknown = Reflect.get(target, name);
      if (typeof method !== 'function') continue;
      Object.defineProperty(target, name, { configurable: true, writable: true, value: (...args: unknown[]) => { guard(); return call(method, target, args); } });
    }
  };
  // The breaker lifts its own alarm with the unpatched method.
  const rawDeleteAlarm = storage.deleteAlarm.bind(storage);
  patchKeyValue(storage);
  const transaction: unknown = Reflect.get(storage, 'transaction');
  if (typeof transaction === 'function') {
    Object.defineProperty(storage, 'transaction', {
      configurable: true, writable: true,
      value: (closure: (tx: object) => unknown) => {
        guard();
        return call(transaction, storage, [(tx: object) => { patchKeyValue(tx); return closure(tx); }]);
      },
    });
  }
  const transactionSync: unknown = Reflect.get(storage, 'transactionSync');
  if (typeof transactionSync === 'function') {
    Object.defineProperty(storage, 'transactionSync', { configurable: true, writable: true, value: (closure: () => unknown) => { guard(); return call(transactionSync, storage, [closure]); } });
  }
  return {
    status,
    quarantine(reason) {
      if (!held) enter(reason);
      return status();
    },
    resume() {
      held = null;
      minutes = [];
      resumedAt = new Date(now()).toISOString();
      rawExec?.(`INSERT OR REPLACE INTO ${FLAG_TABLE} VALUES(1, NULL, NULL, ?)`, resumedAt);
      return status();
    },
  };
}

/** The parts of `DurableObjectState` `installDurableObjectBreaker` needs. */
export interface BreakerState {
  readonly storage: BreakerStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
}

/**
 * Installs the breaker on a Durable Object's storage from its constructor, before the class's own code runs. Its
 * construction (the constructor and any `blockConcurrencyWhile` it starts) is never refused: a quarantined object must
 * still start, or it could not be resumed.
 */
export function installDurableObjectBreaker(state: BreakerState, options: Omit<StorageBreakerOptions, 'exempt'> = {}): StorageBreaker {
  let constructing = true;
  let starting = 0;
  const blockConcurrencyWhile = state.blockConcurrencyWhile.bind(state);
  Object.defineProperty(state, 'blockConcurrencyWhile', {
    configurable: true, writable: true,
    value: <T>(callback: () => Promise<T>): Promise<T> => {
      if (!constructing) return blockConcurrencyWhile(callback);
      starting += 1;
      return blockConcurrencyWhile(async () => { try { return await callback(); } finally { starting -= 1; } });
    },
  });
  queueMicrotask(() => { constructing = false; });
  return installStorageBreaker(state.storage, { ...options, exempt: () => constructing || starting > 0 });
}
