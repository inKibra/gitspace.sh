import { isAgentRecoveryRunning, type AgentHealthState } from '@gitspace/protocol-agent';
import { useEffect, useState } from 'react';

/** An obligation is not progress. Expiry stops the indicator even without another event. */
export function useAgentRecovery(
  health: AgentHealthState | undefined,
  machineId: string | null,
  generation: number,
  connected: boolean,
  refresh: () => unknown,
): boolean {
  const [, tick] = useState(0);
  const issue = health?.issues.recovery;
  const deadline = issue?.attempt?.state === 'running' ? Date.parse(issue.attempt.deadlineAt) : null;
  useEffect(() => {
    if (!connected || deadline === null || !Number.isFinite(deadline)) return;
    const timer = setTimeout(() => {
      tick((value) => value + 1);
      void refresh();
    }, Math.max(0, deadline - Date.now()) + 1);
    return () => clearTimeout(timer);
  }, [connected, deadline, issue?.operationId, refresh]);
  return connected && machineId !== null && health !== undefined
    && isAgentRecoveryRunning(health, machineId, generation);
}
