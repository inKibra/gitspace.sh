import { describe, expect, it } from 'bun:test';
import type { CloudSpaceCheckpointAuthority } from '../src/cloud-space-authority.js';
import { createSpaceEvalNamespace } from '../src/space-eval-sdk.js';

describe('Space eval SDK', () => {
  it('injects the active project and workspace identity into every mutation', async () => {
    const calls: Array<{ method: string; input: unknown; context?: unknown }> = [];
    const authority = {
      putInspectorGoal: async (input: unknown) => {
        calls.push({ method: 'goal.put', input });
        return input;
      },
      createInspectorReviewThread: async (input: unknown, context?: unknown) => {
        calls.push({ method: 'review.create', input, context });
        return input;
      },
    } as unknown as CloudSpaceCheckpointAuthority;
    const namespace = createSpaceEvalNamespace(authority, 'project-a', 'workspace-a');

    await namespace.call('goal.put', { projectId: 'forged', spaceId: 'forged', title: 'Goal' });
    await namespace.call('review.create', { projectId: 'forged', context: { mode: 'working' }, body: 'Comment' });

    expect(calls).toEqual([
      { method: 'goal.put', input: { projectId: 'project-a', spaceId: 'workspace-a', title: 'Goal' } },
      { method: 'review.create', input: { projectId: 'project-a', spaceId: 'workspace-a', body: 'Comment' }, context: { mode: 'working' } },
    ]);
  });

  it('uses the project id as the durable project-space identity', async () => {
    const authority = {
      getProject: async () => ({ id: 'project-a' }),
      listProjectWorkspaces: async () => [],
      getSpace: async (_projectId: string, spaceId: string) => ({ spaceId }),
      getInspectorOverview: async (identity: unknown) => ({ identity }),
    } as unknown as CloudSpaceCheckpointAuthority;
    const namespace = createSpaceEvalNamespace(authority, 'project-a', null);

    expect(await namespace.call('current', {})).toMatchObject({
      identity: { projectId: 'project-a', spaceId: 'project-a' },
      scope: 'project',
      placement: { spaceId: 'project-a' },
    });
  });
});
