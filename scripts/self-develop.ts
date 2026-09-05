import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, deviceCapabilitySchema, encodeDeviceInviteToken, signCredentialAuthorityGrant, signDeviceInvite } from '../packages/protocol/src/index.js';
import { Miniflare } from 'miniflare';
import { AuthStorage } from '@oh-my-pi/pi-ai';
import {
  buildFrontendTree,
  buildMachineBundle,
  buildOmpBundle,
  buildControlWorkerBundle,
  workspaceSha,
  type DeploymentArtifact,
} from '../packages/deployment/src/index.js';
import { ReplacementEnvironment } from '../packages/account-machine/src/index.js';
import { machineBrokerToken } from '../packages/operator-worker/src/account-access.js';
import { executableManifestPath } from '../packages/account-omp/src/manifest.js';

const repositoryRoot = dirname(import.meta.dir);
const environmentRoot = process.env.GITSPACE_SANDBOX_ROOT
  ?? join(repositoryRoot, '.gitspace', 'environments', 'self-sandbox');
const artifactKey = new Uint8Array(new Bun.CryptoHasher('sha256').update(environmentRoot).digest());
const rootSigningPrivateKey = new Uint8Array(new Bun.CryptoHasher('sha256').update(`${environmentRoot}:root-signing`).digest());
const machineSigningPrivateKey = new Uint8Array(new Bun.CryptoHasher('sha256').update(`${environmentRoot}:machine-signing`).digest());
const machineExchangePrivateKey = new Uint8Array(new Bun.CryptoHasher('sha256').update(`${environmentRoot}:machine-exchange`).digest());
const devBootstrapToken = crypto.randomUUID();
const ompBrokerToken = new Bun.CryptoHasher('sha256').update(`${environmentRoot}:omp-broker`).digest('hex');
const gitAccessKeyId = 'GITSPACELOCAL';
const gitBucketName = 'gsp-u-local-user';
const gitSecretAccessKey = new Bun.CryptoHasher('sha256').update(`${environmentRoot}:git-secret`).digest('hex');
const rustfsBinary = process.env.GITSPACE_RUSTFS_BINARY ?? join(environmentRoot, 'bin', 'rustfs');
const ompAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent');
const walgitBinary = process.env.GITSPACE_WALGIT_BINARY ?? join(environmentRoot, 'bin', 'walgit');
const controlUrl = 'http://127.0.0.1:4512';
const gitEndpoint = 'http://127.0.0.1:4513';
const controlToken = crypto.randomUUID();
const initialOmp = await buildOmpBundle(repositoryRoot, join(environmentRoot, 'initial-omp', crypto.randomUUID()));
const environment = new ReplacementEnvironment({
  id: 'self-sandbox',
  root: environmentRoot,
  repositoryRoot,
  rpcPort: 4511,
  webPort: 4510,
  machineId: 'local-machine',
  artifactKey,
  ompAgentDir,
  controlToken,
  environment: {
    GITSPACE_CONTROL_URL: controlUrl,
    OMP_AUTH_BROKER_URL: `${controlUrl}/omp/users/local-user`,
    OMP_AUTH_BROKER_TOKEN: await machineBrokerToken(ompBrokerToken, 'local-user', 'local-machine', 1),
    GITSPACE_OMP_RUNTIME_PATH: join(initialOmp.path, 'omp.js'),
    GITSPACE_OMP_MANIFEST_HASH: initialOmp.manifestHash,
    GITSPACE_USER_ID: 'local-user',
    GITSPACE_ROOT_PUBLIC_KEY: credentialProtocolBase64.encode(ed25519.getPublicKey(rootSigningPrivateKey)),
    GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: Buffer.from(machineSigningPrivateKey).toString('base64'),
    GITSPACE_GIT_ENDPOINT: gitEndpoint,
    GITSPACE_GIT_BUCKET: gitBucketName,
    GITSPACE_GIT_REGION: 'us-east-1',
    GITSPACE_GIT_ACCESS_KEY_ID: gitAccessKeyId,
    GITSPACE_GIT_SECRET_ACCESS_KEY: gitSecretAccessKey,
    GITSPACE_MANAGED_SPACE_ROOT: join(environmentRoot, 'managed'),
    GITSPACE_WALGIT_BINARY: walgitBinary,
    GITSPACE_SERVICE_DOMAIN: 'gssh.dev',
    GITSPACE_SERVICE_NAMESPACE: 'gitspace',
  },
  bootstrap: {
    projectId: 'project-a',
    projectName: 'GitSpace',
    repositoryPath: repositoryRoot,
    baseBranch: 'develop',
    workspaceId: 'workspace-a',
    workspaceName: 'agent-blame',
    workspaceBranch: 'develop',
    workspacePath: repositoryRoot,
  },
});

