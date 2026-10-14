import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, DEVICE_SOCKET_PROTOCOL, RPC_DEVICE_HEADER, signDeviceInvite, signRpcRequest, type CloudProjectSummary, type CloudWorkspaceDefinition, type DeviceInvite } from '@gitspace/protocol';
import { accountDirectoryEventSchema, type AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { http, HttpResponse } from 'msw';
import { UserProjectIndexDO, ProjectAuthorityDO } from '../src/project-authority.js';
import type { FleetCatalogDO } from '../src/fleet-catalog.js';
import { DIRECTORY_OUTBOX_MAX_ATTEMPTS, DirectoryOutbox, type DirectoryPublication, type DirectorySource } from '../src/account-directory.js';
import { DurableChangeLog } from '../src/durable-stream.js';
import { invalidateDeviceAuthority } from '../src/device-authority.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';
import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';

afterEach(() => vi.restoreAllMocks());

const timestamp = '2026-09-01T00:00:00.000Z';
const project: CloudProjectSummary = { id: 'directory-project', name: 'Directory', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 1, archivedAt: null, updatedAt: timestamp, role: null, source: null };
const workspace: CloudWorkspaceDefinition = { id: 'directory-space', projectId: project.id, kind: 'worktree', name: 'Directory space', branch: 'feature', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, revision: 1, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
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
  type Event = { type: 'message'; value: StreamEvent<AccountDirectorySnapshot> } | { type: 'close'; code: number };
  const events: Event[] = [];
  const waiters: Array<(event: Event) => void> = [];
  const push = (event: Event) => { const waiter = waiters.shift(); if (waiter) waiter(event); else events.push(event); };
  socket.addEventListener('message', (event) => push({ type: 'message', value: accountDirectoryEventSchema.parse(JSON.parse(String(event.data))) }));
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

  it('retries durable unacknowledged publication after reconstruction and stops alarms when drained', async () => {
    const receiver = env.USER_PROJECTS.getByName('outbox-receiver');
    const sender = env.USER_PROJECTS.getByName('outbox-sender');
    await runInDurableObject(sender, async (_instance, state) => {
      const failAfterAcceptance = { ...env, USER_PROJECTS: { getByName: () => ({ publishDirectory: async (publication: DirectoryPublication) => { await env.USER_PROJECTS.getByName('outbox-receiver').publishDirectory(publication); throw new Error('Acknowledgement lost'); } }) } } as unknown as Env;
      const outbox = new DirectoryOutbox(state, failAfterAcceptance);
      state.storage.transactionSync(() => outbox.enqueue(source));
      await outbox.flush();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect((await receiver.directorySnapshot()).workspaces).toEqual([{ ...workspace, cloudRuntime: false }]);
    await runInDurableObject(sender, async (_instance, state) => {
      const recovered = new DirectoryOutbox(state, { ...env, USER_PROJECTS: { getByName: () => env.USER_PROJECTS.getByName('outbox-receiver') } } as unknown as Env);
      await recovered.flush();
      expect(await state.storage.getAlarm()).toBeNull();
      await recovered.flush();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect((await receiver.directorySnapshot()).projectRevisions[project.id]).toBe(1);
  });

  it('parks a publication the directory keeps refusing until a new enqueue resumes delivery', async () => {
    const sender = env.USER_PROJECTS.getByName('outbox-refused-sender');
    await runInDurableObject(sender, async (_instance, state) => {
      // The directory rejects a workspace claimed for a different project, on every attempt.
      const refused: DirectorySource = { ...source, workspaces: [{ ...workspace, projectId: 'another-project' }] };
      const outbox = new DirectoryOutbox(state, env);
      state.storage.transactionSync(() => outbox.enqueue(refused));
      for (let attempt = 1; attempt < DIRECTORY_OUTBOX_MAX_ATTEMPTS; attempt++) {
        await outbox.flush();
        expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 3_600_000);
      }
      await outbox.flush();
      expect(await state.storage.getAlarm()).toBeNull();
      state.storage.transactionSync(() => outbox.enqueue(refused));
      await outbox.flush();
      expect(await state.storage.getAlarm()).not.toBeNull();
      await state.storage.deleteAlarm();
    });
  });

  it('releases a due outbox wake that has nothing left to deliver instead of re-arming it', async () => {
    await runInDurableObject(env.FLEET_CATALOG.getByName('outbox-idle-fleet'), async (instance: FleetCatalogDO, state) => {
      // A directory wake left due after its publication was already delivered by a request-time flush.
      state.storage.sql.exec("INSERT INTO fleet_alarms(owner,timestamp) VALUES('directory',?) ON CONFLICT(owner) DO UPDATE SET timestamp=excluded.timestamp", Date.now() - 1_000);
      await instance.alarm();
      expect(state.storage.sql.exec("SELECT owner FROM fleet_alarms WHERE owner='directory'").toArray()).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('recovers a source commit that lost publication before the directory accepted it', async () => {
    const receiver = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const sender = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${project.id}`);
    await runInDurableObject(sender, async (_instance, state) => {
      const unavailable = { ...env, USER_PROJECTS: { getByName: () => ({ publishDirectory: async () => { throw new Error('Directory unavailable'); } }) } } as unknown as Env;
      const authority = new ProjectAuthorityDO(state, unavailable);
      await state.blockConcurrencyWhile(async () => {});
      await authority.bootstrap({ ...project, createdBy: machine.id });
      authority.putWorkspace({ ...workspace, expectedRevision: 0 });
      await authority.alarm();
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
    expect(await receiver.list()).toEqual([]);
    await runInDurableObject(sender, async (_instance, state) => {
      const restarted = new ProjectAuthorityDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      await restarted.alarm();
    });
    expect(await receiver.directorySnapshot()).toMatchObject({ projects: [{ id: project.id }], workspaces: [{ id: workspace.id }] });
  });

  it('does not let an in-flight acknowledgement discard a newer committed publication', async () => {
    const receiver = env.USER_PROJECTS.getByName('outbox-newer-receiver');
    const sender = env.USER_PROJECTS.getByName('outbox-newer-sender');
    await runInDurableObject(sender, async (_instance, state) => {
      const accepted = Promise.withResolvers<void>();
      const acknowledge = Promise.withResolvers<void>();
      const outbox = new DirectoryOutbox(state, { ...env, USER_PROJECTS: { getByName: () => ({ publishDirectory: async (publication: DirectoryPublication) => {
        await env.USER_PROJECTS.getByName('outbox-newer-receiver').publishDirectory(publication);
        if (publication.cursor === 1) { accepted.resolve(); await acknowledge.promise; }
        return true;
      } }) } } as unknown as Env);
      state.storage.transactionSync(() => outbox.enqueue(source));
      const first = outbox.flush();
      await accepted.promise;
      state.storage.transactionSync(() => outbox.enqueue({ ...source, workspaces: [] }));
      acknowledge.resolve();
      await first;
      await outbox.flush();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await receiver.directorySnapshot()).toMatchObject({ workspaces: [], projectRevisions: { [project.id]: 2 } });
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

  it('replays durable changes after reconnect and explicitly resyncs ahead and expired cursors', async () => {
    const device = await browserDevice();
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const first = await openDirectory(device.request());
    const initial = await first.events.next();
    expect(initial.type).toBe('message');
    if (initial.type !== 'message') throw new Error('No snapshot');
    const cursor = initial.value.cursor;
    first.socket.close(1000, 'reconnect');
    await index.publishDirectory({ ...source, cursor: 1 });
    const resumed = await openDirectory(device.request(cursor));
    expect(await resumed.events.next()).toMatchObject({ type: 'message', value: { type: 'change', previous: cursor, value: { workspaces: [workspace] } } });
    resumed.socket.close(1000, 'done');
    const ahead = await openDirectory(device.request(Number.MAX_SAFE_INTEGER));
    expect(await ahead.events.next()).toMatchObject({ type: 'message', value: { type: 'resync', reason: 'cursor-ahead' } });
    expect(await ahead.events.next()).toMatchObject({ type: 'message', value: { type: 'snapshot', value: { workspaces: [workspace] } } });
    ahead.socket.close(1000, 'done');
    await runInDurableObject(index, (instance, state) => {
      // Fill the actual bounded log without hundreds of network round trips.
      for (let revision = 2; revision <= 514; revision++) instance.publishDirectory({ ...source, cursor: revision });
      expect(new DurableChangeLog(state.storage).head('account-directory')).toBeGreaterThan(cursor);
    });
    const expired = await openDirectory(device.request(cursor));
    expect(await expired.events.next()).toMatchObject({ type: 'message', value: { type: 'resync', reason: 'cursor-expired' } });
    expect(await expired.events.next()).toMatchObject({ type: 'message', value: { type: 'snapshot', value: { projectRevisions: { [project.id]: 514 } } } });
    expired.socket.close(1000, 'done');
  });

  it('reconstructs delivery from attachments and durable state, then fences revocation', async () => {
    const device = await browserDevice();
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const opened = await openDirectory(device.request());
    const initial = await opened.events.next();
    if (initial.type !== 'message') throw new Error('No snapshot');
    await runInDurableObject(index, async (_instance, state) => {
      const restarted = new UserProjectIndexDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      const snapshot: AccountDirectorySnapshot = { projects: [project], workspaces: [{ ...workspace, cloudRuntime: false }], placements: [], machines: [], projectRevisions: { [project.id]: 1 } };
      // A commit survived eviction immediately before its socket notification.
      state.storage.transactionSync(() => new DurableChangeLog(state.storage).append('account-directory', snapshot));
      await restarted.alarm();
    });
    expect(await opened.events.next()).toMatchObject({ type: 'message', value: { type: 'change', previous: initial.value.cursor, value: { workspaces: [workspace] } } });
    await device.vault.revokeDeviceGrant(device.deviceId);
    await index.publishDirectory({ ...source, cursor: 1 });
    expect(await opened.events.next()).toEqual({ type: 'close', code: 4401 });
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
    expect(await opened.events.next()).toMatchObject({ type: 'message', value: { type: 'change', value: { workspaces: [workspace] } } });
    clock.mockReturnValue(now + 60_001);
    // The next refresh carries the lapsed platform observation.
    invalidateDeviceAuthority();
    await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).publishDirectory({ ...source, cursor: 2 });
    expect(await opened.events.next()).toEqual({ type: 'close', code: 1013 });
  });
});
