import { expect, test } from 'vitest';
import { AssistantEntry, defineDoc, MemoryStorage, ToolResultEntry, UserEntry } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context';
import { createAssistantMessageEventStream, createModels, type Api, type AssistantMessage, type Context, type Message, type Model } from '@earendil-works/pi-ai';
import { RuntimeIdentitySchema, type WorkspaceBoardRow } from '@gitspace/protocol-runtime';
import { boundedReplay } from './documents.js';
import { createRuntimeHarness } from './harness.js';
import { PROJECT_BOARD_INSTRUCTION, STACK_BOARD_INSTRUCTION } from './project-board.js';

const model: Model<Api> = { id: 'board', name: 'Board', provider: 'test', api: 'test', baseUrl: 'https://invalid.test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 4096 };
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const unused = async (): Promise<never> => { throw new Error('Unexpected service'); };
const colored = (primaryColor: NonNullable<WorkspaceBoardRow['status']>['primaryColor']): WorkspaceBoardRow['status'] => ({ primaryColor, agents: { green: 0, blue: 0, orange: 0, red: 0 }, machines: { attached: 0, online: 0, ready: 0 }, sync: { conflicts: 0, problems: 0 } });
const reply = (content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage => ({ role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason, timestamp: Date.now(), usage });
/** Today at 17:00 UTC: a board line shows a time of the day it is read without its date. */
const today = `${new Date().toISOString().slice(0, 10)}T17:00:00Z`;
const row = (workspaceId: string, name: string, changes: Partial<WorkspaceBoardRow> = {}): WorkspaceBoardRow => ({
  workspaceId, name, phase: 'code', lifecycle: 'active', status: colored('blue'), waitingOn: null, pullRequests: [], since: today, lastReply: null, lastReplySource: null, journal: [], ...changes,
});
const text = (message: Message | undefined) => typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content);
/** The instructions a request carries: pi sends them as system messages in the conversation. */
const instructions = (request: Context | undefined) => JSON.stringify(request?.messages.filter(message => String(message.role) === 'system'));

/** The project agent's harness (its base workspace), whose board reads `board.rows` (or fails with `board.failure`);
 * with `stack`, a workspace agent's harness whose stack board reads `board.rows`, or null while `board.heads` is false.
 * `script` holds the model's replies in order, then it answers "Done.". `history` is appended before the first turn. */
async function fixture(options: { history?: number; script?: AssistantMessage[]; stack?: true } = {}) {
  const requests: Context[] = [];
  const script = [...options.script ?? []];
  const board: { rows: WorkspaceBoardRow[]; failure: string | null; heads: boolean } = { rows: [row('billing', 'Billing export'), row('search', 'Search index', { status: colored('green') })], failure: null, heads: true };
  const read = async () => { if (board.failure !== null) throw new Error(board.failure); return board.rows; };
  const models = Object.assign(createModels(), { getModel: () => model,
    async completeSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      return reply([{ type: 'text', text: 'Handoff: the person asked about billing.' }], 'stop');
    },
    streamSimple(_model: Model<Api>, request: Context) {
      requests.push(request);
      const answer = script.shift() ?? reply([{ type: 'text', text: 'Done.' }], 'stop');
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: answer.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: answer });
      stream.end(answer);
      return stream;
    } });
  const { harness, root } = await createRuntimeHarness({
    identity: RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: options.stack ? 'billing' : 'project' }), storage: new MemoryStorage(), models, model: { provider: 'test', modelId: model.id },
    tools: { images: { store: async image => image, load: async image => image }, prepareBrowser: unused, takeoverTab: unused, lifecycleApproval: async () => null, instructions: async () => 'Project instructions.', preflight: async () => {}, results: { put: unused, text: unused },
      async invoke(input) { return { requestId: input.requestId, attemptId: input.attemptId, status: 'completed', content: [{ type: 'text', text: '[]' }] }; },
      ...options.stack ? { stackBoard: async () => board.heads ? read() : null } : { projectBoard: read } },
    operations: { execute: unused, reconcile: async () => null, cancel: unused, jobScope: () => ({ projectId: 'project', workspaceId: 'project' }), controlJob: unused, observeProcess: unused, stopProcess: unused, wakeAt: async () => {} },
    retainedRules: { loadRules: async () => [] }, editTool: () => 'edit',
    onReport: error => { throw error; }, admitInference: unused, bindInferenceConversation: async () => {}, refuseRequest: unused,
    unfinished: { begin: () => 0, end: () => {} },
  });
  if (options.history) await root.commit(async tx => {
    for (let index = 0; index < options.history!; index++) await tx.appendEntry(UserEntry, root.id, { model: [{ role: 'user', content: `Earlier request ${index}: ${'z'.repeat(12_000)}`, timestamp: 1 + index }] });
  }, context);
  let turns = 0;
  /** One turn of the person: every request it made. */
  async function turn(message: string) {
    const before = requests.length;
    await root.submit({ type: 'input', content: message, requestId: `turn-${++turns}` }, context);
    await root.waitForIdle(context);
    return requests.slice(before);
  }
  return { harness, root, board, requests, turn };
}

