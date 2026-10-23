import { daemonClientForProject, type DaemonResponse } from '@gitspace/supervisor';
import { checkoutPath, type LocalAttachment } from '@gitspace/runtime-machine';
import { RuntimeServiceOperationSchema, type RuntimeService } from '@gitspace/protocol-runtime/services';
import type { z } from 'zod';
import { parseServiceDefinitions, readServicesJson, type LocalHttpService, type WorkspaceServiceManager } from './workspace-services.js';
import { workspaceProcessVisible } from './workspace-process.js';

/** A declared service or visible ad hoc process of the attachment, with its `http` ports (port numbers once known). */
interface LocalServiceEntry {
  name: string;
  source: RuntimeService['source'];
  terminalName: string;
  state: RuntimeService['state'];
  portNames: string[];
  ports: LocalHttpService['ports'];
}

async function inventory(manager: WorkspaceServiceManager, local: LocalAttachment) {
  const { attachment } = local;
  if (attachment.state !== 'ready') throw new Error('Services require a ready attachment');
  const definitions = parseServiceDefinitions(await readServicesJson(local.rootPath));
  const client = await daemonClientForProject(local.rootPath);
  const owner = `workspace:${attachment.projectId}:${attachment.workspaceId}`;
  const listed = await client.request({ op: 'list' });
  if (listed.op !== 'list') throw new Error('Invalid supervisor response');
  const processes: Extract<DaemonResponse, { op: 'describe' }>[] = [];
  for (const daemon of listed.daemons) {
    if (daemon.owner !== owner) continue;
    const described = await client.request({ op: 'describe', name: daemon.name });
    if (described.op !== 'describe') throw new Error('Invalid supervisor response');
    if (!await workspaceProcessVisible(local.rootPath, described)) continue;
    processes.push(described);
  }
  const terminalName = (name: string) => `gitspace-svc-${attachment.attachmentId}-${name}`;
  const declared = await Promise.all(definitions.map(async (definition): Promise<LocalServiceEntry> => {
    const name = terminalName(definition.name);
    const process = processes.find(item => item.daemon.name === name);
    if (!process && listed.daemons.some(item => item.name === name)) throw new Error('Service process is private or outside this attachment');
    const ports = (await manager.definitionPorts(attachment.workspaceId, definition)).filter(port => port.protocol === 'http').map(port => ({ name: port.name, port: port.port }));
    return { name: definition.name, source: 'declared', terminalName: name, state: process?.daemon.state ?? 'stopped', portNames: definition.ports.filter(port => port.protocol === 'http').map(port => port.name), ports };
  }));
  const agent = processes.filter(process => !declared.some(service => service.terminalName === process.daemon.name)).map((process): LocalServiceEntry => {
    const port = process.spec.ready?.port;
    return { name: process.daemon.name, source: 'process', terminalName: process.daemon.name, state: process.daemon.state, portNames: port ? ['http'] : [], ports: port ? [{ name: 'http', port }] : [] };
  });
  return { definitions, client, owner, processes, services: [...declared, ...agent] };
}

async function views(manager: WorkspaceServiceManager, local: LocalAttachment, services: readonly LocalServiceEntry[]): Promise<RuntimeService[]> {
  const urls = await manager.urls(local.attachment.projectId, local.attachment.workspaceId, services.map(service => ({ source: service.source, name: service.name, ports: service.portNames })));
  return services.map((service, index) => {
    const url = urls[index];
    if (!url) throw new Error(`Service ${service.name} has no URLs`);
    return { name: service.name, source: service.source, terminalName: service.terminalName, state: service.state, url: url.url, machineUrl: url.machineUrl, ports: url.ports };
  });
}

function localHttpService(local: LocalAttachment, service: Pick<LocalServiceEntry, 'source' | 'name' | 'ports'>): LocalHttpService {
  return { projectId: local.attachment.projectId, workspaceId: local.attachment.workspaceId, generation: local.attachment.generation, source: service.source, name: service.name, ports: service.ports };
}

/** A running service of this attachment with an `http` port, for a pin. */
export async function runningHttpService(manager: WorkspaceServiceManager, local: LocalAttachment, source: RuntimeService['source'], name: string): Promise<LocalHttpService> {
  const service = (await inventory(manager, local)).services.find(item => item.source === source && item.name === name);
  if (!service) throw new Error(`No ${source === 'declared' ? 'declared service' : 'process'} named ${name} in this workspace`);
  if (service.state !== 'running' && service.state !== 'ready') throw new Error(`${name} is not running on this machine`);
  if (service.ports.length === 0) throw new Error(`${name} has no http port`);
  return localHttpService(local, service);
}

