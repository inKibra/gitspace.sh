// @vitest-environment happy-dom
import type { AgentHealthState } from '@gitspace/protocol-agent';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useAgentRecovery } from './useAgentRecovery.js';

let root: Root;
let container: HTMLDivElement;
const refresh = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-18T01:00:00Z'));
  refresh.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function attempt(operationId: string, milliseconds: number): AgentHealthState {
  return { revision: 1, issues: { recovery: { revision: 1, operationId, failure: null, incidentId: null,
    attempt: { runtimeId: 'runtime-a', machineId: 'machine-a', generation: 5, number: 1,
      state: 'running', startedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + milliseconds).toISOString() },
  } } };
}
function View({ health, generation = 5 }: { health: AgentHealthState; generation?: number }) {
  const recovering = useAgentRecovery(health, 'machine-a', generation, true, refresh);
  return <button disabled={recovering}>{recovering ? 'Recovering' : 'Retry'}</button>;
}
it('expires progress without another server event and invalidates the stale snapshot', async () => {
  await act(() => root.render(<View health={attempt('first', 1_000)} />));
  expect(container.querySelector('button')?.disabled).toBe(true);
  await act(async () => { vi.advanceTimersByTime(1_001); });
  expect(container.querySelector('button')?.disabled).toBe(false);
  expect(refresh).toHaveBeenCalledTimes(1);
});
it('does not let an old attempt timer end a newer attempt or another ownership generation', async () => {
  await act(() => root.render(<View health={attempt('first', 1_000)} />));
  const successor = attempt('second', 5_000);
  await act(() => root.render(<View health={successor} />));
  await act(async () => { vi.advanceTimersByTime(1_001); });
  expect(container.querySelector('button')?.disabled).toBe(true);
  expect(refresh).not.toHaveBeenCalled();
  await act(() => root.render(<View health={successor} generation={6} />));
  expect(container.querySelector('button')?.disabled).toBe(false);
});
