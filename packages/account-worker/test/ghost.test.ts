import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { AssistantMessage, Context, ToolCall } from '@earendil-works/pi-ai';
import { createDeviceBinding, credentialProtocolBase64, DEVICE_SOCKET_PROTOCOL, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { GHOST_LIFETIME_MS, GHOST_MAX_ROUNDS, GHOST_PATH, GhostAskResultSchema, GhostServerMessageSchema, RuntimeIdentitySchema, RuntimeSnapshotSchema, type GhostServerMessage, type ServiceUsage } from '@gitspace/protocol-runtime';
import { InspectorCloudArtifacts, readInspectorContext } from '../src/account-inspector-data.js';
import { createDocumentMarkdown } from '../src/document-markdown.js';
import { GhostSession, type GhostModel } from '../src/ghost-session.js';
import { createGhostTools } from '../src/ghost-tools.js';
import { serveGhost } from '../src/ghost.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const origin = 'https://test.gitspace.sh';
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

/** A project with one workspace, and a browser of the account that may read and prompt. */
async function fixture() {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(crypto.getRandomValues(new Uint8Array(32))) });
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'Ghosts', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  await index.put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  const key = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'session.prompt'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: `${origin}/v1/devices/enroll` }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Laptop', boundAt: Date.now(), signingPrivateKey: key });
  expect(await vault.enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  return { identity: RuntimeIdentitySchema.parse({ projectId, workspaceId }), device: { deviceId: binding.deviceId, key } };
}

/** Two conversations of the workspace: the main one the ghost reads, and another it must never reach; and the asking
 * agent's own conversation, in another workspace. */
const TRANSCRIPTS: Record<string, string[]> = {
  main: ['Where should exports go?', 'The archive bucket: uploads is public.', 'Exports now go to the archive bucket.'],
  other: ['The other conversation keeps a secret: the launch is on Friday.'],
  asking: ['Which port does the proxy use?', 'Port 8443: 443 is taken by the gateway.'],
};
const RangeSchema = z.object({ from: z.number().optional(), before: z.number().optional(), newestFirst: z.boolean().optional() });

/** The workspace object's transcripts as NDJSON, one entry per message (ordinal entry*1024), honouring the range. */
function transcripts() {
  return vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeTranscript').mockImplementation(async (raw, _format, range) => {
    const conversationId = z.object({ conversationId: z.string() }).parse(raw).conversationId;
    const { from, before, newestFirst } = RangeSchema.parse(range);
    const events = (TRANSCRIPTS[conversationId] ?? []).map((text, entry) => ({ ordinal: entry * 1024, kind: 'message', createdAt: '2026-11-20T09:00:00.000Z', sessionId: conversationId, payload: { message: { role: entry % 2 === 0 ? 'user' : 'assistant', content: text } } }))
      .filter(event => (from === undefined || event.ordinal >= from) && (before === undefined || event.ordinal < before));
    return new Response((newestFirst ? events.reverse() : events).map(event => `${JSON.stringify(event)}\n`).join(''));
  });
}

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 } };
function reply(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', content, api: 'openai-responses', provider: 'openai', model: 'fake', usage, stopReason, timestamp: Date.now() };
}
const call = (id: string, name: string, args: ToolCall['arguments']): ToolCall => ({ type: 'toolCall', id, name, arguments: args });

/** A model that answers each request with the next scripted reply, streaming its text; every request's context is kept. */
function scripted(replies: Array<(context: Context) => AssistantMessage>) {
  const contexts: Context[] = [];
  const model: GhostModel = {
    name: 'openai/fake',
    async respond(context, _signal, onText) {
      contexts.push(structuredClone(context));
      const next = replies[Math.min(contexts.length, replies.length) - 1];
      if (!next) throw new Error('No scripted reply');
      const answer = next(context);
      for (const part of answer.content) if (part.type === 'text') for (const piece of part.text.match(/.{1,5}/gsu) ?? []) onText(piece);
      return answer;
    },
  };
  return { model, contexts };
}

