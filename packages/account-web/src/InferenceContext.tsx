import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InferenceAssignment, InferenceProfile, InferenceState } from '@gitspace/protocol/inference';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useAccountInference } from './SynchronizationProvider.js';

export interface InferenceController {
  state: InferenceState | null;
  loading: boolean;
  pending: boolean;
  error: string | null;
  refresh(): Promise<void>;
  create(name: string, sourceProfileId: string | null): Promise<InferenceState>;
  update(profile: InferenceProfile, name: string, settings: InferenceProfile['settings']): Promise<InferenceState>;
  remove(profile: InferenceProfile): Promise<InferenceState>;
  assign(assignment: InferenceAssignment, profileId: string): Promise<InferenceState>;
}

export const InferenceContext = createContext<InferenceController | null>(null);
export function useInference(): InferenceController | null { return useContext(InferenceContext); }

/** The only browser projection of canonical profile/assignment state; never persisted locally. */
export function InferenceProvider({ children }: { children: ReactNode }) {
  const query = useAccountInference();
  const [committed, setCommitted] = useState<InferenceState | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const currentQuery = useRef(query);
  currentQuery.current = query;
  useEffect(() => {
    const refresh = () => { void currentQuery.current.refetch(); };
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('gitspace:account-directory-changed', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('gitspace:account-directory-changed', refresh);
    };
  }, []);
  const loaded = query.state === 'success' ? query.value : null;
  const state = query.state === 'failure' ? null : committed && (!loaded || committed.revision > loaded.revision) ? committed : loaded;
  const run = async (operation: () => Promise<{ status: 'ok'; value: InferenceState } | { status: 'error'; error: Error }>): Promise<InferenceState> => {
    if (busy.current) throw new Error('Another inference change is still saving.');
    busy.current = true;
    setPending(true);
    setMutationError(null);
    try {
      const result = await operation();
      if (result.status === 'error') throw result.error;
      setCommitted(result.value);
      void currentQuery.current.refetch();
      return result.value;
    } catch (cause) {
      setMutationError(rpcErrorMessage(cause, 'Save inference configuration'));
      throw cause;
    } finally {
      busy.current = false;
      setPending(false);
    }
  };
  const value: InferenceController = {
    state,
    loading: query.state === 'pending',
    pending,
    error: query.state === 'failure' ? rpcErrorMessage(query.error, 'Load inference profiles') : mutationError,
    refresh: async () => { setMutationError(null); await query.refetch(); },
    create: (name, sourceProfileId) => run(() => rpcClient.inference.create({ name, sourceProfileId })),
    update: (profile, name, settings) => run(() => rpcClient.inference.update({ profileId: profile.id, expectedRevision: profile.revision, name, settings })),
    remove: (profile) => run(() => rpcClient.inference.delete({ profileId: profile.id, expectedRevision: profile.revision })),
    assign: (assignment, profileId) => run(() => rpcClient.inference.assign({ projectId: assignment.projectId, profileId, expectedRevision: assignment.revision })),
  };
  return <InferenceContext.Provider value={value}>{children}</InferenceContext.Provider>;
}
