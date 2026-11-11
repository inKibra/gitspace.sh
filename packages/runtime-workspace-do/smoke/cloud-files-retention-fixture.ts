import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { Result } from 'better-result';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { CloudFileStore } from '../src/cloud-files.js';

const initial = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/spaces/cloud/checkpoints', branch: 'main', headCommit: '1'.repeat(40), indexCommit: '2'.repeat(40), trackedWorktreeCommit: '3'.repeat(40), worktreeCommit: '4'.repeat(40), indexTree: '5'.repeat(40), worktreeTree: '6'.repeat(40) });
const version = (n: number, machine = 'a') => RuntimeGitCheckpointSchema.parse({ ...initial, checkpointRef: `refs/gitspace/spaces/cache-${machine}/snapshot`, worktreeCommit: n.toString(16).padStart(40, '0') });

export class CloudFilesRetentionProof extends DurableObject {
  async fetch(): Promise<Response> {
    await this.ctx.storage.deleteAll();
    let caches: RuntimeAttachment[] = [], merges = 0;
    const unused = async (): Promise<never> => { throw new Error('Not used by this proof'); };
    const code = {
      readFile: unused, writeSnapshot: unused, listSnapshotPaths: unused, changedSnapshotPaths: unused,
      mergeSnapshot: async (input: { machine: typeof initial }) => { merges++; return Result.ok(input.machine); },
    };
    const lfs = { has: async () => false, get: async () => null, put: async () => {} };
    const open = () => new CloudFileStore(this.ctx.storage, { list: () => caches }, code, 'cloud', () => {}, lfs, async () => {});
    let store = open();
    await this.ctx.storage.put('runtime.code', initial);
    await store.initializeSnapshot();
    const current = async () => { const snapshot = await store.snapshot(); assert(snapshot); return snapshot.worktreeCommit; };

    // Machine b publishes once; then machine a publishes 150 versions, each from the one before.
    await store.commitMachine(version(1000, 'b'), initial.worktreeCommit, 'machine-b');
    for (let n = 1; n <= 150; n++) await store.commitMachine(version(n), await current(), 'machine-a');
    // Everything recorded so far is older than a day, except version 30; machine b reports version 5 as its base.
    this.ctx.storage.sql.exec('UPDATE runtime_code_commits SET recorded_at=0');
    this.ctx.storage.sql.exec('UPDATE runtime_machine_publications SET recorded_at=0');
    this.ctx.storage.sql.exec('UPDATE runtime_code_commits SET recorded_at=? WHERE commit_id=?', Date.now(), version(30).worktreeCommit);
    caches = [RuntimeAttachmentSchema.parse({ projectId: 'p', workspaceId: 'cloud', attachmentId: 'b-0', machineId: 'machine-b', generation: 0, checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: new Date().toISOString(), executionObservation: { activeExecutions: 0, observedAt: new Date().toISOString(), materializedCommit: version(5).worktreeCommit } })];

    // A woken workspace prunes after its first publication.
    store = open();
    await store.commitMachine(version(151), version(150).worktreeCommit, 'machine-a');

    // The current version's last 100 predecessors stay walkable.
    assert.equal(store.snapshotDistance(version(51).worktreeCommit, version(151).worktreeCommit, 100), 100);
    // A base nothing protects is gone: a machine syncing from it is refused.
    await assert.rejects(store.commitMachine(version(2000, 'c'), version(40).worktreeCommit, 'machine-c'), /unknown predecessor/);
    // Each machine's newest publication is answered from its record when retried, without merging again.
    const settled = merges;
    assert.equal((await store.commitMachine(version(1000, 'b'), initial.worktreeCommit, 'machine-b')).worktreeCommit, version(1000, 'b').worktreeCommit);
    assert.equal((await store.commitMachine(version(151), version(150).worktreeCommit, 'machine-a')).worktreeCommit, version(151).worktreeCommit);
    assert.equal(merges, settled);
    // Older settled publications are deleted.
    assert.equal(this.ctx.storage.sql.exec<{ count: number }>('SELECT count(*) AS count FROM runtime_machine_publications').one().count, 2);
    // A machine's reported base and a row of the last day still serve as merge bases.
    await store.commitMachine(version(3000, 'b'), version(5).worktreeCommit, 'machine-b');
    await store.commitMachine(version(4000, 'd'), version(30).worktreeCommit, 'machine-d');

    // A backlog larger than one pass drains over the next publications, then passes wait an hour. Rows recorded so far
    // count as recent here, so only the backlog is old.
    this.ctx.storage.sql.exec('UPDATE runtime_code_commits SET recorded_at=?', Date.now());
    const backlog = (count: number) => { for (let n = 0; n < count; n++) this.ctx.storage.sql.exec('INSERT INTO runtime_code_commits(commit_id,predecessor,checkpoint) VALUES(?,NULL,?)', `old-${crypto.randomUUID()}`, JSON.stringify(initial)); };
    const left = () => this.ctx.storage.sql.exec<{ count: number }>("SELECT count(*) AS count FROM runtime_code_commits WHERE commit_id LIKE 'old-%'").one().count;
    backlog(2_500);
    store = open();
    const remaining: number[] = [];
    for (let n = 5000; n < 5004; n++) {
      await store.commitMachine(version(n), await current(), 'machine-a');
      remaining.push(left());
      if (n === 5002) backlog(10);
    }
    assert.deepEqual(remaining, [1_500, 500, 0, 10]);
    return Response.json({ passed: true });
  }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<CloudFilesRetentionProof> }) { return env.PROOF.getByName('proof').fetch(request); } };
