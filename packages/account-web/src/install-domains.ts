import { DEFAULT_DOMAINS, fetchInstallDomains, type GitSpaceDomains } from '@gitspace/protocol-environment/domains';

/**
 * The install's domains, learned at startup from the Worker that served this app (`GET /v1/domains`), so one build
 * serves any install. Until then, and from a server that does not answer, GitSpace's own.
 */
let current: GitSpaceDomains = DEFAULT_DOMAINS;

export function installDomains(): GitSpaceDomains {
  return current;
}

/** Learns the domains from `origin`'s Worker. A failure keeps GitSpace's own and says so. */
export async function loadInstallDomains(origin: string, fetcher: typeof fetch = fetch): Promise<GitSpaceDomains> {
  const answered = await fetchInstallDomains(origin, fetcher);
  if (answered.ok) current = answered.domains;
  else console.warn(`GitSpace: ${answered.reason}; using ${current.account} and ${current.service}`);
  return current;
}

/** For tests: the domains as if the server had answered them. */
export function setInstallDomains(domains: GitSpaceDomains): void {
  current = domains;
}
