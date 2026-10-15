import { ed25519 } from '@noble/curves/ed25519.js';
import { env, exports } from 'cloudflare:workers';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RELAY_HEARTBEAT_LEASE_MS,
  RELAY_HEARTBEAT_MODE,
  RELAY_NOTICE_MODE,
  RELAY_PING_MESSAGE,
  RELAY_PONG_MESSAGE,
  createRelayAuthorization,
  createSignedControlRequest,
  credentialProtocolBase64,
  signCredentialAuthorityGrant,
} from '@gitspace/protocol';
import { RuntimeAttachInputSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore, AttachmentStore } from '@gitspace/runtime-workspace-do';
import worker, { SpaceAuthorityDO, UserRelayDO } from '../src/index.js';

const rootKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const machineKey = Uint8Array.from({ length: 32 }, (_, index) => 100 + index);
const machineId = 'darktop';
const projectId = 'presence-project';
const grant = signCredentialAuthorityGrant({
  version: 1, userId: env.ACCOUNT_ID, machineId, generation: 1, capabilities: ['storage.access', 'space.control'],
  signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
  exchangePublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(machineKey)),
}, rootKey);
const repository = { id: 'presence-repo', name: 'presence-repo', description: null, defaultBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.test/presence.git' };
const fleet = () => env.FLEET_CATALOG.getByName(env.ACCOUNT_ID);
const space = (workspaceId: string) => env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);

beforeEach(async () => {
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  await vault.bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(49)) });
  await vault.registerDevice(grant);
  await fleet().putMachine({
    id: machineId, label: 'Darktop', state: 'offline', rpcEndpoint: `/tunnel/${machineId}/rpc`, kind: 'physical', provider: 'physical',
    notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null,
  });
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: 'Presence', repositoryReference: null, baseBranch: 'main', createdBy: machineId });
  await project.setProjectLifecycle(created.revision, 'active');
});

afterEach(async () => {
  await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
    for (const socket of state.getWebSockets()) socket.close(1000, 'test complete');
    await state.storage.deleteAlarm();
  });
  vi.restoreAllMocks();
});

/** A worktree whose stored attachment of the machine is indexed by the fleet, as a cache request leaves it. */
async function attachedWorkspace(workspaceId: string, indexed = true) {
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await project.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: workspaceId, branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const identity = { projectId, workspaceId };
  await space(workspaceId).runtimeAttachments(identity);
  const connected = indexed && (await fleet().attachMachineWorkspace(machineId, identity)).connected;
  await runInDurableObject(space(workspaceId), async (_instance, state) => {
    const store = new AttachmentStore(state.storage, { seal: async () => 'sealed', open: async () => 'secret', dispatch: async () => { throw new Error('No dispatch in presence tests'); } });
    await store.attach(RuntimeAttachInputSchema.parse({ ...identity, machineId, generation: 1, checkout: { kind: 'shared', branch: 'main' }, capabilities: [] }), connected);
  });
  return identity;
}

async function connect(query: Record<string, string> = { heartbeat: RELAY_HEARTBEAT_MODE, notices: RELAY_NOTICE_MODE }): Promise<WebSocket> {
  const url = new URL(`https://relay.test/ws?${new URLSearchParams({ role: 'machine', id: machineId, ...query })}`);
  const response = await exports.default.fetch(new Request(url, { headers: {
    upgrade: 'websocket',
    authorization: createRelayAuthorization(machineKey, `${url.pathname}${url.search}`),
    'x-gitspace-machine-grant': btoa(JSON.stringify(grant)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''),
  } }));
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Expected relay WebSocket');
  response.webSocket.accept();
  return response.webSocket;
}

/** Presence is pushed from the relay's background work (`waitUntil`), which exposes no completion signal. */
async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Condition was not reached');
}

const attachmentOnline = async (workspaceId: string) => (await space(workspaceId).runtimeAttachments({ projectId, workspaceId })).find(item => item.machineId === machineId)?.online;
const machineState = async () => (await fleet().getMachine(machineId))?.state;

