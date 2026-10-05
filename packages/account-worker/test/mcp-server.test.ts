import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createDeviceBinding, deviceProtocolBase64, RPC_DEVICE_HEADER, signDeviceInvite, signRpcRequest, type DeviceCapability, type DeviceInvite } from '@gitspace/protocol';
import { mcpAccessResultSchema, type McpAccessOperation } from '@gitspace/protocol/mcp-access';
import worker from '../src/index.js';
import { CredentialVaultDO } from '../src/application.js';
import { tenantRootPrivateKey } from './setup.js';
import { network } from './network.js';

async function fixture(capabilities: DeviceCapability[], rights: Partial<DeviceInvite> = {}, enable = true) {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: deviceProtocolBase64.encode(new Uint8Array(32).fill(71)) });
  await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).setHandle('bootstrap', 0, env.TENANT_ID);
  const invite = signDeviceInvite({
    version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: 'Browser', scope: { kind: 'user' },
    capabilities: [...new Set<DeviceCapability>([...capabilities, 'devices.manage'])], canDelegate: true, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: 3_600_000, ...rights,
    enrollUrl: `${env.ACCOUNT_URL}/v1/devices/enroll`,
  }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: deviceProtocolBase64.encode(ed25519.getPublicKey(privateKey)), label: 'MCP', boundAt: Date.now(), signingPrivateKey: privateKey });
  const enrolled = await vault.enrollDevice({ invite, binding });
  if (enrolled.status !== 'ok') throw new Error(enrolled.error.message);
  const management = (operation: McpAccessOperation, payload: Record<string, unknown> = {}, signed = true) => {
    const path = `/v1/mcp-access/${operation}`;
    const body = new TextEncoder().encode(JSON.stringify({ userId: env.ACCOUNT_ID, ...payload }));
    return worker.fetch(new Request(`${env.ACCOUNT_URL}${path}`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-gitspace-user': env.ACCOUNT_ID,
        ...(signed ? { [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: privateKey, method: 'POST', path, body }) } : {}),
      },
    }), env);
  };
  const clientInvite = (overrides: Partial<DeviceInvite> = {}) => signDeviceInvite({
    version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'client', label: 'MCP', scope: { kind: 'user' },
    capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: 3_600_000,
    enrollUrl: `${env.ACCOUNT_URL}/v1/devices/enroll`, ...overrides,
  }, privateKey, { kind: 'device', deviceId: binding.deviceId });
  const enabled = enable ? mcpAccessResultSchema.parse(await (await management('enable', { expectedRevision: 0, invite: clientInvite() })).json()) : null;
  if (enabled?.status === 'error') throw new Error(enabled.error.message);
  const accessKey = enabled?.value.token ?? '';
  const configured = env;
  const request = (token = accessKey) => new Request(`${env.ACCOUNT_URL}/mcp`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  const client = new Client({ name: 'gitspace-mcp-regression', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${env.ACCOUNT_URL}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${accessKey}` } },
    fetch: (input, init) => worker.fetch(new Request(input, init), configured),
  });
  return { client, transport, configured, request, vault, deviceId: enabled?.value.deviceId ?? '', browserId: binding.deviceId, accessKey, management, clientInvite };
}

describe('tenant MCP authority boundary', () => {
  it('uses a standard MCP client to change real account state, then rejects a revoked signing grant', async () => {
    const value = await fixture(['rpc.read', 'rpc.write', 'session.prompt', 'fleet.control', 'devices.manage', 'deployment.control', 'account.admin', 'lifecycle.control']);
    await value.client.connect(value.transport);
    try {
      // The standard client compiles all advertised output schemas, including nested references.
      const catalog = await value.client.listTools();
      expect(catalog.tools.some(tool => tool.name === 'gitspace_environment_approve')).toBe(true);
      expect(catalog.tools.some(tool => tool.name.startsWith('gitspace_providers_login_'))).toBe(false);
      expect(catalog.tools.some(tool => tool.name === 'gitspace_terminals_live')).toBe(false);
      await expect(value.client.callTool({ name: 'gitspace_terminals_live', arguments: { spaceId: 'workspace', name: 'life-private' } })).rejects.toMatchObject({ code: -32602 });
      for (const name of ['gitspace_runtime_browser_trust', 'gitspace_runtime_browser_targets', 'gitspace_runtime_browser_select']) {
        expect(catalog.tools.some(tool => tool.name === name)).toBe(false);
        await expect(value.client.callTool({ name, arguments: { projectId: 'project', workspaceId: 'workspace', conversationId: 'conversation', questionId: 'approval:task', targetId: 'tab' } })).rejects.toMatchObject({ code: -32602 });
      }
      const resources = await value.client.listResources();
      const skill = resources.resources.find(resource => resource.uri.startsWith('gitspace://skills/'));
      if (!skill) throw new Error('Expected an enabled built-in skill resource');
      const content = await value.client.readResource({ uri: skill.uri });
      expect(content.contents[0]).toMatchObject({ mimeType: 'text/markdown' });
      const events = await value.client.callTool({ name: 'gitspace_settings_events', arguments: { after: null, _mcp: { waitMs: 100 } } });
      expect(events.isError).not.toBe(true);
      expect(events.structuredContent).toMatchObject({ complete: false });
      const missing = await value.client.callTool({ name: 'gitspace_environment_get', arguments: { spaceId: 'mcp-missing-workspace' } });
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing.content)).toContain('mcp-missing-workspace');
      const result = await value.client.callTool({ name: 'gitspace_configuration_values_put', arguments: { scope: 'global', name: 'MCP_REGION', value: 'verified' } });
      expect(result.isError).not.toBe(true);
      const read = await value.client.callTool({ name: 'gitspace_configuration_values_get', arguments: {} });
      expect(read.isError).not.toBe(true);
      expect(JSON.stringify(read)).toContain('verified');
      const revoked = await value.vault.revokeDeviceGrant(value.deviceId);
      expect(revoked.status).toBe('ok');
      const response = await worker.fetch(value.request(), value.configured);
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ error: { code: 'MCP_UNAUTHORIZED' } });
    } finally { await value.client.close(); }
  }, 30_000);

  it('rejects an invalid MCP key and prevents a read-only key from invoking a known write tool', async () => {
    const value = await fixture(['rpc.read']);
    expect((await worker.fetch(value.request('wrong_access_key_01234567890123456789'), value.configured)).status).toBe(401);
    await value.client.connect(value.transport);
    try {
      const listed = await value.client.listTools();
      expect(listed.tools.some(tool => tool.name === 'gitspace_configuration_values_put')).toBe(false);
      let denied = false;
      try {
        const result = await value.client.callTool({ name: 'gitspace_configuration_values_put', arguments: { scope: 'global', name: 'MCP_REGION', value: 'forbidden' } });
        denied = result.isError === true;
      } catch { denied = true; }
      expect(denied).toBe(true);
      const state = await value.client.callTool({ name: 'gitspace_configuration_values_get', arguments: {} });
      expect(JSON.stringify(state)).not.toContain('forbidden');
    } finally { await value.client.close(); }
  });

  it('dispatches machine-bound tools to the account /rpc, which forwards them to the holder', async () => {
    const value = await fixture(['rpc.read']);
    // Catalog endpoints are relay tunnels on the Worker's own host, which it cannot fetch.
    await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).putMachine({ id: 'machine-b', label: 'Machine B', kind: 'physical', provider: 'physical', state: 'online', desiredState: 'online', rpcEndpoint: `${env.RELAY_URL}/tunnel/machine-b/rpc`, notes: '', lifecycleRevision: 1, operationId: null, error: null });
    await env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:space-mcp`).bootstrap({ projectId: 'project-mcp', spaceId: 'space-mcp', machineId: 'machine-b' });
    const selfFetches: string[] = [];
    network.use(http.all(`${env.ACCOUNT_URL}/*`, ({ request }) => {
      selfFetches.push(request.url);
      return HttpResponse.json({ error: { code: 'SELF_FETCH', message: 'The Worker fetched its own hostname' } }, { status: 500 });
    }));
    const logs = vi.spyOn(console, 'log');
    await value.client.connect(value.transport);
    try {
      const result = await value.client.callTool({ name: 'gitspace_space_view', arguments: { projectId: 'project-mcp', workspaceId: 'space-mcp' } });
      // No machine socket is connected in tests, so the holder's tunnel reports it offline.
      expect(result.isError).toBe(true);
      expect(selfFetches).toEqual([]);
      const batches = logs.mock.calls.flatMap(([line]): unknown[] => typeof line === 'string' && line.includes('"rpc_batch"') ? [JSON.parse(line)] : []);
      expect(batches).toContainEqual(expect.objectContaining({ procedures: ['space.view'], target: 'machine-b' }));
    } finally {
      logs.mockRestore();
      await value.client.close();
    }
  });

  it('returns the bearer once, rotates it, and disables both bearer and dedicated grant', async () => {
    const value = await fixture(['rpc.read']);
    const status = mcpAccessResultSchema.parse(await (await value.management('status')).json());
    if (status.status !== 'ok') throw new Error('Status failed');
    expect(status).toMatchObject({ status: 'ok', value: { revision: 1, enabled: true, active: true, deviceId: value.deviceId } });
    expect(Object.keys(status.value).sort()).toEqual(['active', 'capabilities', 'deviceId', 'enabled', 'endpoint', 'expiresAt', 'revision', 'scope', 'updatedAt']);
    expect(JSON.stringify(status)).not.toContain(value.accessKey);
    const rotated = mcpAccessResultSchema.parse(await (await value.management('rotate', { expectedRevision: 1 })).json());
    if (rotated.status !== 'ok' || !rotated.value.token) throw new Error('Rotation failed');
    expect(rotated.value.token).not.toBe(value.accessKey);
    expect((await worker.fetch(value.request(), env)).status).toBe(401);
    expect((await worker.fetch(value.request(rotated.value.token), env)).status).toBe(200);
    expect((await value.management('disable', { expectedRevision: 2 })).status).toBe(200);
    expect((await worker.fetch(value.request(rotated.value.token), env)).status).toBe(401);
    expect(await value.vault.currentDeviceGrant(value.deviceId)).toBeNull();
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 3, enabled: false, active: false } });
  });

  it('keeps encrypted access and its revision across vault reconstruction', async () => {
    const value = await fixture(['rpc.read']);
    await runInDurableObject(value.vault, async (_instance, state) => {
      const restarted = new CredentialVaultDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      const access = await restarted.resolveMcpAccess(value.accessKey);
      expect(access?.device.deviceId).toBe(value.deviceId);
      const persisted = JSON.stringify(state.storage.sql.exec('SELECT * FROM mcp_access').toArray());
      expect(persisted).not.toContain(value.accessKey);
      if (!access) throw new Error('Persisted access was lost');
      expect(persisted).not.toContain(access.key);
    });
    expect((await value.management('rotate', { expectedRevision: 0 })).status).toBe(409);
    expect((await worker.fetch(value.request(), env)).status).toBe(200);
  });

  it('denies a bearer after its issuing browser is revoked', async () => {
    const value = await fixture(['rpc.read']);
    await value.vault.revokeDeviceGrant(value.browserId);
    expect((await worker.fetch(value.request(), env)).status).toBe(401);
  });

  it('rejects invitations that delegate extra capabilities or impersonate another issuer', async () => {
    const value = await fixture(['rpc.read'], {}, false);
    const delegated = value.clientInvite();
    const forged = value.clientInvite({ capabilities: ['account.admin'] });
    expect((await value.management('enable', { expectedRevision: 0, invite: forged })).status).toBe(403);
    const foreign = { ...delegated, issuer: { kind: 'device', deviceId: crypto.randomUUID() } };
    expect((await value.management('enable', { expectedRevision: 0, invite: foreign })).status).toBe(403);
    expect((await value.vault.listDeviceGrants()).filter(record => record.invite.invite.label === 'MCP')).toHaveLength(0);
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 0, enabled: false } });
  });

  it.each([
    { kind: 'client' as const },
    { scope: { kind: 'project' as const, projectId: 'mcp-narrow' } },
    { capabilities: ['rpc.read'] as DeviceCapability[] },
    { canDelegate: false },
  ])('rejects setup without browser account delegation authority: %j', async (rights) => {
    const value = await fixture(['rpc.read'], rights, false);
    expect((await value.management('enable', { expectedRevision: 0, invite: value.clientInvite() })).status).toBe(403);
    expect((await value.vault.listDeviceGrants()).filter(record => record.invite.invite.label === 'MCP')).toHaveLength(0);
  });

  it('requires signed management and prevents stale concurrent enrollment from leaving grants', async () => {
    const value = await fixture(['rpc.read'], {}, false);
    expect((await value.management('enable', { expectedRevision: 0, invite: value.clientInvite() }, false)).status).toBe(403);
    const responses = await Promise.all([
      value.management('enable', { expectedRevision: 0, invite: value.clientInvite() }),
      value.management('enable', { expectedRevision: 0, invite: value.clientInvite() }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await value.vault.listDeviceGrants()).filter(record => record.invite.invite.label === 'MCP')).toHaveLength(1);
    expect((await value.management('disable', { expectedRevision: 0 })).status).toBe(409);
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 1, active: true } });
  });
});
