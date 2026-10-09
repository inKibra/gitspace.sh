import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, expect, it, vi } from 'vitest';
import { invokeCompute, TenantComputeProvider } from '../src/compute-provider.js';
import { publishDefaultFixture } from './default-release-fixture.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });
const accountId = `u-${'a'.repeat(32)}`;
const imageA = `registry.example/tenant/a@sha256:${'a'.repeat(64)}`;
const imageB = `registry.example/tenant/b@sha256:${'b'.repeat(64)}`;
const imageC = `registry.example/tenant/c@sha256:${'c'.repeat(64)}`;
interface Holder {
  image: string | null; instance: string; prepared: boolean; retired: boolean; runtimeStarted: boolean;
  enrollment: { userId: string; machineId: string; environment: Record<string, string> } | null;
}
interface Application {
  id: string; durable_objects: { namespace_id: string }; configuration: { image: string; vcpu: number; memory_mib: number; disk: { size_mb: number } }; max_instances: number;
  instances: number;
  health?: { instances: { healthy: number; active: number; assigned: number; failed: number; starting: number; scheduling: number } };
}

function fixture(storage: DurableObjectStorage, maxImages = 16) {
  const namespaces = new Map<string, { id: string; script: string; dispatch_namespace: string; class: string; use_containers: boolean }>();
  const applications = new Map<string, Application>();
  const holders = new Map<string, Holder>();
  const faults = { applicationResponse: false, enrollmentResponse: false, retirementResponse: false, preflight: false, preflightInternal: false };
  const namespaceReadiness: Array<'missing' | 'pending'> = [];
  const preparedHealth = { instances: { healthy: 7, active: 0, assigned: 0, failed: 0, starting: 0, scheduling: 0 } };
  const applicationReadiness: Array<Application['health']> = [];
  const applicationRead: { observe?: (application: Application) => void; response?: Response } = {};
  let preflights = 0;
  let applicationCreates = 0;
  const bindings = { ...env, COMPUTE_TEMPLATE_SCRIPT: 'trusted-template',
    COMPUTE_SANDBOX_HOSTNAME: 'sandbox.example', COMPUTE_MAX_MACHINES: 20, COMPUTE_MAX_IMAGE_DEPLOYMENTS: maxImages } as unknown as Env;
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.pathname.replace(`/client/v4/accounts/${env.CF_ACCOUNT_ID}`, '');
    if (path === '/workers/scripts/trusted-template') {
      const form = new FormData();
      form.set('index.js', new Blob(['export default {}'], { type: 'application/javascript+module' }), 'index.js');
      return new Response(form, { headers: { 'cf-entrypoint': 'index.js' } });
    }
    if (path === '/workers/durable_objects/namespaces') {
      const page = Number(url.searchParams.get('page'));
      // A foreign namespace occupies the first page. Never reconcile by class/name alone.
      const readiness = namespaces.size ? namespaceReadiness[0] : undefined;
      const visible = readiness === 'missing' ? [] : [...namespaces.values()].map(namespace => ({ ...namespace, use_containers: readiness !== 'pending' }));
      const rows = [{ id: 'foreign', script: 'unrelated', dispatch_namespace: 'another-tenant', class: 'GitSpaceSandbox', use_containers: true }, ...visible];
      if (namespaces.size && page >= rows.length) namespaceReadiness.shift();
      return Response.json({ success: true, result: rows.slice(page - 1, page), result_info: { page, per_page: 1, total_count: rows.length } });
    }
    const script = /^\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/(.+)$/u.exec(path)?.[1];
    if (script) {
      if (request.method === 'DELETE') { namespaces.delete(script); return Response.json({ success: true }); }
      expect(request.method).toBe('PUT');
      namespaces.set(script, { id: `namespace-${script}`, script, dispatch_namespace: env.DISPATCH_NAMESPACE, class: 'GitSpaceSandbox', use_containers: true });
      return Response.json({ success: true });
    }
    if (path === '/containers/applications' && request.method === 'GET') {
      // A foreign durable_object-policy application need not have an application-wide image or prepared pool.
      return Response.json({ success: true, result: [{ id: 'foreign-application', scheduling_policy: 'durable_object' }, ...applications.values()] });
    }
    if (path === '/containers/applications' && request.method === 'POST') {
      const body = await request.json() as Omit<Application, 'id' | 'configuration'> & { configuration: { image: string } };
      // The Containers API expands instance_type into concrete resources; it does not echo the preset.
      const application: Application = { ...body, id: `application-${++applicationCreates}`,
        configuration: { image: body.configuration.image, vcpu: 0.5, memory_mib: 4096, disk: { size_mb: 8000 } },
        health: applicationReadiness.length ? applicationReadiness.shift() : preparedHealth };
      applications.set(application.id, application);
      if (faults.applicationResponse) { faults.applicationResponse = false; throw new Error('Application create response lost'); }
      return Response.json({ success: true, result: application });
    }
    if (path.startsWith('/containers/applications/') && request.method === 'GET') {
      if (applicationRead.response) return applicationRead.response.clone();
      const application = applications.get(path.slice('/containers/applications/'.length));
      if (!application) return Response.json({ success: false }, { status: 404 });
      if (applicationReadiness.length) application.health = applicationReadiness.shift();
      application.instances = 7;
      applicationRead.observe?.(application);
      return Response.json({ success: true, result: application });
    }
    if (path.startsWith('/containers/applications/') && request.method === 'DELETE') {
      applications.delete(path.slice('/containers/applications/'.length));
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected provider API operation ${request.method} ${path}`);
  };
  const fetcher = (script: string | null) => ({
    async fetch(request: Request): Promise<Response> {
      if (request.headers.get('x-gitspace-user-id') !== accountId || request.headers.has('x-gitspace-provider-token')) return new Response('Wrong account', { status: 403 });
      const path = new URL(request.url).pathname;
      if (path === '/_image/preflight') {
        preflights += 1;
        const application = [...applications.values()].find(value => value.durable_objects.namespace_id === namespaces.get(script ?? '')?.id);
        if (!application?.health || application.health.instances.healthy === 0) throw new Error('Container capacity is not prepared');
        if (faults.preflightInternal) throw new Error('internal error; reference = s3e6155h85p879ek0jafetmm');
        return faults.preflight
          ? Response.json({ status: 'error', error: { code: 'IMAGE_BOOTSTRAP_MISSING', message: 'Image bootstrap is missing' } }, { status: 409 })
          : Response.json({ status: 'ok' });
      }
      const body = path === '/v1/sandboxes' ? await request.json() as NonNullable<Holder['enrollment']> : null;
      const machineId = body?.machineId ?? path.split('/')[3]!;
      const instance = request.headers.get('x-gitspace-image-incarnation') ?? 'legacy';
      const key = `${script ?? 'legacy'}:${machineId}:${instance}`;
      let holder = holders.get(key);
      if (!holder) {
        const application = [...applications.values()].find(value => value.durable_objects.namespace_id === namespaces.get(script ?? '')?.id);
        holder = { image: application?.configuration.image ?? null, instance, prepared: false, retired: false, runtimeStarted: false, enrollment: null };
        holders.set(key, holder);
      }
      if (body) { holder.enrollment = body; holder.runtimeStarted = true; return Response.json({ status: 'ok', machine: { id: machineId } }); }
      if (path.endsWith('/_image/enrollment')) {
        if (request.method === 'GET') {
          if (!holder.prepared || !holder.enrollment) return new Response('Not prepared', { status: 409 });
          return Response.json(holder.enrollment);
        }
        holder.enrollment ??= await request.json() as NonNullable<Holder['enrollment']>;
        holder.prepared = true;
        if (faults.enrollmentResponse) { faults.enrollmentResponse = false; return new Response('Enrollment response lost', { status: 503 }); }
        return Response.json({ status: 'ok' });
      }
      if (path.endsWith('/_image/retire')) {
        const operation = request.headers.get('x-gitspace-image-operation');
        // Refuse retirement unless the destination already durably owns the complete enrollment.
        const destination = [...holders.values()].find(value => value.instance === operation);
        if (!destination?.enrollment || JSON.stringify(destination.enrollment) !== JSON.stringify(holder.enrollment)) throw new Error('Retirement would lose enrollment');
        holder.retired = true;
        if (faults.retirementResponse) { faults.retirementResponse = false; return new Response('Retirement response lost', { status: 503 }); }
        return Response.json({ status: 'ok' });
      }
      if (path.endsWith('/image/status')) return Response.json({ status: 'ok', value: { image: holder.image, operationId: instance === 'legacy' ? null : instance, prepared: holder.prepared, runtimeStarted: holder.runtimeStarted } });
      if (path.endsWith('/prepare-replacement')) { holder.prepared = true; return Response.json({ prepared: true, machineId }); }
      if (path.endsWith('/resume')) { holder.runtimeStarted = true; holder.prepared = false; }
      if (path.endsWith('/rpc') || path.endsWith('/resume')) return Response.json({ image: holder.image, instance: holder.instance, retired: holder.retired });
      throw new Error(`Unexpected sandbox operation ${request.method} ${path}`);
    },
  });
  bindings.DISPATCHER = { get: fetcher } as unknown as DispatchNamespace;
  bindings.COMPUTE = fetcher(null) as Fetcher;
  let provider = new TenantComputeProvider(storage, bindings, 'tenant-a', accountId, () => null);
  return {
    applications, holders, faults, namespaceReadiness, applicationReadiness, applicationRead, preparedHealth,
    preflights: () => preflights,
    creates: () => applicationCreates,
    restart: () => { provider = new TenantComputeProvider(storage, bindings, 'tenant-a', accountId, () => null); },
    rpc: (machineId: string) => invokeCompute(bindings, accountId, provider.rpcTarget(machineId), `/v1/sandboxes/${machineId}/rpc`, { method: 'POST' }),
    post: (path: string, body?: unknown) => provider.fetch(new Request(`https://compute.test${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gitspace-user-id': 'foreign', 'x-gitspace-provider-token': 'must-not-leak', 'x-gitspace-image-incarnation': crypto.randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })),
  };
}

