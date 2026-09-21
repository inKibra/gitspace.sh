import { mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ReplacementEnvironment } from './replacement-environment.js';
import { signedCredentialAuthorityGrantSchema } from '@gitspace/protocol/credential-vault';
import { MachineRelayConnector } from './relay-connector.js';
import { acquireMachineLock, alive, atomicJson, readJson, verifyMachine } from './machine-update.js';
import type { MachineSelection } from './machine-update.js';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const environmentRoot = requiredEnvironment('GITSPACE_ENVIRONMENT_ROOT');
const bundleRoot = process.env.GITSPACE_BUNDLE_ROOT ?? import.meta.dir;
const artifactKey = Uint8Array.from(Buffer.from(requiredEnvironment('GITSPACE_ARTIFACT_KEY'), 'base64'));
if (artifactKey.byteLength !== 32) throw new Error('GITSPACE_ARTIFACT_KEY must decode to 32 bytes');
await mkdir(environmentRoot, { recursive: true });
const selection: MachineSelection = JSON.parse(requiredEnvironment('GITSPACE_HOST_SELECTION'));
await verifyMachine(selection);
const owner = Number(process.env.GITSPACE_UPDATE_OWNER);
if (owner) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const transaction = await readJson<{ pid: number; successorPid?: number }>(
      join(environmentRoot, 'machine-update.json'),
    );
    if (transaction?.pid === owner && transaction.successorPid === process.pid) break;
    if (!alive(owner) || Date.now() > deadline) throw new Error('Complete-host launch was not durably authorized');
    await Bun.sleep(50);
  }
} else if (await readJson(join(environmentRoot, 'machine-update.json'))) {
  throw new Error('An interrupted update requires bootstrap recovery before opening the machine database');
}
const releaseLock = acquireMachineLock(environmentRoot, 'host');
process.env.GITSPACE_CONTROL_TOKEN ??=
  (await readJson<{ token: string }>(join(environmentRoot, 'host-control.json')))?.token ?? crypto.randomUUID();
await atomicJson(join(environmentRoot, 'host-control.json'), { token: process.env.GITSPACE_CONTROL_TOKEN });
process.env.GITSPACE_HOST_PID = String(process.pid);
process.env.GITSPACE_HOST_HASH = selection.hash;
const previousMachine = await readJson<{ pid: number; hostPid: number; url: string }>(
  join(environmentRoot, 'host-machine.json'),
);
if (previousMachine && alive(previousMachine.pid)) {
  if (alive(previousMachine.hostPid)) throw new Error('Another host still owns the running machine');
  const retired = await fetch(`${previousMachine.url}/__control/retire`, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.GITSPACE_CONTROL_TOKEN}` },
    signal: AbortSignal.timeout(30_000),
  });
  if (!retired.ok || ((await retired.json()) as { stopMode?: string }).stopMode !== 'replace')
    throw new Error('Orphan machine did not acknowledge retained ownership');
  process.kill(previousMachine.pid, 'SIGTERM');
  const deadline = Date.now() + 150_000;
  while (alive(previousMachine.pid)) {
    if (Date.now() > deadline) throw new Error('Orphan machine did not drain; startup remains fenced');
    await Bun.sleep(100);
  }
}
process.env.GITSPACE_HOST_RPC_PORT = process.env.GITSPACE_RPC_PORT ?? '8081';
process.env.GITSPACE_HOST_RPC_HOST = process.env.GITSPACE_RPC_HOST ?? '127.0.0.1';
process.env.GITSPACE_HOST_WEB_PORT = process.env.GITSPACE_WEB_PORT ?? '0';
const environment = new ReplacementEnvironment({
  id: process.env.GITSPACE_ENVIRONMENT_ID ?? 'machine',
  root: environmentRoot,
  repositoryRoot: environmentRoot,
  rpcPort: Number(process.env.GITSPACE_HOST_RPC_PORT),
  rpcHost: process.env.GITSPACE_HOST_RPC_HOST,
  webPort: Number(process.env.GITSPACE_HOST_WEB_PORT),
  machineId: requiredEnvironment('GITSPACE_MACHINE_ID'),
  artifactKey,
  ompAgentDir: requiredEnvironment('GITSPACE_OMP_AGENT_DIR'),
  controlToken: process.env.GITSPACE_CONTROL_TOKEN,
});
process.env.GITSPACE_HOST_RPC_PORT = String(environment.options.rpcPort);
process.env.GITSPACE_RPC_PORT = String(environment.options.rpcPort);
process.env.GITSPACE_HOST_WEB_PORT = new URL(environment.hostUrl).port;
process.env.GITSPACE_WEB_PORT = process.env.GITSPACE_HOST_WEB_PORT;
let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  relay?.stop();
  void environment
    .close()
    .then(async () => {
      const ready = await readJson<{ pid: number }>(join(environmentRoot, 'host-ready.json'));
      if (ready?.pid === process.pid) await rm(join(environmentRoot, 'host-ready.json'), { force: true });
      const pidPath = process.env.GITSPACE_MACHINE_PID_PATH;
      if (pidPath && Number(await readFile(pidPath, 'utf8').catch(() => '')) === process.pid)
        await rm(pidPath, { force: true });
      releaseLock();
      process.exit(0);
    })
    .catch((error) => {
      // A failed drain remains fenced: never exit and leave an untracked child writing the database.
      console.error('[gitspace-host] shutdown failed', error);
    });
};
let relay: MachineRelayConnector | null = null;
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const channelPath = existsSync(join(bundleRoot, 'machine')) ? join(bundleRoot, 'machine') : selection.path;
await environment.bootMachine(
  channelPath,
  channelPath === selection.path ? undefined : process.env.GITSPACE_INITIAL_MACHINE_MANIFEST_HASH,
  selection,
);
await environment.restoreFrontend();
if (!owner) await atomicJson(join(environmentRoot, 'host-selection.json'), selection);
const relayUrl = process.env.GITSPACE_RELAY_URL;
relay = relayUrl
  ? new MachineRelayConnector({
      relayUrl,
      machineId: requiredEnvironment('GITSPACE_MACHINE_ID'),
      machineGrant: signedCredentialAuthorityGrantSchema.parse(
        JSON.parse(requiredEnvironment('GITSPACE_MACHINE_GRANT')),
      ),
      signingPrivateKey: Uint8Array.from(
        Buffer.from(requiredEnvironment('GITSPACE_MACHINE_SIGNING_PRIVATE_KEY'), 'base64'),
      ),
      localOrigin: `http://${environment.options.rpcHost}:${environment.options.rpcPort}`,
      onError: (error) => console.error('[gitspace-relay]', error),
    })
  : null;
relay?.start();
const url = `http://${environment.options.rpcHost === '0.0.0.0' ? '127.0.0.1' : environment.options.rpcHost}:${environment.options.rpcPort}`;
await atomicJson(join(environmentRoot, 'host-ready.json'), { pid: process.pid, hash: selection.hash, url });
if (process.env.GITSPACE_MACHINE_PID_PATH) await atomicJson(process.env.GITSPACE_MACHINE_PID_PATH, process.pid);
console.log(
  `GitSpace host ready pid=${process.pid} rpc=${environment.options.rpcHost}:${environment.options.rpcPort} control=${environment.hostUrl} release=${environment.status().machineReleaseSha ?? 'channel'}`,
);
await Promise.withResolvers<never>().promise;
