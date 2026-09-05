/**
 * Provider usage reports for the OMP broker `GET /v1/usage` endpoint.
 *
 * `@oh-my-pi/pi-ai/usage/*` cannot be imported here: every provider module
 * transitively pulls the `@oh-my-pi/pi-utils` barrel (`Bun.env` at module
 * scope, `bun:sqlite`, `node:fs`), which crashes workerd at import time. This
 * module ports the two OAuth usage fetchers GitSpace vaults hold (Anthropic
 * `/api/oauth/usage`, OpenAI Codex `wham/usage`) against the wire types from
 * `@oh-my-pi/pi-ai/usage` (type-only import), producing the same limit ids,
 * labels, windows and metadata OMP's usage UI expects.
 */
import { claudeCodeVersion } from '@oh-my-pi/pi-ai/providers/claude-code-fingerprint';
import type { UsageAmount, UsageLimit, UsageReport, UsageResetCredits, UsageStatus, UsageWindow } from '@oh-my-pi/pi-ai/usage';
import type { StoredOAuthCredential, WorkerOAuthProvider } from './providers.js';

export interface OmpUsageResponse {
  generatedAt: number;
  reports: UsageReport[];
}

type UsageFetcher = (credential: StoredOAuthCredential, fetcher: typeof fetch, signal: AbortSignal) => Promise<UsageReport | null>;

const USAGE_FETCH_TIMEOUT_MS = 12_000;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const USER_AGENT = 'gitspace-omp-broker';

const CLAUDE_ENDPOINT = 'https://api.anthropic.com/api/oauth';
const CLAUDE_MAX_ATTEMPTS = 3;
const CLAUDE_BASE_RETRY_DELAY_MS = 500;
const CLAUDE_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'anthropic-beta':
    'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,mid-conversation-system-2026-04-07,advanced-tool-use-2025-11-20,effort-2025-11-24,extended-cache-ttl-2025-04-11',
  'content-type': 'application/json',
  'user-agent': `claude-cli/${claudeCodeVersion} (external, cli)`,
} as const;

const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const CODEX_JWT_AUTH_CLAIM = 'https://api.openai.com/auth';
const CODEX_JWT_PROFILE_CLAIM = 'https://api.openai.com/profile';

type Json = Record<string, unknown>;

/** Provider payloads are loosely shaped JSON; this is the package's one boundary guard. Fields stay `unknown`. */
function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function parseIsoTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percentAmount(usedPercent: number): UsageAmount {
  const clamped = Math.min(Math.max(usedPercent, 0), 100);
  const usedFraction = clamped / 100;
  return {
    used: clamped,
    limit: 100,
    remaining: Math.max(0, 100 - clamped),
    usedFraction,
    remainingFraction: Math.max(0, 1 - usedFraction),
    unit: 'percent',
  };
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) {
    reject(signal.reason);
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    reject(signal.reason);
  };
  const timer = setTimeout(() => {
    signal.removeEventListener('abort', onAbort);
    resolve();
  }, delayMs);
  signal.addEventListener('abort', onAbort, { once: true });
  return promise;
}

// ─── Anthropic ─────────────────────────────────────────────────────────────

interface ClaudeBucket {
  utilization?: number;
  resetsAt?: number;
}

interface ClaudeApiLimitEntry {
  kind: string;
  bucket: ClaudeBucket;
  displayName?: string;
}

function parseClaudeBucket(bucket: unknown): ClaudeBucket | undefined {
  if (!isRecord(bucket)) return undefined;
  const utilization = toNumber(bucket.utilization);
  const resetsAt = parseIsoTimestamp(bucket.resets_at);
  if (utilization === undefined && resetsAt === undefined) return undefined;
  return { utilization, resetsAt };
}

function parseClaudeApiLimitEntries(raw: unknown): ClaudeApiLimitEntry[] {
  if (!Array.isArray(raw)) return [];
  const entries: ClaudeApiLimitEntry[] = [];
  for (const entry of raw) {
    if (!isRecord(entry) || typeof entry.kind !== 'string') continue;
    const utilization = toNumber(entry.percent);
    const resetsAt = parseIsoTimestamp(entry.resets_at);
    if (utilization === undefined && resetsAt === undefined) continue;
    const scope = isRecord(entry.scope) && isRecord(entry.scope.model) ? entry.scope.model : undefined;
    const displayName = nonEmptyString(scope?.display_name);
    entries.push({ kind: entry.kind, bucket: { utilization, resetsAt }, ...(displayName ? { displayName } : {}) });
  }
  return entries;
}

