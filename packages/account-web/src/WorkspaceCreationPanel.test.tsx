// @vitest-environment happy-dom
import type { InspectorView } from '@gitspace/protocol';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkspaceCreationPanel } from './WorkspaceCreationPanel.js';

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
});

const creation: NonNullable<InspectorView['creation']> = {
  operationId: 'operation', state: 'failed', error: null, updatedAt: '2026-09-30T00:00:00.000Z',
  steps: [
    { id: 'checkout', label: 'Create worktree', state: 'succeeded', message: null },
    { id: 'agent', label: 'Start agent', state: 'failed', message: 'Agent runtime is unavailable.' },
  ],
};

function buttons(): string[] {
  return Array.from(container.querySelectorAll('button'), (button) => button.textContent ?? '');
}

it('offers only Retry and Delete for a failed creation and shows the Retry failure reason inline', async () => {
  const retry = Promise.withResolvers<void>();
  const onRetry = vi.fn(() => retry.promise);
  await act(() => root.render(<WorkspaceCreationPanel name="feature" state="failed" creation={creation} onRetry={onRetry} onDelete={async () => undefined} />));
  expect(container.textContent).toContain('Workspace creation failed');
  expect(container.textContent).toContain('Agent runtime is unavailable.');
  expect(container.textContent).toContain('Create worktree');
  expect(buttons()).toEqual(['Retry', 'Delete']);
  expect(buttons().some((label) => /open/iu.test(label))).toBe(false);

  const retryButton = container.querySelector<HTMLButtonElement>('button')!;
  await act(() => retryButton.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(true);
  expect(buttons()[0]).toContain('Retrying…');

  await act(async () => retry.reject(rpcErrors.operationFailed({ operation: 'retry workspace creation', message: 'The repository could not be cloned.' })));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('The repository could not be cloned.');
  expect(container.querySelector<HTMLButtonElement>('button')!.disabled).toBe(false);
});
