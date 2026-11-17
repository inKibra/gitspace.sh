// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepositoryDiffView, ReviewThreadView } from '@gitspace/protocol';
import { Toasts } from '../toasts.js';
import { Inspector, type InspectorProps } from './Inspector.js';
import { RuntimeSubagentRecordSchema } from '@gitspace/protocol-runtime';

vi.mock('@pierre/diffs', async (importOriginal) => {
  const actual: object = await importOriginal();
  /** Stands in for Pierre's viewer: one button that ends a selection on the first old line. */
  class FileDiff {
    button = document.createElement('button');
    options: { onLineSelectionEnd(range: unknown): void };
    constructor(options: { onLineSelectionEnd(range: unknown): void }) { this.options = options; }
    hydrate({ fileContainer }: { fileContainer: HTMLElement }) {
      this.button.textContent = 'Select old line';
      this.button.onclick = () => this.options.onLineSelectionEnd({ side: 'deletions', start: 1, end: 1 });
      fileContainer.append(this.button);
    }
    render() { return true; }
    setThemeType() {}
    cleanUp() { this.button.remove(); }
  }
  return { ...actual, FileDiff };
});
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
async function render() { await act(async () => root.render(<Toasts><Inspector {...props} /></Toasts>)); }
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
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal: null, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 }, changeGuide: { projectId: 'project', spaceId: 'space', revision: 1, headCommit: diff.headCommit, baseRef: 'main', baseCommit: 'c'.repeat(40), title: 'Guide', createdAt: date, createdBy: 'author', reviewerStates: [], sections: [{ id: 'section', title: 'Behavior', kind: 'behavior', explanation: 'Changed behavior', why: '', requirementIds: [], exhibits: [{ path: 'file.ts', blobId: null, note: '', slowRead: false }] }] } },
    initialView: 'guide', workspaces: [], onSelectWorkspace() {}, repositoryEntries: [], repositoryMode: 'current', onRepositoryModeChange() {}, repositoryFile: null, repositoryDiff: null, journalEntries: [], threads: [], services: [], subagents: [],
    usage: { sessionId: null, report: null, status: 'idle', load() {}, refresh() {} }, agentSetup: { sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }, reviewerId: 'reviewer', onRequestArtifact: unavailable, onRequestRepositoryFile() {}, onRequestRepositoryDiff() {}, onLoadGuideDiff: async () => diff, onMarkGuideSectionRead: unavailable,
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); });

