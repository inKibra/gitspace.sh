export type StoredRetry = {
  /** Runs `operation`; a failure is recorded, schedules the next try and is rethrown. */
  run<T>(operation: () => Promise<T>): Promise<T>;
  /** Records a failure seen outside `run` and schedules the next try. */
  failed(error: unknown): Promise<void>;
  /** Whether `error` is one `run` recorded (and so reported itself). */
  handled(error: unknown): boolean;
  /** Retrying stopped after `attempts` failures. */
  stopped(): boolean;
  clear(): void;
};
/**
 * A retry after failure, as the No polling rule allows one: tried again after `firstMs`, doubling per consecutive
 * failure up to `maxMs`, for at most `attempts` tries. The count of consecutive failures is stored in `table`, so a
 * workspace evicted between tries keeps its place in the backoff; a success clears it. A person hears of a run of
 * failures twice: `report` when it starts, `stopped` when retrying stops. After that only `clear` (new work) or a
 * success starts it over.
 */
export function createStoredRetry(sql: SqlStorage, options: {
  table: string;
  /** The log line's event. */
  event: string;
  workspaceId: string;
  firstMs: number;
  maxMs: number;
  attempts: number;
  schedule(timestamp: number): Promise<void>;
  report(error: unknown): void;
  stopped(failures: number, message: string): void;
}): StoredRetry {
  sql.exec(`CREATE TABLE IF NOT EXISTS ${options.table}(singleton INTEGER PRIMARY KEY CHECK(singleton=1), failures INTEGER NOT NULL)`);
  let last: unknown;
  async function failed(error: unknown) {
    const count = sql.exec<{ failures: number }>(`INSERT INTO ${options.table}(singleton,failures) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET failures=failures+1 RETURNING failures`).toArray()[0]?.failures ?? 1;
    const message = error instanceof Error ? error.message : String(error);
    const retryInMs = count < options.attempts ? Math.min(options.firstMs * 2 ** (count - 1), options.maxMs) : null;
    console.error(JSON.stringify({ event: options.event, workspaceId: options.workspaceId, failures: count, retryInMs, message }));
    if (count === 1) options.report(error);
    if (count === options.attempts) options.stopped(count, message);
    if (retryInMs !== null) await options.schedule(Date.now() + retryInMs);
  }
  return {
    async run(operation) {
      try {
        const value = await operation();
        sql.exec(`DELETE FROM ${options.table}`);
        return value;
      } catch (error) {
        last = error;
        await failed(error);
        throw error;
      }
    },
    failed,
    handled: error => error === last,
    stopped: () => (sql.exec<{ failures: number }>(`SELECT failures FROM ${options.table}`).toArray()[0]?.failures ?? 0) >= options.attempts,
    clear() { sql.exec(`DELETE FROM ${options.table}`); },
  };
}