type EntrypointKind = 'machine' | 'omp' | 'frontend';

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

async function sourceDirectories(root: string): Promise<string[]> {
  const directories = [root];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) directories.push(...await sourceDirectories(join(root, entry.name)));
  }
  return directories;
}

async function waitForService(url: string, process: ReturnType<typeof Bun.spawn>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${label} exited with ${process.exitCode}`);
    try {
      await fetch(url);
      return;
    } catch {
      await Bun.sleep(100);
    }
  }
  throw new Error(`${label} did not become ready`);
}

async function createGitBucket(): Promise<void> {
  const client = new AwsClient({
    accessKeyId: gitAccessKeyId,
    secretAccessKey: gitSecretAccessKey,
    service: 's3',
    region: 'us-east-1',
  });
  const deadline = Date.now() + 30_000;
  let lastStatus = 0;
  while (Date.now() < deadline) {
    const request = await client.sign(new Request(`${gitEndpoint}/${gitBucketName}`, { method: 'PUT' }));
    const response = await fetch(request);
    if (response.ok || response.status === 409) return;
    lastStatus = response.status;
    if (response.status < 500) break;
    await Bun.sleep(100);
  }
  throw new Error(`RustFS Git bucket creation failed with ${lastStatus}`);
}

async function bootstrapDevelopmentControlPlane(): Promise<void> {
  const deviceGrant = signCredentialAuthorityGrant({
    version: 1,
    userId: 'local-user',
    machineId: 'local-machine',
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineSigningPrivateKey)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machineExchangePrivateKey)),
    capabilities: ['storage.access', 'space.control', 'credential.access', 'credential.manage'],
    generation: 1,
  }, rootSigningPrivateKey);
  const localAuth = await AuthStorage.create(join(ompAgentDir, 'agent.db'));
  await localAuth.reload();
  const credentials = ['anthropic', 'openai-codex', 'google-gemini-cli', 'google-antigravity', 'cursor']
    .flatMap((provider) => {
      const credential = localAuth.getOAuthCredential(provider);
      return credential ? [{ id: `${provider}-primary`, provider, ...credential }] : [];
    });
  localAuth.close();
  const response = await fetch(new URL('/__dev/bootstrap', controlUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${devBootstrapToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      userId: 'local-user',
      handle: 'local-user',
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootSigningPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(artifactKey),
      gitBucketName,
      deviceGrant,
      credentials,
    }),
  });
  if (!response.ok) throw new Error(`Development control bootstrap failed with ${response.status}: ${(await response.text()).slice(0, 1_024)}`);
}

await mkdir(environmentRoot, { recursive: true });
if (!existsSync(rustfsBinary)) throw new Error(`RustFS binary is required at ${rustfsBinary}; set GITSPACE_RUSTFS_BINARY`);
if (!existsSync(walgitBinary)) throw new Error(`walgit binary is required at ${walgitBinary}; set GITSPACE_WALGIT_BINARY`);
const rustfsData = join(environmentRoot, 'rustfs');
await mkdir(rustfsData, { recursive: true });
const rustfs = Bun.spawn([rustfsBinary, 'server', '--address', '127.0.0.1:4513', rustfsData], {
  cwd: environmentRoot,
  env: {
    ...processEnvironment(),
    RUSTFS_ACCESS_KEY: gitAccessKeyId,
    RUSTFS_SECRET_KEY: gitSecretAccessKey,
  },
  stdout: 'inherit',
  stderr: 'inherit',
});
await waitForService(gitEndpoint, rustfs, 'RustFS');
await createGitBucket();
const controlBundleRoot = join(environmentRoot, 'control-worker');
await rm(controlBundleRoot, { recursive: true, force: true });
await buildControlWorkerBundle(repositoryRoot, await workspaceSha(repositoryRoot), controlBundleRoot);
const control = new Miniflare({
  modules: true,
  scriptPath: join(controlBundleRoot, 'worker.mjs'),
  compatibilityDate: '2025-07-18',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    CREDENTIALS: { className: 'CredentialVaultDO', useSQLite: true },
    USER_STORAGE: { className: 'UserStorageDO', useSQLite: true },
    USER_SETTINGS: { className: 'UserSettingsDO', useSQLite: true },
    USER_HANDLES: { className: 'HandleRegistryDO', useSQLite: true },
    PROJECT_SECRETS: { className: 'ProjectSecretsDO', useSQLite: true },
    PROJECT_CRONS: { className: 'ProjectCronsDO', useSQLite: true },
    SPACE_CONTEXT: { className: 'SpaceContextDO', useSQLite: true },
    USER_SKILLS: { className: 'UserSkillsDO', useSQLite: true },
    USER_PROJECTS: { className: 'UserProjectIndexDO', useSQLite: true },
    PROJECT_AUTHORITY: { className: 'ProjectAuthorityDO', useSQLite: true },
    USER_MCP_CONNECTIONS: { className: 'UserMcpConnectionsDO', useSQLite: true },
    TENANT_RELEASES: { className: 'TenantReleasesDO', useSQLite: true },
    SPACE_AUTHORITY: { className: 'SpaceAuthorityDO', useSQLite: true },
    FLEET_CATALOG: { className: 'FleetCatalogDO', useSQLite: true },
  },
  r2Buckets: ['DATA'],
  bindings: {
    CF_ACCOUNT_ID: 'local',
    CF_API_TOKEN: 'local',
    R2_PARENT_ACCESS_KEY_ID: 'local',
    GITSPACE_DEV_BOOTSTRAP_TOKEN: devBootstrapToken,
    GITSPACE_OMP_BROKER_TOKEN: ompBrokerToken,
  },
  durableObjectsPersist: join(environmentRoot, 'miniflare', 'durable-objects'),
  r2Persist: join(environmentRoot, 'miniflare', 'r2'),
  host: '127.0.0.1',
  port: 4512,
});
await control.ready;
await bootstrapDevelopmentControlPlane();
let deploying = false;
const pending = new Set<EntrypointKind>();

async function deployPending(): Promise<void> {
  if (deploying) return;
  deploying = true;
  try {
    while (pending.size > 0) {
      const selected = new Set(pending);
      pending.clear();
      const candidates: string[] = [];
      const artifacts: DeploymentArtifact[] = [];
      try {
        if (selected.has('machine')) {
          const built = await buildMachineBundle(repositoryRoot, join(environmentRoot, 'candidates', `machine-${crypto.randomUUID()}`));
          candidates.push(built.path);
          artifacts.push({ entrypoint: 'machine-daemon', hash: built.hash, path: built.path, dependsOn: [] });
        }
        if (selected.has('frontend')) {
          const built = await buildFrontendTree(repositoryRoot, join(environmentRoot, 'candidates', `frontend-${crypto.randomUUID()}`));
          candidates.push(built.path);
          artifacts.push({ entrypoint: 'frontend', hash: built.hash, path: built.path, dependsOn: ['machine-daemon'] });
        }
        // Watcher builds are local channel candidates, independent of account release selections.
        if (artifacts.length > 0) {
          await environment.deploy({ artifacts, releaseSha: null, revision: String(Date.now()), dirty: true });
          const status = environment.status();
          console.log(`GitSpace self-sandbox active machine=${status.machineHash ?? 'none'} frontend=${status.frontendHash ?? 'none'}`);
        }
        if (selected.has('omp')) {
          const built = await buildOmpBundle(repositoryRoot, join(environmentRoot, 'candidates', `omp-${crypto.randomUUID()}`));
          const response = await fetch('http://127.0.0.1:4511/__control/omp-activate', {
            method: 'POST',
            headers: { authorization: `Bearer ${controlToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ path: built.path, hash: built.hash, manifestHash: built.manifestHash, sha: null }),
          });
          if (!response.ok) throw new Error(`OMP activation failed (${response.status}): ${await response.text()}`);
          console.log(`[gitspace-self-develop] OMP selected ${built.hash}: ${await response.text()}`);
        }
      } finally {
        for (const candidate of candidates) {
          await rm(candidate, { recursive: true, force: true });
          await rm(executableManifestPath(candidate), { force: true });
        }
      }
    }
  } finally {
    deploying = false;
    if (pending.size > 0) void deployPending().catch((error) => console.error('[gitspace-self-develop]', error));
  }
}

