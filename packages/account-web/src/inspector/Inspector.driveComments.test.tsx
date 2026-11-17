// @vitest-environment happy-dom
import type { TranscriptRow } from '@gitspace/blocks';
import { commentsMessage, type CommentAnchor, type StagedComment } from '@gitspace/protocol-runtime/comments';
import { SessionControlSchema, type RuntimeSessionCommand, type RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from '../App.js';
import { ComposerStagingProvider } from '../chat/staging.js';
import { CommentLayerProvider } from '../comments/CommentLayer.js';
import { StandaloneComposer as Composer } from '../Composer.js';
import { GitSpaceShell, type GitSpaceShellProps } from '../GitSpaceShell.js';
import { Toasts } from '../toasts.js';
import type { DriveFileView } from './DriveSurface.js';
import { Inspector, type InspectorProps } from './Inspector.js';
import type { ArtifactReference, InspectorArtifactContent } from './inspector-shared.js';

vi.mock('../device-session.js', () => ({ currentDevice: vi.fn(async () => null), deviceRejected: vi.fn() }));
// Mermaid draws its labels as paragraphs inside the diagram's SVG.
vi.mock('@streamdown/mermaid', () => ({ mermaid: { getMermaid: () => ({ render: async () => ({ svg: '<svg viewBox="0 0 100 20"><foreignObject width="100" height="20"><div><p>Old queue</p></div></foreignObject></svg>' }) }) } }));

const date = '2026-01-01T00:00:00.000Z';
const url = 'drive://workspace/notes/release-plan.md';
const fence = '```';
const timeline = `${fence}gitspace-ui Timeline id=deploy\n${JSON.stringify({ title: 'Deploy', events: [{ at: '2026-11-17T09:00:00Z', kind: 'deploy', label: 'Started' }, { at: '2026-11-17T09:20:00Z', kind: 'fix', label: 'Rolled out' }] })}\n${fence}`;
/** The plan as the agent first wrote it; after it changed the end of the second paragraph; after it changed the first
 * words of the second paragraph; after it changed the end of the first paragraph's sentence; and after it changed the
 * Timeline. */
const first = `# Release plan\n\nThe orders service ships on Friday after the migration.\n\nWe keep the old queue for one week.\n\n${timeline}`;
const second = `# Release plan\n\nThe orders service ships on Friday after the migration.\n\nWe keep the old queue for one weekend.\n\n${timeline}`;
const third = `# Release plan\n\nThe orders service ships on Friday after the migration.\n\nThen we keep the old queue for one week.\n\n${timeline}`;
const fourth = `# Release plan\n\nThe orders service ships on Friday after the review.\n\nWe keep the old queue for one week.\n\n${timeline}`;
const fifth = `# Release plan\n\nThe orders service ships on Friday after the migration.\n\nWe keep the old queue for one week.\n\n${timeline.replace('Rolled out', 'Rolled back')}`;
const diagram = `# Release plan\n\nThe orders service ships on Friday after the migration.\n\n${fence}mermaid\nflowchart LR\n  A[Old queue] --> B[Migration]\n${fence}`;
const versions: Record<string, string> = Object.fromEntries([first, second, third, fourth, fifth, diagram].map((markdown, index) => [`sha256:${String(index + 1).repeat(64)}`, markdown]));
const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });

interface Runtime { staged: StagedComment[]; sent: { id: string; anchor: CommentAnchor; message: string }[]; replies: { row: string; comment: string }[]; rows: TranscriptRow[]; revision: number }
let runtime: Runtime;
let requested: RuntimeSessionCommand[];
let root: Root;
let container: HTMLDivElement;
let props: InspectorProps;
const unavailable = async (): Promise<never> => { throw new Error('Unexpected action'); };
const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>();

async function request(command: RuntimeSessionCommand): Promise<RuntimeSessionResult> {
  requested.push(command);
  if (command.type === 'stageComment') {
    runtime.staged = [...runtime.staged, { id: `cm-${String(runtime.staged.length + runtime.sent.length + 1).padStart(12, '0')}`, anchor: command.anchor, note: command.note, stagedAt: date, deviceId: null }];
    draw();
  }
  if (command.type === 'commentLookup') {
    const shown = runtime.sent.filter(({ anchor: { document } }) => document.kind !== 'drive' || (command.documents?.includes('drive') && command.drivePaths?.includes(document.path)));
    return { control, commentLookup: { comments: shown.map(({ id, anchor, message }) => ({ id, anchor, message, conversationId: 'main' })), replies: runtime.replies } };
  }
  return { control };
}

