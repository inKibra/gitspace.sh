import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Context, type Message, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { CHATTER_DIGEST_INSTRUCTION, type ChatterTurnDigest } from './chatter-digest.js';
import { AgentDefinitionContextDoc } from './subagent-state.js';

const model: Model<Api> = { id: 'listener', name: 'Listener', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const done: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
const text = (message: Message | undefined) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
const digests = (request: Context | undefined) => request?.messages.map(text).filter(line => line.startsWith('Chatter since your last turn')) ?? [];

/**
 * A main agent whose Chatter is a list of posts by offset: a read after `after` hears every later post once, as the
 * Chatter object does, and records each position it was asked from.
 */
async function fixture() {
  const requests: Context[] = [];
  const chatter: { posts: string[]; asked: (number | null)[]; fail: boolean } = { posts: [], asked: [], fail: false };
  const models = Object.assign(createModels(), { getModel: () => model, completeSimple: unused,
    streamSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: done });
      stream.end(done);
      return stream;
    } });
  const read = async (input: { after: number | null }): Promise<ChatterTurnDigest> => {
    chatter.asked.push(input.after);
    if (chatter.fail) throw new Error('Chatter is restarting');
    const fresh = chatter.posts.slice(input.after ?? 0);
    const body = fresh.map(post => `  10:00 Parser (code, discovery): ${post} [its stack's head]`);
    return { text: fresh.length ? ['Chatter since your last turn (times UTC):', 'Always heard', 'parser:', ...body].join('\n') : null, through: chatter.posts.length, floor: fresh.length, picked: 0, newest: 0, others: 0, tokens: 10, fullTokens: 10 };
  };
  const { harness, root } = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'billing' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => '', preflight: async () => {}, results: { put: unused, text: unused },
      invoke: unused, chatterDigest: read },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'billing' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: unused,
    unfinished: { begin: () => 0, end: () => {} },
  });
  let turns = 0;
  async function turn(message: string, conversation = root) {
    const before = requests.length;
    await conversation.submit({ type: 'input', content: message, requestId: `turn-${++turns}` }, context);
    await conversation.waitForIdle(context);
    return requests.slice(before)[0];
  }
  return { harness, root, chatter, turn };
}

test('a main turn starts with the posts since its last digest, each heard once; a turn with no news gets nothing', async () => {
  const f = await fixture();
  try {
    f.chatter.posts.push('The migration renames the users table.');
    const first = await f.turn('Start.');
    expect(digests(first)).toEqual([expect.stringContaining('The migration renames the users table.')]);
    expect(JSON.stringify(first?.messages.filter(message => String(message.role) === 'system'))).toContain(JSON.stringify(CHATTER_DIGEST_INSTRUCTION).slice(1, -1));

    const quiet = await f.turn('Next.');
    expect(text(quiet?.messages.at(-1))).toBe('Next.');
    expect(digests(quiet)).toHaveLength(1);

    f.chatter.posts.push('Run the backfill after the deploy.');
    const third = await f.turn('And now?');
    expect(digests(third).at(-1)).toContain('Run the backfill after the deploy.');
    expect(digests(third).at(-1)).not.toContain('renames the users table');
    expect(f.chatter.asked).toEqual([null, 1, 1]);
  } finally { await f.harness.close(context); }
}, 20_000);

test('a failed read keeps the position, so the next turn hears what it missed', async () => {
  const f = await fixture();
  try {
    await f.turn('Start.');
    f.chatter.posts.push('The staging database is read-only today.');
    f.chatter.fail = true;
    expect(digests(await f.turn('Next.'))).toEqual([]);
    f.chatter.fail = false;
    expect(digests(await f.turn('Again.')).at(-1)).toContain('The staging database is read-only today.');
    expect(f.chatter.asked).toEqual([null, 0, 0]);
  } finally { await f.harness.close(context); }
}, 20_000);

test('a subagent gets no digest and does not move its parent\'s position', async () => {
  const f = await fixture();
  try {
    f.chatter.posts.push('The parser now emits spans.');
    const child = await f.harness.createConversation({ ownership: { kind: 'ownerless' } }, context);
    await child.configure({ model: { provider: 'test', modelId: model.id } }, context);
    await child.commit(async tx => {
      (await tx.doc(AgentDefinitionContextDoc, child.id)).child = { parentId: String(f.root.id), name: 'Helper', requestedName: 'Helper', attemptId: 'spawn-1', definition: null, selection: { kind: 'default' }, role: null, thinking: null, tools: [], model: { provider: 'test', modelId: model.id } };
    }, context);
    const childRequest = await f.turn('Look at the parser.', child);
    expect(digests(childRequest)).toEqual([]);
    expect(JSON.stringify(childRequest?.messages)).not.toContain(JSON.stringify(CHATTER_DIGEST_INSTRUCTION).slice(1, -1));
    expect(f.chatter.asked).toEqual([]);
    expect(digests(await f.turn('Start.')).at(-1)).toContain('The parser now emits spans.');
  } finally { await f.harness.close(context); }
}, 20_000);
