import type { AnyModel } from '@earendil-works/pi-ai';
import { z } from 'zod';

const usageWindowSchema = z.object({ usedFraction: z.number().min(0).max(1), resetsAt: z.number().optional() });

const familyLimitSchema = z.object({ until: z.number(), label: z.string() });
export const credentialAccountSchema = z.object({
  id: z.string().min(1), provider: z.string().min(1), type: z.enum(['api_key', 'oauth']),
  revision: z.number().int().nonnegative(), expiresAt: z.number().nullable(),
  identity: z.string().nullable(), cooldownUntil: z.number().optional(),
  usage: usageWindowSchema.extend({ observedAt: z.number(), primary: usageWindowSchema.optional(), secondary: usageWindowSchema.optional(), scoped: z.record(z.string(), familyLimitSchema).optional() }).optional(),
  /** The models this account's provider lists for it; absent when the provider lists none, so it serves every model. */
  models: z.array(z.string()).optional(),
});
export type CredentialAccount = z.infer<typeof credentialAccountSchema>;
export type ResolvedCredential = {
  id: string; provider: string; revision: number;
  credential: { type: 'api_key'; key: string } | { type: 'oauth'; access: string; expires: number; accountId?: string; projectId?: string; email?: string; orgId?: string; baseUrl?: string; headers?: Record<string, string> };
};
/** A request the account could not serve: `until` is the provider's reset when its answer named one. */
export type AccountFailure = { profileId: string; credentialId: string; kind: Exclude<AuthFailure, 'none'>; until?: number; reason: string };
export type VaultAccess = {
  list(profileId: string, provider?: string): Promise<readonly CredentialAccount[]>;
  resolve(input: { profileId: string; credentialId: string; forceRefresh?: boolean; signal?: AbortSignal }): Promise<ResolvedCredential>;
  /** Takes the account out until `until` or a short backoff; answers its label and when it is usable again. */
  recordFailure(input: AccountFailure): Promise<{ label: string; until: number }>;
  /** The profile's source models (`ProfileCatalog`); `refresh` reads providers past their cache. */
  catalog(profileId: string, refresh?: boolean): Promise<Readonly<Record<string, readonly AnyModel[]>>>;
};
/** The account that served a conversation's latest request, so a deferred response is fetched with it. */
export type CredentialPin = { credentialId: string };
export type CredentialPins = {
  read(provider: string): Promise<CredentialPin | null>;
  write(provider: string, pin: CredentialPin): Promise<void>;
};
export type AuthFailure = 'refresh' | 'rotate' | 'none';
/** Concurrency throttles are not evidence that another identity is usable. */
export function classifyAuthFailure(message: string, status?: number): AuthFailure {
  if (/concurren(?:t|cy)|too many (?:simultaneous|active) requests/iu.test(message)) return 'none';
  if (status === 429 || /usage.?limit|quota.?exceed|insufficient.?quota|credit.?balance|billing|account.{0,20}(?:disabled|suspended|deactivated)/iu.test(message)) return 'rotate';
  if (status === 403) return 'rotate';
  if (status === 401 || /invalid.{0,12}(?:token|api.?key)|unauthenticated|authentication.?error|token.{0,12}expir/iu.test(message)) return 'refresh';
  return 'none';
}

/** When the provider says a rejected account serves again: Anthropic's subscription reset when that limit rejected the
 * request, else Retry-After. Headers are lower-case, as pi and `fetch` report them. */
export function providerResetAt(headers: Readonly<Record<string, string>>, now: number): number | undefined {
  const unified = Number(headers['anthropic-ratelimit-unified-reset']);
  if (headers['anthropic-ratelimit-unified-status'] === 'rejected' && Number.isFinite(unified) && unified > 0) return unified * 1000;
  const milliseconds = Number(headers['retry-after-ms']);
  if (headers['retry-after-ms'] !== undefined && Number.isFinite(milliseconds)) return now + milliseconds;
  const after = headers['retry-after'];
  if (after === undefined) return undefined;
  const seconds = Number(after);
  const at = Number.isFinite(seconds) ? now + seconds * 1000 : Date.parse(after);
  return Number.isFinite(at) ? at : undefined;
}

/** Mythos draws on Fable's usage allowance (Anthropic's plan limits). */
const SHARED_ALLOWANCE: Readonly<Record<string, string>> = { mythos: 'fable' };
/** When `account` can serve `modelId` again, and why it cannot now; null when it can. An account that does not list the
 * model never serves it (`until` Infinity). A used-up family limit counts when it names the model, its line
 * (`claude-<line>-…`) or the allowance the line shares. */
