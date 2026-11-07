// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntryView } from '@gitspace/protocol';
import { Inspector, type InspectorProps } from './Inspector.js';
import { InspectorLayout } from './inspector-shared.js';
import type { DriveFileView } from './DriveSurface.js';

vi.mock('@pierre/trees/react', () => ({
  useFileTree: ({ onSelectionChange }: { onSelectionChange(paths: string[]): void }) => ({ model: { resetPaths() {}, setGitStatus() {}, open: () => onSelectionChange(['file.ts']) } }),
  FileTree: ({ model }: { model: { open(): void } }) => <button onClick={model.open}>Open file.ts</button>,
}));

const date = '2026-11-01T10:00:00.000Z';
let root: Root;
let container: HTMLDivElement;
let props: InspectorProps;
let animationDescriptor: PropertyDescriptor | undefined;
const unavailable = async (): Promise<never> => { throw new Error('Unexpected action'); };

/** The shell's side of full width: it holds the state and gives the Inspector the toggle. */
function Pane({ inspector }: { inspector: InspectorProps }) {
  const [full, setFull] = useState(false);
  return <InspectorLayout.Provider value={{ full, onFull: setFull }}><Inspector {...inspector} /></InspectorLayout.Provider>;
}
async function render(withPane = false) { await act(async () => root.render(withPane ? <Pane inspector={props} /> : <Inspector {...props} />)); }
function button(label: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].findLast((node) => node.textContent === label || node.getAttribute('aria-label') === label);
}
async function click(label: string) {
  const target = button(label);
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
}
/** Selects an Inspector tab by the start of its label (a count may follow). */
async function tab(label: string) {
  const target = [...container.querySelectorAll<HTMLElement>('[aria-label="Inspector views"] [role="tab"]')].find((node) => node.textContent?.startsWith(label));
  expect(target, label).toBeDefined();
  await act(async () => target!.click());
}
async function type(placeholder: string, text: string) {
  const input = container.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
function layout(): string | null { return container.querySelector('[aria-label="Workspace Inspector"]')!.getAttribute('data-inspector-layout'); }
/** The open-file chips the shown tab draws (a hidden kept-mounted tab draws the same strip). */
function chips(): string[] { return [...container.querySelectorAll('[role="tablist"][aria-label="Open files"] [role="tab"]')].filter((node) => !node.closest('[hidden]')).map((node) => node.textContent ?? ''); }
function driveFile(path: string): DriveFileView {
  return { url: `drive://workspace/${path}`, path, hash: `sha256:${'0'.repeat(64)}`, size: 10, mediaType: 'text/plain', scope: 'workspace', workspaceId: 'space', writtenAt: date };
}
function entry(overrides: Partial<JournalEntryView> & Pick<JournalEntryView, 'id' | 'sequence' | 'kind' | 'title'>): JournalEntryView {
  return { projectId: 'project', spaceId: 'space', phaseRunId: null, phase: 'code', body: '', outcome: null, decisions: [], surprises: [], evidence: [], snapshot: null, delta: null, reverted: null, createdAt: date, createdBy: 'agent', ...overrides };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = {
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal: null, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 }, changeGuide: null },
    initialView: 'journal', workspaces: [], onSelectWorkspace() {}, repositoryEntries: [], repositoryMode: 'current', onRepositoryModeChange() {}, repositoryFile: null, repositoryDiff: null, journalEntries: [], threads: [], services: [], subagents: [],
    usage: { sessionId: null, report: null, status: 'idle', load() {}, refresh() {} }, agentSetup: { sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }, reviewerId: 'reviewer', onRequestArtifact: () => Promise.withResolvers<never>().promise, onRequestRepositoryFile() {}, onRequestRepositoryDiff() {}, onLoadGuideDiff: unavailable, onCreateThread: unavailable, onReplyThread: unavailable, onResolveThread: unavailable, onMarkGuideSectionRead: unavailable,
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); });

