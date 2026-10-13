import { describe, expect, it } from 'vitest';
import { createModels, InMemoryModelsStore, type Api, type Model, type Provider } from '@earendil-works/pi-ai';
import { CATALOG_TTL_MS, withPublishedCatalog } from './published-catalog.js';
import { resolveAvailableProfileModel, resolveModelSelection, resolveProfileModel } from './admission.js';

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
    const removed = await resolveModelSelection({}, restarted, { kind: 'explicit', provider: 'test', modelId: 'new' });
    expect(removed.model.id).toBe('floor');
    expect(removed.notice).toContain('test/new');
  });

  it('keeps a usable bundled floor when the first download fails and rejects a bodyless 304', async () => {
    const models = createModels();
    models.setProvider(withPublishedCatalog(provider, { fetch: async () => new Response(null, { status: 304 }) }));
    expect((await models.refresh()).errors.size).toBe(1);
    expect(models.getModel('test', 'floor')).toEqual(floor);
  });

  it('resolves roles from current settings and reports removed explicit models or roles', async () => {
    const models = createModels(); models.setProvider({ ...provider, getModels: () => [floor, { ...floor, id: 'next' }] });
    const selection = { kind: 'role', role: 'fast' } as const;
    expect((await resolveModelSelection({ 'modelRoles.fast': 'test/floor' }, models, selection)).model.id).toBe('floor');
    expect((await resolveModelSelection({ 'modelRoles.fast': 'test/next' }, models, selection)).model.id).toBe('next');
    const fallback = await resolveModelSelection({ 'modelRoles.default': 'test/next' }, models, { kind: 'explicit', provider: 'test', modelId: 'removed' });
    expect(fallback.model.id).toBe('next');
    expect(fallback.notice).toContain('test/removed');
    expect((await resolveModelSelection({}, models, selection)).notice).toContain('fast');
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
    expect(await resolveModelSelection(settings, models, { kind: 'role', role: 'override' })).toEqual({ model: floor, thinking: 'low' });
    expect(await resolveModelSelection(settings, models, { kind: 'role', role: 'removed' })).toMatchObject({ model: floor, thinking: 'medium', notice: expect.stringContaining('removed') });
    expect(() => resolveProfileModel({ modelRoles: { default: 'pi/review:high', review: '@default:low' } }, models)).toThrow('Circular profile model role');
  });
});
