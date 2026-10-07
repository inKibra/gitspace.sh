import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { daemonClientForProject } from '@gitspace/supervisor';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import type { WorkspaceServiceManager } from './workspace-services.js';

/** Ready attachment worktrees, not legacy primary projections, own runtime services. */
export async function replicaServiceOperation(manager: WorkspaceServiceManager, local: LocalAttachment, operation: { op: 'list' | 'start' | 'stop'; name?: string }) {
  const { attachment } = local;
  if (attachment.state !== 'ready') throw new Error('Services require a ready attachment');
  const source: unknown = JSON.parse(await readFile(join(local.rootPath, '.gitspace/services.json'), 'utf8'));
  const definitions = manager.parseDefinitions(source);
  const client = await daemonClientForProject(local.rootPath);
  const owner = `workspace:${attachment.projectId}:${attachment.workspaceId}`;
  const describe = async (definition: typeof definitions[number]) => {
    const name = `gitspace-svc-${attachment.attachmentId}-${definition.name}`;
    const listed = await client.request({ op: 'list' });
    if (listed.op !== 'list') throw new Error('Invalid supervisor response');
    const daemon = listed.daemons.find(item => item.name === name && item.owner === owner);
    return { name: definition.name, terminalName: name, state: daemon?.state ?? 'stopped', url: manager.routeUrl(attachment.workspaceId, definition.name) };
  };
  if (operation.op === 'list') return Promise.all(definitions.map(describe));
  const definition = definitions.find(item => item.name === operation.name);
  if (!definition) throw new Error('Service is not configured');
  const name = `gitspace-svc-${attachment.attachmentId}-${definition.name}`;
  if (operation.op === 'stop') {
    await client.request({ op: 'stop', name });
    await manager.releaseProcessRoutes(attachment.workspaceId, definition.name);
    return describe(definition);
  }
  const ports = await manager.allocateDefinitionPorts(attachment.workspaceId, definition);
  const env = { ...definition.env, PORT: String(ports[0]?.port ?? ''), GITSPACE_PORTS_JSON: JSON.stringify(Object.fromEntries(ports.map(port => [port.name, port.port]))) };
  for (const port of ports) Object.assign(env, { [`GITSPACE_PORT_${port.name.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`]: String(port.port) });
  const ready = ports[0] ? { port: ports[0].port, host: '127.0.0.1', timeoutMs: 30_000 } : undefined;
  const started = await client.request({ op: 'start', owner, spec: { name, application: definition.command, args: definition.args, cwd: resolve(local.rootPath, definition.cwd), env, pty: false, restart: 'no', persist: true, detached: false, ready } });
  if (started.op !== 'start') throw new Error('Invalid supervisor start response');
  if (ready) {
    const observed = await client.request({ op: 'wait', name, for: 'ready', timeoutMs: ready.timeoutMs });
    if (observed.op !== 'wait' || observed.daemon.id !== started.daemon.id || observed.timedOut || observed.daemon.readiness?.timedOut || observed.daemon.state !== 'ready') {
      const logs = await client.request({ op: 'logs', name, lines: 50 });
      throw new Error(`Service did not become ready: ${JSON.stringify(observed)}; ${logs.op === 'logs' ? logs.text : ''}`);
    }
  }
  for (const port of ports) if (port.protocol === 'http') await manager.registerProcessRoute({ projectId: attachment.projectId, workspaceId: attachment.workspaceId, generation: attachment.generation, name: definition.name, portName: port.name, port: port.port });
  return describe(definition);
}