export function accountOut(account: CredentialAccount, modelId: string, now: number): { until: number; reason: string } | null {
  if (account.models && !account.models.includes(modelId)) return { until: Number.POSITIVE_INFINITY, reason: 'not offered to this account' };
  const id = modelId.toLowerCase();
  const line = /^claude-([a-z]+)-/u.exec(id)?.[1];
  const scopes = [id, ...(line ? [line, SHARED_ALLOWANCE[line] ?? line] : [])];
  let out: { until: number; reason: string } | null = (account.cooldownUntil ?? 0) > now ? { until: account.cooldownUntil ?? 0, reason: 'account out' } : null;
  for (const scope of scopes) {
    const limit = account.usage?.scoped?.[scope];
    if (limit && limit.until > now && limit.until > (out?.until ?? 0)) out = { until: limit.until, reason: `${limit.label} limit used up` };
  }
  return out;
}

/** Whether a profile's accounts can serve `modelId` now: `listed` false when none of them lists it; otherwise `out` is
 * null when one can, else the soonest any of them serves it again. */
export function modelAvailability(accounts: readonly CredentialAccount[], provider: string, modelId: string, now: number): { listed: boolean; out: { until: number; reason: string } | null } {
  const outs = accounts.filter(account => account.provider === provider).map(account => accountOut(account, modelId, now));
  if (!outs.some(out => out?.until !== Number.POSITIVE_INFINITY)) return { listed: false, out: null };
  if (outs.some(out => out === null)) return { listed: true, out: null };
  return { listed: true, out: outs.reduce((soonest, out) => out && (!soonest || out.until < soonest.until) ? out : soonest, null) };
}

/** Usable accounts in the order to try them. Every conversation of a workspace starts on the same account (its prompt
 * cache stays warm) and workspaces spread across accounts; cooldowns and fresh usage still decide first. With `model`,
 * only accounts that serve it now count (`accountOut`). */
export async function orderedAccounts(options: { profileId: string; provider: string; workspaceId: string; vault: VaultAccess; model?: string; now?: number }): Promise<readonly CredentialAccount[]> {
  const now = options.now ?? Date.now();
  const listed = (await options.vault.list(options.profileId, options.provider)).filter(account => account.provider === options.provider);
  if (!listed.length) throw new Error(`Inference profile has no usable account for ${options.provider}`);
  const model = options.model;
  const all = model === undefined ? listed : listed.filter(account => accountOut(account, model, now)?.until !== Number.POSITIVE_INFINITY);
  if (!all.length) throw new Error(`No ${options.provider} account in this inference profile offers ${model}`);
  // The workspace's place is taken among all accounts, so another account's cooldown does not move it.
  let hash = 2166136261;
  for (const char of `${options.workspaceId}\0${options.provider}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const offset = (hash >>> 0) % all.length;
  const out = (account: CredentialAccount) => model !== undefined ? accountOut(account, model, now)?.until ?? null : (account.cooldownUntil ?? 0) > now ? account.cooldownUntil ?? 0 : null;
  const rotated = [...all.slice(offset), ...all.slice(0, offset)].filter(account => out(account) === null);
  if (!rotated.length) throw new Error(`Every ${options.provider} account in this inference profile${model === undefined ? '' : ` that offers ${model}`} is out until ${new Date(Math.min(...all.map(account => out(account) ?? 0))).toUTCString()}`);
  const window = (value: z.infer<typeof usageWindowSchema> | undefined) => value && (value.resetsAt === undefined || value.resetsAt > now) ? value : undefined;
  const drain = (value: z.infer<typeof usageWindowSchema> | undefined, duration: number) =>
    (1 - (value?.usedFraction ?? 0)) / (Math.max(60_000, Math.min(duration, value?.resetsAt === undefined ? duration : value.resetsAt - now)) / 3_600_000);
  const metric = (left: number, right: number) => {
    const difference = left - right;
    return Math.abs(difference) <= Math.max(1e-9, Math.max(Math.abs(left), Math.abs(right)) * 0.000001) ? 0 : difference;
  };
  // Preserve each reset window: long-window utilization must not trigger the
  // short-window hot guard, and secondary drain urgency precedes primary drain.
  const ranked = rotated.map(account => {
    const usage = account.usage && now - account.usage.observedAt < 5 * 60_000 ? account.usage : undefined;
    const primary = window(usage?.primary ?? (usage?.secondary ? undefined : usage));
    const secondary = window(usage?.secondary);
    return { account, measured: primary !== undefined || secondary !== undefined,
      primaryUsed: primary?.usedFraction ?? 0, secondaryUsed: secondary?.usedFraction ?? 0,
      primaryDrain: drain(primary, 5 * 3_600_000), secondaryDrain: drain(secondary, 7 * 24 * 3_600_000) };
  });
  ranked.sort((left, right) => {
    const leftHot = left.primaryUsed >= 0.85, rightHot = right.primaryUsed >= 0.85;
    if (leftHot !== rightHot) return leftHot ? 1 : -1;
    // Missing usage never invalidates an account; measured cool accounts rank first.
    if (left.measured !== right.measured) return left.measured ? -1 : 1;
    return metric(right.secondaryDrain, left.secondaryDrain)
      || metric(left.secondaryUsed, right.secondaryUsed)
      || metric(right.primaryDrain, left.primaryDrain)
      || metric(left.primaryUsed, right.primaryUsed);
  });
  return ranked.map(candidate => candidate.account);
}