/** A ghost of `identity`'s main conversation with `model`, its drive read as of `driveAsOf`; what it sends, collected. */
async function ghost(identity: z.infer<typeof RuntimeIdentitySchema>, model: GhostModel, driveAsOf = new Date().toISOString()) {
  const sent: GhostServerMessage[] = [];
  const recorded: unknown[] = [];
  const session = new GhostSession({
    ghostId: 'ghost-test',
    send: message => sent.push(GhostServerMessageSchema.parse(message)),
    close() {},
    alarm: { set: async () => {}, clear: async () => {} },
    recordUsage: async spent => { recorded.push(spent); await env.CREDENTIALS.getByName(env.ACCOUNT_ID).recordServiceUsage(spent); },
    ended() {},
  });
  const target = { ...identity, conversationId: 'main' };
  await session.start({
    asker: 'person', target, title: 'Main', main: true, entries: 3, archived: false, driveAsOf, profileId: 'default', model,
    tools: createGhostTools({ env, target, driveAsOf, judge: async (_state, questions) => Object.fromEntries(Object.keys(questions).map(id => [id, 1])), documentMarkdown: createDocumentMarkdown(null, env.AI) }),
  });
  const answer = async (text: string) => {
    await session.ask(text);
    const last = sent.at(-1);
    if (last?.type !== 'answer') throw new Error(`Expected an answer, got ${JSON.stringify(last)}`);
    return last;
  };
  return { session, sent, recorded, answer };
}

const toolText = (context: Context) => context.messages.flatMap(message => message.role === 'toolResult' ? message.content.flatMap(part => part.type === 'text' ? [part.text] : []) : []).join('\n');

