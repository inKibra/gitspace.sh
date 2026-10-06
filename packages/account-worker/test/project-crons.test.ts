import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { PROJECT_CRON_OVERDUE_MS, type ProjectCronDraft } from '@gitspace/protocol/cron-contract';
import {
  ProjectCronAlreadyRunningError,
  ProjectCronRevisionConflictError,
  ProjectCronValidationError,
  ProjectCronsDO,
} from '../src/project-crons.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';

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

  it('deduplicates a retried manual request without admitting another run', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('request-identity');
    const now = Date.now() + 120_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const first = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, requestId: 'request-a', now: now + 1 }));
    const retry = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, requestId: 'request-a', now: now + 2 }));
    expect(retry.id).toBe(first.id);
    expect((await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.history({ projectId: 'project-a', cronId: cron.id }))).map(run => run.id)).toEqual([first.id]);
  });

  it('materializes due runs once and blocks overlapping requests', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('claim');
    const now = Date.now() + 120_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const dueAt = cron.nextRunAt!.getTime();
    const first = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: dueAt }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ trigger: 'scheduled', state: 'pending', cronRevision: 1 });

    const stacked = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: dueAt + 299_999 }));
    expect(stacked).toEqual([]);
    await expect(runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: dueAt + 299_999 }))).rejects.toBeInstanceOf(ProjectCronAlreadyRunningError);

  });

  it('does not stop the user when a cron queues behind user work for more than an hour', async () => {
    const now = Date.now() + 120_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const receipt = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeRequestStatus').mockResolvedValue({ state: 'pending', conversationId: 'user-conversation', message: null });
    const submit = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronSubmit').mockResolvedValue({ conversationId: 'user-conversation' });
    const stop = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCancel').mockResolvedValue({ accepted: true, cursor: 0 });
    try {
      const stub = cronEnv.PROJECT_CRONS.getByName('queued-past-hour');
      const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft({ schedule: 'every 6h' }), now }));
      await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
      await runInDurableObject(stub, instance => instance.alarm());
      clock.mockReturnValue(now + PROJECT_CRON_OVERDUE_MS + 1);
      await runInDurableObject(stub, instance => instance.alarm());
      expect(stop).not.toHaveBeenCalled();
      const history = await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id }));
      expect(history[0]?.startedAt).toBeNull();
      expect(history[0]?.completedAt).toBeNull();
    } finally { clock.mockRestore(); receipt.mockRestore(); submit.mockRestore(); stop.mockRestore(); }
  });

  it('expires queued work at the schedule interval instead of waiting for the runtime limit', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('queue-interval');
    const now = Date.now() + 120_000;
    const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const old = await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
    const due = await runInDurableObject(stub, instance => instance.processDue({ projectId: 'project-a', now: now + 300_000 }));
    expect(due).toHaveLength(1);
    const history = await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id }));
    expect(history.find(run => run.id === old.id)).toMatchObject({ state: 'blocked', message: 'Skipped: workspace busy' });
    expect(due[0]?.id).not.toBe(old.id);
  });

  it('keeps an overdue running cron active and later records its actual completion', async () => {
    const now = Date.now() + 120_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const receipt = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeRequestStatus').mockResolvedValue({ state: 'running', conversationId: 'cron-conversation', message: null });
    const stop = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCancel').mockResolvedValue({ accepted: true, cursor: 0 });
    const notify = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronNotifyOverdue').mockResolvedValue(undefined);
    try {
      const stub = cronEnv.PROJECT_CRONS.getByName('overdue-completion');
      const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft({ schedule: 'every 6h' }), now }));
      const run = await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
      await runInDurableObject(stub, instance => instance.alarm());
      clock.mockReturnValue(now + PROJECT_CRON_OVERDUE_MS + 1);
      await runInDurableObject(stub, instance => instance.alarm());
      expect(stop).not.toHaveBeenCalled();
      const overdue = await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id }));
      expect(overdue[0]).toMatchObject({ id: run.id, state: 'running', completedAt: null });
      expect(overdue[0]?.message).toMatch(/overdue/i);
      expect(notify).toHaveBeenCalledWith({ projectId: 'project-a', workspaceId: 'project-a', requestId: `cron:${run.id}` });
      receipt.mockResolvedValue({ state: 'succeeded', conversationId: 'cron-conversation', message: null });
      await runInDurableObject(stub, instance => instance.alarm());
      expect((await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id })))[0]).toMatchObject({ id: run.id, state: 'succeeded' });
    } finally { clock.mockRestore(); receipt.mockRestore(); stop.mockRestore(); notify.mockRestore(); }
  });

  it('withdraws an expired cloud queue receipt and schedules a fresh run without stopping the workspace', async () => {
    const now = Date.now() + 120_000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const status = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeRequestStatus').mockResolvedValue({ state: 'queued', conversationId: 'busy-user', message: null });
    const withdraw = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronWithdraw').mockResolvedValue({ state: 'withdrawn', conversationId: 'busy-user', message: 'withdrawn' });
    const stop = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCancel').mockResolvedValue({ accepted: true, cursor: 0 });
    try {
      const stub = cronEnv.PROJECT_CRONS.getByName('cloud-queue-expiry');
      const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft(), now }));
      const old = await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
      await runInDurableObject(stub, instance => instance.alarm());
      clock.mockReturnValue(now + 300_000);
      await runInDurableObject(stub, instance => instance.alarm());
      expect(withdraw).toHaveBeenCalledWith({ projectId: 'project-a', workspaceId: 'project-a', requestId: `cron:${old.id}` });
      expect(stop).not.toHaveBeenCalled();
      const history = await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id }));
      expect(history.find(run => run.id === old.id)).toMatchObject({ state: 'blocked', message: 'Skipped: workspace busy' });
      expect(history.filter(run => run.state === 'pending' || run.state === 'running')).toHaveLength(1);
      expect(history[0]?.id).not.toBe(old.id);
    } finally { clock.mockRestore(); status.mockRestore(); withdraw.mockRestore(); stop.mockRestore(); }
  });

  it('queued page cancellation only withdraws its own request and never calls workspace Stop', async () => {
    const now = Date.now() + 120_000;
    const status = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeRequestStatus').mockResolvedValue({ state: 'queued', conversationId: 'shared-root', message: null });
    const withdraw = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronWithdraw').mockResolvedValue({ state: 'withdrawn', conversationId: 'shared-root', message: 'withdrawn' });
    const cancel = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronCancel');
    const stop = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCancel');
    try {
      const stub = cronEnv.PROJECT_CRONS.getByName('page-queued-cancel');
      const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft(), now }));
      const run = await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
      await runInDurableObject(stub, instance => instance.alarm());
      expect(await runInDurableObject(stub, instance => instance.cancelRun({ projectId: 'project-a', runId: run.id, confirmStopWorkspaceAgent: false }))).toMatchObject({ id: run.id, state: 'blocked', startedAt: null });
      expect(withdraw).toHaveBeenCalledWith({ projectId: 'project-a', workspaceId: 'project-a', requestId: `cron:${run.id}` });
      expect(cancel).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
    } finally { status.mockRestore(); withdraw.mockRestore(); cancel.mockRestore(); stop.mockRestore(); }
  });

  it('refuses a queued-to-running cancellation race until the user explicitly confirms Stop', async () => {
    const now = Date.now() + 120_000;
    const status = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeRequestStatus').mockResolvedValue({ state: 'queued', conversationId: 'shared-root', message: null });
    const withdraw = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronWithdraw').mockResolvedValue({ state: 'running', conversationId: 'shared-root', message: null, startedAt: now });
    const cancel = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeCronCancel').mockResolvedValue({ state: 'interrupted', conversationId: 'shared-root', message: 'Workspace stopped', startedAt: now });
    try {
      const stub = cronEnv.PROJECT_CRONS.getByName('page-running-cancel');
      const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft(), now }));
      const run = await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
      await runInDurableObject(stub, instance => instance.alarm());
      await expect(runInDurableObject(stub, instance => instance.cancelRun({ projectId: 'project-a', runId: run.id, confirmStopWorkspaceAgent: false }))).rejects.toThrow('Explicit confirmation');
      expect(cancel).not.toHaveBeenCalled();
      expect((await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id })))[0]?.startedAt?.getTime()).toBe(now);
      await runInDurableObject(stub, instance => instance.cancelRun({ projectId: 'project-a', runId: run.id, confirmStopWorkspaceAgent: true }));
      expect(cancel).toHaveBeenCalledWith({ projectId: 'project-a', workspaceId: 'project-a', requestId: `cron:${run.id}`, confirmStopWorkspaceAgent: true });
    } finally { status.mockRestore(); withdraw.mockRestore(); cancel.mockRestore(); }
  });

  it('caps queued retention at 24 hours for schedules longer than a day', async () => {
    const now = Date.now() + 120_000;
    const stub = cronEnv.PROJECT_CRONS.getByName('queue-cap');
    const cron = await runInDurableObject(stub, instance => instance.create({ projectId: 'project-a', draft: draft({ schedule: 'every 3d' }), now }));
    const run = await runInDurableObject(stub, instance => instance.runNow({ projectId: 'project-a', cronId: cron.id, now }));
    await runInDurableObject(stub, instance => instance.processDue({ projectId: 'project-a', now: now + 24 * 3600000 - 1 }));
    expect((await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id })))[0]?.completedAt).toBeNull();
    await runInDurableObject(stub, instance => instance.processDue({ projectId: 'project-a', now: now + 24 * 3600000 }));
    expect((await runInDurableObject(stub, instance => instance.history({ projectId: 'project-a', cronId: cron.id })))[0]).toMatchObject({ id: run.id, state: 'blocked', message: 'Skipped: workspace busy' });
  });

  it('expires stale pending locks honestly before scheduling another due run', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('stale');
    const now = Date.now() + 180_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const manual = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: now + 1 }));
    const afterLock = now + PROJECT_CRON_OVERDUE_MS + 2;
    const replacement = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: afterLock }));
    expect(replacement).toHaveLength(1);
    const history = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.history({ projectId: 'project-a', cronId: cron.id }));
    expect(history.find((run) => run.id === manual.id)?.state).toBe('blocked');
    expect(history.find((run) => run.id === replacement[0]!.id)?.state).toBe('pending');
  });

  it('does not release an unresolved running claim when its old lease expires', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('uncertain-claim');
    const now = Date.now() + 180_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft(), now }));
    const run = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: now + 1 }));
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE project_cron_runs SET state='running',claimed_at=?,claim_token='unresolved',claimed_by='old-machine' WHERE id=?", now + 2, run.id);
    });
    const afterExpiry = now + PROJECT_CRON_OVERDUE_MS + 3;
    expect(await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: afterExpiry }))).toEqual([]);
    await expect(runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: afterExpiry + 1 }))).rejects.toBeInstanceOf(ProjectCronAlreadyRunningError);
    expect((await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.history({ projectId: 'project-a', cronId: cron.id })))[0]).toMatchObject({ id: run.id, state: 'running' });
  });

  it('retains append-only run history after deleting a blocked definition', async () => {
    const stub = cronEnv.PROJECT_CRONS.getByName('delete-history');
    const now = Date.now() + 240_000;
    const cron = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.create({ projectId: 'project-a', draft: draft({ enabled: false }), now }));
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.runNow({ projectId: 'project-a', cronId: cron.id, now: now + 1 }));
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.processDue({ projectId: 'project-a', now: now + PROJECT_CRON_OVERDUE_MS + 2 }));
    await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.delete({ projectId: 'project-a', cronId: cron.id, expectedRevision: 1, now: now + PROJECT_CRON_OVERDUE_MS + 3 }));
    expect(await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.list('project-a'))).toEqual([]);
    const history = await runInDurableObject(stub, (instance: ProjectCronsDO) => instance.history({ projectId: 'project-a', cronId: cron.id }));
    expect(history).toHaveLength(1);
    expect(history[0]?.state).toBe('blocked');
  });
});
