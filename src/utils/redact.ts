/**
 * Content redaction (docs/REPORT-A-PROBLEM.md, stage 2).
 *
 * The safety gate for anything captured and shipped off-machine — diagnostic
 * bundles, crash logs, issue bodies. `crash-log.ts` already redacts sensitive
 * CLI *flag values*; this adds *content* scrubbing (tokens, bearer, JWTs,
 * home paths) that runs over free-form error text and logs.
 *
 * Pure and dependency-free (no fs) so it runs identically in the daemon and
 * the browser. Redaction is conservative-by-design: prefer over-redacting a
 * near-miss to leaking a real secret.
 */

const REDACTED = '[REDACTED]';

// Each pattern replaces the secret-bearing portion with [REDACTED]. Ordered so
// more specific patterns run before broad ones.
const PATTERNS: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_, github_pat_…
  { re: /\b(gh[posru]_[A-Za-z0-9]{20,255})\b/g, replace: () => REDACTED },
  { re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g, replace: () => REDACTED },
  // Slack tokens
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replace: () => REDACTED },
  // AWS access key ids
  { re: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: () => REDACTED },
  // JWTs (three base64url segments) — commonly session/auth tokens (eyJ…)
  { re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, replace: () => REDACTED },
  // Authorization headers: "Bearer <token>", "Basic <token>", "token <token>"
  { re: /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, scheme: string) => `${scheme} ${REDACTED}` },
  // x-access-token:<pat>@ (git-over-https credential form)
  { re: /x-access-token:[^@\s]+@/g, replace: () => `x-access-token:${REDACTED}@` },
  // Absolute home paths → ~  (strip the username, keep the shape)
  { re: /\/(?:home|Users)\/[^/\s"']+/g, replace: () => '~' },
];

// Sensitive CLI flags whose value (space- or =-separated) must be scrubbed
// wherever they appear in free text (crash-log.redactArgv only covers argv).
const SENSITIVE_FLAGS = [
  '--bootstrap-token', '--enrollment-token', '--invite', '--linear-key',
  '--machine-key-exchange-key', '--machine-signing-key', '--relay-private-key',
  '--unlock-token', '--password', '--token',
];

const FLAG_RE = new RegExp(
  `(${SENSITIVE_FLAGS.map((f) => f.replace(/[-]/g, '\\-')).join('|')})(\\s+|=)(\\S+)`,
  'g',
);

/** Redact secrets from a single string. Never throws. */
export function redactText(input: string): string {
  if (!input) return input;
  try {
    let out = input;
    out = out.replace(FLAG_RE, (_m, flag: string, sep: string) => `${flag}${sep}${REDACTED}`);
    for (const { re, replace } of PATTERNS) {
      out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
    }
    return out;
  } catch {
    // If redaction itself fails, fail CLOSED: drop the whole string rather
    // than risk emitting an unredacted secret.
    return REDACTED;
  }
}

/** Deep-redact every string in a JSON-ish value (arrays/objects/strings). */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}
