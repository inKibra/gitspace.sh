// @vitest-environment happy-dom
import type { TranscriptRow } from '@gitspace/blocks';
import type { ChangeGuideSection, GoalRecordView, RepositoryDiffView } from '@gitspace/protocol';
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
import { Inspector, type InspectorProps } from './Inspector.js';

vi.mock('../device-session.js', () => ({ currentDevice: vi.fn(async () => null), deviceRejected: vi.fn() }));
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

const date = '2026-01-01T00:00:00.000Z';
const diff: RepositoryDiffView = { spaceId: 'space', generation: 7, mode: 'base', path: 'src/parse.ts', baseCommit: 'a'.repeat(40), headCommit: 'b'.repeat(40), patch: 'diff --git a/src/parse.ts b/src/parse.ts\n--- a/src/parse.ts\n+++ b/src/parse.ts\n@@ -1 +1 @@\n-old parse\n+new parse\n', files: [{ path: 'src/parse.ts', oldPath: null, status: 'modified', additions: 1, deletions: 1, binary: false, oldBlobId: 'c'.repeat(40), newBlobId: 'd'.repeat(40) }] };
const goal: GoalRecordView = { projectId: 'project', spaceId: 'space', id: 'goal', revision: 3, title: 'Parse v2', summary: 'Parse every sample.', phase: 'code', createdAt: date, updatedAt: date, updatedBy: 'agent',
  requirements: [{ id: 'parses', title: 'Parses every sample', description: 'All of them.', required: true, status: 'missing', workflowNodeId: null, criterionId: null, evidence: [] }] };
const control = SessionControlSchema.parse({ sessionId: 'main', role: null, roleLabel: null, roles: [], provider: null, models: [], model: null, thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, historyAnchorId: null, history: [], goal: null, pendingAsk: null });

/** The workspace runtime as the comment layer sees it: the staged comments, the sent ones with the message carrying
 * each, the agent's replies, and the transcript's rows. A send moves the comments it names to sent, and the agent
 * answers each with a Reply block. */
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
  if (command.type === 'commentLookup') return { control, commentLookup: { comments: runtime.sent.map(({ id, anchor, message }) => ({ id, anchor, message, conversationId: 'main' })), replies: runtime.replies } };
  return { control };
}

function draw(): void {
  root.render(<CommentLayerProvider conversationId="main" document={{ staged: runtime.staged, lookupRevision: runtime.revision }} rows={runtime.rows} request={request}>
    <ComposerStagingProvider>
      <Toasts><Inspector {...props} /></Toasts>
      <Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} onSend={onSend} />
    </ComposerStagingProvider>
  </CommentLayerProvider>);
}

async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label || node.getAttribute('aria-label') === label || (node.getAttribute('role') === 'tab' && node.textContent?.includes(label)));
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}

/** Hovers the Goal or Guide entity so its comment icon shows in the gutter. */
async function hover(entity: string) {
  const element = container.querySelector(`[data-comment-entity="${entity}"]`);
  expect(element, entity).not.toBeNull();
  await act(async () => element!.dispatchEvent(new MouseEvent('mouseenter')));
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

function chips(): string[] {
  return [...container.querySelectorAll('[aria-label="Staged in your message"] > li')].map((chip) => chip.getAttribute('aria-label') ?? '');
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
    const replied = carried.map((each) => `\`\`\`gitspace-ui\n${JSON.stringify({ root: 'r', elements: { r: { type: 'Reply', props: { comment: each.id, quote: each.anchor.quote, text: `Answering: ${each.note}` }, children: [] } } })}\n\`\`\``).join('\n\n');
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
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 },
      changeGuide: { projectId: 'project', spaceId: 'space', revision: 1, headCommit: diff.headCommit, baseRef: 'main', baseCommit: diff.baseCommit, title: 'Guide', createdAt: date, createdBy: 'author', reviewerStates: [],
        sections: [{ id: 'reader', title: 'Reader', kind: 'behavior', explanation: 'The reader changed.', why: '', requirementIds: [], exhibits: [{ path: 'src/parse.ts', blobId: null, note: '', slowRead: false }] }] } },
    initialView: 'goal', workspaces: [], onSelectWorkspace() {}, repositoryEntries: [], repositoryMode: 'current', onRepositoryModeChange() {}, repositoryFile: null, repositoryDiff: null, journalEntries: [], threads: [], services: [], subagents: [],
    usage: { sessionId: null, report: null, status: 'idle', load() {}, refresh() {} }, agentSetup: { sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }, reviewerId: 'reviewer', onRequestArtifact: unavailable, onRequestRepositoryFile() {}, onRequestRepositoryDiff() {}, onLoadGuideDiff: async () => diff, onMarkGuideSectionRead: async () => undefined,
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); document.body.replaceChildren(); vi.unstubAllGlobals(); });

