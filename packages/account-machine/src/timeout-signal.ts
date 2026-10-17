/** An AbortSignal that aborts after `ms` with an Error naming what took too long. `AbortSignal.timeout` aborts with an
 * anonymous "The operation timed out." whose stack is empty, which leaves a failure impossible to place. */
export function timeoutSignal(ms: number, reason: string): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(reason)), ms);
  // A pending limit never keeps the process alive.
  timer.unref();
  return controller.signal;
}
