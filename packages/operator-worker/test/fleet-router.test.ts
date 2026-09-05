import { env, SELF } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { stringify } from 'devalue';
import { describe, expect, it } from 'vitest';
import type { FleetCatalogDO } from '../src/fleet-catalog.js';
import type { UserSettingsDO } from '../src/user-settings.js';
import { network } from './network.js';

describe('account fleet router', () => {
  it('skips observed-offline machines and fails over without a selected machine', async () => {
    const accountId = `u-${crypto.randomUUID().replaceAll('-', '').slice(0, 32)}`;
    await env.ACCOUNTS.getByName('global').upsertProvisioning({ userId: accountId, handle: 'bravo' });
    await env.ACCOUNTS.getByName('global').markActive({ userId: accountId, release: null });
    const settings = (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(accountId);
    const reserved = await settings.setHandle('test', 0, 'bravo');
    expect(reserved.status).toBe('ok');
    const catalog = (env.FLEET_CATALOG as DurableObjectNamespace<FleetCatalogDO>).getByName(accountId);
    const base = {
      label: 'machine',
      state: 'online' as const,
      kind: 'physical' as const,
      provider: 'physical' as const,
      notes: '',
      desiredState: 'online' as const,
      lifecycleRevision: 1,
      operationId: null,
      error: null,
    };
    await catalog.putMachine({ ...base, id: 'machine-0-offline', state: 'offline', rpcEndpoint: 'https://bravo.gssh.dev/tunnel/machine-0-offline/rpc' });
    await catalog.putMachine({ ...base, id: 'machine-a', rpcEndpoint: 'https://bravo.gssh.dev/tunnel/machine-a/rpc' });
    await catalog.putMachine({ ...base, id: 'machine-b', rpcEndpoint: 'https://bravo.gssh.dev/tunnel/machine-b/rpc' });

    const attempts: string[] = [];
    network.use(
      http.post('https://bravo.gssh.dev/tunnel/machine-0-offline/rpc', () => new HttpResponse(null, { status: 522 })),
      http.post('https://bravo.gssh.dev/tunnel/machine-a/rpc', ({ request }) => {
        attempts.push(new URL(request.url).pathname);
        return HttpResponse.json({ error: { code: 'MACHINE_OFFLINE' } }, { status: 503 });
      }),
      http.post('https://bravo.gssh.dev/tunnel/machine-b/rpc', ({ request }) => {
        attempts.push(new URL(request.url).pathname);
        expect(request.headers.get('x-gitspace-signed-target')).toBe('/rpc');
        return HttpResponse.json({ status: 'ok', value: { machineId: 'machine-b' } });
      }),
    );

    const response = await SELF.fetch('https://bravo.gitspace.sh/rpc', {
      method: 'POST',
      headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': accountId, 'x-gitspace-device': 'opaque-test-signature' },
      body: stringify({ v: 1, path: 'browserRelay.status', input: {} }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', value: { machineId: 'machine-b' } });
    expect(attempts).toEqual(['/tunnel/machine-a/rpc', '/tunnel/machine-b/rpc']);
  });
});
