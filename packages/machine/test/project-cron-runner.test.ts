import { describe, expect, it } from 'bun:test';
import type { ProjectCronRunView } from '@gitspace/protocol/cron-contract';
import {
  buildProjectCronPrompt,
  runClaimedProjectCron,
  runNextProjectCron,
  type ProjectCronExecutionAdapter,
  type ProjectCronRunnerAdapter,
  type ProjectCronRunCompletion,
} from '../src/project-cron-runner.js';

function runFixture(): ProjectCronRunView {
  const at = new Date();
  return {
    id: 'run-a', projectId: 'project-a', cronId: 'cron-a', cronRevision: 2,
    cronName: 'nightly-triage', schedule: 'every 1d', description: 'Triage failures.',
    trigger: 'scheduled', state: 'running',
    target: { scope: 'workspace', projectId: 'project-a', spaceId: 'space-a' },
    prompt: 'Triage open failures and update the project report.',
    readScopes: ['repository/**'], writeScopes: ['local://workspace/reports/**'],
    resolvedSpaceId: null, resolvedGeneration: null,
    scheduledFor: at, claimedAt: at, startedAt: at, completedAt: null, message: null, createdAt: at,
  };
}

describe('project cron runner', () => {
  it('resolves the stable target at run time and prompts only the canonical agent', async () => {
    const run = runFixture();
    const completed: ProjectCronRunCompletion[] = [];
    const adapter: ProjectCronExecutionAdapter<string> = {
      resolveCanonicalAgent: async (target) => {
        expect(target).toEqual({ scope: 'workspace', projectId: 'project-a', spaceId: 'space-a' });
        return { status: 'ready', agent: 'canonical-agent', spaceId: 'space-a', generation: 9 };
      },
      promptCanonicalAgent: async (input) => {
        expect(input.agent).toBe('canonical-agent');
        expect(input.generation).toBe(9);
        expect(input.readScopes).toEqual(['repository/**']);
        expect(input.writeScopes).toEqual(['local://workspace/reports/**']);
        expect(input.prompt).toContain('A missing capability is a blocked run');
        return { status: 'accepted', message: 'Agent turn completed' };
      },
      completeRun: async (input) => {
        completed.push(input);
        return { ...run, state: input.state, message: input.message, resolvedSpaceId: input.resolvedSpaceId, resolvedGeneration: input.resolvedGeneration, completedAt: new Date() };
      },
    };

    const result = await runClaimedProjectCron({ run, claimToken: 'claim-a', leaseExpiresAt: new Date(Date.now() + 60_000) }, adapter);
    expect(result).toMatchObject({ state: 'succeeded', resolvedSpaceId: 'space-a', resolvedGeneration: 9 });
    expect(completed).toEqual([expect.objectContaining({ state: 'succeeded', resolvedSpaceId: 'space-a', resolvedGeneration: 9 })]);
  });

  it('records unavailable canonical targets as blocked without prompting another agent', async () => {
    const run = runFixture();
    let prompted = false;
    const adapter: ProjectCronExecutionAdapter<string> = {
      resolveCanonicalAgent: async () => ({ status: 'blocked', message: 'Workspace is closed and has no canonical agent' }),
      promptCanonicalAgent: async () => { prompted = true; return { status: 'accepted' }; },
      completeRun: async (input) => ({ ...run, state: input.state, message: input.message, resolvedSpaceId: input.resolvedSpaceId, resolvedGeneration: input.resolvedGeneration, completedAt: new Date() }),
    };
    const result = await runClaimedProjectCron({ run, claimToken: 'claim-a', leaseExpiresAt: new Date(Date.now() + 60_000) }, adapter);
    expect(prompted).toBe(false);
    expect(result).toMatchObject({ state: 'blocked', message: 'Workspace is closed and has no canonical agent', resolvedSpaceId: null });
  });

  it('records prompt exceptions as failed rather than claiming success', async () => {
    const run = runFixture();
    const adapter: ProjectCronExecutionAdapter<string> = {
      resolveCanonicalAgent: async () => ({ status: 'ready', agent: 'canonical-agent', spaceId: 'space-a', generation: 10 }),
      promptCanonicalAgent: async () => { throw new Error('OMP runtime unavailable'); },
      completeRun: async (input) => ({ ...run, state: input.state, message: input.message, resolvedSpaceId: input.resolvedSpaceId, resolvedGeneration: input.resolvedGeneration, completedAt: new Date() }),
    };
    const result = await runClaimedProjectCron({ run, claimToken: 'claim-a', leaseExpiresAt: new Date(Date.now() + 60_000) }, adapter);
    expect(result.state).toBe('failed');
    expect(result.message).toContain('OMP runtime unavailable');
    expect(result.resolvedGeneration).toBe(10);
  });

  it('claims the next authority run before executing it', async () => {
    const run = runFixture();
    const adapter: ProjectCronRunnerAdapter<string> = {
      claimNext: async (input) => {
        expect(input).toEqual({ projectId: 'project-a', claimedBy: 'machine-a' });
        return { run, claimToken: 'claim-a', leaseExpiresAt: new Date(Date.now() + 60_000) };
      },
      resolveCanonicalAgent: async () => ({ status: 'ready', agent: 'canonical-agent', spaceId: 'space-a', generation: 11 }),
      promptCanonicalAgent: async () => ({ status: 'accepted' }),
      completeRun: async (input) => ({ ...run, state: input.state, message: input.message, resolvedSpaceId: input.resolvedSpaceId, resolvedGeneration: input.resolvedGeneration, completedAt: new Date() }),
    };
    expect(await runNextProjectCron('project-a', 'machine-a', adapter)).toMatchObject({ state: 'succeeded', resolvedGeneration: 11 });
  });

  it('builds an unattended prompt with both authority scope lists', () => {
    const prompt = buildProjectCronPrompt(runFixture());
    expect(prompt).toContain('Explicit read scopes: repository/**.');
    expect(prompt).toContain('Explicit write scopes: local://workspace/reports/**.');
    expect(prompt).toContain('Stable target: workspace space-a in project project-a.');
  });
});
