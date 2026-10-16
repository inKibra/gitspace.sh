import { describe, expect, it } from 'vitest';
import { createModels, InMemoryModelsStore, type Api, type Model, type Provider } from '@earendil-works/pi-ai';
import { CATALOG_TTL_MS, withPublishedCatalog } from './published-catalog.js';
import { resolveAvailableProfileModel, resolveModelSelection, resolveProfileModel } from './admission.js';
import type { ModelSelectionIntent } from '@gitspace/protocol-runtime/session-controls';

const floor: Model<Api> = { provider: 'test', id: 'floor', name: 'Floor', api: 'openai-responses', baseUrl: 'https://provider.invalid', reasoning: false, input: ['text'], contextWindow: 8192, maxTokens: 1024, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
const provider: Provider = {
  id: 'test', name: 'Test', getModels: () => [floor],
  auth: { apiKey: { name: 'Test', resolve: async () => ({ auth: { apiKey: 'unused' }, source: 'test' }) } },
  stream: () => { throw new Error('Inference is forbidden in catalog tests'); },
  streamSimple: () => { throw new Error('Inference is forbidden in catalog tests'); },
};

describe('published catalog admission data', () => {
  it('restores the overlay, revalidates after four hours with ETag, and keeps the floor on failure', async () => {
    let time = 10;
    const requests: Array<Headers> = [];
    let response = Response.json([{ ...floor, id: 'new', name: 'Published', baseUrl: 'https://untrusted.invalid', headers: { authorization: 'secret' } }], { headers: { etag: 'revision-1' } });
    const store = new InMemoryModelsStore();
    const wrap = () => withPublishedCatalog(provider, { now: () => time, fetch: async (_url, init) => { requests.push(new Headers(init?.headers)); return response; } });
    const models = createModels({ modelsStore: store }); models.setProvider(wrap());
    await models.refresh();
    expect(models.getModel('test', 'floor')).toEqual(floor);
    expect(models.getModel('test', 'new')?.baseUrl).toBe(floor.baseUrl);
    expect(models.getModel('test', 'new')?.headers).toBeUndefined();
    time += CATALOG_TTL_MS;
    await models.refresh();
    expect(requests).toHaveLength(1);
    time++;
    response = new Response(null, { status: 304 });
    await models.refresh();
    expect(requests[1]?.get('if-none-match')).toBe('revision-1');
    expect((await store.read('test'))?.checkedAt).toBe(time);
    const restarted = createModels({ modelsStore: store }); restarted.setProvider(wrap());
    await restarted.refresh({ allowNetwork: false });
    expect(restarted.getModel('test', 'new')?.name).toBe('Published');
    time += CATALOG_TTL_MS + 1;
    response = new Response(null, { status: 503 });
    expect((await restarted.refresh()).errors.size).toBe(1);
    expect(restarted.getModel('test', 'floor')).toEqual(floor);
    expect(restarted.getModel('test', 'new')?.name).toBe('Published');
    expect((await store.read('test'))?.etag).toBe('revision-1');
    response = Response.json([], { headers: { etag: 'revision-2' } });
    await restarted.refresh();
    expect(restarted.getModel('test', 'new')).toBeUndefined();
    await expect(resolveModelSelection({}, restarted, { kind: 'explicit', provider: 'test', modelId: 'new' })).rejects.toThrow('test/new is not available');
  });

  it('keeps a usable bundled floor when the first download fails and rejects a bodyless 304', async () => {
    const models = createModels();
    models.setProvider(withPublishedCatalog(provider, { fetch: async () => new Response(null, { status: 304 }) }));
    expect((await models.refresh()).errors.size).toBe(1);
    expect(models.getModel('test', 'floor')).toEqual(floor);
  });

  it('resolves a role chain to its first set role and never substitutes an unavailable model', async () => {
    const models = createModels(); models.setProvider({ ...provider, getModels: () => [floor, { ...floor, id: 'next' }] });
    const tester: ModelSelectionIntent = { kind: 'role', role: 'taste', fallback: ['fast', 'default'] };
    expect((await resolveModelSelection({ 'modelRoles.fast': 'test/next', 'modelRoles.default': 'test/floor' }, models, tester)).model.id).toBe('next');
    expect((await resolveModelSelection({ 'modelRoles.taste': 'test/floor', 'modelRoles.fast': 'test/next' }, models, tester)).model.id).toBe('floor');
    expect((await resolveModelSelection({ 'modelRoles.default': 'test/next' }, models, tester)).model.id).toBe('next');
    await expect(resolveModelSelection({ 'modelRoles.taste': 'test/gone', 'modelRoles.fast': 'test/next' }, models, tester)).rejects.toThrow('no admitted model for role taste');
    await expect(resolveModelSelection({ 'modelRoles.default': 'test/next' }, models, { kind: 'explicit', provider: 'test', modelId: 'removed' })).rejects.toThrow('test/removed is not available');
    await expect(resolveModelSelection({}, models, { kind: 'role', role: 'tast' })).rejects.toThrow('tast is not defined');
    expect((await resolveModelSelection({ 'modelRoles.reviewer': 'test/next' }, models, { kind: 'role', role: 'reviewer' })).model.id).toBe('next');
  });

  it('resolves effort suffixes without losing literal model colons', async () => {
    const literal = { ...floor, id: 'floor:0' };
    const models = createModels(); models.setProvider({ ...provider, getModels: () => [floor, literal] });
    for (const thinking of ['low', 'medium', 'high'] as const) expect(await resolveAvailableProfileModel({ modelRoles: { default: `test/floor:0:${thinking}` } }, models)).toEqual({ model: literal, thinking });
    expect(resolveProfileModel({ modelRoles: { default: 'test/floor:0' } }, models)).toEqual({ model: literal, thinking: null });
    expect(() => resolveProfileModel({ modelRoles: { default: 'test/floor:unknown' } }, models)).toThrow('no admitted model');
  });

  it('takes effort from the selected alternative through aliases and honors the outer alias effort', async () => {
    const models = createModels(); models.setProvider(provider);
    const settings = { modelRoles: { default: ['other/floor:high', 'pi/review'], review: ['test/missing:low', '@available'], available: 'test/floor:medium', override: 'pi/review:low' } };
    expect(resolveProfileModel(settings, models)).toEqual({ model: floor, thinking: 'medium' });
    expect(await resolveModelSelection(settings, models, { kind: 'role', role: 'override' })).toEqual({ model: floor, thinking: 'low', role: 'override' });
    expect(() => resolveProfileModel({ modelRoles: { default: 'pi/review:high', review: '@default:low' } }, models)).toThrow('Circular profile model role');
  });
});
