import {
  WORKER_VERSION_HEADER,
  workerReleaseMetadataSchema,
  type PlatformDeployRequest,
  type PlatformDeployResponse,
  type WorkerReleaseMetadata,
} from '@gitspace/protocol';
import type { TenantDeployRecord, TenantDeploymentsDO, TenantDeploymentState } from './tenant-deployments.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
/** Our channel build, placed in RELEASES by the GitSpace release pipeline. */
export const CHANNEL_BUNDLE_KEY = 'channel/worker.mjs';
export const CHANNEL_METADATA_KEY = 'channel/metadata.json';
export const CHANNEL_SHA = 'channel';

/**
 * Binding types carried over from the tenant's previous upload. Durable Object
 * namespaces are NOT kept: the release metadata declares them so a build that
 * adds or drops a class is uploaded exactly as its wrangler config says.
 */
export const KEPT_BINDING_TYPES = [
  'plain_text',
  'json',
  'secret_text',
  'secret_key',
  'r2_bucket',
  'kv_namespace',
  'd1',
  'service',
  'queue',
  'analytics_engine',
  'hyperdrive',
  'dispatch_namespace',
  'browser',
  'ai',
  'vectorize',
  'workflow',
  'secrets_store_secret',
  'ratelimit',
  'send_email',
  'mtls_certificate',
  'version_metadata',
  'pipelines',
] as const;

const PROBE_ATTEMPTS = 3;

export interface MigrationUpload {
  old_tag?: string;
  new_tag: string;
  steps: Array<{ new_sqlite_classes: string[] }>;
}

/** The `metadata` multipart part of a Workers for Platforms script upload. */
export interface ScriptUploadMetadata {
  main_module: string;
  compatibility_date: string;
  compatibility_flags: string[];
  bindings: Array<{ type: 'durable_object_namespace'; name: string; class_name: string }>;
  migrations?: MigrationUpload;
  keep_bindings: string[];
  tags: string[];
}

export interface DeployFailure {
  status: number;
  code: string;
  message: string;
}

export type DeployResult =
  | { status: 'ok'; value: PlatformDeployResponse }
  | { status: 'error'; error: DeployFailure };

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
    steps: pending.map((migration) => ({ new_sqlite_classes: migration.newSqliteClasses })),
  };
}

export function scriptUploadMetadata(
  metadata: WorkerReleaseMetadata,
  migrations: MigrationUpload | null,
  tags: string[],
): ScriptUploadMetadata {
  return {
    main_module: metadata.mainModule,
    compatibility_date: metadata.compatibilityDate,
    compatibility_flags: metadata.compatibilityFlags,
    bindings: metadata.durableObjects.map((binding) => ({
      type: 'durable_object_namespace',
      name: binding.name,
      class_name: binding.className,
    })),
    ...(migrations ? { migrations } : {}),
    keep_bindings: [...KEPT_BINDING_TYPES],
    tags,
  };
}

