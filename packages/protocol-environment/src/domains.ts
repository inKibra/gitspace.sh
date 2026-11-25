import { z } from 'zod';
import { EnvironmentError } from './errors.js';

/**
 * The two public domains an install of GitSpace answers on.
 *
 * - `account` (default `gitspace.sh`): each account at `<handle>.<account>`, the site at the apex, the operator API at
 *   `api.<account>` and compute sandboxes at `sandboxes.<account>`.
 * - `service` (default `gssh.dev`): each account's relay at `<handle>.<service>`, the platform at `platform.<service>`
 *   and an account's hosted services at `<name>--<tenant>-srv.<service>`.
 *
 * Every host check and every URL GitSpace hands out is made here, from the install's `ACCOUNT_DOMAIN` and
 * `SERVICE_DOMAIN`, so the patterns are defined once. Unset, they are GitSpace's own, and production is unchanged.
 */
export const DEFAULT_ACCOUNT_DOMAIN = 'gitspace.sh';
export const DEFAULT_SERVICE_DOMAIN = 'gssh.dev';

/** A DNS name of two labels or more, lowercase, without a trailing dot. */
export const DomainNameSchema = z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/u, 'A domain is a lowercase DNS name such as example.com');

export const GitSpaceDomainsSchema = z.object({ account: DomainNameSchema, service: DomainNameSchema }).strict();
export type GitSpaceDomains = z.infer<typeof GitSpaceDomainsSchema>;

export const DEFAULT_DOMAINS: GitSpaceDomains = { account: DEFAULT_ACCOUNT_DOMAIN, service: DEFAULT_SERVICE_DOMAIN };

/** Where a browser app learns the install's domains from the Worker that served it (`GitSpaceDomainsSchema`). */
export const DOMAINS_PATH = '/v1/domains';

/** A browser app's question to the Worker that served it: the install's domains, or why it has none. */
export async function fetchInstallDomains(origin: string, fetcher: typeof fetch = fetch): Promise<{ ok: true; domains: GitSpaceDomains } | { ok: false; reason: string }> {
  try {
    const response = await fetcher(new URL(DOMAINS_PATH, origin), { cache: 'no-store', redirect: 'error' });
    if (!response.ok) return { ok: false, reason: `${DOMAINS_PATH} answered ${response.status}` };
    const parsed = GitSpaceDomainsSchema.safeParse(await response.json());
    return parsed.success ? { ok: true, domains: parsed.data } : { ok: false, reason: `${DOMAINS_PATH} answered no domains` };
  } catch (error) {
    return { ok: false, reason: `${DOMAINS_PATH} is unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** What an install's configuration says: each domain, unset or empty for the default. */
export type DomainSettings = { readonly ACCOUNT_DOMAIN?: string | undefined; readonly SERVICE_DOMAIN?: string | undefined };

/** The install's domains, from its configuration. A malformed domain is a configuration error, not a fallback. */
export function domainsFromSettings(settings: DomainSettings): GitSpaceDomains {
  const parsed = GitSpaceDomainsSchema.safeParse({
    account: settings.ACCOUNT_DOMAIN || DEFAULT_ACCOUNT_DOMAIN,
    service: settings.SERVICE_DOMAIN || DEFAULT_SERVICE_DOMAIN,
  });
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', 'ACCOUNT_DOMAIN and SERVICE_DOMAIN must be DNS names', { detail: parsed.error.message });
  return parsed.data;
}

/** The site at the account domain's apex (signup, docs). */
export const siteUrl = (domains: GitSpaceDomains): string => `https://${domains.account}`;
/** The operator API (enrollment of a new account, recovery). */
export const apiUrl = (domains: GitSpaceDomains): string => `https://api.${domains.account}`;
/** Compute sandboxes' host. */
export const sandboxesHostname = (domains: GitSpaceDomains): string => `sandboxes.${domains.account}`;
/** The platform's own host. */
export const platformUrl = (domains: GitSpaceDomains): string => `https://platform.${domains.service}`;

/** An account's hostname: its browser app and RPC. */
export const accountHostname = (domains: GitSpaceDomains, handle: string): string => `${handle}.${domains.account}`;
export const accountUrl = (domains: GitSpaceDomains, handle: string): string => `https://${accountHostname(domains, handle)}`;
/** An account's relay hostname: machines and the transport. */
export const relayHostname = (domains: GitSpaceDomains, handle: string): string => `${handle}.${domains.service}`;
export const relayUrl = (domains: GitSpaceDomains, handle: string): string => `https://${relayHostname(domains, handle)}`;

/** What every hostname of a tenant's hosted services ends with: `<name>--<tenant>-srv.<service>`. */
export const hostedServiceSuffix = (domains: GitSpaceDomains, tenantId: string): string => `--${tenantId}-srv.${domains.service}`;

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** The handle of an account hostname (`<handle>.<account>`), or null for any other host. */
export function handleOfAccountHostname(domains: GitSpaceDomains, hostname: string): string | null {
  const match = new RegExp(`^([a-z0-9-]+)\\.${escaped(domains.account)}$`, 'u').exec(hostname.toLowerCase());
  return match?.[1] ?? null;
}

/**
 * The service domain an account's relay URL names (`https://<handle>.<service>`), for a machine that knows its relay but
 * not the install's settings; null when the URL is not that account's relay.
 */
export function serviceDomainOfRelayUrl(relay: string, handle: string): string | null {
  let host: string;
  try { host = new URL(relay).hostname.toLowerCase(); } catch { return null; }
  if (!host.startsWith(`${handle}.`)) return null;
  const parsed = DomainNameSchema.safeParse(host.slice(handle.length + 1));
  return parsed.success ? parsed.data : null;
}

/** A host that belongs to the install itself: its domains and their subdomains. */
export function isInstallHostname(domains: GitSpaceDomains, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return [domains.account, domains.service].some((domain) => host === domain || host.endsWith(`.${domain}`));
}