describe('a ghost of one session', () => {
  test('answers citing what it read from its own conversation; another conversation is unreachable', async () => {
    const { identity } = await fixture();
    const reads = transcripts();
    const { model, contexts } = scripted([
      () => reply([call('search', 'history_search', { query: 'bucket' }), call('elsewhere', 'history_read', { conversationId: 'other', fromEnd: true }), call('project', 'history_search', { query: 'launch', scope: 'project' })], 'toolUse'),
      () => reply([{ type: 'text', text: 'Exports go to the archive bucket [#1], because uploads is public [#1-2].' }], 'stop'),
    ]);
    const { answer, sent } = await ghost(identity, model);

    const answered = await answer('Where do exports go?');
    expect(answered.parts).toEqual(['Exports go to the archive bucket ', { kind: 'entry', from: 1 }, ', because uploads is public ', { kind: 'entry', from: 1, to: 2 }, '.']);
    expect(answered).toMatchObject({ rounds: 1, truncated: false, draft: null });
    // The reads, as the person sees them: the search with its hits, and the two refused reads elsewhere.
    expect(sent.flatMap(message => message.type === 'read' && message.done ? [message] : []).sort((left, right) => left.index - right.index)).toEqual([
      expect.objectContaining({ index: 0, read: { kind: 'search', query: 'bucket', hits: 2 } }),
      expect.objectContaining({ index: 1, failed: expect.stringContaining('reads only its own session') }),
      expect.objectContaining({ index: 2, failed: expect.stringContaining('reads only its own session') }),
    ]);
    // What the model read is the main conversation's, and never the other's.
    const read = toolText(contexts[1]!);
    expect(read).toContain('The archive bucket: uploads is public.');
    expect(read).not.toContain('launch is on Friday');
    expect(reads.mock.calls.every(([raw]) => z.object({ conversationId: z.literal('main') }).safeParse(raw).success)).toBe(true);
    // Its tools are the three reads and nothing else.
    expect(contexts[0]!.tools?.map(tool => tool.name)).toEqual(['history_search', 'history_read', 'read']);
  });

  test('reads its transcript with the arguments models send: numbers or numeric strings, a page or one event', async () => {
    const { identity } = await fixture();
    transcripts();
    const { model, contexts } = scripted([
      () => reply([
        call('page', 'history_read', { offset: 1024, limit: 1 }),
        call('strings', 'history_read', { offset: '2048', limit: '5', textOnly: 'true' }),
        call('event', 'history_read', { mode: 'content', ordinal: 0 }),
        call('event-string', 'history_read', { mode: 'content', ordinal: '1024', contentLimit: '4000' }),
      ], 'toolUse'),
      () => reply([{ type: 'text', text: 'It moved exports to the archive bucket [#2].' }], 'stop'),
    ]);
    const { answer, sent } = await ghost(identity, model);

    await answer('What did it decide?');
    expect(sent.flatMap(message => message.type === 'read' && message.done ? [message] : []).sort((left, right) => left.index - right.index)).toEqual([
      expect.objectContaining({ index: 0, read: { kind: 'read', from: 1, to: 1 } }),
      expect.objectContaining({ index: 1, read: { kind: 'read', from: 2, to: 2 } }),
      expect.objectContaining({ index: 2, read: { kind: 'read', from: 0, to: 0 } }),
      expect.objectContaining({ index: 3, read: { kind: 'read', from: 1, to: 1 } }),
    ]);
    expect(sent.some(message => message.type === 'read' && message.failed !== undefined)).toBe(false);
    const read = toolText(contexts[1]!);
    for (const text of TRANSCRIPTS.main!) expect(read).toContain(text);
    // What the provider is sent: one object per tool, its fields typed, never a bare union it would drop.
    const Published = z.object({ type: z.literal('object'), properties: z.record(z.string(), z.unknown()), anyOf: z.never().optional(), oneOf: z.never().optional() });
    expect(Object.fromEntries((contexts[0]!.tools ?? []).map(tool => [tool.name, Object.keys(Published.parse(tool.parameters).properties).sort()]))).toEqual({
      history_search: ['cursor', 'query'],
      history_read: ['before', 'contentLimit', 'contentOffset', 'fromEnd', 'limit', 'mode', 'offset', 'ordinal', 'role', 'textOnly'],
      read: ['limit', 'offset', 'path'],
    });
  });

  test('reads the drive as it was when the ghost started: a later write is invisible', async () => {
    const { identity } = await fixture();
    transcripts();
    const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, identity.workspaceId, identity.projectId));
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(start + 60_000);
    await artifacts.write('drive://workspace/plan.md', { bytes: new TextEncoder().encode('plan one\nship on Monday') });
    const startedAt = new Date(start + 90_000).toISOString();
    vi.setSystemTime(start + 120_000);
    await artifacts.write('drive://workspace/plan.md', { bytes: new TextEncoder().encode('plan two\nship on Friday') });
    vi.useRealTimers();
    const { model, contexts } = scripted([
      () => reply([call('plan', 'read', { path: 'drive://workspace/plan.md' })], 'toolUse'),
      () => reply([{ type: 'text', text: 'The plan ships on Monday [drive://workspace/plan.md:2-2].' }], 'stop'),
    ]);
    const { answer, sent } = await ghost(identity, model, startedAt);

    const answered = await answer('When does it ship?');
    expect(answered.parts).toEqual(['The plan ships on Monday ', { kind: 'drive', url: 'drive://workspace/plan.md', lines: [2, 2], generation: 1 }, '.']);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'read', done: true, read: { kind: 'drive', url: 'drive://workspace/plan.md', generation: 1 } }));
    const read = toolText(contexts[1]!);
    expect(read).toContain('ship on Monday');
    expect(read).not.toContain('ship on Friday');
  });

  test('asked to act, it refuses and drafts the message for the person to send; it has no tool to act with', async () => {
    const { identity } = await fixture();
    transcripts();
    const { model, contexts } = scripted([
      () => reply([call('act', 'bash', { command: 'git merge' })], 'toolUse'),
      () => reply([{ type: 'text', text: 'I can only read its transcript and the workspace drive, so I can\'t merge anything.\n<draft>Please merge the export change. You left off at #2, after moving exports to the archive bucket.</draft>' }], 'stop'),
    ]);
    const { answer, sent } = await ghost(identity, model);

    const answered = await answer('Merge it for me.');
    expect(answered.draft).toBe('Please merge the export change. You left off at #2, after moving exports to the archive bucket.');
    expect(answered.parts).toEqual(['I can only read its transcript and the workspace drive, so I can\'t merge anything.']);
    // The draft never streams as text, and the call to act found no tool.
    expect(sent.filter(message => message.type === 'text').map(message => message.delta).join('')).not.toContain('<dr');
    expect(toolText(contexts[1]!)).toContain('This ghost has no bash tool');
  });

  test('stops reading at the round cap and answers from what it has', async () => {
    const { identity } = await fixture();
    transcripts();
    const { model, contexts } = scripted([context => context.tools?.length
      ? reply([call(`search-${crypto.randomUUID()}`, 'history_search', { query: 'bucket' })], 'toolUse')
      : reply([{ type: 'text', text: 'From what I read: the archive bucket [#2].' }], 'stop')]);
    const { answer } = await ghost(identity, model);

    const answered = await answer('Read everything.');
    expect(answered).toMatchObject({ rounds: GHOST_MAX_ROUNDS, truncated: true });
    expect(contexts).toHaveLength(GHOST_MAX_ROUNDS + 1);
    expect(contexts.at(-1)!.tools).toEqual([]);
    expect(contexts.at(-1)!.messages.at(-1)).toMatchObject({ role: 'user', content: expect.stringContaining(`used all ${GHOST_MAX_ROUNDS} rounds`) });
  });

  test('records each answer\'s token counts in the account\'s usage, and no text', async () => {
    const { identity } = await fixture();
    transcripts();
    const { model } = scripted([
      () => reply([call('search', 'history_search', { query: 'bucket' })], 'toolUse'),
      () => reply([{ type: 'text', text: 'The archive bucket [#2].' }], 'stop'),
    ]);
    const { answer, recorded } = await ghost(identity, model);

    await answer('Where do exports go?');
    expect(recorded).toEqual([{ service: 'ghost', profileId: 'default', model: 'openai/fake', requests: 2, input: 200, output: 40, costUsd: 0.006 }]);
    const rows = await runInDurableObject(env.CREDENTIALS.getByName(env.ACCOUNT_ID), (_instance, state) => state.storage.sql.exec('SELECT * FROM service_usage').toArray());
    expect(rows).toEqual([{ day: new Date().toISOString().slice(0, 10), profile_id: 'default', service: 'ghost', model: 'openai/fake', workspace_id: '', requests: 2, input: 200, output: 40, cost_usd: 0.006 }]);
  });

  test('moves the account\'s ghost_usage rows into its service usage once, and adds decisions beside them', async () => {
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE ghost_usage(day TEXT NOT NULL, profile_id TEXT NOT NULL, model TEXT NOT NULL, questions INTEGER NOT NULL, requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost_usd REAL NOT NULL, PRIMARY KEY(day, profile_id, model))');
      state.storage.sql.exec("INSERT INTO ghost_usage VALUES('2026-11-01', 'default', 'openai/fake', 3, 5, 100, 20, 30, 10, 0.5)");
    });
    await vault.recordServiceUsage({ service: 'decision', profileId: 'default', model: 'cloudflare/clef-flash', requests: 1, input: 120, output: 0, costUsd: 0.0001 });
    await vault.recordServiceUsage({ service: 'decision', profileId: 'default', model: 'cloudflare/clef-flash', requests: 1, input: 80, output: 0, costUsd: 0.0001 });
    const { rows, ghostTable } = await runInDurableObject(vault, (_instance, state) => ({
      rows: state.storage.sql.exec('SELECT * FROM service_usage ORDER BY day').toArray(),
      ghostTable: state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'ghost_usage'").toArray().length,
    }));
    expect(ghostTable).toBe(0);
    expect(rows).toEqual([
      { day: '2026-11-01', profile_id: 'default', service: 'ghost', model: 'openai/fake', workspace_id: '', requests: 5, input: 140, output: 20, cost_usd: 0.5 },
      { day: new Date().toISOString().slice(0, 10), profile_id: 'default', service: 'decision', model: 'cloudflare/clef-flash', workspace_id: '', requests: 2, input: 200, output: 0, cost_usd: 0.0002 },
    ]);
  });

  test('names the workspace whose agent spent it, and keeps rows recorded before as the account\'s own', async () => {
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    await runInDurableObject(vault, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE service_usage(day TEXT NOT NULL, profile_id TEXT NOT NULL, service TEXT NOT NULL, model TEXT NOT NULL, requests INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL, cost_usd REAL NOT NULL, PRIMARY KEY(day, profile_id, service, model))');
      state.storage.sql.exec("INSERT INTO service_usage VALUES('2026-11-01', 'default', 'ghost', 'openai/fake', 1, 100, 20, 0.5)");
    });
    const spent: ServiceUsage = { service: 'ghost', profileId: 'default', model: 'openai/fake', requests: 1, input: 100, output: 20, costUsd: 0.25 };
    await vault.recordServiceUsage({ ...spent, workspaceId: 'parser' });
    await vault.recordServiceUsage({ ...spent, workspaceId: 'parser' });
    await vault.recordServiceUsage(spent);
    const rows = await runInDurableObject(vault, (_instance, state) => state.storage.sql.exec('SELECT day, workspace_id, requests, cost_usd FROM service_usage ORDER BY day, workspace_id').toArray());
    const today = new Date().toISOString().slice(0, 10);
    expect(rows).toEqual([
      { day: '2026-11-01', workspace_id: '', requests: 1, cost_usd: 0.5 },
      { day: today, workspace_id: '', requests: 1, cost_usd: 0.25 },
      { day: today, workspace_id: 'parser', requests: 2, cost_usd: 0.5 },
    ]);
  });
});

