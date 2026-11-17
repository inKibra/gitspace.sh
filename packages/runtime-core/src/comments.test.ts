import { expect, test } from 'vitest';
import { AssistantEntry, MemoryStorage, UserEntry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { messageComments, type CommentAnchor } from '@gitspace/protocol-runtime/comments';
import { PI_ENTRY_ORDINALS, piMessageRowId, piSessionId, turnRowId, userRowId } from '@gitspace/blocks';
import { createRuntimeHarness } from './harness.js';
import { CommentLookupDoc, StagedCommentsDoc } from './documents.js';
import { commentLookup, rebuildCommentLookup } from './comments.js';
import { createSessionControls } from './session-controls.js';

const model: Model<Api> = { id: 'comments', name: 'Comments', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
/** The text of the last message a model request carries. */
function lastText(messages: readonly unknown[]): string {
  const last: unknown = messages.at(-1);
  if (typeof last !== 'object' || last === null || !('content' in last)) return '';
  if (typeof last.content === 'string') return last.content;
  return Array.isArray(last.content) ? last.content.flatMap((part: unknown) => typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('\n') : '';
}

/** A reply answering every comment the request's last message carries with a Reply block; "Use KV." when it carries
 * none. */
function replyTo(messages: readonly unknown[]): string {
  const comments = messageComments(lastText(messages));
  if (comments.length === 0) return 'Use KV.\n\nIt keeps reads at the edge.';
  return comments.map((comment) => `\`\`\`gitspace-ui\n${JSON.stringify({ root: 'reply', elements: { reply: { type: 'Reply', props: { comment: comment.id, quote: 'Use KV.', text: 'Because reads stay at the edge.' }, children: [] } } })}\n\`\`\``).join('\n\n');
}

/** The workspace runtime's harness whose model answers as `replyTo` says; every request's messages are recorded. */
async function open(storage = new MemoryStorage()) {
  const requests: unknown[][] = [];
  const reports: unknown[] = [];
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: unknown[] }) {
    const reply: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: replyTo(request.messages) }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply);
    requests.push(request.messages);
    return stream;
  } });
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage, models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { reports.push(error); }, admitInference: async () => ({ provider: 'test', modelId: model.id }), bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  const controls = createSessionControls({ ...runtime, admitInference: async () => ({ provider: 'test', modelId: model.id }), reload: async () => {}, catalog: async () => ({ models: [], roles: [] }),
    history: { conversation: unused, recent: async () => ({ anchorId: null, prompts: [], tokens: null }), page: unused, resolve: unused, transcriptPage: unused, transcriptContent: unused, usage: unused } });
  const conversationId = String(runtime.root.id);
  /** Sends `text` as a person on device-a and waits for the turn to end; answers the turn its input opened. */
  async function send(text: string, comments?: string[]): Promise<string> {
    await controls.execute(conversationId, { type: 'prompt', text, ...(comments ? { comments } : {}) }, false, 'device-a');
    await runtime.root.waitForIdle(context);
    const input = (await runtime.root.entries({}, 50, undefined, context)).items.find(entry => UserEntry.is(entry));
    if (!input) throw new Error('The turn stored no input');
    return turnRowId(piSessionId(conversationId), Number(input.id) * PI_ENTRY_ORDINALS);
  }
  /** The newest reply entry's id. */
  async function newestReply(): Promise<number> {
    const reply = (await runtime.root.entries({}, 50, undefined, context)).items.find(entry => AssistantEntry.is(entry));
    if (!reply) throw new Error('No reply');
    return Number(reply.id);
  }
  /** The lookup once it has read every entry so far: it is updated in the commit after the one that stored a message. */
  async function settled() {
    const latest = Number((await runtime.root.entries({}, 1, undefined, context)).items[0]?.id ?? 0);
    let committed = Promise.withResolvers<void>();
    const observation = runtime.harness.observeCommits({ end() {}, advance() { const done = committed; committed = Promise.withResolvers(); done.resolve(); } });
    try {
      for (;;) {
        const lookup = await runtime.harness.snapshot(CommentLookupDoc, context);
        if ((lookup?.through ?? 0) >= latest) return lookup;
        await committed.promise;
      }
    } finally { observation.detach(); }
  }
  const staged = async () => (await runtime.harness.snapshot(StagedCommentsDoc, context))?.items ?? [];
  return { ...runtime, storage, controls, requests, reports, conversationId, send, newestReply, settled, staged };
}

function anchorOn(conversationId: string, turnId: string, row: string): CommentAnchor {
  return { document: { kind: 'turn', conversationId, turnId }, target: { kind: 'text', within: `message:${row}`, exact: 'Use KV.', prefix: '', suffix: '\n\nIt keeps' }, quote: 'Use KV.' };
}