describe('relay presence', () => {
  it('puts the machine and its attachments online on connect and offline when the socket closes; a replacement never flaps', async () => {
    const workspace = await attachedWorkspace('presence-a');
    expect(await attachmentOnline(workspace.workspaceId)).toBe(false);
    const first = await connect();
    await eventually(async () => await attachmentOnline(workspace.workspaceId) === true);
    expect(await machineState()).toBe('online');
    const presence = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeMachinePresence');
    const closes = vi.spyOn(UserRelayDO.prototype, 'webSocketClose');
    const replaced = new Promise<CloseEvent>(resolve => first.addEventListener('close', resolve, { once: true }));
    const second = await connect();
    expect((await replaced).code).toBe(1000);
    // The relay has handled the replaced socket's close while the replacement stays connected.
    await eventually(async () => closes.mock.calls.length === 1);
    await closes.mock.results[0]?.value;
    expect(presence.mock.calls.filter(([, connected]) => connected === false)).toEqual([]);
    expect(await attachmentOnline(workspace.workspaceId)).toBe(true);
    second.close(1000, 'host stopped');
    await eventually(async () => await attachmentOnline(workspace.workspaceId) === false);
    expect(await machineState()).toBe('offline');
    await connect();
    await eventually(async () => await attachmentOnline(workspace.workspaceId) === true);
    expect(await machineState()).toBe('online');
  });

  it('a workspace that missed the report is put online by the next connection even if the relay already counts the machine connected', async () => {
    const workspace = await attachedWorkspace('presence-missed');
    // As after the deploy that introduced relay presence: the relay counts the machine connected, the attachment is offline.
    await runInDurableObject(env.RELAY.getByName(env.RELAY_NAME), async (_instance, state) => {
      state.storage.sql.exec('INSERT OR IGNORE INTO machine_presence(machine_id) VALUES(?)', machineId);
    });
    expect(await attachmentOnline(workspace.workspaceId)).toBe(false);
    await connect();
    await eventually(async () => await attachmentOnline(workspace.workspaceId) === true);
  });

  it('a new attachment starts with the presence the relay reported', async () => {
    await connect();
    await eventually(async () => await machineState() === 'online');
    const workspace = await attachedWorkspace('presence-late');
    expect(await attachmentOnline(workspace.workspaceId)).toBe(true);
  });

  it('answers the fixed ping without waking the relay, and the answer extends the heartbeat lease', async () => {
    const workspace = await attachedWorkspace('presence-ping');
    const socket = await connect();
    await eventually(async () => await attachmentOnline(workspace.workspaceId) === true);
    // The auto-response time comes from the platform clock, which mocking Date.now cannot move: real time must pass
    // between the connection's lease and the ping's.
    await new Promise<void>(resolve => setTimeout(resolve, 400));
    const pingedAt = Date.now();
    const pong = new Promise<string>(resolve => socket.addEventListener('message', event => resolve(String(event.data)), { once: true }));
    socket.send(RELAY_PING_MESSAGE);
    expect(await pong).toBe(RELAY_PONG_MESSAGE);
    const clock = vi.spyOn(Date, 'now');
    // Past the lease granted at connection, inside the one the answered ping renewed.
    clock.mockReturnValue(pingedAt + RELAY_HEARTBEAT_LEASE_MS - 100);
    await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME));
    expect(socket.readyState).toBe(WebSocket.OPEN);
    const closed = new Promise<CloseEvent>(resolve => socket.addEventListener('close', resolve, { once: true }));
    clock.mockReturnValue(pingedAt + RELAY_HEARTBEAT_LEASE_MS + 1_000);
    await runDurableObjectAlarm(env.RELAY.getByName(env.RELAY_NAME));
    expect((await closed).code).toBe(1011);
    clock.mockRestore();
    await eventually(async () => await attachmentOnline(workspace.workspaceId) === false);
  });
});

describe('relay notices', () => {
  it('reach only machines that negotiated them, and carry no state', async () => {
    const legacy = await connect({ heartbeat: RELAY_HEARTBEAT_MODE });
    const legacyMessages: string[] = [];
    legacy.addEventListener('message', event => legacyMessages.push(String(event.data)));
    await env.RELAY.getByName(env.RELAY_NAME).notifyMachines([machineId], { topics: ['assignments'], workspaceId: 'presence-a' });
    const current = await connect();
    const notice = new Promise<string>(resolve => current.addEventListener('message', event => resolve(String(event.data)), { once: true }));
    await env.RELAY.getByName(env.RELAY_NAME).notifyMachines('all', { topics: ['release', 'devices'] });
    expect(JSON.parse(await notice)).toEqual({ version: 1, type: 'notice', topics: ['release', 'devices'] });
    expect(legacyMessages).toEqual([]);
  });
});

