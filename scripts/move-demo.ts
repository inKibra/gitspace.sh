import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, normalize } from 'node:path';
import { AwsClient } from 'aws4fetch';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { Miniflare } from 'miniflare';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '../packages/protocol/src/index.js';

const repositoryRoot = dirname(import.meta.dir);
const root = process.env.GITSPACE_MOVE_DEMO_ROOT ?? join(repositoryRoot, '.gitspace', 'environments', 'move-demo');
const rustfsBinary = process.env.GITSPACE_RUSTFS_BINARY ?? join(repositoryRoot, '.gitspace', 'environments', 'self-sandbox', 'bin', 'rustfs');
const walgitBinary = process.env.GITSPACE_WALGIT_BINARY ?? join(repositoryRoot, '.gitspace', 'environments', 'self-sandbox', 'bin', 'walgit');
const gitEndpoint = 'http://127.0.0.1:4513';
const controlUrl = 'http://127.0.0.1:4512';
const accessKeyId = 'GITSPACEDEMO';
const secretAccessKey = new Bun.CryptoHasher('sha256').update(`${root}:git-secret`).digest('hex');
const artifactKey = new Uint8Array(new Bun.CryptoHasher('sha256').update(`${root}:artifact-key`).digest());
const rootPrivateKey = new Uint8Array(new Bun.CryptoHasher('sha256').update(`${root}:root`).digest());
const bootstrapToken = crypto.randomUUID();
const ompBrokerToken = new Bun.CryptoHasher('sha256').update(`${root}:omp-broker`).digest('hex');
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function environment(extra: Record<string, string> = {}): Record<string, string> {
  return { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), ...extra };
}

async function waitFor(url: string, process: ReturnType<typeof Bun.spawn>, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`${label} exited with ${process.exitCode}`);
    try { if ((await fetch(url)).status < 500) return; } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`${label} did not become ready`);
}

async function createBucket(): Promise<void> {
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'us-east-1' });
  const response = await fetch(await client.sign(new Request(`${gitEndpoint}/gitspace-git`, { method: 'PUT' })));
  if (!response.ok && response.status !== 409) throw new Error(`Git bucket creation failed with ${response.status}`);
}

function machineKey(id: string, kind: 'signing' | 'exchange'): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher('sha256').update(`${root}:${id}:${kind}`).digest());
}

async function registerMachine(id: string): Promise<void> {
  const signing = machineKey(id, 'signing');
  const exchange = machineKey(id, 'exchange');
  const deviceGrant = signCredentialAuthorityGrant({
    version: 1,
    userId: 'demo-user',
    machineId: id,
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(signing)),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(exchange)),
    capabilities: ['storage.access', 'space.control'],
    generation: 1,
  }, rootPrivateKey);
  const response = await fetch(new URL('/__dev/bootstrap', controlUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${bootstrapToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'demo-user',
      rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivateKey)),
      vaultKey: credentialProtocolBase64.encode(artifactKey),
      deviceGrant,
    }),
  });
  if (!response.ok) throw new Error(`Machine ${id} registration failed: ${(await response.text()).slice(0, 512)}`);
}

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: environment({ GIT_AUTHOR_NAME: 'GitSpace Demo', GIT_AUTHOR_EMAIL: 'demo@gitspace.invalid', GIT_COMMITTER_NAME: 'GitSpace Demo', GIT_COMMITTER_EMAIL: 'demo@gitspace.invalid' }),
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

async function prepareFixture(): Promise<string> {
  const workspace = join(root, 'machines', 'machine-a', 'managed', 'demo-project', 'demo-space');
  await mkdir(workspace, { recursive: true });
  git(workspace, 'init', '-b', 'main');
  await writeFile(join(workspace, '.gitignore'), 'secret.env\n');
  await writeFile(join(workspace, 'README.md'), '# Portable workspace demo\n');
  await writeFile(join(workspace, 'tracked.txt'), 'base\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-m', 'demo base');
  await writeFile(join(workspace, 'staged.txt'), 'staged on machine A\n');
  git(workspace, 'add', 'staged.txt');
  await writeFile(join(workspace, 'tracked.txt'), 'modified on machine A\n');
  await writeFile(join(workspace, 'portable.txt'), 'untracked and portable\n');
  await writeFile(join(workspace, 'secret.env'), 'machine-a-only\n');
  return workspace;
}

