import type { AutomationException, AutomationMode, AutomationView } from '@gitspace/protocol/automations-contract';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { useResultQuery } from 'result-rpc/react';
import { useState } from 'react';
import { settle } from '../automations/automation-formatters.js';
import { useLiveChanges } from '../live-notices.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { useEventRefresh } from '../SynchronizationProvider.js';
import { useRetainedRead } from '../useRetainedRead.js';

/** The project's automations and their per-workspace phase exceptions, as the Goal tab shows them for one workspace. */
export interface GoalAutomations {
  automations: readonly AutomationView[];
  exceptions: readonly AutomationException[];
  /** True once both the automations and the exceptions have been read; until then the lists are empty, not known empty. */
  read: boolean;
  /** The automation whose exception is being saved. */
  busy: string | null;
  error: string | null;
  set(automation: AutomationView, workspaceId: string, phase: AutomationMode, enabled: boolean | null): void;
  retry(): void;
}

/** Reads the project's automations and exceptions, again when automations change anywhere in the account. */
export function useWorkspaceAutomations(projectId: string): GoalAutomations {
  const list = useResultQuery(rpcClient.automations.list, { projectId });
  const listRead = useRetainedRead(list, projectId);
  const exceptions = useResultQuery(rpcClient.automations.exceptions.list, { projectId });
  const exceptionsRead = useRetainedRead(exceptions, projectId);
  const refresh = (): Promise<unknown> => Promise.all([list.refetch(), exceptions.refetch()]);
  useEventRefresh(useLiveChanges(accountLiveKey('automations')), refresh);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const readError = listRead.error ? rpcErrorMessage(listRead.error, 'Read automations') : exceptionsRead.error ? rpcErrorMessage(exceptionsRead.error, 'Read workspace exceptions') : null;
  return {
    automations: listRead.value?.automations ?? [],
    exceptions: exceptionsRead.value ?? [],
    busy,
    read: listRead.value !== undefined && exceptionsRead.value !== undefined,
    error: failure ?? readError,
    set: (automation, workspaceId, phase, enabled) => {
      setBusy(automation.id);
      setFailure(null);
      void settle(rpcClient.automations.exceptions.set({ projectId, automationId: automation.id, workspaceId, phase, enabled }))
        .then(refresh)
        .catch((cause: unknown) => setFailure(rpcErrorMessage(cause, enabled === null ? 'Remove the exception' : 'Make an exception')))
        .finally(() => setBusy(null));
    },
    retry: () => { setFailure(null); void refresh(); },
  };
}
