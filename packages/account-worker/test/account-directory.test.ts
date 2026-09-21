import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { createDeviceBinding, credentialProtocolBase64, RPC_DEVICE_HEADER, signDeviceInvite, signRpcRequest, type CloudProjectSummary, type CloudWorkspaceDefinition, type DeviceInvite } from '@gitspace/protocol';
import { accountDirectoryEventSchema, type AccountDirectorySnapshot } from '@gitspace/protocol/account-directory';
import type { StreamEvent } from '@gitspace/protocol-sync';
import { http, HttpResponse } from 'msw';
import { UserProjectIndexDO, ProjectAuthorityDO } from '../src/project-authority.js';
import { DirectoryOutbox, type DirectoryPublication, type DirectorySource } from '../src/account-directory.js';
import { DurableChangeLog } from '../src/durable-stream.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

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
  const request = (after?: number, upgrade = true) => {
    const path = `/v1/directory/events${after === undefined ? '' : `?after=${after}`}`;
    const auth = signRpcRequest({ deviceId: binding.deviceId, signingPrivateKey: key, method: 'GET', path, body: new Uint8Array() });
    return new Request(`${env.ACCOUNT_URL}${path}${after === undefined ? '?' : '&'}auth=${encodeURIComponent(auth)}`, { headers: { origin: env.ACCOUNT_URL, ...(upgrade ? { upgrade: 'websocket' } : {}) } });
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
    expect(before.workspaces).toEqual([workspace]);
    await index.publishDirectory({ ...source, cursor: 4, project: { ...project, revision: 2, lifecycle: 'deleting' }, workspaces: [] });
    // Even an erroneously later source publication cannot bypass an account tombstone.
    await index.publishDirectory({ ...source, cursor: 5 });
    expect(await index.directorySnapshot()).toMatchObject({ projects: [], workspaces: [], placements: [], projectRevisions: {} });
    expect(await index.locateWorkspace(workspace.id)).toBeNull();
  });

  it('hydrates pre-feed authorities once and preserves their placement and fleet endpoint', async () => {
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${project.id}`);
    await authority.bootstrap({ ...project, createdBy: 'machine-a' });
    await authority.putWorkspace({ ...workspace, expectedRevision: 0 });
    const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspace.id}`);
    await space.bootstrap({ projectId: project.id, spaceId: workspace.id, machineId: machine.id });
    const fleet = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
    await fleet.putMachine(machine);
    await Promise.all([
      runInDurableObject(authority, (instance) => instance.alarm()),
      runInDurableObject(space, (instance) => instance.alarm()),
      runInDurableObject(fleet, (instance) => instance.alarm()),
    ]);
    // Simulate an existing account at rollout: metadata and authorities predate the projection.
    await runInDurableObject(index, (_instance, state) => {
      state.storage.sql.exec('DELETE FROM directory_sources');
      state.storage.sql.exec('DELETE FROM directory_metadata');
    });
    expect(await index.directorySnapshot()).toMatchObject({ projects: [expect.objectContaining({ id: project.id })], workspaces: [expect.objectContaining({ id: workspace.id, projectId: project.id })], machines: [machine],
      placements: [{ spaceId: workspace.id, holderId: machine.id, generation: 1, state: 'open', endpoint: '/rpc' }] });
    const repeated = await index.directorySnapshot();
    expect(repeated.workspaces).toHaveLength(1);
  });

  it('publishes close, transfer, fleet removal and canonical-session invalidations from authoritative commits', async () => {
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${project.id}`);
    const defined = await authority.bootstrap({ ...project, createdBy: machine.id });
    const definition = await authority.putWorkspace({ ...workspace, expectedRevision: 0 });
    const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspace.id}`);
    const identity = { projectId: project.id, spaceId: workspace.id, machineId: machine.id };
    await space.bootstrap(identity);
    const fleet = env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
    await fleet.putMachine(machine);
    await runInDurableObject(authority, (instance) => instance.alarm());
    await runInDurableObject(space, (instance) => instance.alarm());
    await runInDurableObject(fleet, (instance) => instance.alarm());
    const initial = await index.directorySnapshot();
    const fleetPublication = await fleet.directoryPublication();
    const { notes, ...heartbeat } = machine;
    await fleet.putMachine({ notes, ...heartbeat });
    await runInDurableObject(fleet, async (instance, state) => {
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect(await index.directorySnapshot()).toEqual(initial);
    expect(await fleet.directoryPublication()).toEqual(fleetPublication);
    const delayedPlacement = (await space.directoryPublication())!;
    await authority.putCanonicalSession({ id: 'session-a', workspaceId: workspace.id, ompSessionId: 'omp-a', machineId: machine.id, state: 'active', sessionObjectKey: null, sessionObjectHash: null, sessionFormatVersion: null, activity: { active: false, reasons: [] }, health: { revision: 0, issues: {} }, expectedRevision: 0 });
    await runInDurableObject(authority, (instance) => instance.alarm());
    const activity = await index.directorySnapshot();
    expect(activity.projectRevisions[project.id]).toBeGreaterThan(initial.projectRevisions[project.id]!);
    expect(activity.workspaces).toEqual(initial.workspaces);
    await space.beginClose({ ...identity, expectedGeneration: 1 });
    await space.commitClosed({ ...identity, expectedGeneration: 1, revision: 1, manifestKey: `projects/${project.id}/spaces/${workspace.id}/checkpoints/1/manifest.enc`, manifestHash: `sha256:${'a'.repeat(64)}` });
    await runInDurableObject(space, (instance) => instance.alarm());
    expect((await index.directorySnapshot()).placements).toMatchObject([{ holderId: 'unassigned', generation: 2, state: 'closed', endpoint: null }]);
    await space.beginOpen({ ...identity, machineId: 'machine-b', expectedGeneration: 2 });
    await space.commitOpen({ ...identity, machineId: 'machine-b', expectedGeneration: 2, revision: 1 });
    await fleet.putMachine({ ...machine, id: 'machine-b', rpcEndpoint: '/rpc-b' });
    await runInDurableObject(space, (instance) => instance.alarm());
    await runInDurableObject(fleet, (instance) => instance.alarm());
    expect((await index.directorySnapshot()).placements).toMatchObject([{ holderId: 'machine-b', generation: 3, state: 'open', endpoint: '/rpc-b' }]);
    const delayedFleet = await fleet.directoryPublication();
    await fleet.removeMachine('machine-b', true);
    await runInDurableObject(fleet, (instance) => instance.alarm());
    expect(await index.publishDirectory(delayedPlacement)).toBe(false);
    expect(await index.publishDirectory(delayedFleet)).toBe(false);
    expect((await index.directorySnapshot()).placements).toMatchObject([{ holderId: 'machine-b', endpoint: null }]);
    const archived = await authority.setProjectLifecycle(defined.revision, 'archived');
    await runInDurableObject(authority, (instance) => instance.alarm());
    expect((await index.directorySnapshot()).projects[0]?.lifecycle).toBe('archived');
    await authority.setProjectLifecycle(archived.revision, 'active');
    await authority.removeWorkspace(definition.id, definition.revision);
    await expect(runInDurableObject(authority, (instance: ProjectAuthorityDO) => instance.putWorkspace({ ...workspace, expectedRevision: 0 }))).rejects.toThrow();
    await runInDurableObject(authority, (instance) => instance.alarm());
    expect(await index.directorySnapshot()).toMatchObject({ workspaces: [], placements: [] });
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
    expect((await receiver.directorySnapshot()).workspaces).toEqual([workspace]);
    await runInDurableObject(sender, async (_instance, state) => {
      const recovered = new DirectoryOutbox(state, { ...env, USER_PROJECTS: { getByName: () => env.USER_PROJECTS.getByName('outbox-receiver') } } as unknown as Env);
      await recovered.flush();
      expect(await state.storage.getAlarm()).toBeNull();
      await recovered.flush();
      expect(await state.storage.getAlarm()).toBeNull();
    });
    expect((await receiver.directorySnapshot()).projectRevisions[project.id]).toBe(1);
  });

  it('recovers a source commit that lost publication before the directory accepted it', async () => {
    const receiver = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const sender = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${project.id}`);
    await runInDurableObject(sender, async (_instance, state) => {
      const unavailable = { ...env, USER_PROJECTS: { getByName: () => ({ publishDirectory: async () => { throw new Error('Directory unavailable'); } }) } } as unknown as Env;
      const authority = new ProjectAuthorityDO(state, unavailable);
      await state.blockConcurrencyWhile(async () => {});
      authority.bootstrap({ ...project, createdBy: machine.id });
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

describe('directory WebSocket authentication and replay', () => {
  it('binds the cursor and method to the signature, consumes nonces and rejects foreign origins before upgrade', async () => {
    const device = await browserDevice();
    const request = device.request(0, false);
    const replay = request.clone();
    expect((await SELF.fetch(request)).status).toBe(426);
    expect(await (await SELF.fetch(replay)).json()).toMatchObject({ error: { code: 'REQUEST_REPLAY' } });
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
    const opened = await openDirectory(new Request(`${env.ACCOUNT_URL}${path}?auth=${encodeURIComponent(auth)}`, { headers: { origin: env.ACCOUNT_URL, upgrade: 'websocket' } }));
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

  it('reconstructs delivery from attachments and durable state without consuming the nonce again, then fences revocation', async () => {
    const device = await browserDevice();
    const index = env.USER_PROJECTS.getByName(env.ACCOUNT_ID);
    const opened = await openDirectory(device.request());
    const initial = await opened.events.next();
    if (initial.type !== 'message') throw new Error('No snapshot');
    await runInDurableObject(index, async (_instance, state) => {
      const restarted = new UserProjectIndexDO(state, env);
      await state.blockConcurrencyWhile(async () => {});
      const snapshot: AccountDirectorySnapshot = { projects: [project], workspaces: [workspace], placements: [], machines: [], projectRevisions: { [project.id]: 1 } };
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

  it('fails closed when account authority is unavailable after wake rather than disclosing a committed change', async () => {
    const device = await browserDevice();
    const opened = await openDirectory(device.request());
    await opened.events.next();
    network.use(http.get(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/state`, () => new HttpResponse(null, { status: 503 })));
    await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).publishDirectory({ ...source, cursor: 1 });
    expect(await opened.events.next()).toEqual({ type: 'close', code: 1013 });
  });
});
