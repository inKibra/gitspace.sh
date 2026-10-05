// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryDiffView, ReviewThreadView } from '@gitspace/protocol';
import { Inspector, type InspectorProps } from './Inspector.js';

vi.mock('@pierre/diffs/react', () => ({ FileDiff: ({ options }: { options: { onLineSelectionEnd(range: unknown): void } }) => <button onClick={() => options.onLineSelectionEnd({ side: 'deletions', start: 1, end: 1 })}>Select old line</button> }));
vi.mock('@pierre/trees/react', () => ({
  useFileTree: ({ onSelectionChange }: { onSelectionChange(paths: string[]): void }) => ({ model: { resetPaths() {}, setGitStatus() {}, open: () => onSelectionChange(['file.ts']) } }),
  FileTree: ({ model }: { model: { open(): void } }) => <button onClick={model.open}>Open file.ts</button>,
}));
const date = '2026-01-01T00:00:00.000Z';
const diff: RepositoryDiffView = { spaceId: 'space', generation: 7, mode: 'base', path: 'file.ts', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), patch: 'diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n', files: [{ path: 'file.ts', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, oldBlobId: 'c'.repeat(40), newBlobId: 'd'.repeat(40) }] };
let root: Root;
let container: HTMLDivElement;
let props: InspectorProps;
let animationDescriptor: PropertyDescriptor | undefined;
const unavailable = async (): Promise<never> => { throw new Error('Unexpected action'); };
async function render() { await act(async () => root.render(<Inspector {...props} />)); }
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label || (node.getAttribute('role') === 'tab' && node.textContent?.includes(label)));
  expect(button).toBeDefined();
  await act(async () => button!.click());
}
async function draft(text: string) {
  const textarea = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: unknown[]) => void) {} observe() { this.callback([{ isIntersecting: true }]); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = {
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal: null, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 }, changeGuide: { projectId: 'project', spaceId: 'space', revision: 1, headCommit: diff.headCommit, baseRef: 'main', title: 'Guide', createdAt: date, createdBy: 'author', reviewerStates: [], sections: [{ id: 'section', title: 'Behavior', kind: 'behavior', explanation: 'Changed behavior', why: '', requirementIds: [], exhibits: [{ path: 'file.ts', blobId: null, note: '', slowRead: false }] }] } },
    initialView: 'guide', workspaces: [], onSelectWorkspace() {}, repositoryEntries: [], repositoryMode: 'current', onRepositoryModeChange() {}, repositoryFile: null, repositoryDiff: null, journalEntries: [], threads: [], services: [], subagents: [],
    usage: { sessionId: null, report: null, status: 'idle', load() {}, refresh() {} }, agentSetup: { sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }, reviewerId: 'reviewer', onRequestArtifact: unavailable, onRequestRepositoryFile() {}, onRequestRepositoryDiff() {}, onLoadRepositoryDiff: async () => diff, onCreateThread: unavailable, onReplyThread: unavailable, onResolveThread: unavailable, onMarkGuideSectionRead: unavailable, onSetGuideApproval: unavailable,
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); });