async function sha256Prefixed(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

interface CloudflareApiEnvelope {
  success: boolean;
  /** `code: message` per API error. */
  errors: string[];
}

async function uploadScript(env: Env, tenant: string, bundle: ArrayBuffer, metadata: ScriptUploadMetadata): Promise<DeployFailure | null> {
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.append(metadata.main_module, new Blob([bundle], { type: 'application/javascript+module' }), metadata.main_module);
  const url = `${CLOUDFLARE_API}/accounts/${env.CF_ACCOUNT_ID}/workers/dispatch/namespaces/${env.DISPATCH_NAMESPACE}/scripts/tenant-${tenant}`;
  let response: Response;
  try {
    response = await fetch(url, { method: 'PUT', headers: { authorization: `Bearer ${env.CF_API_TOKEN}` }, body: form });
  } catch (error) {
    return { status: 502, code: 'UPLOAD_UNREACHABLE', message: error instanceof Error ? error.message : String(error) };
  }
  let envelope: CloudflareApiEnvelope | null = null;
  try {
    const parsed: unknown = await response.json();
    if (parsed && typeof parsed === 'object' && 'success' in parsed && typeof parsed.success === 'boolean') {
      const errors: string[] = [];
      if ('errors' in parsed && Array.isArray(parsed.errors)) {
        for (const entry of parsed.errors) {
          if (!entry || typeof entry !== 'object') continue;
          const code = 'code' in entry && typeof entry.code === 'number' ? String(entry.code) : '?';
          const message = 'message' in entry && typeof entry.message === 'string' ? entry.message : 'unknown';
          errors.push(`${code}: ${message}`);
        }
      }
      envelope = { success: parsed.success, errors };
    }
  } catch {
    envelope = null;
  }
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
async function probeHealth(env: Env, tenant: string, expectedSha: string | null): Promise<Probe> {
  let version: string | null = null;
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, Number(env.DEPLOY_PROBE_DELAY_MS));
      await promise;
    }
    try {
      const response = await env.DISPATCHER.get(`tenant-${tenant}`).fetch('https://tenant/healthz');
      version = response.headers.get(WORKER_VERSION_HEADER);
      if (response.ok && version !== null && (expectedSha === null || version === expectedSha)) return { healthy: true, version };
    } catch (error) {
      console.error(JSON.stringify({ event: 'deploy-probe-failed', tenant, attempt, message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { healthy: false, version };
}

interface Candidate {
  /** Release sha, or `channel` for our build (whose stamp is only known after the probe). */
  sha: string;
  bundleKey: string;
  bundle: ArrayBuffer;
  metadata: WorkerReleaseMetadata;
}

type Deployments = DurableObjectStub<TenantDeploymentsDO>;

async function loadFallback(env: Env, state: TenantDeploymentState, exclude: string): Promise<Candidate | null> {
  const active: TenantDeployRecord | null = state.active && state.active.sha !== exclude ? state.active : null;
  if (active) {
    const object = await env.RELEASES.get(active.bundleKey);
    if (object) return { sha: active.sha, bundleKey: active.bundleKey, bundle: await object.arrayBuffer(), metadata: active.metadata };
  }
  return loadChannel(env);
}

async function loadChannel(env: Env): Promise<Candidate | null> {
  const [bundle, metadata] = await Promise.all([env.RELEASES.get(CHANNEL_BUNDLE_KEY), env.RELEASES.get(CHANNEL_METADATA_KEY)]);
  if (!bundle || !metadata) return null;
  const parsed = workerReleaseMetadataSchema.safeParse(await metadata.json());
  if (!parsed.success) return null;
  return { sha: CHANNEL_SHA, bundleKey: CHANNEL_BUNDLE_KEY, bundle: await bundle.arrayBuffer(), metadata: parsed.data };
}

/**
 * Upload → probe → (auto-revert). Assumes the caller holds the tenant lease;
 * `recordDeploy` releases it on every exit except an upload rejection, where
 * nothing changed on Cloudflare and the caller releases explicitly.
 */
async function swap(env: Env, tenant: string, deployments: Deployments, state: TenantDeploymentState, candidate: Candidate, autoRevert: boolean): Promise<DeployResult> {
  const expectedSha = candidate.sha === CHANNEL_SHA ? null : candidate.sha;
  const delta = migrationDelta(candidate.metadata.migrations, state.appliedMigrationTag);
  const rejected = await uploadScript(env, tenant, candidate.bundle, scriptUploadMetadata(candidate.metadata, delta, [tenant, candidate.sha]));
  if (rejected) {
    await deployments.releaseLease();
    return { status: 'error', error: rejected };
  }
  const appliedMigrationTag = delta ? delta.new_tag : state.appliedMigrationTag;
  const probe = await probeHealth(env, tenant, expectedSha);
  const sha = probe.version ?? candidate.sha;
  if (probe.healthy) {
    await deployments.recordDeploy({ sha, bundleKey: candidate.bundleKey, metadata: candidate.metadata, healthy: true, revertedTo: null, appliedMigrationTag });
    return { status: 'ok', value: { sha, healthy: true, revertedTo: null, appliedMigrationTag } };
  }

  const fallback = autoRevert ? await loadFallback(env, state, candidate.sha) : null;
  let revertedTo: string | null = null;
  if (fallback) {
    const fallbackDelta = migrationDelta(fallback.metadata.migrations, appliedMigrationTag);
    const fallbackRejected = await uploadScript(env, tenant, fallback.bundle, scriptUploadMetadata(fallback.metadata, fallbackDelta, [tenant, fallback.sha]));
    if (fallbackRejected) {
      console.error(JSON.stringify({ event: 'deploy-revert-rejected', tenant, sha: candidate.sha, message: fallbackRejected.message }));
    } else {
      const fallbackProbe = await probeHealth(env, tenant, fallback.sha === CHANNEL_SHA ? null : fallback.sha);
      const fallbackSha = fallbackProbe.version ?? fallback.sha;
      if (fallbackProbe.healthy) {
        revertedTo = fallbackSha;
        await deployments.recordDeploy({
          sha: fallbackSha,
          bundleKey: fallback.bundleKey,
          metadata: fallback.metadata,
          healthy: true,
          revertedTo: null,
          appliedMigrationTag: fallbackDelta ? fallbackDelta.new_tag : null,
        });
      }
    }
  }
  await deployments.recordDeploy({ sha: candidate.sha, bundleKey: candidate.bundleKey, metadata: candidate.metadata, healthy: false, revertedTo, appliedMigrationTag });
  return { status: 'ok', value: { sha: candidate.sha, healthy: false, revertedTo, appliedMigrationTag } };
}

export async function deployTenantWorker(env: Env, tenant: string, request: PlatformDeployRequest): Promise<DeployResult> {
  const object = await env.DATA.get(request.bundleKey);
  if (!object) return { status: 'error', error: { status: 404, code: 'BUNDLE_NOT_FOUND', message: `No object at ${request.bundleKey}` } };
  const bundle = await object.arrayBuffer();
  const hash = await sha256Prefixed(bundle);
  if (hash !== request.bundleHash) {
    return { status: 'error', error: { status: 409, code: 'BUNDLE_HASH_MISMATCH', message: `Bundle hashes to ${hash}, expected ${request.bundleHash}` } };
  }
  const bundleKey = `tenants/${tenant}/${request.sha}/worker.mjs`;
  await env.RELEASES.put(bundleKey, bundle, { httpMetadata: { contentType: 'application/javascript+module' } });

  const deployments = env.DEPLOYMENTS.getByName(tenant);
  const lease = await deployments.acquireLease();
  if (lease.status === 'error') return { status: 'error', error: { status: 409, ...lease.error } };
  return swap(env, tenant, deployments, lease.value, { sha: request.sha, bundleKey, bundle, metadata: request.metadata }, true);
}

export async function revertTenantWorker(env: Env, tenant: string, to: 'previous' | 'channel'): Promise<DeployResult> {
  const deployments = env.DEPLOYMENTS.getByName(tenant);
  const lease = await deployments.acquireLease();
  if (lease.status === 'error') return { status: 'error', error: { status: 409, ...lease.error } };
  const state = lease.value;

  let candidate: Candidate | null = null;
  if (to === 'previous') {
    const previous = state.previous;
    const object = previous ? await env.RELEASES.get(previous.bundleKey) : null;
    if (previous && object) candidate = { sha: previous.sha, bundleKey: previous.bundleKey, bundle: await object.arrayBuffer(), metadata: previous.metadata };
  } else {
    candidate = await loadChannel(env);
  }
  if (!candidate) {
    await deployments.releaseLease();
    return {
      status: 'error',
      error: {
        status: 409,
        code: to === 'previous' ? 'NO_PREVIOUS_RELEASE' : 'CHANNEL_UNAVAILABLE',
        message: to === 'previous' ? 'No earlier healthy release to restore' : 'Channel bundle is not published to RELEASES',
      },
    };
  }
  return swap(env, tenant, deployments, state, candidate, false);
}