it('pre-pin tenant creates a cloud machine using the authenticated current default image', async () => {
  const published = await publishDefaultFixture(env.RELEASES);
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    const response = await f.post('/v1/sandboxes', { machineId: 'sandbox-default', environment: {} });
    expect(response.status).toBe(200);
    expect([...f.applications.values()].map(application => application.configuration.image)).toEqual([published.image]);
    expect([...f.holders.values()].find(holder => holder.enrollment?.machineId === 'sandbox-default')?.runtimeStarted).toBe(true);
  });
});

it('prepares a new image on the first request while its namespace becomes visible and container-ready', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.namespaceReadiness.push('missing', 'pending');
    const prepared = await f.post('/v1/images/prepare', { image: imageA });
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    expect(await prepared.json()).toMatchObject({ status: 'ok', value: { image: imageA } });
    expect([...f.applications.values()].map(application => application.configuration.image)).toEqual([imageA]);
    expect(f.creates()).toBe(1);
    expect(f.preflights()).toBe(1);
  });
});

it('waits for prepared image capacity, not active containers or the declared instance count', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.applicationReadiness.push(
      undefined,
      { instances: { healthy: 0, active: 1, assigned: 1, failed: 0, starting: 1, scheduling: 1 } },
      { instances: { healthy: 1, active: 0, assigned: 0, failed: 0, starting: 6, scheduling: 0 } },
    );
    const prepared = await f.post('/v1/images/prepare', { image: imageA });
    expect(prepared.status, await prepared.clone().text()).toBe(200);
    expect(await prepared.json()).toMatchObject({ status: 'ok', value: { image: imageA } });
    expect(f.preflights()).toBe(1);
    expect((await f.post('/v1/images/prepare', { image: imageA })).status).toBe(200);
    expect(f.preflights()).toBe(1);
    expect(f.creates()).toBe(1);
  });
});

