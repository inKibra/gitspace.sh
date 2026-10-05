import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonBrokerClient } from '../../supervisor/src/client.js';
import { DAEMON_BROKER_WORKER_ARG } from '../../supervisor/src/protocol.js';
import { validateExecutableArtifact } from '../../deployment/src/executable-manifest.js';
import { prepareMachineNativeRuntime } from '../../deployment/src/native-runtime.js';

const machinePath = '/opt/gitspace/machine';
const hash = process.env.GITSPACE_PROBE_MACHINE_HASH;
const manifestHash = process.env.GITSPACE_PROBE_MACHINE_MANIFEST_HASH;
if (!hash || !manifestHash) throw new Error('Run the probe compiled into the image with its initial machine trust anchors');
await validateExecutableArtifact(machinePath, { target: 'machine', hash, manifestHash });
const native = await prepareMachineNativeRuntime(machinePath);
if (!native.gitLfs) throw new Error('Container machine image lacks bundled Git LFS');

const home = await mkdtemp(join(tmpdir(), 'gitspace-image-probe-'));
process.env.GITSPACE_SUPERVISOR_HOME = join(home, 'supervisor');
const rpc = new DaemonBrokerClient(home);
const child = Bun.spawn([process.execPath, join(machinePath, 'machine-worker.js'), DAEMON_BROKER_WORKER_ARG], {
  cwd: home,
  env: { HOME: home, XDG_CONFIG_HOME: home, TMPDIR: home, PATH: '/usr/local/bin:/usr/bin:/bin', GITSPACE_SUPERVISOR_PROJECT: home, GITSPACE_SUPERVISOR_HOME: process.env.GITSPACE_SUPERVISOR_HOME },
  stdout: 'inherit', stderr: 'inherit',
});
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`Container supervisor exited during startup (${child.exitCode})`);
    try {
      const listed = await rpc.request({ op: 'list' }, AbortSignal.timeout(1_000));
      if (listed.op !== 'list' || listed.daemons.length !== 0) throw new Error('Container supervisor returned unexpected initial state');
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ECONNREFUSED'))) throw error;
      if (Date.now() >= deadline) throw new Error('Container supervisor did not become ready', { cause: error });
      await Bun.sleep(25);
    }
  }
  await rpc.request({ op: 'start', owner: 'image-probe', spec: {
    name: 'image-probe', application: '/bin/sh', args: ['-c', 'printf supervisor-ready'],
    env: { PATH: '/usr/bin:/bin' }, inheritEnv: false, cwd: home,
    pty: false, restart: 'no', persist: true, detached: false,
  } }, AbortSignal.timeout(5_000));
  const exited = await rpc.request({ op: 'wait', name: 'image-probe', for: 'exit', timeoutMs: 5_000 }, AbortSignal.timeout(10_000));
  if (exited.op !== 'wait' || exited.timedOut || exited.daemon.exitCode !== 0) throw new Error('Container supervisor process probe failed');
  const logs = await rpc.request({ op: 'logs', name: 'image-probe' }, AbortSignal.timeout(5_000));
  if (logs.op !== 'logs' || logs.text !== 'supervisor-ready') throw new Error('Container supervisor did not capture process output');
  await rpc.request({ op: 'shutdown' }, AbortSignal.timeout(5_000));
  console.log(JSON.stringify({ supervisor: 'ready', gitLfs: native.gitLfs, machineHash: hash, bunVersion: Bun.version }));
} finally {
  child.kill();
  await child.exited;
  await rm(home, { recursive: true, force: true });
}