function claudeStatus(usedFraction: number | undefined): UsageStatus | undefined {
  if (usedFraction === undefined) return undefined;
  if (usedFraction >= 1) return 'exhausted';
  if (usedFraction >= 0.9) return 'warning';
  return 'ok';
}

function claudeLimit(args: {
  id: string;
  label: string;
  windowId: string;
  windowLabel: string;
  durationMs: number;
  bucket: ClaudeBucket | undefined;
  tier?: string;
  shared?: boolean;
}): UsageLimit | null {
  if (!args.bucket || args.bucket.utilization === undefined) return null;
  const amount = percentAmount(args.bucket.utilization);
  const window: UsageWindow = {
    id: args.windowId,
    label: args.windowLabel,
    durationMs: args.durationMs,
    ...(args.bucket.resetsAt !== undefined ? { resetsAt: args.bucket.resetsAt } : {}),
  };
  return {
    id: args.id,
    label: args.label,
    scope: {
      provider: 'anthropic',
      windowId: args.windowId,
      ...(args.tier !== undefined ? { tier: args.tier } : {}),
      ...(args.shared !== undefined ? { shared: args.shared } : {}),
    },
    window,
    amount,
    status: claudeStatus(amount.usedFraction),
  };
}

function claudeScopedWeeklyLimits(entries: readonly ClaudeApiLimitEntry[]): UsageLimit[] {
  const seen = new Set<string>();
  const limits: UsageLimit[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'weekly_scoped' || !entry.displayName) continue;
    const slug = entry.displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    const limit = claudeLimit({
      id: `anthropic:7d:${slug}`,
      label: `Claude 7 Day (${entry.displayName})`,
      windowId: '7d',
      windowLabel: '7 Day',
      durationMs: WEEK_MS,
      bucket: entry.bucket,
      tier: slug,
    });
    if (limit) limits.push(limit);
  }
  return limits;
}

function parseDollarAmount(amountMinor: unknown, exponent: unknown, currency: unknown, currencyRequired: boolean): number | undefined {
  if (typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor) || amountMinor < 0) return undefined;
  if (typeof exponent !== 'number' || !Number.isSafeInteger(exponent) || exponent < 0) return undefined;
  if (currency === undefined) {
    if (currencyRequired) return undefined;
  } else if (typeof currency !== 'string' || currency.toUpperCase() !== 'USD') {
    return undefined;
  }
  const dollars = amountMinor / 10 ** exponent;
  return Number.isFinite(dollars) ? dollars : undefined;
}

function parseClaudeExtraUsage(payload: Json): { used: number; limit?: number } | null {
  if (payload.spend === null || payload.spend === undefined) {
    const value = payload.extra_usage;
    if (!isRecord(value) || value.is_enabled !== true || !Object.hasOwn(value, 'monthly_limit')) return null;
    const decimalPlaces = value.decimal_places === undefined ? 2 : value.decimal_places;
    const used = parseDollarAmount(value.used_credits, decimalPlaces, value.currency, false);
    if (used === undefined) return null;
    if (value.monthly_limit === null || value.monthly_limit === undefined) return { used };
    const limit = parseDollarAmount(value.monthly_limit, decimalPlaces, value.currency, false);
    return limit === undefined || limit <= 0 ? null : { used, limit };
  }
  const value = payload.spend;
  if (!isRecord(value) || value.enabled !== true || !Object.hasOwn(value, 'limit') || !isRecord(value.used)) return null;
  const used = parseDollarAmount(value.used.amount_minor, value.used.exponent, value.used.currency, true);
  if (used === undefined) return null;
  if (value.limit === null) return { used };
  if (!isRecord(value.limit)) return null;
  const limit = parseDollarAmount(value.limit.amount_minor, value.limit.exponent, value.limit.currency, true);
  return limit === undefined || limit <= 0 ? null : { used, limit };
}

