// @vitest-environment happy-dom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PierreViewer } from './FilesSurface.js';

const identity = { generation: 7, baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), blobId: 'c'.repeat(40) };
const patch = 'diff --git a/retry.ts b/retry.ts\n--- a/retry.ts\n+++ b/retry.ts\n@@ -1,2 +1,2 @@\n export function sendWithRetry() {\n-  return retryThreeTimes();\n+  return retryOnce();\n';
let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.unstubAllGlobals(); });

it('draws the file on first open under StrictMode, which mounts the viewer twice', async () => {
  await act(async () => root.render(<StrictMode><PierreViewer path="retry.ts" identities={{ base: identity, head: identity }} patch={patch} threads={[]} onSelectThread={() => undefined} /></StrictMode>));
  // Pierre draws into its container's shadow root.
  await vi.waitFor(() => {
    const drawn = container.querySelector('diffs-container')?.shadowRoot?.textContent ?? '';
    expect(drawn).toContain('retryOnce');
    expect(drawn).toContain('retryThreeTimes');
  }, { timeout: 5_000 });
});

it('draws the code in the page\'s scheme and switches it in place when the appearance changes', async () => {
  document.documentElement.classList.add('dark');
  try {
    await act(async () => root.render(<StrictMode><PierreViewer path="retry.ts" identities={{ base: identity, head: identity }} patch={patch} threads={[]} onSelectThread={() => undefined} /></StrictMode>));
    const host = container.querySelector('diffs-container');
    await vi.waitFor(() => {
      expect(host?.shadowRoot?.textContent ?? '').toContain('retryOnce');
      expect(host?.shadowRoot?.innerHTML ?? '').toContain('color-scheme: dark');
    }, { timeout: 5_000 });
    await act(async () => { document.documentElement.classList.replace('dark', 'light'); });
    await vi.waitFor(() => expect(host?.shadowRoot?.innerHTML ?? '').toContain('color-scheme: light'), { timeout: 5_000 });
    expect(container.querySelector('diffs-container')).toBe(host);
  } finally {
    document.documentElement.classList.remove('dark', 'light');
  }
});