/** After a machine restart: the attachment's running services lease their URLs again, workspace URLs as their pointers say. */
export async function rehydrateServiceRoutes(manager: WorkspaceServiceManager, local: LocalAttachment): Promise<void> {
  for (const service of (await inventory(manager, local)).services) {
    if ((service.state === 'running' || service.state === 'ready') && service.ports.length > 0) await manager.registerService(localHttpService(local, service));
  }
}

/** Ready attachment worktrees own runtime services. */
export async function cacheServiceOperation(manager: WorkspaceServiceManager, local: LocalAttachment, raw: z.input<typeof RuntimeServiceOperationSchema>) {
  const operation = RuntimeServiceOperationSchema.parse(raw);
  const { attachment } = local;
  const { definitions, client, owner, processes, services } = await inventory(manager, local);
  if (operation.op === 'list') return views(manager, local, services);
  const current = services.find(item => item.name === operation.name && item.source === operation.source);
  if (!current) throw new Error('Service is not configured or is outside this attachment');
  const view = async (state: RuntimeService['state']) => {
    const [service] = await views(manager, local, [{ ...current, state }]);
    if (!service) throw new Error(`Service ${current.name} has no view`);
    return service;
  };
  if (operation.op === 'logs') {
    if (current.state === 'stopped') return { name: current.name, text: '' };
    const logs = await client.request({ op: 'logs', name: current.terminalName, lines: 200 });
    if (logs.op !== 'logs') throw new Error('Invalid supervisor logs response');
    return { name: current.name, text: logs.text };
  }
  if (operation.op === 'stop') {
    if (current.state !== 'stopped') await client.request({ op: 'stop', name: current.terminalName });
    await manager.releaseService(attachment.workspaceId, current.source, current.name);
    return view('stopped');
  }
  if (current.source === 'process') {
    const process = processes.find(item => item.daemon.name === current.terminalName);
    if (!process) throw new Error('Process unavailable');
    const restarted = await client.request({ op: 'restart', name: current.terminalName });
    if (restarted.op !== 'restart') throw new Error('Invalid supervisor restart response');
    let daemon = restarted.daemon;
    if (process.spec.ready) {
      const ready = await client.request({ op: 'wait', name: current.terminalName, for: 'ready', timeoutMs: process.spec.ready.timeoutMs ?? 30_000 });
      if (ready.op !== 'wait' || ready.daemon.id !== daemon.id || ready.timedOut || ready.daemon.readiness?.timedOut || ready.daemon.state !== 'ready') throw new Error('Process did not become ready');
      daemon = ready.daemon;
      await manager.registerService(localHttpService(local, current));
    }
    return view(daemon.state);
  }
  const definition = definitions.find(item => item.name === current.name);
  if (!definition) throw new Error('Service is not configured');
  if (operation.op === 'restart' && current.state !== 'stopped') await client.request({ op: 'stop', name: current.terminalName });
  const cwd = await checkoutPath(local.rootPath, definition.cwd);
  const ports = await manager.allocateDefinitionPorts(attachment.workspaceId, definition);
  const env = await manager.serviceEnvironment(local.rootPath, attachment.workspaceId, definitions, definition, ports);
  const ready = ports[0] ? { port: ports[0].port, host: '127.0.0.1', timeoutMs: 30_000 } : undefined;
  const started = await client.request({ op: 'start', owner, spec: { name: current.terminalName, application: definition.command, args: definition.args, cwd, env, pty: false, restart: 'no', persist: true, detached: false, ready } });
  if (started.op !== 'start') throw new Error('Invalid supervisor start response');
  let daemon = started.daemon;
  if (ready) {
    const observed = await client.request({ op: 'wait', name: current.terminalName, for: 'ready', timeoutMs: ready.timeoutMs });
    if (observed.op !== 'wait' || observed.daemon.id !== started.daemon.id || observed.timedOut || observed.daemon.readiness?.timedOut || observed.daemon.state !== 'ready') throw new Error('Service did not become ready');
    daemon = observed.daemon;
  }
  const http = ports.filter(port => port.protocol === 'http').map(port => ({ name: port.name, port: port.port }));
  await manager.registerService(localHttpService(local, { ...current, ports: http }));
  return view(daemon.state);
}
