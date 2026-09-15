import { cloudImageReferenceSchema } from '@gitspace/protocol/cloud-image';

export interface ComputeImageDeployment {
  id: string;
  image: string;
  script: string;
  namespaceId: string | null;
  applicationId: string | null;
  ready: boolean;
  deleting?: boolean;
}

export class ComputeProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
}

export function loadComputeImage(storage: DurableObjectStorage, id: string): ComputeImageDeployment | null {
  const row = storage.sql.exec<{ value: string }>('SELECT value FROM compute_images WHERE id = ?', id).toArray()[0];
  return row ? JSON.parse(row.value) as ComputeImageDeployment : null;
}
function saveImage(storage: DurableObjectStorage, image: ComputeImageDeployment): void {
  storage.sql.exec('INSERT INTO compute_images(id,value) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value', image.id, JSON.stringify(image));
}

async function cloudflare(env: Env, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(env.CF_ACCOUNT_ID)}${path}`, {
    ...init, headers: { ...init?.headers, authorization: `Bearer ${env.CF_API_TOKEN}` }, redirect: 'manual', signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok && !(init?.method === 'DELETE' && response.status === 404)) {
    const body = await response.json().catch(() => null) as { errors?: Array<{ message?: string }> } | null;
    throw new ComputeProviderError('COMPUTE_PROVIDER_REJECTED', `Cloudflare rejected ${init?.method ?? 'GET'} ${path} (${response.status}): ${body?.errors?.map((error) => error.message).join('; ').slice(0, 512) ?? 'provider request failed'}`);
  }
  return response;
}
async function cloudflareJson<T>(env: Env, path: string, init?: RequestInit): Promise<T> {
  const body = await (await cloudflare(env, path, init)).json() as T & { success?: boolean; result?: T };
  if (body.success === false) throw new ComputeProviderError('COMPUTE_PROVIDER_REJECTED', `Cloudflare rejected ${path}`);
  return body.result ?? body;
}

interface ContainerApplication { id: string; durable_objects?: { namespace_id?: string }; configuration: { image?: string; vcpu?: number; memory_mib?: number; disk?: { size_mb?: number } }; max_instances?: number }
interface ProviderNamespace { id: string; script: string; dispatch_namespace?: string; class: string; use_containers?: boolean }

async function findProviderNamespace(env: Env, script: string): Promise<ProviderNamespace | undefined> {
  for (let page = 1; ; page += 1) {
    const body = await (await cloudflare(env, `/workers/durable_objects/namespaces?per_page=1000&page=${page}`)).json() as {
      success: boolean; result: ProviderNamespace[]; result_info: { page: number; per_page: number; total_count: number };
    };
    if (!body.success || !Array.isArray(body.result) || !body.result_info) throw new ComputeProviderError('COMPUTE_NAMESPACE_INVALID', 'Cloudflare returned an invalid namespace page');
    const namespace = body.result.find((item) => item.script === script && item.dispatch_namespace === env.DISPATCH_NAMESPACE && item.class === 'GitSpaceSandbox');
    if (namespace) return namespace;
    if (page * body.result_info.per_page >= body.result_info.total_count) return undefined;
    if (body.result_info.page !== page || body.result.length === 0) throw new ComputeProviderError('COMPUTE_NAMESPACE_INVALID', 'Cloudflare namespace pagination did not advance');
  }
}

async function deleteUnusedImage(env: Env, storage: DurableObjectStorage, image: ComputeImageDeployment): Promise<void> {
  image.deleting = true;
  image.ready = false;
  saveImage(storage, image);
  if (image.applicationId) {
    const response = await cloudflare(env, `/containers/applications/${encodeURIComponent(image.applicationId)}`, { method: 'DELETE' });
    if (response.status !== 404 && (await response.json().catch(() => null) as { success?: boolean } | null)?.success === false) {
      throw new ComputeProviderError('COMPUTE_IMAGE_DELETE_FAILED', 'Cloudflare did not delete the unused image application');
    }
    image.applicationId = null;
    saveImage(storage, image);
  }
  const response = await cloudflare(env, `/workers/dispatch/namespaces/${encodeURIComponent(env.DISPATCH_NAMESPACE)}/scripts/${image.script}`, { method: 'DELETE' });
  if (response.status !== 404 && (await response.json().catch(() => null) as { success?: boolean } | null)?.success === false) {
    throw new ComputeProviderError('COMPUTE_IMAGE_DELETE_FAILED', 'Cloudflare did not delete the unused image namespace');
  }
  storage.sql.exec('DELETE FROM compute_images WHERE id = ?', image.id);
}

/** Caller serializes provider mutations. Active, stopped, and in-flight machine placements all retain their image resources. */
async function reclaimImageSlot(env: Env, storage: DurableObjectStorage): Promise<boolean> {
  const referenced = new Set<string>();
  for (const row of storage.sql.exec<{ value: string }>('SELECT value FROM compute_machines')) {
    const placement = JSON.parse(row.value) as { deploymentId: string | null; transfer: { target: { deploymentId: string | null } } | null };
    if (placement.deploymentId) referenced.add(placement.deploymentId);
    if (placement.transfer?.target.deploymentId) referenced.add(placement.transfer.target.deploymentId);
  }
  for (const row of storage.sql.exec<{ value: string }>('SELECT value FROM compute_images ORDER BY rowid')) {
    const image = JSON.parse(row.value) as ComputeImageDeployment;
    if (!referenced.has(image.id)) {
      await deleteUnusedImage(env, storage, image);
      return true;
    }
  }
  return false;
}

/** Content-address the trusted provider code as well as the tenant's image. Never mutate an existing image application. */
export async function prepareComputeImage(input: {
  env: Env; storage: DurableObjectStorage; tenant: string; accountId: string; image: string;
}): Promise<ComputeImageDeployment> {
  const { env, storage, tenant, accountId } = input;
  const image = cloudImageReferenceSchema.parse(input.image);
  const source = await cloudflare(env, `/workers/scripts/${encodeURIComponent(env.COMPUTE_TEMPLATE_SCRIPT)}`);
  const entrypoint = source.headers.get('cf-entrypoint');
  if (!entrypoint) throw new ComputeProviderError('COMPUTE_TEMPLATE_INVALID', 'Provider template has no module entrypoint');
  const form = await source.formData();
  const modules: Array<{ name: string; blob: Blob; hash: string }> = [];
  for (const [name, value] of form) {
    if (name === 'metadata') continue;
    const blob = typeof value === 'string' ? new Blob([value], { type: 'application/javascript+module' }) : value;
    const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    modules.push({ name, blob, hash: Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('') });
  }
  modules.sort((left, right) => left.name.localeCompare(right.name));
  if (!modules.some((module) => module.name === entrypoint)) throw new ComputeProviderError('COMPUTE_TEMPLATE_INVALID', 'Provider template entrypoint is missing');
  const maxInstances = Number(env.COMPUTE_MAX_MACHINES);
  const maxImages = Number(env.COMPUTE_MAX_IMAGE_DEPLOYMENTS);
  if (!Number.isSafeInteger(maxInstances) || maxInstances < 1 || !Number.isSafeInteger(maxImages) || maxImages < 1) {
    throw new ComputeProviderError('COMPUTE_CONFIGURATION_INVALID', 'Compute resource limits are not configured', 503);
  }
  const observability = { enabled: true, head_sampling_rate: 1, redact_query_string: true, logs: { enabled: true, invocation_logs: true, persist: true } };
  const identity = JSON.stringify({ tenant, accountId, image, entrypoint, modules: modules.map(({ name, hash }) => ({ name, hash })),
    compatibilityDate: '2026-08-29', className: 'GitSpaceSandbox', instanceType: 'standard-1', maxInstances, hostname: env.COMPUTE_SANDBOX_HOSTNAME, observability });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  let deployment = loadComputeImage(storage, id);
  if (deployment?.deleting) {
    await deleteUnusedImage(env, storage, deployment);
    deployment = null;
  }
  if (deployment?.ready) return deployment;
  if (!deployment) {
    const count = storage.sql.exec<{ count: number }>('SELECT COUNT(*) AS count FROM compute_images').one().count;
    if (count >= maxImages && !await reclaimImageSlot(env, storage)) throw new ComputeProviderError('COMPUTE_IMAGE_LIMIT', 'All of this tenant’s image deployment slots are retained by machines');
    deployment = { id, image, script: `gsc-${id.slice(0, 48)}`, namespaceId: null, applicationId: null, ready: false };
    saveImage(storage, deployment);
  }
  // Namespace identity, not application name, reconciles an upload/create whose response was lost.
  let namespace = await findProviderNamespace(env, deployment.script);
  if (!namespace) {
    const upload = new FormData();
    upload.set('metadata', JSON.stringify({
      main_module: entrypoint, compatibility_date: '2026-08-29', compatibility_flags: ['nodejs_compat'],
      observability,
      bindings: [
        { type: 'durable_object_namespace', name: 'Sandbox', class_name: 'GitSpaceSandbox' },
        { type: 'plain_text', name: 'PROVIDER_ACCOUNT_ID', text: accountId },
        { type: 'plain_text', name: 'PROVIDER_IMAGE', text: image },
        { type: 'plain_text', name: 'SANDBOX_HOSTNAME', text: env.COMPUTE_SANDBOX_HOSTNAME },
      ],
      containers: [{ class_name: 'GitSpaceSandbox' }],
      migrations: { new_tag: 'compute-image-v1', steps: [{ new_sqlite_classes: ['GitSpaceSandbox'] }] },
    }));
    for (const module of modules) upload.set(module.name, module.blob, module.name);
    await cloudflare(env, `/workers/dispatch/namespaces/${encodeURIComponent(env.DISPATCH_NAMESPACE)}/scripts/${deployment.script}`, { method: 'PUT', body: upload });
    namespace = await findProviderNamespace(env, deployment.script);
  }
  if (!namespace?.use_containers) throw new ComputeProviderError('COMPUTE_NAMESPACE_PENDING', 'Container-backed provider namespace is not available yet; retry preparation');
  if (deployment.namespaceId && deployment.namespaceId !== namespace.id) throw new ComputeProviderError('COMPUTE_NAMESPACE_CHANGED', 'Provider namespace identity changed');
  deployment.namespaceId = namespace.id;
  saveImage(storage, deployment);
  const applications = await cloudflareJson<ContainerApplication[]>(env, '/containers/applications');
  const matches = applications.filter((application) => application.durable_objects?.namespace_id === namespace.id);
  if (matches.length > 1) throw new ComputeProviderError('COMPUTE_APPLICATION_AMBIGUOUS', 'More than one application is bound to this image namespace');
  let application = matches[0];
  if (!application) {
    application = await cloudflareJson<ContainerApplication>(env, '/containers/applications', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      name: deployment.script, scheduling_policy: 'default', instances: 0, max_instances: maxInstances,
      configuration: { image, instance_type: 'standard-1' }, durable_objects: { namespace_id: namespace.id },
    }) });
  }
  if (deployment.applicationId && deployment.applicationId !== application.id) throw new ComputeProviderError('COMPUTE_APPLICATION_CHANGED', 'Image application identity changed');
  deployment.applicationId = application.id;
  saveImage(storage, deployment);
  if (application.configuration.image !== image || application.configuration.vcpu !== 0.5 ||
      application.configuration.memory_mib !== 4096 || application.configuration.disk?.size_mb !== 8000 || application.max_instances !== maxInstances) {
    throw new ComputeProviderError('COMPUTE_APPLICATION_CHANGED', 'Immutable image application configuration does not match its declaration');
  }
  const response = await env.DISPATCHER.get(deployment.script).fetch(new Request('https://compute.internal/_image/preflight', {
    method: 'POST', headers: { 'x-gitspace-user-id': accountId },
  }));
  if (!response.ok) throw new ComputeProviderError('COMPUTE_IMAGE_INCOMPATIBLE', `Image startup check failed (${response.status}): ${(await response.text()).slice(0, 512)}`);
  const result = await response.json() as { status?: string };
  if (result.status !== 'ok') throw new ComputeProviderError('COMPUTE_IMAGE_INCOMPATIBLE', 'Image did not acknowledge the provider startup contract');
  deployment.ready = true;
  saveImage(storage, deployment);
  return deployment;
}
