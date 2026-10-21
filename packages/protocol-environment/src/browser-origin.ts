/** Whether `hostname` falls under a browser origin pattern: a lowercase hostname, `*.hostname` or `*`. Imports nothing,
 * so the browser extension bundles it alone. */
export function browserOriginMatches(pattern: string, hostname: string): boolean {
  const validHost = (value: string): boolean => value.length > 0 && value.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(value);
  if (pattern !== '*' && !validHost(pattern.startsWith('*.') ? pattern.slice(2) : pattern)) return false;
  const host = hostname.toLowerCase();
  if (!validHost(host)) return false;
  if (pattern === '*') return true;
  return pattern.startsWith('*.') ? host.endsWith(`.${pattern.slice(2)}`) : host === pattern;
}
