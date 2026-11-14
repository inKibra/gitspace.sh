// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { act, type ReactNode } from 'react';
import type * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InspectorView } from '@gitspace/protocol';
import { InspectorViewCodec } from '@gitspace/protocol/rpc-contract';
import { cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema } from '@gitspace/protocol/project-authority';
import { RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import type * as Device from './device.js';
import { flushFirstPaintCache, openFirstPaintCache, savedCopy, schemaForm, workspaceGroup } from './first-paint-cache.js';
import { savedTranscriptSchema } from './transcriptHistoryCache.js';

type Answer = { status: 'ok'; value: unknown } | { status: 'error'; error: unknown };
type Procedure = ((input: unknown) => Promise<Answer>) & { path: string };

/** Every RPC the page makes, by procedure path; none answers unless a test gives it an answer. */
const rpc = vi.hoisted(() => {
  const calls: Array<{ path: string; input: unknown }> = [];
  const answers = new Map<string, () => Promise<unknown>>();
  const nodes = new Map<string, object>();
  const node = (path: string): object => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const created = new Proxy(function procedure() {}, {
      get: (_target, property) => property === 'path' ? path : typeof property === 'string' && property !== 'then' ? node(path ? `${path}.${property}` : property) : undefined,
      apply: (_target, _this, args: unknown[]) => {
        calls.push({ path, input: args[0] });
        return answers.get(path)?.() ?? Promise.withResolvers<never>().promise;
      },
    });
    nodes.set(path, created);
    return created;
  };
  return { calls, answers, client: node('') };
});
const device = vi.hoisted(() => ({ deviceId: 'device-a', userId: 'user-a', label: 'Test browser', publicKey: 'key', keyPair: {}, enrolledAt: 0, enrollUrl: 'https://example.gitspace.sh', canDelegate: false }));

vi.mock('./rpc-client.js', () => ({ homeRpcUrl: '/rpc', rpcClient: rpc.client, appUpdate: { subscribe: () => () => {}, current: () => false } }));
vi.mock('./device.js', async (importOriginal) => ({ ...await importOriginal<typeof Device>(), loadDevice: async () => device }));
// The account directory socket never opens in these tests: nothing the workspace shows may wait for it.
vi.mock('./account-directory-transport.js', () => ({ accountDirectorySource: async function* (): AsyncGenerator<never> { await Promise.withResolvers<void>().promise; } }));
vi.mock('result-rpc/react', async () => {
  const { useEffect, useState } = await vi.importActual<typeof React>('react');
  return {
    ResultRpcProvider: ({ children }: { children: ReactNode }) => children,
    useResultRuntime: () => ({ cache: { key: (procedure: Procedure, input: unknown) => [procedure.path, JSON.stringify(input)] } }),
    useResultMutation: () => ({ state: 'idle', mutateAsync: async () => ({ status: 'error', error: new Error('No mutation runs in this test') }) }),
    useResultQuery: (procedure: Procedure, input: unknown, options: { enabled?: boolean } = {}) => {
      const enabled = options.enabled ?? true;
      const key = JSON.stringify([procedure.path, input]);
      const [read, setRead] = useState<{ key: string; state: object }>({ key, state: { state: 'pending', fetch: 'fetching' } });
      useEffect(() => {
        if (!enabled) return;
        let live = true;
        void procedure(input).then((answer) => {
          if (live) setRead({ key, state: answer.status === 'ok' ? { state: 'success', value: answer.value, fetch: 'idle' } : { state: 'failure', error: answer.error, fetch: 'idle' } });
        });
        return () => { live = false; };
      }, [key, enabled]);
      return { ...(read.key === key ? read.state : { state: 'pending', fetch: 'fetching' }), refetch: async () => {} };
    },
  };
});

const stamp = '2026-11-14T00:00:00.000Z';
const project = cloudProjectSummarySchema.parse({ id: 'project', name: 'Project', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, archivedAt: null, updatedAt: stamp });
const workspace = cloudWorkspaceDefinitionSchema.parse({ id: 'workspace', projectId: project.id, kind: 'worktree', name: 'Work', branch: 'work', phase: 'code', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, revision: 1, archivedAt: null, createdAt: stamp, updatedAt: stamp });
const inspection: InspectorView = {
  identity: { projectId: project.id, spaceId: workspace.id },
  project, workspace, workspaces: [workspace], machines: [], placement: null,
  overview: { projectId: project.id, spaceId: workspace.id, revision: 1, goal: null, workflow: null, rubric: null, changeGuide: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 } },
  artifacts: [], creation: null,
};
const snapshot = RuntimeSnapshotSchema.parse({ version: 1, projectId: project.id, workspaceId: workspace.id, cursor: 4, conversations: [{ id: 'main', parentId: null, title: 'Workspace agent', status: 'waiting', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} });
const savedRows = savedTranscriptSchema.parse({
  generation: 'generation-a', revision: 4, hasBefore: false, hasAfter: false, total: 2,
  rows: [
    { id: 'row-1', ordinal: 1, turnId: 'turn-1', turnStatus: 'done', truncated: false, contentBytes: 20, item: { id: 'row-1', type: 'message', role: 'user', text: 'Saved question' } },
    { id: 'row-2', ordinal: 2, turnId: 'turn-1', turnStatus: 'done', truncated: false, contentBytes: 20, item: { id: 'row-2', type: 'message', role: 'assistant', text: 'Saved reply from last visit' } },
  ],
});

let root: Root | null = null;
let container: HTMLDivElement;

/** A page load: the app's modules evaluate afresh, so nothing is in memory that IndexedDB did not save. Imported
 * dynamically because each test is a new page load of the same module graph. */
async function load(): Promise<void> {
  vi.resetModules();
  const { LiveApp } = await import('./LiveApp.js');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root?.render(<LiveApp />); });
}

