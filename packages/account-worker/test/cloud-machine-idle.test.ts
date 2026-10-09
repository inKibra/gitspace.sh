import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachmentKeepsMachineRunning, CLOUD_MACHINE_IDLE_CHECK_MS, CLOUD_MACHINE_IDLE_STOP_MS, type FleetCatalogDO, type FleetMachineDefinition } from '../src/fleet-catalog.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

afterEach(() => vi.restoreAllMocks());

const timestamp = '2026-10-08T00:00:00.000Z';
const idleCache = RuntimeAttachmentSchema.parse({
  projectId: 'project-a', workspaceId: 'workspace-a', attachmentId: 'attachment-a', machineId: 'sandbox-a', generation: 1,
  role: 'cache', checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: timestamp, heartbeatAt: timestamp,
  cache: { state: 'live', platform: null, activity: [{ reason: 'watcher', name: 'files' }, { reason: 'grace', name: 'idle' }], lastActivityAt: timestamp, pausedAt: null, reclaimAt: null, lastSyncAt: null, localWorkOptIn: false, reclaimBlocked: null, setup: [{ phase: 'checks', state: 'succeeded', runId: null, error: null }] },
});

describe('cloud machine idle intent', () => {
  it('treats a ready cache with only watcher or grace activity, and lost or detached attachments, as idle', () => {
    expect(attachmentKeepsMachineRunning(idleCache)).toBe(false);
    expect(attachmentKeepsMachineRunning({ ...idleCache, state: 'lost', cache: { ...idleCache.cache!, localWorkOptIn: true } })).toBe(false);
    expect(attachmentKeepsMachineRunning({ ...idleCache, state: 'detached', cache: { ...idleCache.cache!, localWorkOptIn: true } })).toBe(false);
  });

  it.each([
    ['local work opted in', { cache: { ...idleCache.cache!, localWorkOptIn: true } }],
    ['terminal activity', { cache: { ...idleCache.cache!, activity: [{ reason: 'terminal', name: 'shell' }] } }],
    ['service activity', { cache: { ...idleCache.cache!, activity: [{ reason: 'service', name: 'web' }] } }],
    ['command activity', { cache: { ...idleCache.cache!, activity: [{ reason: 'command', name: 'bun test' }] } }],
    ['running setup', { cache: { ...idleCache.cache!, setup: [{ phase: 'checks', state: 'running', runId: 'run-a', error: null }] } }],
    ['a requested reclaim', { cacheAction: { requestId: 'reclaim-a', action: 'reclaim', status: 'requested', error: null } }],
    ['a running reclaim', { cacheAction: { requestId: 'reclaim-a', action: 'reclaim', status: 'running', error: null } }],
    ['a pending retry', { failure: { operation: 'sync', message: 'push rejected', attempts: 2, nextRetryAt: timestamp, at: timestamp } }],
    ['a reclaim blocked on the user', { cache: { ...idleCache.cache!, reclaimBlocked: 'Held-back LFS objects need a decision' } }],
    ['active executions', { executionObservation: { activeExecutions: 1, observedAt: timestamp } }],
    ['setup in flight', { state: 'attaching' }],
    ['reclaim in flight', { state: 'draining' }],
  ] as const)('keeps the machine running for %s', (_name, change) => {
    expect(attachmentKeepsMachineRunning(RuntimeAttachmentSchema.parse({ ...idleCache, ...change }))).toBe(true);
  });
});

it('sleeps an idle cloud machine after the idle window on a fake clock and keeps one with attachment intent', async () => {
  const userId = env.ACCOUNT_ID;
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const repository = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: timestamp, updatedAt: timestamp, lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.test/workspace.git' };
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'initialCheckpoint').mockResolvedValue(null);
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId: 'sandbox-busy', generation: 1, capabilities: ['space.control'],
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(new Uint8Array(32).fill(41))),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(37))),
  }, tenantRootPrivateKey));
  const catalog = env.FLEET_CATALOG.getByName(userId);
  const sandbox: FleetMachineDefinition = { id: 'sandbox-idle', label: 'Idle', state: 'online', rpcEndpoint: null, kind: 'sandbox', provider: 'cloudflare-sandbox', notes: '', desiredState: 'online', lifecycleRevision: 1, operationId: null, error: null };
  const laptop: FleetMachineDefinition = { ...sandbox, id: 'laptop', label: 'Laptop', kind: 'physical', provider: 'physical' };
  await catalog.putMachine(sandbox);
  await catalog.putMachine({ ...sandbox, id: 'sandbox-busy', label: 'Busy' });
  await catalog.putMachine(laptop);
  const project = env.PROJECT_AUTHORITY.getByName(`${userId}:project-a`);
  const created = await project.bootstrap({ id: 'project-a', name: 'Project A', repositoryReference: null, baseBranch: 'main', createdBy: 'sandbox-busy' });
  await env.USER_PROJECTS.getByName(userId).put(await project.setProjectLifecycle(created.revision, 'active'));
  await project.putWorkspace({ id: 'workspace-a', projectId: 'project-a', kind: 'worktree', name: 'Cached', branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  // Setup in flight on the busy machine is attachment intent.
  await env.SPACE_AUTHORITY.getByName(`${userId}:workspace-a`).runtimeCacheAttachmentRequest({ projectId: 'project-a', workspaceId: 'workspace-a', machineId: 'sandbox-busy', requestId: 'attach-cache' });
  const actions: string[] = [];
  network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => {
    const [machineId, action] = new URL(request.url).pathname.split('/').slice(-2);
    actions.push(`${machineId}:${action}`);
    if (machineId !== sandbox.id) throw new Error(`Only the idle machine may be contacted: ${machineId}:${action}`);
    if (action === 'status') return Response.json({ status: 'ok', value: sandbox });
    if (action === 'prepare-replacement') return Response.json({ prepared: true, machineId: sandbox.id });
    if (action === 'sleep') return Response.json({ status: 'ok', value: { ...sandbox, state: 'offline', desiredState: 'offline' } });
    throw new Error(`Unexpected provider operation ${action}`);
  }));
  const sweep = async (advance: number) => {
    now += advance;
    await runInDurableObject(catalog, (instance: FleetCatalogDO) => instance.alarm());
  };
  // First observation starts the idle window; the check just short of it stops nothing.
  await sweep(CLOUD_MACHINE_IDLE_CHECK_MS);
  await sweep(CLOUD_MACHINE_IDLE_STOP_MS - 1);
  expect(actions).toEqual([]);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'online', desiredState: 'online' });
  await sweep(CLOUD_MACHINE_IDLE_CHECK_MS);
  expect(actions).toEqual(['sandbox-idle:status', 'sandbox-idle:prepare-replacement', 'sandbox-idle:sleep']);
  expect(await catalog.getMachine(sandbox.id)).toMatchObject({ state: 'offline', desiredState: 'offline', error: null });
  expect(await catalog.getMachine('sandbox-busy')).toMatchObject({ state: 'online', desiredState: 'online' });
  expect(await catalog.getMachine(laptop.id)).toEqual(laptop);
});
