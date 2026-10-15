import { expect, it } from 'vitest';
import { fastServingFetch } from './fast.js';

it('sends a fast Anthropic request through the caller\'s fetch, keeping its headers', async () => {
  const sent: Request[] = [];
  const callerFetch: typeof fetch = async (input, init) => { sent.push(new Request(input, init)); return new Response('{}'); };
  await fastServingFetch('anthropic', callerFetch)('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-beta': 'oauth-2025-04-20' }, body: JSON.stringify({ model: 'claude' }),
  });
  expect(sent).toHaveLength(1);
  expect(await sent[0]!.json()).toEqual({ model: 'claude', speed: 'fast' });
  expect(sent[0]!.headers.get('anthropic-beta')?.split(',')).toEqual(['oauth-2025-04-20', 'fast-mode-2026-02-01']);
});
