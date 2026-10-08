// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import { InferenceProvider, useInference } from './InferenceContext.js';
import { InferencePage } from './InferencePage.js';
import { Composer } from './Composer.js';

const query = vi.hoisted(() => ({ state: 'failure', error: undefined as unknown, refetch: vi.fn(async () => undefined) }));
vi.mock('./SynchronizationProvider.js', () => ({ useAccountInference: () => query }));
vi.mock('./rpc-client.js', () => ({ rpcClient: {} }));
function Page() {
  const inference = useInference();
  if (!inference) throw new Error('Missing provider');
  return <InferencePage onboarding inference={inference} selectedProfileId="default" onSelectProfile={() => undefined} projects={[]} schema={[]} schemaLoading={false} schemaError={null} onRefreshSchema={() => undefined} models={[]} modelsReady={false} modelsLoading={false} modelsError={null} providers={{ providers: [], usage: null, usageStatus: 'idle', onShow: () => undefined, onRefreshUsage: async () => undefined, onSignIn: async () => undefined, onSignOut: async () => undefined, onSetApiKey: async () => undefined, login: { flow: null, respond: async () => undefined, cancel: async () => undefined } }} />;
}
afterEach(() => vi.unstubAllGlobals());
it('presents health verification as a wait with retry, not a raw error or editable profiles', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.error = rpcErrors.inferenceActivationPending({});
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<InferenceProvider><Page /></InferenceProvider>));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    expect(container.textContent).not.toContain('gitspace/inference-activation-pending');
    expect(container.querySelector('input, textarea')).toBeNull();
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Check again');
    expect(retry).toBeDefined();
    await act(() => retry!.click());
    expect(query.refetch).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});

it('keeps the workspace composer in a neutral activation wait with retry and sending disabled', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  query.error = rpcErrors.inferenceActivationPending({});
  query.refetch.mockClear();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(() => root.render(<InferenceProvider><Composer workspace={{ projectId: 'project', kind: 'workspace', phase: 'code' }} running={false} pending={false} onSend={async () => undefined} /></InferenceProvider>));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Verifying the new release…');
    expect(container.textContent).not.toContain('assignment is unavailable');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Check again');
    expect(retry).toBeDefined();
    await act(() => retry!.click());
    expect(query.refetch).toHaveBeenCalledOnce();
  } finally {
    await act(() => root.unmount());
    container.remove();
  }
});
