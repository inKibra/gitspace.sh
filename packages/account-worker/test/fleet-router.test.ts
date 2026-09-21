import { env, SELF } from 'cloudflare:test';
import { HttpResponse, http } from 'msw';
import { stringify } from 'devalue';
import { describe, expect, it } from 'vitest';
import type { FleetCatalogDO } from '../src/fleet-catalog.js';
import type { UserSettingsDO } from '../src/user-settings.js';
import { network } from './network.js';

describe('account fleet router', () => {
  it('skips observed-offline machines but never replays an unknown mutation outcome elsewhere', async () => {
    const relayUrl = 'https://remote-relay.test';
    const accountId = env.ACCOUNT_ID;
    const settings = (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(accountId);
    await settings.setHandle('test', 0, env.TENANT_ID);
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
    await catalog.putMachine({ ...base, id: 'machine-0-offline', state: 'offline', rpcEndpoint: `${relayUrl}/tunnel/machine-0-offline/rpc` });
    await catalog.putMachine({ ...base, id: 'machine-a', rpcEndpoint: `${relayUrl}/tunnel/machine-a/rpc` });
    await catalog.putMachine({ ...base, id: 'machine-b', rpcEndpoint: `${relayUrl}/tunnel/machine-b/rpc` });

    const attempts: string[] = [];
    network.use(
      http.post(`${relayUrl}/tunnel/machine-0-offline/rpc`, () => new HttpResponse(null, { status: 522 })),
      http.post(`${relayUrl}/tunnel/machine-a/rpc`, ({ request }) => {
        attempts.push(new URL(request.url).pathname);
        return HttpResponse.json({ error: { code: 'MACHINE_UNAVAILABLE', message: 'The remote outcome may be unknown' } }, { status: 503 });
      }),
      http.post(`${relayUrl}/tunnel/machine-b/rpc`, ({ request }) => {
        attempts.push(new URL(request.url).pathname);
        expect(request.headers.get('x-gitspace-signed-target')).toBe('/rpc');
        return HttpResponse.json({ status: 'ok', value: { machineId: 'machine-b' } });
      }),
    );

    const response = await SELF.fetch(`https://${env.TENANT_ID}.gitspace.sh/rpc`, {
      method: 'POST',
      headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': accountId, 'x-gitspace-device': 'opaque-test-signature' },
      body: stringify({ v: 1, path: 'session.prompt', input: { sessionId: 'running', text: 'Make the change' } }),
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: 'MACHINE_UNAVAILABLE', message: 'The remote outcome may be unknown' } });
    expect(attempts).toEqual(['/tunnel/machine-a/rpc']);
  });
});
