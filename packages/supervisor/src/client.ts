import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { BrokerReplySchema, DAEMON_BROKER_WORKER_ARG, SupervisorRequestError, type DaemonRequest, type DaemonResponse } from './protocol.js';
import { getDaemonRuntimeDir } from './process-identity.js';

/** A broker exits after sitting idle, so a socket that existed may be gone by the next request. */
const brokerGone = (error: unknown) => error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED');
/** Requests to the broker whose runtime directory is `runtimeDir` (`getDaemonRuntimeDir(project)`). With `reacquire`,
 * a request whose connection fails (it never reached a broker) is sent once more through a newly started broker. */
export class DaemonBrokerClient {
  constructor(readonly runtimeDir: string, private readonly reacquire?: () => Promise<DaemonBrokerClient>) {}
  async request(request: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
    try { return await this.send(request, signal); } catch (error) {
      if (!this.reacquire || !brokerGone(error)) throw error;
      return (await this.reacquire()).send(request, signal);
    }
  }
  private send(request: DaemonRequest, signal?: AbortSignal): Promise<DaemonResponse> {
    const result = Promise.withResolvers<DaemonResponse>();
    if (signal?.aborted) { result.reject(signal.reason); return result.promise; }
    const socket = createConnection(join(this.runtimeDir, 'broker.sock'));
    let buffer = '';
    const abort = () => socket.destroy(new Error('Supervisor request aborted', { cause: signal?.reason }));
    signal?.addEventListener('abort', abort, { once: true });
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('error', error => result.reject(error));
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
    const client = new DaemonBrokerClient(getDaemonRuntimeDir(project), () => {
      // This broker is gone: drop it from the cache so the next acquisition starts one.
      if (clients.get(project) === connecting) clients.delete(project);
      return daemonClientForProject(project);
    });
    const probe = new DaemonBrokerClient(client.runtimeDir);
    try { await probe.request({ op: 'list' }); return client; } catch (error) {
      if (!brokerGone(error)) throw error;
    }
    const entry = process.env.GITSPACE_SUPERVISOR_WORKER_ENTRY ?? fileURLToPath(new URL('./entry.ts', import.meta.url));
    const child = spawn(process.execPath, [entry, DAEMON_BROKER_WORKER_ARG], { detached: true, stdio: 'ignore', env: { ...process.env, GITSPACE_SUPERVISOR_PROJECT: project } });
    child.unref();
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      try { await probe.request({ op: 'list' }); return client; } catch (error) {
        if (!brokerGone(error)) throw error;
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
