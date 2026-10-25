/**
 * A failed LFS retention is tried again after this long, doubling per consecutive failure up to `RETRY_MAX_MS`, for at
 * most `ATTEMPTS` tries (about 85 minutes). Each try wakes the workspace; after the last only work that flushes the
 * outbox anyway (a snapshot change, a cloud write, an open) tries again, so a retention that cannot succeed stops
 * holding an idle workspace awake. Its outbox row stays an LFS root meanwhile, keeping its objects retained.
 */
const RETRY_FIRST_MS = 5_000, RETRY_MAX_MS = 30 * 60_000, ATTEMPTS = 10;

/**
 * Wraps `retain` with the retry schedule above. The count of consecutive failures is stored, so a workspace evicted
 * between tries keeps its place in the backoff; any success clears it. A person hears of a run of failures twice: when
 * it starts and when retrying stops.
 */
export function createLfsRetentionRetry<Args extends unknown[]>(sql: SqlStorage, options: {
  workspaceId: string;
  retain(...args: Args): Promise<void>;
  schedule(timestamp: number): Promise<void>;
  report(error: unknown): void;
}): { retain(...args: Args): Promise<void>; handled(error: unknown): boolean } {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_lfs_retention_failures(singleton INTEGER PRIMARY KEY CHECK(singleton=1), failures INTEGER NOT NULL)');
  let last: unknown;
  return {
    async retain(...args) {
      try { await options.retain(...args); }
      catch (error) {
        last = error;
        const failures = sql.exec<{ failures: number }>('INSERT INTO runtime_lfs_retention_failures(singleton,failures) VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET failures=failures+1 RETURNING failures').toArray()[0]?.failures ?? 1;
        const message = error instanceof Error ? error.message : String(error);
        const retryInMs = failures < ATTEMPTS ? Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS) : null;
        console.error(JSON.stringify({ event: 'lfs_retention_failed', workspaceId: options.workspaceId, failures, retryInMs, message }));
        if (failures === 1) options.report(error);
        if (failures === ATTEMPTS) options.report(new Error(`LFS retention stopped retrying after ${failures} failures: ${message}. The workspace's LFS objects stay retained; the next snapshot change tries again.`));
        if (retryInMs !== null) await options.schedule(Date.now() + retryInMs);
        throw error;
      }
      sql.exec('DELETE FROM runtime_lfs_retention_failures');
    },
    handled: error => error === last,
  };
}
