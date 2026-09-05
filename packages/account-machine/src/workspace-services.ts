import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { GitSpaceDatabase } from '@gitspace/core';
import type { ServiceView } from '@gitspace/protocol/inspector-contract';
import type { HostedServiceRoute } from '@gitspace/protocol';
import type { WorkspaceTerminalView } from './workspace-hub.js';

const MIN_SERVICE_PORT = 17_000;
const MAX_SERVICE_PORT = 47_000;
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/u;

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
interface HostedRouteAuthority {
  leaseHostedRoute(projectId: string, route: Omit<HostedServiceRoute, 'updatedAt'>): Promise<HostedServiceRoute>;
  releaseHostedRoute(projectId: string, hostname: string): Promise<boolean>;
}
interface ServiceAllocationState {
  version: 1;
  allocations: Record<string, number>;
}
interface ActiveServiceRoute {
  projectId: string;
  generation: number;
  spaceId: string;
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
function serviceHostname(domain: string, namespace: string, spaceId: string, serviceName: string): string {
  const account = normalizeLabel(namespace);
  const fixedLength = account.length + '--'.length * 2 + '-srv'.length;
  const componentBudget = 63 - fixedLength;
  if (componentBudget < 13) throw new Error('GitSpace handle is too long to host workspace services');
  const serviceBudget = Math.max(6, Math.min(20, Math.floor(componentBudget / 3)));
  const spaceBudget = componentBudget - serviceBudget;
  return `${compactLabel(serviceName, serviceBudget)}--${compactLabel(spaceId, spaceBudget)}--${account}-srv.${domain}`;
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
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly terminals: ServiceTerminalCoordinator,
    private readonly machineId: string,
    private readonly runtimeRoot: string,
    private readonly publicDomain: string | null,
    private readonly publicNamespace: string | null,
    private readonly routeAuthority?: HostedRouteAuthority,
  ) {}

  async definitions(spaceId: string): Promise<WorkspaceServiceDefinition[]> {
    const space = this.database.getSpace(spaceId);
    if (!space || space.placementState === 'closed' || space.holderId !== this.machineId) throw new Error(`Space ${spaceId} is unavailable on this machine`);
    const source = await readFile(join(space.rootPath, '.gitspace', 'services.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{"services":[]}' : Promise.reject(error));
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !('services' in parsed) || !Array.isArray(parsed.services)) throw new Error('.gitspace/services.json must contain a services array');
    const services = parsed.services.map(parseService);
    if (new Set(services.map((service) => service.name)).size !== services.length) throw new Error('.gitspace/services.json repeats a service name');
    return services;
  }

  async rehydrate(): Promise<void> {
    for (const project of this.database.listProjects()) {
      const spaces = [this.database.getBaseSpace(project.id), ...this.database.listSpaces(project.id)].filter((space) => space !== null);
      for (const space of spaces) {
        if (space.placementState === 'closed' || space.holderId !== this.machineId) continue;
        await this.list(space.id).catch(() => undefined);
      }
    }
    if (!this.leaseTimer && this.routeAuthority) {
      this.leaseTimer = setInterval(() => {
        void Promise.all([...this.routes.values()].map((route) => this.leaseRoute(route)));
      }, 60_000);
    }
  }