/** The drive as it lists the plan at `hash`. */
function driveAt(hash: string): Pick<InspectorProps, 'drive' | 'artifactReferences'> {
  const file: DriveFileView = { url, path: 'notes/release-plan.md', hash, size: versions[hash]!.length, mediaType: 'text/markdown', scope: 'workspace', workspaceId: 'space', writtenAt: date };
  const reference: ArtifactReference = { kind: 'artifact', url, hash, generation: 1, label: 'release-plan.md', mediaType: 'text/markdown' };
  return { drive: { files: [file], own: 'workspace', captures: new Map(), remove: unavailable }, artifactReferences: [reference] };
}

async function readArtifact(reference: ArtifactReference): Promise<InspectorArtifactContent> {
  return { url: reference.url, source: versions[reference.hash] ?? null, previewUrl: '', mediaType: 'text/markdown' };
}

function draw(): void {
  root.render(<CommentLayerProvider conversationId="main" document={{ staged: runtime.staged, lookupRevision: runtime.revision }} rows={runtime.rows} request={request}>
    <ComposerStagingProvider>
      <Toasts><Inspector {...props} /></Toasts>
      <Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} />
    </ComposerStagingProvider>
  </CommentLayerProvider>);
}

/** Lets the lazily loaded block code and the reads settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 5);
      await promise;
    });
  }
}

async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

/** Writes a note in the open comment editor and saves it. */
async function comment(note: string) {
  const editor = document.querySelector<HTMLElement>('[data-comment-editor]');
  expect(editor).not.toBeNull();
  const textarea = editor!.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, note);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => [...editor!.querySelectorAll('button')].find((node) => node.textContent === 'Comment')!.click());
}