function claudeExtraUsageLimit(payload: Json): UsageLimit | null {
  const parsed = parseClaudeExtraUsage(payload);
  if (!parsed) return null;
  let amount: UsageAmount;
  let status: UsageStatus | undefined;
  if (parsed.limit === undefined) {
    amount = { used: parsed.used, unit: 'usd' };
  } else {
    const remaining = Math.max(0, parsed.limit - parsed.used);
    const usedFraction = parsed.used / parsed.limit;
    if (!Number.isFinite(usedFraction)) return null;
    amount = { used: parsed.used, unit: 'usd', limit: parsed.limit, remaining, usedFraction, remainingFraction: remaining / parsed.limit };
    status = parsed.used >= parsed.limit ? 'exhausted' : (claudeStatus(usedFraction) ?? 'ok');
  }
  return {
    id: 'anthropic:extra',
    label: 'Claude Extra Usage',
    scope: { provider: 'anthropic', windowId: 'extra' },
    amount,
    ...(status !== undefined ? { status } : {}),
  };
}

function claudeLimits(payload: Json): UsageLimit[] {
  const entries = parseClaudeApiLimitEntries(payload.limits);
  const fiveHour = parseClaudeBucket(payload.five_hour) ?? entries.find((entry) => entry.kind === 'session')?.bucket;
  const sevenDay = parseClaudeBucket(payload.seven_day) ?? entries.find((entry) => entry.kind === 'weekly_all')?.bucket;
  return [
    claudeLimit({ id: 'anthropic:5h', label: 'Claude 5 Hour', windowId: '5h', windowLabel: '5 Hour', durationMs: 5 * HOUR_MS, bucket: fiveHour, shared: true }),
    claudeLimit({ id: 'anthropic:7d', label: 'Claude 7 Day', windowId: '7d', windowLabel: '7 Day', durationMs: WEEK_MS, bucket: sevenDay, shared: true }),
    claudeLimit({ id: 'anthropic:7d:opus', label: 'Claude 7 Day (Opus)', windowId: '7d', windowLabel: '7 Day', durationMs: WEEK_MS, bucket: parseClaudeBucket(payload.seven_day_opus), tier: 'opus' }),
    claudeLimit({ id: 'anthropic:7d:sonnet', label: 'Claude 7 Day (Sonnet)', windowId: '7d', windowLabel: '7 Day', durationMs: WEEK_MS, bucket: parseClaudeBucket(payload.seven_day_sonnet), tier: 'sonnet' }),
    ...claudeScopedWeeklyLimits(entries),
    claudeExtraUsageLimit(payload),
  ].filter((limit): limit is UsageLimit => limit !== null);
}

function claudeIdentity(payload: Json): { accountId?: string; email?: string } {
  const account = isRecord(payload.account) ? payload.account : undefined;
  const user = isRecord(payload.user) ? payload.user : undefined;
  return {
    accountId:
      nonEmptyString(payload.account_id) ?? nonEmptyString(payload.accountId) ?? nonEmptyString(payload.user_id) ?? nonEmptyString(payload.userId)
      ?? nonEmptyString(account?.uuid) ?? nonEmptyString(account?.id) ?? nonEmptyString(user?.uuid) ?? nonEmptyString(user?.id),
    email: nonEmptyString(payload.email) ?? nonEmptyString(payload.user_email) ?? nonEmptyString(payload.userEmail) ?? nonEmptyString(account?.email) ?? nonEmptyString(user?.email),
  };
}

function claudeRetryDelayMs(attempt: number, retryAfter: string | null): number {
  const baseline = CLAUDE_BASE_RETRY_DELAY_MS * 2 ** attempt;
  if (!retryAfter?.trim()) return baseline;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(baseline, Math.max(0, seconds * 1000));
  const dateDelay = Date.parse(retryAfter) - Date.now();
  return Number.isFinite(dateDelay) ? Math.max(baseline, Math.max(0, dateDelay)) : baseline;
}

async function fetchClaudePayload(url: string, headers: Record<string, string>, fetcher: typeof fetch, signal: AbortSignal): Promise<Json | null> {
  let lastPayload: Json | null = null;
  for (let attempt = 0; attempt < CLAUDE_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) break;
    let retryAfter: string | null = null;
    try {
      const response = await fetcher(url, { headers, signal });
      if (response.ok) {
        const parsed = (await response.json()) as unknown;
        if (isRecord(parsed)) {
          lastPayload = parsed;
          if (claudeLimits(parsed).length > 0) return parsed;
        }
      } else {
        // 429 is per-source-IP throttling on an informational endpoint; retrying only deepens it.
        if (response.status < 500 && response.status !== 408) return null;
        retryAfter = response.headers.get('retry-after');
      }
    } catch (error) {
      if (signal.aborted || (isRecord(error) && (error.name === 'AbortError' || error.name === 'TimeoutError'))) return null;
    }
    if (attempt >= CLAUDE_MAX_ATTEMPTS - 1) break;
    try {
      await sleep(claudeRetryDelayMs(attempt, retryAfter), signal);
    } catch {
      break;
    }
  }
  return lastPayload;
}

