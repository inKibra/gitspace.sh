import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssistantMessageEventStream,
  InMemoryModelsStore,
  type Api,
  type AssistantMessage,
  type ClassifierModel,
  type ImageModel,
  type Model,
  type ModelsImagesOptions,
  type Provider,
  type ProviderHeaders,
  type StreamOptions,
  type TranscriptContext,
} from '@earendil-works/pi-ai';
import { createVaultModels, type VaultModelsOptions } from './index';
import type { AccountFailure, CredentialAccount, CredentialPin, CredentialPins, VaultAccess } from './selection';
import { describeCloudProviders, listCloudModels } from './admission';

const providerId = 'vault-test-provider';
const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const chat: Model<Api> = {
  id: 'chat', name: 'Vault test chat', provider: providerId, api: 'vault-test-chat',
  baseUrl: 'https://vault-provider.invalid', input: ['text'], cost,
  reasoning: false, contextWindow: 8192, maxTokens: 1024,
};
const image: ImageModel<string> = {
  id: 'image', name: 'Vault test image', provider: providerId, api: 'vault-test-images',
  baseUrl: 'https://vault-provider.invalid', input: ['text'], output: ['image'], cost, type: 'image',
};
const classifier: ClassifierModel<string> = {
  id: 'classifier', name: 'Vault test classifier', provider: providerId, api: 'vault-test-classifier',
  baseUrl: 'https://vault-provider.invalid', input: ['text'], cost, type: 'classifier', contextWindow: 8192,
};
const pool: readonly CredentialAccount[] = ['alpha', 'beta'].map(id => ({
  id, provider: providerId, type: 'oauth', revision: 1, expiresAt: 4_102_444_800_000, identity: id,
  // No usage observation: inference must not depend on a successful usage collector.
}));

type RequestEffect = { key: string; prompt: string };
/** `fetch`: answered like pi's Anthropic adapter, which reports a rejected request to the transport's fetch only. */
type ProviderReply = { status: number; error?: string; headers?: Record<string, string>; afterText?: string; transport?: 'fetch' };

function served(): CredentialPins {
  let value: CredentialPin | null = null;
  return {
    async read() { return value; },
    async write(_provider, next) { value = next; },
  };
}

afterEach(() => { vi.restoreAllMocks(); });

