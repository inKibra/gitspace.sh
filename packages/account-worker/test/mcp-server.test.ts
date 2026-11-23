import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  createDeviceBinding, credentialProtocolBase64, deviceProtocolBase64, encodeStepUpProof, passkeyChallengePayload, RPC_DEVICE_HEADER, signDeviceInvite, signRpcRequest, STEP_UP_HEADER,
  type DeviceCapability, type DeviceInvite,
} from '@gitspace/protocol';
import { mcpAccessResultSchema, type McpAccessOperation } from '@gitspace/protocol/mcp-access';
import { MCP_STEP_UP_CAPABILITIES } from '@gitspace/protocol/mcp-authorization';
import worker from '../src/index.js';
import { CredentialVaultDO } from '../src/application.js';
import { DEFAULT_SKILLS } from '@gitspace/protocol/default-skills';
import { PHASE_RULE } from '@gitspace/protocol-workspace';
import { scriptToolSources } from '@gitspace/runtime-core';
import { tenantRootPrivateKey } from './setup.js';
import { passkeyChallenge } from './fixtures/passkeys.js';
import { createHash } from 'node:crypto';
import { HttpResponse, http } from 'msw';
import { z } from 'zod';
import { network } from './network.js';
import { dnsAnswers, png } from './public-network.js';

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
  const management = (operation: McpAccessOperation, payload: Record<string, unknown> = {}, signed = true, stepUp: string | null = null) => {
    const path = `/v1/mcp-access/${operation}`;
    const body = new TextEncoder().encode(JSON.stringify({ userId: env.ACCOUNT_ID, ...payload }));
    return worker.fetch(new Request(`${env.ACCOUNT_URL}${path}`, {
      method: 'POST', body, headers: { 'content-type': 'application/json', 'x-gitspace-user': env.ACCOUNT_ID,
        ...(signed ? { [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: privateKey, method: 'POST', path, body }) } : {}),
        ...(stepUp ? { [STEP_UP_HEADER]: stepUp } : {}),
      },
    }), env);
  };
  /** A recovery-key step-up, issued to this browser, for creating the connection of `inviteId`. */
  const recoveryStepUp = async (inviteId: string) => {
    const view = await passkeyChallenge({ deviceId: binding.deviceId, key: privateKey }, 'mcp-token.create', [inviteId]);
    if (!view.required) throw new Error('A step-up was due');
    return encodeStepUpProof({ challengeId: view.challengeId, proof: { kind: 'root', signature: credentialProtocolBase64.encode(ed25519.sign(passkeyChallengePayload(view.payload), tenantRootPrivateKey)) } });
  };
  const clientInvite = (overrides: Partial<DeviceInvite> = {}) => signDeviceInvite({
    version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'client', label: 'MCP', scope: { kind: 'user' },
    capabilities, canDelegate: false, issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: 3_600_000,
    enrollUrl: `${env.ACCOUNT_URL}/v1/devices/enroll`, ...overrides,
  }, privateKey, { kind: 'device', deviceId: binding.deviceId });
  const first = clientInvite();
  const stepUp = enable && capabilities.some(capability => MCP_STEP_UP_CAPABILITIES[capability]) ? await recoveryStepUp(first.invite.inviteId) : null;
  const enabled = enable ? mcpAccessResultSchema.parse(await (await management('create', { expectedRevision: 0, label: 'Desktop', invite: first }, true, stepUp)).json()) : null;
  if (enabled?.status === 'error') throw new Error(enabled.error.message);
  const accessKey = enabled?.value.token ?? '';
  const connectionId = enabled?.value.connectionId ?? '';
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
  return { client, transport, configured, request, vault, deviceId: enabled?.value.connections.find(connection => connection.connectionId === connectionId)?.deviceId ?? '', connectionId, browserId: binding.deviceId, accessKey, management, clientInvite, recoveryStepUp };
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
      const settings = await value.client.callTool({ name: 'gitspace_settings_state', arguments: {} });
      expect(settings.isError).not.toBe(true);
      expect(settings.structuredContent).toMatchObject({ result: { user: expect.any(Object) } });
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

  it('states the phase rule in the space-chain skill, the space_workspace and space_phase tools, and the MCP stack tools', async () => {
    const value = await fixture(['rpc.read', 'rpc.write']);
    await value.client.connect(value.transport);
    try {
      const tools = (await value.client.listTools()).tools;
      const texts = [
        DEFAULT_SKILLS['space-chain'],
        ...['space_workspace', 'space_phase'].map(name => scriptToolSources.find(source => source.name === name)?.description),
        ...['gitspace_workspace_set_relations', 'gitspace_workspace_create'].map(name => tools.find(tool => tool.name === name)?.description),
      ];
      for (const text of texts) expect(text).toContain(PHASE_RULE);
    } finally { await value.client.close(); }
  });

  it('states what a stack\'s head leads and when it has members sync in the space-chain skill, and who starts, questions and answers in the space_workspace tool', () => {
    const skill = DEFAULT_SKILLS['space-chain'];
    expect(skill).toContain('A stack\'s head leads its stack with the project agent\'s tools, scoped to its members');
    expect(skill).toContain('Members don\'t instruct other workspaces');
    expect(skill).toContain('a member syncs when it enters Review or before it ships, or when its Base line shows files overlapping its own changes, and never mid-turn (send it with `when: \'queue\'`). The head syncs itself first. Members in Plan, or in Code without overlapping files, are left alone.');
    expect(scriptToolSources.find(source => source.name === 'space_workspace')?.description.match(/the project agent, or a stack's head for its members/gu)).toHaveLength(3);
  });

  it('returns the bearer once, rotates it, and disables both bearer and dedicated grant', async () => {
    const value = await fixture(['rpc.read']);
    const status = mcpAccessResultSchema.parse(await (await value.management('status')).json());
    if (status.status !== 'ok') throw new Error('Status failed');
    expect(status.value).toMatchObject({ revision: 1, connections: [{ connectionId: value.connectionId, label: 'Desktop', active: true, deviceId: value.deviceId, capabilities: ['rpc.read'] }] });
    expect(JSON.stringify(status)).not.toContain(value.accessKey);
    const rotated = mcpAccessResultSchema.parse(await (await value.management('rotate', { expectedRevision: 1, connectionId: value.connectionId })).json());
    if (rotated.status !== 'ok' || !rotated.value.token) throw new Error('Rotation failed');
    expect(rotated.value.token).not.toBe(value.accessKey);
    expect((await worker.fetch(value.request(), env)).status).toBe(401);
    expect((await worker.fetch(value.request(rotated.value.token), env)).status).toBe(200);
    expect((await value.management('disable', { expectedRevision: 2, connectionId: value.connectionId })).status).toBe(200);
    expect((await worker.fetch(value.request(rotated.value.token), env)).status).toBe(401);
    expect((await value.vault.listDeviceGrants()).find(record => record.binding.deviceId === value.deviceId)?.revokedAt).toEqual(expect.any(Number));
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 3, connections: [] } });
    expect((await value.management('rotate', { expectedRevision: 3, connectionId: value.connectionId })).status).toBe(404);
  });

  it('gives each connection its own token, capabilities and revocation', async () => {
    const value = await fixture(['rpc.read', 'rpc.write']);
    const second = mcpAccessResultSchema.parse(await (await value.management('create', { expectedRevision: 1, label: 'Laptop', invite: value.clientInvite({ capabilities: ['rpc.read'] }) })).json());
    if (second.status !== 'ok' || !second.value.token || !second.value.connectionId) throw new Error('Second connection failed');
    expect(second.value.connections.map(connection => [connection.label, connection.capabilities])).toEqual([['Desktop', ['rpc.read', 'rpc.write']], ['Laptop', ['rpc.read']]]);
    const tools = async (token: string) => {
      const response = await worker.fetch(value.request(token), env);
      return { status: response.status, writes: (await response.text()).includes('gitspace_configuration_values_put') };
    };
    expect(await tools(value.accessKey)).toEqual({ status: 200, writes: true });
    expect(await tools(second.value.token)).toEqual({ status: 200, writes: false });
    const rotated = mcpAccessResultSchema.parse(await (await value.management('rotate', { expectedRevision: 2, connectionId: value.connectionId })).json());
    if (rotated.status !== 'ok' || !rotated.value.token) throw new Error('Rotation failed');
    expect(rotated.value.connectionId).toBe(value.connectionId);
    expect((await tools(value.accessKey)).status).toBe(401);
    expect(await tools(second.value.token)).toEqual({ status: 200, writes: false });
    expect((await value.management('disable', { expectedRevision: 3, connectionId: second.value.connectionId })).status).toBe(200);
    expect((await tools(second.value.token)).status).toBe(401);
    expect(await tools(rotated.value.token)).toEqual({ status: 200, writes: true });
    const grants = await value.vault.listDeviceGrants();
    expect(grants.find(record => record.binding.deviceId === second.value.connections[1]?.deviceId)?.revokedAt).toEqual(expect.any(Number));
    expect(grants.find(record => record.binding.deviceId === value.deviceId)?.revokedAt).toBeNull();
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 4, connections: [{ label: 'Desktop', active: true }] } });
  });

  it('creates a connection with a powerful permission only after an mcp-token.create step-up naming its invitation, and rotates it without one', async () => {
    const value = await fixture(['rpc.read', 'account.admin'], {}, false);
    const create = async (expectedRevision: number, capabilities: DeviceCapability[], stepUp: (inviteId: string) => Promise<string | null>) => {
      const invite = value.clientInvite({ capabilities });
      return mcpAccessResultSchema.parse(await (await value.management('create', { expectedRevision, label: 'Agent', invite }, true, await stepUp(invite.invite.inviteId))).json());
    };
    // Ordinary permissions take none.
    expect(await create(0, ['rpc.read'], async () => null)).toMatchObject({ status: 'ok' });
    expect(await create(1, ['rpc.read', 'account.admin'], async () => null)).toMatchObject({ status: 'error', error: { code: 'STEP_UP_ENROLL_REQUIRED' } });
    expect(await create(1, ['rpc.read', 'account.admin'], async () => value.recoveryStepUp(crypto.randomUUID()))).toMatchObject({ status: 'error', error: { code: 'STEP_UP_INVALID' } });
    const powerful = await create(1, ['rpc.read', 'account.admin'], value.recoveryStepUp);
    if (powerful.status !== 'ok' || !powerful.value.connectionId) throw new Error('The stepped-up connection was refused');
    expect(powerful.value.connections.find(connection => connection.connectionId === powerful.value.connectionId)?.capabilities).toEqual(['rpc.read', 'account.admin']);
    const rotated = mcpAccessResultSchema.parse(await (await value.management('rotate', { expectedRevision: 2, connectionId: powerful.value.connectionId })).json());
    expect(rotated).toMatchObject({ status: 'ok', value: { connectionId: powerful.value.connectionId, token: expect.any(String) } });
  });

  it('moves an existing single grant into the connection list with its token unchanged', async () => {
    const value = await fixture(['rpc.read']);
    await runInDurableObject(value.vault, async (_instance, state) => {
      state.storage.sql.exec(`CREATE TABLE mcp_access (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL,
        device_id TEXT, sealed_key TEXT, token_hash TEXT, updated_at TEXT NOT NULL
      )`);
      state.storage.sql.exec('INSERT INTO mcp_access SELECT 1, 5, device_id, sealed_key, token_hash, updated_at FROM mcp_connections');
      state.storage.sql.exec('DELETE FROM mcp_connections');
      state.storage.sql.exec('DELETE FROM mcp_access_revision');
      const restarted = new CredentialVaultDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      expect((await restarted.resolveMcpAccess(value.accessKey))?.device.deviceId).toBe(value.deviceId);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name = 'mcp_access'").toArray()).toHaveLength(0);
    });
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 5, connections: [{ label: 'GitSpace MCP', deviceId: value.deviceId, active: true }] } });
    expect((await worker.fetch(value.request(), env)).status).toBe(200);
  });

  it('keeps encrypted access and its revision across vault reconstruction', async () => {
    const value = await fixture(['rpc.read']);
    await runInDurableObject(value.vault, async (_instance, state) => {
      const restarted = new CredentialVaultDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      const access = await restarted.resolveMcpAccess(value.accessKey);
      expect(access?.device.deviceId).toBe(value.deviceId);
      const persisted = JSON.stringify(state.storage.sql.exec('SELECT * FROM mcp_connections').toArray());
      expect(persisted).not.toContain(value.accessKey);
      if (!access) throw new Error('Persisted access was lost');
      expect(persisted).not.toContain(access.key);
    });
    expect((await value.management('rotate', { expectedRevision: 0, connectionId: value.connectionId })).status).toBe(409);
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
    expect((await value.management('create', { expectedRevision: 0, label: 'Desktop', invite: forged })).status).toBe(403);
    const foreign = { ...delegated, issuer: { kind: 'device', deviceId: crypto.randomUUID() } };
    expect((await value.management('create', { expectedRevision: 0, label: 'Desktop', invite: foreign })).status).toBe(403);
    expect((await value.vault.listDeviceGrants()).filter(record => record.invite.invite.label === 'MCP')).toHaveLength(0);
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 0, connections: [] } });
  });

  it.each([
    { kind: 'client' as const },
    { scope: { kind: 'project' as const, projectId: 'mcp-narrow' } },
    { capabilities: ['rpc.read'] as DeviceCapability[] },
    { canDelegate: false },
  ])('rejects setup without browser account delegation authority: %j', async (rights) => {
    const value = await fixture(['rpc.read'], rights, false);
    expect((await value.management('create', { expectedRevision: 0, label: 'Desktop', invite: value.clientInvite() })).status).toBe(403);
    expect((await value.vault.listDeviceGrants()).filter(record => record.invite.invite.label === 'MCP')).toHaveLength(0);
  });

  it('requires signed management and prevents stale concurrent enrollment from leaving grants', async () => {
    const value = await fixture(['rpc.read'], {}, false);
    expect((await value.management('create', { expectedRevision: 0, label: 'Desktop', invite: value.clientInvite() }, false)).status).toBe(403);
    const responses = await Promise.all([
      value.management('create', { expectedRevision: 0, label: 'Desktop', invite: value.clientInvite() }),
      value.management('create', { expectedRevision: 0, label: 'Laptop', invite: value.clientInvite() }),
    ]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await value.vault.listDeviceGrants()).filter(record => record.invite.invite.label === 'MCP')).toHaveLength(1);
    expect((await value.management('disable', { expectedRevision: 0, connectionId: 'any' })).status).toBe(409);
    expect(await (await value.management('status')).json()).toMatchObject({ value: { revision: 1, connections: [{ active: true }] } });
  });
});

