import { expect, it, vi } from 'vitest';
import { listAccountModels } from './index';

const mythos = {
  type: 'model', id: 'claude-mythos-5-2', display_name: 'Claude Mythos 5.2', line: 'mythos', max_input_tokens: 1_000_000, max_tokens: 128_000,
  capabilities: {
    image_input: { supported: true },
    effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: true }, xhigh: { supported: true }, max: { supported: true } },
    thinking: { supported: true, types: { enabled: { supported: false }, adaptive: { supported: true }, disabled: { supported: false } } },
  },
};
const haiku = {
  type: 'model', id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', line: 'haiku', max_input_tokens: 1_000_000, max_tokens: 128_000,
  capabilities: { image_input: { supported: true }, effort: { supported: true, low: { supported: true }, medium: { supported: true }, high: { supported: false } }, thinking: { supported: true, types: { adaptive: { supported: true }, disabled: { supported: true } } } },
};

it('lists every model an account can use across pages, with what each accepts', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ data: [mythos], has_more: true, last_id: 'claude-mythos-5-2' }))
    .mockResolvedValueOnce(Response.json({ data: [haiku], has_more: false, last_id: 'claude-haiku-5-5' }));
  const models = await listAccountModels({ provider: 'anthropic', type: 'oauth', access: 'sk-ant-oat01-test' }, fetcher);
  expect(models).toEqual([
    { id: 'claude-mythos-5-2', name: 'Claude Mythos 5.2', line: 'mythos', contextWindow: 1_000_000, maxTokens: 128_000, images: true, thinking: { adaptive: true, off: false }, efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', line: 'haiku', contextWindow: 1_000_000, maxTokens: 128_000, images: true, thinking: { adaptive: true, off: true }, efforts: ['low', 'medium'] },
  ]);
  // The second page starts after the first's last model; a subscription reads with its token and the OAuth beta.
  expect(String(fetcher.mock.calls[1]?.[0])).toContain('after_id=claude-mythos-5-2');
  const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
  expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-test');
  expect(headers.get('anthropic-beta')).toBe('oauth-2025-04-20');
});

it('reads with an API key in its own header, never as a bearer token', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ data: [], has_more: false, last_id: null }));
  await listAccountModels({ provider: 'anthropic', type: 'api_key', key: 'sk-ant-api03-test' }, fetcher);
  const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
  expect(headers.get('x-api-key')).toBe('sk-ant-api03-test');
  expect(headers.get('authorization')).toBeNull();
});