it('bounds application readiness and reconciles the same unready allocation after a timeout', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    f.applicationReadiness.push({ instances: { healthy: 0, active: 0, assigned: 0, failed: 0, starting: 7, scheduling: 0 } });
    f.applicationRead.observe = () => { now += 60_000; };
    const pending = await f.post('/v1/images/prepare', { image: imageA });
    expect(pending.status).toBe(503);
    expect(await pending.json()).toMatchObject({ status: 'error', error: { code: 'COMPUTE_APPLICATION_PENDING' } });
    expect(f.preflights()).toBe(0);
    f.applicationRead.observe = undefined;
    f.applicationReadiness.push(f.preparedHealth);
    f.restart();
    expect((await f.post('/v1/images/prepare', { image: imageA })).status).toBe(200);
    expect(f.preflights()).toBe(1);
    expect(f.creates()).toBe(1);
  });
});

it('rejects immutable application drift discovered while waiting for prepared capacity', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.applicationReadiness.push(undefined, f.preparedHealth);
    f.applicationRead.observe = application => { application.configuration.image = imageB; };
    const rejected = await f.post('/v1/images/prepare', { image: imageA });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ status: 'error', error: { code: 'COMPUTE_APPLICATION_CHANGED' } });
    expect(f.preflights()).toBe(0);
    expect(f.creates()).toBe(1);
  });
});

it('does not treat an application API rejection as provisioning progress', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.applicationReadiness.push(undefined);
    f.applicationRead.response = Response.json({ errors: [{ message: 'provider internal error' }] }, { status: 500 });
    const rejected = await f.post('/v1/images/prepare', { image: imageA });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ status: 'error', error: { code: 'COMPUTE_PROVIDER_REJECTED' } });
    expect(f.preflights()).toBe(0);
  });
});

it('does not retry a generic preflight internal error after prepared capacity is available', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.faults.preflightInternal = true;
    const rejected = await f.post('/v1/images/prepare', { image: imageA });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ status: 'error', error: { code: 'COMPUTE_OPERATION_FAILED' } });
    expect(f.preflights()).toBe(1);
  });
});