/** A project with one worktree workspace, owned by the account. */
async function worktree() {
  const projectId = crypto.randomUUID();
  const workspaceId = crypto.randomUUID();
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: 'MCP files', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
  await index.put(await authority.setProjectLifecycle(project.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind, branch: 'main', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await index.putWorkspaceLocation(id, projectId);
  }
  return workspaceId;
}

describe('files over MCP by link (#241)', () => {
  it('writes a PNG, fetches the URL artifacts_file returns as it is, imports one from a public https URL by its hash, and links only a single-file result', async () => {
    const value = await fixture(['rpc.read', 'rpc.write']);
    const space = { spaceId: await worktree(), expectedGeneration: 0 };
    const hash = createHash('sha256').update(png).digest('hex');
    const ResultSchema = z.object({ result: z.object({ url: z.string(), hash: z.string() }).loose() });
    await value.client.connect(value.transport);
    try {
      const written = await value.client.callTool({ name: 'gitspace_inspector_artifacts_write', arguments: { ...space, url: 'drive://workspace/shots/dot.png', mediaType: 'image/png', base64: Buffer.from(png).toString('base64') } });
      expect(ResultSchema.parse(written.structuredContent).result.hash).toBe(`sha256:${hash}`);

      const file = await value.client.callTool({ name: 'gitspace_inspector_artifacts_file', arguments: { ...space, url: 'drive://workspace/shots/dot.png', hash: null } });
      const minted = ResultSchema.parse(file.structuredContent).result;
      expect(minted.url.startsWith(`${env.ACCOUNT_URL}/files/`)).toBe(true);
      // The URL as returned, with no credentials.
      const fetched = await worker.fetch(new Request(minted.url), env);
      expect(fetched.status).toBe(200);
      expect(createHash('sha256').update(new Uint8Array(await fetched.arrayBuffer())).digest('hex')).toBe(hash);
      expect(file.content).toEqual([
        { type: 'text', text: JSON.stringify(file.structuredContent) },
        { type: 'resource_link', uri: minted.url, name: 'dot.png', mimeType: 'image/png', size: png.byteLength },
      ]);
      // A list names many files, and links none.
      const listed = await value.client.callTool({ name: 'gitspace_inspector_artifacts_list', arguments: space });
      expect(listed.content).toEqual([{ type: 'text', text: JSON.stringify(listed.structuredContent) }]);

      network.use(dnsAnswers({ 'files.example.com': { A: ['93.184.216.34'] } }), http.get('https://files.example.com/signed/shot.png', () => new HttpResponse(png, { headers: { 'content-type': 'image/png' } })));
      const imported = await value.client.callTool({ name: 'gitspace_inspector_artifacts_import', arguments: { ...space, url: 'https://files.example.com/signed/shot.png', sha256: hash } });
      expect(imported.structuredContent).toMatchObject({ result: { url: 'drive://workspace/uploads/shot.png', hash: `sha256:${hash}`, size: png.byteLength, mediaType: 'image/png' } });
      // Other bytes than the hash names are never listed.
      const refused = await value.client.callTool({ name: 'gitspace_inspector_artifacts_import', arguments: { ...space, url: 'https://files.example.com/signed/shot.png', fileName: 'wrong.png', sha256: '0'.repeat(64) } });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).toContain('does not match the given sha256');
      expect(JSON.stringify((await value.client.callTool({ name: 'gitspace_inspector_artifacts_list', arguments: space })).structuredContent)).not.toContain('wrong.png');
    } finally { await value.client.close(); }
  }, 30_000);
});
