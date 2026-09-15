import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { PROJECT_CRON_ACTIVE_LOCK_MS, type ProjectCronDraft } from '@gitspace/protocol/cron-contract';
import {
  ProjectCronAlreadyRunningError,
  ProjectCronRevisionConflictError,
  ProjectCronValidationError,
  ProjectCronsDO,
} from '../src/project-crons.js';

const cronEnv = env as typeof env & { PROJECT_CRONS: DurableObjectNamespace<ProjectCronsDO> };

function draft(overrides: Partial<ProjectCronDraft> = {}): ProjectCronDraft {
  return {
    name: 'project-health',
    schedule: 'every 5m',
    description: 'Review project health.',
    prompt: 'Review repository health and summarize blockers.',
    target: { scope: 'project', projectId: 'project-a' },
    readScopes: ['repository/**'],
    writeScopes: ['local://base/reports/**'],
    enabled: true,
    ...overrides,
  };
}

describe('ProjectCronsDO', () => {
  it('stores project definitions with optimistic revisions and explicit scopes', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('definitions');
    const now = Date.now() + 60_000;
    await expect(runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({
      projectId: 'project-a',
      draft: draft({ schedule: 'Mon 09:00' }),
      now: now - 1,
    }))).rejects.toBeInstanceOf(ProjectCronValidationError);
    const created = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    expect(created).toMatchObject({ revision: 1, state: 'armed', readScopes: ['repository/**'], writeScopes: ['local://base/reports/**'] });
    expect(created.nextRunAt?.getTime()).toBe(now + 300_000);

    const updated = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.update({
      projectId: 'project-a',
      cronId: created.id,
      expectedRevision: 1,
      draft: draft({ description: 'Updated authority description.' }),
      now: now + 1,
    }));
    expect(updated).toMatchObject({ revision: 2, description: 'Updated authority description.' });
    await expect(runInDurableObject(stub, (instance: ProjectCronsDO) => instance.update({
      projectId: 'project-a', cronId: created.id, expectedRevision: 1, draft: draft(), now: now + 2,
    }))).rejects.toBeInstanceOf(ProjectCronRevisionConflictError);
  });

  it('leaves runs pending for the machine that holds their target', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('placement');
    const now = Date.now() + 120_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft({ target: { scope: 'workspace', projectId: 'project-a', spaceId: 'workspace-b' } }), now }));
    const dueAt = cron.nextRunAt!.getTime();
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: dueAt }));
    // Machine A holds only the base space: nothing to claim, the run stays pending.
    expect(await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.claimNext({ projectId: 'project-a', claimedBy: 'machine-a', heldSpaceIds: ['project-a'], now: dueAt + 1 }))).toBeNull();
    const claim = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.claimNext({ projectId: 'project-a', claimedBy: 'machine-b', heldSpaceIds: ['workspace-b'], now: dueAt + 2 }));
    expect(claim?.run.state).toBe('running');
  });

  it('materializes due runs once, claims atomically, and records resolved generation on completion', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('claim');
    const now = Date.now() + 120_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const dueAt = cron.nextRunAt!.getTime();
    const first = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: dueAt }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ trigger: 'scheduled', state: 'pending', cronRevision: 1 });

    const stacked = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: dueAt + 300_000 }));
    expect(stacked).toEqual([]);
    await expect(runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: dueAt + 300_001 }))).rejects.toBeInstanceOf(ProjectCronAlreadyRunningError);

    const claim = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.claimNext({ projectId: 'project-a', claimedBy: 'machine-a', now: dueAt + 1 }));
    expect(claim?.run.state).toBe('running');
    expect(await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.claimNext({ projectId: 'project-a', claimedBy: 'machine-b', now: dueAt + 2 }))).toBeNull();

    const completed = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.completeRun({
      projectId: 'project-a', runId: claim!.run.id, claimToken: claim!.claimToken,
      state: 'succeeded', resolvedSpaceId: 'project-a', resolvedGeneration: 4, now: dueAt + 10,
    }));
    expect(completed).toMatchObject({ state: 'succeeded', resolvedSpaceId: 'project-a', resolvedGeneration: 4 });
  });

  it('expires stale pending locks honestly before scheduling another due run', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('stale');
    const now = Date.now() + 180_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const manual = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: now + 1 }));
    const afterLock = now + PROJECT_CRON_ACTIVE_LOCK_MS + 2;
    const replacement = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: afterLock }));
    expect(replacement).toHaveLength(1);
    const history = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.history({ projectId: 'project-a', cronId: cron.id }));
    expect(history.find((run) => run.id === manual.id)).toMatchObject({ state: 'failed', message: 'Run was not claimed within one hour' });
    expect(history.find((run) => run.id === replacement[0]!.id)?.state).toBe('pending');
  });

  it('retains append-only run history after deleting a completed definition', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('delete-history');
    const now = Date.now() + 240_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: now + 1 }));
    const claim = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.claimNext({ projectId: 'project-a', claimedBy: 'machine-a', now: now + 2 }));
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.completeRun({ projectId: 'project-a', runId: claim!.run.id, claimToken: claim!.claimToken, state: 'blocked', message: 'Workspace is closed', now: now + 3 }));
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.delete({ projectId: 'project-a', cronId: cron.id, expectedRevision: 1, now: now + 4 }));
    expect(await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.list('project-a'))).toEqual([]);
    const history = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.history({ projectId: 'project-a', cronId: cron.id }));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ state: 'blocked', message: 'Workspace is closed' });
  });
});
