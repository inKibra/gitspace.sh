import { env } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { handleSandboxRollout } from '../src/sandbox-rollout.js';
import { HttpResponse, http } from 'msw';
import { network } from './network.js';

it('keeps admission fenced after partial preparation and cancels every attempted machine', async () => {
  const registry = env.ACCOUNT_STATE.getByName('account');
  const userId = env.ACCOUNT_ID;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  for (const id of ['sandbox-a', 'sandbox-b']) await catalog.putMachine({ id, label: id, state: 'online', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null });
  const quiesced = new Set<string>();
  let failCancel = true;
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes/:machine/:action`, ({ params, request }) => {
    const path = new URL(request.url).pathname;
    const machine = String(params.machine);
    if (path.endsWith('/prepare-replacement')) {
      quiesced.add(machine);
      return machine === 'sandbox-b' ? HttpResponse.json({ error: 'Object upload failed' }, { status: 503 }) : HttpResponse.json({ prepared: true });
    }
    if (path.endsWith('/cancel-replacement')) {
      if (machine === 'sandbox-b' && failCancel) return HttpResponse.json({ error: 'Recovery unavailable' }, { status: 503 });
      quiesced.delete(machine);
      return HttpResponse.json({ prepared: false });
    }
    throw new Error('Unexpected provider operation');
  }));
  const id = crypto.randomUUID();
  const image = `registry.cloudflare.com/1234/sandbox@sha256:${'a'.repeat(64)}`;
  const request = (action: string, body: object = { id }) => handleSandboxRollout(new Request(`https://auth.test/v1/operator/sandboxes/rollout/${action}`, { method: 'POST', body: JSON.stringify(body) }), env);
  expect((await request('prepare', { id, image }))?.status).toBe(409);
  expect(quiesced).toEqual(new Set(['sandbox-a', 'sandbox-b']));
  expect((await registry.sandboxRollout())?.prepared).toBe(false);
  expect((await request('finish', { id, image }))?.status).toBe(409);
  expect((await request('prepare', { id: crypto.randomUUID(), image }))?.status).toBe(409);
  expect((await request('cancel'))?.status).toBe(409);
  expect(await registry.sandboxRollout()).not.toBeNull();
  expect(quiesced).toEqual(new Set(['sandbox-b']));
  failCancel = false;
  expect((await request('cancel'))?.status).toBe(200);
  expect(quiesced.size).toBe(0);
  expect(await registry.sandboxRollout()).toBeNull();
});

it('retries a partially finished rollout without quiescing recovered machines again', async () => {
  const registry = env.ACCOUNT_STATE.getByName('account');
  const userId = env.ACCOUNT_ID;
  const catalog = env.FLEET_CATALOG.getByName(userId);
  for (const id of ['sandbox-a', 'sandbox-b']) await catalog.putMachine({ id, label: id, state: 'online', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null });
  const quiesced = new Set<string>();
  let failResume = true;
  network.use(http.post(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/v1/sandboxes/:machine/:action`, ({ params, request }) => {
    const path = new URL(request.url).pathname;
    const machine = String(params.machine);
    if (path.endsWith('/prepare-replacement')) {
      quiesced.add(machine);
      return HttpResponse.json({ prepared: true });
    }
    if (path.endsWith('/resume')) {
      if (machine === 'sandbox-b' && failResume) return HttpResponse.json({ error: 'Runtime unavailable' }, { status: 503 });
      quiesced.delete(machine);
      return HttpResponse.json({ state: 'online' });
    }
    throw new Error('Unexpected provider operation');
  }));
  const id = crypto.randomUUID();
  const image = `registry.cloudflare.com/1234/sandbox@sha256:${'b'.repeat(64)}`;
  const request = (action: string) => handleSandboxRollout(new Request(`https://auth.test/v1/operator/sandboxes/rollout/${action}`, { method: 'POST', body: JSON.stringify({ id, image }) }), env);
  expect((await request('prepare'))?.status).toBe(200);
  expect((await request('finish'))?.status).toBe(409);
  expect(quiesced).toEqual(new Set(['sandbox-b']));
  expect((await registry.sandboxRollout())?.recovering).toBe(true);
  expect((await request('prepare'))?.status).toBe(200);
  expect(quiesced).toEqual(new Set(['sandbox-b']));
  failResume = false;
  expect((await request('finish'))?.status).toBe(200);
  expect(quiesced.size).toBe(0);
  expect(await registry.sandboxRollout()).toBeNull();
});
