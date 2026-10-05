import { isModelType, type AnyModel, type Provider, type ModelsStoreEntry } from '@earendil-works/pi-ai';
import { StoredPiModelSchema } from './models-store.js';

export const CATALOG_TTL_MS = 4 * 60 * 60 * 1000;

/** Pi's published, credential-free data shard, layered over the pinned package floor. */
export function withPublishedCatalog(provider: Provider, options: { fetch?: typeof fetch; now?: () => number } = {}): Provider {
  let overlay: readonly AnyModel[] = [];
  const now = options.now ?? Date.now;
  const all = () => {
    const rows = new Map((provider.getAllModels?.() ?? provider.getModels()).map(model => [`${model.type ?? 'chat'}:${model.id}`, model]));
    for (const model of overlay) rows.set(`${model.type ?? 'chat'}:${model.id}`, model);
    return [...rows.values()];
  };
  return {
    ...provider,
    getModels: () => all().filter(model => isModelType(model, 'chat')),
    getAllModels: all,
    async refreshModels(context) {
      const stored = context.stored;
      if (!await context.publish({ update: () => { overlay = stored?.models ?? []; } })) return;
      if (!context.allowNetwork || context.signal.aborted || (!context.force && stored?.checkedAt !== undefined && now() - stored.checkedAt <= CATALOG_TTL_MS)) return;
      const validator = stored?.models.length ? stored.etag : undefined;
      const response = await (options.fetch ?? fetch)(`https://pi.dev/api/models/providers/${encodeURIComponent(provider.id)}?types=chat,image,classifier`, {
        headers: { accept: 'application/json', ...(validator ? { 'if-none-match': validator } : {}) },
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(4_000)]), redirect: 'error',
      });
      const checkedAt = now();
      if (response.status === 304) {
        if (!validator || !stored) throw new Error('Catalog returned not-modified without a cached body');
        await context.publish({ persist: { ...stored, checkedAt } });
        return;
      }
      if (!response.ok) throw new Error(`Published catalog request failed for ${provider.id}: ${response.status}`);
      const body: unknown = await response.json();
      const values = Array.isArray(body) ? body : body && typeof body === 'object' ? ('models' in body && Array.isArray(body.models) ? body.models : Object.values(body)) : null;
      if (!values) throw new Error('Invalid published model catalog');
      const floor = provider.getAllModels?.() ?? provider.getModels();
      const models: AnyModel[] = [];
      for (const value of values) {
        if (!value || typeof value !== 'object') throw new Error('Invalid published model row');
        if ('type' in value && value.type !== undefined && value.type !== 'chat' && value.type !== 'image' && value.type !== 'classifier') continue;
        const model = StoredPiModelSchema.parse({ provider: provider.id, ...value });
        if (model.provider !== provider.id) throw new Error('Published catalog provider does not match shard');
        // Publication supplies metadata, never authority to send credentials to a new endpoint.
        const anchor = floor.find(row => row.api === model.api && (row.type ?? 'chat') === (model.type ?? 'chat'));
        if (!anchor) continue;
        model.baseUrl = anchor.baseUrl;
        delete model.headers;
        models.push(model);
      }
      const modified = Date.parse(response.headers.get('last-modified') ?? '');
      const entry: ModelsStoreEntry = { models, checkedAt, lastModified: Number.isNaN(modified) ? 0 : modified, ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}) };
      await context.publish({ persist: entry, update: () => { overlay = models; } });
    },
  };
}