const issued = (path: string) => rpc.calls.filter((call) => call.path === path);
const transcriptPages = () => issued('runtime.session').filter((call) => JSON.stringify(call.input).includes('"transcriptPage"'));

/** Each test evaluates the whole app afresh; beside the rest of the suite that alone can take seconds. */
const PAGE_LOAD_MS = 20_000;
vi.setConfig({ testTimeout: 30_000 });
beforeEach(() => {
  // The page loads the way a browser does: device, IndexedDB and replies settle outside act, and assertions wait.
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
  vi.stubGlobal('indexedDB', new IDBFactory());
  if (!Element.prototype.getAnimations) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  rpc.calls.length = 0;
  rpc.answers.clear();
  window.history.replaceState(null, '', `/?project=${project.id}&workspace=${workspace.id}`);
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  container.remove();
  vi.unstubAllGlobals();
});

it('requests the workspace’s reads while the account settings batch is still unanswered', async () => {
  await load();
  await vi.waitFor(() => expect(issued('runtime.watch')).toHaveLength(1), { timeout: PAGE_LOAD_MS });
  expect(issued('settings.state')).toHaveLength(1);
  expect(issued('inference.list')).toHaveLength(1);
  expect(issued('inspector.view').map((call) => call.input)).toContainEqual({ projectId: project.id, workspaceId: workspace.id });
  expect(issued('space.view').map((call) => call.input)).toContainEqual({ projectId: project.id, workspaceId: workspace.id });
  expect(issued('runtime.watch')[0]?.input).toMatchObject({ projectId: project.id, workspaceId: workspace.id, after: null });
});

it('requests the transcript page before runtime.watch answers', async () => {
  await load();
  await vi.waitFor(() => expect(transcriptPages()).toHaveLength(1), { timeout: PAGE_LOAD_MS });
  // runtime.watch never answers in this test: the page did not wait for it, or for a snapshot naming the conversation.
  expect(issued('runtime.watch')).toHaveLength(1);
  expect(transcriptPages()[0]?.input).toMatchObject({ projectId: project.id, workspaceId: workspace.id, command: { type: 'transcriptPage' } });
});

it('paints the saved transcript on a reload before any request answers', async () => {
  const group = workspaceGroup(project.id, workspace.id);
  await openFirstPaintCache(JSON.stringify([window.location.origin, device.userId]), [group]);
  savedCopy(group, 'runtime', schemaForm(RuntimeSnapshotSchema)).write(snapshot);
  savedCopy(group, 'inspection', InspectorViewCodec).write(inspection);
  savedCopy(group, 'transcript', schemaForm(savedTranscriptSchema)).write(savedRows);
  await flushFirstPaintCache();

  await load();
  await vi.waitFor(() => expect(container.textContent).toContain('Saved reply from last visit'), { timeout: PAGE_LOAD_MS });
  expect(container.querySelector('nav[aria-label="Location"] [role="status"]')?.getAttribute('aria-label')).toContain('Showing the copy saved in this browser');
  expect(container.textContent).not.toContain('Loading workspace…');
  expect(rpc.answers.size).toBe(0);
  expect(transcriptPages()[0]?.input).toMatchObject({ conversationId: 'main' });
});

it('ends the loading state with a way out when the workspace is not in the linked project', async () => {
  // The page's own module graph defines the tagged errors it recognises: each page load evaluates it afresh.
  rpc.answers.set('inspector.view', async () => ({ status: 'error', error: (await import('@gitspace/protocol/rpc-contract')).rpcErrors.workspaceNotFound({ workspaceId: workspace.id }) }));
  rpc.answers.set('runtime.watch', async () => ({ status: 'error', error: new Error('Workspace does not belong to the requested project') }));
  await load();
  await vi.waitFor(() => expect(container.textContent).toContain('Workspace not found'), { timeout: PAGE_LOAD_MS });
  expect(container.textContent).not.toContain('Loading workspace…');
  const exits = [...container.querySelectorAll('button')].map((button) => button.textContent);
  expect(exits).toContain('Back to the project');
  expect(exits).toContain('All projects');
});
