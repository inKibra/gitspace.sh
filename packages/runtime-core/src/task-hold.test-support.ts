import { awaitWithContext, type Context } from '@earendil-works/chord/context';

/** Holds a test task's phase in its invocation until `until`, or until the task or `context` is aborted, as pi's removed
 * `TaskRuntime.sleep()` did. `sleepUntil()` would end the phase and leave the task sleeping instead of running. */
export async function holdPhase(runtime: { setTimer(callback: () => void, delayMs: number): () => void; now(): number; readonly signal: AbortSignal }, until: number, context: Context): Promise<void> {
  const held = Promise.withResolvers<void>();
  runtime.setTimer(held.resolve, until - runtime.now());
  const aborted = () => held.reject(runtime.signal.reason);
  runtime.signal.addEventListener('abort', aborted, { once: true });
  try { await awaitWithContext(held.promise, context); }
  finally { runtime.signal.removeEventListener('abort', aborted); }
}
