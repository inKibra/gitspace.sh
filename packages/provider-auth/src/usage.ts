import { z } from 'zod';
import { workerOAuthProviderSchema, type StoredOAuthCredential, type WorkerOAuthProvider } from './schemas';
import { request, ProviderRefreshError } from './refresh';

export const providerUsageLimitSchema = z.object({ id: z.string(), label: z.string(), scope: z.string(), window: z.string().nullable(), unit: z.string(), used: z.number().nullable(), limit: z.number().nullable(), remaining: z.number().nullable(), remainingFraction: z.number().nullable(), resetsAt: z.string().nullable(), status: z.string().nullable() });
export type ProviderUsageLimit = z.infer<typeof providerUsageLimitSchema>;
export const providerUsageReportSchema = z.object({ provider: workerOAuthProviderSchema, account: z.string().nullable(), fetchedAt: z.iso.datetime(), limits: z.array(providerUsageLimitSchema), notes: z.array(z.string()) });
export type ProviderUsageReport = z.infer<typeof providerUsageReportSchema>;
export class ProviderUsageError extends Error {
  constructor(readonly provider: WorkerOAuthProvider, readonly kind: 'unsupported' | 'network' | 'rejected' | 'invalid-response', readonly status?: number) { super(`Provider usage ${kind}`); this.name = 'ProviderUsageError'; }
}
const numeric = z.union([z.number().finite(), z.string().regex(/^-?\d+(?:\.\d+)?$/).transform(Number)]);
function timestamp(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const number = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  return Number.isFinite(number) && Math.abs(number) <= 8.64e15 ? new Date(number).toISOString() : null;
}
function percent(id: string, label: string, scope: string, used: number, resetsAt: string | null, window: string | null = null): ProviderUsageLimit {
  const remaining = Math.max(0, 100 - used);
  return { id, label, scope, window, unit: 'percent', used, limit: 100, remaining, remainingFraction: Math.min(1, remaining / 100), resetsAt, status: used >= 100 ? 'exhausted' : used >= 90 ? 'warning' : 'ok' };
}
async function payload<S extends z.ZodType>(credential: StoredOAuthCredential, url: string, schema: S, fetcher: typeof fetch, init: RequestInit = {}): Promise<z.output<S>> {
  let raw: Record<string, unknown> | null;
  try { raw = await request(credential.provider, url, { headers: { Authorization: `Bearer ${credential.access}`, Accept: 'application/json' }, ...init }, fetcher); }
  catch (error) { if (error instanceof ProviderRefreshError) throw new ProviderUsageError(credential.provider, error.kind, error.status); throw error; }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new ProviderUsageError(credential.provider, 'invalid-response');
  return parsed.data;
}
/** Informational only: collector refusal never disables an account or refreshes a token. */
export async function collectUsage(credential: StoredOAuthCredential, fetcher: typeof fetch = fetch): Promise<ProviderUsageReport> {
  const report: ProviderUsageReport = { provider: credential.provider, account: credential.email ?? credential.accountId ?? null, fetchedAt: new Date().toISOString(), limits: [], notes: [] };
  if (credential.provider === 'anthropic') {
    const bucket = z.object({ utilization: numeric.optional(), resets_at: z.string().nullable().optional() });
    const data = await payload(credential, 'https://api.anthropic.com/api/oauth/usage', z.object({ five_hour: bucket.nullable().optional(), seven_day: bucket.nullable().optional(), seven_day_opus: bucket.nullable().optional(), seven_day_sonnet: bucket.nullable().optional(), limits: z.array(z.object({ kind: z.string(), percent: numeric.optional(), resets_at: z.string().nullable().optional(), scope: z.object({ model: z.object({ display_name: z.string().nullable().optional() }).nullable().optional() }).nullable().optional() })).optional() }), fetcher, { headers: { Authorization: `Bearer ${credential.access}`, 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-cli/2.1.280 (external, cli)', Accept: 'application/json' } });
    for (const [id, label, scope, value] of [ ['five_hour', '5 hours', 'account', data.five_hour], ['seven_day', '7 days', 'account', data.seven_day], ['seven_day_opus', 'Opus weekly', 'opus', data.seven_day_opus], ['seven_day_sonnet', 'Sonnet weekly', 'sonnet', data.seven_day_sonnet] ] as const) {
      if (value?.utilization !== undefined) report.limits.push(percent(id, label, scope, value.utilization, timestamp(value.resets_at), label));
    }
    for (const [index, limit] of (data.limits ?? []).entries()) {
      if (limit.percent !== undefined) report.limits.push(percent(`limit:${limit.kind}:${index}`, limit.scope?.model?.display_name ?? limit.kind, limit.scope?.model?.display_name ?? 'account', limit.percent, timestamp(limit.resets_at), limit.kind));
    }
  } else if (credential.provider === 'openai-codex') {
    const window = z.object({ used_percent: numeric.optional(), limit_window_seconds: numeric.optional(), reset_after_seconds: numeric.optional(), reset_at: numeric.optional() });
    const rate = z.object({ allowed: z.boolean().optional(), limit_reached: z.boolean().optional(), primary_window: window.nullable().optional(), secondary_window: window.nullable().optional() });
    const data = await payload(credential, 'https://chatgpt.com/backend-api/wham/usage', z.object({ rate_limit: rate.nullable().optional(), additional_rate_limits: z.array(z.object({ limit_name: z.string().optional(), metered_feature: z.string().optional(), rate_limit: rate.nullable().optional() })).nullable().optional(), credits: z.object({ has_credits: z.boolean().optional(), unlimited: z.boolean().optional(), overage_limit_reached: z.boolean().optional() }).nullable().optional(), spend_control: z.object({ reached: z.boolean().optional() }).nullable().optional() }), fetcher, { headers: { Authorization: `Bearer ${credential.access}`, 'User-Agent': 'gitspace', ...(credential.accountId ? { 'ChatGPT-Account-Id': credential.accountId } : {}) } });
    const overage = data.rate_limit?.limit_reached === true && (data.credits?.has_credits || data.credits?.unlimited) && data.credits?.overage_limit_reached !== true && data.spend_control?.reached !== true;
    if (overage) report.notes.push('Plan quota exhausted; paid credits remain available. Plan usage is not an account-wide inference denial.');
    const groups = [{ name: 'Plan', scope: 'account', rate: data.rate_limit }, ...(data.additional_rate_limits ?? []).map(value => ({ name: value.limit_name ?? value.metered_feature ?? 'Additional quota', scope: value.metered_feature ?? value.limit_name ?? 'feature', rate: value.rate_limit }))];
    for (const [index, group] of groups.entries()) {
      for (const [key, value] of [['primary', group.rate?.primary_window], ['secondary', group.rate?.secondary_window]] as const) {
        if (value?.used_percent === undefined) continue;
        const reset = value.reset_at !== undefined ? timestamp(value.reset_at) : value.reset_after_seconds !== undefined ? timestamp(Date.now() + value.reset_after_seconds * 1000) : null;
        const limit = percent(`${index}:${key}`, `${group.name} ${key}`, group.scope, value.used_percent, reset, value.limit_window_seconds === undefined ? key : `${value.limit_window_seconds / 3600} hours`);
        if (overage && index === 0) { limit.scope = 'plan'; limit.status = 'credit-overage'; }
        report.limits.push(limit);
      }
    }
  } else if (credential.provider === 'cursor') {
    const bucket = z.object({ numRequests: numeric.optional(), used: numeric.optional(), amountUsed: numeric.optional(), usdUsed: numeric.optional(), maxRequestUsage: numeric.optional(), limit: numeric.optional(), amountLimit: numeric.optional(), usdLimit: numeric.optional() });
    const data = await payload(credential, 'https://api2.cursor.sh/auth/usage', z.record(z.string(), z.unknown()), fetcher);
    const reset = z.union([z.string(), z.number()]).safeParse(data.billingCycleEnd ?? data.endOfMonth ?? data.resetsAt ?? data.nextReset);
    for (const [id, raw] of Object.entries(data)) {
      const parsed = bucket.safeParse(raw); if (!parsed.success) continue;
      const value = parsed.data; const used = value.numRequests ?? value.used ?? value.amountUsed ?? value.usdUsed; const limit = value.maxRequestUsage ?? value.limit ?? value.amountLimit ?? value.usdLimit;
      if (used === undefined) continue;
      const remaining = limit === undefined ? null : Math.max(0, limit - used);
      report.limits.push({ id, label: id, scope: 'account', window: 'Monthly', unit: value.usdUsed !== undefined ? 'usd' : 'requests', used, limit: limit ?? null, remaining, remainingFraction: limit !== undefined && limit > 0 && remaining !== null ? Math.min(1, remaining / limit) : null, resetsAt: reset.success ? timestamp(reset.data) : null, status: limit === undefined ? 'unknown' : used >= limit ? 'exhausted' : 'ok' });
    }
  } else if (credential.provider === 'google-antigravity') {
    if (!credential.projectId) throw new ProviderUsageError(credential.provider, 'invalid-response');
    const quota = z.object({ remainingFraction: numeric.optional(), resetTime: z.string().optional(), windowId: z.string().optional(), windowLabel: z.string().optional() });
    const quotas = z.union([quota, z.array(quota)]);
    const data = await payload(credential, 'https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels', z.object({ models: z.record(z.string(), z.object({ displayName: z.string().optional(), quotaInfo: quotas.optional(), quotaInfos: z.array(quota).optional(), dailyQuotaInfo: quotas.optional(), dailyQuotaInfos: z.array(quota).optional(), weeklyQuotaInfo: quotas.optional(), weeklyQuotaInfos: z.array(quota).optional() })) }), fetcher, { method: 'POST', headers: { Authorization: `Bearer ${credential.access}`, 'Content-Type': 'application/json', 'User-Agent': 'antigravity/hub/2.8.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)' }, body: JSON.stringify({ project: credential.projectId }) });
    for (const [model, value] of Object.entries(data.models)) {
      for (const [kind, raw] of [['quota', value.quotaInfo], ['quota', value.quotaInfos], ['daily', value.dailyQuotaInfo], ['daily', value.dailyQuotaInfos], ['weekly', value.weeklyQuotaInfo], ['weekly', value.weeklyQuotaInfos]] as const) {
        for (const [index, info] of (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).entries()) {
          if (info.remainingFraction === undefined) continue;
          report.limits.push(percent(`${model}:${kind}:${index}:${report.limits.length}`, value.displayName ?? model, model, 100 * (1 - Math.max(0, Math.min(1, info.remainingFraction))), timestamp(info.resetTime), info.windowLabel ?? info.windowId ?? kind));
        }
      }
    }
  } else {
    throw new ProviderUsageError(credential.provider, 'unsupported');
  }
  if (report.limits.length === 0) throw new ProviderUsageError(credential.provider, 'invalid-response');
  return report;
}

export type UsageWindowObservation = { usedFraction: number; resetsAt?: number };
export type UsageObservation = UsageWindowObservation & {
  observedAt: number;
  primary?: UsageWindowObservation;
  secondary?: UsageWindowObservation;
};

/** Only shared gates inform account selection; feature quotas and credit-funded plan caps do not. */
export function usageObservation(report: ProviderUsageReport): UsageObservation | undefined {
  const observedAt = Date.parse(report.fetchedAt);
  if (!Number.isFinite(observedAt)) return undefined;
  let observation: UsageObservation | undefined;
  let primary: UsageWindowObservation | undefined;
  let secondary: UsageWindowObservation | undefined;
  for (const limit of report.limits) {
    if (limit.scope !== 'account' || limit.status === 'credit-overage') continue;
    const resetsAt = limit.resetsAt === null ? undefined : Date.parse(limit.resetsAt);
    if (resetsAt !== undefined && (!Number.isFinite(resetsAt) || resetsAt <= observedAt)) continue;
    const fraction = limit.remainingFraction !== null ? 1 - limit.remainingFraction
      : limit.used !== null && limit.limit !== null && limit.limit > 0 ? limit.used / limit.limit : undefined;
    if (fraction === undefined || !Number.isFinite(fraction)) continue;
    const window: UsageWindowObservation = { usedFraction: Math.max(0, Math.min(1, fraction)), ...(resetsAt === undefined ? {} : { resetsAt }) };
    if (!observation || window.usedFraction > observation.usedFraction) observation = { ...window, observedAt };
    if ((report.provider === 'anthropic' && limit.id === 'five_hour') || (report.provider === 'openai-codex' && limit.id === '0:primary')) primary = window;
    if ((report.provider === 'anthropic' && limit.id === 'seven_day') || (report.provider === 'openai-codex' && limit.id === '0:secondary')) secondary = window;
  }
  return observation ? { ...observation, ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } : undefined;
}