it('does not retry or pin an image whose startup check fails after namespace readiness', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.namespaceReadiness.push('pending');
    f.faults.preflight = true;
    const rejected = await f.post('/v1/images/prepare', { image: imageA });
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ status: 'error', error: { code: 'COMPUTE_IMAGE_INCOMPATIBLE' } });
    expect(f.preflights()).toBe(1);
    f.faults.preflight = false;
    expect((await f.post('/v1/images/prepare', { image: imageA })).status).toBe(200);
    expect(f.preflights()).toBe(2);
    expect(f.creates()).toBe(1);
  });
});

it('reconciles a lost application-create response after namespace pagination without allocating twice', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.faults.applicationResponse = true;
    expect((await f.post('/v1/images/prepare', { image: imageA })).status).toBe(409);
    f.restart();
    const prepared = await f.post('/v1/images/prepare', { image: imageA });
    expect(prepared.status, await prepared.text()).toBe(200);
    expect(f.creates()).toBe(1);
    expect([...f.applications.values()][0]?.configuration.image).toBe(imageA);
  });
});

it('rejects a reconciled application whose effective resources differ from the pinned instance type', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    f.faults.applicationResponse = true;
    expect((await f.post('/v1/images/prepare', { image: imageA })).status).toBe(409);
    const application = [...f.applications.values()][0]!;
    application.configuration.memory_mib = 8192;
    f.restart();
    const prepared = await f.post('/v1/images/prepare', { image: imageA });
    expect(prepared.status).toBe(409);
    expect(await prepared.json()).toMatchObject({ status: 'error', error: { code: 'COMPUTE_APPLICATION_CHANGED' } });
  });
});

it('requires a checkpoint and changes only the selected machine image and incarnation', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage);
    for (const machineId of ['sandbox-a', 'sandbox-b']) expect((await f.post('/v1/sandboxes', { machineId, environment: {}, image: imageA })).status).toBe(200);
    const beforeB = await (await f.rpc('sandbox-b')).json();
    const change = { image: imageB, operationId: crypto.randomUUID() };
    expect(await (await f.post('/v1/sandboxes/sandbox-a/image', change)).json()).toMatchObject({ error: { code: 'COMPUTE_NOT_PREPARED' } });
    await f.post('/v1/sandboxes/sandbox-a/prepare-replacement');
    expect((await f.post('/v1/sandboxes/sandbox-a/image', change)).status).toBe(200);
    expect(await (await f.post('/v1/sandboxes/sandbox-a/resume')).json()).toMatchObject({ image: imageB, instance: change.operationId, retired: false });
    expect(await (await f.rpc('sandbox-b')).json()).toEqual(beforeB);
    expect([...f.applications.values()].map(value => value.configuration.image).sort()).toEqual([imageA, imageB]);
  });
});

it('retains both sides of uncertain handoffs and keeps enrollment outside platform state', async () => {
  await runInDurableObject(env.DEPLOYMENTS.getByName(crypto.randomUUID()), async (_instance, state) => {
    const f = fixture(state.storage, 2);
    const secret = 'private-fixture-enrollment-material';
    await f.post('/v1/sandboxes', { machineId: 'sandbox-a', image: imageA, environment: { GITSPACE_CONTROL_TOKEN: secret } });
    await f.post('/v1/sandboxes/sandbox-a/prepare-replacement');
    const change = { image: imageB, operationId: crypto.randomUUID() };
    f.faults.enrollmentResponse = true;
    expect((await f.post('/v1/sandboxes/sandbox-a/image', change)).status).toBe(503);
    expect([...f.holders.values()].every(holder => !holder.retired)).toBe(true);
    f.restart();
    f.faults.retirementResponse = true;
    expect((await f.post('/v1/sandboxes/sandbox-a/image', change)).status).toBe(503);
    expect(await (await f.post('/v1/images/prepare', { image: imageC })).json()).toMatchObject({ error: { code: 'COMPUTE_IMAGE_LIMIT' } });
    expect(f.applications.size).toBe(2);
    expect(JSON.stringify(state.storage.sql.exec('SELECT value FROM compute_machines').toArray())).not.toContain(secret);
    f.restart();
    expect((await f.post('/v1/sandboxes/sandbox-a/image', change)).status).toBe(200);
    expect((await f.post('/v1/images/prepare', { image: imageC })).status).toBe(200);
    expect([...f.applications.values()].map(value => value.configuration.image).sort()).toEqual([imageB, imageC]);
    expect(await (await f.post('/v1/sandboxes/sandbox-a/image/status')).json()).toMatchObject({ value: { image: imageB, operationId: change.operationId, prepared: true, runtimeStarted: false } });
    expect((await f.post('/v1/sandboxes/sandbox-a/_image/enrollment')).status).toBe(403);
  });
});
