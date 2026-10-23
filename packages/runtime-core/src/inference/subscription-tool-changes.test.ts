import { afterEach, expect, it, vi } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { InMemoryModelsStore, type Context } from '@earendil-works/pi-ai';
import { createVaultModels } from './index';
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
    bodies.push(typeof init?.body === 'string' ? init.body : new TextDecoder().decode(init?.body instanceof Uint8Array ? init.body : new Uint8Array()));
    return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'test stops here' } }, { status: 400 });
  });
  const models = await createVaultModels({
    profileId: 'profile', workspaceId: 'workspace', modelsStore: new InMemoryModelsStore(), providers: [provider],
    pins: { async read() { return null; }, async write() {} },
    vault: { async list() { return [account]; }, async resolve() { return { id: 'account', provider: 'anthropic', revision: 1, credential }; }, async recordFailure() { return { label: 'account', until: 0 }; } },
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
