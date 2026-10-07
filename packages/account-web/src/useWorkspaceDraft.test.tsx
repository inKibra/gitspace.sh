// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import type { WorkspaceDraftSave, WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';
import { useWorkspaceDraft } from './useWorkspaceDraft.js';
import type { WorkspaceDraftBinding } from './workspace-draft.js';
vi.mock('./device-session.js', () => ({ currentDevice: async () => ({ deviceId: 'enrolled-device', userId: 'user' }) }));
let root: Root;
let container: HTMLDivElement;
let binding: WorkspaceDraftBinding | undefined;
const saved: Record<string, string> = {};
function View({ workspaceId }: { workspaceId: string }) {
  const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: 'project', workspaceId, cursor: 0, conversations: [], tasks: [], attachments: [], questions: [], documents: { 'gitspace.draft': { text: `${workspaceId} cloud`, revision: 0, updatedAt: null, deviceId: null } } });
  binding = useWorkspaceDraft(snapshot, true, async (input: WorkspaceDraftSave): Promise<WorkspaceDraftSaveResult> => {
    saved[workspaceId] = input.text;
    return { status: 'saved', draft: { text: input.text, revision: input.expectedRevision + 1, updatedAt: new Date().toISOString(), deviceId: 'enrolled-device' } };
  });
  return <p>{binding?.text}</p>;
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.useFakeTimers(); localStorage.clear();
  for (const key of Object.keys(saved)) delete saved[key];
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('debounces text and flushes blur before switching workspace without carrying text across', async () => {
  await act(async () => { root.render(<View workspaceId="a" />); }); expect(container.textContent).toBe('a cloud');
  await act(async () => { binding?.onChange('typed A'); }); await act(async () => { await vi.advanceTimersByTimeAsync(999); }); expect(saved.a).toBeUndefined();
  await act(async () => { binding?.onBlur(); }); expect(saved.a).toBe('typed A');
  await act(async () => { root.render(<View workspaceId="b" />); }); expect(container.textContent).toBe('b cloud');
  await act(async () => { binding?.onChange('typed B'); }); await act(async () => { await vi.advanceTimersByTimeAsync(1000); }); expect(saved.b).toBe('typed B'); expect(saved.a).toBe('typed A');
});
it('flushes a hidden page without waiting for the debounce', async () => {
  await act(async () => { root.render(<View workspaceId="hidden" />); }); await act(async () => { binding?.onChange('leave safely'); });
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')); }); expect(saved.hidden).toBe('leave safely');
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});
