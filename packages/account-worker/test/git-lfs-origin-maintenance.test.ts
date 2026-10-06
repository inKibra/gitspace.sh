import { env, runInDurableObject } from 'cloudflare:test';
import { GitLfsObjectSchema, type GitLfsObject } from '@gitspace/protocol-workspace';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime';
import { ArtifactsCodeStore } from '@gitspace/runtime-workspace-do';
import { expect, it, vi } from 'vitest';

it('bounds and rotates origin retention batches without repeating them on each snapshot', async () => {
  const projectId = crypto.randomUUID(), workspaceId = crypto.randomUUID();
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await project.bootstrap({ id: projectId, name: 'Bounded origin maintenance', repositoryReference: 'https://origin.invalid/repo.git', baseBranch: 'main', createdBy: 'machine' });
  await project.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Retained workspace', branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
  await space.bootstrap({ projectId, spaceId: workspaceId, machineId: 'machine' });
  const objects = Array.from({ length: 150 }, (_, index) => GitLfsObjectSchema.parse({ oid: (index + 1).toString(16).padStart(64, '0'), size: 1 }));
  const checkpoint = RuntimeGitCheckpointSchema.parse({ checkpointRef: `refs/gitspace/spaces/${workspaceId}/checkpoints/1`, headCommit: 'a'.repeat(40), branch: 'main', indexCommit: 'a'.repeat(40), trackedWorktreeCommit: 'a'.repeat(40), worktreeCommit: 'a'.repeat(40), indexTree: 'b'.repeat(40), worktreeTree: 'b'.repeat(40), lfs: { objects: objects.map(object => ({ ...object, source: 'r2' })), heldBack: [] } });
  await runInDurableObject(space, (_instance, state) => {
    state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
    state.storage.sql.exec('INSERT INTO runtime_code_snapshot VALUES(1,?)', JSON.stringify(checkpoint));
  });
  const batches: GitLfsObject[][] = [];
  const configuration = vi.spyOn(ArtifactsCodeStore.prototype, 'readFile').mockResolvedValue(null);
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const requested = GitLfsObjectSchema.array().parse(body.objects);
    expect(body.operation).toBe('download');
    batches.push(requested);
    return Response.json({ objects: requested.map(object => ({ ...object, error: { code: 404 } })) });
  });
  try {
    await project.lfsPin({ publicationId: 'capture', objects });
    await project.lfsRetain({ snapshotId: `runtime:${workspaceId}:${checkpoint.worktreeCommit}`, workspaceId, kind: 'runtime', objects: checkpoint.lfs?.objects ?? [] });
    await project.lfsCollect();
    await project.lfsCollect();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(objects.slice(0, 64));
    await runInDurableObject(project, async (_instance, state) => {
      await state.storage.put('lfs-origin-recheck', { after: 0, cursor: objects[63]?.oid });
    });
    await project.lfsCollect();
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual(objects.slice(64, 128));
  } finally { request.mockRestore(); configuration.mockRestore(); }
});
