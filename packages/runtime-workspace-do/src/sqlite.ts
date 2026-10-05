import type { SqliteDatabase, SqliteExecutor, SqliteValue } from '@earendil-works/pi-durable/storage/sqlite';

/** Queue the portable asynchronous driver over DO transactions; never serialize a memory database. */
export class DurableObjectSqliteDatabase implements SqliteDatabase {
  private line: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly storage: DurableObjectStorage) {}
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
    const executor: SqliteExecutor & { end(): void } = {
      async exec(sql) { check(); storage.sql.exec(sql); },
      async run(sql, ...params) { check(); storage.sql.exec(sql, ...bindings(params)); },
      async get<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T | undefined> { check(); return storage.sql.exec<T & Record<string, SqlStorageValue>>(sql, ...bindings(params)).toArray()[0]; },
      async all<T extends object>(sql: string, ...params: SqliteValue[]): Promise<T[]> { check(); return storage.sql.exec<T & Record<string, SqlStorageValue>>(sql, ...bindings(params)).toArray(); },
      end() { active = false; },
    };
    return executor;
  }
  exec(sql: string): Promise<void> { return this.enqueue(() => this.executor(this.storage).exec(sql)); }
  run(sql: string, ...params: SqliteValue[]): Promise<void> { return this.enqueue(() => this.executor(this.storage).run(sql, ...params)); }
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