test('the first turn carries the full board, a later one only what changed, and the cached prefix and instructions stay as they were', async () => {
  const f = await fixture();
  try {
    const [first] = await f.turn('Which workspaces need me?');
    expect(text(first!.messages.at(-1))).toMatch(/^Workspace board, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(2 workspaces\):\n- Billing export \(billing\) · code · idle · since 17:00\n- Search index \(search\) · code · working · since 17:00$/u);
    expect(instructions(first)).toContain(JSON.stringify(PROJECT_BOARD_INSTRUCTION).slice(1, -1));

    f.board.rows = [row('billing', 'Billing export', { phase: 'plan', status: colored('orange'), waitingOn: { kind: 'ask', prompt: 'Which bucket?' }, since: today.replace('T17:00', 'T18:50') }), f.board.rows[1]!, row('onboarding', 'Onboarding')];
    const [second] = await f.turn('And now?');
    // Everything the first turn sent is sent again unchanged; the change comes after it.
    expect(second!.messages.slice(0, first!.messages.length)).toEqual(first!.messages);
    const changes = text(second!.messages.at(-1));
    expect(changes).toMatch(/^Workspace board changes since \d\d:\d\d \(now .+ UTC\); each line replaces that workspace's line:\n/u);
    expect(changes).toContain('- Billing export (billing) · plan · waiting on a person to answer "Which bucket?" · since 18:50');
    expect(changes).toContain('- New: Onboarding (onboarding) · code · idle · since 17:00');
    expect(changes).not.toContain('Search index');
    expect(instructions(second)).toBe(instructions(first));

    // Nothing changed: nothing is appended.
    const [third] = await f.turn('Anything else?');
    expect(text(third!.messages.at(-1))).toBe('Anything else?');
    expect(instructions(third)).toBe(instructions(first));
  } finally { await f.harness.close(context); }
}, 20_000);

test('a board stored by an earlier release, its rows without every pull request\'s state, gives the next turn a full board, not a failed read', async () => {
  const f = await fixture();
  try {
    // The state the release before left: version 2 rows with one pull request number, and a full board the
    // conversation shows.
    const full = 'Workspace board, 2026-11-08 17:00:00 UTC (1 workspace):';
    const BoardVersion2 = defineDoc<{ rows: Array<Omit<WorkspaceBoardRow, 'pullRequests'> & { pullRequest: number | null }>; at: number; full: string | null; changes: number; turn: string | null }>({ kind: 'gitspace.project-board', version: 2, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ rows: [], at: 0, full: null, changes: 0, turn: null }), checkpointWhen: boundedReplay });
    await f.root.commit(async tx => {
      await tx.appendEntry(UserEntry, f.root.id, { model: [{ role: 'user', content: `${full}\n- Billing export (billing) · code · idle · PR #42 · since 17:00`, timestamp: 1 }] });
      const { pullRequests: _pulls, ...earlier } = row('billing', 'Billing export');
      Object.assign(await tx.doc(BoardVersion2, f.root.id), { rows: [{ ...earlier, pullRequest: 42 }], at: Date.parse('2026-11-08T17:00:00Z'), full, changes: 0, turn: null });
    }, context);
    const [first] = await f.turn('Which workspaces need me?');
    expect(text(first!.messages.at(-1))).toMatch(/^Workspace board, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(2 workspaces\):\n- Billing export \(billing\)/u);
  } finally { await f.harness.close(context); }
}, 20_000);

test('a board is read once per turn: the turn\'s later requests carry it once, where the first put it', async () => {
  const call = reply([{ type: 'toolCall', id: 'list-1', name: 'space_workspace', arguments: { method: 'list' } }], 'toolUse');
  const f = await fixture({ script: [call] });
  try {
    const [request, after] = await f.turn('List them.');
    expect(after!.messages.slice(0, request!.messages.length)).toEqual(request!.messages);
    expect(after!.messages.filter(message => text(message).startsWith('Workspace board'))).toHaveLength(1);
  } finally { await f.harness.close(context); }
}, 20_000);

test('changes that would pass the size come as a fresh full board', async () => {
  const f = await fixture();
  try {
    f.board.rows = Array.from({ length: 30 }, (_, index) => row(`workspace-${index}`, `Workspace with a long descriptive name number ${index}`));
    await f.turn('First.');
    f.board.rows = f.board.rows.map(item => ({ ...item, status: colored('green') }));
    const [request] = await f.turn('Second.');
    expect(text(request!.messages.at(-1))).toMatch(/^Workspace board, .+ \(30 workspaces\):/u);
  } finally { await f.harness.close(context); }
}, 20_000);

