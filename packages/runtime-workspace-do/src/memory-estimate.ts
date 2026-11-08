/**
 * Approximate heap bytes of what a workspace object keeps, by holder, from a walk of the values that never serializes
 * them. workerd reports no heap figures (`process.memoryUsage()` answers zeros), so this is the only reading the object
 * has of its own memory.
 *
 * A string counts its characters plus a header (one byte a character: V8 stores Latin-1 text so, other text at two); an
 * object or array counts a header and one pointer a field or element. A value reached from two holders counts once, in
 * the first holder named; so does a long string, which the snapshot shares with the views it is built from. A string
 * cut from a longer one keeps the longer one alive in V8, which a walk cannot see: it counts the cut length only.
 */
const HEADER_BYTES = 16;
const POINTER_BYTES = 8;
/** Strings at least this long are counted once across every holder; shorter ones are counted wherever they appear. */
const SHARED_STRING_CHARACTERS = 256;
/**
 * Strings and objects one estimate takes on at most. Its own bookkeeping (the seen sets and the walk's stack) costs
 * 30–40 bytes a value, about 3.6 MB at this bound, within an object close to its 128 MB. A workspace with 9 conversations
 * of 512 messages, 129 tasks and 256 watch deltas (24 MB) is 77,000 values. Past the bound the walk stops: the holder
 * it was in counts what it reached, later holders are left out, and the estimate says it was cut short.
 */
export const VISIT_LIMIT = 100_000;

export type MemoryEstimate = { holders: Record<string, number>; totalBytes: number; visited: number; truncated: boolean };

export function estimateMemory(holders: Readonly<Record<string, unknown>>): MemoryEstimate {
  const objects = new WeakSet<object>();
  const strings = new Set<string>();
  const counted: Record<string, number> = {};
  const pending: unknown[] = [];
  let totalBytes = 0, visited = 0, truncated = false;
  /** Queues a value the walk measures; numbers and other primitives cost only the slot holding them. */
  const take = (value: unknown) => {
    if (typeof value !== 'string' && (typeof value !== 'object' || value === null)) return;
    if (visited === VISIT_LIMIT) { truncated = true; return; }
    visited++;
    pending.push(value);
  };
  for (const [name, root] of Object.entries(holders)) {
    let bytes = 0;
    take(root);
    while (pending.length > 0) {
      const value = pending.pop();
      if (typeof value === 'string') {
        if (value.length >= SHARED_STRING_CHARACTERS) {
          if (strings.has(value)) continue;
          strings.add(value);
        }
        bytes += HEADER_BYTES + value.length;
        continue;
      }
      if (typeof value !== 'object' || value === null || objects.has(value)) continue;
      objects.add(value);
      bytes += HEADER_BYTES;
      if (ArrayBuffer.isView(value)) bytes += value.byteLength;
      else if (value instanceof ArrayBuffer) bytes += value.byteLength;
      else if (Array.isArray(value)) {
        bytes += POINTER_BYTES * value.length;
        for (const item of value) take(item);
      } else if (value instanceof Map) {
        bytes += 2 * POINTER_BYTES * value.size;
        for (const [key, item] of value) { take(key); take(item); }
      } else if (value instanceof Set) {
        bytes += POINTER_BYTES * value.size;
        for (const item of value) take(item);
      } else {
        for (const key in value) {
          bytes += POINTER_BYTES;
          take(Reflect.get(value, key));
        }
      }
    }
    counted[name] = bytes;
    totalBytes += bytes;
    if (truncated) break;
  }
  return { holders: counted, totalBytes, visited, truncated };
}

/** Model requests since the last `take`: how many, the largest one's context, and the most contexts held at once. */
export type RequestLoad = { count: number; largestBytes: number; peakInflightBytes: number };

/** Counts model requests from start to end, each by the characters of the context it sends. */
export function createRequestLoad() {
  let inflight = 0;
  let load: RequestLoad = { count: 0, largestBytes: 0, peakInflightBytes: 0 };
  return {
    /** A request sending `bytes` started; the answer ends it (more than once is harmless). */
    begin(bytes: number): () => void {
      inflight += bytes;
      load.count++;
      load.largestBytes = Math.max(load.largestBytes, bytes);
      load.peakInflightBytes = Math.max(load.peakInflightBytes, inflight);
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        inflight -= bytes;
      };
    },
    /** The load since the previous take; requests still running start the next one. */
    take(): RequestLoad {
      const taken = load;
      load = { count: 0, largestBytes: 0, peakInflightBytes: inflight };
      return taken;
    },
  };
}