describe('Inspector full width', () => {
  it('opens any tab at full width and returns on Back to conversation or Escape, but not on Escape inside a dialog', async () => {
    props.onClose = () => undefined;
    await render(true);
    expect(layout()).toBe('side');
    expect(button('Back to conversation')).toBeUndefined();

    await click('Open at full width');
    expect(layout()).toBe('full');
    expect(button('Close Inspector')).toBeUndefined();
    await tab('Usage');
    expect(layout()).toBe('full');

    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(layout()).toBe('side');

    await click('Open at full width');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    container.append(dialog);
    await act(async () => dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(layout()).toBe('full');

    await click('Back to conversation');
    expect(layout()).toBe('side');
  });

  it('offers no full-width toggle where it has no pane to fill', async () => {
    await render();
    expect(button('Open at full width')).toBeUndefined();
  });
});

describe('Inspector open files', () => {
  it('keeps one strip of open files across Files and Drive', async () => {
    props = {
      ...props, initialView: 'files',
      repositoryEntries: [{ spaceId: 'space', generation: 7, mode: 'current', path: 'file.ts', name: 'file.ts', kind: 'file', status: 'modified', oldPath: null, blobId: null, size: null }],
      drive: { files: [driveFile('plan.md')], own: 'workspace', captures: new Map(), remove: unavailable },
      artifactReferences: [{ kind: 'artifact', url: 'drive://workspace/plan.md', hash: 'hash', label: 'plan.md', mediaType: 'text/plain', generation: 1 }],
    };
    await render();
    expect(chips()).toEqual([]);

    await click('Open file.ts');
    expect(chips()).toEqual(['file.ts']);
    expect(container.textContent).toContain('Loading repository view');

    await tab('Drive');
    await click('Drive');
    expect(chips()).toEqual(['file.ts']);
    await act(async () => [...container.querySelectorAll('button')].find((node) => node.textContent?.startsWith('plan.md'))!.click());
    expect(chips()).toEqual(['file.ts', 'plan.md']);
    expect(container.querySelector('[role="tab"][aria-selected="true"][data-open-file]')?.textContent).toBe('plan.md');

    await tab('Files');
    expect(chips()).toEqual(['file.ts', 'plan.md']);
    expect(container.querySelector('[aria-label="Workspace Inspector"] header strong')?.textContent).toBe('plan.md');

    await click('Close plan.md');
    expect(chips()).toEqual(['file.ts']);
    expect(container.querySelector('[aria-label="Workspace Inspector"] header strong')?.textContent).toBe('file.ts');

    await click('Close file.ts');
    expect(chips()).toEqual([]);
    expect(button('Open file.ts')?.closest('[hidden]')).toBeNull();
  });

  it('shows the browser beside the open file at full width', async () => {
    props = { ...props, initialView: 'files', repositoryEntries: [{ spaceId: 'space', generation: 7, mode: 'current', path: 'file.ts', name: 'file.ts', kind: 'file', status: 'modified', oldPath: null, blobId: null, size: null }] };
    await render(true);
    await click('Open file.ts');
    expect(button('Open file.ts')?.closest('[hidden]')).not.toBeNull();
    await click('Open at full width');
    expect(button('Open file.ts')?.closest('[hidden]')).toBeNull();
    expect(container.textContent).toContain('Loading repository view');
  });
});

describe('Inspector journal', () => {
  const first = entry({ id: 'retry-old', sequence: 1, kind: 'decision', title: 'Retry three times', body: 'Retries stay bounded.' });
  const phase = entry({ id: 'phase', sequence: 2, kind: 'phase-start', title: 'Code phase started' });
  const note = entry({ id: 'note', sequence: 3, kind: 'narrative', title: 'Benchmarked the queue', body: 'Queue latency halved.' });
  const decision = entry({
    id: 'retry-new', sequence: 4, kind: 'decision', title: 'Retry once', body: 'A second retry hid outages.', sectionId: 'section', supersedes: 'retry-old',
    citations: [{ conversationId: 'conversation', messageId: 'message', who: 'Bradley', at: date, quote: 'one retry is enough' }],
  });

  it('narrows the log by search and by kind', async () => {
    props.journalEntries = [first, phase, note, decision];
    await render();
    expect(container.textContent).toContain('4 entries');

    await type('Search the journal', 'retry');
    expect([...container.querySelectorAll('[data-journal-entry]')].map((node) => node.getAttribute('data-journal-entry'))).toEqual(['retry-new', 'retry-old']);
    expect(container.textContent).toContain('2 of 4 entries');

    await type('Search the journal', 'bradley');
    expect([...container.querySelectorAll('[data-journal-entry]')].map((node) => node.getAttribute('data-journal-entry'))).toEqual(['retry-new']);

    await type('Search the journal', '');
    await click('Phases1');
    expect([...container.querySelectorAll('[data-journal-entry]')].map((node) => node.getAttribute('data-journal-entry'))).toEqual(['phase']);
    await click('Decisions2');
    expect([...container.querySelectorAll('[data-journal-entry]')].map((node) => node.getAttribute('data-journal-entry'))).toEqual(['retry-new', 'retry-old']);

    await type('Search the journal', 'nothing like this');
    expect(container.textContent).toContain('Nothing in the journal matches.');
  });

  it('shows what a decision rests on and links to its guide section', async () => {
    props.journalEntries = [first, decision];
    props.overview = { ...props.overview, changeGuide: { projectId: 'project', spaceId: 'space', revision: 1, headCommit: 'b'.repeat(40), baseRef: 'main', baseCommit: 'c'.repeat(40), title: 'Guide', createdAt: date, createdBy: 'author', reviewerStates: [], sections: [{ id: 'section', title: 'Retry policy', kind: 'behavior', explanation: 'Retries once', why: '', requirementIds: [], exhibits: [] }] } };
    await render();
    const newer = container.querySelector('[data-journal-entry="retry-new"]')!;
    expect(newer.querySelector('[aria-label="Citations"]')?.textContent).toContain('“one retry is enough”');
    expect(newer.querySelector('[aria-label="Citations"]')?.textContent).toContain('Bradley');
    expect(newer.textContent).toContain('Replaces Retry three times');
    const older = container.querySelector('[data-journal-entry="retry-old"]')!;
    expect(older.textContent).toContain('Superseded');
    expect(older.textContent).toContain('Replaced by Retry once');

    await click('§ Retry policy');
    expect(container.querySelector('[aria-label="Inspector views"] [role="tab"][aria-selected="true"]')?.textContent).toMatch(/^Change Guide/u);
  });
});
