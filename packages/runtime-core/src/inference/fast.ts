import type { Provider } from '@earendil-works/pi-ai';
import { z } from 'zod';

/** The fast-serving request: priority tier (or Anthropic's fast speed and beta) on a JSON POST, sent through `next`,
 * the caller's own fetch (for a Claude subscription, the Claude Code request shaping), never around it. */
export function fastServingFetch(providerId: string, next: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method !== 'POST' || !request.headers.get('content-type')?.includes('application/json')) return next(request, { redirect: 'manual' });
    const body = z.record(z.string(), z.unknown()).parse(await request.json());
    const headers = new Headers(request.headers);
    if (providerId === 'anthropic') {
      body.speed = 'fast';
      const betas = new Set((headers.get('anthropic-beta') ?? '').split(',').filter(Boolean));
      betas.add('fast-mode-2026-02-01');
      headers.set('anthropic-beta', [...betas].join(','));
    } else body.service_tier = 'priority';
    headers.delete('content-length');
    return next(new Request(request, { headers, body: JSON.stringify(body), redirect: 'manual' }));
  };
}

/** Internal serving policy, after account auth is bound; callers cannot supply this fetch hook. */
export function fastServingProvider(provider: Provider): Provider {
  if (!['anthropic', 'openai', 'openai-codex'].includes(provider.id)) throw new Error(`Fast serving is unsupported for ${provider.id}`);
  return {
    ...provider,
    stream: (model, context, options) => {
      if (options?.transport === 'websocket' || options?.transport === 'websocket-cached') throw new Error('Fast serving requires the HTTP streaming transport');
      return provider.stream(model, context, Object.assign({}, options, { fetch: fastServingFetch(provider.id, options?.fetch ?? fetch), transport: 'sse' as const }));
    },
    streamSimple: (model, context, options) => provider.streamSimple(model, context, { ...options, fetch: fastServingFetch(provider.id, options?.fetch ?? fetch), transport: 'sse' }),
  };
}
