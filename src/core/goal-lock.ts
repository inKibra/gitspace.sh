/**
 * Advisory lock around goal.json read-modify-write (P8).
 *
 * proper-lockfile style, kept simple and portable: a lock FILE (O_EXCL
 * create) under the project's goal storage dir carrying the holder pid.
 * Concurrent CLI invocations spin briefly; locks from dead processes (or
 * absurdly old ones) are stolen. One lock per PROJECT — goal mutations are
 * rare and short, so a coarse lock is plenty and avoids resolving which
 * goal.json a token maps to before locking.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { SpacesError } from '../types/errors.js';
import { getProjectGoalStorageDir } from './goal-chain.js';

const ACQUIRE_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 40;
/** Locks older than this are stale regardless of pid liveness. */
const MAX_LOCK_AGE_MS = 10 * 60_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM = alive but not ours; ESRCH = gone.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStale(lockPath: string): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age > MAX_LOCK_AGE_MS) return true;
    const pid = Number.parseInt(readFileSync(lockPath, 'utf-8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? !pidAlive(pid) : age > ACQUIRE_TIMEOUT_MS;
  } catch {
    // Raced with a release — treat as free on the next attempt.
    return false;
  }
}

export function goalLockPath(projectName: string): string {
  return join(getProjectGoalStorageDir(projectName), '.goal.lock');
}

/**
 * Run `fn` holding the project's goal lock. Synchronous by design — the CLI
 * mutation paths are sync — with a bounded spin and stale-lock stealing.
 */
export function withGoalLock<T>(projectName: string, fn: () => T): T {
  const lockPath = goalLockPath(projectName);
  const dir = dirname(lockPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      writeFileSync(lockPath, `${process.pid}\n`, { flag: 'wx' });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      if (isStale(lockPath)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new SpacesError(
          `Goal state is locked by another process (${lockPath}). Retry, or delete the lock file if nothing is running.`,
          'USER_ERROR',
          1,
        );
      }
      sleepSync(RETRY_DELAY_MS);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
}
