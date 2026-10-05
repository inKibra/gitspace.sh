import { setTimeout as pauseFor } from 'node:timers/promises';

export async function pollUntilReady(ready: () => Promise<boolean>, options: {
  timeoutMs: number;
  message: string;
  now?: () => number;
  pause?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const pause = options.pause ?? pauseFor;
  const deadline = now() + options.timeoutMs;
  while (!await ready()) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error(options.message);
    await pause(Math.min(50, remaining));
  }
}
