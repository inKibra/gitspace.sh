import {
  WORKER_MANIFEST_FILE,
  WORKER_VERSION_HEADER,
  platformDeployResponseSchema,
  workerBundleSchema,
  workerManifestSchema,
  workerModuleKey,
  workerReleaseMetadataSchema,
  type LegacyPlatformDeployRequest,
  type PlatformRevertRequest,
  type PlatformDeployRequest,
  type PlatformDeployResponse,
  type WorkerManifest,
  type WorkerReleaseMetadata,
} from '@gitspace/protocol/deployment';
import type { WorkerModule } from '@gitspace/protocol/worker-bundle';
import { z } from 'zod';
import type { CreditLedgerRecord } from './credit-ledger.js';
import type { TenantDeployRecord, TenantDeploymentsDO, TenantDeploymentState } from './tenant-deployments.js';
import { defaultReleaseReader } from './default-release.js';
import { resolveDefaultRelease } from '@gitspace/protocol/default-release';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';


// Dispatchers can still serve the predecessor after upload; allow 30 seconds at the production interval.
const PROBE_ATTEMPTS = 16;

export interface MigrationUpload {
  old_tag?: string;
  new_tag: string;
  steps: Array<{ new_sqlite_classes: string[]; deleted_classes?: string[] }>;
}

/** The `metadata` multipart part of a Workers for Platforms script upload. */
export interface ScriptUploadMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  observability: {
    enabled: true;
    head_sampling_rate: 1;
    redact_query_string: true;
    logs: { enabled: true; invocation_logs: false; persist: true };
  };
  bindings: Array<
    | { type: 'durable_object_namespace'; name: string; class_name: string }
    | { type: 'r2_bucket'; name: string; bucket_name: string }
    | { type: 'artifacts'; name: string; namespace: string }
    | { type: 'worker_loader'; name: string }
    | { type: 'browser'; name: string }
    | { type: 'ai'; name: string }
    | { type: 'plain_text'; name: string; text: string }
    | { type: 'secret_text'; name: string; text: string }
    | { type: 'service'; name: string; service: string }
  >;
  migrations?: MigrationUpload;
  keep_bindings: string[];
  tags: string[];
}

export interface DeployFailure {
  status: number;
  code: string;
  message: string;
}

type Outcome<T> = { status: 'ok'; value: T } | { status: 'error'; error: DeployFailure };

export type DeployResult = Outcome<PlatformDeployResponse>;

/** A deploy result as the tenant's deployment object stores it under its operation id. */
export const deployResultSchema: z.ZodType<DeployResult> = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok'), value: platformDeployResponseSchema }),
  z.object({ status: z.literal('error'), error: z.object({ status: z.number().int(), code: z.string(), message: z.string() }) }),
]);

/**
 * Migrations Cloudflare still has to run for this tenant: every tag after the
 * applied one, in order. No applied tag means the script was never migrated
 * (first upload) so every tag is pending. An applied tag the release does not
 * know (older workspace build, or tags renamed) yields nothing: classes already
 * exist and a `new_sqlite_classes` replay would be rejected.
 */
