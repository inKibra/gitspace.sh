import { z } from 'zod';

const usageWindowSchema = z.object({ usedFraction: z.number().min(0).max(1), resetsAt: z.number().optional() });

export const credentialAccountSchema = z.object({
  id: z.string().min(1), provider: z.string().min(1), type: z.enum(['api_key', 'oauth']),
  revision: z.number().int().nonnegative(), expiresAt: z.number().nullable(),
  identity: z.string().nullable(), cooldownUntil: z.number().optional(),
  usage: usageWindowSchema.extend({ observedAt: z.number(), primary: usageWindowSchema.optional(), secondary: usageWindowSchema.optional() }).optional(),
});
export type CredentialAccount = z.infer<typeof credentialAccountSchema>;
export type ResolvedCredential = {
  id: string; provider: string; revision: number;
  credential: { type: 'api_key'; key: string } | { type: 'oauth'; access: string; expires: number; accountId?: string; projectId?: string; email?: string; orgId?: string };
};
export type VaultAccess = {
  list(profileId: string, provider?: string): Promise<readonly CredentialAccount[]>;
  resolve(input: { profileId: string; credentialId: string; forceRefresh?: boolean; signal?: AbortSignal }): Promise<ResolvedCredential>;
  recordFailure?(input: { profileId: string; credentialId: string; kind: Exclude<AuthFailure, 'none'>; retryAfterMs?: number }): Promise<void>;
};
export type CredentialPin = { credentialId: string; lastUsedAt: number };
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

export async function orderedAccounts(options: { profileId: string; provider: string; conversationId: string; vault: VaultAccess; pins: CredentialPins; now?: number }): Promise<readonly CredentialAccount[]> {
  const now = options.now ?? Date.now();
  const all = await options.vault.list(options.profileId, options.provider);
  const accounts = all.filter(account => account.provider === options.provider && (account.cooldownUntil ?? 0) <= now);
  const pin = await options.pins.read(options.provider);
  const pinned = pin && (options.provider !== 'anthropic' || now - pin.lastUsedAt < 60 * 60_000) ? pin.credentialId : null;
  // Stable rotation spreads cold conversations without a global mutable provider slot.
  let hash = 2166136261;
  for (const char of `${options.conversationId}\0${options.provider}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const offset = accounts.length ? (hash >>> 0) % accounts.length : 0;
  const rotated = [...accounts.slice(offset), ...accounts.slice(0, offset)];
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
    if (left.account.id === pinned) return -1;
    if (right.account.id === pinned) return 1;
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
