import { expect, test } from 'vitest';
import { MemoryStorage } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Context, type Message, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { createRuntimeHarness } from './harness.js';
import { WORKSPACE_BASE_INSTRUCTION, type WorkspaceBase } from './workspace-base.js';

const model: Model<Api> = { id: 'base', name: 'Base', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const done: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage };
const text = (message: Message | undefined) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
const baseLines = (request: Context | undefined) => request?.messages.map(text).filter(line => line.startsWith('Base ·')) ?? [];
const commit = (digit: string) => digit.repeat(40);
const develop = (head: string, changes: Partial<WorkspaceBase> = {}): WorkspaceBase => ({ baseBranch: 'develop', parent: null, head, subject: null, behind: 0, overlapping: null, ...changes });

/** A workspace agent's harness whose base reads `state.base`. */
async function fixture() {
  const requests: Context[] = [];
  const state = { base: develop(commit('1')) };
  const models = Object.assign(createModels(), { getModel: () => model, completeSimple: unused,
    streamSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: done });
      stream.end(done);
      return stream;
    } });
  const { harness, root } = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'billing' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => 'Workspace instructions.', preflight: async () => {}, results: { put: unused, text: unused },
      invoke: unused, workspaceBase: async () => state.base },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'billing' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: unused,
    unfinished: { begin: () => 0, end: () => {} },
  });
  let turns = 0;
  async function turn(message: string) {
    const before = requests.length;
    await root.submit({ type: 'input', content: message, requestId: `turn-${++turns}` }, context);
    await root.waitForIdle(context);
    return requests.slice(before)[0];
  }
  return { harness, state, turn };
}

test('an unstacked workspace is told once, at its next turn, that the project base moved; later turns say nothing until it moves again', async () => {
  const f = await fixture();
  try {
    const first = await f.turn('Start.');
    expect(baseLines(first)).toEqual([]);
    expect(JSON.stringify(first?.messages.filter(message => String(message.role) === 'system'))).toContain(JSON.stringify(WORKSPACE_BASE_INSTRUCTION).slice(1, -1));

    f.state.base = develop(commit('2'), { subject: 'Ship the export', behind: 12, overlapping: 3 });
    const second = await f.turn('Next.');
    expect(text(second?.messages.at(-1))).toBe('Base · develop moved to 2222222 (latest: “Ship the export”). Your branch is 12 behind; 3 files you changed also changed there.');
    expect(second?.messages.slice(0, first!.messages.length)).toEqual(first!.messages);

    const third = await f.turn('And now?');
    expect(text(third?.messages.at(-1))).toBe('And now?');
    expect(baseLines(third)).toHaveLength(1);
  } finally { await f.harness.close(context); }
}, 20_000);

test('after several moves between turns, the line shows only the latest', async () => {
  const f = await fixture();
  try {
    await f.turn('Start.');
    f.state.base = develop(commit('2'), { subject: 'First move', behind: 1 });
    f.state.base = develop(commit('3'), { subject: 'Second move', behind: 2 });
    f.state.base = develop(commit('4'), { subject: 'Third move', behind: 3 });
    const next = await f.turn('Next.');
    expect(baseLines(next)).toEqual(['Base · develop moved to 4444444 (latest: “Third move”). Your branch is 3 behind.']);
  } finally { await f.harness.close(context); }
}, 20_000);

test('a stacked workspace\'s line names its parent, and a merged parent says to restack onto the base branch', async () => {
  const f = await fixture();
  try {
    const parent = { id: 'export', name: 'Billing export', branch: 'billing-export', merged: false };
    f.state.base = develop(commit('5'), { parent, behind: 0 });
    await f.turn('Start.');

    f.state.base = develop(commit('6'), { parent, subject: 'Add CSV', behind: 2 });
    expect(baseLines(await f.turn('Next.'))).toEqual(['Base · Billing export (your stack parent) moved to 6666666 (latest: “Add CSV”). Your branch is 2 behind.']);

    f.state.base = develop(commit('6'), { parent: { ...parent, merged: true }, subject: 'Add CSV', behind: 2 });
    expect(baseLines(await f.turn('Merged?')).at(-1)).toBe('Base · Billing export (your stack parent) merged into develop; restack onto develop: `git rebase --onto develop billing-export`.');

    f.state.base = develop(commit('7'), { subject: 'Release', behind: 0 });
    expect(baseLines(await f.turn('Restacked?')).at(-1)).toBe('Base · Restacked onto develop at 7777777 (latest: “Release”). Your branch has all of it.');
  } finally { await f.harness.close(context); }
}, 20_000);
