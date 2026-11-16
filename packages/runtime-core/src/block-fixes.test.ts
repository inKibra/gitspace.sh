import { expect, test } from 'vitest';
import { AssistantEntry, Harness, LiveDoc, MemoryStorage, ToolResultEntry, createRegistry, defineExtension, type EntryRecord } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context, withAbortSignal } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Message, type Model, type TextContent } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { BlockCorrectionsDoc } from './documents.js';
import { BlockCorrectionEntry, BlockFixEntry, blockFixPrompt, correctedReply, createBlockFixes, fixBlockTool, invalidBlocks } from './block-fixes.js';

const fence = '```';
const model: Model<Api> = { id: 'fixes', name: 'Fixes', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 1000 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const text = (value: string): TextContent => ({ type: 'text', text: value });
const emptyMermaid = `${fence}mermaid\n\n${fence}`;
/** The reply the person asks for: an invalid mermaid block, then an svg drawn with literal colours, which is valid. */
const REPLY = `Here is the flow:\n${emptyMermaid}\nAnd the layout:\n${fence}svg\n<svg viewBox="0 0 4 4"><rect fill="#f4f4f5"/></svg>\n${fence}`;
type Step = AssistantMessage['content'];
const fix = (id: string, block: number | string, source: string): Step[number] => ({ type: 'toolCall', id, name: 'fix_block', arguments: { block, source } });

/** The workspace runtime's harness whose model answers each request with the next of `script` ("Done." past its end);
 * every request's messages are recorded. */
async function open(script: Step[]) {
  const requests: Message[][] = [];
  const reports: unknown[] = [];
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple(_model: Model<Api>, request: { messages: Message[] }) {
    const content = script[requests.length] ?? [text('Done.')];
    requests.push(request.messages);
    const calls = content.some(part => part.type === 'toolCall');
    const reply: AssistantMessage = { role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: calls ? 'toolUse' : 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: calls ? 'toolUse' : 'stop', message: reply }); stream.end(reply);
    return stream;
  } });
  const admitted: string[] = [];
  const runtime = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, invoke: unused, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'workspace' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { reports.push(error); }, admitInference: async input => { admitted.push(input.requestId); return { provider: 'test', modelId: model.id }; }, bindInferenceConversation: async () => {},
    refuseRequest: unused, unfinished: { begin: () => 0, end: () => {} },
  });
  /** Sends `prompt` as a person and waits until the conversation is idle again, its fix step included. */
  async function send(prompt: string, requestId = `request-${prompt}`) {
    await runtime.lifecycle.admit(runtime.root.id, requestId);
    await runtime.root.submit({ type: 'input', content: prompt, requestId, whenBusy: 'followUp' }, context);
    await runtime.root.waitForIdle(context);
  }
  const entries = async () => (await runtime.root.entries({}, 200, undefined, context)).items.toReversed();
  return { ...runtime, requests, reports, admitted, send, entries };
}

/** The text of a tool result entry. */
function resultText(entry: EntryRecord): string {
  const [message] = entry.model ?? [];
  return message?.role === 'toolResult' ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('') : '';
}

test('blocks are numbered through a run\'s replies; only invalid ones are listed, with their ids and issues', async () => {
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models: createModels() }, context);
  try {
    const root = await harness.root(context);
    const reply = (content: AssistantMessage['content']) => root.commit(tx => tx.appendEntry(root.id, { kind: 'pi.assistant', model: [{ role: 'assistant', content, api: 'test', provider: 'test', model: 'fixes', usage, stopReason: 'stop', timestamp: 1 }] }), context);
    const spec = '{"root":"plan","elements":{"plan":{"type":"Text","id":"plan","props":{"text":"hi"},"children":["x"]}}}';
    const svg = `${fence}svg\n<svg viewBox="0 0 4 4"><rect fill="white"/></svg>\n${fence}`;
    const first = await reply([text(`Drawn:\n${svg}`), { type: 'toolCall', id: 'call', name: 'read', arguments: {} }, text(`And:\n${emptyMermaid}`)]);
    const second = await reply([text(`${fence}gitspace-ui\n${spec}\n${fence}\n${fence}ts\nconst x = {"root":\n${fence}`)]);
    const blocks = invalidBlocks([first, second]);
    expect(blocks).toEqual([
      { number: 2, entry: Number(first.id), message: 0, part: 2, block: 0, kind: 'mermaid', id: null, issues: ['the Mermaid source is empty'] },
      { number: 3, entry: Number(second.id), message: 0, part: 0, block: 0, kind: 'gitspace-ui', id: 'plan', issues: ['/elements/plan/children/0: no element "x" in elements', '/elements/plan/children: Text takes no children'] },
    ]);
    expect(blockFixPrompt(blocks).split('\n')).toEqual([
      'Your reply holds blocks that do not validate; the chat shows an error card in place of each. Blocks are numbered through your reply from 1.',
      'Block 2 (mermaid): the Mermaid source is empty',
      'Block 3 (gitspace-ui, id "plan"): /elements/plan/children/0: no element "x" in elements; /elements/plan/children: Text takes no children',
      'Correct them in place: call fix_block once per block, with block (its number or id) and source (the corrected body of its fence, without the fence lines; the fence keeps its info string, so send one whole fence to change that), checked against the drawing brief or skill://gitspace-ui. Each block takes 3 tries. Write nothing else: the person sees only your reply, with each block replaced by its correction.',
    ]);
    expect(invalidBlocks([await reply([text(`${svg}\n${fence}mermaid\ngraph TD; A-->B\n${fence}`)])])).toEqual([]);
  } finally { await harness.close(context); }
});

