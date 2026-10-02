// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RepositoryMode, RepositoryTreeEntry } from '@gitspace/protocol';
import { useRepositoryTree } from './useRepositoryTree.js';
import { useRetainedQueryValue } from './useRetainedRead.js';

const tree = vi.hoisted(() => vi.fn());
vi.mock('./rpc-client.js', () => ({ rpcClient: { inspector: { repository: { tree } } } }));
let root: Root;
let container: HTMLDivElement;
let refresh: () => Promise<void>;
function View({ mode = 'current' }: { mode?: RepositoryMode }) {
  const query = useRepositoryTree('space', 7, mode, 'scope', true);
  const entries = useRetainedQueryValue(query, mode);
  refresh = query.refetch;
  return <div><span>{query.state}</span><output>{entries?.map((entry) => entry.path).join(',') ?? 'unavailable'}</output>{query.state === 'failure' ? <p role="alert">{query.error.message}</p> : null}</div>;
}
function entry(path: string): RepositoryTreeEntry {
  return { spaceId: 'space', generation: 7, mode: 'current', path, name: path, kind: 'file', status: 'clean', oldPath: null, blobId: null, size: null };
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  tree.mockReset();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('publishes complete snapshots, retains accepted files after a partial failure, and retries', async () => {
  const finish = Promise.withResolvers<void>();
  tree.mockImplementationOnce(async function* () {
    yield { status: 'success', value: [entry('first.ts')] };
    await finish.promise;
    yield { status: 'success', value: [entry('second.ts')] };
  });
  await act(async () => root.render(<View />));
  expect(container.querySelector('output')?.textContent).toBe('unavailable');
  await act(async () => { const pending = refresh(); finish.resolve(); await pending; });
  expect(tree).toHaveBeenCalledTimes(1);
  expect(container.querySelector('output')?.textContent).toBe('first.ts,second.ts');
  tree.mockImplementationOnce(async function* () {
    yield { status: 'success', value: [entry('incomplete.ts')] };
    yield { status: 'error', error: new Error('Repository interrupted') };
  });
  await act(async () => refresh());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('Repository interrupted');
  expect(container.querySelector('output')?.textContent).toBe('first.ts,second.ts');
  tree.mockImplementationOnce(async function* () { yield { status: 'success', value: [entry('retried.ts')] }; });
  await act(async () => refresh());
  expect(container.querySelector('output')?.textContent).toBe('retried.ts');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

it('aborts and ignores the previous comparison stream when the selected mode changes', async () => {
  const finish = Promise.withResolvers<void>();
  let oldSignal: AbortSignal | undefined;
  tree.mockImplementationOnce(async function* (_input, options: { signal: AbortSignal }) {
    oldSignal = options.signal;
    await finish.promise;
    yield { status: 'success', value: [entry('stale.ts')] };
  });
  tree.mockImplementationOnce(async function* () { yield { status: 'success', value: [{ ...entry('staged.ts'), mode: 'staged' }] }; });
  await act(async () => root.render(<View />));
  const oldRead = refresh();
  await act(async () => root.render(<View mode="staged" />));
  expect(oldSignal?.aborted).toBe(true);
  await act(async () => { finish.resolve(); await oldRead; });
  expect(container.querySelector('output')?.textContent).toBe('staged.ts');
  expect(container.textContent).not.toContain('stale.ts');
});

it('accepts an empty completed repository rather than remaining unavailable', async () => {
  tree.mockImplementationOnce(async function* () { yield { status: 'success', value: [] }; });
  await act(async () => root.render(<View />));
  expect(container.querySelector('span')?.textContent).toBe('success');
  expect(container.querySelector('output')?.textContent).toBe('');
});
