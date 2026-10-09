import { env, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { Result } from 'better-result';
import { http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeToolDispatchSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import type { LifecycleActor, LifecycleMutation } from '@gitspace/protocol-environment';
import { ArtifactsCodeStore, ArtifactsSnapshotError, AttachmentStore, CloudFileStore } from '@gitspace/runtime-workspace-do';
import { CredentialVaultDO, reconcileFleetMachines } from '../src/application.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';
import { backfillRuntimeLeases } from '../src/runtime-machine-loss.js';
import { network } from './network.js';
import { tenantRootPrivateKey } from './setup.js';

const minute = 60_000;
const hash = `sha256:${'a'.repeat(64)}`;
const repository = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.test/workspace.git' };
const id = (digit: string) => digit.repeat(40);
const base = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/spaces/lease-workspace/checkpoints', headCommit: id('1'), branch: 'main', indexCommit: id('1'), trackedWorktreeCommit: id('1'), worktreeCommit: id('1'), indexTree: id('2'), worktreeTree: id('2') });
const published = { ...base, indexCommit: id('3'), trackedWorktreeCommit: id('3'), worktreeCommit: id('3'), indexTree: id('4'), worktreeTree: id('4') };
const accepted = { ...published, worktreeCommit: id('5'), worktreeTree: id('6') };

beforeEach(() => {
  // Only the external Artifacts service is replaced; every authority is a real Durable Object.
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'initialCheckpoint').mockResolvedValue(null);
});
afterEach(() => vi.restoreAllMocks());

async function workspace(kind: 'sandbox' | 'physical' = 'sandbox') {
  const userId = env.ACCOUNT_ID;
  const projectId = 'lease-project';
  const workspaceId = 'lease-workspace';
  const machineId = 'lease-machine';
  const vault = env.CREDENTIALS.getByName(userId);
  await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
  await vault.registerDevice(signCredentialAuthorityGrant({
    version: 1, userId, machineId, generation: 1, capabilities: ['space.control'],
    signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(new Uint8Array(32).fill(41))),
    exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(37))),
  }, tenantRootPrivateKey));
  const fleet = env.FLEET_CATALOG.getByName(userId);
  await fleet.putMachine({ id: machineId, label: 'Lease machine', kind, provider: kind === 'sandbox' ? 'cloudflare-sandbox' : 'physical', state: 'online', desiredState: 'online', rpcEndpoint: null, notes: '', lifecycleRevision: 1, operationId: null, error: null });
  const project = env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`);
  const created = await project.bootstrap({ id: projectId, name: 'Leases', repositoryReference: null, baseBranch: 'main', createdBy: machineId });
  await project.setProjectLifecycle(created.revision, 'active');
  await project.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Leased', branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const authority = env.SPACE_AUTHORITY.getByName(`${userId}:${workspaceId}`);
  const identity = { projectId, workspaceId };
  const lease = (attachment: RuntimeAttachment) => ({ ...identity, machineId, attachmentId: attachment.attachmentId, generation: attachment.generation });
  const attach = async (requestId: string) => (await authority.runtimeCacheAttachmentRequest({ ...identity, machineId, requestId })).attachment;
  /** Reclaims a cache: it drains, holding a draining lease whose deadline this returns. */
  async function drain(attachment: RuntimeAttachment) {
    const { attachment: reclaiming } = await authority.runtimeCacheAction({ ...lease(attachment), requestId: 'reclaim', action: { kind: 'reclaim' } });
    expect(reclaiming.state).toBe('draining');
    if (reclaiming.deadlineAt === null) throw new Error('A draining cloud cache must hold a deadline');
    return Date.parse(reclaiming.deadlineAt);
  }
  /** A draining cache over a canonical snapshot, ready to publish its final checkpoint. */
  async function finalPublication() {
    await runInDurableObject(authority, (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
      state.storage.sql.exec('INSERT INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(base));
    });
    const attachment = await attach('cache');
    const deadline = await drain(attachment);
    vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (_repository, commit) => ({ hash: commit, treeHash: id('4'), parents: [], message: 'checkpoint', author: { name: 'Fixture', email: 'fixture@example.invalid' }, committer: { name: 'Fixture', email: 'fixture@example.invalid' }, authoredAt: 1, committedAt: 1 }));
    vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotPaths').mockResolvedValue([]);
    const publish = async () => authority.runtimeSnapshotCommit({ ...lease(attachment), checkpoint: published, previousWorktreeCommit: base.worktreeCommit, final: true });
    const writer = () => runInDurableObject(authority, (_instance, state) => state.storage.sql.exec<{ attempt: string | null }>('SELECT attempt FROM runtime_cloud_writer WHERE singleton=1').one().attempt);
    return { attachment, deadline, publish, writer };
  }
  return {
    userId, machineId, identity, project, fleet, authority, lease, attach, drain, finalPublication,
    current: async (attachmentId: string) => (await authority.runtimeMachineAttachments(machineId)).find(item => item.attachmentId === attachmentId),
    sweep: () => runInDurableObject(authority, (instance: SpaceAuthorityDO) => instance.alarm()),
    at: (timestamp: number) => vi.spyOn(Date, 'now').mockReturnValue(timestamp),
  };
}

describe('runtime attachment leases', () => {
  it('expires an overdue draining cache to lost, which releases its barrier so the same machine attaches again', async () => {
    const w = await workspace();
    const first = await w.attach('first');
    expect(Date.parse(first.deadlineAt ?? '') - Date.parse(first.updatedAt)).toBe(20 * minute);
    const deadline = await w.drain(first);
    await expect(w.attach('second')).rejects.toThrow(/fencing barrier/);
    w.at(deadline - 1);
    await w.sweep();
    expect((await w.current(first.attachmentId))?.state).toBe('draining');
    w.at(deadline + 1);
    await w.sweep();
    expect(await w.current(first.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'deadline', deadlineAt: null });
    const second = await w.attach('second');
    expect(second).toMatchObject({ machineId: w.machineId, state: 'attaching' });
    expect(second.generation).toBeGreaterThan(first.generation);
  });

  it('renews a setup lease only on reported progress and records machine failures on the attachment', async () => {
    const w = await workspace();
    const attachment = await w.attach('cache');
    const admitted = Date.parse(attachment.updatedAt);
    const heartbeat = async (now: number, extra: Record<string, unknown> = {}) => {
      w.at(now);
      return w.authority.runtimeHeartbeat({ ...w.lease(attachment), executionObservation: { activeExecutions: 0, observedAt: new Date(now).toISOString() }, ...extra });
    };
    const failure = { operation: 'setup', message: 'apt-get install exited 100', attempts: 2, nextRetryAt: new Date(admitted + 16 * minute).toISOString(), at: new Date(admitted + 15 * minute).toISOString() };
    const progressed = await heartbeat(admitted + 15 * minute, { progress: { phase: 'machine/prepare', at: new Date(admitted + 15 * minute).toISOString() }, failure });
    expect(progressed.attachment).toMatchObject({ deadlineAt: new Date(admitted + 35 * minute).toISOString(), failure });
    const plain = await heartbeat(admitted + 16 * minute);
    expect(plain.attachment).toMatchObject({ deadlineAt: new Date(admitted + 35 * minute).toISOString(), failure });
    const stale = await heartbeat(admitted + 17 * minute, { progress: { phase: 'machine/prepare', at: new Date(admitted + 10 * minute).toISOString() } });
    expect(stale.attachment.deadlineAt).toBe(new Date(admitted + 35 * minute).toISOString());
    w.at(admitted + 21 * minute);
    await w.sweep();
    expect((await w.current(attachment.attachmentId))?.state).toBe('attaching');
    expect((await heartbeat(admitted + 22 * minute, { failure: null })).attachment.failure).toBeNull();
    w.at(admitted + 35 * minute + 1);
    await w.sweep();
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'deadline' });
    await expect(heartbeat(admitted + 36 * minute)).rejects.toThrow(/stale authority/);
  });

  it('ends a lost attachment’s unresolved attempts interrupted and releases its lifecycle claim without a human abandon', async () => {
    const w = await workspace();
    const human: LifecycleActor = { actorId: 'browser', machineId: 'browser', kind: 'browser', lifecycleControl: true };
    const runner: LifecycleActor = { actorId: w.machineId, machineId: w.machineId, kind: 'machine', lifecycleControl: false };
    const other: LifecycleActor = { actorId: 'other-machine', machineId: 'other-machine', kind: 'machine', lifecycleControl: false };
    await w.project.mutateLifecycleState(w.identity.workspaceId, { op: 'configure', bundleJson: JSON.stringify({ version: 1, profiles: { base: {} } }), executions: [{ id: 'prepare', kind: 'script', phase: 'machine/prepare', label: 'Prepare', command: '01-prepare.sh', fileName: '01-prepare.sh', content: 'echo prepare', hash }] }, runner);
    await w.project.mutateLifecycleState(w.identity.workspaceId, { op: 'approval', scope: 'project', executionHash: hash, approved: true }, human);
    const attachment = await w.attach('cache');
    const held = { attachmentId: attachment.attachmentId, generation: attachment.generation };
    const claimed = await w.project.mutateLifecycleState(w.identity.workspaceId, { op: 'claim', runId: 'prepare', phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: 1, rerun: false, attachment: held }, { ...runner, attachment: held });
    if (claimed.status !== 'ok' || !claimed.state.claim?.token) throw new Error('The attachment must own the lifecycle claim');
    expect(await w.project.mutateLifecycleState(w.identity.workspaceId, { op: 'start', runId: 'prepare', token: claimed.state.claim.token }, runner)).toMatchObject({ status: 'ok' });
    const contender: LifecycleMutation = { op: 'claim', runId: 'contender', phase: 'machine/prepare', profile: 'base', executionHashes: [hash], generation: 1, rerun: false };
    expect(await w.project.mutateLifecycleState(w.identity.workspaceId, contender, other)).toMatchObject({ status: 'error', failure: { code: 'RunConflict' } });
    const dispatch = RuntimeToolDispatchSchema.parse({ version: 1, ...w.identity, machineId: w.machineId, attachmentId: attachment.attachmentId, generation: attachment.generation, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: 'request', attemptId: 'in-flight', tool: 'bash', args: { command: 'make' }, deadlineAt: new Date(Date.now() + 120 * minute).toISOString(), replay: 'unsafe' });
    await runInDurableObject(w.authority, (_instance, state) => {
      state.storage.sql.exec("INSERT INTO runtime_attempts(id,dispatch,status) VALUES(?,?,'dispatched')", dispatch.attemptId, JSON.stringify(dispatch));
    });
    w.at(Date.parse(attachment.deadlineAt ?? '') + 1);
    await w.sweep();
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'deadline' });
    expect((await w.project.getLifecycleState(w.identity.workspaceId)).runs.find(run => run.id === 'prepare')).toMatchObject({ status: 'interrupted', failure: { code: 'Interrupted', message: expect.stringContaining('Owning attachment was lost (deadline)') } });
    expect(await w.project.mutateLifecycleState(w.identity.workspaceId, contender, other)).toMatchObject({ status: 'ok', state: { claim: { runId: 'contender', status: 'claimed' } } });
    await runInDurableObject(w.authority, (_instance, state) => {
      const store = new AttachmentStore(state.storage, { seal: async secret => secret, open: async secret => secret, dispatch: async () => { throw new Error('A lost machine must never be asked'); } });
      expect(store.getAttempt(dispatch.attemptId)?.status).toBe('interrupted');
      expect(store.lossResult(dispatch.attemptId)).toMatchObject({ status: 'interrupted', attemptId: dispatch.attemptId, requestId: dispatch.requestId });
    });
  });

  it('marks a destroyed machine’s attachments lost before its credentials are removed', async () => {
    const w = await workspace();
    const attachment = await w.attach('cache');
    const machine = await w.fleet.getMachine(w.machineId);
    if (!machine) throw new Error('Fixture machine is missing');
    await w.fleet.putMachine({ ...machine, state: 'deleting', desiredState: 'removed' });
    network.use(http.all(`${env.PLATFORM_URL}/__platform/tenants/${env.TENANT_ID}/provider/compute/*`, ({ request }) => new URL(request.url).pathname.endsWith('/destroy') ? Response.json({ status: 'ok', value: { machineId: w.machineId } }) : Response.json({ status: 'ok', value: machine })));
    const order: string[] = [];
    const lose = SpaceAuthorityDO.prototype.runtimeLoseMachine;
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeLoseMachine').mockImplementation(async function (this: SpaceAuthorityDO, machineId, reason) {
      const released = await lose.call(this, machineId, reason);
      order.push(...released.map(item => `${item.state}:${item.lossReason}`));
      return released;
    });
    const remove = CredentialVaultDO.prototype.removeManagedDevice;
    vi.spyOn(CredentialVaultDO.prototype, 'removeManagedDevice').mockImplementation(function (this: CredentialVaultDO, machineId) {
      order.push('credentials removed');
      remove.call(this, machineId);
    });
    await reconcileFleetMachines(env, w.userId, w.fleet);
    expect(order).toEqual(['lost:machine-destroyed', 'credentials removed']);
    expect(await w.fleet.wasMachineDestroyed(w.machineId)).toBe(true);
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'machine-destroyed' });
  });

  it('backfills attachments of machines destroyed before leases existed', async () => {
    const w = await workspace('physical');
    const attachment = await w.attach('cache');
    await runInDurableObject(w.authority, (_instance, state) => {
      // Rows and alarms written before leases existed carry no lease at all.
      const { deadlineAt: _deadline, lossReason: _reason, failure: _failure, ...legacy } = RuntimeAttachmentSchema.parse(JSON.parse(state.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments WHERE id=?', attachment.attachmentId).one().record));
      state.storage.sql.exec('UPDATE runtime_attachments SET record=? WHERE id=?', JSON.stringify(legacy), attachment.attachmentId);
      state.storage.sql.exec("DELETE FROM runtime_alarms WHERE owner='leases'");
    });
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'attaching', deadlineAt: null });
    await w.fleet.removeMachine(w.machineId, true);
    expect(await w.fleet.runtimeLeaseBackfillPending()).toBe(true);
    await backfillRuntimeLeases(env, w.userId);
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'machine-destroyed' });
    expect(await w.fleet.runtimeLeaseBackfillPending()).toBe(false);
  });
});

describe('final publication fencing', () => {
  const conflict = () => Result.err(new ArtifactsSnapshotError({ operation: 'writeSnapshot', certainty: 'not-published', message: 'Snapshot conflict: checkpoint ref has advanced' }));
  it.each([
    { outcome: 'lands', merged: () => Result.ok(accepted), canonical: accepted.worktreeCommit, failure: null },
    { outcome: 'is proved unpublished', merged: conflict, canonical: base.worktreeCommit, failure: { operation: 'publish', message: expect.stringContaining('was abandoned') } },
  ])('settles an admitted final publication that $outcome before releasing its overdue cache', async ({ merged, canonical, failure }) => {
    const w = await workspace();
    const { attachment, deadline, publish, writer } = await w.finalPublication();
    const merge = Promise.withResolvers<void>();
    let merging = false;
    vi.spyOn(ArtifactsCodeStore.prototype, 'mergeSnapshot').mockImplementation(async () => { merging = true; await merge.promise; return merged(); });
    let settling = false;
    const settle = CloudFileStore.prototype.settleMachine;
    vi.spyOn(CloudFileStore.prototype, 'settleMachine').mockImplementation(function (this: CloudFileStore, machineId) { settling = true; return settle.call(this, machineId); });
    const publication = publish().catch((error: unknown) => error);
    await expect.poll(() => merging).toBe(true);
    w.at(deadline + 1);
    const sweep = w.sweep();
    await expect.poll(() => settling).toBe(true);
    expect((await w.current(attachment.attachmentId))?.state).toBe('draining');
    merge.resolve();
    await sweep;
    await publication;
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'deadline', failure });
    expect(await writer()).toBeNull();
    expect(await w.authority.runtimeCodeCheckpoint(w.identity)).toMatchObject({ worktreeCommit: canonical });
    expect((await w.attach('replacement')).state).toBe('attaching');
    expect(await w.authority.runtimeCodeCheckpoint(w.identity)).toMatchObject({ worktreeCommit: canonical });
  });

  it('abandons a publication the provider proved unpublished when its cache is lost, so no late finish advances the snapshot', async () => {
    const w = await workspace();
    const { attachment, deadline, publish, writer } = await w.finalPublication();
    const merge = vi.spyOn(ArtifactsCodeStore.prototype, 'mergeSnapshot').mockResolvedValue(conflict());
    await expect(publish()).rejects.toThrow(/Snapshot conflict/);
    expect(await writer()).toMatch(/^machine:/);
    await expect(w.attach('blocked')).rejects.toThrow(/Snapshot conflict/);
    w.at(deadline + 1);
    await w.sweep();
    expect(await w.current(attachment.attachmentId)).toMatchObject({ state: 'lost', lossReason: 'deadline', failure: { operation: 'publish', message: expect.stringContaining('was abandoned') } });
    expect(await writer()).toBeNull();
    merge.mockResolvedValue(Result.ok(accepted));
    expect((await w.attach('replacement')).state).toBe('attaching');
    expect(await w.authority.runtimeCodeCheckpoint(w.identity)).toMatchObject({ worktreeCommit: base.worktreeCommit });
  });
});
