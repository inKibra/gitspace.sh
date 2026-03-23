import { useCallback, useMemo, useState } from 'react';
import type { BackendScopedAgentSessionRef, BackendScopedWorkspaceRef, MultiMachineState } from '../multi/types.js';
import { selectWorkspaceAgentsForRef, selectWorkspaceForRef, selectWorkspaceTerminalsForRef } from '../multi/selectors.js';

export interface UseWorkspaceControllerArgs {
  state: MultiMachineState;
  initialSelectedRef?: BackendScopedWorkspaceRef | null;
}

export function useWorkspaceController(args: UseWorkspaceControllerArgs) {
  const [selectedRef, setSelectedRef] = useState<BackendScopedWorkspaceRef | null>(args.initialSelectedRef ?? null);

  const workspace = useMemo(
    () => selectWorkspaceForRef(args.state, selectedRef),
    [args.state, selectedRef],
  );

  const agents = useMemo(
    () => selectWorkspaceAgentsForRef(args.state, selectedRef),
    [args.state, selectedRef],
  );

  const terminals = useMemo(
    () => selectWorkspaceTerminalsForRef(args.state, selectedRef),
    [args.state, selectedRef],
  );

  const visibleAgents = useMemo(() => agents.filter((agent) => agent.state !== 'archived'), [agents]);
  const archivedAgents = useMemo(() => agents.filter((agent) => agent.state === 'archived'), [agents]);

  const openAgentRef = (agentSessionId: string): BackendScopedAgentSessionRef | null => {
    if (!selectedRef) return null;
    return {
      backendKey: selectedRef.backendKey,
      workspaceId: selectedRef.workspaceId,
      agentSessionId,
    };
  };

  const clearSelectedRef = useCallback(() => {
    setSelectedRef(null);
  }, []);

  return {
    selectedRef,
    setSelectedRef,
    clearSelectedRef,
    workspace,
    terminals,
    agents,
    visibleAgents,
    archivedAgents,
    openAgentRef,
  };
}
