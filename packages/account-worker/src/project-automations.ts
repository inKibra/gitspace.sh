import {
  AUTOMATION_DEFAULT_SETTINGS,
  AUTOMATION_MAX_QUEUE_MS,
  AUTOMATION_TRIGGER_FIELDS,
  nextAutomationRunAt,
  parseAutomationSchedule,
  renderAutomationInstruction,
  unknownAutomationPlaceholders,
  type AutomationAction,
  type AutomationDraft,
  type AutomationProjectSummary,
  type AutomationRunState,
  type AutomationRunView,
  type AutomationSettings,
  type AutomationTestResult,
  type AutomationView,
} from '@gitspace/protocol/automations-contract';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { z } from 'zod';
import { notifyBrowsers } from './live-notices.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

const DAY_MS = 24 * 60 * 60_000;
/** Runs kept per automation; older ended ones are deleted as new ones are recorded. */
const KEPT_RUNS = 200;
/** The newest runs each project pushes to the account index for the overview. */
const INDEXED_RUNS = 20;
/** A run whose message cannot reach its workspace is sent again after each of these delays, then fails. */
const SUBMIT_RETRY_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];
const MAX_NAME = 120;
const MAX_INSTRUCTION = 16_000;
/** A run's submission to its workspace carries this request id prefix and the run id. */
export const AUTOMATION_REQUEST_PREFIX = 'automation:';

/** The start of the UTC day `at` falls in: daily run caps and "failed today" count from it. */
export function utcDay(at: number): number {
  return Math.floor(at / DAY_MS) * DAY_MS;
}

/** A UTC time as run timelines and tests show it: "2026-10-28 06:00 UTC". */
function utcLabel(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

const TimelineSchema = z.array(z.object({ at: z.number(), label: z.string() }));
type Timeline = z.infer<typeof TimelineSchema>;

/** A run as the account index keeps it, times in epoch milliseconds. */
export const AutomationRunRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  automationId: z.string(),
  automationName: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  state: z.enum(['queued', 'running', 'finished', 'skipped', 'failed']),
  workspaceId: z.string(),
  outcome: z.string().nullable(),
  timeline: TimelineSchema,
  scheduledFor: z.number(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
});
export type AutomationRunRecord = z.infer<typeof AutomationRunRecordSchema>;

export function automationRunView(record: AutomationRunRecord): AutomationRunView {
  return {
    ...record,
    timeline: record.timeline.map(entry => ({ at: new Date(entry.at), label: entry.label })),
    scheduledFor: new Date(record.scheduledFor),
    startedAt: record.startedAt === null ? null : new Date(record.startedAt),
    finishedAt: record.finishedAt === null ? null : new Date(record.finishedAt),
  };
}

const ProposalSchema = z.object({
  conversationId: z.string(),
  asked: z.string(),
  reason: z.string(),
  tested: z.array(z.object({ label: z.string(), result: z.string(), runs: z.boolean() })),
  proposedAt: z.number(),
});
type StoredProposal = z.infer<typeof ProposalSchema>;

const SettingsSchema = z.object({ concurrency: z.number().int().min(1).max(10), dailyRunCap: z.number().int().min(1).max(1000) });

/** What the workspace tells a run's automations object about the run's turn: it started, or it ended (finished,
 * failed, or stopped to ask a person). */
export const AutomationTurnReportSchema = z.discriminatedUnion('state', [
  z.object({ projectId: z.string(), workspaceId: z.string(), requestId: z.string(), state: z.literal('running') }),
  z.object({ projectId: z.string(), workspaceId: z.string(), requestId: z.string(), state: z.literal('ended'), outcome: z.enum(['finished', 'failed', 'asked']), text: z.string().nullable() }),
]);
export type AutomationTurnReport = z.infer<typeof AutomationTurnReportSchema>;

/** How a run ends with its turn: a turn that stops to ask a person frees its slot, as one that finished does. */
const TURN_END: Record<'finished' | 'failed' | 'asked', { state: 'finished' | 'failed'; label: string; outcome(text: string | null): string }> = {
  finished: { state: 'finished', label: 'Finished', outcome: text => text ?? 'Finished' },
  failed: { state: 'failed', label: 'Failed', outcome: text => `Failed: ${text ?? 'the turn ended without a reply'}` },
  asked: { state: 'finished', label: 'Stopped to ask a person', outcome: text => `Waiting for you: ${text ?? 'a question'}` },
};

