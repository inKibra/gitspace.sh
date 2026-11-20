// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type * as LiveNotices from '../live-notices.js';
import type * as Synchronization from '../SynchronizationProvider.js';
import { useProjectGraphs } from './project-graph.js';

const reads = vi.hoisted(() => ({ refetch: vi.fn(async () => {}) }));
vi.mock('result-rpc/react', () => ({ useResultQuery: () => ({ state: 'pending', refetch: reads.refetch }) }));
vi.mock('../rpc-client.js', () => ({ rpcClient: { space: { view: {} }, automations: { list: {} } } }));
vi.mock('../live-notices.js', async (importOriginal) => ({ ...await importOriginal<typeof LiveNotices>(), useLiveChanges: () => null }));
vi.mock('../SynchronizationProvider.js', async (importOriginal) => ({ ...await importOriginal<typeof Synchronization>(), useProjectChanges: () => null }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  reads.refetch.mockClear();
});

it('reads a listed project\'s graph again on request and settles once the read ended; an unlisted one settles at once', async () => {
  const hook: { refresh?: (projectId: string) => Promise<void> } = {};
  function Graphs() {
    const graphs = useProjectGraphs(['bakery']);
    hook.refresh = graphs.refresh;
    return <>{graphs.readers}</>;
  }
  await act(() => root.render(<Graphs />));
  expect(reads.refetch).not.toHaveBeenCalled();
  // React renders the request once the first act ends; the read it starts settles the promise.
  let read: Promise<void> | undefined;
  await act(async () => { read = hook.refresh?.('bakery'); });
  await act(async () => { await read; });
  // The project view, read again; its automations are not.
  expect(reads.refetch).toHaveBeenCalledTimes(1);
  await act(async () => { await hook.refresh?.('elsewhere'); });
  expect(reads.refetch).toHaveBeenCalledTimes(1);
});
