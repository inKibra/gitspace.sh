import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { requireWorkspaceAccess } from '../src/runtime-access.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';

/** Every project authority access throws: a decision made against this env came from workspace-local state. */
const projectUnreachable: Env = { ...env, PROJECT_AUTHORITY: new Proxy(env.PROJECT_AUTHORITY, { get() { throw new Error('ProjectAuthority was consulted'); } }) };

async function activeProject(projectId: string) {
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const project = await authority.bootstrap({ id: projectId, name: projectId, repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
  await authority.setProjectLifecycle(project.revision, 'active');
  return authority;
}

describe('workspace runtime access', () => {
  it.each(['cloud-only', 'provisioning', 'active', 'archiving', 'archived', 'restoring', 'failed', 'deleting'] as const)(
    'seeds the base workspace from project lifecycle %s and bounds its writes', async lifecycle => {
      const projectId = `runtime-project-${lifecycle}`;
      const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
      const project = await authority.bootstrap({ id: projectId, name: 'Runtime access', repositoryReference: null, baseBranch: 'main', createdBy: 'machine-a' });
      await authority.setProjectLifecycle(project.revision, lifecycle);
      const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId: projectId });
      const write = requireWorkspaceAccess(env, env.ACCOUNT_ID, identity, true);
      if (lifecycle === 'deleting') await expect(write).rejects.toThrow('Runtime project is unavailable');
      else if (lifecycle === 'archived') await expect(write).rejects.toThrow('Archived runtime state is read-only');
      else await expect(write).resolves.toMatchObject({ workspace: { kind: 'base', branch: 'main', projectLifecycle: lifecycle } });
      const read = requireWorkspaceAccess(env, env.ACCOUNT_ID, identity, false);
      if (lifecycle === 'deleting') await expect(read).rejects.toThrow('Runtime project is unavailable');
      else await expect(read).resolves.toMatchObject({ workspace: { projectLifecycle: lifecycle } });
    },
  );

  it.each(['archiving', 'archived', 'deleting'] as const)('keeps a %s workspace out of runtime writes', async lifecycle => {
    const projectId = `runtime-workspace-${lifecycle}`;
    const authority = await activeProject(projectId);
    const workspaceId = `${projectId}-branch`;
    await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: workspaceId, branch: 'feature', phase: 'code', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle, goalId: null, expectedRevision: 0 });
    const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId });
    await expect(requireWorkspaceAccess(env, env.ACCOUNT_ID, identity, true)).rejects.toThrow(lifecycle === 'deleting' ? 'Runtime workspace is unavailable' : 'Archived runtime state is read-only');
    const read = requireWorkspaceAccess(env, env.ACCOUNT_ID, identity, false);
    if (lifecycle === 'deleting') await expect(read).rejects.toThrow('Runtime workspace is unavailable');
    else await expect(read).resolves.toMatchObject({ workspace: { lifecycle, branch: 'feature', phase: 'code' } });
  });

  it('decides runtime access from workspace metadata alone once seeded, through archive and delete', async () => {
    const projectId = 'runtime-local';
    const authority = await activeProject(projectId);
    const workspaceId = 'runtime-local-branch';
    const created = await authority.putWorkspace({ id: workspaceId, projectId, kind: 'worktree', name: 'Local', branch: 'local', phase: 'plan', sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
    const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId });
    const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${workspaceId}`);
    // The one seeding read.
    await expect(space.runtimeAccess(identity, true)).resolves.toMatchObject({ lifecycle: 'active', revision: created.revision });
    const withoutProject = (check: (local: SpaceAuthorityDO) => Promise<void>) => runInDurableObject(space, async (_instance, state) => {
      const local = new SpaceAuthorityDO(state, projectUnreachable);
      await state.blockConcurrencyWhile(async () => {});
      await check(local);
    });
    await withoutProject(async local => {
      await expect(local.runtimeAccess(identity, true)).resolves.toMatchObject({ lifecycle: 'active' });
      await expect(local.runtimeAccess(RuntimeIdentitySchema.parse({ projectId: 'another-project', workspaceId }), false)).rejects.toThrow('Workspace does not belong to the requested project');
    });

    const archived = await space.archiveWorkspace(created);
    expect(archived).toMatchObject({ lifecycle: 'archived' });
    await withoutProject(async local => {
      await expect(local.runtimeAccess(identity, true)).rejects.toThrow('Archived runtime state is read-only');
      await expect(local.runtimeAccess(identity, false)).resolves.toMatchObject({ lifecycle: 'archived', revision: archived.revision });
    });

    expect(await space.deleteWorkspace(archived)).toMatchObject({ lifecycle: 'deleting' });
    await withoutProject(async local => {
      await expect(local.runtimeAccess(identity, false)).rejects.toThrow('Runtime workspace is unavailable');
    });
  });
});
