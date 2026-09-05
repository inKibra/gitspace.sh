import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMP_IPC_VERSION, OmpRpcPeer, type OmpChildApi } from '../../account-omp/src/ipc.js';

const home = await mkdtemp(join(tmpdir(), 'gitspace-image-probe-'));
const rpc = new OmpRpcPeer<OmpChildApi, Record<string, never>>((message) => child.send(message), {});
const child = Bun.spawn([process.execPath, '/opt/gitspace/omp/omp.js'], {
  cwd: '/opt/gitspace',
  env: { HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, PATH: '/usr/local/bin:/usr/bin:/bin' },
  stdout: 'inherit', stderr: 'inherit',
  ipc: (message) => rpc.receive(message),
  onExit: (_child, code) => rpc.close(new Error(`Container OMP exited during startup (${code})`)),
});
try {
  const health = await rpc.call('health', [], AbortSignal.timeout(30_000));
  if (health.protocolVersion !== OMP_IPC_VERSION || health.bunVersion !== Bun.version || health.platform !== 'linux' || health.arch !== 'x64') {
    throw new Error('Container OMP runtime does not match its Linux x64 host');
  }
  console.log(JSON.stringify({ omp: 'ready', ...health }));
} finally {
  rpc.close();
  child.kill();
  await child.exited;
  await rm(home, { recursive: true, force: true });
}
