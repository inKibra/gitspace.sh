import { DOMAINS_META_NAME, domainsFromMeta, type GitSpaceDomains } from '@gitspace/protocol-environment/domains';

/**
 * The install's domains, named by the Worker that served this page (`<meta name="gitspace-domains">`), read once at
 * startup without a request. A page without them is a serving error: it throws, and the app shows it.
 */
let current: GitSpaceDomains | undefined;

export function installDomains(): GitSpaceDomains {
  current ??= domainsFromMeta(document.querySelector<HTMLMetaElement>(`meta[name="${DOMAINS_META_NAME}"]`)?.content ?? null);
  return current;
}
