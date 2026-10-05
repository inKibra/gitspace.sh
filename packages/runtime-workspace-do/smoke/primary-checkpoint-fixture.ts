import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { createModels } from '@earendil-works/pi-ai';
import { RuntimeGitCheckpointSchema, RuntimeIdentitySchema, RuntimeSnapshotCommitInputSchema } from '@gitspace/protocol-runtime';
import { bootstrapSpaceAuthority } from '@gitspace/protocol-workspace';
import { SpaceAuthorityDO } from '../../account-worker/src/space-authority.js';
import { createWorkspaceRuntime } from '../src/runtime.js';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';

const identity = RuntimeIdentitySchema.parse({ projectId: 'project', workspaceId: 'workspace' });
const unsupported = async (): Promise<never> => { throw new Error('External service forbidden in checkpoint proof'); };
export class PrimaryCheckpointProof extends SpaceAuthorityDO {
  async fetch(request: Request): Promise<Response> {
    const checkpoint = RuntimeGitCheckpointSchema.parse(await request.json());
    const empty = new URL(request.url).pathname === '/empty';
    const state = bootstrapSpaceAuthority(null, { projectId: identity.projectId, spaceId: identity.workspaceId, machineId: 'machine' }, new Date().toISOString());
    this.ctx.storage.sql.exec('INSERT OR REPLACE INTO space_authority(id,project_id,space_id,record_json) VALUES(1,?,?,?)', identity.projectId, identity.workspaceId, JSON.stringify(state));
    let sourceReads = 0;
    let retentionCalls = 0, rejectRetention = false;
    const models = createModels();
    models.setProvider({
      id: 'fixture', name: 'Checkpoint proof', auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: { apiKey: 'fixture-only' } }) } },
      getModels: () => [{ id: 'fixture', name: 'Checkpoint proof', provider: 'fixture', api: 'fixture', baseUrl: 'https://fixture.invalid', input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 8192, maxTokens: 1024 }],
      stream: () => { throw new Error('Inference forbidden in checkpoint proof'); },
      streamSimple: () => { throw new Error('Inference forbidden in checkpoint proof'); },
    });
    const runtime = await createWorkspaceRuntime({
      storage: this.ctx.storage, identity, models, model: { provider: 'fixture', modelId: 'fixture' },
      code: { readFile: unsupported, writeSnapshot: unsupported },
      lfs: { has: unsupported, get: unsupported, put: unsupported }, retainLfs: async value => {
        retentionCalls++;
        const accepted = this.ctx.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').toArray()[0];
        assert(accepted);
        assert.equal(RuntimeGitCheckpointSchema.parse(JSON.parse(accepted.checkpoint)).worktreeCommit, value.worktreeCommit);
        assert.equal(this.ctx.storage.sql.exec('SELECT commit_id FROM runtime_lfs_retention_outbox WHERE commit_id=?', value.worktreeCommit).toArray().length, 1);
        if (rejectRetention) throw new Error('Retention temporarily unavailable');
      },
      initialCheckpoint: async () => { sourceReads++; return empty ? null : checkpoint; },
      tools: { invoke: unsupported, prepareBrowser: unsupported, instructions: async () => '', authorizeCronTool: unsupported },
      operations: { execute: unsupported, reconcile: unsupported, cancel: unsupported, jobScope: () => identity, controlJob: unsupported, wakeAt: unsupported },
      retainedRules: { loadRules: async () => [], judge: unsupported, matchAst: unsupported }, editTool: () => 'edit',
      onReport: error => { throw error; }, admitInference: unsupported, bindInferenceConversation: async () => [],
      session: { catalog: async () => ({ models: [], roles: [] }), reload: unsupported },
      qa: { list: async () => [], act: unsupported }, modelProxy: unsupported, mcpProxy: unsupported,
      attachments: { seal: async secret => secret, open: async secret => secret, dispatch: unsupported },
      waitUntil: promise => this.ctx.waitUntil(promise), schedule: async () => {},
    });
    // Use the real durable runtime without bootstrapping provider/inference adapters.
    Object.defineProperty(this, 'runtime', { value: Promise.resolve(runtime) });
    await this.runtimeSnapshot(identity);
    await this.runtimeCodeCheckpoint(identity);
    assert.equal(sourceReads, 0, 'Read-only runtime access must not consult Artifacts');
    const result = await this.runtimePrimaryAttachmentRequest({ ...identity, machineId: 'machine', requestId: 'first-primary' });
    const assignment = (await this.runtimeAssignments({ ...identity, machineId: 'machine' })).assignments[0];
    assert(assignment);
    if (empty) {
      assert.equal(assignment.checkpoint, null);
      const publication = RuntimeSnapshotCommitInputSchema.parse({ ...identity, attachmentId: result.attachment.attachmentId, generation: result.attachment.generation, checkpoint, previousWorktreeCommit: null });
      await assert.rejects(runtime.snapshotCommit({ ...publication, generation: publication.generation + 1 }));
      await assert.rejects(runtime.snapshotCommit({ ...publication, previousWorktreeCommit: checkpoint.worktreeCommit }));
      assert.equal(retentionCalls, 0, 'Rejected generations and predecessors must not retain inventory');
      this.ctx.storage.sql.exec("UPDATE runtime_cloud_writer SET attempt='lease-conflict' WHERE singleton=1");
      await assert.rejects(runtime.snapshotCommit(publication), /writer lease/u);
      assert.equal(retentionCalls, 0, 'Cloud lease conflict must not retain inventory');
      this.ctx.storage.sql.exec('UPDATE runtime_cloud_writer SET attempt=NULL WHERE singleton=1');
      rejectRetention = true;
      await assert.rejects(runtime.snapshotCommit(publication), /Retention temporarily unavailable/u);
      assert.deepEqual(await runtime.cloudFiles.snapshot(), checkpoint, 'Acceptance survives retention failure');
      assert.equal(this.ctx.storage.sql.exec('SELECT commit_id FROM runtime_lfs_retention_outbox').toArray().length, 1);
      rejectRetention = false;
      await runtime.snapshotCommit(publication);
      await runtime.snapshotCommit(publication);
      assert.equal(retentionCalls, 2, 'Accepted retry drains once; acknowledged replay does not retain again');
      assert.equal(this.ctx.storage.sql.exec('SELECT commit_id FROM runtime_lfs_retention_outbox').toArray().length, 0);
      await assert.rejects(runtime.snapshotCommit({ ...publication, checkpoint: { ...checkpoint, worktreeCommit: 'f'.repeat(40) }, previousWorktreeCommit: checkpoint.worktreeCommit }));
    } else assert.deepEqual(assignment.checkpoint, checkpoint, 'First assignment must restore canonical source without prior cloud file execution');
    const lfsRestored = [{ path: 'modified.bin', outcome: 'committed' as const }, { path: 'added.bin', outcome: 'omitted' as const }];
    const ready = { ...identity, machineId: 'machine', attachmentId: result.attachment.attachmentId, generation: result.attachment.generation, commit: checkpoint.worktreeCommit, prerequisitesComplete: true, capabilities: result.attachment.capabilities, lfsRestored };
    await assert.rejects(this.runtimeAttachmentReady({ ...ready, commit: 'f'.repeat(40) }));
    assert.equal((await this.runtimeAttachmentReady(ready)).attachment.state, 'ready');
    assert.deepEqual(await runtime.cloudFiles.snapshot(), checkpoint);
    const rootHandle = await runtime.harness.root(BACKGROUND_CONTEXT);
    const pivot = await rootHandle.commit(tx => tx.appendEntry(rootHandle.id, { kind: 'proof.before-handoff' }), BACKGROUND_CONTEXT);
    const otherConversation = await rootHandle.fork(pivot.id, { ownership: { kind: 'ownerless' } }, BACKGROUND_CONTEXT);
    const root = (await runtime.snapshot()).conversations.find(item => item.parentId === null); assert(root);
    await runtime.assignPlacement(root.id, ready.attachmentId, ready.generation);
    await runtime.assignPlacement(root.id, ready.attachmentId, ready.generation);
    await this.runtimeAttachmentReady(ready);
    await runtime.assignPlacement(root.id, ready.attachmentId, ready.generation);
    const messages = (await runtime.transcript(root.id)).filter(event => JSON.stringify(event.payload).includes('LFS handoff'));
    assert.equal(messages.length, 1);
    assert.match(JSON.stringify(messages[0]!.payload), /modified\.bin: restored committed content/u);
    assert.match(JSON.stringify(messages[0]!.payload), /added\.bin: omitted/u);
    assert.match(JSON.stringify(messages[0]!.payload), /remain on the previous machine/u);
    await assert.rejects(this.runtimeAttachmentReady({ ...ready, lfsRestored: [] }), /proof changed/u);
    const otherEntries = await otherConversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    assert.equal(otherEntries.items.some(entry => entry.kind === 'gitspace.lfs-restored'), false);
    return Response.json({ passed: true });
  }
}
export class CheckpointMetadata extends DurableObject {
  getProject() { return { id: identity.projectId, lifecycle: 'active', baseBranch: 'main', repositoryReference: null }; }
  listWorkspaces() { return [{ id: identity.workspaceId, projectId: identity.projectId, branch: 'main', lifecycle: 'active' }]; }
  getMachine() { return { id: 'machine', desiredState: 'online' }; }
  hasRuntimeMachine() { return true; }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<PrimaryCheckpointProof> }) { return env.PROOF.getByName(new URL(request.url).pathname).fetch(request); } };