  async list(spaceId: string): Promise<ServiceView[]> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const [definitions, terminals] = await Promise.all([this.definitions(spaceId), this.terminals.list(spaceId)]);
    const serviceTerminals = terminals.filter((terminal) => terminal.kind === 'service');
    return Promise.all(definitions.map(async (definition) => {
      const terminal = serviceTerminals.find((candidate) => candidate.owner === `gitspace:${spaceId}:service:${definition.name}`) ?? null;
      const ports = await this.allocatedPorts(spaceId, definition, false);
      const primary = ports[0] ?? null;
      if (terminal) {
        for (const port of ports) {
          if (port.protocol !== 'http' || !this.publicDomain || !this.publicNamespace) continue;
          const hostname = serviceHostname(this.publicDomain, this.publicNamespace, spaceId, definition.name);
          const route = { projectId: space.projectId, generation: space.generation, spaceId, serviceName: definition.name, portName: port.name, port: port.port, hostname };
          this.routes.set(hostname, route);
          await this.leaseRoute(route);
        }
      }
      return {
        spaceId,
        generation: space.generation,
        id: definition.name,
        name: definition.name,
        command: [definition.command, ...definition.args].join(' '),
        state: terminal?.state ?? 'stopped',
        port: primary?.port ?? null,
        url: primary?.protocol === 'http' ? this.endpoint(spaceId, definition.name, primary.name, primary.port) : null,
        terminalName: terminal?.name ?? `gitspace-svc-${normalizeLabel(spaceId)}-${definition.name}`,
        startedAt: terminal?.createdAt.toISOString() ?? null,
        exitedAt: terminal?.state === 'exited' || terminal?.state === 'failed' ? new Date().toISOString() : null,
        exitCode: terminal?.exitCode ?? null,
      };
    }));
  }

  async start(spaceId: string, serviceName: string): Promise<ServiceView> {
    const space = this.database.getSpace(spaceId);
    if (!space) throw new Error(`Space ${spaceId} does not exist`);
    const definition = (await this.definitions(spaceId)).find((service) => service.name === serviceName);
    if (!definition) throw new Error(`Service ${serviceName} is not configured`);
    const cwd = resolve(space.rootPath, definition.cwd);
    if (!inside(space.rootPath, cwd)) throw new Error(`Service ${serviceName} cwd escapes the workspace`);
    const ports = await this.allocatedPorts(spaceId, definition, true);
    const portMap = Object.fromEntries(ports.map((port) => [port.name, port.port]));
    const env: Record<string, string> = { ...definition.env, GITSPACE_SERVICE_NAME: definition.name, GITSPACE_PORTS_JSON: JSON.stringify(portMap) };
    if (ports[0]) env.PORT = String(ports[0].port);
    for (const port of ports) env[`GITSPACE_PORT_${port.name.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`] = String(port.port);
    const terminal = await this.terminals.startService(spaceId, definition.name, definition.command, definition.args, cwd, env);
    for (const port of ports) {
      if (port.protocol !== 'http' || !this.publicDomain || !this.publicNamespace) continue;
      const hostname = serviceHostname(this.publicDomain, this.publicNamespace, spaceId, definition.name);
      const route = { projectId: space.projectId, generation: space.generation, spaceId, serviceName: definition.name, portName: port.name, port: port.port, hostname };
      this.routes.set(hostname, route);
      await this.leaseRoute(route);
    }
    return (await this.list(spaceId)).find((service) => service.id === definition.name) ?? {
      spaceId, generation: space.generation, id: definition.name, name: definition.name,
      command: [definition.command, ...definition.args].join(' '), state: terminal.state,
      port: ports[0]?.port ?? null, url: ports[0]?.protocol === 'http' ? this.endpoint(spaceId, definition.name, ports[0].name, ports[0].port) : null,
      terminalName: terminal.name, startedAt: terminal.createdAt.toISOString(), exitedAt: null, exitCode: terminal.exitCode,
    };
  }

  async stop(spaceId: string, serviceName: string): Promise<ServiceView> {
    const current = (await this.list(spaceId)).find((service) => service.id === serviceName);
    if (!current) throw new Error(`Service ${serviceName} is not configured`);
    if (current.state !== 'stopped') await this.terminals.stop(spaceId, current.terminalName);
    for (const [hostname, route] of this.routes) {
      if (route.spaceId !== spaceId || route.serviceName !== serviceName) continue;
      await this.routeAuthority?.releaseHostedRoute(route.projectId, hostname);
      this.routes.delete(hostname);
    }
    return { ...current, state: 'stopped', exitedAt: new Date().toISOString(), exitCode: 0 };
  }

  async proxy(request: Request): Promise<Response | null> {
    const requestUrl = new URL(request.url);
    const hostname = request.headers.get('x-forwarded-host')?.toLowerCase() ?? requestUrl.hostname.toLowerCase();
    const route = this.routes.get(hostname);
    if (!route) return null;
    const target = new URL(request.url);
    target.protocol = 'http:';
    target.hostname = '127.0.0.1';
    target.port = String(route.port);
    const headers = new Headers(request.headers);
    headers.set('x-forwarded-host', hostname);
    headers.set('x-gitspace-space', route.spaceId);
    headers.set('x-gitspace-service', route.serviceName);
    headers.delete('host');
    return fetch(new Request(target, { method: request.method, headers, body: request.body, redirect: 'manual' }));
  }

  async dispose(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = null;
    await Promise.all([...this.routes.values()].map((route) => this.routeAuthority?.releaseHostedRoute(route.projectId, route.hostname)));
    this.routes.clear();
  }

  private async leaseRoute(route: ActiveServiceRoute): Promise<void> {
    await this.routeAuthority?.leaseHostedRoute(route.projectId, {
      hostname: route.hostname,
      workspaceId: route.spaceId,
      serviceName: route.serviceName,
      machineId: this.machineId,
      ingress: `http://127.0.0.1:${route.port}`,
      portName: route.portName,
      port: route.port,
      generation: route.generation,
      leaseExpiresAt: new Date(Date.now() + 120_000).toISOString(),
      health: 'healthy',
    });
  }

  private endpoint(spaceId: string, serviceName: string, portName: string, port: number): string {
    if (this.publicDomain && this.publicNamespace) return `https://${serviceHostname(this.publicDomain, this.publicNamespace, spaceId, serviceName)}`;
    return `http://127.0.0.1:${port}`;
  }

  private async allocatedPorts(spaceId: string, definition: WorkspaceServiceDefinition, allocate: boolean): Promise<Array<WorkspaceServicePortDefinition & { port: number }>> {
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