export function migrationDelta(migrations: WorkerReleaseMetadata['migrations'], appliedTag: string | null): MigrationUpload | null {
  let start = 0;
  if (appliedTag !== null) {
    const applied = migrations.findIndex((migration) => migration.tag === appliedTag);
    if (applied === -1) return null;
    start = applied + 1;
  }
  const pending = migrations.slice(start);
  const last = pending.at(-1);
  if (!last) return null;
  return {
    ...(appliedTag === null ? {} : { old_tag: appliedTag }),
    new_tag: last.tag,
    steps: pending.map((migration) => ({ new_sqlite_classes: migration.newSqliteClasses, ...(migration.deletedClasses.length ? { deleted_classes: migration.deletedClasses } : {}) })),
  };
}
export function scriptUploadMetadata(
  metadata: WorkerReleaseMetadata,
  migrations: MigrationUpload | null,
  tags: string[],
  tenant: { id: string; accountId: string; rootPublicKey: string; blobBucket: string; platformUrl: string; platformService: string; token: string; publicAssetsService: string },
): ScriptUploadMetadata {
  const bindings: ScriptUploadMetadata['bindings'] = metadata.durableObjects.map(binding => ({ type: 'durable_object_namespace', name: binding.name, class_name: binding.className }));
  const names = new Set(bindings.map(binding => binding.name));
  for (const resource of metadata.resources) {
    if (names.has(resource.name)) throw new Error('Duplicate provider binding: ' + resource.name);
    names.add(resource.name);
    if (resource.source === 'object-storage') { bindings.push({ type: 'r2_bucket', name: resource.name, bucket_name: tenant.blobBucket }); continue; }
    if (resource.source === 'artifacts') { bindings.push({ type: 'artifacts', name: resource.name, namespace: `gsp-${tenant.accountId}` }); continue; }
    if (resource.source === 'worker-loader') { bindings.push({ type: 'worker_loader', name: resource.name }); continue; }
    if (resource.source === 'browser-rendering') { bindings.push({ type: 'browser', name: resource.name }); continue; }
    if (resource.source === 'workers-ai') { bindings.push({ type: 'ai', name: resource.name }); continue; }
    if (resource.source === 'public-assets') { bindings.push({ type: 'service', name: resource.name, service: tenant.publicAssetsService }); continue; }
    if (resource.source === 'platform-service') { bindings.push({ type: 'service', name: resource.name, service: tenant.platformService }); continue; }
    if (resource.source === 'provider-token') { bindings.push({ type: 'secret_text', name: resource.name, text: tenant.token }); continue; }
    let value: string;
    switch (resource.source) {
      case 'object-storage-name': value = tenant.blobBucket; break;
      case 'tenant-id': value = tenant.id; break;
      case 'account-id': value = tenant.accountId; break;
      case 'root-public-key': value = tenant.rootPublicKey; break;
      case 'platform-url': value = tenant.platformUrl; break;
      case 'application-url': value = 'https://' + tenant.id + '.gitspace.sh'; break;
      case 'transport-url': value = 'https://' + tenant.id + '.gssh.dev'; break;
      case 'literal': if (resource.value === undefined) throw new Error('Literal binding value is required'); value = resource.value; break;
      // A source from a release built by newer code than this deployer: bound by nothing here, so the release is
      // deployed without it rather than refused.
      default: continue;
    }
    bindings.push({ type: 'plain_text', name: resource.name, text: value });
  }
  return {
    main_module: metadata.mainModule, compatibility_date: metadata.compatibilityDate, compatibility_flags: metadata.compatibilityFlags,
    observability: { enabled: true, head_sampling_rate: 1, redact_query_string: true, logs: { enabled: true, invocation_logs: false, persist: true } },
    bindings, ...(migrations ? { migrations } : {}), keep_bindings: [], tags,
  };
}

async function ensureArtifactsNamespace(env: Env, namespace: string): Promise<DeployFailure | null> {
  const base = `${CLOUDFLARE_API}/accounts/${env.CF_ACCOUNT_ID}/artifacts/namespaces`;
  const headers = { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': 'application/json' };
  try {
    const existing = await fetch(`${base}/${encodeURIComponent(namespace)}`, { headers });
    if (existing.ok && (await readCloudflareEnvelope(existing))?.success) return null;
    if (existing.status !== 404) return { status: 502, code: 'ARTIFACTS_NAMESPACE_FAILED', message: `Artifacts namespace lookup returned ${existing.status}` };
    const created = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ namespace }) });
    if (created.ok && (await readCloudflareEnvelope(created))?.success) return null;
    // A concurrent tenant deployment may have created this deterministic namespace.
    if (created.status === 409) {
      const concurrent = await fetch(`${base}/${encodeURIComponent(namespace)}`, { headers });
      if (concurrent.ok && (await readCloudflareEnvelope(concurrent))?.success) return null;
    }
    return { status: 502, code: 'ARTIFACTS_NAMESPACE_FAILED', message: `Artifacts namespace creation returned ${created.status}` };
  } catch (error) {
    return { status: 502, code: 'ARTIFACTS_NAMESPACE_FAILED', message: error instanceof Error ? error.message : 'Artifacts namespace request failed' };
  }
}

async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function invalidModules(message: string): { status: 'error'; error: DeployFailure } {
  return { status: 'error', error: { status: 409, code: 'WORKER_MODULE_INVALID', message } };
}

function missingObject(key: string): { status: 'error'; error: DeployFailure } {
  return { status: 'error', error: { status: 404, code: 'RELEASE_OBJECT_NOT_FOUND', message: `Release object unavailable at ${key}` } };
}

