import { afterEach, expect, it, vi } from 'vitest';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { InMemoryModelsStore, type Context } from '@earendil-works/pi-ai';
import type { AccountModel } from '@gitspace/provider-auth';
import { createVaultModels, createRequestGate, listCloudModels, withListedModels, type CredentialAccount, type ProfileCatalog, type ResolvedCredential } from './index';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const anthropic = builtinProviders().find(candidate => candidate.id === 'anthropic');
if (!anthropic) throw new Error('Anthropic provider missing');
const listed = (id: string, line: string): AccountModel => ({ id, name: id, line, contextWindow: 1_000_000, maxTokens: 128_000, images: true, thinking: { adaptive: true, off: false }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
// As Anthropic lists them: newest first. Fable 5.1 and Opus 5.5 are in pi-ai's catalog; the rest are not.
const cyberList = [listed('claude-mythos-5-2', 'mythos'), listed('claude-fable-5-2', 'fable'), listed('claude-opus-5-5', 'opus'), listed('claude-mythos-5-1', 'mythos'), listed('claude-fable-5-1', 'fable'), listed('claude-zephyr-1', 'zephyr')];
const catalog: ProfileCatalog = { anthropic: withListedModels(anthropic.getAllModels?.() ?? anthropic.getModels(), cyberList) };
const subscription: CredentialAccount = { id: 'cyber', provider: 'anthropic', type: 'oauth', revision: 1, expiresAt: 4_102_444_800_000, identity: 'cyber', models: cyberList.map(model => model.id) };
const keyed: CredentialAccount = { id: 'keyed', provider: 'anthropic', type: 'api_key', revision: 1, expiresAt: null, identity: null, models: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-fable-5-1'] };
const credentials: Record<string, ResolvedCredential['credential']> = { cyber: { type: 'oauth', access: 'sk-ant-oat01-test', expires: 4_102_444_800_000 }, keyed: { type: 'api_key', key: 'sk-ant-api03-test' } };
const context: Context = { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] };

/** A finished Anthropic reply that used 1,000 input and 100 output tokens. */
function reply(): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1_000, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 100 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

async function profile(accounts: readonly CredentialAccount[]) {
  const sent: Array<{ account: string; model: string; thinking: unknown }> = [];
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body: { model: string; thinking?: unknown } = JSON.parse(await new Response(init?.body).text());
    const headers = new Headers(init?.headers);
    sent.push({ account: headers.get('x-api-key') ? 'keyed' : 'cyber', model: body.model, thinking: body.thinking });
    return reply();
  });
  const models = await createVaultModels({
    profileId: 'profile', workspaceId: 'workspace', modelsStore: new InMemoryModelsStore(), providers: [anthropic!],
    pins: { async read() { return null; }, async write() {} }, gate: createRequestGate(),
    vault: {
      async list() { return accounts; },
      async resolve(input) { return { id: input.credentialId, provider: 'anthropic', revision: 1, credential: credentials[input.credentialId]! }; },
      async recordFailure(input) { return { label: input.credentialId, until: 0 }; },
      async catalog() { return catalog; },
    },
  });
  return { models, sent };
}

it('offers a model only an account\'s list names, sends it through that account with its line\'s request settings, and leaves out a model whose line no catalog has', async () => {
  const { models, sent } = await profile([subscription, keyed]);
  const available = (await models.getAvailable()).map(model => model.id);
  expect(available).toEqual(expect.arrayContaining(['claude-mythos-5-2', 'claude-fable-5-2', 'claude-mythos-5-1', 'claude-opus-5-5']));
  // Sonnet 5.5 is in pi-ai's catalog, but no account lists it; Zephyr is listed, but no catalogued model shares its line.
  expect(available).not.toContain('claude-sonnet-5-5');
  expect(available).not.toContain('claude-zephyr-1');
  const mythos = models.getModel('anthropic', 'claude-mythos-5-2');
  expect(mythos).toMatchObject({ contextWindow: 1_000_000, maxTokens: 128_000, api: 'anthropic-messages', compat: { forceAdaptiveThinking: true }, thinkingLevelMap: { off: null, minimal: null, max: 'max' } });
  // No reasoning option asks for thinking off.
  await models.streamSimple(mythos!, context).result();
  // Only the subscription lists Mythos; thinking it cannot turn off is never sent as disabled.
  expect(sent).toEqual([{ account: 'cyber', model: 'claude-mythos-5-2', thinking: expect.not.objectContaining({ type: 'disabled' }) }]);
});

it('records a subscription response\'s tokens without cost, and an API key response\'s cost', async () => {
  const onSubscription = await profile([subscription]);
  const plan = await onSubscription.models.streamSimple(onSubscription.models.getModel('anthropic', 'claude-opus-5-5')!, context).result();
  expect(plan.usage).toMatchObject({ input: 1_000, output: 100, cost: { total: 0 } });
  const onKey = await profile([keyed]);
  const billed = await onKey.models.streamSimple(onKey.models.getModel('anthropic', 'claude-opus-5-5')!, context).result();
  expect(billed.usage).toMatchObject({ input: 1_000, output: 100 });
  expect(billed.usage.cost.total).toBeGreaterThan(0);
});

it('keeps an account whose family limit is used up off that family\'s models only, and the picker says until when', async () => {
  const until = Date.now() + 3_600_000;
  const spent: CredentialAccount = { ...subscription, usage: { usedFraction: 0.2, observedAt: Date.now(), scoped: { fable: { until, label: 'Fable' } } } };
  const { models, sent } = await profile([spent, keyed]);
  // Mythos draws on Fable's allowance, and only the spent subscription lists it.
  await expect(models.streamSimple(models.getModel('anthropic', 'claude-mythos-5-2')!, context).result()).resolves.toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('that offers claude-mythos-5-2 is out until') });
  // Fable 5.2 goes to the API key; Opus still to either.
  await models.streamSimple(models.getModel('anthropic', 'claude-fable-5-2')!, context).result();
  expect(sent.map(request => [request.account, request.model])).toEqual([['keyed', 'claude-fable-5-2']]);
  const picker = listCloudModels({}, catalog, [spent, keyed], Date.now());
  expect(picker.find(model => model.id === 'claude-mythos-5-2')?.unavailable).toEqual({ until: new Date(until).toISOString(), reason: 'Fable limit used up' });
  expect(picker.find(model => model.id === 'claude-fable-5-2')?.unavailable).toBeNull();
  expect(picker.some(model => model.id === 'claude-sonnet-5-5')).toBe(false);
});
