import { useRef } from 'react';
import { isTaggedError } from 'result-rpc';

type ReadQuery<Value> = ({ state: 'success'; value: Value } | { state: 'pending' } | { state: 'failure'; error: Error; previous?: Value }) & { fetch?: 'fetching' | 'idle' | 'paused' };

/** Authority failures invalidate data, unlike a failed background transport read. */
export function invalidatesRead(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isTaggedError(error)) {
    if (error._tag === 'client/http-failure' && error.data !== null && typeof error.data === 'object' && 'status' in error.data && [401, 403, 404, 409].includes(Number(error.data.status))) return true;
    if (/not-found|notFound|unpossessed|Possessed|generation-conflict|GenerationConflict|inspector-state|inspectorState|unauthorized|forbidden/i.test(error._tag)) return true;
  }
  return /unauthorized|forbidden|device (?:rejected|revoked)|not (?:the )?(?:current )?owner|generation (?:conflict|mismatch)/i.test(error.message);
}

/** A view projection only: result-rpc remains the request/cache owner. Null keys revoke the read. */
export function useRetainedRead<Value>(query: ReadQuery<Value>, key: string | null) {
  const retained = useRef<{ key: string | null; value: Value | undefined; observed: Value | undefined; blocked: Value | undefined }>({ key, value: undefined, observed: undefined, blocked: undefined });
  const current = retained.current;
  if (current.key !== key) {
    current.key = key;
    current.value = undefined;
    // A disabled/re-keyed query can still expose its old successful cache entry.
    current.blocked = current.observed;
  }
  const error = query.state === 'failure' ? query.error : null;
  if (key === null || (error && invalidatesRead(error))) {
    current.value = undefined;
    current.blocked = current.observed;
  } else if (query.state === 'success' && query.value !== current.blocked) {
    current.value = query.value;
  } else if (query.state === 'failure' && current.value === undefined && query.previous !== current.blocked) {
    current.value = query.previous;
  }
  if (query.state === 'success') current.observed = query.value;
  const refreshing = key !== null && (query.state === 'pending' || query.fetch === 'fetching');
  return { value: current.value, initialLoading: key !== null && current.value === undefined && refreshing, refreshing: current.value !== undefined && refreshing, stale: current.value !== undefined && error !== null, error };
}

export function useRetainedQueryValue<Value>(query: ReadQuery<Value>, key: string | null): Value | undefined {
  return useRetainedRead(query, key).value;
}