async function fetchClaudeUsage(credential: StoredOAuthCredential, fetcher: typeof fetch, signal: AbortSignal): Promise<UsageReport | null> {
  const url = `${CLAUDE_ENDPOINT}/usage`;
  const headers: Record<string, string> = { ...CLAUDE_HEADERS, authorization: `Bearer ${credential.access}` };
  const payload = await fetchClaudePayload(url, headers, fetcher, signal);
  if (!payload) return null;
  const limits = claudeLimits(payload);
  if (limits.length === 0) return null;
  const identity = claudeIdentity(payload);
  let accountId = identity.accountId ?? credential.accountId;
  let email = identity.email ?? credential.email;
  if ((!accountId || !email) && !signal.aborted) {
    try {
      const response = await fetcher(`${CLAUDE_ENDPOINT}/profile`, { headers, signal });
      const profile = response.ok ? ((await response.json()) as unknown) : null;
      if (isRecord(profile)) {
        const account = isRecord(profile.account) ? profile.account : undefined;
        accountId = accountId ?? nonEmptyString(profile.uuid) ?? nonEmptyString(account?.uuid);
        email = email ?? nonEmptyString(profile.email) ?? nonEmptyString(account?.email);
      }
    } catch {
      // Identity enrichment is best-effort; the usage payload is already in hand.
    }
  }
  return {
    provider: 'anthropic',
    fetchedAt: Date.now(),
    limits,
    metadata: {
      endpoint: url,
      ...(accountId ? { accountId } : {}),
      ...(email ? { email } : {}),
      ...(credential.orgId ? { orgId: credential.orgId } : {}),
    },
  };
}

// ─── OpenAI Codex ──────────────────────────────────────────────────────────

interface CodexWindow {
  usedPercent?: number;
  limitWindowSeconds?: number;
  resetAfterSeconds?: number;
  resetAt?: number;
}

interface CodexRateLimit {
  allowed?: boolean;
  limitReached?: boolean;
  primary?: CodexWindow;
  secondary?: CodexWindow;
}

interface CodexAdditionalRateLimit extends CodexRateLimit {
  limitName?: string;
  meteredFeature?: string;
}

function parseCodexJwt(token: string): Json | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const base64 = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function codexJwtIdentity(token: string): { accountId?: string; email?: string } {
  const payload = parseCodexJwt(token);
  const auth = payload && isRecord(payload[CODEX_JWT_AUTH_CLAIM]) ? payload[CODEX_JWT_AUTH_CLAIM] : undefined;
  const profile = payload && isRecord(payload[CODEX_JWT_PROFILE_CLAIM]) ? payload[CODEX_JWT_PROFILE_CLAIM] : undefined;
  return { accountId: nonEmptyString(auth?.chatgpt_account_id), email: nonEmptyString(profile?.email) };
}

function parseCodexWindow(payload: unknown): CodexWindow | undefined {
  if (!isRecord(payload)) return undefined;
  const window: CodexWindow = {
    usedPercent: toNumber(payload.used_percent),
    limitWindowSeconds: toNumber(payload.limit_window_seconds),
    resetAfterSeconds: toNumber(payload.reset_after_seconds),
    resetAt: toNumber(payload.reset_at),
  };
  return window.usedPercent === undefined && window.limitWindowSeconds === undefined && window.resetAfterSeconds === undefined && window.resetAt === undefined
    ? undefined
    : window;
}

function parseCodexRateLimit(payload: unknown): CodexRateLimit | null {
  if (!isRecord(payload)) return null;
  const parsed: CodexRateLimit = {
    allowed: typeof payload.allowed === 'boolean' ? payload.allowed : undefined,
    limitReached: typeof payload.limit_reached === 'boolean' ? payload.limit_reached : undefined,
    primary: parseCodexWindow(payload.primary_window),
    secondary: parseCodexWindow(payload.secondary_window),
  };
  return !parsed.primary && !parsed.secondary && parsed.allowed === undefined && parsed.limitReached === undefined ? null : parsed;
}

