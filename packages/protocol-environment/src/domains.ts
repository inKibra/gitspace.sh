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
 * The two may be one domain (an install for one organisation on a domain of its own). `<handle>.<domain>` is then the
 * account, so its relay is `<handle>-relay.<domain>`; a handle may not end in `-relay` or hold `--` there, or it would
 * name another account's relay or a hosted service.
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

/** Where a tool reads an install's domains from its account or operator Worker (`GitSpaceDomainsSchema`). */
export const DOMAINS_PATH = '/v1/domains';

/**
 * The `<meta name>` a Worker puts the install's domains in when it serves a browser app's page, so the app reads them
 * at startup without a request (`withDomainsMeta`, `domainsFromMeta`).
 */
export const DOMAINS_META_NAME = 'gitspace-domains';

/** `html` with `domains` in its head: a served page the app reads them from. */
export function withDomainsMeta(served: string, domains: GitSpaceDomains): string {
  // A page that already names domains (served on by another Worker) names this one's instead.
  const html = served.replace(new RegExp(`<meta name="${DOMAINS_META_NAME}" content="[^"]*">`, 'gu'), '');
  const head = /<head(?:\s[^>]*)?>/iu.exec(html);
  if (!head) throw new EnvironmentError('InvalidConfiguration', 'The page has no <head> to name the install\'s domains in');
  const at = head.index + head[0].length;
  const content = JSON.stringify(domains).replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  return `${html.slice(0, at)}<meta name="${DOMAINS_META_NAME}" content="${content}">${html.slice(at)}`;
}

/**
 * A Worker's response for a browser app's page, naming `domains` in its head; any other response (not HTML, or HTML
 * with no head, which no app page is) as it is.
 */
export async function withDomainsPage(response: Response, domains: GitSpaceDomains): Promise<Response> {
  if (!response.headers.get('content-type')?.includes('text/html') || response.body === null) return response;
  const page = await response.text();
  if (!/<head(?:\s[^>]*)?>/iu.test(page)) return new Response(page, { status: response.status, statusText: response.statusText, headers: response.headers });
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  // The page differs from the stored file by the domains it names.
  const etag = response.headers.get('etag');
  if (etag) headers.set('etag', `W/"${etag.replace(/^W\//u, '').replaceAll('"', '')}-${domains.account}-${domains.service}"`);
  return new Response(withDomainsMeta(page, domains), { status: response.status, statusText: response.statusText, headers });
}

/** The domains a served page names (the `content` of its `<meta name="gitspace-domains">`). A page without the tag was
 * served by a Worker from before install domains, which only ever ran on GitSpace's own: a release applies its
 * frontend and its Worker separately, so a new app can be served by such a Worker. A tag naming no valid domains is a
 * serving error. */
export function domainsFromMeta(content: string | null): GitSpaceDomains {
  if (content === null) return DEFAULT_DOMAINS;
  let value: unknown;
  try { value = JSON.parse(content); } catch { value = null; }
  const parsed = GitSpaceDomainsSchema.safeParse(value);
  if (!parsed.success) throw new EnvironmentError('InvalidConfiguration', `The page names no valid install domains (<meta name="${DOMAINS_META_NAME}">)`, { detail: parsed.error.message });
  return parsed.data;
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
/** Whether the install's account and service domains are one domain (its relay hostnames then end in `-relay`). */
export const sharesOneDomain = (domains: GitSpaceDomains): boolean => domains.account === domains.service;

/** What a relay's label ends with on an install whose account and service domains are one: `<handle>-relay.<domain>`. */
export const SHARED_DOMAIN_RELAY_SUFFIX = '-relay';

/** An account's relay hostname: machines and the transport. `<handle>.<service>`, or `<handle>-relay.<domain>` when the
 * account and service domains are one (`<handle>.<domain>` is the account). */
export const relayHostname = (domains: GitSpaceDomains, handle: string): string =>
  sharesOneDomain(domains) ? `${handle}${SHARED_DOMAIN_RELAY_SUFFIX}.${domains.service}` : `${handle}.${domains.service}`;
export const relayUrl = (domains: GitSpaceDomains, handle: string): string => `https://${relayHostname(domains, handle)}`;

/** What every hostname of a tenant's hosted services ends with: `<name>--<tenant>-srv.<service>`. */
export const hostedServiceSuffix = (domains: GitSpaceDomains, tenantId: string): string => `--${tenantId}-srv.${domains.service}`;

/** The single label of `hostname` under `domain` (`<label>.<domain>`), or null. */
function labelUnder(domain: string, hostname: string): string | null {
  const match = new RegExp(`^([a-z0-9-]+)\\.${domain.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u').exec(hostname.toLowerCase());
  return match?.[1] ?? null;
}

/** A label an install with one domain keeps for itself: a relay (`<handle>-relay`) or a hosted service (`…--…`). */
const sharedDomainReserved = (label: string): boolean => label.endsWith(SHARED_DOMAIN_RELAY_SUFFIX) || label.includes('--');

/** The handle of an account hostname (`<handle>.<account>`), or null for any other host (on an install with one domain,
 * its relay and hosted-service hostnames are not accounts). */
export function handleOfAccountHostname(domains: GitSpaceDomains, hostname: string): string | null {
  const label = labelUnder(domains.account, hostname);
  return label !== null && sharesOneDomain(domains) && sharedDomainReserved(label) ? null : label;
}

/** The handle of a relay hostname (`relayHostname`), or null for any other host. (On an install with one domain, an
 * account's or a hosted service's hostname is not a relay; with two, hosted services are told apart by their shape.) */
export function handleOfRelayHostname(domains: GitSpaceDomains, hostname: string): string | null {
  const label = labelUnder(domains.service, hostname);
  if (label === null) return null;
  if (!sharesOneDomain(domains)) return label;
  if (!label.endsWith(SHARED_DOMAIN_RELAY_SUFFIX)) return null;
  const handle = label.slice(0, -SHARED_DOMAIN_RELAY_SUFFIX.length);
  return handle === '' || sharedDomainReserved(handle) ? null : handle;
}

/** Whether `handle` may name an account of this install: on an install with one domain, a handle ending in `-relay` or
 * holding `--` would take another account's relay or a hosted service's hostname. */
export const isInstallHandle = (domains: GitSpaceDomains, handle: string): boolean => !(sharesOneDomain(domains) && sharedDomainReserved(handle));

/**
 * The service domain an account's relay URL names (`https://<handle>.<service>`, or `https://<handle>-relay.<domain>` on
 * an install with one domain), for a machine that knows its relay but not the install's settings; null when the URL is
 * not that account's relay.
 */
export function serviceDomainOfRelayUrl(relay: string, handle: string): string | null {
  let host: string;
  try { host = new URL(relay).hostname.toLowerCase(); } catch { return null; }
  for (const label of [handle, `${handle}${SHARED_DOMAIN_RELAY_SUFFIX}`]) {
    if (!host.startsWith(`${label}.`)) continue;
    const parsed = DomainNameSchema.safeParse(host.slice(label.length + 1));
    if (parsed.success) return parsed.data;
  }
  return null;
}

/** A host that belongs to the install itself: its domains and their subdomains. */
export function isInstallHostname(domains: GitSpaceDomains, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, '');
  return [domains.account, domains.service].some((domain) => host === domain || host.endsWith(`.${domain}`));
}