/** Hovers the paragraph reading `text` so its comment icon shows, and opens its editor. */
async function commentOnParagraph(text: string, note: string) {
  const paragraph = [...container.querySelectorAll('[data-drive-part] p')].find((node) => node.textContent === text);
  expect(paragraph, text).toBeDefined();
  await act(async () => paragraph!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  await click('Comment on this paragraph');
  await comment(note);
}

function chips(): string[] {
  return [...container.querySelectorAll('[aria-label="Staged in your message"] > li')].map((chip) => chip.getAttribute('aria-label') ?? '');
}

/** The threads shown under the part of the document holding `text`. */
function threadsUnder(text: string): string {
  const part = [...container.querySelectorAll('[data-drive-part]')].find((node) => node.textContent?.includes(text));
  return part?.querySelector('[data-drive-threads]')?.textContent ?? '';
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { constructor(private callback: (entries: unknown[]) => void) {} observe() { this.callback([{ isIntersecting: true }]); } disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  if (!('getAnimations' in Element.prototype)) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  runtime = { staged: [], sent: [], replies: [], rows: [], revision: 0 };
  requested = [];
  onSend.mockReset();
  onSend.mockImplementation(async (text, _behavior, _draft, _decisions, ids = []) => {
    const carried = runtime.staged.filter((each) => ids.includes(each.id));
    const turn = `t${runtime.rows.length / 2 + 1}`;
    const said = commentsMessage(text, carried.map(({ id, anchor, note }) => ({ id, anchor, note })));
    const replied = carried.map((each) => `${fence}gitspace-ui\n${JSON.stringify({ root: 'r', elements: { r: { type: 'Reply', props: { comment: each.id, text: `Answering: ${each.note}` }, children: [] } } })}\n${fence}`).join('\n\n');
    const turnRows: ['user' | 'assistant', string][] = [['user', said], ['assistant', replied]];
    runtime.rows = [...runtime.rows, ...turnRows.map(([role, body], index): TranscriptRow => {
      const id = `${turn}:${role}`;
      return { id, ordinal: runtime.rows.length + index + 1, turnId: turn, turnStatus: 'done', item: { id, type: 'message', role, text: body }, truncated: false, contentBytes: 0 };
    })];
    runtime.staged = runtime.staged.filter((each) => !ids.includes(each.id));
    runtime.sent = [...runtime.sent, ...carried.map(({ id, anchor }) => ({ id, anchor, message: `${turn}:user` }))];
    runtime.replies = [...runtime.replies, ...carried.map((each) => ({ row: `${turn}:assistant`, comment: each.id }))];
    runtime.revision += 1;
    draw();
  });
  props = {
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal: null, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 }, changeGuide: null },
    initialView: 'artifacts', workspaces: [], onSelectWorkspace() {}, repositoryEntries: [], repositoryMode: 'current', onRepositoryModeChange() {}, repositoryFile: null, repositoryDiff: null, journalEntries: [], threads: [], services: [], subagents: [],
    usage: { sessionId: null, report: null, status: 'idle', load() {}, refresh() {} }, agentSetup: { sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }, reviewerId: 'reviewer',
    onRequestArtifact: readArtifact, onRequestRepositoryFile() {}, onRequestRepositoryDiff() {}, onLoadGuideDiff: unavailable, onMarkGuideSectionRead: async () => undefined,
    ...driveAt(`sha256:${'1'.repeat(64)}`),
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('draws a drive Markdown file as a block document, stages comments on a paragraph and a block, sends them, shows each Reply under it, and carries them forward or shows them outdated when the file changes', async () => {
  await act(async () => draw());
  await click('notes');
  await click('release-plan.md');
  await settle();

  // The file is a block document: its Timeline draws as a block with its id, and copies as Markdown.
  const block = container.querySelector('[data-drive-part] [data-comment-block="drive#deploy"]');
  expect(block?.getAttribute('data-comment-kind')).toBe('Timeline');
  expect(block?.textContent).toContain('Started');
  expect(container.querySelector('button[aria-label="Copy as Markdown"]')).not.toBeNull();

  // A comment on each paragraph and on the block, staged on the file at its version as chips.
  await commentOnParagraph('The orders service ships on Friday after the migration.', 'Which Friday?');
  await commentOnParagraph('We keep the old queue for one week.', 'Why a week?');
  await click('Comment on this Timeline');
  await comment('Is twenty minutes normal?');
  const document1 = { kind: 'drive', path: url, hash: `sha256:${'1'.repeat(64)}` };
  expect(requested.filter((command) => command.type === 'stageComment')).toMatchObject([
    { anchor: { document: document1, target: { kind: 'text', within: 'drive', exact: 'The orders service ships on Friday after the migration.' } }, note: 'Which Friday?' },
    { anchor: { document: document1, target: { kind: 'text', within: 'drive', exact: 'We keep the old queue for one week.' } }, note: 'Why a week?' },
    { anchor: { document: document1, target: { kind: 'block', id: 'drive#deploy' }, quote: 'Timeline: Deploy' }, note: 'Is twenty minutes normal?' },
  ]);
  expect(chips()).toEqual(['Comment Which Friday?', 'Comment Why a week?', 'Comment Is twenty minutes normal?']);

  // The send names the file; the agent's Reply to each shows under its paragraph or block.
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await settle();
  expect(onSend).toHaveBeenCalledOnce();
  expect(runtime.rows[0]?.item.type === 'message' ? runtime.rows[0].item.text : '').toContain(`Comment on “The orders service ships on Friday after the migration.” in ${url}: Which Friday?`);
  expect(requested.findLast((command) => command.type === 'commentLookup')).toMatchObject({ documents: ['goal', 'guide', 'drive'], drivePaths: [url] });
  expect(threadsUnder('ships on Friday')).toContain('Answering: Which Friday?');
  expect(threadsUnder('old queue for one week')).toContain('Answering: Why a week?');
  expect(threadsUnder('Started')).toContain('Answering: Is twenty minutes normal?');

  // The agent rewrites the second paragraph: the first paragraph's comment and the unchanged block's carry forward,
  // the rewritten paragraph's shows outdated above the document with its quote and the version it was written on.
  props = { ...props, ...driveAt(`sha256:${'2'.repeat(64)}`) };
  await act(async () => draw());
  await settle();
  expect(container.textContent).toContain('We keep the old queue for one weekend.');
  expect(threadsUnder('ships on Friday')).toContain('Which Friday?');
  expect(threadsUnder('Started')).toContain('Is twenty minutes normal?');
  const earlier = container.querySelector('[data-drive-earlier]');
  expect(earlier?.textContent).toContain('Why a week?');
  expect(earlier?.textContent).toContain('We keep the old queue for one week.');
  expect(earlier?.textContent).toContain('as written in 1111111');
  expect(container.querySelectorAll('[data-drive-threads] [data-thread-outdated]')).toHaveLength(0);

  // The agent changes the Timeline: its comment is listed above the document as outdated and no longer marked beside
  // the Timeline; the two paragraphs' comments are still marked (one dot, as they draw at the same height here).
  props = { ...props, ...driveAt(`sha256:${'5'.repeat(64)}`) };
  await act(async () => draw());
  await settle();
  expect(container.querySelector('[data-drive-earlier]')?.textContent).toContain('Is twenty minutes normal?');
  expect([...container.querySelectorAll('[data-comment-dot]')].map((dot) => dot.getAttribute('data-comment-dot'))).toEqual(['2']);
});

it('keeps a passage comment while its own paragraph reads the same, whatever changes in the next one', async () => {
  await act(async () => draw());
  await click('notes');
  await click('release-plan.md');
  await settle();

  // A selection inside the first paragraph: its context is that paragraph's text around it, never the next one's.
  const paragraph = [...container.querySelectorAll('[data-drive-part] p')].find((node) => node.textContent?.startsWith('The orders service'))!;
  const text = paragraph.firstChild!;
  const start = (text.textContent ?? '').indexOf('ships on Friday');
  const range = document.createRange();
  range.setStart(text, start);
  range.setEnd(text, start + 'ships on Friday'.length);
  await act(async () => {
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await click('Comment on the selection');
  await comment('Which Friday?');
  expect(requested.find((command) => command.type === 'stageComment')).toMatchObject({ anchor: { target: { kind: 'text', within: 'drive', exact: 'ships on Friday', prefix: 'The orders service ', suffix: ' after the migration.' } } });
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  await settle();

  // The next paragraph's first words change: the comment is carried forward under its paragraph.
  props = { ...props, ...driveAt(`sha256:${'3'.repeat(64)}`) };
  await act(async () => draw());
  await settle();
  expect(container.textContent).toContain('Then we keep the old queue');
  expect(threadsUnder('ships on Friday')).toContain('Which Friday?');
  expect(container.querySelector('[data-drive-earlier]')).toBeNull();

  // Its own sentence changes after the quote: the comment is outdated.
  props = { ...props, ...driveAt(`sha256:${'4'.repeat(64)}`) };
  await act(async () => draw());
  await settle();
  expect(container.textContent).toContain('after the review.');
  expect(threadsUnder('ships on Friday')).not.toContain('Which Friday?');
  expect(container.querySelector('[data-drive-earlier]')?.textContent).toContain('as written in 1111111');
});

it('offers comments on the paragraphs of a drive doc, never on the labels of its diagram', async () => {
  props = { ...props, ...driveAt(`sha256:${'6'.repeat(64)}`) };
  await act(async () => draw());
  await click('notes');
  await click('release-plan.md');
  await settle();
  const label = container.querySelector('[data-gitspace-block="mermaid"] svg p');
  expect(label?.textContent).toBe('Old queue');
  await act(async () => label!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  await settle();
  expect(document.querySelector('button[aria-label="Comment on this paragraph"]')).toBeNull();
  const paragraph = [...container.querySelectorAll('[data-drive-part] p')].find((node) => node.textContent?.startsWith('The orders service'));
  await act(async () => paragraph!.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
  expect(document.querySelector('button[aria-label="Comment on this paragraph"]')).not.toBeNull();
});

it('opens a drive doc comment linked from the chat in the Inspector at its file', async () => {
  const anchor: CommentAnchor = { document: { kind: 'drive', path: url, hash: `sha256:${'1'.repeat(64)}` }, target: { kind: 'block', id: 'drive#deploy' }, quote: 'Timeline: Deploy' };
  const turn: GitSpaceShellProps['turns'][number] = { ...verticalSliceFixture.turns[0]!, user: { id: 'turn-1-user', type: 'message', role: 'user', text: commentsMessage('See this', [{ id: 'cm-000000000001', anchor, note: 'Why so long?' }]) } };
  await act(async () => root.render(<GitSpaceShell {...verticalSliceFixture} turns={[turn]} onSend={async () => undefined}
    renderInspector={(_onClose, initialView, _resource, _openTerminal, guideSection, driveFocus) => <Inspector {...props} initialView={initialView} guideSection={guideSection} driveFocus={driveFocus} />} />));
  const link = container.querySelector<HTMLButtonElement>('[data-sent-comment="cm-000000000001"] button');
  expect(link?.textContent).toContain('release-plan.md');
  await act(async () => link!.click());
  await settle();
  expect(container.querySelector(`[data-drive-document="${url}"] [data-comment-block="drive#deploy"]`)).not.toBeNull();
});
