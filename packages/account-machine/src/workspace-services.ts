import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { ServiceView } from '@gitspace/protocol/inspector-contract';
import type { HostedRouteLease, HostedRoutes, HostedServiceRoute } from '@gitspace/protocol';
import { SERVICE_ASSERTION_HEADER, stripGitSpaceCredentials, verifyServiceAssertion } from '@gitspace/protocol/service-access';
import type { WorkspaceCheckouts, WorkspaceTerminalView } from './workspace-hub.js';
import { checkoutTerminalEnvironment, inheritedCommandEnvironment } from '@gitspace/runtime-machine';

const MIN_SERVICE_PORT = 17_000;
const MAX_SERVICE_PORT = 47_000;
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;
/** Shares of the one 63-character DNS label a service URL is; the workspace part gets the rest and needs at least 10. */
const WORKSPACE_URL_SERVICE_SHARE = 20;
const MACHINE_URL_SERVICE_SHARE = 15;
const MACHINE_URL_MACHINE_SHARE = 12;
const MIN_WORKSPACE_SHARE = 10;

export interface WorkspaceServicePortDefinition {
  name: string;
  protocol: 'http' | 'tcp';
}
const ALLOWED_SERVICE_FIELDS: Readonly<Record<string, true>> = {
  name: true,
  command: true,
  args: true,
  cwd: true,
  env: true,
  ports: true,
};
export interface WorkspaceServiceDefinition {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  ports: WorkspaceServicePortDefinition[];
}
interface ServiceTerminalCoordinator {
  list(spaceId: string): Promise<WorkspaceTerminalView[]>;
  startService(spaceId: string, serviceName: string, application: string, args: string[], cwd: string, env: Record<string, string>): Promise<WorkspaceTerminalView>;
  stop(spaceId: string, name: string): Promise<WorkspaceTerminalView>;
}
/** The account's hosted route registry, through the machine's signed control operations. */
export interface HostedRouteAuthority {
  listMachineDefinitions(): Promise<ReadonlyArray<{ id: string; label: string }>>;
  listHostedRoutes(projectId: string): Promise<HostedRoutes>;
  leaseHostedRoute(projectId: string, route: Omit<HostedServiceRoute, 'updatedAt'>): Promise<HostedRouteLease>;
  pinHostedRoute(projectId: string, route: Omit<HostedServiceRoute, 'updatedAt'>): Promise<HostedRouteLease>;
  releaseHostedRoute(projectId: string, hostname: string, generation: number): Promise<boolean>;
}
/** A local service with `http` ports (in declared order) that this machine is running. */
export interface LocalHttpService {
  projectId: string;
  workspaceId: string;
  generation: number;
  source: HostedServiceRoute['source'];
  name: string;
  ports: Array<{ name: string; port: number }>;
}
export interface ServicePortUrls {
  name: string;
  /** The workspace URL that points at this machine's port, or null when none does. */
  url: string | null;
  machineUrl: string | null;
  /** The machine the service's own workspace URL points at, when not this port here. */
  servedBy: string | null;
}
export interface ServiceUrls {
  url: string | null;
  machineUrl: string | null;
  ports: ServicePortUrls[];
}
interface ServiceAllocationState {
  version: 1;
  allocations: Record<string, number>;
}
interface ActiveServiceRoute {
  projectId: string;
  generation: number;
  spaceId: string;
  source: HostedServiceRoute['source'];
  serviceName: string;
  portName: string;
  port: number;
  hostname: string;
}

function normalizeLabel(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9-]/gu, '-').replace(/-+/gu, '-').replace(/^-|-$/gu, '');
  return normalized || 'x';
}

function compactLabel(value: string, maxLength: number): string {
  const normalized = normalizeLabel(value);
  if (normalized.length <= maxLength) return normalized;
  const digest = new Bun.CryptoHasher('sha256').update(normalized).digest('hex').slice(0, 8);
  return `${normalized.slice(0, maxLength - digest.length - 1).replace(/-+$/u, '')}-${digest}`;
}
function hashString(value: string): number {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return hash;
}
function serviceKey(machineId: string, spaceId: string, serviceName: string, portName: string): string {
  return `${machineId}:${spaceId}:${serviceName}:${portName}`;
}
/**
 * One DNS label: a workspace URL `<service>--<workspace>--<account>-srv`, or with a machine (its readable name) a machine
 * URL `<service>--<machine>--<workspace>--<account>-srv`. The service and machine keep fixed shares and the workspace gets
 * the rest; a part over its share is a readable prefix and a hash of the whole value.
 */
