import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, DEVICE_SOCKET_PROTOCOL, RPC_DEVICE_HEADER, signDeviceInvite, signRpcRequest, type CloudProjectSummary, type CloudWorkspaceDefinition, type DeviceInvite } from '@gitspace/protocol';
import { accountDirectoryMessageSchema, workspaceStatusMessageSchema, type AccountDirectoryMessage } from '@gitspace/protocol/account-directory';
import { http, HttpResponse } from 'msw';
import { UserProjectIndexDO, ProjectAuthorityDO } from '../src/project-authority.js';
import { DirectoryPublisher, type DirectorySource } from '../src/account-directory.js';
import { invalidateDeviceAuthority } from '../src/device-authority.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';
import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';

afterEach(() => vi.restoreAllMocks());

const timestamp = '2026-09-01T00:00:00.000Z';
const project: CloudProjectSummary = { id: 'directory-project', name: 'Directory', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, remote: null, archivedAt: null, updatedAt: timestamp, role: null, source: null };
const workspace: CloudWorkspaceDefinition = { id: 'directory-space', projectId: project.id, kind: 'worktree', name: 'Directory space', branch: 'feature', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, revision: 1, remote: null, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
const source: DirectorySource = { source: 'project', project, workspaces: [workspace] };
const machine = { id: 'machine-a', label: 'Machine A', state: 'online' as const, desiredState: 'online' as const, kind: 'physical' as const, provider: 'physical' as const, rpcEndpoint: '/rpc', notes: '', lifecycleRevision: 1, operationId: null, error: null };

async function browserDevice(rights: Partial<Pick<DeviceInvite, 'scope' | 'capabilities'>> = {}) {
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(41)) });
  const key = ed25519.utils.randomSecretKey();
  const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'browser', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read'], canDelegate: true,
    issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: env.ACCOUNT_URL, ...rights }, tenantRootPrivateKey);
  const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Browser', boundAt: Date.now(), signingPrivateKey: key });
  expect(await vault.enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
  // Sockets carry the signed GET as a subprotocol; plain GETs (the browser's rejection probe) as a header.
  const request = (after?: number, upgrade = true) => {
    const path = `/v1/directory/events${after === undefined ? '' : `?after=${after}`}`;
    const auth = signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method: 'GET', path, body: new Uint8Array() });
    return new Request(`${env.ACCOUNT_URL}${path}`, { headers: { origin: env.ACCOUNT_URL, ...(upgrade ? { upgrade: 'websocket', 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${auth}` } : { [RPC_DEVICE_HEADER]: auth }) } });
  };
  return { vault, key, deviceId: binding.deviceId, request };
}

/** Attach before accept so the already-queued initial snapshot cannot be lost. */
function socketEvents(socket: WebSocket) {
  type Event = { type: 'message'; value: AccountDirectoryMessage } | { type: 'close'; code: number };
  const events: Event[] = [];
  const waiters: Array<(event: Event) => void> = [];
  const push = (event: Event) => { const waiter = waiters.shift(); if (waiter) waiter(event); else events.push(event); };
  socket.addEventListener('message', (event) => {
    const decoded: unknown = JSON.parse(String(event.data));
    // Status rows share the socket; these tests follow directory events.
    if (workspaceStatusMessageSchema.safeParse(decoded).success) return;
    push({ type: 'message', value: accountDirectoryMessageSchema.parse(decoded) });
  });
  socket.addEventListener('close', (event) => push({ type: 'close', code: event.code }));
  socket.accept();
  return { next: () => { const queued = events.shift(); return queued ? Promise.resolve(queued) : new Promise<Event>((resolve) => waiters.push(resolve)); } };
}

async function openDirectory(request: Request) {
  const response = await SELF.fetch(request);
  expect(response.status).toBe(101);
  expect(response.headers.get('sec-websocket-protocol')).toBe(request.headers.get('sec-websocket-protocol'));
  const socket = response.webSocket!;
  return { socket, events: socketEvents(socket) };
}

describe('account directory projection', () => {
  it('fences delayed hydration, duplicates and deleted workspace/project resurrection', async () => {
    const index = env.USER_PROJECTS.getByName('directory-ordering');
    await index.publishDirectory({ ...source, cursor: 2 });
    const before = await index.directorySnapshot();
    await index.publishDirectory({ ...source, cursor: 3, workspaces: [] });
    expect(await index.publishDirectory({ ...source, cursor: 2 })).toBe(false);
    expect(await index.publishDirectory({ ...source, cursor: 0 })).toBe(false);
    expect(await index.directorySnapshot()).toMatchObject({ workspaces: [], projectRevisions: { [project.id]: 3 } });
    expect(before.workspaces).toEqual([{ ...workspace, cloudRuntime: false }]);
    await index.publishDirectory({ ...source, cursor: 4, project: { ...project, revision: 2, lifecycle: 'deleting' }, workspaces: [] });
    // Even an erroneously later source publication cannot bypass an account tombstone.
    await index.publishDirectory({ ...source, cursor: 5 });
    expect(await index.directorySnapshot()).toMatchObject({ projects: [], workspaces: [], placements: [], projectRevisions: {} });
    expect(await index.locateWorkspace(workspace.id)).toBeNull();
  });

  it('publishes a source entry after each change with a newer version, and a failed send heals on the next change', async () => {
    const receiver = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const sender = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${project.id}`);
    await runInDurableObject(sender, async (_instance, state) => {
      const unavailable = { ...env, USER_PROJECTS: { getByName: () => ({ publishDirectory: async () => { throw new Error('Directory unavailable'); } }) } } as unknown as Env;
      const authority = new ProjectAuthorityDO(state, unavailable);
      await state.blockConcurrencyWhile(async () => {});
      await authority.bootstrap({ ...project, createdBy: machine.id });
    });
    expect(await receiver.list()).toEqual([]);
    await runInDurableObject(sender, async (_instance, state) => {
      const restarted = new ProjectAuthorityDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      restarted.putWorkspace({ ...workspace, expectedRevision: 0 });
    });
    await expect.poll(() => receiver.directorySnapshot()).toMatchObject({ projects: [{ id: project.id }], workspaces: [{ id: workspace.id }] });
  });

  it('continues a source version from its retired outbox, so the directory keeps accepting it', async () => {
    await runInDurableObject(env.USER_PROJECTS.getByName('retired-outbox'), (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE directory_outbox(singleton INTEGER PRIMARY KEY CHECK(singleton=1), cursor INTEGER NOT NULL, value_json TEXT, attempts INTEGER NOT NULL DEFAULT 0)');
      state.storage.sql.exec('INSERT INTO directory_outbox(singleton,cursor) VALUES(1,7)');
      const publisher = new DirectoryPublisher(state, env);
      expect(publisher.version()).toBe(7);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name='directory_outbox'").toArray()).toEqual([]);
    });
  });
});

