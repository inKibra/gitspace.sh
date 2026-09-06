import { describe, expect, it } from 'bun:test';
import { cloudWorkspaceDefinitionSchema, type GoalRecordView, type PutGoalInput } from '@gitspace/protocol';
import type { CloudSpaceCheckpointAuthority } from '../src/cloud-space-authority.js';
import { createSpaceEvalNamespace, type SpaceWorkspaceControls } from '../src/space-eval-sdk.js';

function fixture() {
  const definitions = ['project-a', 'workspace-a', 'workspace-b'].map((id) => cloudWorkspaceDefinitionSchema.parse({
    id, projectId: 'project-a', kind: id === 'project-a' ? 'base' : 'worktree', name: id, branch: 'main',
    phase: 'code', sourceKind: 'base', sourceRef: 'main', lifecycle: 'active', goalId: null, revision: 1,
    archivedAt: null, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  }));
  const goals = new Map<string, GoalRecordView>();
  const operations: string[] = [];
  const authority = {
    listProjectWorkspaces: async () => definitions,
    getProject: async () => ({ id: 'project-a' }),
    getSpace: async (_projectId: string, spaceId: string) => ({ spaceId, state: 'closed', generation: 3 }),
    getInspectorOverview: async ({ spaceId }: { spaceId: string }) => ({ goal: goals.get(spaceId) ?? null }),
    getInspectorGoal: async ({ spaceId }: { spaceId: string }) => goals.get(spaceId) ?? null,
    putInspectorGoal: async (input: PutGoalInput) => {
      const current = goals.get(input.spaceId);
      if ((current?.revision ?? 0) !== input.expectedRevision) throw new Error('Goal revision conflict');
      const goal: GoalRecordView = { ...input.goal, projectId: input.projectId, spaceId: input.spaceId,
        revision: input.expectedRevision + 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' };
      goals.set(input.spaceId, goal);
      return goal;
    },
    appendProjectEvent: async () => undefined,
  } as unknown as CloudSpaceCheckpointAuthority;
  const controls: SpaceWorkspaceControls = {
    create: async () => { operations.push('create'); return { workspace: { id: 'workspace-b', projectId: 'project-a' }, operation: { id: 'creation' } }; },
    manage: async (method) => { operations.push(method); },
    instructionsChanged: async () => undefined,
    refreshArtifacts: async () => undefined,
    environment: async (method) => { operations.push(`environment.${method}`); },
  };
  return { authority, controls, operations, namespace: createSpaceEvalNamespace(authority, 'project-a', 'workspace-a', controls) };
}

const goal = { id: 'goal', title: 'Task', summary: 'Implement the task', phase: 'code' as const, requirements: [], updatedBy: 'agent' };

describe('Space eval SDK', () => {
  it('validates every initial instruction draft before creating a workspace', async () => {
    const { namespace, operations } = fixture();
    await expect(namespace.call('create', { name: 'New', branch: 'new', phase: 'code', sourceKind: 'base', sourceRef: 'main', goal, workflow: { id: 'invalid' } })).rejects.toThrow();
    expect(operations).toEqual([]);
    expect(await namespace.call('goal.get', { workspaceId: 'workspace-b' })).toBeNull();
  });

  it('returns the created identity and committed initial goal when a later instruction write fails', async () => {
    const { namespace, authority, operations } = fixture();
    authority.putInspectorWorkflow = async () => { throw new Error('Workflow authority unavailable'); };
    const created = await namespace.call('create', {
      name: 'New', branch: 'new', phase: 'code', sourceKind: 'base', sourceRef: 'main', goal,
      workflow: { id: 'workflow', title: 'Workflow', description: '', nodes: [], edges: [], updatedBy: 'agent' },
    });
    expect(created).toMatchObject({ identity: { projectId: 'project-a', spaceId: 'workspace-b' }, ready: false, initialized: ['goal'], error: { operation: 'workflow.put' } });
    expect(await namespace.call('goal.get', { workspaceId: 'workspace-b' })).toMatchObject({ title: 'Task', revision: 1 });
    expect(operations).toEqual(['create']);
  });

  it('edits a closed target without opening it and rejects its stale revision without changing either workspace', async () => {
    const { namespace, operations } = fixture();
    await namespace.call('goal.put', { expectedRevision: 0, goal: { ...goal, title: 'Current' } });
    await namespace.call('goal.put', { workspaceId: 'workspace-b', expectedRevision: 0, goal: { ...goal, title: 'Target' } });
    await expect(namespace.call('goal.put', { workspaceId: 'workspace-b', expectedRevision: 0, goal: { ...goal, title: 'Stale' } })).rejects.toThrow('revision conflict');
    expect(await namespace.call('goal.get', { workspaceId: 'workspace-b' })).toMatchObject({ title: 'Target', revision: 1 });
    expect(await namespace.call('goal.get', {})).toMatchObject({ title: 'Current', revision: 1 });
    expect(operations).toEqual([]);
  });

  it('rejects foreign, missing, and forged targets before any mutation', async () => {
    const { namespace, operations } = fixture();
    for (const target of [{ projectId: 'project-b' }, { workspaceId: 'foreign-workspace' }, { spaceId: 'workspace-b' }]) {
      await expect(namespace.call('goal.put', { ...target, expectedRevision: 0, goal })).rejects.toThrow();
    }
    expect(await namespace.call('goal.get', {})).toBeNull();
    expect(operations).toEqual([]);
  });

  it('rejects own-workspace close and archive before entering lifecycle quiescence', async () => {
    const { namespace, operations } = fixture();
    for (const method of ['close', 'archive']) {
      await expect(namespace.call(method, { expectedGeneration: 3, expectedRevision: 1 })).rejects.toThrow('own workspace');
    }
    expect(operations).toEqual([]);
  });

  it('denies agent execution approval, destructive retirement, and claim recovery before side effects', async () => {
    const { namespace, operations } = fixture();
    for (const method of ['environment.approve', 'environment.revokeApproval', 'environment.recoverRun']) {
      await expect(namespace.call(method, {})).rejects.toThrow('human browser');
    }
    await expect(namespace.call('environment.runPhase', { phase: 'cloud/destroy', rerun: true })).rejects.toThrow('human browser');
    await expect(namespace.call('environment.runPhase', { phase: 'machine/prepare', retire: true })).rejects.toThrow();
    expect(operations).toEqual([]);
  });

  it('fences environment access to the current project without changing workspace placement', async () => {
    const { namespace, operations } = fixture();
    await expect(namespace.call('environment.runPhase', { workspaceId: 'foreign', phase: 'cloud/provision' })).rejects.toThrow('does not exist');
    await expect(namespace.call('environment.get', { projectId: 'foreign' })).rejects.toThrow('current project');
    expect(operations).toEqual([]);
  });

  it('discovers current project scope and explicit closed workspace without materializing it', async () => {
    const { authority, controls, namespace, operations } = fixture();
    expect(await createSpaceEvalNamespace(authority, 'project-a', null, controls).call('current', {})).toMatchObject({
      identity: { projectId: 'project-a', spaceId: 'project-a' }, scope: 'project',
    });
    expect(await namespace.call('get', { workspaceId: 'workspace-b' })).toMatchObject({
      identity: { projectId: 'project-a', spaceId: 'workspace-b' }, placement: { state: 'closed', generation: 3 },
    });
    expect(operations).toEqual([]);
  });
});