export function serviceHostname(domain: string, namespace: string, workspaceId: string, service: string, machine: string | null): string {
  const account = normalizeLabel(namespace);
  const leading = machine === null ? [compactLabel(service, WORKSPACE_URL_SERVICE_SHARE)] : [compactLabel(service, MACHINE_URL_SERVICE_SHARE), compactLabel(machine, MACHINE_URL_MACHINE_SHARE)];
  const shares = machine === null ? WORKSPACE_URL_SERVICE_SHARE : MACHINE_URL_SERVICE_SHARE + MACHINE_URL_MACHINE_SHARE;
  const workspaceShare = 63 - shares - '--'.length * (leading.length + 1) - `${account}-srv`.length;
  if (workspaceShare < MIN_WORKSPACE_SHARE) throw new Error('GitSpace handle is too long to host workspace services');
  return `${[...leading, compactLabel(workspaceId, workspaceShare), `${account}-srv`].join('--')}.${domain}`;
}
/** A service's URL name for one `http` port: the first port keeps the service's name, each later port adds its own. */
function portService(service: string, portNames: readonly string[], portName: string): string {
  return portNames[0] === portName ? service : `${service}-${portName}`;
}
function inside(parent: string, candidate: string): boolean {
  const path = relative(resolve(parent), resolve(candidate));
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}
function validateStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${field} must be an array of strings`);
  return [...value];
}
function parseService(value: unknown): WorkspaceServiceDefinition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Service definition must be an object');
  const record: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) record[key] = item;
  const unknown = Object.keys(record).find((key) => !ALLOWED_SERVICE_FIELDS[key]);
  if (typeof record.name !== 'string' || !SERVICE_NAME.test(record.name)) throw new Error('Service name must be a lowercase DNS label');
  if (typeof record.command !== 'string' || !record.command.trim()) throw new Error(`Service ${record.name} requires a command`);
  const cwd = record.cwd === undefined ? '.' : record.cwd;
  if (typeof cwd !== 'string' || isAbsolute(cwd) || cwd.split('/').some((part) => part === '..')) throw new Error(`Service ${record.name} cwd must stay inside the workspace`);
  const envRecord: Record<string, string> = {};
  if (!record.env || typeof record.env !== 'object' || Array.isArray(record.env)) {
    if (record.env !== undefined) throw new Error(`Service ${record.name} env must contain strings`);
  } else {
    for (const [key, item] of Object.entries(record.env)) {
      if (typeof item !== 'string') throw new Error(`Service ${record.name} env must contain strings`);
      envRecord[key] = item;
    }
  }
  const rawPorts = record.ports ?? [];
  if (!Array.isArray(rawPorts)) throw new Error(`Service ${record.name} ports must be an array`);
  const ports: WorkspaceServicePortDefinition[] = rawPorts.map((port) => {
    if (!port || typeof port !== 'object' || Array.isArray(port)) throw new Error(`Service ${record.name} port must be an object`);
    if (!('name' in port) || typeof port.name !== 'string' || !SERVICE_NAME.test(port.name)) throw new Error(`Service ${record.name} port requires a DNS-safe name`);
    const protocol = 'protocol' in port ? port.protocol : 'http';
    if (protocol !== 'http' && protocol !== 'tcp') throw new Error(`Service ${record.name} port ${port.name} has invalid protocol`);
    return { name: port.name, protocol };
  });
  if (new Set(ports.map((port) => port.name)).size !== ports.length) throw new Error(`Service ${record.name} repeats a port name`);
  return { name: record.name, command: record.command, args: record.args === undefined ? [] : validateStringArray(record.args, `Service ${record.name} args`), cwd, env: envRecord, ports };
}

export class WorkspaceServiceManager {
  private readonly routes = new Map<string, ActiveServiceRoute>();
  private leaseTimer: Timer | null = null;
  private allocationWrites: Promise<unknown> = Promise.resolve();
  private readonly assertionNonces = new Map<string, number>();
  private machineName: string | null = null;
  constructor(
    private readonly checkouts: WorkspaceCheckouts,
    private readonly terminals: ServiceTerminalCoordinator,
    private readonly machineId: string,
    private readonly runtimeRoot: string,
    private readonly publicDomain: string | null,
    private readonly publicNamespace: string | null,
    private readonly routeAuthority: HostedRouteAuthority,
    private readonly trust?: () => Promise<{ accountId: string; publicKey: string }>,
  ) {}
  parseDefinitions(source: unknown): WorkspaceServiceDefinition[] {
    if (!source || typeof source !== 'object' || !('services' in source) || !Array.isArray(source.services)) throw new Error('Service definitions require services array');
    const definitions = source.services.map(parseService);
    if (new Set(definitions.map(item => item.name)).size !== definitions.length) throw new Error('Duplicate service name');
    return definitions;
  }
  allocateDefinitionPorts(spaceId: string, definition: WorkspaceServiceDefinition) { return this.allocatedPorts(spaceId, definition, true); }
  /** The ports this machine already allocated for a declared service; none are allocated. */
  definitionPorts(spaceId: string, definition: WorkspaceServiceDefinition) { return this.allocatedPorts(spaceId, definition, false); }

  /**
   * Leases a running service's URLs: a machine URL for every `http` port, and the workspace URLs whose stored pointer names
   * this port here. A declared service also asks for its own workspace URLs, which it claims when nothing points them
   * anywhere yet; an ad hoc process gets a workspace URL only by a pin.
   */
  async registerService(service: LocalHttpService): Promise<void> {
    if (!this.publicDomain || !this.publicNamespace || service.ports.length === 0) return;
    const machine = await this.machineLabel();
    const { pointers } = await this.routeAuthority.listHostedRoutes(service.projectId);
    const portNames = service.ports.map(port => port.name);
    for (const port of service.ports) {
      const name = portService(service.name, portNames, port.name);
      const local = { projectId: service.projectId, generation: service.generation, spaceId: service.workspaceId, source: service.source, serviceName: service.name, portName: port.name, port: port.port };
      await this.leaseRoute({ ...local, hostname: serviceHostname(this.publicDomain, this.publicNamespace, service.workspaceId, name, machine) });
      const own = service.source === 'declared' ? [serviceHostname(this.publicDomain, this.publicNamespace, service.workspaceId, name, null)] : [];
      const pinned = pointers.filter(pointer => pointer.workspaceId === service.workspaceId && pointer.machineId === this.machineId && pointer.source === service.source && pointer.serviceName === service.name && pointer.portName === port.name).map(pointer => pointer.hostname);
      for (const hostname of new Set([...own, ...pinned])) await this.leaseRoute({ ...local, hostname });
    }
  }

  /** Points a workspace URL (`as`, per port as for a service's own URLs) at this machine's running service and port. */
  async pin(service: LocalHttpService, as: string, portName?: string): Promise<string> {
    if (!this.publicDomain || !this.publicNamespace) throw new Error('Private service routing is not configured');
    const port = portName === undefined ? service.ports[0] : service.ports.find(item => item.name === portName);
    if (!port) throw new Error(portName === undefined ? `${service.name} has no http port` : `${service.name} has no http port ${portName}`);
    const hostname = serviceHostname(this.publicDomain, this.publicNamespace, service.workspaceId, portService(as, service.ports.map(item => item.name), port.name), null);
    const route = { projectId: service.projectId, generation: service.generation, spaceId: service.workspaceId, source: service.source, serviceName: service.name, portName: port.name, port: port.port, hostname };
    if (!(await this.routeAuthority.pinHostedRoute(route.projectId, this.hostedRoute(route))).route) throw new Error(`The workspace URL ${hostname} was not pinned`);
    this.routes.set(hostname, route);
    return `https://${hostname}`;
  }

  /** Each service's URLs from the stored pointers: `ports` lists `http` port names in declared order. */
  async urls(projectId: string, workspaceId: string, services: ReadonlyArray<{ source: HostedServiceRoute['source']; name: string; ports: readonly string[] }>): Promise<ServiceUrls[]> {
    const { publicDomain: domain, publicNamespace: namespace } = this;
    if (!domain || !namespace) return services.map(service => ({ url: null, machineUrl: null, ports: service.ports.map(name => ({ name, url: null, machineUrl: null, servedBy: null })) }));
    const [machine, { pointers }] = await Promise.all([this.machineLabel(), this.routeAuthority.listHostedRoutes(projectId)]);
    return services.map(service => {
      const ports = service.ports.map((portName): ServicePortUrls => {
        const name = portService(service.name, service.ports, portName);
        const own = serviceHostname(domain, namespace, workspaceId, name, null);
        const here = pointers.filter(pointer => pointer.workspaceId === workspaceId && pointer.machineId === this.machineId && pointer.source === service.source && pointer.serviceName === service.name && pointer.portName === portName);
        const pointed = here.find(pointer => pointer.hostname === own) ?? here[0];
        const elsewhere = service.source === 'declared' ? pointers.find(pointer => pointer.hostname === own && !here.includes(pointer)) : undefined;
        return { name: portName, url: pointed ? `https://${pointed.hostname}` : null, machineUrl: `https://${serviceHostname(domain, namespace, workspaceId, name, machine)}`, servedBy: elsewhere?.machineLabel ?? null };
      });
      return { url: ports[0]?.url ?? null, machineUrl: ports[0]?.machineUrl ?? null, ports };
    });
  }

  async releaseService(spaceId: string, source: HostedServiceRoute['source'], name: string): Promise<void> {
    for (const [hostname, route] of this.routes) {
      if (route.spaceId !== spaceId || route.source !== source || route.serviceName !== name) continue;
      await this.routeAuthority.releaseHostedRoute(route.projectId, hostname, route.generation);
      this.routes.delete(hostname);
    }
  }

  async definitions(spaceId: string): Promise<WorkspaceServiceDefinition[]> {
    const { rootPath } = this.held(spaceId);
    const source = await readFile(join(rootPath, '.gitspace', 'services.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{"services":[]}' : Promise.reject(error));
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('services' in parsed) || !Array.isArray(parsed.services)) throw new Error('.gitspace/services.json must contain a services array');
    const services = parsed.services.map(parseService);
    if (new Set(services.map((service) => service.name)).size !== services.length) throw new Error('.gitspace/services.json repeats a service name');
    return services;
  }

  async rehydrate(): Promise<void> {
    for (const spaceId of this.checkouts.list()) await this.list(spaceId).catch(() => undefined);
    if (!this.leaseTimer) {
      // A failed renewal is retried on the next tick (the lease outlives two ticks); it must not end the process.
      this.leaseTimer = setInterval(() => {
        for (const route of this.routes.values()) {
          this.leaseRoute(route).catch((error: unknown) => console.error(JSON.stringify({
            event: 'route_lease_failed', hostname: route.hostname, message: error instanceof Error ? error.message : String(error),
          })));
        }
      }, 60_000);
    }
  }

  async list(spaceId: string): Promise<ServiceView[]> {
    const space = this.held(spaceId);
    const [definitions, terminals] = await Promise.all([this.definitions(spaceId), this.terminals.list(spaceId)]);
    const serviceTerminals = terminals.filter((terminal) => terminal.kind === 'service');
    return Promise.all(definitions.map(async (definition) => {
      const terminal = serviceTerminals.find((candidate) => candidate.owner === `gitspace:${spaceId}:service:${definition.name}`) ?? null;
      const ports = await this.allocatedPorts(spaceId, definition, false);
      const primary = ports[0] ?? null;
      const http = ports.filter(port => port.protocol === 'http');
      if (terminal) await this.registerService({ projectId: space.projectId, workspaceId: spaceId, generation: space.generation, source: 'declared', name: definition.name, ports: http });
      const [urls] = primary?.protocol === 'http' ? await this.urls(space.projectId, spaceId, [{ source: 'declared', name: definition.name, ports: http.map(port => port.name) }]) : [];
      return {
        spaceId,
        generation: space.generation,
        id: definition.name,
        name: definition.name,
        command: [definition.command, ...definition.args].join(' '),
        state: terminal?.state ?? 'stopped',
        port: primary?.port ?? null,
        url: primary?.protocol === 'http' ? urls?.url ?? urls?.machineUrl ?? `http://127.0.0.1:${primary.port}` : null,
        terminalName: terminal?.name ?? `gitspace-svc-${normalizeLabel(spaceId)}-${definition.name}`,
        startedAt: terminal?.createdAt.toISOString() ?? null,
        exitedAt: terminal?.state === 'exited' || terminal?.state === 'failed' ? new Date().toISOString() : null,
        exitCode: terminal?.exitCode ?? null,
      };
    }));
  }

  async start(spaceId: string, serviceName: string): Promise<ServiceView> {
    const space = this.held(spaceId);
    const definition = (await this.definitions(spaceId)).find((service) => service.name === serviceName);
    if (!definition) throw new Error(`Service ${serviceName} is not configured`);
    const cwd = resolve(space.rootPath, definition.cwd);
    if (!inside(space.rootPath, cwd)) throw new Error(`Service ${serviceName} cwd escapes the workspace`);
    const ports = await this.allocatedPorts(spaceId, definition, true);
    const portMap = Object.fromEntries(ports.map((port) => [port.name, port.port]));
    const env: Record<string, string> = { ...await checkoutTerminalEnvironment(space.rootPath, inheritedCommandEnvironment()), ...definition.env, GITSPACE_SERVICE_NAME: definition.name, GITSPACE_PORTS_JSON: JSON.stringify(portMap) };
    if (ports[0]) env.PORT = String(ports[0].port);
    for (const port of ports) env[`GITSPACE_PORT_${port.name.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`] = String(port.port);
    await this.terminals.startService(spaceId, definition.name, definition.command, definition.args, cwd, env);
    const started = (await this.list(spaceId)).find((service) => service.id === definition.name);
    if (!started) throw new Error(`Service ${serviceName} is not configured`);
    return started;
  }

  async stop(spaceId: string, serviceName: string): Promise<ServiceView> {
    const current = (await this.list(spaceId)).find((service) => service.id === serviceName);
    if (!current) throw new Error(`Service ${serviceName} is not configured`);
    if (current.state !== 'stopped') await this.terminals.stop(spaceId, current.terminalName);
    await this.releaseService(spaceId, 'declared', serviceName);
    return { ...current, state: 'stopped', exitedAt: new Date().toISOString(), exitCode: 0 };
  }

  async stopOwned(spaceId: string): Promise<void> {
    for (const terminal of await this.terminals.list(spaceId)) {
      if (terminal.kind === 'service' && terminal.owner?.startsWith(`gitspace:${spaceId}:`)) {
        await this.terminals.stop(spaceId, terminal.name);
      }
    }
    for (const [hostname, route] of this.routes) {
      if (route.spaceId !== spaceId) continue;
      await this.routeAuthority.releaseHostedRoute(route.projectId, hostname, route.generation);
      this.routes.delete(hostname);
    }
  }

  /** A workspace URL and a machine URL for the same port reach the same local port; the assertion names the requested one. */
  async proxy(request: Request): Promise<Response | null> {
    const requestUrl = new URL(request.url);
    const hostname = request.headers.get('x-forwarded-host')?.toLowerCase() ?? requestUrl.hostname.toLowerCase();
    const route = this.routes.get(hostname);
    if (!route) return null;
    const trust = await this.trust?.();
    const assertion = trust ? verifyServiceAssertion({ header: request.headers.get(SERVICE_ASSERTION_HEADER), publicKey: trust.publicKey, accountId: trust.accountId, machineId: this.machineId, hostname, method: request.method, target: `${requestUrl.pathname}${requestUrl.search}` }) : null;
    if (!assertion || this.assertionNonces.has(assertion.nonce)) return new Response('Service authorization required', { status: 401 });
    for (const [nonce, expiry] of this.assertionNonces) if (expiry <= Date.now()) this.assertionNonces.delete(nonce);
    this.assertionNonces.set(assertion.nonce, assertion.expiresAt);
    const target = new URL(request.url);
    target.protocol = 'http:';
    target.hostname = '127.0.0.1';
    target.port = String(route.port);
    if (request.headers.get('x-gitspace-websocket-probe') === '1') return Response.json({ url: target.href.replace(/^http/u, 'ws') });
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', hostname);
    headers.set('x-gitspace-space', route.spaceId);
    headers.set('x-gitspace-service', route.serviceName);
    headers.delete('host');
    headers.delete(SERVICE_ASSERTION_HEADER);
    stripGitSpaceCredentials(headers);
    return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  }

  async dispose(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    await Promise.all([...this.routes.values()].map((route) => this.routeAuthority.releaseHostedRoute(route.projectId, route.hostname, route.generation)));
    this.routes.clear();
  }

  /** The machine part of its URLs: its fleet label and the first 4 hex digits of its id, readable and unique although labels are not. */
  private async machineLabel(): Promise<string> {
    if (this.machineName) return this.machineName;
    const definition = (await this.routeAuthority.listMachineDefinitions()).find(item => item.id === this.machineId);
    if (!definition) throw new Error(`Machine ${this.machineId} has no fleet definition, so its service URLs have no machine name`);
    const hex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu.exec(this.machineId)?.[0] ?? new Bun.CryptoHasher('sha256').update(this.machineId).digest('hex');
    this.machineName = `${definition.label}-${hex.slice(0, 4).toLowerCase()}`;
    return this.machineName;
  }

  /** A workspace URL the registry refuses (its pointer names another port) stops routing here to this service's port. */
  private async leaseRoute(route: ActiveServiceRoute): Promise<void> {
    const leased = await this.routeAuthority.leaseHostedRoute(route.projectId, this.hostedRoute(route));
    if (leased.route) {
      this.routes.set(route.hostname, route);
      return;
    }
    const current = this.routes.get(route.hostname);
    if (current && current.spaceId === route.spaceId && current.source === route.source && current.serviceName === route.serviceName && current.portName === route.portName) this.routes.delete(route.hostname);
  }

  private hostedRoute(route: ActiveServiceRoute): Omit<HostedServiceRoute, 'updatedAt'> {
    return {
      hostname: route.hostname,
      workspaceId: route.spaceId,
      serviceName: route.serviceName,
      source: route.source,
      machineId: this.machineId,
      ingress: `http://127.0.0.1:${route.port}`,
      portName: route.portName,
      port: route.port,
      generation: route.generation,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      health: 'healthy',
    };
  }

  /** The held checkout of a workspace; its hosted routes are unfenced (generation 0). */
  private held(spaceId: string): { rootPath: string; projectId: string; generation: number } {
    const rootPath = this.checkouts.path(spaceId);
    const projectId = this.checkouts.projectId(spaceId);
    if (!rootPath || !projectId) throw new Error(`Space ${spaceId} is unavailable on this machine`);
    return { rootPath, projectId, generation: 0 };
  }

  private async allocatedPorts(spaceId: string, definition: WorkspaceServiceDefinition, allocate: boolean): Promise<Array<WorkspaceServicePortDefinition & { port: number }>> {
    const operation = this.allocationWrites.then(() => this.allocatePorts(spaceId, definition, allocate));
    this.allocationWrites = operation.catch(() => undefined);
    return operation;
  }

  private async allocatePorts(spaceId: string, definition: WorkspaceServiceDefinition, allocate: boolean): Promise<Array<WorkspaceServicePortDefinition & { port: number }>> {
    const state = await this.readAllocations();
    const reserved = new Set(Object.values(state.allocations));
    const result: Array<WorkspaceServicePortDefinition & { port: number }> = [];
    for (const port of definition.ports) {
      const key = serviceKey(this.machineId, spaceId, definition.name, port.name);
      let value = state.allocations[key];
      if (value === undefined && allocate) {
        const range = MAX_SERVICE_PORT - MIN_SERVICE_PORT + 1;
        const seed = hashString(key) % range;
        for (let offset = 0; offset < range; offset += 1) {
          const candidate = MIN_SERVICE_PORT + ((seed + offset) % range);
          if (reserved.has(candidate)) continue;
          try {
            const listener = Bun.listen({ hostname: '127.0.0.1', port: candidate, socket: { data() {} } });
            listener.stop(true);
            value = candidate;
            break;
          } catch { /* Port is in use. */ }
        }
        if (value === undefined) throw new Error(`No local port is available for ${definition.name}:${port.name}`);
        state.allocations[key] = value;
        reserved.add(value);
      }
      if (value !== undefined) result.push({ ...port, port: value });
    }
    if (allocate) await this.writeAllocations(state);
    return result;
  }

  private async readAllocations(): Promise<ServiceAllocationState> {
    const path = join(this.runtimeRoot, 'services', 'ports.json');
    return readFile(path, 'utf8').then((source) => JSON.parse(source) as ServiceAllocationState).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return { version: 1, allocations: {} };
      throw error;
    });
  }

  private async writeAllocations(state: ServiceAllocationState): Promise<void> {
    const directory = join(this.runtimeRoot, 'services');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'ports.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }
}