/** Reads a release object: from the tenant's data bucket through its own Worker, or from RELEASES. */
type ObjectReader = (key: string) => Promise<ReadableStream<Uint8Array> | null>;

/** A manifest is a few hundred bytes per module; anything longer is not one. */
const WORKER_MANIFEST_MAX_BYTES = 64 * 1024;
const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const MODULE_CONTENT_TYPES: Record<WorkerModule['type'], string> = { esm: 'application/javascript+module', wasm: 'application/wasm' };

/** Reads at most `limit` bytes into one buffer; null when the object is longer. */
async function readBounded(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const bytes = new Uint8Array(limit);
  const reader = body.getReader();
  let length = 0;
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    if (length + chunk.value.byteLength > limit) {
      await reader.cancel();
      return null;
    }
    bytes.set(chunk.value, length);
    length += chunk.value.byteLength;
  }
  return bytes.subarray(0, length);
}

async function readWorkerManifest(read: ObjectReader, key: string, expectedHash: string | null, mainModule: string): Promise<Outcome<{ bytes: Uint8Array<ArrayBuffer>; manifest: WorkerManifest }>> {
  const body = await read(key);
  if (!body) return missingObject(key);
  const bytes = await readBounded(body, WORKER_MANIFEST_MAX_BYTES);
  if (!bytes) return invalidModules(`Worker manifest is larger than ${WORKER_MANIFEST_MAX_BYTES} bytes`);
  const hash = `sha256:${await sha256Hex(bytes)}`;
  if (expectedHash !== null && hash !== expectedHash) return { status: 'error', error: { status: 409, code: 'MANIFEST_HASH_MISMATCH', message: `Worker manifest hashes to ${hash}, expected ${expectedHash}` } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return invalidModules('Worker manifest is not JSON');
  }
  const manifest = workerManifestSchema.safeParse(parsed);
  if (!manifest.success) return invalidModules(`Worker manifest is invalid: ${manifest.error.message}`);
  if (manifest.data.mainModule !== mainModule) return invalidModules(`Worker manifest main module ${manifest.data.mainModule} differs from the release's ${mainModule}`);
  return { status: 'ok', value: { bytes, manifest: manifest.data } };
}

/** Reads one module into exactly its manifest size and checks its digest before anything stores or uploads it. */
async function readWorkerModule(read: ObjectReader, manifestKey: string, module: WorkerManifest['modules'][number]): Promise<Outcome<WorkerModule>> {
  const key = workerModuleKey(manifestKey, module.name);
  const body = await read(key);
  if (!body) return missingObject(key);
  const content = await readBounded(body, module.size);
  if (!content || content.byteLength !== module.size || await sha256Hex(content) !== module.sha256) return invalidModules(`Worker module integrity mismatch: ${module.name}`);
  if (module.type === 'wasm' && WASM_MAGIC.some((byte, index) => content[index] !== byte)) return invalidModules(`Invalid WASM module: ${module.name}`);
  return { status: 'ok', value: { name: module.name, type: module.type, content } };
}

/**
 * LEGACY(single-bundle releases): a version-1 `worker.bundle.json` carries every module base64-encoded in one JSON
 * document. Reached only by a deploy request that still names a bundle and by a revert, fallback or channel deploy of a
 * release stored before module releases; delete with `legacyPlatformDeployRequestSchema` and the legacy default worker
 * once no tenant sends one and no deploy record or default pin names one. The document is decoded once: its text is
 * released after parsing and each module decodes straight into its own bytes.
 */
async function legacyBundleModules(env: Env, key: string, mainModule: string): Promise<Outcome<WorkerModule[]>> {
  const object = await env.RELEASES.get(key);
  if (!object) return missingObject(key);
  const modules: WorkerModule[] = [];
  try {
    const bundle = workerBundleSchema.parse(JSON.parse(await object.text()));
    for (const module of bundle.modules) {
      const binary = atob(module.base64);
      const content = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) content[index] = binary.charCodeAt(index);
      if (content.byteLength !== module.bytes || `sha256:${await sha256Hex(content)}` !== module.hash) return invalidModules(`Worker module integrity mismatch: ${module.name}`);
      if (module.type === 'wasm' && WASM_MAGIC.some((byte, index) => content[index] !== byte)) return invalidModules(`Invalid WASM module: ${module.name}`);
      modules.push({ name: module.name, type: module.type, content });
    }
  } catch (error) {
    return invalidModules(error instanceof Error ? error.message : String(error));
  }
  if (!modules.some(module => module.name === mainModule && module.type === 'esm')) return invalidModules('Worker bundle has no declared main module');
  return { status: 'ok', value: modules };
}

