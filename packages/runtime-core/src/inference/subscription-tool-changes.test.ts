import { afterEach, expect, it, vi } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { InMemoryModelsStore, type Context } from '@earendil-works/pi-ai';
import { createVaultModels, createRequestGate } from './index';
import type { CredentialAccount, ResolvedCredential } from './selection';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

// The conversation started with `read`; `write` was added before its second turn.
const context: Context = { messages: [
  { role: 'system', content: '', toolsAdded: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: {} } }], timestamp: 1 },
  { role: 'user', content: 'first', timestamp: 2 },
  { role: 'system', content: '', toolsAdded: [{ name: 'write', description: 'Write a file', parameters: { type: 'object', properties: {} } }], timestamp: 3 },
  { role: 'user', content: 'second', timestamp: 4 },
] };

/** The body of the one request a profile with `credential` sends for `context`. */
async function sent(credential: ResolvedCredential['credential']): Promise<{ tools: Array<{ name: string }>; changes: string[] }> {
  const provider = builtinProviders().find(candidate => candidate.id === 'anthropic');
  if (!provider) throw new Error('Anthropic provider missing');
  const account: CredentialAccount = { id: 'account', provider: 'anthropic', type: credential.type, revision: 1, expiresAt: 4_102_444_800_000, identity: 'account' };
  const bodies: string[] = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    // A subscription body is streamed; Response reads a string, bytes or a stream alike.
    bodies.push(await new Response(init?.body).text());
    return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'test stops here' } }, { status: 400 });
  });
  const models = await createVaultModels({
    profileId: 'profile', workspaceId: 'workspace', modelsStore: new InMemoryModelsStore(), providers: [provider],
    pins: { async read() { return null; }, async write() {} }, gate: createRequestGate(),
    vault: { async list() { return [account]; }, async resolve() { return { id: 'account', provider: 'anthropic', revision: 1, credential }; }, async recordFailure() { return { label: 'account', until: 0 }; }, async catalog() { return {}; } },
  });
  const model = models.getModel('anthropic', 'claude-opus-5-5');
  if (!model) throw new Error('claude-opus-5-5 missing from the catalog');
  await models.streamSimple(model, context).result();
  const body: { tools: Array<{ name: string }>; messages: Array<{ role: string; content: unknown }> } = JSON.parse(bodies[0] ?? '{}');
  const changes = body.messages.flatMap(message => Array.isArray(message.content) ? message.content.flatMap((block: { type: string }) => block.type === 'tool_addition' || block.type === 'tool_removal' ? [block.type] : []) : []);
  return { tools: body.tools, changes };
}

it('declares a Claude subscription request\'s current tools up front, without mid-conversation tool changes', async () => {
  const subscription = await sent({ type: 'oauth', access: 'sk-ant-oat01-test', expires: 4_102_444_800_000 });
  expect(subscription.changes).toEqual([]);
  // The subscription shape prefixes tool names with `_` and capitalizes them as Claude Code does.
  expect(subscription.tools.map(declared => declared.name.replace(/^_/u, '').toLowerCase())).toEqual(expect.arrayContaining(['read', 'write']));
});

it('keeps mid-conversation tool changes for an API key request', async () => {
  const keyed = await sent({ type: 'api_key', key: 'sk-ant-api03-test' });
  expect(keyed.changes).toEqual(['tool_addition']);
});

/** Anthropic's streamed answer to a request: one text reply with a message id, which pi-ai continues a thread from. */
function reply(id: string): Response {
  const events = [
    ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  return new Response(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

it('sends every request of a Claude subscription conversation whole and in Claude Code\'s shape, never as a message thread', async () => {
  const provider = builtinProviders().find(candidate => candidate.id === 'anthropic');
  if (!provider) throw new Error('Anthropic provider missing');
  const account: CredentialAccount = { id: 'account', provider: 'anthropic', type: 'oauth', revision: 1, expiresAt: 4_102_444_800_000, identity: 'account' };
  const sentRequests: Array<{ beta: string; body: { system?: Array<{ text: string }>; thread?: unknown } }> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    sentRequests.push({ beta: new Headers(init?.headers).get('anthropic-beta') ?? '', body: JSON.parse(await new Response(init?.body).text()) });
    return reply(`msg_${sentRequests.length}`);
  });
  const models = await createVaultModels({
    profileId: 'profile', workspaceId: 'workspace', modelsStore: new InMemoryModelsStore(), providers: [provider],
    pins: { async read() { return null; }, async write() {} }, gate: createRequestGate(),
    vault: { async list() { return [account]; }, async resolve() { return { id: 'account', provider: 'anthropic', revision: 1, credential: { type: 'oauth', access: 'sk-ant-oat01-test', expires: 4_102_444_800_000 } }; }, async recordFailure() { return { label: 'account', until: 0 }; }, async catalog() { return {}; } },
  });
  const model = models.getModel('anthropic', 'claude-opus-5-5');
  if (!model) throw new Error('claude-opus-5-5 missing from the catalog');
  const first: Context = { messages: [{ role: 'user', content: 'first', timestamp: 1 }] };
  const answered = await models.streamSimple(model, first, { sessionId: 'conversation' }).result();
  expect([answered.stopReason, answered.errorMessage]).toEqual(['stop', undefined]);
  // A message thread would continue from the first reply, sending neither the system prompt nor the tools.
  const second = await models.streamSimple(model, { messages: [...first.messages, answered, { role: 'user', content: 'second', timestamp: 3 }] }, { sessionId: 'conversation' }).result();
  expect([second.stopReason, second.errorMessage]).toEqual(['stop', undefined]);
  expect(sentRequests).toHaveLength(2);
  for (const request of sentRequests) {
    expect(request.body.system?.[0]?.text).toMatch(/^x-anthropic-billing-header: /u);
    expect(request.body.thread).toBeUndefined();
    expect(request.beta).not.toContain('message-threads');
  }
});
