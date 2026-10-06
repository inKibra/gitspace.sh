import { setImmediate } from 'node:timers/promises';
import type { GitWorktreeClock } from '../src/git-worktree-watch.js';

// A watchdog bounds failures; it never advances simulated time or gates success.
async function withinDeadline<T>(
  label: string,
  milliseconds: number,
  run: (wait: <V>(pending: Promise<V>) => Promise<V>) => Promise<T>,
): Promise<T> {
  const expires = performance.now() + milliseconds;
  const failure = new Error(`Manual watcher clock exceeded ${milliseconds}ms waiting for ${label}`);
  const expired = Promise.withResolvers<never>();
  const watchdog = setTimeout(() => expired.reject(failure), milliseconds);
  const wait = async <V>(pending: Promise<V>): Promise<V> => {
    if (performance.now() >= expires) throw failure;
    const value = await Promise.race([pending, expired.promise]);
    if (performance.now() >= expires) throw failure;
    return value;
  };
  try { return await run(wait); }
  finally { clearTimeout(watchdog); }
}

export class ManualWorktreeClock implements GitWorktreeClock {
  now = 0;
  private readonly timers = new Set<{ at: number; milliseconds: number; action(): void }>();
  private changed = Promise.withResolvers<void>();
  schedule(milliseconds: number, action: () => void): () => void {
    const timer = { at: this.now + milliseconds, milliseconds, action };
    this.timers.add(timer);
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
    return () => { this.timers.delete(timer); };
  }
  remaining(milliseconds: number): number | undefined {
    const timer = [...this.timers].find(timer => timer.milliseconds === milliseconds);
    return timer ? timer.at - this.now : undefined;
  }
  advance(milliseconds: number): void {
    const end = this.now + milliseconds;
    const deadline = performance.now() + 2000;
    for (;;) {
      if (performance.now() >= deadline) throw new Error('Manual watcher clock exceeded 2000ms advancing timers');
      const next = [...this.timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      this.now = next.at;
      this.timers.delete(next);
      next.action();
    }
    this.now = end;
  }
  async until<T>(operation: Promise<T>, timeoutMs = 2000): Promise<T> {
    let finished = false;
    void operation.finally(() => {
      finished = true;
      this.changed.resolve();
      this.changed = Promise.withResolvers<void>();
    }).catch(() => {});
    return withinDeadline('completion', timeoutMs, async wait => {
      while (!finished) {
        // Metadata polling is advanced explicitly. Yield to real I/O and the
        // watchdog even when simulated timers keep scheduling more work.
        const next = [...this.timers].filter(timer => timer.milliseconds < 5000).sort((a, b) => a.at - b.at)[0];
        if (next) {
          this.advance(Math.max(0, next.at - this.now));
          await wait(setImmediate());
        } else await wait(this.changed.promise);
      }
      return operation;
    });
  }
  async pending(milliseconds: number, timeoutMs = 2000): Promise<void> {
    await withinDeadline(`${milliseconds}ms timer`, timeoutMs, async wait => {
      while (![...this.timers].some(timer => timer.milliseconds === milliseconds)) await wait(this.changed.promise);
    });
  }
}