describe('directory WebSocket authentication', () => {
  it('binds the cursor and method to the signature, never reads a URL proof and rejects foreign origins before upgrade', async () => {
    const device = await browserDevice();
    expect((await SELF.fetch(device.request(0, false))).status).toBe(426);
    const path = '/v1/directory/events?after=0';
    const inUrl = signRpcRequest({ deviceId: device.deviceId, signingPrivateKey: device.key, method: 'GET', path, body: new Uint8Array() });
    const urlProof = await SELF.fetch(new Request(`${env.ACCOUNT_URL}${path}&auth=${encodeURIComponent(inUrl)}`, { headers: { origin: env.ACCOUNT_URL, upgrade: 'websocket' } }));
    expect(urlProof.status).toBe(400);
    const tampered = device.request(0, false);
    expect((await SELF.fetch(new Request(tampered.url.replace('after=0', 'after=1'), tampered))).status).toBe(401);
    const foreign = device.request();
    foreign.headers.set('origin', 'https://another.gitspace.sh');
    expect((await SELF.fetch(foreign)).status).toBe(403);
    const denied = await browserDevice({ capabilities: ['rpc.write'] });
    expect((await SELF.fetch(denied.request())).status).toBe(401);
    const scoped = await browserDevice({ scope: { kind: 'workspace', workspaceId: workspace.id } });
    expect((await SELF.fetch(scoped.request())).status).toBe(401);
  });

  it('diagnoses rejected browser upgrades through signed HTTP headers without relaxing WebSocket origin checks', async () => {
    const device = await browserDevice();
    const path = '/v1/directory/events?after=0';
    const diagnostic = () => new Request(`${env.ACCOUNT_URL}${path}`, { headers: {
      [RPC_DEVICE_HEADER]: signRpcRequest({ deviceId: device.deviceId, signingPrivateKey: device.key, method: 'GET', path, body: new Uint8Array() }),
    } });
    expect((await SELF.fetch(diagnostic())).status).toBe(426);
    const missingOrigin = device.request();
    missingOrigin.headers.delete('origin');
    expect((await SELF.fetch(missingOrigin)).status).toBe(403);
    await device.vault.revokeDeviceGrant(device.deviceId);
    const rejected = await SELF.fetch(diagnostic());
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: { code: 'RPC_DEVICE_UNKNOWN' } });
  });

  it('rechecks a delegated user device grant chain when an issuer is revoked', async () => {
    const parent = await browserDevice();
    const key = ed25519.utils.randomSecretKey();
    const invite = signDeviceInvite({ version: 1, userId: env.ACCOUNT_ID, inviteId: crypto.randomUUID(), kind: 'client', label: null, scope: { kind: 'user' }, capabilities: ['rpc.read'], canDelegate: false,
      issuedAt: Date.now(), expiresAt: Date.now() + 60_000, grantTtlMs: null, enrollUrl: env.ACCOUNT_URL }, parent.key, { kind: 'device', deviceId: parent.deviceId });
    const binding = createDeviceBinding({ inviteId: invite.invite.inviteId, deviceId: crypto.randomUUID(), signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(key)), label: 'Client', boundAt: Date.now(), signingPrivateKey: key });
    expect(await parent.vault.enrollDevice({ invite, binding })).toMatchObject({ status: 'ok' });
    const path = '/v1/directory/events';
    const auth = signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method: 'GET', path, body: new Uint8Array() });
    const opened = await openDirectory(new Request(`${env.ACCOUNT_URL}${path}`, { headers: { origin: env.ACCOUNT_URL, upgrade: 'websocket', 'sec-websocket-protocol': `${DEVICE_SOCKET_PROTOCOL}${auth}` } }));
    await opened.events.next();
    await parent.vault.revokeDeviceGrant(parent.deviceId);
    await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).publishDirectory({ ...source, cursor: 1 });
    expect(await opened.events.next()).toEqual({ type: 'close', code: 4401 });
  });

  it('sends the whole directory when a socket opens, then only the slice that changed', async () => {
    const device = await browserDevice();
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const opened = await openDirectory(device.request());
    expect(await opened.events.next()).toMatchObject({ type: 'message', value: { type: 'directory', snapshot: { projects: [], workspaces: [] } } });
    await index.publishDirectory({ ...source, cursor: 1 });
    const messages = [await opened.events.next(), await opened.events.next()];
    expect(messages).toEqual(expect.arrayContaining([
      { type: 'message', value: { type: 'directory.projects', projects: [{ ...project, updatedAt: expect.any(String) }] } },
      { type: 'message', value: { type: 'directory.project', projectId: project.id, revision: 1, workspaces: [{ ...workspace, cloudRuntime: false }], placements: [] } },
    ]));
    await index.publishDirectory({ ...source, cursor: 2, workspaces: [] });
    // The project list did not change: only the project's slice is sent.
    expect(await opened.events.next()).toEqual({ type: 'message', value: { type: 'directory.project', projectId: project.id, revision: 2, workspaces: [], placements: [] } });
    opened.socket.close(1000, 'done');
  });

  it('reaches an open socket after the object restarts, then closes it when its device is revoked', async () => {
    const device = await browserDevice();
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const opened = await openDirectory(device.request());
    await opened.events.next();
    await runInDurableObject(index, async (_instance, state) => {
      const restarted = new UserProjectIndexDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      restarted.publishDirectory({ ...source, cursor: 1 });
    });
    expect(await opened.events.next()).toMatchObject({ type: 'message', value: { type: expect.stringMatching(/^directory\./) } });
    await device.vault.revokeDeviceGrant(device.deviceId);
    await index.publishDirectory({ ...source, cursor: 2, workspaces: [] });
    let next = await opened.events.next();
    while (next.type === 'message') next = await opened.events.next();
    expect(next).toEqual({ type: 'close', code: 4401 });
    expect(await (await SELF.fetch(device.request(undefined, false))).json()).toMatchObject({ error: { code: 'RPC_DEVICE_UNKNOWN' } });
  });

  it('survives bounded authority outages after wake, then fails closed before disclosing an expired change', async () => {
    const device = await browserDevice();
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const opened = await openDirectory(device.request());
    await opened.events.next();
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => new HttpResponse(null, { status: 503 })));
    await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).publishDirectory({ ...source, cursor: 1 });
    expect(await opened.events.next()).toMatchObject({ type: 'message', value: { type: expect.stringMatching(/^directory\./) } });
    await opened.events.next();
    clock.mockReturnValue(now + 60_001);
    // The next refresh carries the lapsed platform observation.
    invalidateDeviceAuthority();
    await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).publishDirectory({ ...source, cursor: 2, workspaces: [] });
    expect(await opened.events.next()).toEqual({ type: 'close', code: 1013 });
  });
});
