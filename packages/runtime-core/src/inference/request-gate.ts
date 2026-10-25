/**
 * How many model requests of one workspace object may build and upload their body at once. A request's body is in
 * memory three times while that happens (the loaded history, the SDK's serialized request, the encoded bytes sent), and
 * a main conversation's reaches 17.6 MB: two lets one subagent's request go out beside the main conversation's instead
 * of queueing behind it, and keeps the object under its 128 MB limit however many subagents run.
 */
export const MODEL_REQUEST_UPLOADS = 2;

/** One request's place in the gate. `release` is idempotent: the first call frees the place, later calls do nothing. */
export type RequestPermit = { release(): void };
/**
 * Admits a workspace object's model requests to building and uploading their body, `MODEL_REQUEST_UPLOADS` at a time
 * and the rest in arrival order. One per workspace object: objects sharing an isolate are separate request contexts,
 * and a promise one of them resolves must not wake another's request.
 */
export type RequestGate = {
  /** Resolves with a permit once one is free; rejects with the signal's reason if it aborts first, holding no place. */
  acquire(signal?: AbortSignal): Promise<RequestPermit>;
};

export function createRequestGate(): RequestGate {
  let free = MODEL_REQUEST_UPLOADS;
  const waiting: Array<() => void> = [];
  function permit(): RequestPermit {
    let held = true;
    return {
      release() {
        if (!held) return;
        held = false;
        const next = waiting.shift();
        if (next) next();
        else free++;
      },
    };
  }
  return {
    async acquire(signal) {
      signal?.throwIfAborted();
      if (free > 0) {
        free--;
        return permit();
      }
      const { promise, resolve, reject } = Promise.withResolvers<RequestPermit>();
      const abort = () => {
        waiting.splice(waiting.indexOf(grant), 1);
        reject(signal?.reason);
      };
      const grant = () => {
        signal?.removeEventListener('abort', abort);
        resolve(permit());
      };
      waiting.push(grant);
      signal?.addEventListener('abort', abort, { once: true });
      return promise;
    },
  };
}
