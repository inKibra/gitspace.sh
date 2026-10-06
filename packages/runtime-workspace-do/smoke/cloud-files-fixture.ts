import { DurableObject } from 'cloudflare:workers';
import { strict as assert } from 'node:assert';
import { Result } from 'better-result';
import { canonicalJson, RuntimeAttachInputSchema, RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import { CloudFileStore } from '../src/cloud-files.js';
import { AttachmentStore } from '../src/attachments.js';
import { ArtifactsSnapshotError, type WriteSnapshotInput } from '../src/artifacts.js';
import { collectBytes, GitLfsObjectSchema, type GitLfsStore } from '@gitspace/protocol-workspace';

const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: 'refs/gitspace/spaces/cloud/checkpoints', branch: 'main', headCommit: '1'.repeat(40), indexCommit: '2'.repeat(40), trackedWorktreeCommit: '3'.repeat(40), worktreeCommit: '4'.repeat(40), indexTree: '5'.repeat(40), worktreeTree: '6'.repeat(40) });
export class CloudFilesProof extends DurableObject {
  async fetch(): Promise<Response> {
    await this.ctx.storage.deleteAll();
    let primary: RuntimeAttachment[] = [], failPush = false, pushes = 0;
    let pause: { entered: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined;
    let loseResponse = false, rejectWrite = false;
    const published = new Map<string, typeof checkpoint>();
    const files = new Map<string, string>([['file.txt', 'one\ntwo\nthree'], ['repeat.txt', 'same same']]);
    const headAttributes = new Map<string, string>();
    const blobs = new Map<string, Blob>();
    let blobReads = 0;
    class UnreadBlob extends Blob {
      override async arrayBuffer(): Promise<ArrayBuffer> { blobReads++; throw new Error('Unexpected Blob materialization'); }
      override async text(): Promise<string> { blobReads++; throw new Error('Unexpected Blob materialization'); }
    }
    const payloads = new Map<string, Uint8Array>();
    let payloadGets = 0;
    let payloadStream: (() => AsyncIterable<Uint8Array>) | undefined;
    async function* chunks(bytes: Uint8Array) {
      yield bytes.subarray(0, Math.floor(bytes.byteLength / 2));
      yield bytes.subarray(Math.floor(bytes.byteLength / 2));
    }
    const lfs: GitLfsStore = {
      has: async object => payloads.has(object.oid),
      get: async object => {
        payloadGets++;
        if (payloadStream) return payloadStream();
        const bytes = payloads.get(object.oid);
        return bytes ? chunks(bytes) : null;
      },
      put: async (object, source) => { payloads.set(object.oid, await collectBytes(source, object.size)); },
    };
    const retained = new Map<string, typeof checkpoint>();
    let retentionUnavailable = false, retentionCalls = 0;
    const retainLfs = async (value: typeof checkpoint) => {
      retentionCalls++;
      if (retentionUnavailable) throw new Error('Retention unavailable');
      retained.set(value.worktreeCommit, value);
    };
    const code = {
      readFile: async (_repository: string, commit: string, path: string) => {
        const blob = blobs.get(path);
        if (blob) return blob;
        const source = path.endsWith('.gitattributes') && commit === checkpoint.headCommit ? headAttributes : files;
        return source.has(path) ? new Blob([source.get(path)!]) : null;
      },
      writeSnapshot: async (input: WriteSnapshotInput) => {
        if (pause) { pause.entered.resolve(); await pause.release.promise; }
        const key = JSON.stringify([input.previous, input.mutations]);
        const existing = published.get(key);
        if (existing) return Result.ok(existing);
        if (rejectWrite) return Result.err(new ArtifactsSnapshotError({ operation: 'writeSnapshot', message: 'invalid tree entry', certainty: 'not-published' }));
        if (failPush) return Result.err(new ArtifactsSnapshotError({ operation: 'writeSnapshot', message: 'lost response', certainty: 'unknown' }));
        if (input.mutations.every(mutation => mutation.content !== null && files.get(mutation.path) === new TextDecoder().decode(mutation.content))) {
          if (loseResponse) { loseResponse = false; return Result.err(new ArtifactsSnapshotError({ operation: 'writeSnapshot', message: 'unchanged response lost', certainty: 'unknown' })); }
          return Result.ok(input.previous);
        }
        pushes++;
        for (const mutation of input.mutations) { if (mutation.content === null) files.delete(mutation.path); else files.set(mutation.path, new TextDecoder().decode(mutation.content)); }
        const next = { ...input.previous, worktreeCommit: pushes.toString(16).padStart(40, '0'), worktreeTree: '7'.repeat(40) };
        published.set(key, next);
        if (loseResponse) { loseResponse = false; return Result.err(new ArtifactsSnapshotError({ operation: 'writeSnapshot', message: 'response lost after push', certainty: 'unknown' })); }
        return Result.ok(next);
      },
    };
    const open = () => new CloudFileStore(this.ctx.storage, { list: () => primary }, code, 'cloud', () => {}, lfs, retainLfs);
    let store = open();
    const invoke = (tool: 'read' | 'write' | 'edit', args: unknown, id: string = crypto.randomUUID()) => store.execute({ tool, args, requestId: id, attemptId: id });
    assert.equal((await invoke('read', { path: 'file.txt' })).status, 'failed');
    await this.ctx.storage.put('runtime.code', checkpoint);
    assert.deepEqual((await invoke('read', { path: 'file.txt', offset: 2, limit: 1 })).content, [{ type: 'text', text: 'two' }]);
    assert.equal((await invoke('read', { path: 'absent' })).status, 'failed');
    assert.equal((await invoke('edit', { path: 'repeat.txt', edits: [{ oldText: 'same', newText: 'other' }] })).status, 'failed');
    assert.equal((await invoke('edit', { path: 'file.txt', edits: [{ oldText: 'one\ntwo', newText: 'other' }, { oldText: 'two', newText: 'overlap' }] })).status, 'failed');
    assert.equal((await invoke('write', { path: '../escape', content: 'bad' })).status, 'failed');
    const written = await invoke('write', { path: 'new.txt', content: 'written' }, 'write-once');
    assert.equal(written.status, 'completed');
    assert.deepEqual(await invoke('write', { path: 'new.txt', content: 'written' }, 'write-once'), written);
    assert.equal(pushes, 1);
    await assert.rejects(invoke('write', { path: 'new.txt', content: 'different' }, 'write-once'));
    const first = await store.snapshot(); assert(first);
    assert.equal(first.headCommit, checkpoint.headCommit); assert.equal(first.indexCommit, checkpoint.indexCommit);
    assert.throws(() => store.commitMachine(checkpoint, 'f'.repeat(40), 'machine'), /stale predecessor/);
    const ancestry = () => this.ctx.storage.sql.exec('SELECT * FROM runtime_code_commits ORDER BY commit_id').toArray();
    const beforeNoop = ancestry();
    for (const [tool, args] of [
      ['write', { path: 'new.txt', content: 'written' }],
      ['edit', { path: 'new.txt', edits: [{ oldText: 'written', newText: 'written' }] }],
    ] as const) {
      assert.equal((await invoke(tool, args)).status, 'completed');
      assert.deepEqual(await store.snapshot(), first);
      assert.deepEqual(ancestry(), beforeNoop);
    }
    loseResponse = true;
    await assert.rejects(invoke('write', { path: 'new.txt', content: 'written' }, 'noop-recover'));
    store = open();
    await store.recover();
    assert.equal((await invoke('write', { path: 'new.txt', content: 'written' }, 'noop-recover')).status, 'completed');
    assert.deepEqual(await store.snapshot(), first);
    assert.deepEqual(ancestry(), beforeNoop);
    assert.equal((await invoke('edit', { path: 'file.txt', edits: [{ oldText: 'two', newText: 'changed' }] })).status, 'completed');
    assert.equal(files.get('file.txt'), 'one\nchanged\nthree');
    failPush = true;
    await assert.rejects(invoke('write', { path: 'retry.txt', content: 'durable' }, 'retry'));
    assert.equal((await invoke('write', { path: 'other.txt', content: 'blocked' })).status, 'failed');
    const attachments = new AttachmentStore(this.ctx.storage, { seal: async secret => secret, open: async secret => secret, dispatch: async () => { throw new Error('No machine transport in fixture'); } });
    const admission = RuntimeAttachInputSchema.parse({ projectId: 'p', workspaceId: 'cloud', machineId: 'm', generation: 0, role: 'primary', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['read', 'write', 'edit'] });
    await assert.rejects(attachments.attach(admission), /Cloud mutation/);
    store = open(); failPush = false; await store.recover();
    assert.equal(files.get('retry.txt'), 'durable');
    assert.equal((await invoke('write', { path: 'retry.txt', content: 'durable' }, 'retry')).status, 'completed');
    loseResponse = true;
    await assert.rejects(invoke('write', { path: 'published.txt', content: 'persisted before response' }, 'published'));
    const pushedBeforeRecovery = pushes;
    store = open(); await store.recover();
    assert.equal(pushes, pushedBeforeRecovery);
    assert.equal((await invoke('write', { path: 'published.txt', content: 'persisted before response' }, 'published')).status, 'completed');
    rejectWrite = true;
    assert.equal((await invoke('write', { path: 'bad-tree.txt', content: 'reject' })).status, 'failed');
    rejectWrite = false;
    assert.equal((await invoke('write', { path: 'unblocked.txt', content: 'lease released' })).status, 'completed');
    const beforeRetentionFailure = await store.snapshot();
    retentionUnavailable = true;
    await assert.rejects(invoke('write', { path: 'retention-recovery.txt', content: 'accepted before acknowledgement' }, 'retention-recovery'), /Retention unavailable/u);
    const acceptedWithoutAck = await store.snapshot(); assert(acceptedWithoutAck);
    assert.notEqual(acceptedWithoutAck.worktreeCommit, beforeRetentionFailure?.worktreeCommit);
    assert(store.lfsRoots().some(root => root.worktreeCommit === beforeRetentionFailure?.worktreeCommit), 'Previous root survives pending acknowledgement');
    const pushesBeforeRetentionRecovery = pushes;
    store = open();
    await assert.rejects(store.recover(), /Retention unavailable/u);
    retentionUnavailable = false;
    await store.recover();
    assert.equal((await invoke('write', { path: 'retention-recovery.txt', content: 'accepted before acknowledgement' }, 'retention-recovery')).status, 'completed');
    assert.equal(pushes, pushesBeforeRetentionRecovery, 'Cold recovery retries retention without republishing');
    assert.equal(this.ctx.storage.sql.exec('SELECT commit_id FROM runtime_lfs_retention_outbox').toArray().length, 0);
    assert(!store.lfsRoots().some(root => root.worktreeCommit === beforeRetentionFailure?.worktreeCommit), 'Historical acceptance alone is not a restore root');
    const interrupted = { tool: 'write', args: { path: 'before-prepare.txt', content: 'recovered' }, requestId: 'before-prepare', attemptId: 'before-prepare' };
    this.ctx.storage.sql.exec('INSERT INTO runtime_cloud_files(id,input) VALUES(?,?)', interrupted.attemptId, canonicalJson(interrupted));
    this.ctx.storage.sql.exec('UPDATE runtime_cloud_writer SET fence=fence+1,attempt=? WHERE singleton=1', interrupted.attemptId);
    store = open(); await store.recover();
    assert.equal(files.get('before-prepare.txt'), 'recovered');
    pause = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
    const concurrent = invoke('write', { path: 'concurrent.txt', content: 'first' });
    await pause.entered.promise;
    const callsBeforeConflict = retentionCalls;
    assert.equal((await invoke('write', { path: 'concurrent.txt', content: 'second' })).status, 'failed');
    await assert.rejects(attachments.attach(admission), /Cloud mutation/);
    assert.equal(retentionCalls, callsBeforeConflict, 'Rejected cloud writers do not retain inventory');
    pause.release.resolve(); pause = undefined;
    assert.equal((await concurrent).status, 'completed');
    assert.equal(files.get('concurrent.txt'), 'first');
    const attached = (await attachments.attach(admission)).attachment;
    const ready = { projectId: attached.projectId, workspaceId: attached.workspaceId, machineId: attached.machineId, attachmentId: attached.attachmentId, generation: attached.generation, commit: checkpoint.worktreeCommit, prerequisitesComplete: true as const, capabilities: attached.capabilities };
    assert.throws(() => attachments.ready(ready), /readiness proof/);
    assert.throws(() => attachments.ready(ready, 'f'.repeat(40)), /readiness proof/);
    attachments.ready(ready, checkpoint.worktreeCommit);
    primary = attachments.list();
    assert.equal((await invoke('write', { path: 'owned.txt', content: 'blocked' })).status, 'failed');
    assert.equal(store.hasAttempt('write-once'), true);
    assert.equal(store.hasAttempt('never-dispatched'), false);
    const replayPushes = pushes;
    assert.deepEqual(await invoke('write', { path: 'new.txt', content: 'written' }, 'write-once'), written);
    assert.equal(pushes, replayPushes);
    attachments.transition(attached.attachmentId, attached.generation, 'lost'); primary = attachments.list();
    assert.equal((await invoke('write', { path: 'lost.txt', content: 'blocked' })).status, 'failed');
    attachments.transition(attached.attachmentId, attached.generation, 'draining');
    assert.throws(() => attachments.transition(attached.attachmentId, attached.generation, 'detached'), /final snapshot/);
    assert.throws(() => attachments.recordPrimaryFlush(attached.attachmentId, attached.generation + 1), /draining primary/);
    attachments.recordPrimaryFlush(attached.attachmentId, attached.generation);
    attachments.transition(attached.attachmentId, attached.generation, 'detached'); primary = attachments.list();
    const afterDetach = await invoke('write', { path: 'after-detach.txt', content: 'resumed' }, 'after-detach');
    assert.equal(afterDetach.status, 'completed');
    assert.deepEqual((await invoke('read', { path: 'after-detach.txt' })).content, [{ type: 'text', text: 'resumed' }]);
    const nextPrimary = (await attachments.attach(RuntimeAttachInputSchema.parse({ ...admission, machineId: 'machine-b' }))).attachment;
    const cloudCheckpoint = await store.snapshot(); assert(cloudCheckpoint);
    attachments.ready({ ...ready, machineId: nextPrimary.machineId, attachmentId: nextPrimary.attachmentId, generation: nextPrimary.generation, commit: cloudCheckpoint.worktreeCommit }, cloudCheckpoint.worktreeCommit);
    primary = attachments.list();
    const handoffPushes = pushes;
    assert.deepEqual(await invoke('write', { path: 'after-detach.txt', content: 'resumed' }, 'after-detach'), afterDetach);
    assert.equal(pushes, handoffPushes);
    assert.equal((await invoke('write', { path: 'after-b.txt', content: 'blocked' })).status, 'failed');
    await assert.rejects(attachments.attach(admission), /stale/);
    primary = [RuntimeAttachmentSchema.parse({ ...attached, state: 'attaching' })];
    assert.equal((await invoke('write', { path: 'attaching.txt', content: 'blocked' })).status, 'failed');
    primary = [];
    await this.ctx.storage.delete('runtime.code');
    this.ctx.storage.sql.exec('DELETE FROM runtime_code_snapshot');
    this.ctx.storage.sql.exec('DELETE FROM runtime_code_commits');
    const seedEntered = Promise.withResolvers<void>(), seedRelease = Promise.withResolvers<void>();
    const seedingStore = new CloudFileStore(this.ctx.storage, { list: () => primary }, code, 'cloud', () => {}, lfs, retainLfs, async () => { seedEntered.resolve(); await seedRelease.promise; return checkpoint; });
    assert.equal(await seedingStore.snapshot(), null, 'Reading runtime state must not initialize an Artifacts repository');
    const seed = seedingStore.execute({ tool: 'read', args: { path: 'file.txt' }, requestId: 'raced-seed', attemptId: 'raced-seed' });
    await seedEntered.promise;
    primary = [RuntimeAttachmentSchema.parse({ ...attached, state: 'attaching' })];
    seedRelease.resolve();
    assert.equal((await seed).status, 'failed');
    primary = [];
    store = new CloudFileStore(this.ctx.storage, { list: () => primary }, code, 'cloud', () => {}, lfs, retainLfs, async () => checkpoint);
    assert.equal((await invoke('read', { path: 'file.txt' })).status, 'completed');
    assert.equal((await store.snapshot())?.worktreeCommit, checkpoint.worktreeCommit);
    assert.equal((await invoke('write', { path: 'first-cloud.txt', content: 'without prior machine' })).status, 'completed');
    this.ctx.storage.sql.exec('DELETE FROM runtime_code_snapshot');
    this.ctx.storage.sql.exec('DELETE FROM runtime_code_commits');
    const unborn = { ...checkpoint, headCommit: null };
    store = new CloudFileStore(this.ctx.storage, { list: () => primary }, code, 'cloud', () => {}, lfs, retainLfs, async () => unborn);
    assert.equal((await invoke('write', { path: 'unborn.txt', content: 'cloud before attachment' })).status, 'completed');
    const unbornCloud = await store.snapshot(); assert(unbornCloud);
    assert.equal(unbornCloud.headCommit, null);
    assert.equal(unbornCloud.indexCommit, unborn.indexCommit);
    assert.deepEqual((await invoke('read', { path: 'unborn.txt' })).content, [{ type: 'text', text: 'cloud before attachment' }]);
    store.commitMachine({ ...unbornCloud, headCommit: 'a'.repeat(40), worktreeCommit: 'b'.repeat(40) }, unbornCloud.worktreeCommit, 'machine');
    assert.equal((await invoke('edit', { path: 'unborn.txt', edits: [{ oldText: 'before', newText: 'after' }] })).status, 'completed');
    assert.equal((await store.snapshot())?.headCommit, 'a'.repeat(40));
    const payload = new TextEncoder().encode('real LFS content\nsecond line');
    const oid = [...new Uint8Array(await crypto.subtle.digest('SHA-256', payload))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const object = GitLfsObjectSchema.parse({ oid, size: payload.length });
    const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${payload.length}\n`;
    files.set('asset.dat', pointer);
    payloads.set(oid, payload);
    const current = await store.snapshot(); assert(current);
    store.commitMachine({ ...current, headCommit: checkpoint.headCommit, worktreeCommit: 'c'.repeat(40), lfs: { objects: [{ ...object, source: 'r2' }], heldBack: [{ path: 'asset.dat', kind: 'modified' }] } }, current.worktreeCommit, 'machine');
    headAttributes.set('.gitattributes', '*.dat filter=lfs\n[attr]large filter=lfs\n*.large large\n"space name.bin" filter=lfs\nliteral\\*.bin filter=lfs\ndeep/**/object.bin filter=lfs\n');
    headAttributes.set('nested/.gitattributes', '*.bin filter=lfs\nplain.dat -filter\n');
    assert.deepEqual((await invoke('read', { path: 'asset.dat' })).content, [{ type: 'text', text: 'real LFS content\nsecond line' }]);
    assert.deepEqual((await invoke('read', { path: 'asset.dat', offset: 2 })).content, [{ type: 'text', text: 'second line' }]);
    files.set('oversized.dat', `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${8 * 1024 * 1024 + 1}\n`);
    const getsBeforeOversized = payloadGets;
    const oversized = await invoke('read', { path: 'oversized.dat' });
    assert.equal(oversized.status, 'failed');
    assert.match(JSON.stringify(oversized.content), /8 MiB.*machine/u);
    assert.equal(payloadGets, getsBeforeOversized, 'Declared oversize must fail before asking the LFS store for a payload');
    let streamedChunks = 0, streamClosed = false;
    payloadStream = async function* () {
      try {
        streamedChunks++; yield payload;
        streamedChunks++; yield new Uint8Array([1]);
        streamedChunks++; yield payload;
      } finally { streamClosed = true; }
    };
    const overflow = await invoke('read', { path: 'asset.dat' });
    assert.equal(overflow.status, 'failed');
    assert.match(JSON.stringify(overflow.content), /verification failed/u);
    assert.doesNotMatch(JSON.stringify(overflow.content), /real LFS content/u);
    assert.equal(streamedChunks, 2, 'Size violation must stop consumption before later payload chunks');
    assert.equal(streamClosed, true, 'Size violation must close the source');
    payloadStream = undefined;
    assert.deepEqual((await invoke('read', { path: 'asset.dat' })).content, [{ type: 'text', text: 'real LFS content\nsecond line' }]);
    const oversizedBlob = new UnreadBlob([new Uint8Array(8 * 1024 * 1024 + 1)]);
    blobs.set('large.txt', oversizedBlob);
    const largeArtifact = await invoke('read', { path: 'large.txt' });
    assert.equal(largeArtifact.status, 'failed');
    assert.match(JSON.stringify(largeArtifact.content), /8 MiB.*machine/u);
    blobs.set('not-a-pointer.txt', new UnreadBlob([new Uint8Array(1025)]));
    assert.equal((await invoke('write', { path: 'not-a-pointer.txt', content: 'replacement' })).status, 'completed');
    blobs.set('.gitattributes', oversizedBlob);
    const largeAttributes = await invoke('read', { path: 'asset.dat' });
    assert.equal(largeAttributes.status, 'failed');
    assert.match(JSON.stringify(largeAttributes.content), /8 MiB.*machine/u);
    assert.equal(blobReads, 0, 'Oversized Artifacts and non-candidate pointers must not be materialized');
    blobs.clear();
    payloads.delete(oid);
    const unavailable = await invoke('read', { path: 'asset.dat' });
    assert.equal(unavailable.status, 'failed');
    assert.match(JSON.stringify(unavailable.content), new RegExp(`asset\\.dat.*${payload.length} bytes.*machine.*origin`, 'u'));
    assert.doesNotMatch(JSON.stringify(unavailable.content), /oid sha256/u);
    payloads.set(oid, new TextEncoder().encode('corrupt'));
    assert.match(JSON.stringify((await invoke('read', { path: 'asset.dat' })).content), /verification failed/u);
    payloads.set(oid, payload);
    for (const path of ['asset.dat', 'new.dat', 'nested/new.bin', 'new.large', 'space name.bin', 'literal*.bin', 'deep/a/b/object.bin']) {
      for (const tool of ['write', 'edit'] as const) {
        const result = await invoke(tool, tool === 'write' ? { path, content: 'changed' } : { path, edits: [{ oldText: 'version', newText: 'changed' }] });
        assert.equal(result.status, 'failed');
        assert.match(JSON.stringify(result.content), /machine and commit/u);
      }
    }
    assert.equal((await invoke('write', { path: 'nested/plain.dat', content: 'ordinary' })).status, 'completed');
    assert.equal((await invoke('write', { path: '.gitattributes', content: '*.dat -filter\n*.txt filter=lfs' })).status, 'completed');
    assert.equal((await invoke('write', { path: 'still-lfs.dat', content: 'blocked' })).status, 'failed');
    assert.equal((await invoke('write', { path: 'still-normal.txt', content: 'allowed' })).status, 'completed');
    const beforeFailure = await store.snapshot(); assert(beforeFailure?.lfs);
    assert.deepEqual(beforeFailure.lfs.heldBack, [{ path: 'asset.dat', kind: 'modified' }]);
    failPush = true;
    await assert.rejects(invoke('write', { path: 'pending-retention.txt', content: 'pending' }, 'pending-retention'));
    assert.deepEqual(retained.get(beforeFailure.worktreeCommit)?.lfs, beforeFailure.lfs);
    assert.deepEqual((await store.snapshot())?.lfs, beforeFailure.lfs);
    failPush = false; await store.recover();
    retentionUnavailable = true;
    await assert.rejects(invoke('write', { path: 'origin-outbox.txt', content: 'accepted with retention pending' }, 'origin-outbox'), /Retention unavailable/u);
    const location = { origin: 'https://origin.example/repository.git', endpoint: 'https://origin.example/repository.git/info/lfs' };
    await store.reconcileLfsSources([{ ...object, location }]);
    const transitioned = await store.snapshot(); assert(transitioned);
    assert.equal(transitioned.lfs?.objects[0]?.source, 'origin');
    assert.deepEqual(transitioned.lfs?.objects[0]?.location, location);
    const pendingOrigin = this.ctx.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_lfs_retention_outbox WHERE commit_id=?', transitioned.worktreeCommit).toArray()[0]; assert(pendingOrigin);
    assert.deepEqual(RuntimeGitCheckpointSchema.parse(JSON.parse(pendingOrigin.checkpoint)).lfs?.objects[0], { ...object, source: 'origin', location });
    retentionUnavailable = false;
    store = open(); await store.recover();
    assert.deepEqual(retained.get(transitioned.worktreeCommit)?.lfs?.objects[0], { ...object, source: 'origin', location });
    assert.equal((await invoke('write', { path: 'after-origin-transition.txt', content: 'retains origin source' })).status, 'completed');
    assert.equal((await store.snapshot())?.lfs?.objects[0]?.source, 'origin');
    assert.deepEqual((await store.snapshot())?.lfs?.objects[0], { ...object, source: 'origin', location });
    headAttributes.set('.gitattributes', '[[:alpha:]].bin filter=lfs\n');
    const unsupportedPattern = await invoke('write', { path: 'a.bin', content: 'must not bypass LFS policy' });
    assert.equal(unsupportedPattern.status, 'failed');
    assert.match(JSON.stringify(unsupportedPattern.content), /Unsupported HEAD attribute.*machine/u);
    return Response.json({ passed: true });
  }
}
export default { fetch(request: Request, env: { PROOF: DurableObjectNamespace<CloudFilesProof> }) { return env.PROOF.getByName('proof').fetch(request); } };