test('a reply with an invalid block gets a hidden fix step; a refused correction answers its issues, a valid one replaces the block in the model\'s context while the reply stays stored as it was', async () => {
  const runtime = await open([
    [text(REPLY)],
    [fix('bad', 1, '')],
    [fix('good', 1, 'graph TD; A-->B')],
    [text('Next answer.')],
  ]);
  try {
    await runtime.send('Draw the flow');
    const entries = await runtime.entries();
    const reply = entries.find(entry => AssistantEntry.is(entry));
    expect(reply?.model?.[0]).toMatchObject({ content: [text(REPLY)] });
    // The step is an input of its own, placed as the fix entry with its own admitted request.
    const step = entries.find(entry => BlockFixEntry.is(entry));
    expect(BlockFixEntry.is(step) && step.data.blocks).toEqual([{ number: 1, entry: Number(reply?.id), message: 0, part: 0, block: 0, kind: 'mermaid', id: null, issues: ['the Mermaid source is empty'] }]);
    expect(runtime.admitted).toEqual(['request-Draw the flow', `block-fix:${String(reply?.id)}`]);
    expect(runtime.requests[1]?.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining('Block 1 (mermaid): the Mermaid source is empty') });
    expect(entries.filter(entry => ToolResultEntry.is(entry)).map(resultText)).toEqual(['Block 1 is still invalid: the Mermaid source is empty. 2 tries left.', 'Block 1 corrected.']);
    // The valid correction ended the step: no request followed it.
    expect(runtime.requests).toHaveLength(3);
    const correction = entries.find(entry => BlockCorrectionEntry.is(entry));
    const corrected = REPLY.replace(emptyMermaid, `${fence}mermaid\ngraph TD; A-->B\n${fence}`);
    expect(BlockCorrectionEntry.is(correction) && correction.data).toEqual({ reply: Number(reply?.id), corrected: [{ message: 0, part: 0, block: 0, at: expect.any(String), issues: ['the Mermaid source is empty'] }] });
    expect(reply && correctedReply(reply, correction)?.model[0]).toMatchObject({ role: 'assistant', content: [text(corrected)] });
    expect((await runtime.harness.snapshot(BlockCorrectionsDoc, runtime.root.id, context))?.replies).toEqual({ [String(reply?.id)]: Number(correction?.id) });
    // The next turn's model request carries the corrected reply, never the invalid block.
    await runtime.send('Thanks');
    const next = runtime.requests[3] ?? [];
    expect(next.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text === corrected))).toBe(true);
    expect(next.some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && part.text.includes(emptyMermaid)))).toBe(false);
    expect(runtime.admitted).toHaveLength(3);
    expect(runtime.reports).toEqual([]);
  } finally { await runtime.harness.close(context); }
});

test('a short-form block is listed by its id and corrected in place, keeping its info string', async () => {
  const line = (change: string) => JSON.stringify({ lines: [{ depth: 0, code: 'cache.get(key)', change }] });
  const reply = `The fix:\n${fence}gitspace-ui CallDiff id=fix-path\n${line('moved')}\n${fence}`;
  const runtime = await open([[text(reply)], [fix('good', 'fix-path', line('added'))]]);
  try {
    await runtime.send('Show the fix');
    const entries = await runtime.entries();
    const step = entries.find(entry => BlockFixEntry.is(entry));
    expect(BlockFixEntry.is(step) && step.data.blocks.map(block => block.id)).toEqual(['fix-path']);
    expect(entries.filter(entry => ToolResultEntry.is(entry)).map(resultText)).toEqual(['Block 1 corrected.']);
    const answer = entries.find(entry => AssistantEntry.is(entry));
    const correction = entries.find(entry => BlockCorrectionEntry.is(entry));
    expect(answer && correctedReply(answer, correction)?.model[0]).toMatchObject({ content: [text(`The fix:\n${fence}gitspace-ui CallDiff id=fix-path\n${line('added')}\n${fence}`)] });
  } finally { await runtime.harness.close(context); }
});

