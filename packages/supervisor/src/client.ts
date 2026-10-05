import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { BrokerReplySchema, DAEMON_BROKER_WORKER_ARG, SupervisorRequestError, type DaemonRequest, type DaemonResponse } from './protocol.js';
import { getDaemonRuntimeDir } from './process-identity.js';

export class DaemonBrokerClient {
  constructor(readonly projectDir: string, private readonly unavailable?: () => void) {}
  request(request: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
    const result = Promise.withResolvers<DaemonResponse>();
    if (signal?.aborted) { result.reject(signal.reason); return result.promise; }
    const socket = createConnection(join(getDaemonRuntimeDir(this.projectDir), 'broker.sock'));
    let buffer = '';
    const abort = () => socket.destroy(new Error('Supervisor request aborted', { cause: signal?.reason }));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', error => {
      if ('code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED')) this.unavailable?.();
      result.reject(error);
    });
    socket.on('close', () => { signal?.removeEventListener('abort', abort); result.reject(new Error('Supervisor connection closed before a response')); });
    socket.on('data', (data: string) => {
      buffer += data;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      try {
        const reply = BrokerReplySchema.parse(JSON.parse(buffer.slice(0, newline)));
        if (reply.ok) result.resolve(reply.value); else result.reject(new SupervisorRequestError(reply.code, reply.error));
      } catch (error) { result.reject(error); }
      socket.destroy();
    });
    return result.promise;
  }
}
const clients = new Map<string, Promise<DaemonBrokerClient>>();
export function daemonClientForProject(projectDirectory: string): Promise<DaemonBrokerClient> {
  const project = resolve(projectDirectory);
  const existing = clients.get(project);
  if (existing) return existing;
  const connecting: Promise<DaemonBrokerClient> = (async () => {
    let connected = false;
    const client = new DaemonBrokerClient(project, () => {
      // Evict only this dead connection's cache entry. Never replay its request.
      if (connected && clients.get(project) === connecting) clients.delete(project);
    });
    try { await client.request({ op: 'list' }); connected = true; return client; } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'))) throw error;
    }
    const entry = process.env.GITSPACE_SUPERVISOR_WORKER_ENTRY ?? fileURLToPath(new URL('./entry.ts', import.meta.url));
    const child = spawn(process.execPath, [entry, DAEMON_BROKER_WORKER_ARG], { detached: true, stdio: 'ignore', env: { ...process.env, GITSPACE_SUPERVISOR_PROJECT: project } });
    child.unref();
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try { await client.request({ op: 'list' }); connected = true; return client; } catch (error) {
        if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'))) throw error;
      }
      await Bun.sleep(25);
    }
    throw new Error('GitSpace supervisor failed to become reachable');
  })();
  clients.set(project, connecting);
  void connecting.catch(() => { if (clients.get(project) === connecting) clients.delete(project); });
  return connecting;
}
/** Disconnect callers only: process lifetime is not coupled to agent/client lifetime. */
export async function closeDaemonClients(): Promise<void> { clients.clear(); }
