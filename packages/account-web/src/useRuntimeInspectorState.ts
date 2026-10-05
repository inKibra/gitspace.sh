import { useCallback, useEffect, useRef, useState } from 'react';
import type { InspectorProps } from './inspector/Inspector.js';
import type { RuntimeInspectorContext } from './RuntimeWorkspace.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { runtimeSubagents } from './runtime-shell-adapter.js';
import type { RuntimeSessionCommand } from '@gitspace/protocol-runtime';

type ReadState<T> = { report: T | null; status: 'idle' | 'loading' | 'ready' | 'error'; error?: string };
export function useRuntimeInspectorState(context: RuntimeInspectorContext | undefined): Pick<InspectorProps, 'usage' | 'agentSetup' | 'subagents'> | null {
  const [usage, setUsage] = useState<ReadState<NonNullable<InspectorProps['usage']['report']>>>({ report: null, status: 'idle' });
  const [setup, setSetup] = useState<ReadState<NonNullable<InspectorProps['agentSetup']['report']>>>({ report: null, status: 'idle' });
  const identity = context ? JSON.stringify([context.snapshot.projectId, context.snapshot.workspaceId, context.conversationId]) : '';
  const current = useRef(identity);
  current.current = identity;
  const session = useCallback(async (command: RuntimeSessionCommand) => {
    if (!context) throw new Error('Runtime session is unavailable.');
    const result = await rpcClient.runtime.session({ projectId: context.snapshot.projectId, workspaceId: context.snapshot.workspaceId, conversationId: context.conversationId, command });
    if (result.status === 'error') throw result.error;
    if (current.current !== identity) throw new Error('The selected runtime conversation changed.');
    return result.value;
  }, [identity]);
  useEffect(() => { setUsage({ report: null, status: 'idle' }); setSetup({ report: null, status: 'idle' }); }, [identity]);
  const usageBusy = useRef(false);
  const setupBusy = useRef(false);
  const loadUsage = async () => {
    if (!context || usageBusy.current) return;
    usageBusy.current = true;
    setUsage(value => ({ ...value, status: 'loading', error: undefined }));
    try { const result = await session({ type: 'usage' }); if (!result.usage) throw new Error('The runtime did not return session usage.'); setUsage({ report: result.usage, status: 'ready' }); }
    catch (error) { if (current.current === identity) setUsage(value => ({ ...value, status: 'error', error: rpcErrorMessage(error, 'Load runtime usage') })); }
    finally { usageBusy.current = false; }
  };
  const loadSetup = async () => {
    if (!context || setupBusy.current) return;
    setupBusy.current = true;
    setSetup(value => ({ ...value, status: 'loading', error: undefined }));
    try { const result = await session({ type: 'agentSetup' }); if (!result.setup) throw new Error('The runtime did not return agent definitions.'); setSetup({ report: result.setup, status: 'ready' }); }
    catch (error) { if (current.current === identity) setSetup(value => ({ ...value, status: 'error', error: rpcErrorMessage(error, 'Load runtime agent definitions') })); }
    finally { setupBusy.current = false; }
  };
  useEffect(() => { if (usage.status === 'ready') void loadUsage(); }, [context?.snapshot.cursor]);
  if (!context) return null;
  return {
    subagents: runtimeSubagents(context.snapshot),
    usage: { ...usage, sessionId: context.sessionId, load: () => { void loadUsage(); }, refresh: () => { void loadUsage(); } },
    agentSetup: { ...setup, persistence: 'cloud', sessionId: context.sessionId, load: () => { void loadSetup(); }, refresh: () => { void loadSetup(); }, save: async input => { const result = await session({ type: 'saveAgentDefinition', ...input }); if (!result.setup) throw new Error('The runtime did not return saved agent definitions.'); setSetup({ report: result.setup, status: 'ready' }); return result.setup; } },
  };
}