async function buildMachine(): Promise<string> {
  const output = join(root, 'machine-artifact');
  await rm(output, { recursive: true, force: true });
  const built = await Bun.build({ entrypoints: [join(repositoryRoot, 'packages/machine/src/runtime.ts')], target: 'bun', outdir: output, naming: 'machine.js', external: ['@oh-my-pi/*', '@noble/*'], sourcemap: 'linked' });
  if (!built.success) throw new AggregateError(built.logs, 'Machine build failed');
  await cp(join(repositoryRoot, 'packages/core/drizzle'), join(output, 'drizzle'), { recursive: true });
  return output;
}

async function startMachine(input: { id: string; port: number; artifact: string; workspace?: string }): Promise<ReturnType<typeof Bun.spawn>> {
  const machineRoot = join(root, 'machines', input.id);
  const managedRoot = join(machineRoot, 'managed');
  await mkdir(managedRoot, { recursive: true });
  const child = Bun.spawn(['bun', join(input.artifact, 'machine.js')], {
    cwd: repositoryRoot,
    env: environment({
      GITSPACE_ENVIRONMENT_ROOT: machineRoot,
      GITSPACE_MACHINE_ID: input.id,
      GITSPACE_MACHINE_LABEL: input.id === 'machine-a' ? 'Machine A' : 'Machine B',
      GITSPACE_PUBLIC_RPC_URL: `/${input.id}/rpc`,
      GITSPACE_ARTIFACT_KEY: Buffer.from(artifactKey).toString('base64'),
      GITSPACE_OMP_AGENT_DIR: Bun.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.omp', 'agent'),
      GITSPACE_MIGRATIONS_FOLDER: join(input.artifact, 'drizzle'),
      GITSPACE_RPC_PORT: String(input.port),
      GITSPACE_CONTROL_URL: controlUrl,
      GITSPACE_USER_ID: 'demo-user',
      GITSPACE_MACHINE_SIGNING_PRIVATE_KEY: Buffer.from(machineKey(input.id, 'signing')).toString('base64'),
      GITSPACE_GIT_ENDPOINT: gitEndpoint,
      GITSPACE_GIT_BUCKET: 'gitspace-git',
      GITSPACE_GIT_REGION: 'us-east-1',
      GITSPACE_GIT_ACCESS_KEY_ID: accessKeyId,
      GITSPACE_GIT_SECRET_ACCESS_KEY: secretAccessKey,
      GITSPACE_WALGIT_BINARY: walgitBinary,
      GITSPACE_MANAGED_SPACE_ROOT: managedRoot,
      ...(input.workspace ? {
        GITSPACE_BOOTSTRAP_PROJECT_ID: 'demo-project',
        GITSPACE_BOOTSTRAP_PROJECT_NAME: 'Portable Demo',
        GITSPACE_BOOTSTRAP_REPOSITORY_PATH: join(managedRoot, 'demo-project', 'base'),
        GITSPACE_BOOTSTRAP_BASE_BRANCH: 'main',
        GITSPACE_BOOTSTRAP_WORKSPACE_ID: 'demo-space',
        GITSPACE_BOOTSTRAP_WORKSPACE_NAME: 'Move Me',
        GITSPACE_BOOTSTRAP_WORKSPACE_BRANCH: 'main',
        GITSPACE_BOOTSTRAP_WORKSPACE_PATH: input.workspace,
      } : {}),
    }),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  children.push(child);
  await waitFor(`http://127.0.0.1:${input.port}/health`, child, input.id);
  return child;
}

async function buildFrontend(): Promise<string> {
  const process = Bun.spawn(['bun', 'run', 'build'], { cwd: join(repositoryRoot, 'packages/web'), env: environment(), stdout: 'inherit', stderr: 'inherit' });
  if (await process.exited !== 0) throw new Error('Frontend build failed');
  return join(repositoryRoot, 'packages/web/dist');
}

await rm(root, { recursive: true, force: true });
await mkdir(root, { recursive: true });
if (!existsSync(rustfsBinary) || !existsSync(walgitBinary)) throw new Error('RustFS and walgit binaries are required; run the portable development setup first');
const rustfsData = join(root, 'rustfs');
await mkdir(rustfsData, { recursive: true });
const rustfs = Bun.spawn([rustfsBinary, 'server', '--address', '127.0.0.1:4513', rustfsData], { cwd: root, env: environment({ RUSTFS_ACCESS_KEY: accessKeyId, RUSTFS_SECRET_KEY: secretAccessKey }), stdout: 'inherit', stderr: 'inherit' });
children.push(rustfs);
await waitFor(gitEndpoint, rustfs, 'RustFS');
await createBucket();
const controlBundle = join(root, 'control-worker');
const controlBuild = await Bun.build({ entrypoints: [join(repositoryRoot, 'packages/auth-worker/src/index.ts')], target: 'browser', outdir: controlBundle, naming: 'worker.mjs', external: ['cloudflare:workers'] });
if (!controlBuild.success) throw new AggregateError(controlBuild.logs, 'Control Worker build failed');
const control = new Miniflare({
  modules: true,
  scriptPath: join(controlBundle, 'worker.mjs'),
  compatibilityDate: '2025-07-18',
  compatibilityFlags: ['nodejs_compat'],
  durableObjects: {
    CREDENTIALS: { className: 'CredentialVaultDO', useSQLite: true },
    USER_STORAGE: { className: 'UserStorageDO', useSQLite: true },
    SPACE_AUTHORITY: { className: 'SpaceAuthorityDO', useSQLite: true },
    FLEET_CATALOG: { className: 'FleetCatalogDO', useSQLite: true },
  },
  r2Buckets: ['DATA'],
  bindings: { CF_ACCOUNT_ID: 'local', CF_API_TOKEN: 'local', R2_PARENT_ACCESS_KEY_ID: 'local', GITSPACE_DEV_BOOTSTRAP_TOKEN: bootstrapToken, GITSPACE_OMP_BROKER_TOKEN: ompBrokerToken },
  durableObjectsPersist: join(root, 'control', 'durable-objects'),
  r2Persist: join(root, 'control', 'data-r2'),
  host: '127.0.0.1',
  port: 4512,
});
await control.ready;
await registerMachine('machine-a');
await registerMachine('machine-b');
const workspace = await prepareFixture();
const machineArtifact = await buildMachine();
const machineA = await startMachine({ id: 'machine-a', port: 4521, artifact: machineArtifact, workspace });
await startMachine({ id: 'machine-b', port: 4522, artifact: machineArtifact });
const frontendRoot = await buildFrontend();
const web = Bun.serve({
  hostname: '127.0.0.1',
  port: 4510,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__demo/delete-source' && request.method === 'POST') {
      if (machineA.exitCode === null) machineA.kill('SIGTERM');
      await machineA.exited;
      await rm(join(root, 'machines', 'machine-a'), { recursive: true, force: true });
      return Response.json({ deleted: true });
    }
    const machine = url.pathname.startsWith('/machine-b/') ? 4522 : 4521;
    if (url.pathname === '/rpc' || /^\/machine-[ab]\/rpc$/u.test(url.pathname)) {
      return fetch(new Request(`http://127.0.0.1:${machine}/rpc`, request));
    }
    const relative = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
    const candidate = Bun.file(join(frontendRoot, relative || 'index.html'));
    return await candidate.exists() ? new Response(candidate) : new Response(Bun.file(join(frontendRoot, 'index.html')));
  },
});

console.log('GitSpace move demo ready at http://127.0.0.1:4510/?project=demo-project&workspace=demo-space&machine=machine-a');
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await web.stop(true);
  for (const child of children.reverse()) {
    if (child.exitCode === null) child.kill('SIGTERM');
    await child.exited;
  }
  await control.dispose();
}
process.once('SIGINT', () => { void stop().finally(() => process.exit(0)); });
process.once('SIGTERM', () => { void stop().finally(() => process.exit(0)); });
await new Promise(() => undefined);