/** `workspace-b` starts on alpha, `workspace-a` on beta. */
async function fixture(options: {
  reply?: (request: RequestEffect) => Promise<ProviderReply>;
  workspaceId?: string;
  settings?: VaultModelsOptions['settings'];
  chats?: readonly Model<Api>[];
} = {}) {
  const effects: RequestEffect[] = [];
  const resolutions: { accountId: string; refresh: boolean }[] = [];
  const imageEffects: string[] = [];
  const classifierEffects: string[] = [];
  const failures: AccountFailure[] = [];
  const out = new Map<string, number>();
  const pins = served();
  const vault: VaultAccess = {
    async list(profileId, provider) {
      if (profileId !== 'profile') throw new Error('Unexpected profile');
      return provider === undefined || provider === providerId ? pool.map(account => ({ ...account, cooldownUntil: out.get(account.id) ?? 0 })) : [];
    },
    async recordFailure(input) {
      failures.push(input);
      const until = input.until ?? Date.now() + 60_000;
      out.set(input.credentialId, until);
      return { label: input.credentialId, until };
    },
    async resolve(input) {
      if (input.profileId !== 'profile' || !pool.some(account => account.id === input.credentialId)) {
        throw new Error('Credential escaped the admitted profile');
      }
      resolutions.push({ accountId: input.credentialId, refresh: input.forceRefresh === true });
      return {
        id: input.credentialId, provider: providerId, revision: input.forceRefresh ? 2 : 1,
        credential: {
          type: 'oauth', access: `${input.credentialId}:${input.forceRefresh ? 'refreshed' : 'original'}`,
          expires: 4_102_444_800_000,
        },
      };
    },
  };
  const transport = (model: Model<Api>, context: TranscriptContext, request?: StreamOptions) => {
    const stream = createAssistantMessageEventStream();
    const output: AssistantMessage = {
      role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: 'stop', timestamp: 0,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } },
    };
    void (async () => {
      try {
        if (!request?.apiKey) throw new Error('Transport received no selected credential');
        const user = context.messages.find(message => message.role === 'user');
        if (!user || typeof user.content !== 'string') throw new Error('Expected a text test request');
        const effect = { key: request.apiKey, prompt: user.content };
        effects.push(effect);
        const reply: ProviderReply = options.reply ? await options.reply(effect) : { status: 200 };
        if (reply.transport === 'fetch') {
          const response = await request.fetch?.('https://vault-provider.invalid/v1/messages', { method: 'POST' });
          if (!response?.ok) throw new Error(`${response?.status} ${await response?.text()}`);
        } else await request.onResponse?.({ status: reply.status, headers: reply.headers ?? {} }, model);
        stream.push({ type: 'start', partial: output });
        if (reply.status >= 400) throw new Error(reply.error ?? `HTTP ${reply.status}`);
        const block = { type: 'text' as const, text: '' };
        output.content.push(block);
        stream.push({ type: 'text_start', contentIndex: 0, partial: output });
        block.text = effect.key;
        stream.push({ type: 'text_delta', contentIndex: 0, delta: effect.key, partial: output });
        stream.push({ type: 'text_end', contentIndex: 0, content: effect.key, partial: output });
        if (reply.afterText) throw new Error(reply.afterText);
        stream.push({ type: 'done', reason: 'stop', message: output });
      } catch (error) {
        output.stopReason = 'error';
        output.errorMessage = error instanceof Error ? error.message : String(error);
        stream.push({ type: 'error', reason: 'error', error: output });
      } finally {
        stream.end();
      }
    })();
    return stream;
  };
  const provider: Provider = {
    id: providerId, name: 'Vault test provider',
    auth: { apiKey: { name: 'Explicit test credential', async resolve({ credential }) {
      return credential?.key ? { auth: { apiKey: credential.key } } : undefined;
    } } },
    getModels: () => [...options.chats ?? [chat]],
    getAllModels: () => [...options.chats ?? [chat], image, classifier],
    stream: transport,
    streamSimple: transport,
    async generateImages(model, _context, request) {
      if (!request?.apiKey) throw new Error('Image transport received no credential');
      imageEffects.push(request.apiKey);
      return {
        api: model.api, provider: model.provider, model: model.id,
        output: [{ type: 'text', text: request.apiKey }], stopReason: 'stop', timestamp: 0,
      };
    },
    async classify(model, _context, request) {
      if (!request?.apiKey) throw new Error('Classifier transport received no credential');
      classifierEffects.push(request.apiKey);
      return {
        api: model.api, provider: model.provider, model: model.id,
        answers: { account: { type: 'choice', choice: request.apiKey, probabilities: { [request.apiKey]: 1 }, confidence: 1 } },
        stopReason: 'stop', timestamp: 0,
      };
    },
  };
  const models = await createVaultModels({
    profileId: 'profile', workspaceId: options.workspaceId ?? 'workspace-b', vault, pins,
    modelsStore: new InMemoryModelsStore(), providers: [provider],
    ...(options.settings ? { settings: options.settings } : {}),
  });
  const chatModel = models.getModel(providerId, chat.id);
  const imageModel = models.getModelOfType('image', providerId, image.id);
  const classifierModel = models.getModelOfType('classifier', providerId, classifier.id);
  if (!chatModel || !imageModel || !classifierModel) throw new Error('Test provider was not admitted');
  // Initialization may resolve auth to restore the catalog; assertions below observe dispatch only.
  resolutions.length = 0;
  return { models, chatModel, imageModel, classifierModel, effects, resolutions, imageEffects, classifierEffects, pins, failures };
}

const context = { messages: [{ role: 'user' as const, content: 'request', timestamp: 0 }] };
const imageContext = { input: [{ type: 'text' as const, text: 'draw a square' }] };
const classifierContext = {
  state: { request: 'identify selected account' },
  questions: { account: { type: 'choice' as const, instructions: 'Identify the account.', criteria: { alpha: 'First account', beta: 'Second account' } } },
};