test('the compaction summary ends with the full board, and the first turn after it carries a full board again', async () => {
  const f = await fixture({ history: 8 });
  try {
    await f.turn('First.');
    await f.root.compact(undefined, context);
    await f.root.waitForIdle(context);
    const entries = JSON.stringify((await f.root.entries({}, 200, undefined, context)).items);
    expect(entries).toMatch(/Handoff: the person asked about billing\.\\n\\nWorkspace board, .+ \(2 workspaces\):\\n- Billing export \(billing\)/u);
    const [request] = await f.turn('Second.');
    expect(text(request!.messages.at(-1))).toMatch(/^Workspace board, .+ \(2 workspaces\):/u);
  } finally { await f.harness.close(context); }
}, 20_000);

test('a board that cannot be read says so and why', async () => {
  const f = await fixture();
  try {
    f.board.failure = 'Durable Object reset because its code was updated.';
    const [request] = await f.turn('Is billing safe to archive?');
    expect(text(request!.messages.at(-1))).toMatch(/^The workspace board could not be read at .+: Durable Object reset because its code was updated\.\nTell the person you could not read the current state of this project's workspaces; do not answer from memory\.$/u);
  } finally { await f.harness.close(context); }
}, 20_000);

test('a call this project\'s object restart cut off reaches the model with the likely cause', async () => {
  const f = await fixture();
  try {
    await f.root.commit(async tx => {
      await tx.appendEntry(UserEntry, f.root.id, { model: [{ role: 'user', content: 'Which workspaces wait?', timestamp: 1 }] });
      await tx.appendEntry(AssistantEntry, f.root.id, { model: [reply([{ type: 'toolCall', id: 'status-1', name: 'space_workspace', arguments: { method: 'list' } }], 'toolUse')] });
      await tx.appendEntry(ToolResultEntry, f.root.id, { model: [{ role: 'toolResult', toolCallId: 'status-1', toolName: 'space_workspace', content: [{ type: 'text', text: 'Tool space_workspace was interrupted and may have partially run' }], isError: true, timestamp: 2 }], data: { diagnostics: [] } });
    }, context);
    const [request] = await f.turn('Well?');
    const result = request!.messages.find(message => message.role === 'toolResult');
    expect(text(result)).toContain('Tool space_workspace was interrupted because this project\'s object restarted (often its memory limit; see Monitoring); it may have partially run.');
  } finally { await f.harness.close(context); }
}, 20_000);

test('a stack\'s head starts its turns with its stack board, its members with their stack state, then only what changed; one that stops heading a stack gets none, and a full board once it heads one again', async () => {
  const f = await fixture({ stack: true });
  const told = JSON.stringify(STACK_BOARD_INSTRUCTION).slice(1, -1);
  try {
    f.board.rows = [row('ledger', 'Ledger', { stack: { on: 'Billing export', position: { behind: 3, baseRewritten: false, parentMerged: false } } }), row('invoices', 'Invoices', { stack: { on: 'Ledger', position: { behind: 0, baseRewritten: true, parentMerged: false } } })];
    const [first] = await f.turn('How is my stack?');
    expect(text(first!.messages.at(-1))).toMatch(/^Stack board, \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC \(2 workspaces\):\n- Ledger \(ledger\) · on Billing export · 3 behind · code · idle · since 17:00\n- Invoices \(invoices\) · on Ledger · base rewritten · code · idle · since 17:00$/u);
    expect(instructions(first)).not.toContain(JSON.stringify(PROJECT_BOARD_INSTRUCTION).slice(1, -1));

    f.board.rows = [f.board.rows[0]!, row('invoices', 'Invoices', { stack: { on: 'Ledger', position: { behind: 2, baseRewritten: false, parentMerged: true } } })];
    const [second] = await f.turn('And now?');
    expect(text(second!.messages.at(-1))).toMatch(/^Stack board changes since \d\d:\d\d \(now .+ UTC\); each line replaces that workspace's line:\n- Invoices \(invoices\) · on Ledger · 2 behind · parent merged · code · idle · since 17:00$/u);
    // The instructions in effect (the newest system message) say what the board is once the head has one.
    expect(JSON.stringify(second!.messages.filter(message => String(message.role) === 'system').at(-1))).toContain(told);

    // Unstacked or merged: no board, and the instruction leaves with it.
    f.board.heads = false;
    const [third] = await f.turn('Still there?');
    expect(text(third!.messages.at(-1))).toBe('Still there?');
    const [fourth] = await f.turn('Anything?');
    // Nothing follows the person's message but the system message that takes the instruction away.
    expect(text(fourth!.messages.findLast(message => message.role === 'user'))).toBe('Anything?');
    expect(String(fourth!.messages.at(-1)?.role)).toBe('system');
    expect(JSON.stringify(fourth!.messages.filter(message => String(message.role) === 'system').at(-1))).not.toContain(told);

    f.board.heads = true;
    const [fifth] = await f.turn('Back?');
    expect(text(fifth!.messages.at(-1))).toMatch(/^Stack board, .+ UTC \(2 workspaces\):\n- Ledger \(ledger\)/u);
  } finally { await f.harness.close(context); }
}, 20_000);
