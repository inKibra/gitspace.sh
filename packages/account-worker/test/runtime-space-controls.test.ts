import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RuntimeIdentitySchema } from '@gitspace/protocol-runtime';
import { emptyWorkspaceStatus } from '@gitspace/protocol-workspace';
import { invokeRuntimeSpaceTool } from '../src/runtime-space-tools.js';
import { createWorkspaceMetadataTables, storeWorkspaceReport } from '../src/workspace-metadata.js';

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
  const call = (tool: string, args: Parameters<typeof invokeRuntimeSpaceTool>[2]['args']) => invokeRuntimeSpaceTool(env, identity, { tool, args, conversationId: 'agent-a', attemptId: crypto.randomUUID() });
  return { call, context, owned, authority };
}
const goal = { id: 'goal', title: 'Task', summary: 'Implement the task', phase: 'code', requirements: [] };

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
  it('refuses an agent accepting a requirement, by method or by writing acceptance into the goal', async () => {
    const { call, context, owned } = await fixture();
    const requirement = { id: 'saved', title: 'Saved', description: '', required: true, status: 'review', workflowNodeId: null, criterionId: null, evidence: [] };
    await call('space_goal', { method: 'put', expectedRevision: 0, goal: { ...goal, requirements: [requirement] } });
    await expect(call('space_goal', { method: 'setAcceptance', expectedRevision: 1, requirementId: 'saved', accepted: true })).rejects.toThrow();
    await expect(call('space_goal', { method: 'put', expectedRevision: 1, goal: { ...goal, requirements: [{ ...requirement, status: 'accepted', acceptedBy: 'human', acceptedAt: '2026-11-06T10:00:00.000Z' }] } })).rejects.toThrow('only a person');
    const stored = (await context.getGoal(owned))?.requirements[0];
    expect(stored?.status).toBe('review');
    expect(stored).not.toHaveProperty('acceptedBy');
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
  it('fills the ids, authors and code of records, so the agent names only what it wrote', async () => {
    const { call } = await fixture();
    expect(await call('space_goal', { method: 'put', expectedRevision: 0, goal })).toMatchObject({ updatedBy: 'conversation:agent-a' });
    const headCommit = 'a'.repeat(40);
    await runInDurableObject(env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:workspace-a`), async (_instance, ctx) => {
      createWorkspaceMetadataTables(ctx.storage);
      storeWorkspaceReport(ctx.storage, { summary: emptyWorkspaceStatus, phase: 'code', waitingOn: null, failure: null, lastReply: null, lastReplySource: null, lastActivityAt: null, model: null, code: { branch: 'main', headCommit, uncommitted: false } });
    });
    const started = await call('space_journal', { method: 'startPhase', phase: 'build', intent: 'Build the parser.' });
    expect(started).toMatchObject({ kind: 'phase-start', createdBy: 'conversation:agent-a', snapshot: { headCommit } });
    const phaseRunId = z.object({ phaseRunId: z.string() }).parse(started).phaseRunId;
    expect(await call('space_journal', { method: 'endPhase', phaseRunId, outcome: 'Parser built.', decisions: [], surprises: [], revert: null })).toMatchObject({ kind: 'phase-end', phaseRunId, createdBy: 'conversation:agent-a' });
    expect(await call('space_review', { method: 'create', anchor: { kind: 'workspace' }, decision: 'pending', message: { body: 'Check the parser.' } })).toMatchObject({ messages: [{ authorId: 'conversation:agent-a', body: 'Check the parser.' }] });
  });
});
