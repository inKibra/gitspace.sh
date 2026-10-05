import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { invokeRuntimeSpaceTool } from '../src/runtime-space-tools.js';

async function fixture() {
  const identity = RuntimeIdentitySchema.parse({ projectId: 'project-a', workspaceId: 'workspace-a' });
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  const project = await authority.bootstrap({ id: identity.projectId, name: 'Workspace controls', repositoryReference: null, baseBranch: 'main', createdBy: 'user' });
  await authority.setProjectLifecycle(project.revision, 'active');
  for (const id of ['workspace-a', 'workspace-b']) {
    await authority.putWorkspace({ id, projectId: identity.projectId, kind: 'worktree', name: id, branch: 'main', phase: 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  }
  const context = env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, identity.projectId, identity.workspaceId]));
  const owned = { projectId: identity.projectId, spaceId: identity.workspaceId };
  await context.bootstrap(owned);
  const call = (tool: string, args: Parameters<typeof invokeRuntimeSpaceTool>[2]['args']) => invokeRuntimeSpaceTool(env, identity, { tool, args, conversationId: 'agent-a', attemptId: crypto.randomUUID() });
  return { call, context, owned, authority };
}
const goal = { id: 'goal', title: 'Task', summary: 'Implement the task', phase: 'code', requirements: [], updatedBy: 'agent' };

describe('Cloud workspace authority controls', () => {
  it('rejects claimed human approval before authority writes', async () => {
    const { call, context, owned } = await fixture();
    for (const [tool, method] of [['space_workflow', 'waiveGate'], ['space_guide', 'approve'], ['space_rubric', 'judge']] as const) {
      await expect(call(tool, { method, actorKind: 'human', reviewerId: 'human' })).rejects.toThrow('authenticated account administration');
    }
    expect(await context.getWorkflow(owned)).toBeNull();
    expect(await context.getChangeGuide(owned)).toBeNull();
    expect(await context.getRubric(owned)).toBeNull();
  });
  it('updates a closed same-project target and rejects stale revisions without overwriting it', async () => {
    const { call } = await fixture();
    await call('space_goal', { method: 'put', expectedRevision: 0, goal: { ...goal, title: 'Current' } });
    await call('space_goal', { method: 'put', workspaceId: 'workspace-b', expectedRevision: 0, goal: { ...goal, title: 'Target' } });
    await expect(call('space_goal', { method: 'put', workspaceId: 'workspace-b', expectedRevision: 0, goal: { ...goal, title: 'Stale' } })).rejects.toThrow('revision conflict');
    expect(await call('space_goal', { method: 'get', workspaceId: 'workspace-b' })).toMatchObject({ title: 'Target', revision: 1 });
    expect(await call('space_goal', { method: 'get' })).toMatchObject({ title: 'Current', revision: 1 });
  });
  it('rejects foreign and forged targets before mutation', async () => {
    const { call, context, owned } = await fixture();
    const targets: Record<string, string>[] = [{ projectId: 'foreign' }, { workspaceId: 'foreign' }, { spaceId: 'workspace-b' }];
    for (const target of targets) {
      await expect(call('space_goal', { method: 'put', ...target, expectedRevision: 0, goal })).rejects.toThrow();
    }
    expect(await context.getGoal(owned)).toBeNull();
  });
});