describe('Inspector review threads, retired', () => {
  const thread: ReviewThreadView = {
    projectId: 'project', spaceId: 'space', id: 'thread', revision: 2, anchorState: 'current', staleReason: null, decision: 'approved', resolved: true, createdAt: date, updatedAt: date,
    anchor: { kind: 'line', path: 'file.ts', generation: 7, baseCommit: diff.baseCommit, headCommit: diff.headCommit, blobId: diff.files[0]!.oldBlobId, side: 'base', startLine: 1, endLine: 1 },
    messages: [{ id: 'first', authorId: 'reviewer', body: 'Keep this context', createdAt: date }, { id: 'second', authorId: 'agent', body: 'Kept.', createdAt: date }],
  };

  it('shows an older thread on its guide line read-only, and selecting lines starts no thread', async () => {
    props = { ...props, threads: [thread] };
    await render();
    // The thread's mark on its line shows how many messages it holds.
    await click('2');
    expect(container.textContent).toContain('Review thread · read-only');
    expect(container.textContent).toContain('Keep this context');
    expect(container.textContent).toContain('Kept.');
    expect(container.textContent).toContain('Resolved');
    expect(container.querySelector('textarea')).toBeNull();
    expect([...container.querySelectorAll('button')].map((node) => node.textContent)).not.toContain('Resolve');
    await click('Select old line');
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('New review thread');
  });

  it('offers no thread on a line selected in Files, and still shows an older one there read-only', async () => {
    props = { ...props, threads: [thread], initialView: 'files', repositoryMode: 'base', repositoryEntries: [{ spaceId: 'space', generation: 7, mode: 'base', path: 'file.ts', name: 'file.ts', kind: 'file', status: 'modified', oldPath: null, blobId: null, size: null }], repositoryDiff: diff };
    await render(); await click('Open file.ts');
    await click('Select old line');
    expect(container.querySelector('textarea')).toBeNull();
    await click('2');
    expect(container.textContent).toContain('Review thread · read-only');
    expect(container.querySelector('textarea')).toBeNull();
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
      root.render(<Toasts><Inspector {...props} /></Toasts>);
    });
    props = { ...props, initialView: 'environment', environment: () => <button>Configure environment</button>, sectionErrors: { files: { message: 'Repository read failed (incident repo-123)', retained: false, retry } } };
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
    expect(container.querySelector('section[aria-label="Notifications"] [role="alert"]')?.textContent).toContain('Repository refresh unavailable');
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

it('offers a scoped Stop only for active subagents and keeps their inspection read only', async () => {
  const stop = async (id: string) => {
    props = { ...props, subagents: props.subagents.map(agent => agent.type === 'side-agent' && agent.agentId === id ? { ...agent, status: 'done' } : agent) };
    root.render(<Toasts><Inspector {...props} /></Toasts>);
  };
  props = { ...props, initialView: 'subagents', subagents: [
    { id: 'agent:a', type: 'side-agent', agentId: 'a', label: 'Research A', status: 'running', messages: [{ id: 'a-text', type: 'message', role: 'assistant', text: 'Read-only child transcript' }] },
    { id: 'agent:b', type: 'side-agent', agentId: 'b', label: 'Research B', status: 'running' },
  ], onStopSubagent: stop };
  await render();
  const first = container.querySelector<HTMLButtonElement>('button[aria-label="Stop Research A"]');
  expect(first).not.toBeNull();
  await act(async () => { first!.click(); });
  expect(container.querySelector('button[aria-label="Stop Research A"]')).toBeNull();
  expect(container.querySelector('button[aria-label="Stop Research B"]')).not.toBeNull();
  expect(container.querySelector('textarea')).toBeNull();
  expect(container.textContent).toContain('Read-only child transcript');
});

it('does not advertise an empty legacy service count for the runtime inventory', async () => {
  props = { ...props, initialView: 'services', runtimeServices: <p>Services across machine caches</p> };
  await render();
  const tab = [...container.querySelectorAll('[role="tab"]')].find(item => item.textContent?.startsWith('Services'));
  expect(tab).toBeDefined();
  expect(tab?.textContent).not.toContain(' · 0');
  expect(container.textContent).toContain('Services across machine caches');
});

it('shows a compact retained revision while copying the full identity', async () => {
  const revision = '1234567890abcdef'.repeat(4);
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const runtime = RuntimeSubagentRecordSchema.parse({ parentId: 'root', name: 'Boundary reviewer', attemptId: 'spawn', role: 'scout', selection: { kind: 'role', role: 'scout' }, thinking: null, tools: ['read'], model: { provider: 'anthropic', modelId: 'claude-sonnet-4' }, definition: { name: 'Repository Scout', description: '', source: 'workspace', path: '.agents/agents/repository.md', editable: true, content: 'Review', revision, modelSelectors: ['pi/scout'], role: 'scout', provider: 'anthropic', model: 'claude-sonnet-4', thinking: null, selection: 'definition', tools: ['read'], spawns: null } });
  props = { ...props, initialView: 'subagents', subagents: [{ id: 'agent:child', type: 'side-agent', agentId: 'child', label: runtime.name, agent: runtime.role ?? undefined, model: 'anthropic / claude-sonnet-4', status: 'done', runtime }] };
  await render();
  const revisionLabel = [...container.querySelectorAll('dt')].find(element => element.textContent === 'Definition revision');
  const revisionValue = revisionLabel?.nextElementSibling;
  expect(revisionValue?.textContent).toContain(revision.slice(0, 8));
  expect(revisionValue?.textContent).not.toContain(revision);
  expect(revisionValue?.querySelector('[title]')?.getAttribute('title')).toBe(revision);
  const copy = revisionValue?.querySelector('button');
  expect(copy).not.toBeNull();
  await act(async () => { copy!.click(); });
  expect(writeText).toHaveBeenCalledWith(revision);
  expect(container.querySelector('[aria-label="Role"]')?.textContent).toContain('scout');
  expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain('claude-sonnet-4');
  expect(container.querySelector('[aria-label="Model"]')?.textContent).toContain('anthropic');
  writeText.mockRestore();
});
