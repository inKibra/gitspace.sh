import { env, runInDurableObject } from 'cloudflare:test';
import { GitLfsObjectSchema } from '@gitspace/protocol-workspace';
import { describe, expect, it } from 'vitest';
import { GitLfsRetention } from '../src/git-lfs-retention.js';
import { canonicalLfsObjects, parseCanonicalRefs } from '../src/git-lfs-reachability.js';
import { persistPortableCheckpoint } from './portable-checkpoint-fixture.js';

const object = GitLfsObjectSchema.parse({ oid: 'a'.repeat(64), size: 17 });
async function ledger(run: (value: GitLfsRetention, storage: DurableObjectStorage) => void) {
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${crypto.randomUUID()}`);
  await runInDurableObject(authority, (_instance, state) => run(new GitLfsRetention(state.storage), state.storage));
}

describe('durable LFS restore roots', () => {
  it('replaces historical owners with current roots without losing publisher fencing', async () => {
    await ledger(value => {
      value.snapshot({ snapshotId: 'old', workspaceId: 'workspace', kind: 'runtime', objects: [{ ...object, source: 'r2' }] });
      value.snapshot({ snapshotId: 'current', workspaceId: 'workspace', kind: 'runtime', objects: [{ ...object, source: 'r2' }] });
      value.reconcile(new Set(['current']));
      expect(value.candidates()).toEqual([]);
      value.retain('publication:pending', [object]);
      value.reconcile(new Set());
      expect(value.candidates()).toEqual([]);
      value.release('publication:pending');
      expect(value.candidates()).toEqual([object]);
    });
  });

  it('persists canonical source resolution across restart before releasing snapshot ownership', async () => {
    await ledger((value, storage) => {
      value.snapshot({ snapshotId: 'portable:1', workspaceId: 'workspace', kind: 'portable', objects: [{ ...object, source: 'r2' }] });
      value.reconcile(new Set(['portable:1']));
      const location = { origin: 'https://origin.invalid/repo.git', endpoint: 'https://lfs.invalid/old' };
      value.origin([{ ...object, location }]);
      const recovered = new GitLfsRetention(storage);
      expect(recovered.snapshots()[0]?.objects).toEqual([{ ...object, source: 'origin', location }]);
      expect(recovered.resolve([{ ...object, source: 'r2' }], location.origin)).toEqual([{ ...object, source: 'origin', location }]);
      expect(recovered.resolve([{ ...object, source: 'r2' }], 'https://other.invalid/repo.git')).toEqual([{ ...object, source: 'r2' }]);
      expect(recovered.candidates()).toEqual([object]);
      expect(recovered.beginDelete(object)).toBe(true);
      expect(() => recovered.retain('publication:racing', [object])).toThrow('deletion');
      recovered.forget(object);
      recovered.retain('publication:next', [object]);
      expect(recovered.candidates()).toEqual([]);
    });
  });

  it('does not begin deletion of an object owned by a current or pending publication', async () => {
    await ledger(value => {
      value.retain('publication:pending', [object]);
      expect(value.beginDelete(object)).toBe(false);
      value.forget(object);
      value.release('publication:pending');
      expect(value.candidates()).toEqual([object]);
    });
  });

  it('discovers branch and peeled tag roots but excludes private checkpoint refs', () => {
    const packet = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    const branch = '1'.repeat(40), tag = '2'.repeat(40), peeled = '3'.repeat(40);
    const bytes = new TextEncoder().encode(packet('# service=git-upload-pack\n') + '0000' + packet(`${branch} refs/heads/topic\0multi_ack\n`) + packet(`${tag} refs/tags/release\n`) + packet(`${peeled} refs/tags/release^{}\n`) + packet(`${branch} refs/gitspace/checkpoints/private\n`) + '0000');
    expect([...parseCanonicalRefs(bytes)]).toEqual([['refs/heads/topic', branch], ['refs/tags/release', tag], ['refs/tags/release^{}', peeled]]);
    expect(() => parseCanonicalRefs(bytes.subarray(0, bytes.length - 2))).toThrow();
  });

  it('protects pointers found only in tagged ancestors and fails closed on unavailable history', async () => {
    const head = '1'.repeat(40), ancestor = '2'.repeat(40), tree = '3'.repeat(40), blob = '4'.repeat(40);
    const packet = (line: string) => `${(line.length + 4).toString(16).padStart(4, '0')}${line}`;
    let revoked = 0;
    let missing = false;
    const repo = {
      async info(): Promise<ArtifactsRepoInfo> { return { id: 'repo', name: 'repo', remote: 'https://git.invalid/repo.git', description: null, defaultBranch: 'main', createdAt: '', updatedAt: '', lastPushAt: null, source: null, readOnly: false }; },
      async createToken(): Promise<ArtifactsCreateTokenResult> { return { id: 'token', plaintext: 'secret', scope: 'read', expiresAt: '' }; },
      async revokeToken() { revoked++; return true; },
      async readCommit(oid: string) { return missing ? null : { hash: oid, treeHash: tree, parents: oid === head ? [ancestor] : [], message: '', author: { name: 'Fixture', email: 'f@example.invalid' }, committer: { name: 'Fixture', email: 'f@example.invalid' }, authoredAt: 0, committedAt: 0 }; },
      async readTree() { return [{ name: 'asset', hash: blob, mode: '100644', type: 'blob' as const }]; },
      async readBlob() { return new Blob([`version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`]); },
    };
    const fetcher: typeof fetch = async (_url, init) => {
      expect(init?.redirect).toBe('error');
      return new Response(packet('# service=git-upload-pack\n') + '0000' + packet(`${head} refs/tags/only-tag\n`) + '0000');
    };
    expect(await canonicalLfsObjects({ get: async () => repo }, ['canonical'], fetcher)).toEqual([object]);
    expect(revoked).toBe(1);
    missing = true;
    await expect(canonicalLfsObjects({ get: async () => repo }, ['canonical'], fetcher)).rejects.toThrow('unavailable');
    expect(revoked).toBe(2);
  });

  it('does not retain a stale portable close inventory', async () => {
    const projectId = crypto.randomUUID(), spaceId = crypto.randomUUID();
    const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await project.bootstrap({ id: projectId, name: 'Rejected portable', repositoryReference: 'https://origin.invalid/repo.git', baseBranch: 'main', createdBy: 'machine' });
    const placement = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${spaceId}`);
    const identity = { projectId, spaceId, machineId: 'machine' };
    await placement.bootstrap(identity);
    await placement.beginClose({ ...identity, expectedGeneration: 1 });
    const manifest = await persistPortableCheckpoint(projectId, spaceId, 1, { objects: [{ ...object, source: 'r2' }], heldBack: [] });
    await placement.abortClose({ ...identity, expectedGeneration: 1, revision: 1, message: 'cancelled' });
    const result = await placement.commitClosed({ ...identity, expectedGeneration: 1, revision: 1, ...manifest });
    expect(result.status).toBe('error');
    await runInDurableObject(project, (_instance, state) => expect(new GitLfsRetention(state.storage).snapshots()).toEqual([]));
  });

  it('roots a closed restorable portable revision and releases it when the workspace is archived', async () => {
    const projectId = crypto.randomUUID(), spaceId = crypto.randomUUID();
    const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
    await project.bootstrap({ id: projectId, name: 'Portable roots', repositoryReference: 'https://origin.invalid/repo.git', baseBranch: 'main', createdBy: 'machine' });
    const definition = { id: spaceId, projectId, kind: 'worktree' as const, name: 'Closed workspace', branch: 'topic', phase: 'code' as const, sourceKind: 'base' as const, sourceRef: 'main', sourceCommit: null, lifecycle: 'active' as const, goalId: null };
    const workspace = await project.putWorkspace({ ...definition, expectedRevision: 0 });
    const placement = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${spaceId}`);
    const identity = { projectId, spaceId, machineId: 'machine' };
    await placement.bootstrap(identity);
    await placement.beginClose({ ...identity, expectedGeneration: 1 });
    const manifest = await persistPortableCheckpoint(projectId, spaceId, 1, { objects: [{ ...object, source: 'r2' }], heldBack: [] });
    expect((await placement.commitClosed({ ...identity, expectedGeneration: 1, revision: 1, ...manifest })).status).toBe('ok');
    await project.lfsCollect();
    await runInDurableObject(project, (_instance, state) => expect(new GitLfsRetention(state.storage).candidates()).toEqual([]));
    await project.putWorkspace({ ...definition, lifecycle: 'archived', expectedRevision: workspace.revision });
    await project.lfsCollect();
    await runInDurableObject(project, (_instance, state) => expect(new GitLfsRetention(state.storage).candidates()).toEqual([object]));
  });
});
