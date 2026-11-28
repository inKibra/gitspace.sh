import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { RuntimeAttachmentSchema, RuntimeIdentitySchema, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { emptyWorkspaceStatus } from '@gitspace/protocol-workspace';
import { credentialProtocolBase64 } from '@gitspace/protocol';
import { ArtifactsCodeStore, AttachmentStore } from '@gitspace/runtime-workspace-do';
import { invokeRuntimeSpaceTool } from '../src/runtime-space-tools.js';
import { createWorkspaceMetadataTables, storeWorkspaceReport } from '../src/workspace-metadata.js';

afterEach(() => vi.restoreAllMocks());
/** The commits each Artifacts repository holds; any other commit reads as absent. */
function cloudCommits(held: Record<string, Set<string>>) {
  const identity = { name: 'Fixture', email: 'fixture@example.invalid' };
  return vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (repository, hash) => held[repository]?.has(hash)
    ? { hash, treeHash: hash, message: hash, author: identity, committer: identity, parents: [], authoredAt: 1, committedAt: 1 } : null);
}
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
      storeWorkspaceReport(ctx.storage, { summary: emptyWorkspaceStatus, phase: 'code', waiting: { items: [], more: 0 }, planStep: null, failure: null, lastReply: null, lastReplySource: null, lastActivityAt: null, model: null, code: { branch: 'main', headCommit, uncommitted: false } });
    });
    const started = await call('space_journal', { method: 'startPhase', phase: 'build', intent: 'Build the parser.' });
    expect(started).toMatchObject({ kind: 'phase-start', createdBy: 'conversation:agent-a', snapshot: { headCommit } });
    const phaseRunId = z.object({ phaseRunId: z.string() }).parse(started).phaseRunId;
    expect(await call('space_journal', { method: 'endPhase', phaseRunId, outcome: 'Parser built.', decisions: [], surprises: [], revert: null })).toMatchObject({ kind: 'phase-end', phaseRunId, createdBy: 'conversation:agent-a' });
  });
  it('leads a guide put\'s result with what the revision lacks to show its change, and leaves it out once nothing is missing', async () => {
    const { call, context, owned } = await fixture();
    const section = { id: 'parse', title: 'Parse v2 headers', kind: 'behavior', explanation: 'Reads the version first.', why: '', requirementIds: [], exhibits: [] };
    const draft = { headCommit: 'a'.repeat(40), baseRef: 'main', baseCommit: 'b'.repeat(40), title: 'Parser v2', sections: [section] };
    cloudCommits({ 'workspace-workspace-a': new Set([draft.headCommit, draft.baseCommit]) });
    const bare = z.record(z.string(), z.unknown()).parse(await call('space_guide', { method: 'put', expectedRevision: 0, guide: draft }));
    expect(Object.keys(bare)[0]).toBe('toAdd');
    expect(bare).toMatchObject({ revision: 1, toAdd: [expect.stringContaining('Sections without a diagram: parse.'), expect.stringContaining('No walkthrough')] });
    expect(await context.getChangeGuide(owned)).not.toHaveProperty('toAdd');
    const diagram = '```mermaid\ngraph LR\n  read --> parse\n```';
    const walkthrough = { root: 'tour', elements: { tour: { type: 'Sequence', props: { title: 'Parser v2', frames: [{ content: { ref: 'overview' }, say: 'The parser reads v2.' }, { content: { ref: 'diagram:parse' }, say: 'It reads the version first.' }] }, children: [] } } };
    const drawn = await call('space_guide', { method: 'put', expectedRevision: 1, guide: { ...draft, sections: [{ ...section, diagram }], walkthrough } });
    expect(drawn).toMatchObject({ revision: 2 });
    expect(drawn).not.toHaveProperty('toAdd');
  });
  it('publishes a guide\'s base commit the workspace repository lacks through the workspace\'s own machine, then stores the guide', async () => {
    const { call, context, owned } = await fixture();
    // The workspace runtime a guide put with a missing commit opens reads the account's credential vault.
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(41)) });
    const draft = { headCommit: 'a'.repeat(40), baseRef: 'main', baseCommit: 'b'.repeat(40), title: 'Merged branch', sections: [{ id: 'merge', title: 'Merge', kind: 'behavior', explanation: 'Merges main.', why: '', requirementIds: [], exhibits: [] }] };
    // A workspace copied in from its tip: its repository holds HEAD, not the merge base.
    const held = new Set([draft.headCommit]);
    cloudCommits({ 'workspace-workspace-a': held });
    const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project-a', workspaceId: 'workspace-a', attachmentId: 'cache-a', machineId: 'sandbox-a', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['publish_commit'], online: true, updatedAt: new Date().toISOString() });
    vi.spyOn(AttachmentStore.prototype, 'list').mockReturnValue([attachment]);
    const dispatches: RuntimeToolDispatch[] = [];
    vi.spyOn(AttachmentStore.prototype, 'execute').mockImplementation(async dispatch => {
      dispatches.push(dispatch);
      const { commit } = z.object({ commit: z.string() }).parse(dispatch.args);
      held.add(commit);
      return { status: 'completed', requestId: dispatch.requestId, attemptId: dispatch.attemptId, content: [{ type: 'text', text: JSON.stringify({ ref: `refs/gitspace/commits/${commit}`, commit }) }] };
    });
    expect(await call('space_guide', { method: 'put', expectedRevision: 0, guide: draft })).toMatchObject({ revision: 1, baseCommit: draft.baseCommit });
    expect(dispatches).toMatchObject([{ tool: 'publish_commit', args: { commit: draft.baseCommit }, projectId: 'project-a', workspaceId: 'workspace-a', machineId: 'sandbox-a', attachmentId: 'cache-a' }]);
    expect(await context.getChangeGuide(owned)).toMatchObject({ revision: 1, baseCommit: draft.baseCommit, headCommit: draft.headCommit });
  });
  it('refuses a guide whose base commit the workspace repository lacks while no machine holding the workspace is online, storing nothing', async () => {
    const { call, context, owned } = await fixture();
    await env.CREDENTIALS.getByName(env.ACCOUNT_ID).bootstrap({ userId: env.ACCOUNT_ID, rootPublicKey: env.AUTH_PUBLIC_KEY, vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(41)) });
    const draft = { headCommit: 'a'.repeat(40), baseRef: 'main', baseCommit: 'b'.repeat(40), title: 'Merged branch', sections: [{ id: 'merge', title: 'Merge', kind: 'behavior', explanation: 'Merges main.', why: '', requirementIds: [], exhibits: [] }] };
    cloudCommits({ 'workspace-workspace-a': new Set([draft.headCommit]) });
    const offline = RuntimeAttachmentSchema.parse({ projectId: 'project-a', workspaceId: 'workspace-a', attachmentId: 'cache-a', machineId: 'sandbox-a', generation: 1, role: 'cache', state: 'ready', checkout: { kind: 'shared', branch: 'main' }, capabilities: ['publish_commit'], online: false, updatedAt: new Date().toISOString() });
    vi.spyOn(AttachmentStore.prototype, 'list').mockReturnValue([offline]);
    const execute = vi.spyOn(AttachmentStore.prototype, 'execute');
    await expect(call('space_guide', { method: 'put', expectedRevision: 0, guide: draft })).rejects.toThrow(`The guide's base commit ${'b'.repeat(12)} is not in GitSpace's copy of this workspace, so its diffs cannot be shown, and only a machine holding the workspace can publish it. Bring sandbox-a online, then put the guide again.`);
    expect(execute).not.toHaveBeenCalled();
    expect(await context.getChangeGuide(owned)).toBeNull();
  });
  it('lists older review threads and refuses opening, replying to or resolving one', async () => {
    const { call } = await fixture();
    expect(await call('space_review', { method: 'list' })).toEqual([]);
    for (const method of ['create', 'append', 'resolve']) {
      await expect(call('space_review', { method, anchor: { kind: 'workspace' }, decision: 'pending', message: { body: 'Check the parser.' } })).rejects.toThrow('Unknown workspace authority operation');
    }
  });
});