describe('Inspector review comments', () => {
  it('pins guide selection to its loaded side, preserves failed drafts, and follows saved thread revisions', async () => {
    const pending = Promise.withResolvers<ReviewThreadView>();
    const create = vi.fn<InspectorProps['onCreateThread']>(() => pending.promise);
    props.onCreateThread = create;
    await render();
    await click('Select old line');
    await draft('Keep this context');
    await click('Start thread');
    expect(container.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[0]).toMatchObject({ anchor: { kind: 'line', path: 'file.ts', generation: 7, baseCommit: diff.baseCommit, headCommit: diff.headCommit, blobId: diff.files[0]!.oldBlobId, side: 'base', startLine: 1, endLine: 1 } });
    await act(async () => pending.reject(new Error('Review unavailable')));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Review unavailable');
    expect(container.querySelector('textarea')?.value).toBe('Keep this context');
    const saved: ReviewThreadView = { projectId: 'project', spaceId: 'space', id: 'thread', revision: 1, anchor: create.mock.calls[0]![0].anchor, anchorState: 'current', staleReason: null, decision: 'pending', resolved: false, messages: [{ id: 'first', authorId: 'reviewer', body: 'Keep this context', createdAt: date }], createdAt: date, updatedAt: date };
    props.onCreateThread = async () => { props = { ...props, threads: [saved] }; root.render(<Inspector {...props} />); return saved; };
    await render();
    await click('Start thread');
    expect(container.querySelector('textarea')?.getAttribute('aria-label')).toBe('Reply to review thread');
    props = { ...props, threads: [{ ...saved, revision: 2, messages: [...saved.messages, { id: 'second', authorId: 'other', body: 'New reply', createdAt: date }] }], onReplyThread: vi.fn(async () => {}), onResolveThread: vi.fn(async () => {}) };
    await render();
    expect(container.textContent).toContain('New reply');
    await draft('Follow up'); await click('Reply');
    expect(props.onReplyThread).toHaveBeenCalledWith('thread', 2, 'Follow up');
    await click('Resolve');
    expect(props.onResolveThread).toHaveBeenCalledWith('thread', 2, true, 'pending');
  });

  it('does not render a response for another comparison mode', async () => {
    props = { ...props, initialView: 'files', repositoryMode: 'working', repositoryEntries: [{ spaceId: 'space', generation: 7, mode: 'working', path: 'file.ts', name: 'file.ts', kind: 'file', status: 'modified', oldPath: null, blobId: null, size: null }], repositoryDiff: diff };
    await render(); await click('Open file.ts');
    expect(container.textContent).not.toContain('Select old line');
    props = { ...props, repositoryDiff: { ...diff, mode: 'working' } }; await render();
    expect(container.textContent).toContain('Select old line');
  });
});

describe('Inspector independent reads', () => {
  it('keeps Environment usable when Files fails and retries the failed section', async () => {
    const retry = vi.fn(() => {
      props = { ...props, sectionErrors: {}, repositoryEntries: [{ spaceId: 'space', generation: 7, mode: 'current', path: 'file.ts', name: 'file.ts', kind: 'file', status: 'clean', oldPath: null, blobId: null, size: null }] };
      root.render(<Inspector {...props} />);
    });
    props = { ...props, initialView: 'environment', environment: <button>Configure environment</button>, sectionErrors: { files: { message: 'Repository read failed (incident repo-123)', retained: false, retry } } };
    await render();
    await click('Configure environment');
    expect(container.textContent).not.toContain('Inspector could not load');
    await click('Files');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Repository read failed (incident repo-123)');
    expect(container.textContent).not.toContain('Repository unavailable');
    await click('Retry Files');
    expect(retry).toHaveBeenCalledTimes(1);
    await click('Open file.ts');
    await click('Environment');
    await click('Configure environment');
  });

  it('keeps accepted repository data available during a failed refresh', async () => {
    const retry = vi.fn();
    props = {
      ...props, initialView: 'files',
      repositoryEntries: [{ spaceId: 'space', generation: 7, mode: 'current', path: 'file.ts', name: 'file.ts', kind: 'file', status: 'clean', oldPath: null, blobId: null, size: null }],
      sectionErrors: { files: { message: 'Repository refresh unavailable', retained: true, retry } },
    };
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Repository refresh unavailable');
    await click('Retry Files');
    expect(retry).toHaveBeenCalledTimes(1);
    await click('Open file.ts');
    expect(container.textContent).toContain('Loading repository view');
  });
});

it('shows saved held-back paths while offline even when the sanitized working diff has no files', async () => {
  const open = vi.fn();
  props = { ...props, initialView: 'files', runtimeAvailable: false, repositoryMode: 'working', repositoryEntries: [], lfsHeldBack: [{ path: 'assets/offline.psd', kind: 'modified' }], onRequestRepositoryDiff: open };
  await render();
  expect(container.textContent).toContain('assets/offline.psd');
  expect(container.textContent).toContain('Only on this machine');
  expect(container.textContent).toContain('LFS changes leave this machine only after a commit');
  await click('assets/offline.psd');
  expect(open).toHaveBeenCalledWith('assets/offline.psd', 'working');
});

it('does not label committed comparisons as machine-local changes', async () => {
  props = { ...props, initialView: 'files', repositoryMode: 'base', lfsHeldBack: [{ path: 'assets/offline.psd', kind: 'staged' }] };
  await render();
  expect(container.textContent).not.toContain('Only on this machine');
  expect(container.textContent).not.toContain('assets/offline.psd');
});
