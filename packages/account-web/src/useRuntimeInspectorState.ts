import { useCallback, useEffect, useRef, useState } from 'react';
import type { InspectorProps } from './inspector/Inspector.js';
import type { InspectorProviderUsageState } from './inspector/UsageView.js';
import type { RuntimeInspectorContext } from './RuntimeWorkspace.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { runtimeSubagents } from './runtime-shell-adapter.js';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime';

type ReadState<T> = { report: T | null; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };
export type RuntimeInspectorState = Pick<InspectorProps, 'agentSetup' | 'subagents'> & { usage: InspectorProps['usage'] & { providerUsage: InspectorProviderUsageState } };
export function useRuntimeInspectorState(context: RuntimeInspectorContext | undefined): RuntimeInspectorState | null {
  const [usage, setUsage] = useState<ReadState<NonNullable<InspectorProps['usage']['report']>>>({ report: null, status: 'idle' });
  const [setup, setSetup] = useState<ReadState<NonNullable<InspectorProps['agentSetup']['report']>>>({ report: null, status: 'idle' });
  const [providerUsage, setProviderUsage] = useState<InspectorProviderUsageState>({ report: null, status: 'idle' });
  const main = context?.snapshot.conversations.find(conversation => conversation.parentId === null);
  const identity = context ? JSON.stringify([context.snapshot.projectId, context.snapshot.workspaceId, main?.id]) : '';
  const current = useRef(identity);
  current.current = identity;
  const session = useCallback(async (command: RuntimeSessionCommand) => {
    if (!context || !main) throw new Error('The main runtime session is unavailable.');
    const result = await rpcClient.runtime.session({ projectId: context.snapshot.projectId, workspaceId: context.snapshot.workspaceId, conversationId: main.id, command });
    if (result.status === 'error') throw result.error;
    if (current.current !== identity) throw new Error('The runtime workspace changed.');
    return result.value;
  }, [identity]);
  useEffect(() => { setUsage({ report: null, status: 'idle' }); setSetup({ report: null, status: 'idle' }); setProviderUsage({ report: null, status: 'idle' }); }, [identity]);
  const usageBusy = useRef<string | null>(null);
  const setupBusy = useRef<string | null>(null);
  const loadUsage = async (refresh = false) => {
    if (!main || usageBusy.current === identity) return;
    usageBusy.current = identity;
    setUsage(value => ({ ...value, status: 'loading', error: undefined }));
    try {
      const result = await session({ type: 'usage' });
      if (!result.usage) throw new Error('The runtime did not return session usage.');
      setUsage({ report: result.usage, status: 'ready' });
      const profileId = result.control.inference?.profileId;
      if (!profileId) {
        setProviderUsage({ report: null, status: 'error', error: 'The active inference profile is unavailable. Provider account limits cannot be loaded.' });
      } else {
        setProviderUsage(value => ({ ...value, status: 'loading', error: undefined }));
        try {
          const limits = await rpcClient.providers.usage({ profileId, providerId: null, refresh });
          if (current.current !== identity) return;
          if (limits.status === 'error') throw limits.error;
          setProviderUsage({ report: limits.value, status: 'ready' });
        } catch (error) {
          if (current.current === identity) setProviderUsage(value => ({ ...value, status: 'error', error: rpcErrorMessage(error, 'Load provider account limits') }));
        }
      }
    } catch (error) { if (current.current === identity) setUsage(value => ({ ...value, status: 'error', error: rpcErrorMessage(error, 'Load runtime usage') })); }
    finally { if (usageBusy.current === identity) usageBusy.current = null; }
  };
  const loadSetup = async () => {
    if (!main || setupBusy.current === identity) return;
    setupBusy.current = identity;
    setSetup(value => ({ ...value, status: 'loading', error: undefined }));
    try { const result = await session({ type: 'agentSetup' }); if (!result.setup) throw new Error('The runtime did not return agent definitions.'); setSetup({ report: result.setup, status: 'ready' }); }
    catch (error) { if (current.current === identity) setSetup(value => ({ ...value, status: 'error', error: rpcErrorMessage(error, 'Load runtime agent definitions') })); }
    finally { if (setupBusy.current === identity) setupBusy.current = null; }
  };
  useEffect(() => { if (usage.status === 'ready') void loadUsage(); }, [context?.snapshot.cursor]);
  if (!context) return null;
  return {
    subagents: runtimeSubagents(context.snapshot),
    usage: { ...usage, providerUsage, sessionId: main?.id ?? null, load: () => { void loadUsage(); }, refresh: () => { void loadUsage(true); } },
    agentSetup: { ...setup, immutable: false, persistence: 'cloud', sessionId: main?.id ?? null, load: () => { void loadSetup(); }, refresh: () => { void loadSetup(); }, save: async input => { const result = await session({ type: 'saveAgentDefinition', ...input }); if (!result.setup) throw new Error('The runtime did not return saved agent definitions.'); setSetup({ report: result.setup, status: 'ready' }); return result.setup; } },
  };
}