/** Why an automation operation was refused; each kind is one of `automationErrors`. */
export type AutomationFailure =
  | { kind: 'invalid'; field: string; message: string }
  | { kind: 'notFound'; automationId: string }
  | { kind: 'alreadyRunning'; automationId: string; runId: string }
  | { kind: 'runNotFound'; runId: string };
export type AutomationOutcome<T> = { status: 'ok'; value: T } | { status: 'error'; failure: AutomationFailure };

export function automationFailureMessage(failure: AutomationFailure): string {
  switch (failure.kind) {
    case 'invalid': return failure.message;
    case 'notFound': return `Automation ${failure.automationId} does not exist`;
    case 'alreadyRunning': return `Automation ${failure.automationId} already has run ${failure.runId} queued or working`;
    case 'runNotFound': return `Run ${failure.runId} does not exist`;
  }
}

/** The value of an outcome, or its refusal as an error (for the project agent's tool). */
export function automationValue<T>(outcome: AutomationOutcome<T>): T {
  if (outcome.status === 'error') throw new Error(automationFailureMessage(outcome.failure));
  return outcome.value;
}

/** A refusal inside the automations object; its public methods return it as an outcome, since errors crossing a
 * Durable Object call keep only their message. */
class AutomationRefusal extends Error {
  readonly failure: AutomationFailure;

  constructor(failure: AutomationFailure) {
    super(automationFailureMessage(failure));
    this.name = 'AutomationRefusal';
    this.failure = failure;
  }
}

function refuse(field: string, message: string): never {
  throw new AutomationRefusal({ kind: 'invalid', field, message });
}

async function settled<T>(work: () => T | Promise<T>): Promise<AutomationOutcome<T>> {
  try { return { status: 'ok', value: await work() }; } catch (error) {
    if (error instanceof AutomationRefusal) return { status: 'error', failure: error.failure };
    throw error;
  }
}

/** A draft with its name trimmed and its schedule normalized, or the field that refuses it. */
function checkDraft(draft: AutomationDraft): AutomationDraft {
  const name = draft.name.trim();
  if (name.length === 0 || name.length > MAX_NAME) refuse('name', `Name must be 1 to ${MAX_NAME} characters`);
  let trigger = draft.trigger;
  if (trigger.kind === 'schedule') {
    const cron = trigger.cron.trim().split(/\s+/u).join(' ');
    const parsed = parseAutomationSchedule(cron);
    if ('error' in parsed) refuse('trigger.cron', parsed.error);
    trigger = { kind: 'schedule', cron };
  }
  const { instruction } = draft.action;
  if (instruction.trim().length === 0 || instruction.length > MAX_INSTRUCTION) refuse('action.instruction', `Instruction must be 1 to ${MAX_INSTRUCTION.toLocaleString('en-US')} characters`);
  const unknown = unknownAutomationPlaceholders(instruction, trigger.kind);
  if (unknown.length > 0) {
    const fields = AUTOMATION_TRIGGER_FIELDS[trigger.kind].map(field => `{{${field.path}}}`).join(', ');
    refuse('action.instruction', `${unknown.map(path => `{{${path}}}`).join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of a ${trigger.kind} trigger; it provides ${fields}`);
  }
  return { name, trigger, action: draft.action, enabled: draft.enabled };
}