function codexWindow(window: CodexWindow, key: 'primary' | 'secondary', nowMs: number): UsageWindow {
  let resetsAt: number | undefined;
  if (window.resetAt !== undefined) {
    resetsAt = window.resetAt > 1_000_000_000_000 ? window.resetAt : window.resetAt * 1000;
  } else if (window.resetAfterSeconds !== undefined) {
    resetsAt = nowMs + window.resetAfterSeconds * 1000;
  }
  const reset = resetsAt !== undefined ? { resetsAt } : {};
  const seconds = window.limitWindowSeconds;
  if (seconds === undefined) return { id: key, label: key === 'primary' ? 'Primary window' : 'Secondary window', ...reset };
  if (seconds >= 86_400) {
    const days = Math.round(seconds / 86_400);
    return { id: `${days}d`, label: `${days} ${days === 1 ? 'day' : 'days'}`, durationMs: seconds * 1000, ...reset };
  }
  const hours = Math.max(1, Math.round(seconds / 3600));
  return { id: `${hours}h`, label: `${hours} ${hours === 1 ? 'hour' : 'hours'}`, durationMs: seconds * 1000, ...reset };
}

function codexStatus(usedFraction: number | undefined, explicitlyAllowed: boolean): UsageStatus {
  if (usedFraction === undefined) return 'unknown';
  if (usedFraction >= 1) return explicitlyAllowed ? 'warning' : 'exhausted';
  if (usedFraction >= 0.9) return 'warning';
  return 'ok';
}

function codexLimit(args: {
  key: 'primary' | 'secondary';
  window: CodexWindow;
  rateLimit: CodexRateLimit;
  nowMs: number;
  accountId?: string;
  extra?: { slug: string; displayName: string; limitName?: string };
}): UsageLimit {
  const window = codexWindow(args.window, args.key, args.nowMs);
  const amount = args.window.usedPercent === undefined ? { unit: 'percent' as const } : percentAmount(args.window.usedPercent);
  const explicitlyAllowed = args.rateLimit.allowed === true && args.rateLimit.limitReached === false;
  if (!args.extra) {
    return {
      id: `openai-codex:${args.key}`,
      label: window.label,
      scope: { provider: 'openai-codex', windowId: window.id, shared: true },
      window,
      amount,
      status: codexStatus(amount.usedFraction, explicitlyAllowed),
    };
  }
  return {
    id: `openai-codex:${args.extra.slug}:${args.key}`,
    label: `${window.label} (${args.extra.displayName})`,
    scope: {
      provider: 'openai-codex',
      accountId: args.accountId,
      tier: args.extra.slug,
      modelId: args.extra.limitName,
      windowId: window.id,
      shared: true,
    },
    window,
    amount,
    status: codexStatus(amount.usedFraction, explicitlyAllowed),
  };
}