test('a staged comment is kept in the runtime: it is there after the workspace reopens, and only the latest turn takes one', async () => {
  const storage = new MemoryStorage();
  const f = await open(storage);
  try {
    const turn = await f.send('Which cache?');
    const row = piMessageRowId(f.conversationId, Number(turn.split(':turn:')[1]) / PI_ENTRY_ORDINALS, await f.newestReply(), 0, 0);
    await f.controls.execute(f.conversationId, { type: 'stageComment', anchor: anchorOn(f.conversationId, turn, row), note: 'Why not D1?' }, false, 'device-a');
    const [comment] = await f.staged();
    if (!comment) throw new Error('Nothing staged');
    expect(comment.id).toMatch(/^cm-[0-9a-f]{12}$/u);
    expect({ note: comment.note, deviceId: comment.deviceId, anchor: comment.anchor }).toEqual({ note: 'Why not D1?', deviceId: 'device-a', anchor: anchorOn(f.conversationId, turn, row) });
    await f.controls.execute(f.conversationId, { type: 'editComment', id: comment.id, note: 'Why not D1 instead?' });
    // The workspace object resets: a new runtime opens the same storage.
    const reopened = await open(storage);
    expect(await reopened.staged()).toEqual([{ ...comment, note: 'Why not D1 instead?' }]);
    await expect(reopened.controls.execute(f.conversationId, { type: 'stageComment', anchor: anchorOn(f.conversationId, `${turn}0`, row), note: 'Late' })).rejects.toThrow('Comments go on the latest turn');
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('a send carries its staged comments as data, the agent\'s Reply links to its comment, the turn takes no more, and the lookup rebuilds from the transcript', async () => {
  const f = await open();
  try {
    const first = await f.send('Which cache?');
    const reply = await f.newestReply();
    const row = piMessageRowId(f.conversationId, Number(first.split(':turn:')[1]) / PI_ENTRY_ORDINALS, reply, 0, 0);
    const anchor = anchorOn(f.conversationId, first, row);
    await f.controls.execute(f.conversationId, { type: 'stageComment', anchor, note: 'Why not D1?' });
    const [comment] = await f.staged();
    if (!comment) throw new Error('Nothing staged');
    const second = await f.send('Thanks.', [comment.id]);
    const request = lastText(f.requests.at(-1) ?? []);
    expect(request).toContain('Thanks.\n\nComment on “Use KV.”: Why not D1?\n~~~json');
    expect(messageComments(request)).toEqual([{ id: comment.id, note: 'Why not D1?', anchor }]);
    expect(await f.staged()).toEqual([]);
    // The commented turn is no longer the latest: it takes no new comments.
    await expect(f.controls.execute(f.conversationId, { type: 'stageComment', anchor, note: 'One more' })).rejects.toThrow('Comments go on the latest turn');
    const lookup = await f.settled();
    const replyRow = piMessageRowId(f.conversationId, Number(second.split(':turn:')[1]) / PI_ENTRY_ORDINALS, await f.newestReply(), 0, 0);
    expect(lookup?.comments).toEqual({ [comment.id]: { conversationId: f.conversationId, message: userRowId(second), anchor } });
    expect(lookup?.replies).toEqual({ [replyRow]: [comment.id] });
    const found = await commentLookup(f.harness, [first]);
    expect(found).toEqual({ comments: [{ id: comment.id, conversationId: f.conversationId, message: userRowId(second), anchor }], replies: [{ row: replyRow, comment: comment.id }] });
    // The reply's turn finds the comment it answers.
    expect(await commentLookup(f.harness, [second])).toEqual(found);
    await rebuildCommentLookup(f.harness, f.storage);
    const rebuilt = await f.harness.snapshot(CommentLookupDoc, context);
    expect({ comments: rebuilt?.comments, replies: rebuilt?.replies }).toEqual({ comments: lookup?.comments, replies: lookup?.replies });
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});

test('a comment on a Goal requirement or a Guide exhibit\'s lines stages on any turn, goes with a send, stays open after it, and the lookup finds it and its Reply by document', async () => {
  const f = await open();
  try {
    const goal: CommentAnchor = { document: { kind: 'goal', revision: 3 }, target: { kind: 'entity', ref: 'requirement:parses' }, quote: 'Parses every sample' };
    const lines: CommentAnchor = { document: { kind: 'guide', revision: 2 }, target: { kind: 'lines', exhibit: 'exhibit:parser:src/parse.ts', side: 'head', start: 12, end: 14, blobId: 'a'.repeat(40) }, quote: 'const line = read();' };
    await f.send('Start.');
    await f.controls.execute(f.conversationId, { type: 'stageComment', anchor: goal, note: 'Which samples?' });
    await f.controls.execute(f.conversationId, { type: 'stageComment', anchor: lines, note: 'Why read here?' });
    const staged = await f.staged();
    expect(staged.map((comment) => comment.anchor)).toEqual([goal, lines]);
    const turn = await f.send('Two comments.', staged.map((comment) => comment.id));
    expect(messageComments(lastText(f.requests.at(-1) ?? [])).map((comment) => comment.anchor)).toEqual([goal, lines]);
    // Sent, the Goal still takes comments: its blocks never lock.
    await f.controls.execute(f.conversationId, { type: 'stageComment', anchor: goal, note: 'And the empty file?' });
    expect((await f.staged()).map((comment) => comment.note)).toEqual(['And the empty file?']);
    await f.settled();
    const replyRow = piMessageRowId(f.conversationId, Number(turn.split(':turn:')[1]) / PI_ENTRY_ORDINALS, await f.newestReply(), 0, 0);
    const [first, second] = staged;
    if (!first || !second) throw new Error('Nothing staged');
    // A lookup of no loaded turns finds them by their documents.
    expect(await commentLookup(f.harness, [], ['goal'])).toEqual({ comments: [{ id: first.id, conversationId: f.conversationId, message: userRowId(turn), anchor: goal }], replies: [{ row: replyRow, comment: first.id }] });
    expect((await commentLookup(f.harness, [], ['goal', 'guide'])).comments.map((comment) => comment.anchor)).toEqual([goal, lines]);
    expect(await commentLookup(f.harness, [])).toEqual({ comments: [], replies: [] });
    expect(f.reports).toEqual([]);
  } finally { await f.harness.close(context); }
});