describe('relay live notices', () => {
  it('forwards only notices for the sending machine\'s own resources, and reports one nobody watched', async () => {
    const socket = await connect();
    const messages: unknown[] = [];
    socket.addEventListener('message', event => { messages.push(JSON.parse(String(event.data))); });
    socket.send(JSON.stringify({ version: 1, type: 'live.notice', workspace: 'presence-a', resource: 'terminals:presence-a:other-machine:', cursor: 3 }));
    socket.send(JSON.stringify({ version: 1, type: 'live.notice', workspace: 'presence-a', resource: `terminals:presence-a:${machineId}:`, cursor: 4 }));
    await eventually(async () => messages.length > 0);
    expect(messages).toEqual([{ version: 1, type: 'live.unwatched', workspace: 'presence-a', resource: `terminals:presence-a:${machineId}:`, cursor: 4 }]);
    expect(socket.readyState).toBe(WebSocket.OPEN);
  });
});

describe('machine-wide assignments', () => {
  it('read only the workspaces the fleet index holds for the machine', async () => {
    const indexed = await attachedWorkspace('indexed-a');
    // Another workspace of the account that this machine is not attached to: the account-wide fan-out read it too.
    await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).putWorkspace({ id: 'unattached-b', projectId, kind: 'worktree', name: 'unattached-b', branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    await space('unattached-b').runtimeAttachments({ projectId, workspaceId: 'unattached-b' });
    const reads = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAssignments');
    const response = await worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId, operation: 'runtime.assignments', payload: { machineId }, signingPrivateKey: machineKey })),
    }), env);
    expect(response.status, await response.clone().text()).toBe(200);
    expect(reads.mock.calls.map(([input]) => input)).toEqual([{ ...indexed, machineId }]);
  });

  it('index, once, the attachments recorded before the index existed, so previous-release machines keep them', async () => {
    const recorded = await attachedWorkspace('recorded-before', false);
    const reads = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAssignments');
    const response = await worker.fetch(new Request('https://auth.test/v1/control', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(createSignedControlRequest({ userId: env.ACCOUNT_ID, machineId, operation: 'runtime.assignments', payload: { machineId }, signingPrivateKey: machineKey })),
    }), env);
    expect(response.status).toBe(200);
    expect(reads.mock.calls.map(([input]) => input)).toEqual([{ ...recorded, machineId }]);
  });
});

describe('machine notices', () => {
  /** The notices in the workspace's main conversation, as its transcript shows them. */
  async function notices(workspaceId: string): Promise<string[]> {
    const response = await space(workspaceId).runtimeTranscript({ projectId, workspaceId }, 'ndjson');
    return (await response.text()).split('\n').filter(Boolean).flatMap(line => {
      const message = JSON.parse(line)?.payload?.message;
      return message?.customType === 'gitspace.machine-notice' ? [String(message.content)] : [];
    });
  }

  it('tells the conversation of an absence only once it lasts a minute, then of the return', async () => {
    const workspace = await attachedWorkspace('notice-offline');
    await space(workspace.workspaceId).runtimeMachinePresence(machineId, true);
    // A blip: offline and back within the minute says nothing.
    await space(workspace.workspaceId).runtimeMachinePresence(machineId, false);
    await space(workspace.workspaceId).runtimeMachinePresence(machineId, true);
    expect(await notices(workspace.workspaceId)).toEqual([]);
    await space(workspace.workspaceId).runtimeMachinePresence(machineId, false);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
    await runDurableObjectAlarm(space(workspace.workspaceId));
    clock.mockRestore();
    await space(workspace.workspaceId).runtimeMachinePresence(machineId, true);
    expect(await notices(workspace.workspaceId)).toEqual([
      'Machine Darktop went offline. Commands on it fail until it reconnects; attach another machine if this work cannot wait.',
      'Machine Darktop is back online; commands can run on it again.',
    ]);
  });

  it('tells the conversation of a failed setup step once', async () => {
    const workspace = await attachedWorkspace('notice-setup');
    const [attachment] = await space(workspace.workspaceId).runtimeAttachments(workspace);
    const report = () => space(workspace.workspaceId).runtimeHeartbeat({
      ...workspace, machineId, attachmentId: attachment!.attachmentId, generation: attachment!.generation,
      executionObservation: { activeExecutions: 0, observedAt: new Date().toISOString(), materializedCommit: null },
      cache: { state: 'setup', platform: 'linux', lastSyncAt: null, unsent: null, syncProblem: null, setup: [{ phase: 'workspace/materialize', state: 'failed', runId: 'run-1', error: '30-fail.sh exited 3' }] },
    });
    await report();
    await report();
    expect(await notices(workspace.workspaceId)).toEqual(['Setup on Darktop failed at workspace/materialize: 30-fail.sh exited 3. Commands that need it wait until setup runs again.']);
  });
});
