import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTOMATION_MAX_QUEUE_MS, type AutomationDraft, type AutomationMode } from '@gitspace/protocol/automations-contract';
import { automationValue } from '../src/project-automations.js';
import { SpaceAuthorityDO } from '../src/space-authority.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** A UTC midnight days ahead: the alarms these tests set never come due on the real clock, so only the tests run them. */
const midnight = Math.ceil(Date.now() / DAY) * DAY + 3 * DAY;

/** A project with one active workspace, as the account knows it. */
async function project() {
  const projectId = `project-${crypto.randomUUID()}`;
  const workspaceId = `space-${crypto.randomUUID()}`;
  const authority = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const created = await authority.bootstrap({ id: projectId, name: `Automations ${projectId}`, repositoryReference: null, baseBranch: 'main', createdBy: 'human' });
  await env.USER_PROJECTS.getByName(env.ACCOUNT_ID).put(await authority.setProjectLifecycle(created.revision, 'active'));
  for (const [id, kind] of [[projectId, 'base'], [workspaceId, 'worktree']] as const) {
    await authority.putWorkspace({ id, projectId, kind, name: kind === 'base' ? 'Project' : 'release-work', branch: kind === 'base' ? 'main' : 'release', phase: kind === 'base' ? null : 'code', sourceKind: 'base', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
  }
  const automations = env.PROJECT_AUTOMATIONS.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  const alarm = () => runInDurableObject(automations, (_instance, state) => state.storage.getAlarm());
  return { projectId, workspaceId, automations, alarm };
}

function manual(name: string, instruction = 'Check the project.'): AutomationDraft {
  return { name, trigger: { kind: 'manual' }, conditions: [], action: { kind: 'messageProjectAgent', instruction }, enabled: true };
}

describe('ProjectAutomationsDO', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(midnight + HOUR);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('runs a schedule at its next UTC time and messages its workspace', async () => {
    const submit = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationSubmit').mockResolvedValue({ conversationId: 'root' });
    const { projectId, workspaceId, automations, alarm } = await project();
    const created = automationValue(await automations.create({ projectId, draft: { name: 'Nightly audit', trigger: { kind: 'schedule', cron: '0 6 * * *' }, conditions: [], action: { kind: 'messageWorkspace', workspaceId, instruction: 'Audit dependencies as of {{scheduled_for}}.' }, enabled: true } }));
    const six = midnight + 6 * HOUR;
    expect(created.nextRunAt?.getTime()).toBe(six);
    expect(await alarm()).toBe(six);
    vi.setSystemTime(six);
    expect(await runDurableObjectAlarm(automations)).toBe(true);
    const [run] = automationValue(await automations.runs({ projectId }));
    expect(run).toMatchObject({ automationId: created.id, trigger: 'schedule', state: 'running', workspaceId, scheduledFor: new Date(six) });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ projectId, workspaceId, requestId: `automation:${run?.id}`, text: expect.stringContaining(`Audit dependencies as of ${new Date(six).toISOString()}.`) });
    // The run works in its workspace; the only deadline left is tomorrow's run.
    expect(await alarm()).toBe(six + DAY);
  });

  it('never runs a proposal until a person approves it, and refuses an approval of a revision since changed', async () => {
    const submit = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationSubmit').mockResolvedValue({ conversationId: 'root' });
    const { projectId, automations, alarm } = await project();
    const draft: AutomationDraft = { name: 'Heartbeat', trigger: { kind: 'schedule', cron: '*/5 * * * *' }, conditions: [], action: { kind: 'messageProjectAgent', instruction: 'Check in.' }, enabled: true };
    const asked = { conversationId: 'conversation-1', asked: 'Check in every five minutes', reason: 'A heartbeat finds a stuck project early' };
    const proposed = automationValue(await automations.propose({ projectId, draft, ...asked }));
    expect(proposed).toMatchObject({ createdBy: 'projectAgent', enabled: false, nextRunAt: null, proposal: { conversationId: 'conversation-1', tested: [{ result: 'Would message the project agent', runs: true }, { runs: true }, { runs: true }] } });
    expect(await alarm()).toBeNull();
    expect(await automations.runNow({ projectId, automationId: proposed.id, requestedBy: 'Brad' })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'proposal' } });
    vi.setSystemTime(midnight + DAY);
    expect(await runDurableObjectAlarm(automations)).toBe(false);
    expect(automationValue(await automations.runs({ projectId }))).toEqual([]);

    // The agent changes it after a person looked at revision 1: approving what they saw is refused.
    const changed = automationValue(await automations.propose({ projectId, automationId: proposed.id, draft: { ...draft, action: { kind: 'messageProjectAgent', instruction: 'Check in, briefly.' } }, ...asked }));
    expect(changed.revision).toBe(2);
    expect(await automations.approve({ projectId, automationId: proposed.id, revision: 1 })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'revision' } });
    expect((await automations.list(projectId)).automations).toMatchObject([{ id: proposed.id, enabled: false, proposal: { conversationId: 'conversation-1' } }]);

    const approved = automationValue(await automations.approve({ projectId, automationId: proposed.id, revision: 2 }));
    expect(approved).toMatchObject({ enabled: true, proposal: null, nextRunAt: new Date(midnight + DAY + 5 * MINUTE) });
    vi.setSystemTime(midnight + DAY + 5 * MINUTE);
    expect(await runDurableObjectAlarm(automations)).toBe(true);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ projectId, workspaceId: projectId, text: expect.stringContaining('Check in, briefly.') }));
  });

  it('queues runs past the project concurrency, and skips a run that waited a day for a slot', async () => {
    const submit = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationSubmit').mockResolvedValue({ conversationId: 'root' });
    const { projectId, automations, alarm } = await project();
    const runIds: string[] = [];
    for (const name of ['One', 'Two', 'Three']) {
      const automation = automationValue(await automations.create({ projectId, draft: manual(name) }));
      runIds.push(automationValue(await automations.runNow({ projectId, automationId: automation.id, requestedBy: 'Brad' })).id);
    }
    expect(await runDurableObjectAlarm(automations)).toBe(true);
    expect(submit).toHaveBeenCalledTimes(2);
    const runs = async () => automationValue(await automations.runs({ projectId }));
    expect((await runs()).map(run => [run.automationName, run.state])).toEqual([['Three', 'queued'], ['Two', 'running'], ['One', 'running']]);
    // The queued run's only deadline is its expiry.
    expect(await alarm()).toBe(midnight + HOUR + AUTOMATION_MAX_QUEUE_MS);
    vi.setSystemTime(midnight + HOUR + AUTOMATION_MAX_QUEUE_MS);
    expect(await runDurableObjectAlarm(automations)).toBe(true);
    expect((await runs()).find(run => run.id === runIds[2])).toMatchObject({ state: 'skipped', outcome: 'Skipped: waited more than a day for a slot' });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('skips an automation\'s runs past the daily run cap until the next UTC day', async () => {
    vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationSubmit').mockResolvedValue({ conversationId: 'root' });
    const { projectId, automations } = await project();
    expect(await automations.updateSettings({ projectId, settings: { concurrency: 2, dailyRunCap: 1, trusted: [] } })).toEqual({ concurrency: 2, dailyRunCap: 1, trusted: [] });
    const automation = automationValue(await automations.create({ projectId, draft: manual('Triage') }));
    const first = automationValue(await automations.runNow({ projectId, automationId: automation.id, requestedBy: 'Brad' }));
    await runDurableObjectAlarm(automations);
    await automations.runTurnChanged({ projectId, workspaceId: projectId, requestId: `automation:${first.id}`, state: 'ended', outcome: 'finished', text: 'Triaged.' });
    expect(automationValue(await automations.runNow({ projectId, automationId: automation.id, requestedBy: 'Brad' }))).toMatchObject({ state: 'skipped', outcome: 'Skipped: daily run cap' });
    vi.setSystemTime(midnight + DAY + HOUR);
    expect(automationValue(await automations.runNow({ projectId, automationId: automation.id, requestedBy: 'Brad' }))).toMatchObject({ state: 'queued', outcome: null });
  });

  it('ends a run when its workspace reports the turn ended, and sets no alarm while the agent works', async () => {
    const submit = vi.spyOn(SpaceAuthorityDO.prototype, 'runtimeAutomationSubmit').mockResolvedValue({ conversationId: 'root' });
    const { projectId, workspaceId, automations, alarm } = await project();
    const automation = automationValue(await automations.create({ projectId, draft: { name: 'Summary', trigger: { kind: 'manual' }, conditions: [], action: { kind: 'messageWorkspace', workspaceId, instruction: 'Summarize what {{requested_by}} needs.' }, enabled: true } }));
    const run = automationValue(await automations.runNow({ projectId, automationId: automation.id, requestedBy: 'Brad' }));
    expect(run.state).toBe('queued');
    await runDurableObjectAlarm(automations);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, requestId: `automation:${run.id}`, text: expect.stringContaining('Summarize what Brad needs.') }));
    expect(await alarm()).toBeNull();
    vi.setSystemTime(midnight + HOUR + MINUTE);
    await automations.runTurnChanged({ projectId, workspaceId, requestId: `automation:${run.id}`, state: 'running' });
    expect(await alarm()).toBeNull();
    vi.setSystemTime(midnight + HOUR + 10 * MINUTE);
    await automations.runTurnChanged({ projectId, workspaceId, requestId: `automation:${run.id}`, state: 'ended', outcome: 'finished', text: 'Summary posted.' });
    const [ended] = automationValue(await automations.runs({ projectId, automationId: automation.id }));
    expect(ended).toMatchObject({ id: run.id, state: 'finished', outcome: 'Summary posted.', startedAt: new Date(midnight + HOUR + MINUTE), finishedAt: new Date(midnight + HOUR + 10 * MINUTE) });
    expect(ended?.timeline.map(entry => entry.label)).toEqual(['Started by Brad', 'Queued', 'Sent to release-work', 'The agent started working', 'Finished']);
    // A report the workspace sends again changes nothing.
    await automations.runTurnChanged({ projectId, workspaceId, requestId: `automation:${run.id}`, state: 'ended', outcome: 'failed', text: 'Again.' });
    expect(automationValue(await automations.runs({ projectId, automationId: automation.id }))[0]).toMatchObject({ state: 'finished', outcome: 'Summary posted.' });
    expect(await alarm()).toBeNull();
  });

  it('refuses an instruction naming a field its trigger lacks, an invalid UTC schedule and a workspace outside the project', async () => {
    const { projectId, automations } = await project();
    const refused = (draft: AutomationDraft) => automations.create({ projectId, draft });
    expect(await refused(manual('Pull requests', 'Review {{pull_request.html_url}}'))).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'action.instruction' } });
    expect(await refused({ name: 'Nightly', trigger: { kind: 'schedule', cron: '0 6 * * *' }, conditions: [], action: { kind: 'messageProjectAgent', instruction: 'Asked by {{requested_by}}' }, enabled: true })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'action.instruction' } });
    for (const cron of ['61 * * * *', '0 0 30 2 *', 'every 5m']) {
      expect(await refused({ name: 'Nightly', trigger: { kind: 'schedule', cron }, conditions: [], action: { kind: 'messageProjectAgent', instruction: 'Audit.' }, enabled: true })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'trigger.cron' } });
    }
    expect(await refused({ name: 'Elsewhere', trigger: { kind: 'manual' }, conditions: [], action: { kind: 'messageWorkspace', workspaceId: 'not-in-project', instruction: 'Audit.' }, enabled: true })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'action.workspaceId' } });
    expect(await automations.testDraft({ projectId, draft: manual('Pull requests', 'Review {{pull_request.html_url}}'), requestedBy: 'Brad' })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'action.instruction' } });
    expect((await automations.list(projectId)).automations).toEqual([]);
  });

  it('tests a schedule as its next three UTC run times and renders its instruction', async () => {
    const { projectId, workspaceId, automations } = await project();
    expect(automationValue(await automations.testDraft({ projectId, draft: { name: 'Nightly', trigger: { kind: 'schedule', cron: '0 6 * * *' }, conditions: [], action: { kind: 'messageWorkspace', workspaceId, instruction: '{{automation.name}} for {{scheduled_for}}' }, enabled: true }, requestedBy: 'Brad' }))).toEqual({
      results: [0, 1, 2].map(day => ({ label: `${new Date(midnight + day * DAY).toISOString().slice(0, 10)} 06:00 UTC`, result: 'Would message release-work', runs: true })),
      instruction: `Nightly for ${new Date(midnight + 6 * HOUR).toISOString()}`, checks: [],
    });
    expect(automationValue(await automations.testDraft({ projectId, draft: manual('By hand', 'Started by {{requested_by}}'), requestedBy: 'Brad' }))).toEqual({
      results: [{ label: 'Manual', result: 'Runs only when someone starts it', runs: false }],
      instruction: 'Started by Brad', checks: [],
    });
  });

  describe('phases', () => {
    /** A manual automation messaging the project's workspace (in Code), limited to `phases` when given. */
    const toWorkspace = (name: string, workspaceId: string, phases?: AutomationMode[]): AutomationDraft => ({
      name, trigger: { kind: 'manual' }, conditions: [], action: { kind: 'messageWorkspace', workspaceId, instruction: 'Check the release.' }, enabled: true, ...(phases ? { phases } : {}),
    });

    it('runs in every phase without phases, skips a workspace in a phase it does not name, and records the workspace\'s phase on its runs', async () => {
      const { projectId, workspaceId, automations } = await project();
      const run = async (draft: AutomationDraft) => {
        const automation = automationValue(await automations.create({ projectId, draft }));
        return automationValue(await automations.runNow({ projectId, automationId: automation.id, requestedBy: 'Brad' }));
      };
      expect(await run(toWorkspace('Any phase', workspaceId))).toMatchObject({ state: 'queued', workspaceId, phase: 'code', skipReason: null, outcome: null, checks: [] });
      expect(await run(toWorkspace('Plan and review', workspaceId, ['plan', 'review']))).toMatchObject({ state: 'skipped', workspaceId, phase: 'code', skipReason: 'phase', outcome: 'Skipped: release-work is in Code; it runs in Plan, Review', checks: [{ label: 'release-work is in Code; it runs in Plan, Review', passed: false }] });
      await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`).commitWorkspacePhase(workspaceId, 'review');
      expect(await run(toWorkspace('Review only', workspaceId, ['review']))).toMatchObject({ state: 'queued', workspaceId, phase: 'review', outcome: null });
      // The project agent has no phase, so phases do not limit a run to it.
      expect(await run({ ...manual('Project check'), phases: ['ship'] })).toMatchObject({ state: 'queued', workspaceId: projectId, phase: null });
      expect(await automations.create({ projectId, draft: toWorkspace('Twice', workspaceId, ['code', 'code']) })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'phases' } });
    });

    it('lets a person\'s exception for one workspace and phase decide over the automation\'s phases until it is removed, and deletes exceptions with the automation', async () => {
      const { projectId, workspaceId, automations } = await project();
      const codeOnly = automationValue(await automations.create({ projectId, draft: toWorkspace('Code only', workspaceId, ['code']) }));
      const planOnly = automationValue(await automations.create({ projectId, draft: toWorkspace('Plan only', workspaceId, ['plan']) }));
      const set = async (automationId: string, phase: AutomationMode, enabled: boolean | null) => automationValue(await automations.setException({ projectId, automationId, workspaceId, phase, enabled, by: 'device-1' }));
      /** One run now; a queued one is cancelled so the automation can run again. */
      const run = async (automationId: string) => {
        const started = automationValue(await automations.runNow({ projectId, automationId, requestedBy: 'Brad' }));
        if (started.state === 'queued') automationValue(await automations.cancelRun({ projectId, runId: started.id }));
        return started;
      };

      // An exception in another phase leaves this one to the automation's phases.
      await set(codeOnly.id, 'review', false);
      expect(await run(codeOnly.id)).toMatchObject({ state: 'queued', phase: 'code' });
      expect(await set(codeOnly.id, 'code', false)).toEqual({ automationId: codeOnly.id, workspaceId, phase: 'code', enabled: false, at: new Date(midnight + HOUR).toISOString(), by: 'device-1' });
      expect(await run(codeOnly.id)).toMatchObject({ state: 'skipped', phase: 'code', skipReason: 'phase', outcome: 'Skipped: a person switched it off for release-work in Code' });
      await set(planOnly.id, 'code', true);
      expect(await run(planOnly.id)).toMatchObject({ state: 'queued', phase: 'code', checks: [{ label: 'a person switched it on for release-work in Code', passed: true }] });
      expect(await set(codeOnly.id, 'code', null)).toBeNull();
      expect(await run(codeOnly.id)).toMatchObject({ state: 'queued', phase: 'code', checks: [{ label: 'release-work is in Code; it runs in Code', passed: true }] });
      expect(await automations.setException({ projectId, automationId: codeOnly.id, workspaceId: 'not-in-project', phase: 'code', enabled: true, by: 'device-1' })).toMatchObject({ status: 'error', failure: { kind: 'invalid', field: 'workspaceId' } });

      expect(await automations.exceptions(projectId)).toHaveLength(2);
      automationValue(await automations.delete({ projectId, automationId: planOnly.id }));
      expect(await automations.exceptions(projectId)).toEqual([expect.objectContaining({ automationId: codeOnly.id, workspaceId, phase: 'review', enabled: false })]);
    });
  });
});
