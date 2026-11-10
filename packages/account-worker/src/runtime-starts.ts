/**
 * Workspace runtime starts that failed in a row. A start fails when its open throws, or when its instance does not
 * stay up `START_SETTLE_MS` after opening: a reset (memory, CPU, storage timeout) ends the instance before the start
 * is marked settled, and the next instance finds it still marked as running. After a failure the next start waits
 * `START_BACKOFF_MS` (the last delay repeats); after `START_FAILURE_LIMIT` failures in a row the workspace is paused.
 */
export const START_SETTLE_MS = 60_000;
export const START_BACKOFF_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 3_600_000];
export const START_FAILURE_LIMIT = 15;

export type StartGate =
  | { status: 'open' }
  | { status: 'waiting'; failures: number; lastFailure: string; retryAt: number }
  | { status: 'pause'; failures: number; lastFailure: string };

/** A start refused while an earlier failure's delay runs; `retryAt` is when the next start may run. */
export class RuntimeStartWaiting extends Error {
  constructor(readonly failures: number, readonly lastFailure: string, readonly retryAt: number) {
    super(`This workspace failed to start ${failures} ${failures === 1 ? 'time' : 'times'} in a row (last: ${lastFailure}); it tries again at ${new Date(retryAt).toISOString()}`);
    this.name = 'RuntimeStartWaiting';
  }
}

export interface RuntimeStarts {
  /** Before a start: records an earlier start whose instance ended before it settled, then decides this one. */
  gate(now: number): StartGate;
  /** Marks a start as running from `now`; until it settles or fails, a reset counts it as failed. */
  begin(now: number): void;
  /** The instance stayed up `START_SETTLE_MS` after opening: the count starts over. */
  settled(): void;
  /** The instance ends on purpose (a release restart) before it settled: not a failure, and the count stays. */
  ended(): void;
  failed(error: string): void;
}

export function createRuntimeStarts(sql: SqlStorage): RuntimeStarts {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_starts(id INTEGER PRIMARY KEY CHECK (id = 1), failures INTEGER NOT NULL, running_since INTEGER, last_started_at INTEGER NOT NULL, last_failure TEXT)');
  const read = () => sql.exec<{ failures: number; running_since: number | null; last_started_at: number; last_failure: string | null }>('SELECT failures, running_since, last_started_at, last_failure FROM runtime_starts WHERE id=1').toArray()[0];
  /** What the reset instance was running, from the marks the runtime keeps for exactly this. */
  const interrupted = (): string => {
    if (!sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_running'").toArray().length) return 'reset while starting';
    const steps = sql.exec<{ step: string; detail: string }>('SELECT step, detail FROM runtime_running ORDER BY started_at').toArray();
    return steps.length ? `reset while ${steps.map(row => row.detail ? `${row.step}: ${row.detail}` : row.step).join('; ')}` : 'reset within a minute of starting';
  };
  return {
    gate(now) {
      const row = read();
      if (!row) return { status: 'open' };
      let { failures, last_failure: lastFailure } = row;
      if (row.running_since !== null) {
        failures += 1;
        lastFailure = interrupted();
        sql.exec('UPDATE runtime_starts SET failures=?, running_since=NULL, last_failure=? WHERE id=1', failures, lastFailure);
      }
      if (failures === 0) return { status: 'open' };
      const failure = lastFailure ?? 'unknown';
      if (failures >= START_FAILURE_LIMIT) return { status: 'pause', failures, lastFailure: failure };
      const retryAt = row.last_started_at + START_BACKOFF_MS[Math.min(failures, START_BACKOFF_MS.length) - 1];
      return now < retryAt ? { status: 'waiting', failures, lastFailure: failure, retryAt } : { status: 'open' };
    },
    begin(now) {
      sql.exec('INSERT INTO runtime_starts(id,failures,running_since,last_started_at) VALUES(1,0,?,?) ON CONFLICT(id) DO UPDATE SET running_since=excluded.running_since, last_started_at=excluded.last_started_at', now, now);
    },
    settled() {
      sql.exec('DELETE FROM runtime_starts');
    },
    ended() {
      sql.exec('UPDATE runtime_starts SET running_since=NULL WHERE id=1');
    },
    failed(error) {
      sql.exec('UPDATE runtime_starts SET failures=failures+1, running_since=NULL, last_failure=? WHERE id=1', error);
    },
  };
}