/** A stored release's modules: a worker manifest and the modules beside it, or a LEGACY single bundle. */
async function loadWorkerModules(env: Env, workerKey: string, mainModule: string): Promise<Outcome<WorkerModule[]>> {
  if (!workerKey.endsWith(`/${WORKER_MANIFEST_FILE}`)) return legacyBundleModules(env, workerKey, mainModule);
  const read: ObjectReader = async key => (await env.RELEASES.get(key))?.body ?? null;
  const manifest = await readWorkerManifest(read, workerKey, null, mainModule);
  if (manifest.status === 'error') return manifest;
  const modules: WorkerModule[] = [];
  for (const entry of manifest.value.manifest.modules) {
    const module = await readWorkerModule(read, workerKey, entry);
    if (module.status === 'error') return module;
    modules.push(module.value);
  }
  return { status: 'ok', value: modules };
}

interface CloudflareApiEnvelope {
  success: boolean;
  /** `code: message` per API error. */
  errors: string[];
}

async function readCloudflareEnvelope(response: Response): Promise<CloudflareApiEnvelope | null> {
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== 'object' || !('success' in parsed) || typeof parsed.success !== 'boolean') return null;
    const errors: string[] = [];
    if ('errors' in parsed && Array.isArray(parsed.errors)) {
      for (const entry of parsed.errors) {
        if (!entry || typeof entry !== 'object') continue;
        const code = 'code' in entry && typeof entry.code === 'number' ? String(entry.code) : '?';
        const message = 'message' in entry && typeof entry.message === 'string' ? entry.message : 'unknown';
        errors.push(`${code}: ${message}`);
      }
    }
    return { success: parsed.success, errors };
  } catch {
    return null;
  }
}

/**
 * Streams the multipart upload from the module bytes already in memory: a `FormData` body would copy every module into
 * a Blob and again into the serialized request.
 */
async function uploadScript(env: Env, tenant: string, workerKey: string, metadata: ScriptUploadMetadata): Promise<DeployFailure | null> {
  const modules = await loadWorkerModules(env, workerKey, metadata.main_module);
  if (modules.status === 'error') return modules.error;
  const boundary = `gitspace-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [
    encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="metadata"; filename="metadata.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    ...modules.value.flatMap(module => [
      encoder.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${module.name}"; filename="${module.name}"\r\nContent-Type: ${MODULE_CONTENT_TYPES[module.type]}\r\n\r\n`),
      module.content,
      encoder.encode('\r\n'),
    ]),
    encoder.encode(`--${boundary}--\r\n`),
  ];
  const length = parts.reduce((total, part) => total + part.byteLength, 0);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts.shift();
      if (part) controller.enqueue(part);
      else controller.close();
    },
  }).pipeThrough(new FixedLengthStream(length));
  const url = `${CLOUDFLARE_API}/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/${env.DISPATCH_NAMESPACE}-tenant-${tenant}`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
  } catch (error) {
    return { status: 502, code: 'UPLOAD_UNREACHABLE', message: error instanceof Error ? error.message : String(error) };
  }
  const envelope = await readCloudflareEnvelope(response);
  if (response.ok && envelope?.success) return null;
  const detail = envelope?.errors.join('; ');
  return {
    status: 502,
    code: 'UPLOAD_REJECTED',
    message: `Cloudflare rejected the script upload (HTTP ${response.status})${detail ? `: ${detail}` : ''}`,
  };
}

interface Probe {
  healthy: boolean;
  version: string | null;
}