let deployTimer: ReturnType<typeof setTimeout> | undefined;
function schedule(kind: EntrypointKind): void {
  pending.add(kind);
  clearTimeout(deployTimer);
  deployTimer = setTimeout(() => {
    void deployPending().catch((error) => console.error('[gitspace-self-develop]', error));
  }, 150);
}

pending.add('machine');
pending.add('frontend');
await deployPending();

async function stopChild(process: ReturnType<typeof Bun.spawn>): Promise<void> {
  if (process.exitCode !== null) return;
  process.kill('SIGTERM');
  await process.exited;
}

// `GITSPACE_DEV_NO_WATCH=1` builds once and leaves replacement to launches:
// with the watcher on, every save re-stamps the running build, which hides
// what a launch actually swaps.
const watchers: FSWatcher[] = [];
if (process.env.GITSPACE_DEV_NO_WATCH !== '1') {
  for (const sourceRoot of [
    join(repositoryRoot, 'packages/core/src'),
    join(repositoryRoot, 'packages/account-machine/src'),
  ]) {
    for (const directory of await sourceDirectories(sourceRoot)) {
      watchers.push(watch(directory, () => schedule('machine')));
    }
  }
  for (const sourceRoot of [
    join(repositoryRoot, 'packages/account-omp/src'),
    join(repositoryRoot, 'packages/account-omp/patches'),
  ]) {
    for (const directory of await sourceDirectories(sourceRoot)) watchers.push(watch(directory, () => schedule('omp')));
  }
  for (const directory of await sourceDirectories(join(repositoryRoot, 'packages/protocol/src'))) {
    watchers.push(watch(directory, () => { schedule('machine'); schedule('omp'); }));
  }
  for (const directory of await sourceDirectories(join(repositoryRoot, 'packages/account-web/src'))) {
    watchers.push(watch(directory, () => schedule('frontend')));
  }
  for (const file of [join(repositoryRoot, 'packages/account-web/index.html'), join(repositoryRoot, 'packages/account-web/vite.config.ts')]) {
    watchers.push(watch(file, () => schedule('frontend')));
  }
}

// The dev script stands in for `gssh web`: it holds the root key, so it mints
// the one-time browser invite. Enrolled browsers persist across restarts in
// the vault; a fresh link is only needed for a new browser profile.
const browserInvite = signDeviceInvite({
  version: 1,
  userId: 'local-user',
  inviteId: crypto.randomUUID(),
  kind: 'browser',
  label: null,
  scope: { kind: 'user' },
  capabilities: deviceCapabilitySchema.options,
  canDelegate: true,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 24 * 60 * 60_000,
  grantTtlMs: null,
  enrollUrl: controlUrl,
}, rootSigningPrivateKey);
await Bun.write(join(environmentRoot, 'browser-enroll.txt'), `http://127.0.0.1:4510/?enroll=${encodeDeviceInviteToken(browserInvite)}\n`);
console.log('GitSpace self-sandbox ready at http://127.0.0.1:4510');
console.log(`Enroll a browser: http://127.0.0.1:4510/?enroll=${encodeDeviceInviteToken(browserInvite)}`);
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  clearTimeout(deployTimer);
  for (const watcher of watchers) watcher.close();
  await environment.close();
  await control.dispose();
  await stopChild(rustfs);
}
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
await new Promise(() => undefined);
