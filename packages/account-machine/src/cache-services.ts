import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { daemonClientForProject, type DaemonResponse } from '@gitspace/supervisor';
import { checkoutPath, checkoutTerminalEnvironment, inheritedCommandEnvironment, type LocalAttachment } from '@gitspace/runtime-machine';
import { RuntimeServiceOperationSchema, type RuntimeService } from '@gitspace/protocol-runtime/services';
import type { z } from 'zod';
import type { WorkspaceServiceManager } from './workspace-services.js';
import { workspaceProcessVisible } from './workspace-process.js';

/** Ready attachment worktrees own runtime services. */
export async function cacheServiceOperation(manager: WorkspaceServiceManager, local: LocalAttachment, raw: z.input<typeof RuntimeServiceOperationSchema>) {
  const operation = RuntimeServiceOperationSchema.parse(raw);
  const { attachment } = local;
  if (attachment.state !== 'ready') throw new Error('Services require a ready attachment');
  const source: unknown = JSON.parse(await readFile(join(local.rootPath, '.gitspace/services.json'), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '{"services":[]}' : Promise.reject(error)));
  const definitions = manager.parseDefinitions(source);
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
  const declared = definitions.map((definition): RuntimeService => {
    const name = terminalName(definition.name);
    const process = processes.find(item => item.daemon.name === name);
    if (!process && listed.daemons.some(item => item.name === name)) throw new Error('Service process is private or outside this attachment');
    return { name: definition.name, source: 'declared', terminalName: name, state: process?.daemon.state ?? 'stopped', url: definition.ports.some(port => port.protocol === 'http') ? manager.routeUrl(attachment.workspaceId, definition.name) : null };
  });
  const agent = processes.filter(process => !declared.some(service => service.terminalName === process.daemon.name)).map((process): RuntimeService => ({ name: process.daemon.name, source: 'process', terminalName: process.daemon.name, state: process.daemon.state, url: process.spec.ready?.port ? manager.routeUrl(attachment.workspaceId, process.daemon.name) : null }));
  if (operation.op === 'list') return [...declared, ...agent];
  const current = [...declared, ...agent].find(item => item.name === operation.name && item.source === operation.source);
  if (!current) throw new Error('Service is not configured or is outside this attachment');
  if (operation.op === 'logs') {
    if (current.state === 'stopped') return { name: current.name, text: '' };
    const logs = await client.request({ op: 'logs', name: current.terminalName, lines: 200 });
    if (logs.op !== 'logs') throw new Error('Invalid supervisor logs response');
    return { name: current.name, text: logs.text };
  }
  if (operation.op === 'stop') {
    if (current.state !== 'stopped') await client.request({ op: 'stop', name: current.terminalName });
    await manager.releaseProcessRoutes(attachment.workspaceId, current.name);
    return { ...current, state: 'stopped' as const };
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
      if (process.spec.ready.port) await manager.registerProcessRoute({ projectId: attachment.projectId, workspaceId: attachment.workspaceId, generation: attachment.generation, name: current.name, portName: 'http', port: process.spec.ready.port });
    }
    return { ...current, state: daemon.state };
  }
  const definition = definitions.find(item => item.name === current.name);
  if (!definition) throw new Error('Service is not configured');
  if (operation.op === 'restart' && current.state !== 'stopped') await client.request({ op: 'stop', name: current.terminalName });
  const cwd = await checkoutPath(local.rootPath, definition.cwd);
  const ports = await manager.allocateDefinitionPorts(attachment.workspaceId, definition);
  const env: Record<string, string> = { ...await checkoutTerminalEnvironment(local.rootPath, inheritedCommandEnvironment()), ...definition.env, GITSPACE_PORTS_JSON: JSON.stringify(Object.fromEntries(ports.map(port => [port.name, port.port]))) };
  if (ports[0]) env.PORT = String(ports[0].port);
  for (const port of ports) env[`GITSPACE_PORT_${port.name.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`] = String(port.port);
  const ready = ports[0] ? { port: ports[0].port, host: '127.0.0.1', timeoutMs: 30_000 } : undefined;
  const started = await client.request({ op: 'start', owner, spec: { name: current.terminalName, application: definition.command, args: definition.args, cwd, env, pty: false, restart: 'no', persist: true, detached: false, ready } });
  if (started.op !== 'start') throw new Error('Invalid supervisor start response');
  let daemon = started.daemon;
  if (ready) {
    const observed = await client.request({ op: 'wait', name: current.terminalName, for: 'ready', timeoutMs: ready.timeoutMs });
    if (observed.op !== 'wait' || observed.daemon.id !== started.daemon.id || observed.timedOut || observed.daemon.readiness?.timedOut || observed.daemon.state !== 'ready') throw new Error('Service did not become ready');
    daemon = observed.daemon;
  }
  for (const port of ports) if (port.protocol === 'http') await manager.registerProcessRoute({ projectId: attachment.projectId, workspaceId: attachment.workspaceId, generation: attachment.generation, name: definition.name, portName: port.name, port: port.port });
  return { ...current, state: daemon.state };
}