function codexAdditionalSlug(limit: CodexAdditionalRateLimit): string {
  const probe = `${limit.limitName ?? ''} ${limit.meteredFeature ?? ''}`.toLowerCase();
  if (probe.includes('spark') || probe.includes('bengalfox')) return 'spark';
  const source = (limit.meteredFeature ?? limit.limitName ?? 'extra').toLowerCase();
  return source.replace(/^codex[-_]/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'extra';
}

function codexAdditionalDisplayName(slug: string, limitName?: string): string {
  if (slug === 'spark') return 'Spark';
  if (limitName) return limitName;
  return slug.replace(/(^|-)([a-z])/g, (_match, sep: string, char: string) => `${sep === '-' ? ' ' : ''}${char.toUpperCase()}`);
}

async function fetchCodexUsage(credential: StoredOAuthCredential, fetcher: typeof fetch, signal: AbortSignal): Promise<UsageReport | null> {
  const nowMs = Date.now();
  if (credential.expires <= nowMs) return null;
  const jwt = codexJwtIdentity(credential.access);
  const accountId = credential.accountId ?? jwt.accountId;
  const email = (credential.email ?? jwt.email)?.trim().toLowerCase() || undefined;
  const headers: Record<string, string> = { Authorization: `Bearer ${credential.access}`, 'User-Agent': USER_AGENT };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const response = await fetcher(`${CODEX_BASE_URL}/wham/usage`, { headers, signal });
  if (!response.ok) throw new Error(`Codex usage request failed with status ${response.status}`);
  const payload = (await response.json()) as unknown;
  if (!isRecord(payload)) return null;

  const planType = nonEmptyString(payload.plan_type);
  const rateLimit = parseCodexRateLimit(payload.rate_limit);
  const additional = (Array.isArray(payload.additional_rate_limits) ? payload.additional_rate_limits : [])
    .map((entry): CodexAdditionalRateLimit | null => {
      if (!isRecord(entry)) return null;
      const parsed = parseCodexRateLimit(entry.rate_limit);
      return parsed ? { ...parsed, limitName: nonEmptyString(entry.limit_name), meteredFeature: nonEmptyString(entry.metered_feature) } : null;
    })
    .filter((entry): entry is CodexAdditionalRateLimit => entry !== null);

  const limits: UsageLimit[] = [];
  const meterStates: Record<string, { allowed?: boolean; limitReached?: boolean }> = {
    chat: { allowed: rateLimit?.allowed, limitReached: rateLimit?.limitReached },
  };
  if (rateLimit?.primary) limits.push(codexLimit({ key: 'primary', window: rateLimit.primary, rateLimit, nowMs, accountId }));
  if (rateLimit?.secondary) limits.push(codexLimit({ key: 'secondary', window: rateLimit.secondary, rateLimit, nowMs, accountId }));
  for (const entry of additional) {
    const slug = codexAdditionalSlug(entry);
    const extra = { slug, displayName: codexAdditionalDisplayName(slug, entry.limitName), limitName: entry.limitName };
    meterStates[slug] = { allowed: entry.allowed, limitReached: entry.limitReached };
    if (entry.primary) limits.push(codexLimit({ key: 'primary', window: entry.primary, rateLimit: entry, nowMs, accountId, extra }));
    if (entry.secondary) limits.push(codexLimit({ key: 'secondary', window: entry.secondary, rateLimit: entry, nowMs, accountId, extra }));
  }

  let resetCredits: UsageResetCredits | undefined;
  const credits = isRecord(payload.rate_limit_reset_credits) ? toNumber(payload.rate_limit_reset_credits.available_count) : undefined;
  if (credits !== undefined) resetCredits = { availableCount: Math.max(0, Math.trunc(credits)) };

  return {
    provider: 'openai-codex',
    fetchedAt: nowMs,
    limits,
    ...(resetCredits ? { resetCredits } : {}),
    metadata: {
      planType,
      allowed: rateLimit?.allowed,
      limitReached: rateLimit?.limitReached,
      email,
      accountId,
      meterStates,
    },
  };
}

// ─── Aggregation ───────────────────────────────────────────────────────────

/** Providers whose usage endpoints this worker can query; the rest are omitted from `/v1/usage`. */
const USAGE_FETCHERS: Partial<Record<WorkerOAuthProvider, UsageFetcher>> = {
  anthropic: fetchClaudeUsage,
  'openai-codex': fetchCodexUsage,
};

/**
 * Fetch usage for every credential with a supported provider. Per-credential
 * failures are logged and omitted; the response never carries access tokens
 * or provider `raw` bodies.
 */
export async function fetchUsageReports(credentials: readonly StoredOAuthCredential[], fetcher: typeof fetch = fetch): Promise<UsageReport[]> {
  const supported = credentials.flatMap((credential) => {
    const fetchUsage = USAGE_FETCHERS[credential.provider];
    return fetchUsage ? [{ credential, fetchUsage }] : [];
  });
  const settled = await Promise.allSettled(
    supported.map(({ credential, fetchUsage }) => fetchUsage(credential, fetcher, AbortSignal.timeout(USAGE_FETCH_TIMEOUT_MS))),
  );
  const reports: UsageReport[] = [];
  settled.forEach((result, index) => {
    const credential = supported[index]!.credential;
    if (result.status === 'rejected') {
      console.warn('omp usage fetch failed', { provider: credential.provider, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      return;
    }
    if (!result.value) return;
    const metadata = { ...result.value.metadata };
    if (!metadata.email && credential.email) metadata.email = credential.email;
    if (!metadata.accountId && credential.accountId) metadata.accountId = credential.accountId;
    reports.push({ ...result.value, metadata });
  });
  return reports;
}
