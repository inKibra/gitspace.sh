/** Runs `run` now, or once more after the run in flight. Every request made while a run is in flight shares the
 * single next run and its result, so a burst of requests costs one run, and none is answered by a run that began
 * before it. */
export function coalesced<T>(run: () => Promise<T>): () => Promise<T> {
  let active: Promise<T> | null = null;
  let next: Promise<T> | null = null;
  const start = (): Promise<T> => {
    const current: Promise<T> = run().finally(() => { if (active === current) active = null; });
    active = current;
    return current;
  };
  return () => {
    if (!active) return start();
    next ??= active.catch(() => undefined).then(() => {
      next = null;
      return start();
    });
    return next;
  };
}
