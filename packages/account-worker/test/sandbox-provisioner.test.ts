import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { controlCloudflareSandboxMachine, createCloudflareSandboxMachine } from '../src/sandbox-provisioner.js';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';
import { createSignedControlRequest, credentialProtocolBase64 } from '@gitspace/protocol';
import { controlFleetMachine, provisionManagedSandbox, reconcileFleetMachines } from '../src/application.js';
import { FleetCatalogDO } from '../src/fleet-catalog.js';

const image = `docker.io/example/runtime@sha256:${'a'.repeat(64)}`;

describe('Cloudflare Sandbox tenant platform integration', () => {
  it('returns provider readiness without publishing an unconfirmed fleet record', async () => {
    const userId = env.ACCOUNT_ID;
    const environment = { GITSPACE_MACHINE_ID: 'sandbox-build-a' };
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes`, ({ request }) => {
      if (request.headers.get('x-gitspace-provider-token') !== env.PLATFORM_TOKEN) return new HttpResponse(null, { status: 403 });
      return HttpResponse.json({ status: 'ok', machine: { id: 'sandbox-build-a', label: 'Cloudflare build-a', state: 'online', rpcEndpoint: 'https://sandbox.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'Machine runtime ready', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null } });
    }));
    const machine = await createCloudflareSandboxMachine({
      env,
      userId,
      machineId: 'sandbox-build-a',
      image,
      environment,
    });
    expect(machine).toMatchObject({ id: 'sandbox-build-a', kind: 'sandbox', state: 'online', rpcEndpoint: 'https://sandbox.example/rpc' });
    expect(await env.FLEET_CATALOG.getByName(userId).listMachines()).toEqual([]);
  });

  it('rejects provider failure instead of returning a ready machine', async () => {
    const userId = env.ACCOUNT_ID;
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes`, () => HttpResponse.json({ status: 'error', error: 'container failed readiness' }, { status: 503 })));
    await expect(createCloudflareSandboxMachine({
      env,
      userId,
      machineId: 'sandbox-broken',
      image,
      environment: { GITSPACE_MACHINE_ID: 'sandbox-broken' },
    })).rejects.toThrow();
    expect(await env.FLEET_CATALOG.getByName(userId).listMachines()).toEqual([]);
  });
  it('routes sleep, resume, and destroy through the tenant provider', async () => {
    network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes/sandbox-a/:action`, ({ params, request }) => {
      if (request.headers.get('x-gitspace-provider-token') !== env.PLATFORM_TOKEN) return new HttpResponse(null, { status: 403 });
      const action = String(params.action);
      return HttpResponse.json({ status: 'ok', value: action === 'destroy' ? { machineId: 'sandbox-a' } : { id: 'sandbox-a', label: 'Sandbox A', state: action === 'sleep' ? 'offline' : 'online', rpcEndpoint: action === 'sleep' ? null : 'https://sandbox.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: action, desiredState: action === 'sleep' ? 'offline' : 'online', lifecycleRevision: 2, operationId: null, error: null } });
    }));
    expect(await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: 'sandbox-a', action: 'sleep' })).toMatchObject({ state: 'offline', rpcEndpoint: null });
    expect(await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: 'sandbox-a', action: 'resume' })).toMatchObject({ state: 'online', rpcEndpoint: 'https://sandbox.example/rpc' });
    expect(await controlCloudflareSandboxMachine({ env, userId: env.ACCOUNT_ID, machineId: 'sandbox-a', action: 'destroy' })).toBeNull();
  });
});

async function provisionFixture() {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(7)) });
  const storage = env.USER_STORAGE.getByName(userId);
  await storage.beginProvisioning({ userId, gitBucketName: 'test-bucket' });
  await storage.markReady({ userId, gitBucketName: 'test-bucket' });
  const settings = env.USER_SETTINGS.getByName(userId);
  await settings.setHandle('owner', (await settings.get('owner')).revision, env.TENANT_ID);
  const catalog = env.FLEET_CATALOG.getByName(userId);
  const calls: string[] = [];
  const enrollments: Array<{ userId: string; machineId: string; image: string; environment: Record<string, string> }> = [];
  const faults = { prepare: false, lostResponse: false, status: false };
  const hold = { prepare: null as Promise<void> | null, enroll: null as Promise<void> | null, ready: null as Promise<void> | null };
  let destroyed = false;
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, async ({ request }) => {
    const path = new URL(request.url).pathname.split('/provider/compute')[1]!;
    calls.push(path);
    if (path === '/v1/images/default') return HttpResponse.json({ status: 'ok', value: { image } });
    if (path === '/v1/images/prepare') {
      await hold.prepare;
      return faults.prepare ? HttpResponse.json({ status: 'error', error: 'preflight failed' }, { status: 503 })
        : HttpResponse.json({ status: 'ok', value: { image, deploymentId: 'prepared' } });
    }
    if (path.endsWith('/destroy')) {
      destroyed = true;
      return HttpResponse.json({ status: 'ok', value: { machineId: path.split('/').at(-2) } });
    }
    if (path === '/v1/sandboxes') {
      enrollments.push(await request.json() as typeof enrollments[number]);
      await hold.enroll;
      // Exercise accidental provider error echo without leaking real credentials
      // from the assertion output or the public fleet record.
      if (faults.lostResponse || destroyed) return HttpResponse.json({ status: 'error', error: enrollments[0]!.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY }, { status: 503 });
    }
    if (path.endsWith('/resume')) {
      await hold.ready;
    }
    if (path.endsWith('/image/status')) return HttpResponse.json({ status: 'ok', value: { image, operationId: null, prepared: false, runtimeStarted: true } });
    if (path.endsWith('/status') && faults.status) return HttpResponse.json({ status: 'error', error: 'status unavailable' }, { status: 503 });
    const enrolled = enrollments.at(-1)!;
    const machine = { id: enrolled.machineId, label: 'Provider runtime', state: path === '/v1/sandboxes' ? 'offline' : 'online', rpcEndpoint: 'https://provider.example/rpc', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: enrolled.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY, desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null };
    return HttpResponse.json({ status: 'ok', [path === '/v1/sandboxes' ? 'machine' : 'value']: machine });
  }));
  return { userId, vault, catalog, calls, enrollments, faults, hold };
}

it('acknowledges durable private enrollment before preflight and fences premature registration and image changes', async () => {
  const f = await provisionFixture();
  const gate = Promise.withResolvers<void>();
  f.hold.prepare = gate.promise;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL);
  try {
    expect(machine).toMatchObject({ state: 'provisioning', desiredState: 'online' });
    expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(true);
    const registered = await f.catalog.putMachine({ ...machine, state: 'online', operationId: null, rpcEndpoint: 'https://premature.example/rpc' });
    expect(registered.state).toBe('provisioning');
    await expect(Promise.resolve(f.catalog.startCloudImage({ userId: f.userId, machineId: machine.id, operationId: crypto.randomUUID(), selection: { kind: 'custom', image } }))).rejects.toThrow();
    await expect(controlFleetMachine(env, f.userId, machine.id, 'sleep')).rejects.toThrow();
    expect((await reconcileFleetMachines(env, f.userId, f.catalog))[0]?.state).toBe('provisioning');
    expect(f.enrollments.length).toBe(0);
    const retained = await runInDurableObject(f.catalog, (_instance, state) => {
      const row = state.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machine.id).one();
      const enrollment = JSON.parse(row.enrollment_json) as { choice: { image: string }; environment: Record<string, string> };
      const observable = JSON.stringify(state.storage.sql.exec('SELECT value_json FROM app_changes').toArray());
      return { image: enrollment.choice.image, keyRetained: !!enrollment.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY, secretInEvents: Object.entries(enrollment.environment).some(([key, value]) => /PRIVATE_KEY|TOKEN|ARTIFACT_KEY/u.test(key) && observable.includes(value)) };
    });
    expect(retained).toEqual({ image, keyRetained: true, secretInEvents: false });
  } finally { gate.resolve(); }
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'online', error: null });
  expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(false);
  const visible = JSON.stringify(await f.catalog.listMachines());
  expect(visible.includes(f.enrollments[0]!.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY!)).toBe(false);
});

it('keeps accepted enrollment private and admission closed until the runtime is healthy', async () => {
  const f = await provisionFixture();
  const ready = Promise.withResolvers<void>();
  f.hold.ready = ready.promise;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL);
  try {
    await expect.poll(() => f.calls.includes(`/v1/sandboxes/${machine.id}/resume`)).toBe(true);
    expect(await f.catalog.getMachine(machine.id)).toMatchObject({ state: 'provisioning', rpcEndpoint: null });
    expect(await f.catalog.cloudImage(machine.id)).toMatchObject({ currentImage: null, desiredImage: image });
    expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(true);
  } finally { ready.resolve(); }
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'online', error: null });
  expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(false);
});

it('keeps provider-accepted failures durable and explicit Start reuses the same enrollment and immutable image', async () => {
  const f = await provisionFixture();
  f.faults.lostResponse = true;
  f.faults.status = true;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL, { kind: 'custom', image });
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'error', operationId: null });
  expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(true);
  const first = f.enrollments[0]!;
  const visible = JSON.stringify(await f.catalog.listMachines());
  expect(visible.includes(first.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY!)).toBe(false);
  await reconcileFleetMachines(env, f.userId, f.catalog);
  expect(f.enrollments.length).toBe(1);
  f.faults.lostResponse = false;
  f.faults.status = false;
  expect(await controlFleetMachine(env, f.userId, machine.id, 'resume')).toMatchObject({ id: machine.id, state: 'provisioning' });
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'online', error: null });
  expect(f.enrollments.length).toBe(2);
  expect(JSON.stringify(f.enrollments[1]) === JSON.stringify(first)).toBe(true);
  expect((await f.catalog.listMachines()).map(value => value.id)).toEqual([machine.id]);
  expect(await f.catalog.cloudImage(machine.id)).toMatchObject({ currentImage: image, desiredImage: image });
  const proof = createSignedControlRequest({ userId: f.userId, machineId: machine.id, operation: 'catalog.machine.list', payload: {}, signingPrivateKey: credentialProtocolBase64.decode(first.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY!) });
  expect(await f.vault.authorizeControl(proof, 'space.control')).toMatchObject({ status: 'ok' });
});

it('reconciles a lost create response once without allocating or reenrolling another machine', async () => {
  const f = await provisionFixture();
  f.faults.lostResponse = true;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL, { kind: 'custom', image });
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'online', error: null });
  expect(f.enrollments.length).toBe(1);
  expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(false);
});

it('exposes interrupted provisioning as retryable after reconstruction without losing its credentials', async () => {
  const f = await provisionFixture();
  const gate = Promise.withResolvers<void>();
  f.hold.prepare = gate.promise;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL, { kind: 'custom', image });
  await expect.poll(() => f.calls.includes('/v1/images/prepare')).toBe(true);
  try {
    await runInDurableObject(f.catalog, async (_instance, state) => {
      const before = state.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machine.id).one().enrollment_json;
      const restarted = new FleetCatalogDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect(restarted.getMachine(machine.id)).toMatchObject({ state: 'error', operationId: null });
      expect(state.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machine.id).one().enrollment_json === before).toBe(true);
      f.hold.prepare = null;
      expect(restarted.resumeSandboxProvisioning(f.userId, machine.id)).toMatchObject({ state: 'provisioning' });
    });
  } finally { gate.resolve(); }
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'online', error: null });
  await runInDurableObject(f.catalog, async (instance: FleetCatalogDO) => {
    // Drain the discarded isolate's suspended work before checking it cannot
    // enroll a second time after the replacement run has committed.
    const draining = instance as unknown as { provisioningRuns: Map<string, Promise<void>> };
    await Promise.all(draining.provisioningRuns.values());
  });
  expect(f.enrollments.length).toBe(1);
});

it.each(['prepare', 'enroll'] as const)('destroys pending %s work without late resurrection or reusable credentials', async phase => {
  const f = await provisionFixture();
  const gate = Promise.withResolvers<void>();
  f.hold[phase] = gate.promise;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL, { kind: 'custom', image });
  await expect.poll(() => f.calls.includes(phase === 'prepare' ? '/v1/images/prepare' : '/v1/sandboxes')).toBe(true);
  const proof = await runInDurableObject(f.catalog, (_instance, state) => {
    const row = state.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machine.id).one();
    const enrollment = JSON.parse(row.enrollment_json) as { environment: Record<string, string> };
    return createSignedControlRequest({ userId: f.userId, machineId: machine.id, operation: 'catalog.machine.list', payload: {}, signingPrivateKey: credentialProtocolBase64.decode(enrollment.environment.GITSPACE_MACHINE_SIGNING_PRIVATE_KEY!) });
  });
  try {
    expect(await controlFleetMachine(env, f.userId, machine.id, 'destroy')).toEqual({ machineId: machine.id, removed: true });
    expect(await f.catalog.hasPendingSandbox(machine.id)).toBe(false);
    expect(await f.vault.authorizeControl(proof, 'space.control')).toMatchObject({ status: 'error' });
  } finally { gate.resolve(); }
  await runInDurableObject(f.catalog, async (instance: FleetCatalogDO) => {
    // Test-only access drains background work; no production state is mutated.
    const draining = instance as unknown as { provisioningRuns: Map<string, Promise<void>> };
    await Promise.all(draining.provisioningRuns.values());
  });
  await expect(Promise.resolve(f.catalog.putMachine({ ...machine, state: 'online', operationId: null }))).rejects.toThrow();
  await expect(controlFleetMachine(env, f.userId, machine.id, 'resume')).rejects.toThrow();
  expect(await f.catalog.listMachines()).toEqual([]);
  expect(await f.catalog.cloudImage(machine.id)).toBeNull();
  expect(await f.catalog.wasMachineDestroyed(machine.id)).toBe(true);
});

it('retains enrollment when preflight fails before the provider has ever enrolled the machine', async () => {
  const f = await provisionFixture();
  f.faults.prepare = true;
  const machine = await provisionManagedSandbox(env, f.userId, env.ACCOUNT_URL, { kind: 'custom', image });
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'error', operationId: null });
  expect(f.enrollments.length).toBe(0);
  const retainedFingerprint = await runInDurableObject(f.catalog, async (_instance, state) => {
    const row = state.storage.sql.exec<{ enrollment_json: string }>('SELECT enrollment_json FROM sandbox_enrollments WHERE machine_id=?', machine.id).one();
    const retained = JSON.parse(row.enrollment_json) as { userId: string; machineId: string; choice: { image: string }; environment: Record<string, string> };
    const request = JSON.stringify({ userId: retained.userId, machineId: retained.machineId, environment: retained.environment, image: retained.choice.image });
    return credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request))));
  });
  f.faults.prepare = false;
  expect(await controlFleetMachine(env, f.userId, machine.id, 'resume')).toMatchObject({ state: 'provisioning' });
  await expect.poll(() => f.catalog.getMachine(machine.id)).toMatchObject({ state: 'online', error: null });
  const actualFingerprint = credentialProtocolBase64.encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(f.enrollments[0])))));
  expect(actualFingerprint).toBe(retainedFingerprint);
});