interface AutomationRow extends Record<string, SqlStorageValue> {
  id: string;
  revision: number;
  name: string;
  /** Null for a manual trigger. */
  cron: string | null;
  /** Null for the project agent. */
  workspace_id: string | null;
  target_name: string;
  instruction: string;
  enabled: number;
  created_by: 'person' | 'projectAgent';
  proposal_json: string | null;
  /** Set only while the automation runs on a schedule: enabled and not proposed. */
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface RunRow extends Record<string, SqlStorageValue> {
  id: string;
  automation_id: string;
  automation_name: string;
  trigger: 'schedule' | 'manual';
  state: AutomationRunState;
  workspace_id: string;
  target_name: string;
  /** The rendered instruction, exactly as it is submitted. */
  message: string;
  outcome: string | null;
  timeline_json: string;
  scheduled_for: number;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  /** 1 once the workspace has accepted the submission. */
  submitted: number;
  attempts: number;
  retry_at: number | null;
}

type Firing = { trigger: 'schedule'; scheduledFor: number } | { trigger: 'manual'; requestedBy: string };

/**
 * One project's automations (docs/AUTOMATIONS-DESIGN.md §4, §7): their definitions, runs and limits. One alarm drives
 * schedules and the queue; it is set only for a deadline the work names (the next schedule time, a queued run's
 * expiry, a submission's retry) or to resume a run that holds a slot but was not yet submitted. A submitted run learns
 * its turn started and ended from its workspace (`runTurnChanged`), never by asking.
 */
export class ProjectAutomationsDO extends BudgetedDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS automation_identity(id INTEGER PRIMARY KEY CHECK (id = 1), project_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS automation_settings(id INTEGER PRIMARY KEY CHECK (id = 1), concurrency INTEGER NOT NULL, daily_run_cap INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS automations(
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          cron TEXT,
          workspace_id TEXT,
          target_name TEXT NOT NULL,
          instruction TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_by TEXT NOT NULL CHECK (created_by IN ('person', 'projectAgent')),
          proposal_json TEXT,
          next_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_runs(
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          automation_name TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'skipped', 'failed')),
          workspace_id TEXT NOT NULL,
          target_name TEXT NOT NULL,
          message TEXT NOT NULL,
          outcome TEXT,
          timeline_json TEXT NOT NULL,
          scheduled_for INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER,
          submitted INTEGER NOT NULL DEFAULT 0,
          attempts INTEGER NOT NULL DEFAULT 0,
          retry_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id, created_at);
        CREATE INDEX IF NOT EXISTS automation_runs_state ON automation_runs(state, created_at);
      `);
    });
  }

  list(projectIdInput: string): { automations: AutomationView[]; settings: AutomationSettings } {
    const projectId = this.ensureProject(projectIdInput);
    return { automations: this.rows<AutomationRow>('SELECT * FROM automations ORDER BY name, id').map(row => this.automationView(projectId, row)), settings: this.settings() };
  }

  /** A person's automation: it takes effect at once. */
  async create(input: { projectId: string; draft: AutomationDraft }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const draft = checkDraft(input.draft);
      const id = this.save({ projectId, id: null, draft, targetName: await this.targetName(projectId, draft.action), proposal: null, createdBy: 'person' });
      await this.changed(projectId);
      return this.automationView(projectId, this.requiredAutomation(id));
    });
  }

  /** A person's change: it takes effect at once and clears a proposal. */
  async update(input: { projectId: string; automationId: string; draft: AutomationDraft }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      this.requiredAutomation(input.automationId);
      const draft = checkDraft(input.draft);
      this.save({ projectId, id: input.automationId, draft, targetName: await this.targetName(projectId, draft.action), proposal: null, createdBy: 'person' });
      await this.changed(projectId);
      return this.automationView(projectId, this.requiredAutomation(input.automationId));
    });
  }

  /** The project agent's automation, new or a change to one: it is Proposed and does not run until a person approves it. */
  async propose(input: { projectId: string; automationId?: string; draft: AutomationDraft; conversationId: string; asked: string; reason: string }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      if (input.automationId !== undefined) this.requiredAutomation(input.automationId);
      const draft = checkDraft({ ...input.draft, enabled: false });
      const targetName = await this.targetName(projectId, draft.action);
      const now = Date.now();
      const proposal = { conversationId: input.conversationId, asked: input.asked, reason: input.reason, tested: dryRun(draft, targetName, 'a person', now).results, proposedAt: now };
      const id = this.save({ projectId, id: input.automationId ?? null, draft, targetName, proposal, createdBy: 'projectAgent' });
      await this.changed(projectId);
      return this.automationView(projectId, this.requiredAutomation(id));
    });
  }

  /** A person switches on a proposal at the revision they reviewed; a later change refuses it. */
  async approve(input: { projectId: string; automationId: string; revision: number }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const automation = this.requiredAutomation(input.automationId);
      if (automation.revision !== input.revision) refuse('revision', `This automation changed since revision ${input.revision}; review revision ${automation.revision} before approving it`);
      if (automation.proposal_json !== null) {
        this.ctx.storage.sql.exec('UPDATE automations SET proposal_json=NULL, enabled=1, next_run_at=?, updated_at=? WHERE id=?',
          automation.cron === null ? null : nextAutomationRunAt(automation.cron, Date.now()), Date.now(), automation.id);
        await this.changed(projectId);
      }
      return this.automationView(projectId, this.requiredAutomation(automation.id));
    });
  }

  /** Switches an automation off at once; a proposal stays a proposal. */
  async disable(input: { projectId: string; automationId: string }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const automation = this.requiredAutomation(input.automationId);
      this.ctx.storage.sql.exec('UPDATE automations SET enabled=0, next_run_at=NULL, updated_at=? WHERE id=?', Date.now(), automation.id);
      await this.changed(projectId);
      return this.automationView(projectId, this.requiredAutomation(automation.id));
    });
  }

  /** Deletes an automation, or dismisses a proposal. Its queued runs are skipped; a run already working finishes and
   * its history stays. */
  async delete(input: { projectId: string; automationId: string }): Promise<AutomationOutcome<{ projectId: string; automationId: string; deleted: boolean }>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const automation = this.requiredAutomation(input.automationId);
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        for (const run of this.rows<RunRow>("SELECT * FROM automation_runs WHERE automation_id=? AND state='queued'", automation.id)) this.finish(run, 'skipped', 'Skipped: its automation was deleted', now);
        this.ctx.storage.sql.exec('DELETE FROM automations WHERE id=?', automation.id);
      });
      await this.changed(projectId);
      return { projectId, automationId: automation.id, deleted: true };
    });
  }

  /** A person starts one run now, whatever the automation's trigger; a proposal never runs. */
  async runNow(input: { projectId: string; automationId: string; requestedBy: string }): Promise<AutomationOutcome<AutomationRunView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const automation = this.requiredAutomation(input.automationId);
      if (automation.proposal_json !== null) refuse('proposal', 'Approve this automation before it runs');
      const active = this.activeRun(automation.id);
      if (active) throw new AutomationRefusal({ kind: 'alreadyRunning', automationId: automation.id, runId: active.id });
      const now = Date.now();
      const runId = this.ctx.storage.transactionSync(() => this.recordRun(projectId, automation, { trigger: 'manual', requestedBy: input.requestedBy }, now));
      await this.changed(projectId);
      return this.runView(projectId, this.requiredRun(runId));
    });
  }

  /** A queued run, or one its workspace has not started, is skipped; one whose agent has started stops that agent. */
  async cancelRun(input: { projectId: string; runId: string }): Promise<AutomationOutcome<AutomationRunView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const run = this.requiredRun(input.runId);
      if (run.state === 'queued') this.finish(run, 'skipped', 'Cancelled', Date.now());
      else if (run.state === 'running') {
        const receipt = await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${run.workspace_id}`)
          .runtimeAutomationCancel({ projectId, workspaceId: run.workspace_id, requestId: `${AUTOMATION_REQUEST_PREFIX}${run.id}` });
        // The workspace may have reported the turn while the cancel was on its way.
        const current = this.requiredRun(run.id);
        if (current.state === 'running') {
          if (receipt.state === 'withdrawn') this.finish(current, 'skipped', 'Cancelled', Date.now());
          else if (receipt.state === 'failed') this.finish(current, 'failed', 'Cancelled: the workspace agent was stopped', Date.now());
          else if (receipt.state === 'succeeded') this.finish(current, 'finished', 'Finished', Date.now());
        }
      }
      await this.changed(projectId);
      return this.runView(projectId, this.requiredRun(run.id));
    });
  }

  /** The project's runs, or one automation's, newest first. */
  async runs(input: { projectId: string; automationId?: string; limit?: number }): Promise<AutomationOutcome<AutomationRunView[]>> {
    return settled(() => {
      const projectId = this.ensureProject(input.projectId);
      const limit = input.limit ?? 50;
      if (input.automationId === undefined) return this.rows<RunRow>('SELECT * FROM automation_runs ORDER BY created_at DESC, rowid DESC LIMIT ?', limit).map(row => this.runView(projectId, row));
      const rows = this.rows<RunRow>('SELECT * FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?', input.automationId, limit);
      if (rows.length === 0) this.requiredAutomation(input.automationId);
      return rows.map(row => this.runView(projectId, row));
    });
  }

  /** What a draft would do, without saving or running it. (`test` names a Workers event handler; RPC cannot call it.) */
  async testDraft(input: { projectId: string; draft: AutomationDraft; requestedBy: string }): Promise<AutomationOutcome<{ results: AutomationTestResult[]; instruction: string }>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const draft = checkDraft(input.draft);
      return dryRun(draft, await this.targetName(projectId, draft.action), input.requestedBy, Date.now());
    });
  }

  /** Only people change the limits; every automation of the project runs under them. */
  async updateSettings(input: { projectId: string; settings: AutomationSettings }): Promise<AutomationSettings> {
    const projectId = this.ensureProject(input.projectId);
    const settings = SettingsSchema.parse(input.settings);
    this.ctx.storage.sql.exec('INSERT INTO automation_settings(id, concurrency, daily_run_cap) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET concurrency=excluded.concurrency, daily_run_cap=excluded.daily_run_cap', settings.concurrency, settings.dailyRunCap);
    await this.changed(projectId);
    return this.settings();
  }

  /** The workspace's word on a run's turn. Idempotent: a report the workspace sends again changes nothing. */
  async runTurnChanged(raw: AutomationTurnReport): Promise<void> {
    const report = AutomationTurnReportSchema.parse(raw);
    const projectId = this.ensureProject(report.projectId);
    const run = report.requestId.startsWith(AUTOMATION_REQUEST_PREFIX) ? this.run(report.requestId.slice(AUTOMATION_REQUEST_PREFIX.length)) : undefined;
    if (!run || run.workspace_id !== report.workspaceId || run.state !== 'running') return;
    const now = Date.now();
    if (report.state === 'running') {
      if (run.started_at !== null) return;
      // A report proves the submission arrived, whatever became of the call that made it.
      this.ctx.storage.sql.exec('UPDATE automation_runs SET started_at=?, submitted=1, retry_at=NULL, timeline_json=? WHERE id=?', now, timelineWith(run, now, 'The agent started working'), run.id);
    } else {
      const end = TURN_END[report.outcome];
      this.finish(run, end.state, end.outcome(report.text), now, end.label);
    }
    await this.changed(projectId);
  }

  /** The project is deleted: its automations, runs and alarm go with it. */
  async erase(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const projectId = this.rows<{ project_id: string }>('SELECT project_id FROM automation_identity WHERE id=1')[0]?.project_id;
    if (projectId === undefined) return;
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const automation of this.rows<AutomationRow>('SELECT * FROM automations WHERE next_run_at <= ? ORDER BY next_run_at, id', now)) {
        if (automation.cron === null || automation.next_run_at === null) continue;
        this.recordRun(projectId, automation, { trigger: 'schedule', scheduledFor: automation.next_run_at }, now);
        this.ctx.storage.sql.exec('UPDATE automations SET next_run_at=? WHERE id=?', nextAutomationRunAt(automation.cron, now), automation.id);
      }
      for (const run of this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='queued' AND created_at <= ?", now - AUTOMATION_MAX_QUEUE_MS)) {
        this.finish(run, 'skipped', 'Skipped: waited more than a day for a slot', now);
      }
      const free = this.settings().concurrency - this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='running'");
      for (const run of free > 0 ? this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='queued' ORDER BY created_at, rowid LIMIT ?", free) : []) {
        this.ctx.storage.sql.exec("UPDATE automation_runs SET state='running', timeline_json=? WHERE id=?", timelineWith(run, now, `Sent to ${run.target_name}`), run.id);
      }
    });
    await this.submit(projectId);
    await this.changed(projectId);
  }

  /** Submits each run that holds a slot and has not reached its workspace. The request id makes a submission whose
   * reply was lost, or one resumed after a restart, deliver its message once. */
  private async submit(projectId: string): Promise<void> {
    const due = this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='running' AND submitted=0 AND (retry_at IS NULL OR retry_at <= ?)", Date.now());
    await Promise.all(due.map(async run => {
      try {
        await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${run.workspace_id}`)
          .runtimeAutomationSubmit({ projectId, workspaceId: run.workspace_id, requestId: `${AUTOMATION_REQUEST_PREFIX}${run.id}`, text: run.message });
        this.ctx.storage.sql.exec('UPDATE automation_runs SET submitted=1, retry_at=NULL WHERE id=?', run.id);
      } catch (error) {
        const current = this.run(run.id);
        if (current?.state !== 'running' || current.submitted === 1) return;
        const reason = error instanceof Error ? error.message : String(error);
        const delay = SUBMIT_RETRY_MS[current.attempts];
        const now = Date.now();
        if (delay === undefined) this.finish(current, 'failed', `Failed: could not reach ${current.target_name}: ${reason}`, now);
        else this.ctx.storage.sql.exec('UPDATE automation_runs SET attempts=attempts+1, retry_at=?, timeline_json=? WHERE id=?', now + delay, timelineWith(current, now, `Could not reach ${current.target_name} (${reason}); trying again`), current.id);
      }
    }));
  }

  /** Records a run: queued, or skipped when its automation's previous run still works or the daily cap is reached. */
  private recordRun(projectId: string, automation: AutomationRow, firing: Firing, now: number): string {
    const id = crypto.randomUUID();
    const scheduledFor = firing.trigger === 'schedule' ? firing.scheduledFor : now;
    const when = firing.trigger === 'schedule' ? { label: 'Scheduled for', detail: utcLabel(scheduledFor) } : { label: 'Started by', detail: firing.requestedBy };
    const values: Record<string, string> = firing.trigger === 'schedule'
      ? { 'automation.name': automation.name, scheduled_for: new Date(scheduledFor).toISOString() }
      : { 'automation.name': automation.name, requested_by: firing.requestedBy };
    const message = `Automation "${automation.name}" (${when.label.toLowerCase()} ${when.detail}):\n\n${renderAutomationInstruction(automation.instruction, values)}`;
    const today = this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id=? AND created_at >= ? AND state != 'skipped'", automation.id, utcDay(now));
    const skipped = this.activeRun(automation.id) ? 'Skipped: its previous run is still working'
      : today >= this.settings().dailyRunCap ? 'Skipped: daily run cap'
      : null;
    const timeline: Timeline = [{ at: now, label: `${when.label} ${when.detail}` }, { at: now, label: skipped ?? 'Queued' }];
    this.ctx.storage.sql.exec(`
      INSERT INTO automation_runs(id, automation_id, automation_name, trigger, state, workspace_id, target_name, message, outcome, timeline_json, scheduled_for, created_at, finished_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, automation.id, automation.name, firing.trigger, skipped === null ? 'queued' : 'skipped', automation.workspace_id ?? projectId, automation.target_name,
    message, skipped, JSON.stringify(timeline), scheduledFor, now, skipped === null ? null : now);
    this.ctx.storage.sql.exec(`
      DELETE FROM automation_runs WHERE automation_id=? AND state IN ('finished', 'skipped', 'failed')
        AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)
    `, automation.id, automation.id, KEPT_RUNS);
    return id;
  }

  private finish(run: RunRow, state: 'finished' | 'skipped' | 'failed', outcome: string, now: number, label: string = outcome): void {
    this.ctx.storage.sql.exec('UPDATE automation_runs SET state=?, outcome=?, finished_at=?, retry_at=NULL, timeline_json=? WHERE id=?', state, outcome, now, timelineWith(run, now, label), run.id);
  }

  /** Writes a checked draft over automation `id`, or as a new automation; returns its id. */
  private save(input: { projectId: string; id: string | null; draft: AutomationDraft; targetName: string; proposal: StoredProposal | null; createdBy: 'person' | 'projectAgent' }): string {
    const { draft } = input;
    const now = Date.now();
    const cron = draft.trigger.kind === 'schedule' ? draft.trigger.cron : null;
    const workspaceId = draft.action.kind === 'messageWorkspace' ? draft.action.workspaceId : null;
    const enabled = input.proposal === null && draft.enabled;
    const nextRunAt = cron !== null && enabled ? nextAutomationRunAt(cron, now) : null;
    const proposal = input.proposal === null ? null : JSON.stringify(input.proposal);
    return this.ctx.storage.transactionSync(() => {
      if (this.rows('SELECT id FROM automations WHERE name=? AND id IS NOT ?', draft.name, input.id).length > 0) refuse('name', `An automation named "${draft.name}" already exists`);
      if (input.id === null) {
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec(`
          INSERT INTO automations(id, revision, name, cron, workspace_id, target_name, instruction, enabled, created_by, proposal_json, next_run_at, created_at, updated_at)
          VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, id, draft.name, cron, workspaceId, input.targetName, draft.action.instruction, enabled ? 1 : 0, input.createdBy, proposal, nextRunAt, now, now);
        return id;
      }
      this.ctx.storage.sql.exec(`
        UPDATE automations SET revision=revision+1, name=?, cron=?, workspace_id=?, target_name=?, instruction=?, enabled=?, proposal_json=?, next_run_at=?, updated_at=?
        WHERE id=?
      `, draft.name, cron, workspaceId, input.targetName, draft.action.instruction, enabled ? 1 : 0, proposal, nextRunAt, now, input.id);
      return input.id;
    });
  }

  /** The name runs show for an action's target; a workspace must be an active workspace of the project. */
  private async targetName(projectId: string, action: AutomationAction): Promise<string> {
    if (action.kind === 'messageProjectAgent') return 'the project agent';
    const workspace = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getWorkspace(action.workspaceId);
    if (!workspace || workspace.kind !== 'worktree') refuse('action.workspaceId', `Workspace ${action.workspaceId} is not a workspace of this project`);
    if (workspace.lifecycle !== 'active') refuse('action.workspaceId', `Workspace ${workspace.name} is ${workspace.lifecycle}; choose an active workspace`);
    return workspace.name;
  }

  /** Sets the one alarm to the earliest deadline the work names, or now for a run that holds a slot and has not been
   * submitted (a restart resumes it) or a queued run with a free slot. */
  private async reschedule(): Promise<void> {
    const now = Date.now();
    const working = this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='running'");
    const immediate = this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='running' AND submitted=0 AND retry_at IS NULL") > 0
      || (working < this.settings().concurrency && this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='queued'") > 0);
    const due = immediate ? now : this.rows<{ at: number | null }>(`
      SELECT MIN(at) AS at FROM (
        SELECT MIN(next_run_at) AS at FROM automations
        UNION ALL SELECT MIN(retry_at) FROM automation_runs WHERE state='running' AND submitted=0
        UNION ALL SELECT MIN(created_at) + ? FROM automation_runs WHERE state='queued'
      )
    `, AUTOMATION_MAX_QUEUE_MS)[0]?.at ?? null;
    if (due === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(due);
  }

  /** After every change: the alarm follows the work, the account index gets the project's counts and newest runs (the
   * overview reads only those), and open tabs refetch. */
  private async changed(projectId: string): Promise<void> {
    await this.reschedule();
    const now = Date.now();
    const day = utcDay(now);
    const summary: AutomationProjectSummary = {
      projectId,
      total: this.count('SELECT COUNT(*) AS count FROM automations'),
      on: this.count('SELECT COUNT(*) AS count FROM automations WHERE enabled=1 AND proposal_json IS NULL'),
      proposed: this.count('SELECT COUNT(*) AS count FROM automations WHERE proposal_json IS NOT NULL'),
      working: this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='running'"),
      queued: this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='queued'"),
      failedToday: this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='failed' AND finished_at >= ?", day),
    };
    const runs = this.rows<RunRow>('SELECT * FROM automation_runs ORDER BY created_at DESC, rowid DESC LIMIT ?', INDEXED_RUNS).map(row => runRecord(projectId, row));
    try { await this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).setAutomationSummary({ summary, day, runs }); }
    catch (error) { console.error(JSON.stringify({ event: 'automation_summary_unsent', projectId, error: error instanceof Error ? error.message : String(error) })); }
    await notifyBrowsers(this.env, [{ ...accountLiveKey('automations'), version: now }]);
  }

  private ensureProject(projectIdInput: string): string {
    const projectId = z.string().regex(/^[A-Za-z0-9._:-]{1,160}$/u).parse(projectIdInput);
    const stored = this.rows<{ project_id: string }>('SELECT project_id FROM automation_identity WHERE id=1')[0];
    if (!stored) this.ctx.storage.sql.exec('INSERT INTO automation_identity(id, project_id) VALUES(1, ?)', projectId);
    else if (stored.project_id !== projectId) throw new Error(`These automations belong to project ${stored.project_id}, not ${projectId}`);
    return projectId;
  }

  private settings(): AutomationSettings {
    const row = this.rows<{ concurrency: number; daily_run_cap: number }>('SELECT concurrency, daily_run_cap FROM automation_settings WHERE id=1')[0];
    return row ? { concurrency: row.concurrency, dailyRunCap: row.daily_run_cap } : AUTOMATION_DEFAULT_SETTINGS;
  }

  private automationView(projectId: string, row: AutomationRow): AutomationView {
    const last = this.rows<{ state: AutomationRunState; at: number }>('SELECT state, COALESCE(finished_at, started_at, created_at) AS at FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', row.id)[0];
    const proposal = row.proposal_json === null ? null : ProposalSchema.parse(JSON.parse(row.proposal_json));
    return {
      id: row.id,
      projectId,
      revision: row.revision,
      name: row.name,
      trigger: row.cron === null ? { kind: 'manual' } : { kind: 'schedule', cron: row.cron },
      action: row.workspace_id === null ? { kind: 'messageProjectAgent', instruction: row.instruction } : { kind: 'messageWorkspace', workspaceId: row.workspace_id, instruction: row.instruction },
      enabled: row.enabled === 1,
      createdBy: row.created_by,
      proposal: proposal === null ? null : { ...proposal, proposedAt: new Date(proposal.proposedAt) },
      nextRunAt: row.next_run_at === null ? null : new Date(row.next_run_at),
      lastRun: last ? { at: new Date(last.at), state: last.state } : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private runView(projectId: string, row: RunRow): AutomationRunView {
    return automationRunView(runRecord(projectId, row));
  }

  private requiredAutomation(automationId: string): AutomationRow {
    const row = this.rows<AutomationRow>('SELECT * FROM automations WHERE id=?', automationId)[0];
    if (!row) throw new AutomationRefusal({ kind: 'notFound', automationId });
    return row;
  }

  private activeRun(automationId: string): RunRow | undefined {
    return this.rows<RunRow>("SELECT * FROM automation_runs WHERE automation_id=? AND state IN ('queued', 'running') ORDER BY created_at LIMIT 1", automationId)[0];
  }

  private run(runId: string): RunRow | undefined {
    return this.rows<RunRow>('SELECT * FROM automation_runs WHERE id=?', runId)[0];
  }

  private requiredRun(runId: string): RunRow {
    const row = this.run(runId);
    if (!row) throw new AutomationRefusal({ kind: 'runNotFound', runId });
    return row;
  }

  private count(query: string, ...bindings: SqlStorageValue[]): number {
    return this.rows<{ count: number }>(query, ...bindings)[0]?.count ?? 0;
  }

  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }
}

function timelineWith(run: RunRow, at: number, label: string): string {
  return JSON.stringify([...TimelineSchema.parse(JSON.parse(run.timeline_json)), { at, label }]);
}

function runRecord(projectId: string, row: RunRow): AutomationRunRecord {
  return {
    id: row.id,
    projectId,
    automationId: row.automation_id,
    automationName: row.automation_name,
    trigger: row.trigger,
    state: row.state,
    workspaceId: row.workspace_id,
    outcome: row.outcome,
    timeline: TimelineSchema.parse(JSON.parse(row.timeline_json)),
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** What a draft would do: for a schedule its next three run times, for manual that it runs only when started; and its
 * instruction rendered with sample values. */
function dryRun(draft: AutomationDraft, targetName: string, requestedBy: string, now: number): { results: AutomationTestResult[]; instruction: string } {
  const values: Record<string, string> = { 'automation.name': draft.name, requested_by: requestedBy };
  if (draft.trigger.kind === 'manual') {
    return { results: [{ label: 'Manual', result: 'Runs only when someone starts it', runs: false }], instruction: renderAutomationInstruction(draft.action.instruction, values) };
  }
  const times: number[] = [];
  for (let after = now; times.length < 3;) {
    after = nextAutomationRunAt(draft.trigger.cron, after);
    times.push(after);
  }
  return {
    results: times.map(at => ({ label: utcLabel(at), result: `Would message ${targetName}`, runs: true })),
    instruction: renderAutomationInstruction(draft.action.instruction, { 'automation.name': draft.name, scheduled_for: new Date(times[0] ?? now).toISOString() }),
  };
}
