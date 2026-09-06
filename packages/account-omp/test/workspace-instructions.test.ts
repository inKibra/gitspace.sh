import { describe, expect, it } from 'bun:test';
import type { GoalRecordView } from '@gitspace/protocol';
import { WorkspaceInstructionContext, type WorkspaceInstructions } from '../src/workspace-instructions.js';

function goal(revision: number, title: string): GoalRecordView {
  return { projectId: 'project', spaceId: 'workspace', id: 'goal', revision, title, summary: '', phase: 'code', requirements: [],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', updatedBy: 'user' };
}

describe('Workspace instruction boundaries', () => {
  it('does not fetch or start work on change and uses the latest edit at the next boundary', async () => {
    let canonical: WorkspaceInstructions = { goal: goal(1, 'First'), workflow: null, rubric: null };
    let loads = 0;
    let notices = 0;
    const context = new WorkspaceInstructionContext(async () => { loads += 1; return canonical; }, () => { notices += 1; });
    const inFlight = await context.nextTurn();
    canonical = { ...canonical, goal: goal(2, 'Second') };
    context.changed();
    canonical = { ...canonical, goal: goal(3, 'Latest') };
    context.changed();
    expect(loads).toBe(1);
    expect(notices).toBe(1);
    expect(inFlight.goal?.title).toBe('First');
    expect((await context.nextTurn()).goal).toMatchObject({ title: 'Latest', revision: 3 });
    expect(notices).toBe(1);
  });

  it('observes remote changes without a local notification and retains pending changes when authority read fails', async () => {
    let canonical: WorkspaceInstructions = { goal: goal(1, 'Initial'), workflow: null, rubric: null };
    let unavailable = false;
    let notices = 0;
    const context = new WorkspaceInstructionContext(async () => {
      if (unavailable) throw new Error('Authority unavailable');
      return canonical;
    }, () => { notices += 1; });
    await context.nextTurn();
    canonical = { ...canonical, goal: goal(2, 'Remote edit') };
    expect((await context.nextTurn()).goal?.title).toBe('Remote edit');
    expect(notices).toBe(1);
    context.changed();
    unavailable = true;
    await expect(context.nextTurn()).rejects.toThrow('Authority unavailable');
    unavailable = false;
    canonical = { ...canonical, goal: goal(3, 'Recovered latest edit') };
    expect((await context.nextTurn()).goal?.revision).toBe(3);
    expect(notices).toBe(2);
  });
});
