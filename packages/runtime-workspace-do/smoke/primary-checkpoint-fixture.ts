import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { createModels } from '@earendil-works/pi-ai';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, RuntimeIdentitySchema, RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime';
import { bootstrapSpaceAuthority, GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { SpaceAuthorityDO } from '../../account-worker/src/space-authority.js';
import { createWorkspaceRuntime } from '../src/runtime.js';
import { CloudFileStore } from '../src/cloud-files.js';
import { GitLfsRetention } from '../../account-worker/src/git-lfs-retention.js';
import { Result } from 'better-result';
import { emptyLifecycleState } from '../../protocol-environment/src/lifecycle.js';
import { LifecycleRunSchema } from '../../protocol-environment/src/schema.js';

const identity = RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' });
const unsupported = async (): Promise<never> => { throw new Error('External service forbidden in checkpoint proof'); };
export class PrimaryCheckpointProof extends SpaceAuthorityDO {
  async fetch(request: Request): Promise<Response> {
    const supplied = RuntimeGitCheckpointSchema.parse(await request.json());
    const empty = new URL(request.url).pathname === '/empty';
    const object = GitLfsObjectSchema.parse({ oid: '1'.repeat(64), size: 17 });
    const otherObject = GitLfsObjectSchema.parse({ oid: '2'.repeat(64), size: 23 });
    const checkpoint = empty ? RuntimeGitCheckpointSchema.parse({ ...supplied, lfs: { objects: [{ ...object, source: 'r2' }], heldBack: [] } }) : supplied;
    const state = bootstrapSpaceAuthority(null, { projectId: identity.projectId, spaceId: identity.workspaceId, machineId: 'machine' }, new Date().toISOString());
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO space_authority(id,project_id,space_id,record_json) VALUES(1,?,?,?)', identity.projectId, identity.workspaceId, JSON.stringify(state));
    let sourceReads = 0;
    let retentionCalls = 0, rejectRetention = false, rejectRelease = false;
    const ledger = new GitLfsRetention(this.ctx.storage);
    const uploader = `machine:${checkpoint.checkpointRef}`;
    if (empty) {
      ledger.retain(`publication:${uploader}`, [object]);
      ledger.retain(`publication:other-machine:${checkpoint.checkpointRef}`, [otherObject]);
    }
    const retainLfs = async (value: typeof checkpoint, publicationId?: string) => {
      retentionCalls++;
      if (rejectRetention) throw new Error('Retention temporarily unavailable');
      ledger.snapshot({ snapshotId: `runtime:${identity.workspaceId}:${value.worktreeCommit}`, workspaceId: identity.workspaceId, kind: 'runtime', objects: value.lfs?.objects ?? [] });
      if (rejectRelease) throw new Error('Publication release temporarily unavailable');
      ledger.release(`publication:${publicationId ?? `runtime:${identity.workspaceId}`}`);
    };
    const models = createModels();
    models.setProvider({
      id: 'fixture', name: 'Checkpoint proof', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture-only' } }) } },
      getModels: () => [{ id: 'fixture', name: 'Checkpoint proof', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      stream: () => { throw new Error('Inference forbidden in checkpoint proof'); },
      streamSimple: () => { throw new Error('Inference forbidden in checkpoint proof'); },
    });
    const code = { readFile: unsupported, writeSnapshot: unsupported, mergeSnapshot: async (input: { machine: typeof checkpoint }) => Result.ok(input.machine), listSnapshotPaths: async () => [], listSnapshotEntries: async () => new Map(), readBlob: unsupported };
    const runtime = await createWorkspaceRuntime({
      storage: this.ctx.storage, identity, models, model: { provider: 'fixture', modelId: 'fixture' },
      code,
      lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs,
      initialCheckpoint: async () => { sourceReads++; return empty ? null : checkpoint; },
      tools: { invoke: unsupported, prepareBrowser: unsupported, instructions: async () => '', authorizeCronTool: unsupported },
      operations: { execute: unsupported, reconcile: unsupported, cancel: unsupported, jobScope: () => identity, controlJob: unsupported, observeProcess: unsupported, stopProcess: unsupported, wakeAt: unsupported },
      retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit',
      onReport: error => { throw error; }, admitInference: unsupported, bindInferenceConversation: async () => [],
      session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported },
      qa: { list: async () => [], act: unsupported },
      attachments: { seal: async secret => secret, open: async secret => secret, dispatch: unsupported },
      waitUntil: promise => this.ctx.waitUntil(promise), schedule: async () => {},
    });
    // Use the real durable runtime without bootstrapping provider/inference adapters.
    Object.defineProperty(this, 'runtime', { value: Promise.resolve(runtime) });
    await this.runtimeSnapshot(identity);
    await this.runtimeCodeCheckpoint(identity);
    assert.equal(sourceReads, 0, 'Read-only runtime access must not consult Artifacts');
    const repository: ArtifactsRepo = {
      [Symbol.dispose]() {}, createToken: unsupported, revokeToken: unsupported, listTokens: unsupported, fork: unsupported, readBlob: unsupported, readFile: unsupported, log: async () => [],
      info: async () => ({ id: 'proof', name: 'proof', description: null, defaultBranch: 'main', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.invalid/workspace.git' }),
      readCommit: async hash => ({ hash, treeHash: checkpoint.worktreeTree, parents: [], message: 'proof', author: { name: 'Proof', email: 'proof@example.invalid' }, committer: { name: 'Proof', email: 'proof@example.invalid' }, authoredAt: 1, committedAt: 1 }),
      readTree: async () => [],
    };
    this.env.ARTIFACTS = { get: async () => repository, create: unsupported, import: unsupported, list: unsupported, delete: unsupported };
    const result = await this.runtimeCacheAttachmentRequest({ ...identity, machineId: 'machine', requestId: 'first-primary' });
    const assignment = (await this.runtimeAssignments({ ...identity, machineId: 'machine' })).assignments[0];
    assert(assignment);
    if (empty) {
      assert.equal(assignment.checkpoint, null);
      const publication = RuntimeSnapshotCommitInputSchema.parse({ ...identity, attachmentId: result.attachment.attachmentId, generation: result.attachment.generation, checkpoint, previousWorktreeCommit: null });
      await assert.rejects(runtime.snapshotCommit({ ...publication, generation: publication.generation + 1 }));
      await assert.rejects(runtime.snapshotCommit({ ...publication, previousWorktreeCommit: checkpoint.worktreeCommit }));
      assert.equal(retentionCalls, 0, 'Rejected generations and predecessors must not retain inventory');
      ledger.reconcile(new Set());
      assert.deepEqual(ledger.candidates(), [], 'Rejected snapshots must not release either publisher');
      this.ctx.storage.sql.exec("UPDATE runtime_cloud_writer SET attempt='lease-conflict' WHERE singleton=1");
      await assert.rejects(runtime.snapshotCommit(publication), /publication is busy/u);
      assert.equal(retentionCalls, 0, 'Cloud lease conflict must not retain inventory');
      this.ctx.storage.sql.exec('UPDATE runtime_cloud_writer SET attempt=NULL WHERE singleton=1');
      rejectRetention = true;
      await assert.rejects(runtime.snapshotCommit(publication), /Retention temporarily unavailable/u);
      assert.deepEqual(await runtime.cloudFiles.snapshot(), checkpoint, 'Acceptance survives retention failure');
      rejectRetention = false;
      rejectRelease = true;
      const recover = () => new CloudFileStore(this.ctx.storage, runtime.attachments, code, identity.workspaceId, () => {}, { has: unsupported, get: unsupported, put: unsupported }, retainLfs);
      await assert.rejects(recover().recover(), /Publication release temporarily unavailable/u);
      ledger.reconcile(new Set());
      assert.deepEqual(ledger.candidates(), [], 'Failed release keeps the real uploader pinned');
      rejectRelease = false;
      // Reconstruct without a machine retry: acceptance followed by response loss must drain on its own.
      await recover().recover();
      assert.deepEqual(ledger.candidates(), [], 'Snapshot takes ownership before the uploader is released');
      await runtime.snapshotCommit(publication);
      await runtime.snapshotCommit(publication);
      ledger.reconcile(new Set());
      assert.deepEqual(ledger.candidates(), [object], 'Owner release permits collection without machine cleanup; the other publisher stays pinned');
      ledger.retain(`publication:second-machine:${checkpoint.checkpointRef}`, [object]);
      const duplicate = recover();
      await duplicate.commitMachine(checkpoint, checkpoint.worktreeCommit, 'second-machine');
      await duplicate.commitMachine(checkpoint, checkpoint.worktreeCommit, 'second-machine');
      await recover().recover();
      ledger.reconcile(new Set());
      assert.deepEqual(ledger.candidates(), [object], 'A different accepted publisher of the same checkpoint releases its own pin exactly');
      await assert.rejects(runtime.snapshotCommit({ ...publication, checkpoint: { ...checkpoint, checkpointRef: 'refs/gitspace/unknown' }, previousWorktreeCommit: 'f'.repeat(40) }), /unknown predecessor/u);
    } else assert.deepEqual(assignment.checkpoint, checkpoint, 'First assignment must restore canonical source without prior cloud file execution');
    const lfsRestored = [{ path: 'modified.bin', outcome: 'committed' as const }, { path: 'added.bin', outcome: 'omitted' as const }];
    const ready = { ...identity, machineId: 'machine', attachmentId: result.attachment.attachmentId, generation: result.attachment.generation, commit: checkpoint.worktreeCommit, prerequisitesComplete: true, capabilities: result.attachment.capabilities, lfsRestored };
    await assert.rejects(this.runtimeAttachmentReady({ ...ready, commit: 'f'.repeat(40) }));
    await assert.rejects(this.runtimeAttachmentReady(ready), /durable receipt/u);
    await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${identity.projectId}`).fetch(new Request('https://proof/setup-receipts', { method: 'POST', body: JSON.stringify(result.attachment) }));
    assert.equal((await this.runtimeAttachmentReady(ready)).attachment.state, 'ready');
    assert.deepEqual(await runtime.cloudFiles.snapshot(), checkpoint);
    const root = (await runtime.snapshot()).conversations.find(item => item.parentId === null); assert(root);
    await this.runtimeAttachmentReady(ready);
    const messages = (await runtime.transcript(root.id)).filter(event => JSON.stringify(event.payload).includes('LFS handoff'));
    assert.equal(messages.length, 1);
    assert.match(JSON.stringify(messages[0]!.payload), /modified\.bin: restored committed content/u);
    assert.match(JSON.stringify(messages[0]!.payload), /added\.bin: omitted/u);
    assert.match(JSON.stringify(messages[0]!.payload), /remain on the previous machine/u);
    await assert.rejects(this.runtimeAttachmentReady({ ...ready, lfsRestored: [] }), /proof changed/u);
    const lease = { ...identity, machineId: result.attachment.machineId, attachmentId: result.attachment.attachmentId, generation: result.attachment.generation };
    runtime.attachments.requestCacheAction({ ...lease, requestId: 'reclaim-confirmed', action: { kind: 'reclaim', discardHeldBack: true } });
    let cache = runtime.attachments.list().find(item => item.attachmentId === lease.attachmentId);
    assert.equal(cache?.cacheAction?.discardHeldBack, true, 'Explicit reclaim acceptance survives assignment persistence');
    assert.throws(() => runtime.attachments.requestCacheAction({ ...lease, requestId: 'reclaim-confirmed', action: { kind: 'reclaim' } }), /identity/u);
    assert(cache?.cache);
    runtime.attachments.heartbeat({ ...lease, cache: { ...cache.cache, state: 'paused', reclaimBlocked: 'Held-back LFS: private.bin' }, cacheAction: { requestId: 'reclaim-confirmed', status: 'failed', error: 'Held back' }, executionObservation: { activeExecutions: 0, observedAt: new Date().toISOString(), materializedCommit: checkpoint.worktreeCommit } });
    runtime.attachments.detach({ ...lease, state: 'draining' });
    cache = runtime.attachments.list().find(item => item.attachmentId === lease.attachmentId);
    assert.deepEqual(cache?.detachRequest, {}, 'Generic detach must not inherit the prior reclaim acceptance');
    runtime.attachments.detach({ ...lease, state: 'draining', discardHeldBack: true });
    cache = runtime.attachments.list().find(item => item.attachmentId === lease.attachmentId);
    assert.equal(cache?.detachRequest?.discardHeldBack, true, 'Explicit detach acceptance survives assignment persistence');
    assert(cache?.cache);
    assert.throws(() => runtime.attachments.detach({ ...lease, state: 'detached' }), /final snapshot/u);
    runtime.attachments.recordCacheFlush(lease.attachmentId, lease.generation);
    const reclaimed = runtime.attachments.heartbeat({ ...lease, cache: { ...cache.cache, state: 'reclaimed', reclaimBlocked: null }, executionObservation: { activeExecutions: 0, observedAt: new Date().toISOString(), materializedCommit: checkpoint.worktreeCommit } });
    assert.equal(reclaimed.state, 'draining', 'Explicit detach must not return to resumable attaching state');
    runtime.attachments.detach({ ...lease, state: 'detached' });
    assert.equal((await runtime.attachments.assignments(lease.machineId)).length, 0, 'Detached cache disappears from assignments');
    return Response.json({ passed: true });
  }
}
export class CheckpointMetadata extends DurableObject {
  getProject() { return { id: identity.projectId, lifecycle: 'active', baseBranch: 'main', repositoryReference: null }; }
  listWorkspaces() { return [{ id: identity.workspaceId, projectId: identity.projectId, branch: 'main', lifecycle: 'active' }]; }
  getMachine() { return { id: 'machine', desiredState: 'online' }; }
  hasRuntimeMachine() { return true; }
  async fetch(request: Request) {
    const attachment = RuntimeAttachmentSchema.parse(await request.json());
    await this.ctx.storage.put('attachment', attachment);
    return new Response('saved');
  }
  async getLifecycleState() {
    const state = emptyLifecycleState(identity.projectId, identity.workspaceId);
    const stored = await this.ctx.storage.get('attachment');
    if (stored === undefined) return state;
    const attachment = RuntimeAttachmentSchema.parse(stored);
    state.runs = ['machine/prepare', 'checks', 'workspace/materialize'].map(phase => LifecycleRunSchema.parse({
      id: `attachment:${attachment.attachmentId}:${attachment.generation}:${phase}`,
      projectId: identity.projectId, spaceId: identity.workspaceId, phase, status: 'succeeded', profile: 'default', machineId: attachment.machineId,
      generation: null, attachment: { attachmentId: attachment.attachmentId, generation: attachment.generation }, executionHashes: [], terminalName: null,
      results: [], output: '', exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, failure: null, incidents: [],
    }));
    return state;
  }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<PrimaryCheckpointProof> }) { return env.PROOF.getByName(new URL(request.url).pathname).fetch(request); } };