describe('vault-bound provider dispatch', () => {
  it('disables legacy Codex even with profile overrides while retaining supported OpenAI', () => {
    const settings = { 'providers.models': { 'openai-codex': { name: 'Re-enabled legacy Codex' } } };
    const providers = describeCloudProviders(settings);
    expect(providers.find(provider => provider.id === 'openai-codex')).toBeUndefined();
    expect(providers.find(provider => provider.id === 'openai')).toMatchObject({ supportsOAuth: true, supportsApiKey: true });
    expect(listCloudModels(settings, ['openai-codex'])).toEqual([]);
  });

  it('uses each chat model with its roles\' lowest context limit, keeps unlimited models at their own window, and requests still pass', async () => {
    const large = { ...chat, contextWindow: 1_000_000 };
    const test = await fixture({
      chats: [chat, { ...large, id: 'deep' }, { ...large, id: 'wide' }],
      settings: { modelRoles: { default: `${providerId}/wide`, deep: `${providerId}/deep`, taste: `${providerId}/deep` }, contextLimits: { deep: 200_000, taste: 120_000 } },
    });
    // Two roles on one model share the lower limit; a model no role limits keeps its own window.
    expect([chat.id, 'deep', 'wide'].map(id => test.models.getModel(providerId, id)?.contextWindow)).toEqual([8192, 120_000, 1_000_000]);
    const deep = test.models.getModel(providerId, 'deep');
    if (!deep) throw new Error('Limited model missing');
    expect((await test.models.completeSimple(deep, context)).stopReason).toBe('stop');
  });

  it('starts every conversation of a workspace on one account and another workspace on the other', async () => {
    // The runtime builds one collection per conversation; each here is one conversation.
    const conversations = await Promise.all([fixture({ workspaceId: 'workspace-b' }), fixture({ workspaceId: 'workspace-b' }), fixture({ workspaceId: 'workspace-a' })]);
    const answers = await Promise.all(conversations.map(test => test.models.completeSimple(test.chatModel, context)));
    expect(answers.map(answer => answer.content)).toEqual([
      [{ type: 'text', text: 'alpha:original' }], [{ type: 'text', text: 'alpha:original' }], [{ type: 'text', text: 'beta:original' }],
    ]);
  });

  it('keeps an account its Claude subscription limit rejected out until the reset, then uses it again', async () => {
    let now = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const reset = 1_000_000_000 + 5 * 3600;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(
      { type: 'error', error: { type: 'rate_limit_error', message: 'This request would exceed your account\'s rate limit.' } },
      { status: 429, headers: { 'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-reset': String(reset) } },
    ));
    let limited = true;
    const test = await fixture({ async reply(request) {
      return limited && request.key.startsWith('alpha:') ? { status: 429, transport: 'fetch' } : { status: 200 };
    } });
    expect((await test.models.completeSimple(test.chatModel, context)).content).toEqual([{ type: 'text', text: 'beta:original' }]);
    expect(test.failures).toMatchObject([{ credentialId: 'alpha', kind: 'rotate', until: reset * 1000 }]);
    now = reset * 1000 - 1;
    expect((await test.models.completeSimple(test.chatModel, context)).content).toEqual([{ type: 'text', text: 'beta:original' }]);
    limited = false;
    now = reset * 1000;
    expect((await test.models.completeSimple(test.chatModel, context)).content).toEqual([{ type: 'text', text: 'alpha:original' }]);
    expect(test.effects.map(effect => effect.key)).toEqual(['alpha:original', 'beta:original', 'beta:original', 'alpha:original']);
  });

  it('ends a turn whose account runs out mid-answer without replaying it, and starts the next request on the other account', async () => {
    const test = await fixture({ async reply(request) {
      return request.key.startsWith('alpha:') ? { status: 200, afterText: 'You have reached your usage limit.' } : { status: 200 };
    } });
    const interrupted = await test.models.completeSimple(test.chatModel, context);
    expect(interrupted).toMatchObject({ stopReason: 'error', content: [{ type: 'text', text: 'alpha:original' }] });
    expect(interrupted.errorMessage).toMatch(/^You have reached your usage limit\.\n\nalpha ran out until .+; the next turn uses another account\.$/u);
    expect(test.effects.map(effect => effect.key)).toEqual(['alpha:original']);
    expect((await test.models.completeSimple(test.chatModel, context)).content).toEqual([{ type: 'text', text: 'beta:original' }]);
  });

  it('refreshes a rejected OAuth token on the same account before considering a sibling', async () => {
    const test = await fixture({ async reply(request) {
      return request.key === 'alpha:original' ? { status: 401, error: 'Unauthorized' } : { status: 200 };
    } });
    const result = await test.models.completeSimple(test.chatModel, context);
    expect(result.content).toEqual([{ type: 'text', text: 'alpha:refreshed' }]);
    expect(test.effects.map(effect => effect.key)).toEqual(['alpha:original', 'alpha:refreshed']);
    expect((await test.pins.read(providerId))?.credentialId).toBe('alpha');
  });

  it('rotates after a failed forced refresh and returns the successful sibling response', async () => {
    const test = await fixture({ async reply(request) {
      return request.key.startsWith('alpha:') ? { status: 401, error: 'Unauthorized' } : { status: 200 };
    } });
    const result = await test.models.completeSimple(test.chatModel, context);
    expect(result.content).toEqual([{ type: 'text', text: 'beta:original' }]);
    expect(test.effects.map(effect => effect.key)).toEqual(['alpha:original', 'alpha:refreshed', 'beta:original']);
    expect((await test.pins.read(providerId))?.credentialId).toBe('beta');
  });

  it('terminates after each account and its forced refresh have been rejected', async () => {
    const test = await fixture({ async reply() { return { status: 401, error: 'Unauthorized' }; } });
    const result = await test.models.completeSimple(test.chatModel, context);
    expect(result.stopReason).toBe('error');
    expect(test.effects.map(effect => effect.key)).toEqual([
      'alpha:original', 'alpha:refreshed', 'beta:original', 'beta:refreshed',
    ]);
  });

  it.each([403, 429])('rotates HTTP %i account failures without refreshing the rejected account', async status => {
    const test = await fixture({ async reply(request) {
      return request.key.startsWith('alpha:') ? { status, error: 'Account request rejected' } : { status: 200 };
    } });
    const result = await test.models.completeSimple(test.chatModel, context);
    expect(result.content).toEqual([{ type: 'text', text: 'beta:original' }]);
    expect(test.effects.map(effect => effect.key)).toEqual(['alpha:original', 'beta:original']);
    expect(test.resolutions).toEqual([{ accountId: 'alpha', refresh: false }, { accountId: 'beta', refresh: false }]);
  });

  it.each([403, 429])('does not rotate or refresh a concurrency rejection with HTTP %i', async status => {
    const test = await fixture({ async reply() { return { status, error: 'Too many concurrent requests' }; } });
    const result = await test.models.completeSimple(test.chatModel, context);
    expect(result.stopReason).toBe('error');
    expect(test.effects.map(effect => effect.key)).toEqual(['alpha:original']);
    expect(test.resolutions).toEqual([{ accountId: 'alpha', refresh: false }]);
  });

  it('rejects image and classifier credential overrides before any provider or transform effect', async () => {
    const test = await fixture();
    const initialImage = await test.models.generateImages(test.imageModel, imageContext);
    const initialClassification = await test.models.classify(test.classifierModel, classifierContext);
    expect(initialImage.output).toEqual([{ type: 'text', text: 'alpha:original' }]);
    expect(initialClassification.answers.account).toEqual({
      type: 'choice', choice: 'alpha:original', probabilities: { 'alpha:original': 1 }, confidence: 1,
    });
    test.imageEffects.length = 0;
    test.classifierEffects.length = 0;
    test.resolutions.length = 0;
    let transformed = false;
    const overrides: (Pick<ModelsImagesOptions, 'apiKey' | 'env' | 'transformHeaders'> & { client?: object })[] = [
      { apiKey: 'unadmitted-account' },
      { env: { PROVIDER_API_KEY: 'unadmitted-account' } },
      { transformHeaders(headers: ProviderHeaders) { transformed = true; return headers; } },
      { client: { apiKey: 'unadmitted-account' } },
    ];
    for (const override of overrides) {
      await expect(test.models.generateImages(test.imageModel, imageContext, override)).rejects.toBeInstanceOf(Error);
      await expect(test.models.classify(test.classifierModel, classifierContext, override)).rejects.toBeInstanceOf(Error);
    }
    expect(test.imageEffects).toEqual([]);
    expect(test.classifierEffects).toEqual([]);
    expect(test.resolutions).toEqual([]);
    expect(transformed).toBe(false);
  });
});