test('a block takes 3 tries: the third refusal ends the step and a fourth call is refused unread; the block stays as it was', async () => {
  const runtime = await open([
    [text(REPLY)],
    [fix('one', 1, '')],
    [fix('two', '1', 'graph TD; A-->\n```')],
    [fix('three', 1, ''), fix('four', 1, 'graph TD; A-->B')],
    [text('Never asked.')],
  ]);
  try {
    await runtime.send('Draw the flow');
    const entries = await runtime.entries();
    expect(entries.filter(entry => ToolResultEntry.is(entry)).map(resultText)).toEqual([
      'Block 1 is still invalid: the Mermaid source is empty. 2 tries left.',
      'The source of block 1 holds a fence line; send only the body of its fence. 1 try left.',
      'Block 1 is still invalid: the Mermaid source is empty. That was its last try; its error card stays.',
      'Block 1 had its 3 tries; its error card stays.',
    ]);
    expect(runtime.requests).toHaveLength(4);
    expect(entries.some(entry => BlockCorrectionEntry.is(entry))).toBe(false);
    expect((await runtime.harness.snapshot(BlockCorrectionsDoc, runtime.root.id, context))?.replies ?? {}).toEqual({});
  } finally { await runtime.harness.close(context); }
});

test('a reply whose blocks are valid gets no fix step, and fix_block outside one changes nothing', async () => {
  const runtime = await open([
    [text(`${fence}svg\n<svg viewBox="0 0 4 4"><rect fill="#f4f4f5"/></svg>\n${fence}`)],
    [fix('stray', 1, 'graph TD; A-->B')],
  ]);
  try {
    await runtime.send('Draw it');
    await runtime.send('Fix it anyway');
    const entries = await runtime.entries();
    expect(entries.some(entry => BlockFixEntry.is(entry))).toBe(false);
    expect(entries.filter(entry => ToolResultEntry.is(entry)).map(resultText)).toEqual(['fix_block corrects blocks only when GitSpace lists your reply\'s invalid blocks; nothing was changed.']);
    expect(runtime.admitted).toEqual(['request-Draw it', 'request-Fix it anyway']);
  } finally { await runtime.harness.close(context); }
});

test.each([
  ['fails', async (): Promise<void> => { throw new Error('no model for this profile'); }, 'its inference admission failed: no model for this profile'],
  ['never answers', async (): Promise<void> => { await Promise.withResolvers<void>().promise; }, 'its inference admission took longer than 0.05 s'],
])('a fix step whose admission %s is given up and reported; the run ends and nothing is queued', async (_name, admit, reason) => {
  const reports: unknown[] = [];
  const fixes = createBlockFixes(admit, 50);
  const registry = createRegistry();
  registry.install(defineExtension({ name: 'fixes-proof', tools: [fixBlockTool] }));
  registry.install(fixes.extension);
  let requests = 0;
  const models = Object.assign(createModels(), { getModel: () => model, streamSimple() {
    requests++;
    const reply: AssistantMessage = { role: 'assistant', content: [text(REPLY)], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message: reply }); stream.end(reply);
    return stream;
  } });
  const harness = await Harness.open(new MemoryStorage(), { registry, models, onReport: report => { reports.push(report.error); } }, context);
  const observation = harness.observeCommits({ end() {}, advance(publication) { for (const change of publication.changes) if (change.type === 'entry') fixes.noteReply(change.value); } });
  try {
    const root = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, tools: [fixBlockTool] } });
    await root.submit({ type: 'input', content: 'Draw the flow', requestId: 'draw' }, context);
    await root.waitForIdle(withAbortSignal(AbortSignal.timeout(5000), context));
    expect((await harness.snapshot(LiveDoc, root.id, context))?.run).toBeUndefined();
    expect(requests).toBe(1);
    expect((await root.entries({}, 50, undefined, context)).items.some(entry => BlockFixEntry.is(entry))).toBe(false);
    expect(reports.map(String)).toEqual([`Error: The block fix step was given up: ${reason}`]);
  } finally { observation.detach(); await harness.close(context); }
});
