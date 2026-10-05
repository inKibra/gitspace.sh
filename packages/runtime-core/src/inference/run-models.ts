import { lazyStream, type Api, type Model, type Context, type ModelsApiStreamOptions, type Models, type AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { interceptRuntimeModelStream } from '../retained-rules.js';

/** API-specific options can only be forwarded to the same admitted transport. */
function hasApi<T extends Api>(model: Model<Api>, api: T): model is Model<T> {
  return model.api === api;
}

/** A request's signal is bound by the durable generation hook, never a process-global account. */
export function createRunModelsRouter(initial: Models, resolve: (signal?: AbortSignal) => Promise<Models>) {
  const catalogs = [initial];
  function intercept(signal: AbortSignal | undefined, start: (signal: AbortSignal) => AssistantMessageEventStream): AssistantMessageEventStream {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
    try {
      const stream = interceptRuntimeModelStream(start(controller.signal), signal, controller);
      void stream.result().finally(() => signal?.removeEventListener('abort', abort));
      return stream;
    } catch (error) {
      signal?.removeEventListener('abort', abort);
      throw error;
    }
  }
  const routed: Models = {
    ...initial,
    getModel: (provider, id) => { for (const models of catalogs) { const model = models.getModel(provider, id); if (model) return model; } return undefined; },
    getModelOfType: (type, provider, id) => { for (const models of catalogs) { const model = models.getModelOfType(type, provider, id); if (model) return model; } return undefined; },
    stream<T extends Api>(model: Model<T>, context: Context, options?: ModelsApiStreamOptions<T>) {
      return lazyStream(model, async () => {
        const models = await resolve(options?.signal);
        const canonical = models.getModel(model.provider, model.id);
        if (!canonical || !hasApi(canonical, model.api)) throw new Error('Model API is not admitted for this run');
        return intercept(options?.signal, signal => models.stream<T>(canonical, context, Object.assign({}, options, { signal })));
      });
    },
    complete: (model, context, options) => routed.stream(model, context, options).result(),
    streamSimple: (model, context, options) => lazyStream(model, async () => { const models = await resolve(options?.signal); const canonical = models.getModel(model.provider, model.id); if (!canonical) throw new Error('Model is not admitted for this run'); return intercept(options?.signal, signal => models.streamSimple(canonical, context, { ...options, signal })); }),
    completeSimple: (model, context, options) => routed.streamSimple(model, context, options).result(),
    streamDeferred: (model, handle, options) => lazyStream(model, async () => { const models = await resolve(options?.signal); const canonical = models.getModel(model.provider, model.id); if (!canonical) throw new Error('Model is not admitted for this run'); return intercept(options?.signal, signal => models.streamDeferred(canonical, handle, { ...options, signal })); }),
    fetchDeferred: (model, handle, options) => routed.streamDeferred(model, handle, options).result(),
    cancelDeferred: async (model, handle, options) => { const models = await resolve(options?.signal); const canonical = models.getModel(model.provider, model.id); if (!canonical) throw new Error('Model is not admitted for this run'); await models.cancelDeferred(canonical, handle, options); },
    generateImages: async (model, context, options) => { const models = await resolve(options?.signal); const canonical = models.getModelOfType('image', model.provider, model.id); if (!canonical) throw new Error('Image model is not admitted for this run'); return models.generateImages(canonical, context, options); },
    classify: async (model, context, options) => { const models = await resolve(options?.signal); const canonical = models.getModelOfType('classifier', model.provider, model.id); if (!canonical) throw new Error('Classifier model is not admitted for this run'); return models.classify(canonical, context, options); },
  };
  return { models: routed, register(models: Models) { if (!catalogs.includes(models)) catalogs.unshift(models); } };
}
