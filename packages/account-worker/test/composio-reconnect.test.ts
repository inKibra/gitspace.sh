import { env, SELF } from 'cloudflare:test';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, signDeviceInvite, signRpcRequest } from '@gitspace/protocol';
import { parse, stringify } from 'devalue';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

type Rpc = (path: string, input?: unknown) => Promise<unknown>;

async function signedRpc(): Promise<Rpc> {
  const userId = env.ACCOUNT_ID;
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(73)) });
  await vault.putProviderSecret('composio', 'composio-test-key-reconnect');
  await env.USER_SETTINGS.getByName(userId).setHandle('bootstrap', 0, env.TENANT_ID);
  const browserKey = crypto.getRandomValues(new Uint8Array(32));
  const invite = signDeviceInvite({ version: 1, userId, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read', 'rpc.write'], canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: 'https://api.gitspace.sh' }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(browserKey)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: browserKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  return async (path: string, input: unknown = {}): Promise<unknown> => {
    const body = stringify({ v: 1, path, input });
    const signature = signRpcRequest({ deviceId: binding.deviceId, method: 'POST', path: '/rpc', body: new TextEncoder().encode(body), signingPrivateKey: browserKey });
    const response = await SELF.fetch(new Request(`https://${env.TENANT_ID}.gitspace.sh/rpc`, { method: 'POST', body, headers: { 'content-type': 'application/result-rpc+devalue; sv=1', 'x-gitspace-user': userId, 'x-gitspace-device': signature } }));
    return parse(await response.text());
  };
}

type AccountStatus = 'INITIATED' | 'ACTIVE' | 'EXPIRED';

interface FakeComposio {
  accounts: Map<string, AccountStatus>;
  callbacks: string[];
  deleted: string[];
}

/** Composio's API as the SDK calls it: each authorization links a new connected account and remembers the GitSpace
 * callback it should return the browser to. */
function composio(): FakeComposio {
  const accounts = new Map<string, AccountStatus>();
  const callbacks: string[] = [];
  const deleted: string[] = [];
  network.use(
    http.post('https://backend.composio.dev/*/tool_router/session', () => HttpResponse.json({
      session_id: 'session-1',
      mcp: { type: 'http', url: 'https://backend.composio.dev/tool_router/session-1/mcp' },
      config: {},
      config_version: 1,
    })),
    http.post('https://backend.composio.dev/*/tool_router/session/:session/link', async ({ request }) => {
      const body = z.object({ toolkit: z.literal('gmail'), callback_url: z.string() }).parse(await request.json());
      const id = `ca_${accounts.size + 1}`;
      accounts.set(id, 'INITIATED');
      callbacks.push(body.callback_url);
      return HttpResponse.json({ connected_account_id: id, redirect_url: `https://connect.composio.test/${id}` });
    }),
    http.get('https://backend.composio.dev/*/connected_accounts/:id', ({ params }) => {
      const id = String(params.id);
      const status = accounts.get(id);
      if (!status) return HttpResponse.json({ error: { message: 'not found' } }, { status: 404 });
      return HttpResponse.json({
        id, status, status_reason: null, is_disabled: false, toolkit: { slug: 'gmail' },
        auth_config: { id: 'ac_gmail', auth_scheme: 'OAUTH2', is_composio_managed: true, is_disabled: false },
        created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-19T00:00:00.000Z',
      });
    }),
    http.delete('https://backend.composio.dev/*/connected_accounts/:id', ({ params }) => {
      deleted.push(String(params.id));
      return HttpResponse.json({ success: true });
    }),
  );
  return { accounts, callbacks, deleted };
}

const connectionView = z.object({ status: z.literal('ok'), value: z.object({
  id: z.string(),
  status: z.string(),
  statusMessage: z.string().nullable(),
  revision: z.number(),
  transport: z.object({ type: z.literal('composio'), connectedAccountId: z.string() }),
}) });
const authorizationView = z.object({ status: z.literal('ok'), value: z.object({ redirectUrl: z.string(), connection: connectionView.shape.value }) });

/** Connects Gmail through the browser return, then lets its account expire and refreshes it. */
async function expiredGmail(rpc: Rpc, fake: FakeComposio) {
  const started = authorizationView.parse(await rpc('mcp.composio.authorize', { toolkit: 'gmail', label: 'Work Gmail' }));
  const first = started.value.connection.transport.connectedAccountId;
  fake.accounts.set(first, 'ACTIVE');
  expect((await SELF.fetch(fake.callbacks.at(-1)!)).status).toBe(200);
  expect(connectionView.parse(await rpc('mcp.connections.status', { connectionId: started.value.connection.id })).value.status).toBe('ready');
  fake.accounts.set(first, 'EXPIRED');
  return { connectionId: started.value.connection.id, first };
}

describe('Composio plugin reconnect', () => {
  it('reads an expired account as expired, and Reconnect switches the plugin to the new account once it is active', async () => {
    const rpc = await signedRpc();
    const fake = composio();
    const { connectionId, first } = await expiredGmail(rpc, fake);

    const expired = connectionView.parse(await rpc('mcp.composio.refresh', { connectionId }));
    expect(expired.value).toMatchObject({ status: 'expired', statusMessage: 'Composio account is expired' });

    const reconnect = authorizationView.parse(await rpc('mcp.composio.reconnect', { connectionId }));
    const second = [...fake.accounts.keys()].at(-1)!;
    expect(second).not.toBe(first);
    expect(reconnect.value.redirectUrl).toBe(`https://connect.composio.test/${second}`);
    expect(reconnect.value.connection.transport.connectedAccountId).toBe(first);

    fake.accounts.set(second, 'ACTIVE');
    expect((await SELF.fetch(fake.callbacks.at(-1)!)).status).toBe(200);
    const reconnected = connectionView.parse(await rpc('mcp.connections.status', { connectionId }));
    expect(reconnected.value).toMatchObject({ status: 'ready', statusMessage: null, transport: { connectedAccountId: second } });
    expect(fake.deleted).toEqual([first]);
  });

  it('keeps the previous connection when a reconnect never completes', async () => {
    const rpc = await signedRpc();
    const fake = composio();
    const { connectionId, first } = await expiredGmail(rpc, fake);
    const before = connectionView.parse(await rpc('mcp.composio.refresh', { connectionId })).value;

    authorizationView.parse(await rpc('mcp.composio.reconnect', { connectionId }));
    expect(connectionView.parse(await rpc('mcp.connections.status', { connectionId })).value).toEqual(before);

    // Composio sends the browser back before the new account finished connecting.
    const returned = await SELF.fetch(fake.callbacks.at(-1)!);
    expect(returned.status).toBe(400);
    expect(await returned.text()).toContain('keeps its previous connection');
    expect(connectionView.parse(await rpc('mcp.connections.status', { connectionId })).value).toEqual(before);
    expect(before.transport.connectedAccountId).toBe(first);
    expect(fake.deleted).toEqual([]);
  });
});
