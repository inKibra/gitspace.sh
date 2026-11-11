import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';
import type { StorageReads } from './storage-reads.js';

/** Queue the portable asynchronous driver over DO transactions; never serialize a memory database. Every row a read
 * returns is counted in `reads`. */
export class DurableObjectSqliteDatabase implements SqliteDatabase {
  private line: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly storage: DurableObjectStorage, private readonly reads: StorageReads) {}
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.line.then(() => { if (this.closed) throw new Error('SQLite driver is closed'); return operation(); });
    this.line = result.then(() => {}, () => {});
    return result;
  }
  private executor(storage: DurableObjectStorage): SqliteExecutor & { end(): void } {
    let active = true;
    const bindings = (params: SqliteValue[]) => params.map(value => {
      if (typeof value === 'bigint') { const number = Number(value); if (!Number.isSafeInteger(number)) throw new RangeError('SQLite integer exceeds safe range'); return number; }
      return value;
    });
    const check = () => { if (!active) throw new Error('SQLite transaction ended'); };
    const read = <T extends object>(sql: string, params: SqliteValue[]) => {
      const rows = storage.sql.exec<T & Record<string, SqlStorageValue>>(sql, ...bindings(params)).toArray();
      this.reads.record(rows);
      return rows;
    };
    const executor: SqliteExecutor & { end(): void } = {
      async exec(sql) { check(); storage.sql.exec(sql); },
      async run(sql, ...params) { check(); storage.sql.exec(sql, ...bindings(params)); },
      // The rows the statement changed, as SQLite counts them; the cursor's `rowsWritten` also counts index writes.
      async runCounted(sql, ...params) { check(); storage.sql.exec(sql, ...bindings(params)); return storage.sql.exec<{ changed: number }>('SELECT changes() AS changed').one().changed; },
      async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> { check(); return read<T>(sql, params)[0]; },
      async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> { check(); return read<T>(sql, params); },
      end() { active = false; },
    };
    return executor;
  }
  exec(sql: string): Promise<void> { return this.enqueue(() => this.executor(this.storage).exec(sql)); }
  run(sql: string, ...params: SqliteValue[]): Promise<void> { return this.enqueue(() => this.executor(this.storage).run(sql, ...params)); }
  runCounted(sql: string, ...params: SqliteValue[]): Promise<number> { return this.enqueue(() => this.executor(this.storage).runCounted(sql, ...params)); }
  get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> { return this.enqueue(() => this.executor(this.storage).get<T>(sql, ...params)); }
  all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> { return this.enqueue(() => this.executor(this.storage).all<T>(sql, ...params)); }
  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>): Promise<T> {
    return this.enqueue(() => this.storage.transaction(async () => {
      const executor = this.executor(this.storage);
      try { return await callback(executor); }
      finally { executor.end(); }
    }));
  }
  close(): Promise<void> { return this.enqueue(async () => { this.closed = true; }); }
}
