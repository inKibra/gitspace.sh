import { DOMAINS_META_NAME, domainsFromMeta, type GitSpaceDomains } from '@gitspace/protocol-environment/domains';

/**
 * The install's domains, named by the Worker that served this page (`<meta name="gitspace-domains">`, which it puts
 * in every page it serves), read once at startup without a request. A page without the tag came from a Worker older
 * than install domains, which ran on GitSpace's own; a tag naming no valid domains throws, and the app shows it.
 */
let current: GitSpaceDomains | undefined;

export function installDomains(): GitSpaceDomains {
  current ??= domainsFromMeta(typeof document === 'undefined' ? null : document.querySelector<HTMLMetaElement>(`meta[name="${DOMAINS_META_NAME}"]`)?.content ?? null);
  return current;
}

/** For tests: the domains as if the served page had named them (undefined: read the page again). */
export function setInstallDomains(domains: GitSpaceDomains | undefined): void {
  current = domains;
}
