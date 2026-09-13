// @vitest-environment happy-dom
import type { SessionControlView } from '@gitspace/protocol';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useLiveSessionControls } from './useLiveSessionControls.js';

type Outcome = { status: 'ok'; value: SessionControlView } | { status: 'error'; error: Error };
const { control } = vi.hoisted(() => ({ control: vi.fn<(input: { sessionId: string }, options: { signal: AbortSignal }) => Promise<Outcome>>() }));
vi.mock('./rpc-client.js', () => ({ rpcClient: { session: { control } } }));
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  control.mockReset();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
function controls(model: string): SessionControlView {
  return { sessionId: 'omp-session', role: null, roleLabel: null, roles: [], provider: null, models: [], model, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null };
}
function View({ lease, revision = 1 }: { lease: string | null; revision?: number }) {
  const read = useLiveSessionControls('saved-session', 'omp-session', lease, revision);
  return <>{read.value ? <button>{read.value.model}</button> : null}{read.error ? <p role="alert">{read.error.message}</p> : null}<button aria-label="Refresh controls" onClick={() => void read.refetch()}>Refresh</button></>;
}
it('never reads inactive saved sessions even on event revisions or explicit stale callbacks', async () => {
  await act(() => root.render(<View lease={null} />));
  await act(() => root.render(<View lease={null} revision={2} />));
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Refresh controls"]')!.click());
  expect(control).not.toHaveBeenCalled();
});
it('rejects late control responses across lease changes even when the persisted session ID stays the same', async () => {
  const old = Promise.withResolvers<Outcome>();
  const current = Promise.withResolvers<Outcome>();
  control.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  await act(() => root.render(<View lease="machine-a:generation-1" />));
  await act(() => root.render(<View lease="machine-b:generation-2" />));
  await act(async () => { current.resolve({ status: 'ok', value: controls('Current model') }); });
  expect(container.textContent).toContain('Current model');
  await act(async () => { old.resolve({ status: 'ok', value: controls('Obsolete model') }); });
  expect(container.textContent).toContain('Current model');
  expect(container.textContent).not.toContain('Obsolete model');
  await act(() => root.render(<View lease={null} />));
  expect(container.textContent).not.toContain('Current model');
});
it('retains accepted controls on a read failure and removes them when the runtime becomes inactive', async () => {
  control.mockResolvedValueOnce({ status: 'ok', value: controls('Accepted model') });
  await act(() => root.render(<View lease="generation-1" />));
  control.mockResolvedValueOnce({ status: 'error', error: new Error('Machine temporarily unreachable') });
  await act(() => container.querySelector<HTMLButtonElement>('[aria-label="Refresh controls"]')!.click());
  expect(container.textContent).toContain('Accepted model');
  expect(container.querySelector('[role=alert]')?.textContent).toBe('Machine temporarily unreachable');
  await act(() => root.render(<View lease={null} />));
  expect(container.textContent).not.toContain('Accepted model');
  expect(container.querySelector('[role=alert]')).toBeNull();
});
