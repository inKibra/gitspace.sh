import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Rows and bytes the runtime's SQLite adapter returns, by what asked for them. Every value a query returns is built in
 * the object's heap until its reader lets go, so these are the transient allocations of reading storage, which the
 * resident estimate (memory-estimate.ts) cannot see. A string counts its characters (as that estimate does), a blob
 * its bytes, any other value 8.
 *
 * A read made while `within(scope, …)` runs, or in any work it awaits, counts under that scope; every other read
 * (pi's own: a turn's context, its task and document reads) counts as `other`. Reads the runtime makes on the
 * object's SQL directly, past this adapter, are not counted.
 */
export type StorageReadScope = 'rebuild' | 'transcript';
export type StorageReadTally = { queries: number; rows: number; bytes: number };
/** Reads since the last `take`, by scope, and the most bytes one query returned. */
export type StorageReadLoad = Record<StorageReadScope | 'other', StorageReadTally> & { largestBytes: number };
export type StorageReads = {
  record(rows: readonly Record<string, unknown>[]): void;
  within<T>(scope: StorageReadScope, operation: () => Promise<T>): Promise<T>;
  take(): StorageReadLoad;
};

const VALUE_BYTES = 8;

function emptyLoad(): StorageReadLoad {
  return { rebuild: { queries: 0, rows: 0, bytes: 0 }, transcript: { queries: 0, rows: 0, bytes: 0 }, other: { queries: 0, rows: 0, bytes: 0 }, largestBytes: 0 };
}

export function createStorageReads(): StorageReads {
  const scopes = new AsyncLocalStorage<StorageReadScope>();
  let load = emptyLoad();
  return {
    record(rows) {
      let bytes = 0;
      for (const row of rows) for (const value of Object.values(row)) {
        if (typeof value === 'string') bytes += value.length;
        else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) bytes += value.byteLength;
        else if (value !== null) bytes += VALUE_BYTES;
      }
      const tally = load[scopes.getStore() ?? 'other'];
      tally.queries++;
      tally.rows += rows.length;
      tally.bytes += bytes;
      if (bytes > load.largestBytes) load.largestBytes = bytes;
    },
    within: (scope, operation) => scopes.run(scope, operation),
    take() {
      const taken = load;
      load = emptyLoad();
      return taken;
    },
  };
}