it('stages comments on a Goal requirement and a Guide exhibit\'s lines as chips, sends them, shows each Reply under its comment, and keeps the requirement commentable', async () => {
  await act(async () => draw());

  // The Goal: a comment on the requirement stages on the Goal's revision and shows as a chip above the composer.
  await hover('requirement:parses');
  await click('Comment on requirement “Parses every sample”');
  await comment('What about the empty file?');
  expect(requested.find((command) => command.type === 'stageComment')).toMatchObject({ anchor: { document: { kind: 'goal', revision: 3 }, target: { kind: 'entity', ref: 'requirement:parses' } }, note: 'What about the empty file?' });
  expect(chips()).toEqual(['Comment What about the empty file?']);
  expect(container.querySelector('[data-entity-threads="requirement:parses"] [data-thread-state="staged"]')?.textContent).toContain('What about the empty file?');

  // The Guide: selecting a line of the exhibit opens a comment on those lines, staged on the Guide's revision.
  await click('Guide');
  await click('Select old line');
  await comment('Why was this line removed?');
  expect(requested.filter((command) => command.type === 'stageComment').at(-1)).toMatchObject({ anchor: { document: { kind: 'guide', revision: 1 }, target: { kind: 'lines', exhibit: 'exhibit:reader:src/parse.ts', side: 'base', start: 1, end: 1 } } });
  expect(chips()).toEqual(['Comment What about the empty file?', 'Comment Why was this line removed?']);

  // The send carries both comments; the agent's Reply to each shows under it, on the exhibit and on the requirement.
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click());
  for (let turn = 0; turn < 5; turn += 1) await act(async () => {});
  expect(onSend).toHaveBeenCalledOnce();
  expect(runtime.sent).toHaveLength(2);
  expect(onSend.mock.calls[0]?.[4]).toEqual(runtime.sent.map((each) => each.id));
  expect(chips()).toEqual([]);
  const exhibitThread = container.querySelector('[data-entity-threads="exhibit:reader:src/parse.ts"] [data-thread-state="sent"]');
  expect(exhibitThread?.textContent).toContain('Why was this line removed?');
  expect(exhibitThread?.querySelector('[data-thread-reply]')?.textContent).toContain('Answering: Why was this line removed?');
  await click('Goal');
  const requirementThread = container.querySelector('[data-entity-threads="requirement:parses"] [data-thread-state="sent"]');
  expect(requirementThread?.textContent).toContain('What about the empty file?');
  expect(requirementThread?.querySelector('[data-thread-reply]')?.textContent).toContain('Answering: What about the empty file?');

  // After the send the requirement still takes a comment.
  await hover('requirement:parses');
  await click('Comment on requirement “Parses every sample”');
  await comment('And a file of one line?');
  expect(chips()).toEqual(['Comment And a file of one line?']);
});

it('opens the Guide section of an exhibit comment linked from the chat when the section id contains `:`', async () => {
  const exhibit = (id: string): ChangeGuideSection => ({ id, title: `Section ${id}`, kind: 'behavior', explanation: `About ${id}.`, why: '', requirementIds: [], exhibits: [{ path: 'src/store.ts', blobId: null, note: '', slowRead: false }] });
  props = { ...props, initialView: undefined, overview: { ...props.overview, changeGuide: { ...props.overview.changeGuide!, sections: [exhibit('intro'), exhibit('store'), exhibit('store:v2')] } } };
  const anchor: CommentAnchor = { document: { kind: 'guide', revision: 1 }, target: { kind: 'lines', exhibit: 'exhibit:store:v2:src/store.ts', side: 'head', start: 1, end: 1, blobId: null }, quote: 'new parse' };
  const turn: GitSpaceShellProps['turns'][number] = { ...verticalSliceFixture.turns[0]!, user: { id: 'turn-1-user', type: 'message', role: 'user', text: commentsMessage('See this', [{ id: 'cm-000000000001', anchor, note: 'Why here?' }]) } };
  await act(async () => root.render(<GitSpaceShell {...verticalSliceFixture} turns={[turn]} onSend={async () => undefined}
    renderInspector={(_onClose, initialView, _resource, _openTerminal, guideSection) => <Inspector {...props} initialView={initialView} guideSection={guideSection} />} />));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-sent-comment="cm-000000000001"] button')!.click());
  expect(container.querySelector('[data-section="store:v2"] button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('true');
  expect(container.querySelector('[data-section="store"] button[aria-expanded]')?.getAttribute('aria-expanded')).toBe('false');
});
