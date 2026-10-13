import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { builtinModules, createRequire } from 'node:module';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { z } from 'zod';
import { transcriptPageSchema } from '../packages/blocks/src/index.js';
import { RuntimeGitCheckpointSchema, RuntimeSnapshotSchema, RuntimeSessionResultSchema } from '../packages/protocol-runtime/src/index.js';
import { artifactsWorkspaceRepository } from '../packages/runtime-workspace-do/src/artifacts';
import { credentialProtocolBase64, signCredentialAuthorityGrant, deriveArtifactScopeKey, encryptArtifactBytes, artifactManifestSchema, cloudProjectSummarySchema, cloudWorkspaceDefinitionSchema, type CloudWorkspaceDefinition } from '../packages/protocol/src/index.js';
import { collectBytes, spaceArtifactManifestKey, spaceCheckpointManifestKey, spaceOmpCheckpointKey, parseWorkspaceCheckpoint, GitLfsObjectSchema, parseGitLfsPointer } from '../packages/protocol-workspace/src/index.js';
import { EncryptedCheckpointBlobStore, type CheckpointBlobStore } from '../packages/account-machine/src/portable-space-lifecycle';
import { CloudDataCheckpointBlobStore } from '../packages/account-machine/src/cloud-space-authority';
import { createCloudGitLfsPublisher, createCloudGitLfsStore } from '../packages/account-machine/src/cloud-lfs-store';
import { LegacyMigrationPlanSchema, type LegacyMigrationPlan } from '../packages/account-machine/src/legacy-migration-client';
import { LegacySpaceMigrationReceiptSchema, type LegacySpaceMigrationReceipt } from '../packages/protocol/src/legacy-migration.js';
import { startLegacyMigrationGitBacking, type LegacyMigrationGitBacking } from './legacy-migration-git-backing';
import { openLegacySession } from '../packages/account-worker/src/legacy-checkpoint-reader.js';
import { readRuntimeTranscript } from '../packages/account-worker/src/runtime-transcript-reader.js';
import { restoreGitIntermediateCheckpoint } from '../packages/account-machine/src/git-checkpoint.js';

const immutableInputSchema = z.object({ plaintextPath: z.string(), plaintextHash: z.string(), plaintextSize: z.number().nonnegative(), ciphertextHash: z.string(), artifactPath: z.string().optional() });
type ImmutableInput = z.infer<typeof immutableInputSchema>;
const capturedInputsSchema = z.object({
  schemaVersion: z.literal(1), complete: z.literal(true), sourceCaptureRoot: z.string(),
  spaces: z.array(z.object({
    projectId: z.string(), workspaceId: z.string(), canonicalSessionId: z.string(), ompSessionId: z.string(), projectDefinitionPath: z.string(), workspaceDefinitionPath: z.string(),
    checkpointManifestPath: z.string(), sessionPath: z.string(), artifactManifestPath: z.string(), artifactEntriesPath: z.string().nullable(),
    sourcePlacement: z.object({ generation: z.number() }),
    sourceGit: z.object({ repositoryPath: z.string(), checkpointRef: z.string(), headCommit: z.string().nullable(), indexCommit: z.string(), worktreeCommit: z.string(), branch: z.string() }),
    lfsPayloads: z.array(GitLfsObjectSchema.extend({ path: z.string() })),
    expected: z.object({ history: z.object({ projectedEvents: z.number(), entries: z.number(), bytes: z.number() }), artifacts: z.object({ entries: z.number(), bytes: z.number() }) }),
    immutableObjects: z.object({ ompTranscript: immutableInputSchema, artifactScopeManifest: immutableInputSchema.nullable(), artifactBlobs: z.array(immutableInputSchema.extend({ chunked: z.boolean() })) }),
  })).length(21),
});
const artifactCheckpointSchema = z.object({ version: z.literal(2), scope: z.object({ id: z.string(), spaceId: z.string(), generation: z.number(), manifestHash: z.string().nullable(), dirty: z.union([z.boolean(), z.number()]).optional() }) });

process.umask(0o077);
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete process.env[name];
const inputPath = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: bun scripts/rehearse-legacy-migration.ts /protected/input/index.json');
const input = capturedInputsSchema.parse(JSON.parse(await readFile(inputPath, 'utf8')));
const root = await mkdtemp('/tmp/opdeploy/bradleat-real-rehearsal-');
const sourceRoot = resolve(import.meta.dir, '..');
const stamp = '0000000000000000000000000000000000000000';
const token = randomBytes(32).toString('hex');
const rootPrivate = ed25519.utils.randomSecretKey();
const machinePrivate = ed25519.utils.randomSecretKey();
const accountId = `u-${randomBytes(16).toString('hex')}`;
const machineId = `rehearsal-${crypto.randomUUID()}`;
const rootPublicKey = credentialProtocolBase64.encode(ed25519.getPublicKey(rootPrivate));
const grant = signCredentialAuthorityGrant({ version: 1, userId: accountId, machineId, signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machinePrivate)), exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(machinePrivate)), capabilities: ['space.control', 'storage.access'], generation: 1 }, rootPrivate);
const digest = (bytes: Uint8Array): `sha256:${string}` => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
let stage = 'setup';
let modelCalls = 0;
let historicalModelMessages = 0;
let allowModel = false;
const network: Record<string, number> = {};
const evidence: Record<string, unknown> = { inputPath, accountId, productionWrites: false, originalSourceWrites: false, actualGitBacking: true, actualWorkerDurableObjects: true, realSpaces: 21, generationMappings: [], verification: [] };
console.log(JSON.stringify({ stage, root }));