describe('a ghost\'s object', () => {
  /** The ghost socket a signed-in browser opens, and the messages it receives. */
  async function open(identity: z.infer<typeof RuntimeIdentitySchema>, device: { deviceId: string; key: Uint8Array }) {
    const path = `${GHOST_PATH}?${new URLSearchParams(identity)}`;
    const proof = signRpcRequest({ deviceId: device.deviceId, signingPrivateKey: device.key, method: 'GET', path, body: new Uint8Array() });
    const response = await serveGhost(new Request(`${origin}${path}`, { headers: { upgrade: 'websocket', origin, 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${proof}` } }), env);
    const socket = response.webSocket;
    if (!socket) throw new Error(`No ghost socket (${response.status}): ${await response.text()}`);
    const received: GhostServerMessage[] = [];
    const waiting: Array<{ type: GhostServerMessage['type']; resolve(message: GhostServerMessage): void }> = [];
    const closed = Promise.withResolvers<void>();
    socket.addEventListener('message', event => {
      const message = GhostServerMessageSchema.parse(JSON.parse(String(event.data)));
      received.push(message);
      for (const waiter of waiting.splice(0)) { if (waiter.type === message.type) waiter.resolve(message); else waiting.push(waiter); }
    });
    socket.addEventListener('close', () => closed.resolve());
    socket.accept();
    const next = <T extends GhostServerMessage['type']>(type: T) => {
      const { promise, resolve } = Promise.withResolvers<GhostServerMessage>();
      waiting.push({ type, resolve });
      return promise.then(message => message.type === type ? message : Promise.reject(new Error('Unexpected message')));
    };
    return { socket, received, next, closed: closed.promise };
  }

  test('lives in memory only; Keep moves its deadline; at the deadline it fades and nothing remains', async () => {
    const { identity, device } = await fixture();
    transcripts();
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeSnapshot').mockImplementation(async () => Response.json(RuntimeSnapshotSchema.parse({ version: 1, ...identity, cursor: 0, conversations: [{ id: 'main', parentId: null, title: 'Exports', status: 'idle', messages: [] }, { id: 'other', parentId: null, title: 'Other', status: 'idle', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} })));
    network.use(http.get('https://pi.dev/*', () => new HttpResponse(null, { status: 404 })), http.get('https://api.openai.com/*', () => HttpResponse.json({ data: [] })));
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    await vault.ensureInference();
    await vault.putBrowserApiKey('default', 'openai', 'sk-ghost-key');
    const browser = await open(identity, device);

    const ready = await browser.next('ready');
    if (ready.type !== 'ready') throw new Error('Expected ready');
    expect(ready).toMatchObject({ conversationId: 'main', title: 'Exports', entries: 3, archived: false, model: expect.stringMatching(/^openai\//u) });
    const object = env.GHOSTS.getByName(`${env.ACCOUNT_ID}:ghost:${ready.ghostId}`);
    const held = async () => runInDurableObject(object, async (_instance, state) => ({ keys: (await state.storage.list()).size, alarm: await state.storage.getAlarm() }));
    const opened = await held();
    expect(opened.keys).toBe(0);
    expect(opened.alarm).toBe(Date.parse(ready.expiresAt));
    expect(Date.parse(ready.expiresAt) - Date.now()).toBeGreaterThan(GHOST_LIFETIME_MS - 60_000);

    // A minute on: Keep moves the deadline to ten minutes from then.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    browser.socket.send(JSON.stringify({ type: 'keep' }));
    const kept = await browser.next('expires');
    if (kept.type !== 'expires') throw new Error('Expected expires');
    expect(Date.parse(kept.expiresAt)).toBeGreaterThan(Date.parse(ready.expiresAt));
    expect((await held()).alarm).toBe(Date.parse(kept.expiresAt));

    const ended = browser.next('ended');
    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(await ended).toMatchObject({ type: 'ended', reason: 'faded', questions: 0 });
    await browser.closed;
    expect(await held()).toEqual({ keys: 0, alarm: null });
  });

  test('ends when its socket closes', async () => {
    const { identity, device } = await fixture();
    transcripts();
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeSnapshot').mockImplementation(async () => Response.json(RuntimeSnapshotSchema.parse({ version: 1, ...identity, cursor: 0, conversations: [{ id: 'main', parentId: null, title: 'Exports', status: 'idle', messages: [] }], tasks: [], attachments: [], questions: [], documents: {} })));
    network.use(http.get('https://pi.dev/*', () => new HttpResponse(null, { status: 404 })), http.get('https://api.openai.com/*', () => HttpResponse.json({ data: [] })));
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    await vault.ensureInference();
    await vault.putBrowserApiKey('default', 'openai', 'sk-ghost-key');
    const browser = await open(identity, device);
    const ready = await browser.next('ready');
    if (ready.type !== 'ready') throw new Error('Expected ready');
    const object = env.GHOSTS.getByName(`${env.ACCOUNT_ID}:ghost:${ready.ghostId}`);

    browser.socket.close(1000, 'Window closed');
    await vi.waitFor(async () => expect(await runInDurableObject(object, async (_instance, state) => state.storage.getAlarm())).toBeNull());
    // The object holds no ghost any more: an alarm finds nothing to end.
    expect(await runInDurableObject(object, async (_instance, state) => (await state.storage.list()).size)).toBe(0);
  });
});

describe('an agent\'s ghost (ghost_ask)', () => {
  type Turn = Array<Record<string, unknown>>;
  const created = { type: 'response.created', response: { id: 'resp', status: 'in_progress', output: [] } };
  const done = { type: 'response.completed', response: { id: 'resp', status: 'completed', output: [], usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } };
  /** One model turn calling tools, as OpenAI's Responses API streams it. */
  const calls = (...called: Array<[string, Record<string, unknown>]>): Turn => [created, ...called.flatMap(([name, args], index) => {
    const item = { type: 'function_call', id: `fc_${index}`, call_id: `call_${index}`, name };
    return [{ type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '' } }, { type: 'response.output_item.done', output_index: index, item: { ...item, arguments: JSON.stringify(args) } }];
  }), done];
  /** One model turn answering in text. */
  const says = (text: string): Turn => [created,
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg', delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] } },
    done];

  /**
   * The fixture's project with an asking workspace beside its workspace: the asker's conversation is `asking`, the
   * other workspace's are `main` and `other`. The account's default profile answers on OpenAI, whose Responses API
   * streams `turns` in order; every request body is kept.
   */
  async function asking(turns: Turn[]) {
    const { identity } = await fixture();
    const askerId = crypto.randomUUID();
    const reads = transcripts();
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeSnapshot').mockImplementation(async raw => {
      const { workspaceId } = RuntimeIdentitySchema.parse(raw);
      const conversations = workspaceId === askerId ? [{ id: 'asking', parentId: null, title: 'Proxy', status: 'running', messages: [] }]
        : [{ id: 'main', parentId: null, title: 'Exports', status: 'idle', messages: [] }, { id: 'other', parentId: null, title: 'Other', status: 'idle', messages: [] }];
      return Response.json(RuntimeSnapshotSchema.parse({ version: 1, projectId: identity.projectId, workspaceId, cursor: 0, conversations, tasks: [], attachments: [], questions: [], documents: {} }));
    });
    const bodies: string[] = [];
    network.use(
      http.get('https://pi.dev/*', () => new HttpResponse(null, { status: 404 })),
      http.get('https://api.openai.com/*', () => HttpResponse.json({ data: [] })),
      http.post('https://api.openai.com/*', async ({ request }) => {
        bodies.push(await request.text());
        const turn = turns[Math.min(bodies.length, turns.length) - 1] ?? [];
        return new HttpResponse(turn.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
      }),
    );
    const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
    await vault.ensureInference();
    await vault.putBrowserApiKey('default', 'openai', 'sk-ghost-key');
    const asker = { projectId: identity.projectId, workspaceId: askerId, conversationId: 'asking' };
    const ghost = (ghostId: string) => env.GHOSTS.getByName(`${env.ACCOUNT_ID}:ghost:${ghostId}`);
    return { identity, askerId, asker, reads, bodies, ghost };
  }
  const answered = <T extends { status: string }>(reply: T) => {
    if (reply.status !== 'answered' || !('result' in reply)) throw new Error(`Expected an answer, got ${JSON.stringify(reply)}`);
    return GhostAskResultSchema.parse(reply.result);
  };

  test('answers about another workspace\'s session from that session only, cited as the asker reads it; the asking workspace\'s usage counts it', async () => {
    const { identity, askerId, asker, reads, bodies, ghost } = await asking([
      calls(['history_read', { fromEnd: true }], ['history_read', { conversationId: 'other', fromEnd: true }], ['history_read', { conversationId: 'asking', fromEnd: true }]),
      says('Exports go to the archive bucket [#1-2], as the plan says [drive://workspace/plan.md:2-2].'),
    ]);
    const ghostId = crypto.randomUUID();

    const result = answered(await ghost(ghostId).ask({ ghostId, asker, question: 'Where do exports go?', open: { workspaceId: identity.workspaceId, workspace: 'Exports work', conversationId: null, archived: false, profileId: 'default' } }));
    expect(result).toMatchObject({
      ghostId, session: { workspaceId: identity.workspaceId, workspace: 'Exports work', conversationId: 'main', title: 'Exports', main: true, archived: false },
      answer: 'Exports go to the archive bucket [#1-2], as the plan says [drive://workspace/plan.md:2-2].',
      cites: [
        { kind: 'entry', from: 1, to: 2, ref: `history://${identity.workspaceId}/main#1-2` },
        { kind: 'drive', url: 'drive://workspace/plan.md', lines: [2, 2], generation: null, ref: `drive://workspaces/${identity.workspaceId}/plan.md:2-2` },
      ],
      reads: [{ kind: 'read', from: 0, to: 2 }], draft: null, rounds: 1, truncated: false,
      usage: { model: expect.stringMatching(/^openai\//u), requests: 2, input: 200, output: 40 },
    });
    // It read the main conversation of that workspace and nothing else: not its other conversation, not the asker's.
    const read = bodies[1] ?? '';
    expect(read).toContain('The archive bucket: uploads is public.');
    expect(read).not.toContain('launch is on Friday');
    expect(read).not.toContain('Port 8443');
    expect(reads.mock.calls.every(([raw]) => z.object({ workspaceId: z.literal(identity.workspaceId), conversationId: z.literal('main') }).safeParse(raw).success)).toBe(true);
    const rows = await runInDurableObject(env.CREDENTIALS.getByName(env.ACCOUNT_ID), (_instance, state) => state.storage.sql.exec("SELECT service, workspace_id, requests, input, output FROM service_usage WHERE service = 'ghost'").toArray());
    expect(rows).toEqual([{ service: 'ghost', workspace_id: askerId, requests: 2, input: 200, output: 40 }]);
  });

  test('answers about the asker\'s own conversation', async () => {
    const { askerId, asker, reads, bodies, ghost } = await asking([calls(['history_read', { fromEnd: true }]), says('The proxy uses port 8443, since the gateway holds 443 [#1].')]);
    const ghostId = crypto.randomUUID();

    const result = answered(await ghost(ghostId).ask({ ghostId, asker, question: 'Which port did we pick, and why?', open: { workspaceId: askerId, workspace: 'Proxy work', conversationId: 'asking', archived: false, profileId: 'default' } }));
    expect(result).toMatchObject({ session: { workspaceId: askerId, conversationId: 'asking', title: 'Proxy', main: true }, cites: [{ kind: 'entry', from: 1, ref: `history://${askerId}/asking#1` }] });
    expect(bodies[1]).toContain('Port 8443: 443 is taken by the gateway.');
    expect(reads.mock.calls.every(([raw]) => z.object({ workspaceId: z.literal(askerId), conversationId: z.literal('asking') }).safeParse(raw).success)).toBe(true);
  });

  test('a follow-up reuses the ghost and its reads while it lives, only for the conversation that started it; once it fades a new one starts', async () => {
    const { identity, asker, bodies, ghost } = await asking([
      calls(['history_read', { fromEnd: true }]), says('The archive bucket [#2].'),
      says('Because uploads is public [#1].'),
      says('The archive bucket [#2].'),
    ]);
    const ghostId = crypto.randomUUID();
    const open = { workspaceId: identity.workspaceId, workspace: 'Exports work', conversationId: null, archived: false, profileId: 'default' };
    const object = ghost(ghostId);
    const alarm = async () => runInDurableObject(object, async (_instance, state) => ({ keys: (await state.storage.list()).size, alarm: await state.storage.getAlarm() }));

    const first = answered(await object.ask({ ghostId, asker, question: 'Where do exports go?', open }));
    // Another conversation, even of the same workspace, can't reach it.
    expect(await object.ask({ ghostId, asker: { ...asker, conversationId: 'elsewhere' }, question: 'Tell me too', open: null })).toEqual({ status: 'faded' });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60_000);
    const again = answered(await object.ask({ ghostId, asker, question: 'Why there?', open: null }));
    expect(again).toMatchObject({ ghostId, answer: 'Because uploads is public [#1].', reads: [], rounds: 0 });
    // The follow-up carried the first question and what the ghost read for it; its life moved ten minutes on.
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toContain('Where do exports go?');
    expect(bodies[2]).toContain('The archive bucket: uploads is public.');
    expect(Date.parse(again.expiresAt)).toBeGreaterThan(Date.parse(first.expiresAt));
    expect(await alarm()).toEqual({ keys: 0, alarm: Date.parse(again.expiresAt) });

    expect(await runDurableObjectAlarm(object)).toBe(true);
    expect(await object.ask({ ghostId, asker, question: 'Still there?', open: null })).toEqual({ status: 'faded' });
    expect(await alarm()).toEqual({ keys: 0, alarm: null });
    const fresh = crypto.randomUUID();
    expect(answered(await ghost(fresh).ask({ ghostId: fresh, asker, question: 'Where do exports go?', open }))).toMatchObject({ ghostId: fresh, answer: 'The archive bucket [#2].' });
  });
});
