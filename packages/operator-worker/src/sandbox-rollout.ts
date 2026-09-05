import type { AccountRegistryDO } from './account-registry.js';
import type { FleetCatalogDO } from './fleet-catalog.js';

interface RolloutEnvironment {
  ACCOUNTS: DurableObjectNamespace;
  FLEET_CATALOG: DurableObjectNamespace;
  SANDBOX_PROVISIONER: Fetcher;
}

/** Called only after the operator Access identity has been verified. */
export async function handleSandboxRollout(request: Request, env: RolloutEnvironment): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/v1/operator/sandboxes/rollout')) return null;
  const registry = (env.ACCOUNTS as DurableObjectNamespace<AccountRegistryDO>).getByName('global');
  const catalogs = env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>;
  if (path === '/v1/operator/sandboxes/rollout' && request.method === 'GET') {
    return Response.json({ status: 'ok', value: await registry.sandboxRollout() }, { headers: { 'cache-control': 'no-store' } });
  }
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const body = await request.json() as { id?: unknown; image?: unknown };
  if (typeof body.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/u.test(body.id)) return Response.json({ error: 'Invalid rollout id' }, { status: 400 });
  if (!['/v1/operator/sandboxes/rollout/prepare', '/v1/operator/sandboxes/rollout/finish', '/v1/operator/sandboxes/rollout/cancel'].includes(path)) return new Response('Not found', { status: 404 });
  try {
    if (path.endsWith('/prepare')) {
      if (typeof body.image !== 'string' || !/^registry\.cloudflare\.com\/[a-f0-9]+\/[a-z0-9-]+@sha256:[a-f0-9]{64}$/u.test(body.image)) return Response.json({ error: 'An immutable container image is required' }, { status: 400 });
      const existing = await registry.beginSandboxRollout(body.id, body.image);
      if (existing.prepared) return Response.json({ status: 'ok', value: existing });
      for (const { userId } of await registry.sandboxRolloutAccounts()) {
        for (const machine of await catalogs.getByName(userId).listMachines()) {
          if (machine.provider !== 'cloudflare-sandbox' || machine.desiredState !== 'online') continue;
          await registry.recordSandboxPrepared(body.id, [{ userId, machineId: machine.id }]);
          const response = await env.SANDBOX_PROVISIONER.fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machine.id)}/prepare-replacement`, {
            method: 'POST', headers: { 'x-gitspace-user-id': userId },
          }));
          if (!response.ok) throw new Error(`Machine ${machine.id} did not acknowledge a durable checkpoint (HTTP ${response.status}); rollout remains blocked`);
          const result = await response.json() as { prepared?: boolean };
          if (result.prepared !== true) throw new Error(`Machine ${machine.id} returned no preparation acknowledgement`);
        }
      }
      return Response.json({ status: 'ok', value: await registry.markSandboxRolloutPrepared(body.id) });
    }
    const rollout = await registry.sandboxRollout();
    if (!rollout || rollout.id !== body.id) throw new Error('Rollout identity does not match');
    if (path.endsWith('/finish')) {
      // The operator script verifies Cloudflare's applied image before releasing this barrier.
      if (body.image !== rollout.image) throw new Error('Applied image does not match the prepared rollout');
      await registry.beginSandboxRolloutRecovery(body.id, true);
      for (const machine of rollout.machines) {
        const response = await env.SANDBOX_PROVISIONER.fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machine.machineId)}/resume`, {
          method: 'POST', headers: { 'x-gitspace-user-id': machine.userId },
        }));
        if (!response.ok) throw new Error(`Image rollout finished but machine ${machine.machineId} needs resume (HTTP ${response.status})`);
      }
      await registry.finishSandboxRollout(body.id);
      return Response.json({ status: 'ok', value: { finished: true } });
    }
    await registry.beginSandboxRolloutRecovery(body.id, false);
    for (const machine of rollout.machines) {
      const response = await env.SANDBOX_PROVISIONER.fetch(new Request(`https://sandbox.internal/v1/sandboxes/${encodeURIComponent(machine.machineId)}/cancel-replacement`, {
        method: 'POST', headers: { 'x-gitspace-user-id': machine.userId },
      }));
      if (!response.ok) throw new Error(`Machine ${machine.machineId} could not cancel preparation; rollout remains blocked`);
    }
    await registry.cancelSandboxRollout(body.id);
    return Response.json({ status: 'ok', value: { cancelled: true } });
  } catch (error) {
    return Response.json({ status: 'error', error: { code: 'SANDBOX_ROLLOUT_BLOCKED', message: error instanceof Error ? error.message : 'Sandbox rollout failed' } }, { status: 409, headers: { 'cache-control': 'no-store' } });
  }
}