async function command(args: string[], name: string, env: Record<string, string> = {}) {
  const child = Bun.spawn(args, { cwd: sourceRoot, env: { ...process.env, ...env }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await writeFile(join(root, `${name}.stdout`), stdout, { mode: 0o600 });
  await writeFile(join(root, `${name}.stderr`), stderr, { mode: 0o600 });
  if (code !== 0) throw new Error(`${name} failed (${code}); diagnostics retained privately`);
  return stdout;
}

await command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'git.key'), '-out', join(root, 'git.crt'), '-subj', '/CN=legacy-migration-git.invalid', '-days', '1'], 'isolated-certificate');
let gitBacking: LegacyMigrationGitBacking;
const tls = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: Bun.file(join(root, 'git.key')), cert: Bun.file(join(root, 'git.crt')) }, fetch: request => gitBacking.fetch(request) });
gitBacking = await startLegacyMigrationGitBacking({ root: join(root, 'repositories'), origin: `https://legacy-migration-git.invalid:${tls.port}` });
const gitConfig = join(root, 'git.config');
await writeFile(gitConfig, `[http "${gitBacking.origin}/"]\n\tsslVerify = false\n\tcurloptResolve = legacy-migration-git.invalid:${tls.port}:127.0.0.1\n`, { mode: 0o600 });
Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_TERMINAL_PROMPT: '0' });
const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(null, { status: 503 }) });
const port = portProbe.port;
portProbe.stop(true);
const accountUrl = `http://127.0.0.1:${port}`;
const mfRequire = createRequire(import.meta.resolve('wrangler'));
const { Miniflare, Response: MiniflareResponse, Log, LogLevel } = mfRequire('miniflare');
const wrangler = z.object({
  compatibility_date: z.string(), compatibility_flags: z.array(z.string()), vars: z.record(z.string(), z.json()),
  durable_objects: z.object({ bindings: z.array(z.object({ name: z.string(), class_name: z.string() })) }),
}).parse(JSON.parse(await readFile(join(sourceRoot, 'packages/account-worker/wrangler.jsonc'), 'utf8')));
await mkdir(join(root, 'build'));
const nodeBuiltinPattern = new RegExp(`^(?:${builtinModules.filter(name => !name.startsWith('node:')).map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
async function buildRehearsalWorker(entrypoint: string) {
  const modules: Record<string, { type: 'esm'; contents: string } | { type: 'wasm'; contents: Uint8Array }> = {};
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, entrypoint)],
    outdir: join(root, 'build'), target: 'browser', format: 'esm', external: ['cloudflare:*', 'node:*'],
    conditions: ['workerd'],
    banner: "import { createRequire as __gitspaceCreateRequire } from 'node:module';\nconst require = __gitspaceCreateRequire('/worker.js');",
    define: { GITSPACE_WORKER_SHA: JSON.stringify(stamp) }, sourcemap: 'external',
    plugins: [{ name: 'cloudflare-node-builtins', setup(builder) {
      builder.onResolve({ filter: nodeBuiltinPattern }, ({ path }) => ({ path: `node:${path}`, external: true }));
    } }, { name: 'static-worker-wasm', setup(builder) {
      builder.onResolve({ filter: /\.wasm$/ }, async args => {
        const name = basename(args.path);
        if (args.path !== name && args.path !== `./${name}`) throw new Error('Worker WASM imports must use a sibling module name');
        const contents = new Uint8Array(await readFile(resolve(dirname(args.importer), args.path)));
        const previous = modules[name];
        if (previous && (previous.type !== 'wasm' || !Buffer.from(previous.contents).equals(contents))) throw new Error('Conflicting Worker WASM module name');
        modules[name] = { type: 'wasm', contents };
        return { path: `./${name}`, external: true };
      });
    } }],
  });
  if (!build.success) { await writeFile(join(root, 'build-errors.json'), JSON.stringify(build.logs.map(log => String(log)))); throw new Error('Isolated Worker bundle failed; private build diagnostics retained'); }
  modules['worker.js'] = { type: 'esm', contents: await readFile(join(root, 'build', `${basename(entrypoint, '.ts')}.js`), 'utf8') };
  return { mainModule: 'worker.js', modules };
}

async function outbound(request: Request) {
  const url = new URL(request.url);
  network[url.origin] = (network[url.origin] ?? 0) + 1;
  let response: Response;
  if (url.origin === gitBacking.origin) response = await gitBacking.fetch(new Request(request.url, { method: request.method, headers: request.headers, ...(request.body ? { body: request.body, duplex: 'half' } : {}) }));
  else if (url.origin === 'https://rehearsal-platform.invalid' && url.pathname.endsWith('/state')) response = Response.json({ control: { status: 'active' }, deployment: { active: stamp } });
  else if (url.origin === 'https://rehearsal-model.invalid' && allowModel) {
    const payload = z.object({ messages: z.array(z.object({ role: z.string() })) }).parse(await request.json());
    modelCalls++;
    historicalModelMessages += payload.messages.filter(message => message.role === 'assistant' || message.role === 'tool').length;
    const base = { id: 'isolated-turn', object: 'chat.completion.chunk', created: 1, model: 'migration-proof' };
    response = new Response(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Isolated migration turn completed.' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } else throw new Error(`Isolated rehearsal blocked outbound origin ${url.origin}`);
  return new MiniflareResponse(response.body, { status: response.status, headers: response.headers });
}
const accountBindings = { ...wrangler.vars, ACCOUNT_ID: accountId, AUTH_PUBLIC_KEY: rootPublicKey, TENANT_ID: 'isolated-rehearsal', RELAY_NAME: accountId, ACCOUNT_URL: accountUrl, RELAY_URL: accountUrl, PLATFORM_URL: 'https://rehearsal-platform.invalid', PLATFORM_TOKEN: 'isolated-platform-only', REHEARSAL_ONLY: 'local-no-production', REHEARSAL_TOKEN: token };
const options = {
  host: '127.0.0.1', port, log: new Log(LogLevel.ERROR), cf: false, telemetry: { enabled: false },
  resourcePersistencePath: join(root, 'state'), isolatedResourcePersistencePath: join(root, 'isolated-state'),
  resourceTmpPath: join(root, 'temporary'), unsafeDevRegistryPath: join(root, 'dev-registry'),
  workers: [
    { config: {
      name: 'account', compatibilityDate: wrangler.compatibility_date, compatibilityFlags: wrangler.compatibility_flags,
      manifest: await buildRehearsalWorker('legacy-migration-rehearsal-worker.ts'),
      exports: Object.fromEntries(wrangler.durable_objects.bindings.map(binding => [binding.class_name, { type: 'durable-object', storage: 'sqlite' }])),
      env: {
        ...Object.fromEntries(Object.entries(accountBindings).map(([name, value]) => [name, { type: 'json', value }])),
        ...Object.fromEntries(wrangler.durable_objects.bindings.map(binding => [binding.name, { type: 'durable-object', worker: 'account', exportName: binding.class_name }])),
        DATA: { type: 'r2', name: 'isolated-data' }, BLOBS: { type: 'r2', name: 'isolated-data' },
        ARTIFACTS: { type: 'worker', worker: 'artifacts', exportName: 'LegacyMigrationArtifactsService' },
        ASSETS: { type: 'fetcher', handler: () => new MiniflareResponse(null, { status: 404 }) },
      },
    }, dev: { outboundService: { type: 'fetcher', handler: outbound } } },
    { config: {
      name: 'artifacts', compatibilityDate: wrangler.compatibility_date, compatibilityFlags: ['nodejs_compat'],
      manifest: await buildRehearsalWorker('legacy-migration-artifacts-service.ts'),
      exports: { LegacyMigrationArtifactsService: { type: 'worker' } },
      env: { LEGACY_GIT_ORIGIN: { type: 'text', value: gitBacking.origin }, LEGACY_GIT_CONTROL_TOKEN: { type: 'text', value: gitBacking.controlToken } },
    }, dev: { outboundService: { type: 'fetcher', handler: outbound } } },
  ],
};
let mf = new Miniflare(options);

async function fixture(path: string, input: unknown): Promise<unknown> {
  const response = await fetch(`${accountUrl}/__rehearsal/${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  if (!response.ok) { await writeFile(join(root, `fixture-error-${crypto.randomUUID()}.txt`), await response.text()); throw new Error(`Isolated fixture ${path} failed (${response.status})`); }
  const { value } = z.object({ value: z.unknown() }).parse(await response.json());
  if (value && typeof value === 'object' && 'status' in value) {
    if (value.status === 'error') { await writeFile(join(root, `owner-error-${crypto.randomUUID()}.json`), JSON.stringify(value)); throw new Error('Isolated owning API rejected fixture input'); }
    if (value.status === 'ok') return z.object({ value: z.unknown().optional() }).parse(value).value;
  }
  return value;
}
async function rpc(binding: string, id: string | null, method: string, ...args: unknown[]) {
  return fixture('rpc', { binding, name: id === null ? accountId : `${accountId}:${id}`, method, args });
}
async function* verifiedFile(object: ImmutableInput) {
  const hash = createHash('sha256'); let size = 0;
  for await (const bytes of createReadStream(object.plaintextPath)) { hash.update(bytes); size += bytes.length; yield bytes; }
  if (`sha256:${hash.digest('hex')}` !== object.plaintextHash || size !== object.plaintextSize) throw new Error('Captured plaintext failed integrity verification');
}

try {
  await mf.ready;
  stage = 'verifying-isolated-git-transport'; console.log(JSON.stringify({ stage }));
  const initialRepositories = z.object({ total: z.number().int().nonnegative() }).parse(await fixture('git-transport', {}));
  if (initialRepositories.total !== 0) throw new Error('Isolated Git owner was not empty at startup');
  stage = 'seeding-isolated-owners'; console.log(JSON.stringify({ stage }));
  await rpc('CREDENTIALS', null, 'bootstrap', { userId: accountId, rootPublicKey, vaultKey: credentialProtocolBase64.encode(randomBytes(32)) });
  await rpc('CREDENTIALS', null, 'registerDevice', grant);
  const settings = z.object({ revision: z.number() }).parse(await rpc('USER_SETTINGS', null, 'get', machineId));
  await rpc('USER_SETTINGS', null, 'setHandle', machineId, settings.revision, 'isolated-bradleat');
  const key = credentialProtocolBase64.decode(z.string().parse(await rpc('CREDENTIALS', null, 'artifactKey', accountId)));
  const bucket = await mf.getR2Bucket('DATA', 'account');
  const blobs: CheckpointBlobStore = {
    async put(path, bytes) { await bucket.put(`users/${accountId}/${path}`, bytes); return digest(bytes); },
    async get(path, expectedHash) { const object = await bucket.get(`users/${accountId}/${path}`); if (!object) return null; const bytes = new Uint8Array(await object.arrayBuffer()); if (expectedHash && digest(bytes) !== expectedHash) throw new Error('Isolated R2 integrity mismatch'); return bytes; },
  };
  const checkpointStore = new EncryptedCheckpointBlobStore(blobs, key);
  const projects = new Set<string>();
  const workspaceDefinitions = new Map<string, CloudWorkspaceDefinition>();
  for (const space of input.spaces) {
    if (!projects.has(space.projectId)) {
      const original = cloudProjectSummarySchema.parse(JSON.parse(await readFile(space.projectDefinitionPath, 'utf8')));
      let project = cloudProjectSummarySchema.parse(original.role === 'gitspace-source'
        ? await rpc('PROJECT_AUTHORITY', space.projectId, 'ensureGitSpaceProject', original)
        : await rpc('PROJECT_AUTHORITY', space.projectId, 'bootstrap', { id: original.id, name: original.name, repositoryReference: original.repositoryReference, baseBranch: original.baseBranch, createdBy: machineId }));
      project = cloudProjectSummarySchema.parse(await rpc('PROJECT_AUTHORITY', space.projectId, 'setProjectLifecycle', project.revision, original.lifecycle));
      await rpc('USER_PROJECTS', null, 'put', project);
      projects.add(space.projectId);
    }
    const original = cloudWorkspaceDefinitionSchema.parse(JSON.parse(await readFile(space.workspaceDefinitionPath, 'utf8')));
    const { revision: _revision, createdAt: _createdAt, updatedAt: _updatedAt, archivedAt: _archivedAt, ...definition } = original;
    const existing = z.array(cloudWorkspaceDefinitionSchema).parse(await rpc('PROJECT_AUTHORITY', space.projectId, 'listWorkspaces')).find(workspace => workspace.id === original.id);
    workspaceDefinitions.set(space.workspaceId, cloudWorkspaceDefinitionSchema.parse(await rpc('PROJECT_AUTHORITY', space.projectId, 'putWorkspace', { ...definition, expectedRevision: existing?.revision ?? 0 })));
  }
  await rpc('CREDENTIALS', null, 'ensureInference');
  await rpc('CREDENTIALS', null, 'updateInferenceProfile', { profileId: 'default', expectedRevision: 0, name: 'Default', settings: { 'modelRoles.default': 'openai-codex/gpt-6-astra' } });
  await rpc('CREDENTIALS', null, 'cloudSetApiKey', { profileId: 'default', providerId: 'anthropic', key: 'isolated-not-production' });
  const inferenceBefore = await rpc('CREDENTIALS', null, 'ensureInference');
  const credentialsBefore = await rpc('CREDENTIALS', null, 'cloudCredentialAccounts', 'default');
  const controlOptions = { baseUrl: accountUrl, userId: accountId, machineId, signingPrivateKey: machinePrivate };
  const cloudBlobs = new CloudDataCheckpointBlobStore(controlOptions);
  const seededLfs = new Set<string>();
  for (const space of input.spaces) {
    const publisher = await createCloudGitLfsPublisher({ projectId: space.projectId, publicationId: 'isolated-source', blobs: cloudBlobs, encryptionKey: key, controlOptions });
    for (const object of space.lfsPayloads) {
      const id = `${space.projectId}:${object.oid}`;
      if (seededLfs.has(id)) continue;
      await publisher.put({ oid: object.oid, size: object.size }, createReadStream(object.path)); seededLfs.add(id);
    }
  }
  const planSpaces: LegacyMigrationPlan['spaces'] = [];
  const artifactObjects = new Map<string, string>();
  const artifactDownloads: { projectId: string; workspaceId: string; path: string; hash: string; plaintextHash: string; size: number }[] = [];
  for (const space of input.spaces) {
    stage = `seeding:${space.workspaceId}`; console.log(JSON.stringify({ stage }));
    const manifest = parseWorkspaceCheckpoint(JSON.parse(await readFile(space.checkpointManifestPath, 'utf8')));
    if (manifest.agent.kind !== 'legacy') throw new Error('Real input must be an OMP checkpoint');
    const scopeCheckpoint = artifactCheckpointSchema.parse(JSON.parse(await readFile(space.artifactManifestPath, 'utf8')));
    const scopeKey = await deriveArtifactScopeKey(key, scopeCheckpoint.scope.id);
    const artifactPrefix = `accounts/${Buffer.from(accountId).toString('base64url')}/artifacts/sha256/`;
    const artifactStore = new EncryptedCheckpointBlobStore({
      async put(_path, bytes) { const hash = digest(bytes); await blobs.put(`${artifactPrefix}${hash.slice(7)}`, bytes); return hash; },
      async get(_path, hash) { if (!hash) throw new Error('Artifact reads require an immutable ciphertext hash'); return blobs.get(`${artifactPrefix}${hash.slice(7)}`, hash); },
    }, scopeKey);
    const remapped = new Map<string, string>();
    for (const object of space.immutableObjects.artifactBlobs) {
      const identity = `${scopeCheckpoint.scope.id}:${object.plaintextHash}:${object.chunked ? 'chunked' : 'single'}`;
      let hash = artifactObjects.get(identity);
      if (!hash) {
        if (object.chunked) hash = await artifactStore.putStream('artifact', verifiedFile(object), object.plaintextSize);
        else {
          const sealed = await encryptArtifactBytes(await collectBytes(verifiedFile(object), object.plaintextSize), scopeKey);
          hash = digest(sealed);
          await blobs.put(`${artifactPrefix}${hash.slice(7)}`, sealed);
        }
        artifactObjects.set(identity, hash);
      }
      remapped.set(object.ciphertextHash, hash);
      if (!object.artifactPath) throw new Error('An artifact download lacks its original path');
      artifactDownloads.push({ projectId: space.projectId, workspaceId: space.workspaceId, path: object.artifactPath, hash, plaintextHash: object.plaintextHash, size: object.plaintextSize });
    }
    if (space.immutableObjects.artifactScopeManifest) {
      if (!space.artifactEntriesPath) throw new Error('Captured artifact manifest lacks its entries inventory');
      const entries = artifactManifestSchema.parse(JSON.parse(await readFile(space.artifactEntriesPath, 'utf8')));
      for (const entry of entries.entries) { const hash = remapped.get(entry.blobHash); if (!hash) throw new Error('An artifact entry lacks verified retained bytes'); entry.blobHash = hash as `sha256:${string}`; }
      scopeCheckpoint.scope.manifestHash = await artifactStore.put('manifest', new TextEncoder().encode(JSON.stringify(entries)));
    }
    scopeCheckpoint.scope.dirty = false;
    manifest.agent.ompCheckpointHash = await checkpointStore.putStream(spaceOmpCheckpointKey(space.projectId, space.workspaceId, manifest.revision), verifiedFile(space.immutableObjects.ompTranscript), space.immutableObjects.ompTranscript.plaintextSize);
    manifest.artifacts.manifestHash = await checkpointStore.put(spaceArtifactManifestKey(space.projectId, space.workspaceId, manifest.revision, manifest.artifacts.generation), new TextEncoder().encode(JSON.stringify(scopeCheckpoint)));
    const manifestKey = spaceCheckpointManifestKey(space.projectId, space.workspaceId, manifest.revision);
    const manifestHash = await checkpointStore.put(manifestKey, new TextEncoder().encode(JSON.stringify(manifest)));
    await rpc('PROJECT_AUTHORITY', space.projectId, 'putArtifactScope', { id: scopeCheckpoint.scope.id, workspaceId: space.workspaceId, generation: scopeCheckpoint.scope.generation, manifestHash: scopeCheckpoint.scope.manifestHash, expectedGeneration: 0 });
    const holder = { projectId: space.projectId, spaceId: space.workspaceId, machineId, expectedGeneration: 1 };
    await rpc('SPACE_AUTHORITY', space.workspaceId, 'bootstrap', { projectId: space.projectId, spaceId: space.workspaceId, machineId });
    for (let revision = 1; revision <= manifest.revision; revision++) {
      const closing = z.object({ revision: z.number() }).parse(await rpc('SPACE_AUTHORITY', space.workspaceId, 'beginClose', holder));
      if (closing.revision !== revision) throw new Error('Isolated checkpoint revision diverged');
      if (revision < manifest.revision) await rpc('SPACE_AUTHORITY', space.workspaceId, 'abortClose', { ...holder, revision, message: 'Isolated predecessor revision; original source is unchanged' });
      else await rpc('SPACE_AUTHORITY', space.workspaceId, 'commitClosed', { ...holder, revision, manifestKey, manifestHash });
    }
    const placement = z.object({ generation: z.number() }).parse(await rpc('SPACE_AUTHORITY', space.workspaceId, 'get'));
    (evidence.generationMappings as unknown[]).push({ workspaceId: space.workspaceId, originalGeneration: space.sourcePlacement.generation, isolatedGeneration: placement.generation, originalRevision: manifest.revision, isolatedManifestHash: manifestHash });
    planSpaces.push({ operationId: crypto.randomUUID(), projectId: space.projectId, workspaceId: space.workspaceId, expectedGeneration: placement.generation, expectedManifestHash: manifestHash, repositoryPath: space.sourceGit.repositoryPath, lfsRoots: [...new Set(space.lfsPayloads.map(object => dirname(object.path))), join(input.sourceCaptureRoot, 'retrieval/lfs-objects')], submoduleRepositories: [join(input.sourceCaptureRoot, 'retrieval/submodule-all-refs.bundle')] });
    scopeKey.fill(0);
  }
  const plan = LegacyMigrationPlanSchema.parse({ version: 1, accountId, accountUrl, spaces: planSpaces });
  const planPath = join(root, 'plan.json');
  await writeFile(planPath, JSON.stringify(plan, null, 2), { mode: 0o600 });
  const configRoot = join(root, 'machine-config'); await mkdir(configRoot);
  await writeFile(join(configRoot, 'config.json'), JSON.stringify({ version: 4, apiUrl: accountUrl, accountUrl, relayUrl: accountUrl, userId: accountId, rootPublicKey, handle: 'isolated-bradleat', machine: { id: machineId, label: 'Isolated rehearsal', signingPrivateKey: credentialProtocolBase64.encode(machinePrivate), exchangePrivateKey: credentialProtocolBase64.encode(machinePrivate), grant } }), { mode: 0o600 });
  const cliEnvironment = { GITSPACE_CONFIG_HOME: configRoot, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', HTTPS_PROXY: '', HTTP_PROXY: '', ALL_PROXY: '', https_proxy: '', http_proxy: '', all_proxy: '' };
  const cli = [process.execPath, join(sourceRoot, 'packages/cli/src/index.ts'), 'machine', 'migrate', '--plan', planPath, '--receipts', join(root, 'receipts')];
  const recordless = input.spaces.find(space => space.workspaceId === 'recordless-web-cloudflare-containers-eb16b1ed')!;
  stage = 'recordless-cold-saved-index'; console.log(JSON.stringify({ stage }));
  const coldPage = transcriptPageSchema.parse(await fixture('transcript', { projectId: recordless.projectId, workspaceId: recordless.workspaceId, request: { generation: null, before: null, after: null, around: null, executionId: null } }));
  evidence.recordlessSavedIndex = { generation: coldPage.generation, rows: coldPage.rows.length, plaintextBytes: recordless.expected.history.bytes };
  stage = 'cli-read-only-preflight'; console.log(JSON.stringify({ stage }));
  await command(cli, 'preflight', cliEnvironment);
  for (const space of input.spaces) if (z.boolean().parse(await rpc('SPACE_AUTHORITY', space.workspaceId, 'hasCloudRuntime'))) throw new Error('Read-only preflight activated a runtime');
  if ((await readdir(gitBacking.root)).length !== 0) throw new Error('Read-only preflight created an Artifacts repository');
  stage = 'cli-apply'; console.log(JSON.stringify({ stage }));
  await command([...cli, '--apply'], 'apply', cliEnvironment);
  stage = 'cli-idempotent-retry'; console.log(JSON.stringify({ stage }));
  await command([...cli, '--apply'], 'retry', cliEnvironment);
  const receipts: LegacySpaceMigrationReceipt[] = [];
  for (const item of plan.spaces) {
    const receipt = LegacySpaceMigrationReceiptSchema.parse(JSON.parse(await readFile(join(root, 'receipts', `${encodeURIComponent(item.workspaceId)}-${item.operationId}.json`), 'utf8')));
    const original = input.spaces.find(space => space.workspaceId === item.workspaceId)!;
    if (receipt.importedEvents !== original.expected.history.projectedEvents) throw new Error('Imported history event count differs from the verified source');
    receipts.push(receipt);
  }
  stage = 'historical-lfs-after-release'; console.log(JSON.stringify({ stage }));
  for (const projectId of projects) {
    const options = { projectId, blobs: cloudBlobs, encryptionKey: key, controlOptions };
    const publisher = await createCloudGitLfsPublisher({ ...options, publicationId: 'isolated-source' });
    await publisher.releasePublication();
    const reader = await createCloudGitLfsStore(options);
    const objects = new Map(input.spaces.filter(space => space.projectId === projectId).flatMap(space => space.lfsPayloads).map(object => [object.oid, object]));
    for (const object of objects.values()) if (!await reader.has(object)) throw new Error('Historical LFS payload was lost after publication release');
  }
  evidence.historicalLfsAfterPublicationRelease = seededLfs.size;
  if (JSON.stringify(await rpc('CREDENTIALS', null, 'ensureInference')) !== JSON.stringify(inferenceBefore) || JSON.stringify(await rpc('CREDENTIALS', null, 'cloudCredentialAccounts', 'default')) !== JSON.stringify(credentialsBefore)) throw new Error('Passive migration changed inference ownership');
  evidence.inferencePreserved = true;
  await mf.dispose(); mf = new Miniflare(options); await mf.ready;
  stage = 'cold-runtime-readback'; console.log(JSON.stringify({ stage }));
  for (const receipt of receipts) {
    const original = input.spaces.find(space => space.workspaceId === receipt.source.workspaceId)!;
    const identity = { projectId: original.projectId, workspaceId: original.workspaceId };
    const checkpoint = RuntimeGitCheckpointSchema.parse(await rpc('SPACE_AUTHORITY', original.workspaceId, 'runtimeCodeCheckpoint', identity));
    for (const name of ['headCommit', 'indexCommit', 'worktreeCommit', 'branch'] as const) if (checkpoint[name] !== original.sourceGit[name]) throw new Error(`Restored code identity differs at ${name}`);
    const snapshot = RuntimeSnapshotSchema.parse(await rpc('SPACE_AUTHORITY', original.workspaceId, 'runtimeSnapshot', identity));
    const page = transcriptPageSchema.parse(await fixture('transcript', { ...identity, request: { generation: null, before: null, after: null, around: null, executionId: null } }));
    const definitions = z.array(cloudWorkspaceDefinitionSchema).parse(await rpc('PROJECT_AUTHORITY', original.projectId, 'listWorkspaces'));
    const definition = definitions.find(item => item.id === original.workspaceId);
    if (!definition || definition.lifecycle !== workspaceDefinitions.get(original.workspaceId)?.lifecycle) throw new Error('Migration changed workspace lifecycle');
    await command(['git', `--git-dir=${gitBacking.repositoryPath(artifactsWorkspaceRepository(original.workspaceId))}`, 'fsck', '--full', '--strict'], `fsck-${original.workspaceId}`);
    const shallow = (await command(['git', `--git-dir=${gitBacking.repositoryPath(artifactsWorkspaceRepository(original.workspaceId))}`, 'rev-parse', '--is-shallow-repository'], `shallow-${original.workspaceId}`)).trim() === 'true';
    const checkout = join(root, `checkout-${encodeURIComponent(original.workspaceId)}`);
    await mkdir(checkout);
    await command(['git', '-C', checkout, 'init'], `checkout-init-${original.workspaceId}`);
    await command(['git', '-C', checkout, 'fetch', '--update-shallow', '--no-tags', gitBacking.repositoryPath(artifactsWorkspaceRepository(original.workspaceId)), `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`], `checkout-fetch-${original.workspaceId}`);
    const lfs = await createCloudGitLfsStore({ projectId: original.projectId, blobs: cloudBlobs, encryptionKey: key, controlOptions });
    await restoreGitIntermediateCheckpoint({ repositoryPath: checkout, checkpoint, branch: checkpoint.branch, lfs: { store: lfs, originEnvironment: async () => { throw new Error('Isolated restore must not contact an external LFS origin'); } } });
    if ((await command(['git', '-C', checkout, 'write-tree'], `checkout-index-${original.workspaceId}`)).trim() !== checkpoint.indexTree) throw new Error('Restored checkout index changed');
    const checkIndex = join(root, `verify-index-${encodeURIComponent(original.workspaceId)}`);
    await command(['git', '-C', checkout, 'read-tree', checkpoint.worktreeCommit], `checkout-tree-${original.workspaceId}`, { GIT_INDEX_FILE: checkIndex });
    const differences = (await command(['git', '-C', checkout, '-c', 'filter.lfs.process=', '-c', 'filter.lfs.clean=cat', '-c', 'filter.lfs.required=false', 'diff', '--raw', '--no-abbrev', '-z', '--no-renames', '--no-ext-diff', '--ignore-submodules=all', '--'], `checkout-files-${original.workspaceId}`, { GIT_INDEX_FILE: checkIndex })).split('\0').filter(Boolean);
    for (let index = 0; index < differences.length; index += 2) {
      const header = /^:(\d+) (\d+) ([a-f0-9]{40}) [a-f0-9]{40} M$/u.exec(differences[index]!);
      const path = differences[index + 1];
      if (!header || header[1] !== header[2] || !path) throw new Error('Cold worktree changed path or mode');
      const pointer = parseGitLfsPointer(new TextEncoder().encode(await command(['git', '-C', checkout, 'cat-file', 'blob', header[3]!], `checkout-pointer-${original.workspaceId}-${index}`)));
      if (!pointer) throw new Error(`Cold worktree changed non-LFS file: ${path}`);
      let size = 0; const hasher = createHash('sha256');
      for await (const bytes of createReadStream(join(checkout, path))) { size += bytes.length; hasher.update(bytes); }
      if (size !== pointer.size || hasher.digest('hex') !== pointer.oid) throw new Error(`Cold LFS payload changed: ${path}`);
    }
    const status = (await command(['git', '-C', checkout, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], `checkout-status-${original.workspaceId}`)).split('\0');
    let trackedChanges = 0; let untrackedFiles = 0;
    for (let index = 0; index < status.length; index++) {
      const row = status[index]!;
      if (!row) continue;
      if (row.startsWith('??')) untrackedFiles++;
      else { trackedChanges++; if (/[RC]/u.test(row.slice(0, 2))) index++; }
    }
    (evidence.verification as unknown[]).push({ workspaceId: original.workspaceId, nativeCheckout: true, shallow, indexExact: true, worktreeExact: true, trackedChanges, untrackedFiles, lfsFromIsolatedCloud: true });
    await rm(checkout, { recursive: true }); await rm(checkIndex);
    const exported = await mf.dispatchFetch(`${accountUrl}/__rehearsal/export`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ ...identity, conversationId: receipt.conversationId }) });
    if (!exported.ok) throw new Error('Cold transcript export failed');
    const legacy = await openLegacySession(() => verifiedFile(original.immutableObjects.ompTranscript), original.canonicalSessionId, original.ompSessionId);
    const sourceHash = createHash('sha256'); const restoredHash = createHash('sha256');
    let sourceEvents = 0; let restoredEvents = 0;
    for await (const event of legacy.events) { sourceHash.update(JSON.stringify([event.kind, event.payload, new Date(event.createdAt).toISOString()])); sourceEvents++; }
    for await (const event of readRuntimeTranscript(exported)) { restoredHash.update(JSON.stringify([event.kind, event.payload, new Date(event.createdAt).toISOString()])); restoredEvents++; }
    if (sourceEvents !== restoredEvents || sourceEvents !== original.expected.history.projectedEvents || sourceHash.digest('hex') !== restoredHash.digest('hex')) throw new Error('Cold transcript differs from the original selected history');
    (evidence.verification as unknown[]).push({ workspaceId: original.workspaceId, historyEvents: receipt.importedEvents, historyEntries: receipt.importedEntries, conversations: snapshot.conversations.length, transcriptGeneration: page.generation, codeExact: true, lifecyclePreserved: true, historicalLfs: receipt.historicalLfs.length, branchAlignment: receipt.branchAlignment });
  }
  stage = 'cloud-workspace-source-continuity'; console.log(JSON.stringify({ stage }));
  const forkSources = [
    ...input.spaces.filter(space => space.workspaceId === space.projectId).map(space => ({ space, kind: 'base' as const })),
    { space: recordless, kind: 'workspace' as const },
  ];
  if (forkSources.length !== projects.size + 1) throw new Error('Missing canonical base input for cloud workspace continuity');
  const createdForks = [];
  for (const { space, kind } of forkSources) {
    const created = z.object({ workspace: cloudWorkspaceDefinitionSchema }).parse(await fixture('create-workspace', {
      projectId: space.projectId, name: `Migration fork ${space.workspaceId}`, branch: `rehearsal/from-${kind}`, sourceKind: kind,
      sourceRef: kind === 'workspace' ? space.workspaceId : '', phase: workspaceDefinitions.get(space.workspaceId)?.phase ?? 'plan',
    })).workspace;
    if (created.lifecycle !== 'active' || created.sourceCommit !== space.sourceGit.headCommit) throw new Error('Cloud fork changed the migrated source HEAD');
    const checkpoint = RuntimeGitCheckpointSchema.parse(await rpc('SPACE_AUTHORITY', created.id, 'runtimeRepositoryCheckpoint', { projectId: space.projectId, workspaceId: created.id }));
    if (checkpoint.headCommit !== space.sourceGit.headCommit || checkpoint.branch !== created.branch) throw new Error('Cold cloud fork initialized the wrong branch or HEAD');
    if (space.sourceGit.headCommit !== null) {
      const headTree = (await command(['git', `--git-dir=${gitBacking.repositoryPath(artifactsWorkspaceRepository(space.workspaceId))}`, 'rev-parse', `${space.sourceGit.headCommit}^{tree}`], `fork-source-tree-${space.workspaceId}`)).trim();
      if (checkpoint.indexTree !== headTree || checkpoint.worktreeTree !== headTree) throw new Error('Cloud fork copied uncommitted source changes instead of HEAD');
    }
    createdForks.push({ projectId: space.projectId, sourceWorkspaceId: space.workspaceId, sourceKind: kind, workspaceId: created.id, headCommit: checkpoint.headCommit, cloudOnly: true });
  }
  evidence.cloudForks = createdForks;
  stage = 'artifact-download-readback'; console.log(JSON.stringify({ stage }));
  let artifactBytes = 0;
  for (const artifact of artifactDownloads) {
    const share = z.object({ url: z.string() }).parse(await fixture('share', { projectId: artifact.projectId, workspaceId: artifact.workspaceId, url: `local://${artifact.workspaceId === artifact.projectId ? 'base' : 'workspace'}/${artifact.path.split('/').map(encodeURIComponent).join('/')}`, hash: artifact.hash }));
    const response = await mf.dispatchFetch(new URL(share.url, accountUrl).href);
    if (!response.ok || !response.body) throw new Error('Restored artifact download failed');
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of response.body) { hash.update(chunk); bytes += chunk.byteLength; }
    if (bytes !== artifact.size || `sha256:${hash.digest('hex')}` !== artifact.plaintextHash) throw new Error('Restored artifact bytes differ');
    artifactBytes += bytes;
  }
  evidence.artifactDownloads = { count: artifactDownloads.length, bytes: artifactBytes };
  evidence.receipts = receipts.map(receipt => ({ operationId: receipt.operationId, workspaceId: receipt.source.workspaceId, sourceDigest: receipt.source.sourceDigest }));
  evidence.network = network; evidence.modelCallsDuringMigration = modelCalls;
  if (modelCalls !== 0) throw new Error('Passive migration called inference');
  stage = 'fresh-pi-turn'; console.log(JSON.stringify({ stage }));
  const inference = z.object({ profiles: z.array(z.object({ id: z.string(), revision: z.number() })) }).parse(await rpc('CREDENTIALS', null, 'ensureInference'));
  const defaultProfile = inference.profiles.find(profile => profile.id === 'default');
  if (!defaultProfile) throw new Error('Isolated Default profile disappeared');
  await rpc('CREDENTIALS', null, 'updateInferenceProfile', { profileId: 'default', expectedRevision: defaultProfile.revision, name: 'Default', settings: {
    modelRoles: { default: 'openai/migration-proof' },
    providers: { models: { openai: { name: 'Isolated OpenAI fixture', models: [{
      id: 'migration-proof', name: 'Migration proof', api: 'openai-completions', baseUrl: 'https://rehearsal-model.invalid/v1',
      reasoning: false, input: ['text'], contextWindow: 200000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] } } },
  } });
  await rpc('CREDENTIALS', null, 'cloudSetApiKey', { profileId: 'default', providerId: 'openai', key: 'isolated-not-production' });
  allowModel = true;
  const fresh = receipts.find(receipt => receipt.source.workspaceId === recordless.workspaceId);
  if (!fresh || workspaceDefinitions.get(fresh.source.workspaceId)?.lifecycle !== 'active') throw new Error('Recovered Recordless is not active for the isolated continuation');
  const freshIdentity = { projectId: fresh.source.projectId, workspaceId: fresh.source.workspaceId, conversationId: fresh.conversationId };
  RuntimeSessionResultSchema.parse(await rpc('SPACE_AUTHORITY', fresh.source.workspaceId, 'runtimeSession', { ...freshIdentity, command: { type: 'prompt', text: 'Reply with the isolated migration completion sentence. Do not call tools.' } }, { canApprove: false, deviceId: machineId }));
  const deadline = Date.now() + 60_000;
  let replied = false;
  while (Date.now() < deadline) {
    const result = RuntimeSessionResultSchema.parse(await rpc('SPACE_AUTHORITY', fresh.source.workspaceId, 'runtimeSession', { ...freshIdentity, command: { type: 'messages' } }, { canApprove: false, deviceId: machineId }));
    const messages = z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }))]) })).parse(result.messages);
    replied = messages.some(message => message.role === 'assistant' && (typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('')) === 'Isolated migration turn completed.');
    if (replied) break;
    await Bun.sleep(100);
  }
  if (!replied || modelCalls !== 1 || historicalModelMessages !== 0) throw new Error('Fresh Pi continuation did not complete without historical replay');
  evidence.freshTurn = { workspaceId: fresh.source.workspaceId, modelCalls, historicalModelMessages, replyVerified: true, provider: 'isolated-local-fixture' };
  evidence.status = 'migrated-and-cold-read';
  await writeFile(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ stage: 'migrated-and-cold-read', workspaces: receipts.length, root }));
  key.fill(0);
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({ stage, error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error), evidence }, null, 2), { mode: 0o600 });
  console.error(JSON.stringify({ stage, status: 'failed', diagnostics: join(root, 'failure.json') }));
  process.exitCode = 1;
} finally {
  await mf.dispose(); tls.stop(true); await gitBacking.close(); rootPrivate.fill(0); machinePrivate.fill(0);
}
