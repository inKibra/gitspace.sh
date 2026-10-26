/** A running http service of a workspace at its workspace URL (`https://<name>--<workspace>--<account>-srv…`): `name`
 * is the URL name (`web`, `web-admin`), `port` the local port on `machine` (its label) that serves it. */
export type WorkspaceServiceUrl = { name: string; url: string; port: number; machine: string };

/** Services listed in the instructions at most; the rest are counted. */
const SERVICES_LISTED = 8;
const LOCAL_HOSTS: Record<string, true | undefined> = { localhost: true, '127.0.0.1': true, '[::1]': true, '0.0.0.0': true };

/** The instructions' Services block, or '' with none running. */
export function servicesBlock(services: readonly WorkspaceServiceUrl[]): string {
  if (!services.length) return '';
  const rows = services.slice(0, SERVICES_LISTED).map(service => `- ${service.name}: ${service.url} (port ${service.port} on ${service.machine})`);
  const more = services.length > SERVICES_LISTED ? [`- and ${services.length - SERVICES_LISTED} more`] : [];
  return ['Services of this workspace (open these URLs in the cloud browser; it cannot reach localhost):', ...rows, ...more].join('\n');
}

/** The port of a localhost URL (localhost, 127.0.0.1, [::1], 0.0.0.0), or null for any other URL. */
export function localhostPort(url: string): number | null {
  const parsed = URL.parse(url);
  if (!parsed || !LOCAL_HOSTS[parsed.hostname]) return null;
  return parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
}

/** What the cloud browser answers a navigation to localhost `port`: the service URL to open instead, if any. */
export function localhostRefusal(port: number, services: readonly WorkspaceServiceUrl[]): string {
  const service = services.find(item => item.port === port);
  if (service) return `localhost isn't reachable from the cloud browser. This workspace's \`${service.name}\` service on port ${port} is at ${service.url}; open that. For a port with no service URL, add on:"${service.machine}".`;
  return `localhost isn't reachable from the cloud browser, and no service of this workspace has a URL for port ${port}. Declare the service in .gitspace/services.json to get a URL the cloud browser can open, or add on:"<machine>" to use that machine's headless browser.`;
}

/** The note a step on a machine's headless browser (`on`) ends with, or null when none applies. */
export function machineBrowserNote(url: string, machine: string, services: readonly WorkspaceServiceUrl[]): string | null {
  const port = localhostPort(url);
  if (port === null) return `This runs on ${machine}'s headless browser, which the user can't watch live; use the cloud browser unless you need this machine.`;
  const service = services.find(item => item.port === port);
  return service ? `This port has a service URL (${service.url}); the cloud browser can open it, and the user can watch and take it over there.` : null;
}
