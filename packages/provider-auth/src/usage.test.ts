import { expect, it, vi } from 'vitest';
import { collectUsage, usageObservation, ProviderUsageError, type StoredOAuthCredential } from './index';
const credential: StoredOAuthCredential = { provider: 'openai-codex', access: 'access', refresh: 'refresh-secret', expires: 123, accountId: 'chosen-account' };
it('sends usage to the selected Codex account and preserves credit-funded eligibility', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ rate_limit: { limit_reached: true, primary_window: { used_percent: 100, reset_at: 2_000_000_000 } }, credits: { has_credits: true } }));
  const report = await collectUsage(credential, fetcher);
  expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('ChatGPT-Account-Id')).toBe('chosen-account');
  expect(report.limits[0]).toMatchObject({ scope: 'plan', status: 'credit-overage', remainingFraction: 0 });
  expect(usageObservation(report)).toBeUndefined();
});
it('reports collector refusal without refreshing or rewriting credential health', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private', { status: 403 }));
  await expect(collectUsage(credential, fetcher)).rejects.toBeInstanceOf(ProviderUsageError);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(credential.refresh).toBe('refresh-secret');
});
it('does not turn an unrelated successful JSON document into zero usage', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ status: 'ok' }));
  await expect(collectUsage({ ...credential, provider: 'anthropic' }, fetcher)).rejects.toMatchObject({ kind: 'invalid-response' });
});
it('retains measured Claude model limits even when provider marks them inactive', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ limits: [{ kind: 'weekly_scoped', percent: 77, is_active: false, scope: { model: { display_name: 'Opus' } } }] }));
  const report = await collectUsage({ ...credential, provider: 'anthropic' }, fetcher);
  expect(report.limits[0]).toMatchObject({ used: 77, remaining: 23, scope: 'Opus' });
});
it('preserves shared primary and secondary windows without treating model exhaustion as account exhaustion', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    five_hour: { utilization: 50, resets_at: '2099-01-01T01:00:00.000Z' },
    seven_day: { utilization: 75, resets_at: '2099-01-07T00:00:00.000Z' },
    limits: [{ kind: 'weekly_scoped', percent: 100, scope: { model: { display_name: 'Opus' } } }],
  }));
  const report = await collectUsage({ ...credential, provider: 'anthropic' }, fetcher);
  expect(usageObservation(report)).toEqual({
    usedFraction: 0.75, observedAt: Date.parse(report.fetchedAt), resetsAt: Date.parse('2099-01-07T00:00:00.000Z'),
    primary: { usedFraction: 0.5, resetsAt: Date.parse('2099-01-01T01:00:00.000Z') },
    secondary: { usedFraction: 0.75, resetsAt: Date.parse('2099-01-07T00:00:00.000Z') },
  });
});
