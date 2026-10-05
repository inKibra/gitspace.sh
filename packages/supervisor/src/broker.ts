import { createServer } from 'node:net';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DaemonRequestSchema, ProcessIdentitySchema, SupervisorRequestError } from './protocol.js';
import { getDaemonRuntimeDir, processIdentity, sameProcess } from './process-identity.js';
import { ProcessSupervisor } from './supervisor.js';

export async function startDaemonBrokerFromEnvironment(): Promise<void> {
  const project = process.env.GITSPACE_SUPERVISOR_PROJECT;
  if (!project) throw new Error('GITSPACE_SUPERVISOR_PROJECT is required');
  const root = getDaemonRuntimeDir(resolve(project));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'broker.lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    // A live identity, or a launch with no committed identity, fences a competing broker.
    const owner = ProcessIdentitySchema.parse(JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')));
    if (await sameProcess(owner)) throw new Error('Supervisor already running');
    await rm(lock, { recursive: true });
    await mkdir(lock, { mode: 0o700 });
  }
  const identity = await processIdentity(process.pid);
  if (!identity) throw new Error('Cannot establish supervisor process identity');
  await writeFile(join(lock, 'owner.json'), JSON.stringify(identity), { mode: 0o600 });
  const socketPath = join(root, 'broker.sock');
  await rm(socketPath, { force: true });
  const supervisor = new ProcessSupervisor(root);
  await supervisor.recover();
  const server = createServer(socket => {
    let pending = '';
    const controller = new AbortController();
    socket.on('close', () => controller.abort());
    socket.on('error', () => controller.abort());
    socket.setEncoding('utf8');
    socket.on('data', (data: string) => {
      pending += data;
      if (pending.length > 16 * 1024 * 1024) { socket.destroy(new Error('Supervisor request too large')); return; }
      const newline = pending.indexOf('\n');
      if (newline === -1) return;
      const frame = pending.slice(0, newline); pending = '';
      socket.pause();
      void (async () => {
        try {
          const request = DaemonRequestSchema.parse(JSON.parse(frame));
          const value = await supervisor.request(request, controller.signal);
          socket.end(JSON.stringify({ ok: true, value }) + '\n');
          if (request.op === 'shutdown') server.close();
        } catch (error) { socket.end(JSON.stringify({ ok: false, code: error instanceof SupervisorRequestError ? error.code : 'SUPERVISOR_FAILURE', error: error instanceof Error ? error.message : String(error) }) + '\n'); }
      })();
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(socketPath, () => listening.resolve());
  await listening.promise;
  await chmod(socketPath, 0o600);
  console.log(`GitSpace supervisor ready: ${socketPath}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await supervisor.request({ op: 'shutdown' });
    server.close();
  };
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
  server.once('close', () => { void Promise.all([rm(socketPath, { force: true }), rm(lock, { recursive: true, force: true })]); });
}
