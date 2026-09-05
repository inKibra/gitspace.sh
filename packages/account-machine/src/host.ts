import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ReplacementEnvironment } from './replacement-environment.js';
import { signedCredentialAuthorityGrantSchema } from '@gitspace/protocol/credential-vault';
import { MachineRelayConnector } from './relay-connector.js';

/**
 * Production host: `bun host.js`. Restores the selected machine release, or
 * boots the adjacent `machine/` bundle for a fresh or channel-selected machine,
 * behind the RPC proxy. It swaps generations whenever a running machine asks
 * via `/__environment/launch` after downloading a release. Everything else in
 * the environment (`GITSPACE_CONTROL_URL`, keys, buckets) passes through to the
 * generations untouched.
 */

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

const environment = new ReplacementEnvironment({
  id: process.env.GITSPACE_ENVIRONMENT_ID ?? 'machine',
  root: environmentRoot,
  repositoryRoot: environmentRoot,
  rpcPort: Number(process.env.GITSPACE_RPC_PORT ?? 8081),
  rpcHost: process.env.GITSPACE_RPC_HOST ?? '127.0.0.1',
  webPort: Number(process.env.GITSPACE_WEB_PORT ?? 0),
  machineId: requiredEnvironment('GITSPACE_MACHINE_ID'),
  artifactKey,
  ompAgentDir: requiredEnvironment('GITSPACE_OMP_AGENT_DIR'),
  controlToken: process.env.GITSPACE_CONTROL_TOKEN ?? crypto.randomUUID(),
});

await environment.bootMachine(join(bundleRoot, 'machine'));
const relayUrl = process.env.GITSPACE_RELAY_URL;
const relay = relayUrl ? new MachineRelayConnector({
  relayUrl,
  machineId: requiredEnvironment('GITSPACE_MACHINE_ID'),
  machineGrant: signedCredentialAuthorityGrantSchema.parse(JSON.parse(requiredEnvironment('GITSPACE_MACHINE_GRANT'))),
  signingPrivateKey: Uint8Array.from(Buffer.from(requiredEnvironment('GITSPACE_MACHINE_SIGNING_PRIVATE_KEY'), 'base64')),
  localOrigin: `http://${environment.options.rpcHost}:${environment.options.rpcPort}`,
  onError: (error) => console.error('[gitspace-relay]', error),
}) : null;
relay?.start();
console.log(`GitSpace host ready rpc=${environment.options.rpcHost}:${environment.options.rpcPort} control=${environment.hostUrl} release=${environment.status().machineReleaseSha ?? 'channel'}`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  relay?.stop();
  void environment.close().finally(() => process.exit(0));
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
await Promise.withResolvers<never>().promise;