/** Hits the freshly uploaded script through the dispatcher; the version stamp must match the release. */
async function probeHealth(env: Env, tenant: string, expectedSha: string): Promise<Probe> {
  let version: string | null = null;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Number(env.DEPLOY_PROBE_DELAY_MS));
      await promise;
    }
    try {
      const response = await env.DISPATCHER.get(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`).fetch('https://tenant/healthz');
      version = response.headers.get(WORKER_VERSION_HEADER);
      // Release this invocation before looking up the next Worker version.
      await response.body?.cancel();
      const matches = version === expectedSha;
      if (response.ok && matches) return { healthy: true, version };
    } catch (error) {
      console.error(JSON.stringify({ event: 'deploy-probe-failed', tenant, attempt, message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { healthy: false, version };
}

/** A release to upload; its bytes are read from RELEASES only for the upload itself, so no swap holds two releases. */
export interface Candidate {
  /** Exact Worker build identity, checked by the post-upload health probe. */
  sha: string;
  /** RELEASES key: a worker manifest, or a LEGACY single bundle. */
  workerKey: string;
  metadata: WorkerReleaseMetadata;
}

/** What a swap reads from and records in the tenant's deployment object, which is also the object running it. */
export type DeploymentRecords = Pick<TenantDeploymentsDO, 'tenantConfig' | 'providerToken' | 'recordDeploy'>;

/** The release an unhealthy swap falls back to: the one that was running. */
async function loadFallback(env: Env, state: TenantDeploymentState, exclude: string): Promise<Candidate | null> {
  const active: TenantDeployRecord | null = state.active && state.active.sha !== exclude ? state.active : null;
  return active && await env.RELEASES.head(active.workerKey) ? { sha: active.sha, workerKey: active.workerKey, metadata: active.metadata } : null;
}

/** The release a new tenant starts on: the current published default, with its pin as `DEFAULT_ACCOUNT_RELEASE`, which
 * the account takes once as its default release (by reference, from the channel). Resolving it verifies its worker
 * manifest (or LEGACY bundle) against the default manifest. */
async function loadChannel(env: Env): Promise<Candidate | null> {
  try {
    const { release: manifest, pin } = await resolveDefaultRelease(defaultReleaseReader(env.RELEASES));
    const metadata = workerReleaseMetadataSchema.parse({
      ...manifest.worker.metadata,
      resources: [...manifest.worker.metadata.resources.filter(resource => resource.name !== 'DEFAULT_ACCOUNT_RELEASE'), { name: 'DEFAULT_ACCOUNT_RELEASE', source: 'literal', value: pin }],
    });
    return { sha: manifest.worker.version, workerKey: 'manifest' in manifest.worker ? manifest.worker.manifest.key : manifest.worker.bundle.key, metadata };
  } catch { return null; }
}

/** Upload → probe → (auto-revert). Runs inside the tenant's deployment object, which holds the lease for the whole call. */
async function swap(env: Env, tenant: string, records: DeploymentRecords, state: TenantDeploymentState, candidate: Candidate, autoRevert: boolean): Promise<DeployResult> {
  const expectedSha = candidate.sha;
  const tenantConfig = await records.tenantConfig();
  if (!tenantConfig) return { status: 'error', error: { status: 409, code: 'TENANT_UNCONFIGURED', message: 'Tenant bindings are not configured' } };
  const delta = migrationDelta(candidate.metadata.migrations, state.appliedMigrationTag);
  const accountKey = Uint8Array.from(atob(tenantConfig.rootPublicKey), character => character.charCodeAt(0));
  const accountHash = new Uint8Array(await crypto.subtle.digest('SHA-256', accountKey));
  const accountId = `u-${Array.from(accountHash.subarray(0, 16), byte => byte.toString(16).padStart(2, '0')).join('')}`;
  const token = await records.providerToken();
  if (candidate.metadata.resources.some(resource => resource.source === 'artifacts')) {
    const failure = await ensureArtifactsNamespace(env, `gsp-${accountId}`);
    if (failure) return { status: 'error', error: failure };
  }
  const uploadMetadata = scriptUploadMetadata(candidate.metadata, delta, [tenant, candidate.sha], {
    id: tenant,
    accountId,
    token,
    platformUrl: env.PLATFORM_URL,
    platformService: env.PLATFORM_SERVICE_NAME,
    rootPublicKey: tenantConfig.rootPublicKey,
    blobBucket: tenantConfig.blobBucket,
    publicAssetsService: env.PUBLIC_ASSETS_SERVICE,
  });
  const rejected = await uploadScript(env, tenant, candidate.workerKey, uploadMetadata);
  if (rejected) return { status: 'error', error: rejected };
  const appliedMigrationTag = delta ? delta.new_tag : state.appliedMigrationTag;
  const probe = await probeHealth(env, tenant, expectedSha);
  const sha = probe.version ?? candidate.sha;
  if (probe.healthy) {
    await records.recordDeploy({ sha, workerKey: candidate.workerKey, metadata: candidate.metadata, healthy: true, revertedTo: null, appliedMigrationTag });
    return { status: 'ok', value: { sha, healthy: true, revertedTo: null, appliedMigrationTag } };
  }

  const fallback = autoRevert ? await loadFallback(env, state, candidate.sha) : null;
  let revertedTo: string | null = null;
  if (fallback) {
    const fallbackDelta = migrationDelta(fallback.metadata.migrations, appliedMigrationTag);
    const fallbackRejected = await uploadScript(env, tenant, fallback.workerKey, scriptUploadMetadata(
      fallback.metadata,
      fallbackDelta,
      [tenant, fallback.sha],
      { id: tenant, accountId, token, platformUrl: env.PLATFORM_URL, platformService: env.PLATFORM_SERVICE_NAME, rootPublicKey: tenantConfig.rootPublicKey, blobBucket: tenantConfig.blobBucket, publicAssetsService: env.PUBLIC_ASSETS_SERVICE },
    ));
    if (fallbackRejected) {
      console.error(JSON.stringify({ event: 'deploy-revert-rejected', tenant, sha: candidate.sha, message: fallbackRejected.message }));
    } else {
      const fallbackProbe = await probeHealth(env, tenant, fallback.sha);
      const fallbackSha = fallbackProbe.version ?? fallback.sha;
      if (fallbackProbe.healthy) {
        revertedTo = fallbackSha;
        await records.recordDeploy({
          sha: fallbackSha,
          workerKey: fallback.workerKey,
          metadata: fallback.metadata,
          healthy: true,
          revertedTo: null,
          appliedMigrationTag: fallbackDelta ? fallbackDelta.new_tag : null,
        });
      }
    }
  }
  await records.recordDeploy({ sha: candidate.sha, workerKey: candidate.workerKey, metadata: candidate.metadata, healthy: false, revertedTo, appliedMigrationTag });
  return { status: 'ok', value: { sha: candidate.sha, healthy: false, revertedTo, appliedMigrationTag } };
}

/** One swap the tenant's deployment object runs under its lease: a staged tenant release, a revert to the previous
 * release, or the published default a new tenant starts on. */
export type DeployWork =
  | { kind: 'release'; candidate: Candidate }
  | { kind: 'revert'; request: Omit<PlatformRevertRequest, 'operationId'> }
  | { kind: 'bootstrap' };
/**
 * Runs `work` for the tenant. Called by its deployment object, which holds the lease for the whole call, so the swap
 * and its metering finish whether or not the request that asked for it is still connected. A tenant release and a
 * revert are metered once they swap; bootstrap installs the channel unmetered.
 */
export async function runDeployWork(env: Env, tenant: string, records: DeploymentRecords, state: TenantDeploymentState, work: DeployWork): Promise<DeployResult> {
  if (work.kind === 'bootstrap') {
    const candidate = await loadChannel(env);
    if (!candidate) return { status: 'error', error: { status: 503, code: 'CHANNEL_UNAVAILABLE', message: 'Relay channel release is not published' } };
    return swap(env, tenant, records, state, candidate, false);
  }
  const result = work.kind === 'release'
    ? await swap(env, tenant, records, state, work.candidate, true)
    : await revertSwap(env, tenant, records, state);
  // Metering never turns a swap that happened into a failure.
  if (result.status === 'ok') {
    await meterDeploy(env, tenant, result.value.sha).catch((error: unknown) => console.error(JSON.stringify({ event: 'deploy-metering-failed', tenant, message: error instanceof Error ? error.message : String(error) })));
  }
  return result;
}

/** One `worker-deploy` ledger entry per swap; an unconfigured credit account is logged, never a deploy failure. */
async function meterDeploy(env: Env, tenant: string, sha: string): Promise<void> {
  const credits = env.CREDITS.getByName(tenant);
  const account = await credits.getAccount();
  if (account.status === 'error') {
    console.error(JSON.stringify({ event: 'deploy-metering-skipped', tenant, code: account.error.code }));
    return;
  }
  const now = new Date().toISOString();
  const ledger: CreditLedgerRecord = {
    id: `deploy:${tenant}:${sha}:${crypto.randomUUID()}`,
    resource: 'worker-deploy',
    quantity: '1',
    rateVersion: 'cloudflare-2026-08-27',
    debitMicros: Number(env.DEPLOY_SETTLEMENT_MICROS),
    windowStart: now,
    windowEnd: now,
    createdAt: now,
  };
  const applied = await credits.applyUsage(ledger);
  if (applied.status === 'error') console.error(JSON.stringify({ event: 'deploy-metering-failed', tenant, code: applied.error.code }));
}

/** Copies a tenant's module release into RELEASES, checking the manifest digest and each module against the manifest. */
async function stageModuleRelease(env: Env, tenant: string, read: ObjectReader, sha: string, release: { key: string; hash: string }, mainModule: string): Promise<Outcome<string>> {
  const manifest = await readWorkerManifest(read, release.key, release.hash, mainModule);
  if (manifest.status === 'error') return manifest;
  const workerKey = `tenants/${tenant}/${sha}/${WORKER_MANIFEST_FILE}`;
  for (const entry of manifest.value.manifest.modules) {
    const module = await readWorkerModule(read, release.key, entry);
    if (module.status === 'error') return module;
    await env.RELEASES.put(workerModuleKey(workerKey, entry.name), module.value.content);
  }
  // Last, so a stored manifest only ever names stored modules.
  await env.RELEASES.put(workerKey, manifest.value.bytes, { httpMetadata: { contentType: 'application/json' } });
  return { status: 'ok', value: workerKey };
}

/** LEGACY(single-bundle releases): stores the bundle as sent, checked against its digest; `legacyBundleModules` decodes it at upload. */
async function stageLegacyBundle(env: Env, tenant: string, read: ObjectReader, sha: string, bundle: { key: string; hash: string }): Promise<Outcome<string>> {
  const body = await read(bundle.key);
  if (!body) return missingObject(bundle.key);
  const bytes = await new Response(body).arrayBuffer();
  const hash = `sha256:${await sha256Hex(bytes)}`;
  if (hash !== bundle.hash) return { status: 'error', error: { status: 409, code: 'BUNDLE_HASH_MISMATCH', message: `Bundle hashes to ${hash}, expected ${bundle.hash}` } };
  const workerKey = `tenants/${tenant}/${sha}/worker.bundle.json`;
  await env.RELEASES.put(workerKey, bytes, { httpMetadata: { contentType: 'application/json' } });
  return { status: 'ok', value: workerKey };
}

export async function deployTenantWorker(env: Env, tenant: string, request: PlatformDeployRequest | LegacyPlatformDeployRequest): Promise<DeployResult> {
  const tenantWorker = env.DISPATCHER.get(`${env.DISPATCH_NAMESPACE}-tenant-${tenant}`);
  const token = await env.DEPLOYMENTS.getByName(tenant).providerToken();
  const read: ObjectReader = async key => {
    const response = await tenantWorker.fetch(new Request(`https://${tenant}.gitspace.sh/__platform/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: { authorization: `Bearer ${token}` } }));
    if (response.ok && response.body) return response.body;
    await response.body?.cancel();
    return null;
  };
  // LEGACY(single-bundle releases): a tenant on an older release names its worker `bundleKey`: a single bundle, or a
  // module manifest when a newer machine built the release.
  const release = 'manifestKey' in request ? { key: request.manifestKey, hash: request.manifestHash } : { key: request.bundleKey, hash: request.bundleHash };
  const staged = release.key.endsWith(`/${WORKER_MANIFEST_FILE}`)
    ? await stageModuleRelease(env, tenant, read, request.sha, release, request.metadata.mainModule)
    : await stageLegacyBundle(env, tenant, read, request.sha, release);
  if (staged.status === 'error') return staged;

  return env.DEPLOYMENTS.getByName(tenant).deploy(tenant, { kind: 'release', candidate: { sha: request.sha, workerKey: staged.value, metadata: request.metadata } }, null);
}

/** Restores the previous healthy release. */
async function revertSwap(env: Env, tenant: string, records: DeploymentRecords, state: TenantDeploymentState): Promise<DeployResult> {
  const previous = state.previous;
  if (!previous || !await env.RELEASES.head(previous.workerKey)) return { status: 'error', error: { status: 409, code: 'NO_PREVIOUS_RELEASE', message: 'No earlier healthy release to restore' } };
  return swap(env, tenant, records, state, { sha: previous.sha, workerKey: previous.workerKey, metadata: previous.metadata }, false);
}
