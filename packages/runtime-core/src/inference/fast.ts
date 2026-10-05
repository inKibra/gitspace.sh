import type { Provider } from '@earendil-works/pi-ai';
import { z } from 'zod';

/** Internal serving policy, after account auth is bound; callers cannot supply this fetch hook. */
export function fastServingProvider(provider: Provider): Provider {
  if (!['anthropic', 'openai', 'openai-codex'].includes(provider.id)) throw new Error(`Fast serving is unsupported for ${provider.id}`);
  const fastFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST' || !request.headers.get('content-type')?.includes('application/json')) return fetch(request, { redirect: 'manual' });
    const body = z.record(z.string(), z.unknown()).parse(await request.json());
    const headers = new Headers(request.headers);
    if (provider.id === 'anthropic') {
      body.speed = 'fast';
      const betas = new Set((headers.get('anthropic-beta') ?? '').split(',').filter(Boolean));
      betas.add('fast-mode-2026-02-01');
      headers.set('anthropic-beta', [...betas].join(','));
    } else body.service_tier = 'priority';
    headers.delete('content-length');
    return fetch(new Request(request, { headers, body: JSON.stringify(body), redirect: 'manual' }));
  };
  return {
    ...provider,
    stream: (model, context, options) => {
      if (options?.transport === 'websocket' || options?.transport === 'websocket-cached') throw new Error('Fast serving requires the HTTP streaming transport');
      return provider.stream(model, context, Object.assign({}, options, { fetch: fastFetch, transport: 'sse' as const }));
    },
    streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, fetch: fastFetch, transport: 'sse' }),
  };
}
