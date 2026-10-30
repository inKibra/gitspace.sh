import {
  AUTOMATION_DEFAULT_SETTINGS,
  AUTOMATION_EVENT_ACTIONS,
  AUTOMATION_EVENT_LABEL,
  AUTOMATION_MAX_QUEUE_MS,
  AUTOMATION_MODES,
  AUTOMATION_START_LABELS,
  AUTOMATION_WATCH_EVERY_MS,
  AUTOMATION_WATCH_LABEL,
  AutomationActionSchema,
  AutomationConditionSchema,
  AutomationSubjectSchema,
  AutomationTriggerSchema,
  automationConditionKinds,
  automationFields,
  automationSubjectKey,
  automationSubjectName,
  nextAutomationRunAt,
  parseAutomationSchedule,
  renderAutomationInstruction,
  unknownAutomationPlaceholders,
  type AutomationAction,
  type AutomationCheck,
  type AutomationCondition,
  type AutomationDraft,
  type AutomationLinkSource,
  type AutomationLinkView,
  type AutomationMode,
  type AutomationProjectSummary,
  type AutomationRecordedEvent,
  type AutomationRunState,
  type AutomationRunView,
  type AutomationSettings,
  type AutomationSubject,
  type AutomationSubjectRef,
  type AutomationTest,
  type AutomationTestResult,
  type AutomationTrigger,
  type AutomationView,
} from '@gitspace/protocol/automations-contract';
import { githubRepositoryOf } from '@gitspace/protocol/github';
import { BUILT_IN_MODEL_ROLES, MODEL_ROLE_LABELS } from '@gitspace/protocol/inference';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { cloudResourceId, type CloudWorkspaceDefinition } from '@gitspace/protocol/project-authority';
import { profileModelRoles } from '@gitspace/runtime-core/inference';
import { z } from 'zod';
import { AutomationEventSchema, automationEventName, describeAutomationEvent, globMatches, triggerMatches, watchedEvent, type AutomationEvent } from './automation-events.js';
import { createCloudWorkspace, restoreCloudWorkspace, retryCloudWorkspaceCreation } from './cloud-workspace-lifecycle.js';
import { notifyBrowsers } from './live-notices.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

const DAY_MS = 24 * 60 * 60_000;
/** Runs kept per automation; older ended ones are deleted as new ones are recorded. */
const KEPT_RUNS = 200;
/** The newest runs each project pushes to the account index for the overview. */
const INDEXED_RUNS = 20;
/** A run whose message cannot reach its workspace (or whose workspace cannot be started) is tried again after each of
 * these delays, then fails. */
const SUBMIT_RETRY_MS: readonly number[] = [30_000, 2 * 60_000, 10 * 60_000];
const MAX_NAME = 120;
const MAX_INSTRUCTION = 16_000;
/** Recorded deliveries a test without a chosen one reads, and the matching ones it shows. */
const TESTED_DELIVERIES = 50;
const TESTED_EVENTS = 5;
const MAX_TRUSTED = 200;
/** Seen releases, tags and deployments a watch keeps; tag lists are not ordered by time, so a bounded set is kept. */
const WATCH_SEEN_KEPT = 500;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/u;
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
const ChecksSchema = z.array(z.object({ label: z.string(), passed: z.boolean().nullable() }));

/** A run as the account index keeps it, times in epoch milliseconds. Runs indexed before GitHub events existed have no
 * event, subject or checks. */
export const AutomationRunRecordSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  automationId: z.string(),
  automationName: z.string(),
  trigger: z.enum(['schedule', 'manual', 'github', 'label']),
  event: z.string().nullable().default(null),
  subject: AutomationSubjectSchema.nullable().default(null),
  state: z.enum(['queued', 'running', 'finished', 'skipped', 'failed']),
  workspaceId: z.string().nullable(),
  outcome: z.string().nullable(),
  checks: ChecksSchema.default([]),
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

const SettingsSchema = z.object({
  concurrency: z.number().int().min(1).max(10),
  dailyRunCap: z.number().int().min(1).max(1000),
  trusted: z.array(z.string().trim().transform(login => login.replace(/^@/u, '')).pipe(z.string().regex(GITHUB_LOGIN, 'A trusted author is a GitHub login'))).max(MAX_TRUSTED),
});

/** What a workspace started for a subject is: its name and branch, mode, model role, source and the subject it is
 * linked to. */
const StartSchema = z.object({
  name: z.string(),
  mode: z.enum(AUTOMATION_MODES),
  /** The model role its first run uses; null (and runs recorded before roles) the profile's default role. */
  role: z.string().nullable().default(null),
  sourceKind: z.enum(['base', 'branch', 'pull-request']),
  sourceRef: z.string(),
  subject: AutomationSubjectSchema,
  /** How the link reads: the automation, and the label that started it. */
  detail: z.string(),
  /** The workspace exists and is linked. */
  created: z.boolean(),
});
type Start = z.infer<typeof StartSchema>;

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

const MODE_LABEL: Record<AutomationMode, string> = { plan: 'Plan', code: 'Code', review: 'Review', ship: 'Ship' };
const LINK_LABEL: Record<AutomationLinkSource, string> = { person: 'linked by a person', agent: 'linked by an agent', started: 'started for it', branch: 'same branch', closes: 'closed by its pull request' };
/** A stronger link replaces a weaker one (docs/AUTOMATIONS-DESIGN.md §4). */
const LINK_STRENGTH: Record<AutomationLinkSource, number> = { person: 3, agent: 3, started: 2, branch: 1, closes: 1 };

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

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A draft with its name, values and schedule normalized, or the field that refuses it. */
function checkDraft(draft: AutomationDraft): AutomationDraft {
  const name = draft.name.trim();
  if (name.length === 0 || name.length > MAX_NAME) refuse('name', `Name must be 1 to ${MAX_NAME} characters`);
  let trigger: AutomationTrigger = draft.trigger;
  if (trigger.kind === 'schedule') {
    const cron = trigger.cron.trim().split(/\s+/u).join(' ');
    const parsed = parseAutomationSchedule(cron);
    if ('error' in parsed) refuse('trigger.cron', parsed.error);
    trigger = { kind: 'schedule', cron };
  }
  if (trigger.kind === 'github') {
    const events = trigger.events.map(entry => ({ event: entry.event, actions: [...new Set(entry.actions)] }));
    if (new Set(events.map(entry => entry.event)).size !== events.length) refuse('trigger.events', 'Choose each event once');
    for (const entry of events) {
      const known = AUTOMATION_EVENT_ACTIONS[entry.event];
      const unknown = entry.actions.filter(action => !known.includes(action));
      if (known.length === 0 && entry.actions.length > 0) refuse('trigger.events', `${AUTOMATION_EVENT_LABEL[entry.event]} has no actions to choose; it runs on every one`);
      if (known.length > 0 && entry.actions.length === 0) refuse('trigger.events', `Choose at least one ${AUTOMATION_EVENT_LABEL[entry.event].toLowerCase()} action: ${known.join(', ')}`);
      if (unknown.length > 0) refuse('trigger.events', `${unknown.join(', ')} ${unknown.length === 1 ? 'is not an action' : 'are not actions'} of ${entry.event}; choose from ${known.join(', ')}`);
    }
    trigger = { kind: 'github', events };
  }
  const offered = automationConditionKinds(trigger);
  const conditions = draft.conditions.map((condition): AutomationCondition => 'values' in condition ? { ...condition, values: [...new Set(condition.values.map(value => value.trim()).filter(Boolean))] } : condition);
  for (const condition of conditions) {
    if (!offered.includes(condition.kind)) refuse('conditions', offered.length === 0 ? 'Conditions apply only to GitHub events' : `${condition.kind} is not a condition of these events; they offer ${offered.join(', ')}`);
    if ('values' in condition && condition.values.length === 0) refuse('conditions', `Give ${condition.kind} at least one value`);
  }
  if (new Set(conditions.map(condition => condition.kind)).size !== conditions.length) refuse('conditions', 'Use each condition once');
  const { action } = draft;
  const event = trigger.kind === 'github' || trigger.kind === 'label';
  if (action.kind === 'sendToLinked' && !event) refuse('action.kind', 'Sending to the linked workspace needs a GitHub event or label: a schedule, manual run or watched repository has no pull request or issue');
  if (action.kind === 'startWorkspace' && !event && trigger.kind !== 'watch') refuse('action.kind', 'Starting a workspace needs a GitHub event, a label or a watched repository: a schedule or manual run starts none');
  if (action.kind === 'startWorkspace' && action.mode === null && trigger.kind !== 'label') refuse('action.mode', 'Choose the mode the workspace starts in; only a label trigger starts in the label\'s mode');
  if (action.instruction.trim().length === 0 || action.instruction.length > MAX_INSTRUCTION) refuse('action.instruction', `Instruction must be 1 to ${MAX_INSTRUCTION.toLocaleString('en-US')} characters`);
  const unknown = unknownAutomationPlaceholders(action.instruction, trigger);
  if (unknown.length > 0) {
    const fields = automationFields(trigger).map(field => `{{${field.path}}}`).join(', ');
    refuse('action.instruction', `${unknown.map(path => `{{${path}}}`).join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of this trigger; it provides ${fields}`);
  }
  return { name, trigger, conditions, action, enabled: draft.enabled };
}

/** The GitSpace project's release automation (docs/TENANT-RELEASES-DESIGN.md §5): GitSpace's releases go to its project
 * agent, which asks how to take each one. `repository` null watches the project's repository, or its upstream parent
 * when the project builds a fork, so it follows the project wherever Project settings point it. */
export const GITSPACE_RELEASES_AUTOMATION: AutomationDraft = {
  name: 'GitSpace releases', enabled: true,
  trigger: { kind: 'watch', repository: null, on: 'release', every: 'daily' },
  conditions: [{ kind: 'tag', mode: 'oneOf', values: ['v*'] }],
  action: {
    kind: 'messageProjectAgent',
    instruction: [
      'GitSpace {{release.tag}} is published: {{release.url}}',
      'Read this project\'s repository and base branch, and gitspace_deployment_status for what this account runs and its default release. From the release notes, say in a few lines what changes from the default.',
      'Then ask me with a question card. If this project\'s repository is inKibra/gitspace.sh: update this account to {{release.tag}}? Options: Launch it now (gitspace_deployment_launchPublished with tag {{release.tag}}; nothing is built), Not now, Skip this release. If it is a fork: bring {{release.tag}} into its base branch? Options: Merge it in a workspace and open a pull request, Not now, Skip this release; once that pull request is merged, ask whether to build and launch the branch.',
      'If I skipped {{release.tag}} earlier in this conversation, do not ask again.',
    ].join('\n\n'),
  },
};

/** The default automations installing the GitHub App adds (docs/AUTOMATIONS-DESIGN.md §4), by key. */
function defaultAutomations(bot: string): Array<{ key: string; draft: AutomationDraft }> {
  return [
    { key: 'review-feedback', draft: {
      name: 'Review feedback to its workspace', enabled: true,
      trigger: { kind: 'github', events: [{ event: 'pull_request_review', actions: ['submitted'] }, { event: 'pull_request_review_comment', actions: ['created'] }] },
      conditions: [{ kind: 'linked', linked: true }, { kind: 'author', mode: 'noneOf', values: ['*[bot]'] }],
      action: { kind: 'sendToLinked', wake: true, orProjectAgent: false, instruction: 'A person reviewed this workspace\'s pull request or commented on it. Read the feedback and address it.' },
    } },
    { key: 'failed-checks', draft: {
      name: 'Failed checks to its workspace', enabled: true,
      trigger: { kind: 'github', events: [{ event: 'check_suite', actions: ['completed'] }] },
      conditions: [{ kind: 'linked', linked: true }, { kind: 'conclusion', values: ['failure', 'timed_out'] }],
      action: { kind: 'sendToLinked', wake: true, orProjectAgent: false, instruction: 'Checks failed on this workspace\'s branch. Find out why and fix it.' },
    } },
    { key: 'mentions', draft: {
      name: `Mentions of ${bot}`, enabled: true,
      trigger: { kind: 'github', events: [{ event: 'issue_comment', actions: ['created'] }, { event: 'pull_request_review_comment', actions: ['created'] }, { event: 'pull_request_review', actions: ['submitted'] }] },
      conditions: [{ kind: 'mentionsBot' }],
      action: { kind: 'sendToLinked', wake: true, orProjectAgent: true, instruction: `Someone mentioned ${bot} on GitHub. Read the comment and do what it asks. If it has no linked workspace and needs one, start or link one.` },
    } },
    { key: 'closed', draft: {
      name: 'Merged or closed', enabled: true,
      trigger: { kind: 'github', events: [{ event: 'pull_request', actions: ['closed'] }, { event: 'issues', actions: ['closed'] }] },
      conditions: [{ kind: 'linked', linked: true }],
      action: { kind: 'sendToLinked', wake: false, orProjectAgent: false, instruction: 'It was merged or closed. This workspace stays open.' },
    } },
  ];
}

interface AutomationRow extends Record<string, SqlStorageValue> {
  id: string;
  revision: number;
  name: string;
  trigger_json: string;
  conditions_json: string;
  action_json: string;
  /** A schedule trigger's expression; null for every other trigger. */
  cron: string | null;
  /** The workspace a message action names, as runs show it. */
  target_name: string;
  enabled: number;
  created_by: 'person' | 'projectAgent';
  /** Which default automation it is; null for every other. */
  default_key: string | null;
  proposal_json: string | null;
  /** Set only while the automation runs on a schedule: enabled and not proposed. */
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

/** A run that holds a slot while its agent works (`message`, `start`), or a notice that wakes no agent. */
type RunKind = 'message' | 'start' | 'notice';

interface RunRow extends Record<string, SqlStorageValue> {
  id: string;
  automation_id: string;
  automation_name: string;
  trigger: 'schedule' | 'manual' | 'github' | 'label';
  kind: RunKind;
  /** `pull_request.opened`; null for a schedule or manual run. */
  event: string | null;
  subject_json: string | null;
  /** The event as conditions and instructions read it. */
  event_json: string | null;
  checks_json: string;
  /** A `start` run's workspace (`Start`). */
  start_json: string | null;
  state: AutomationRunState;
  /** Null until it has a target; a `start` run's is chosen when it is recorded. */
  workspace_id: string | null;
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

interface LinkRow extends Record<string, SqlStorageValue> {
  subject_key: string;
  subject_json: string;
  workspace_id: string;
  source: AutomationLinkSource;
  detail: string;
  linked_at: number;
  activity_label: string | null;
  activity_at: number | null;
}

interface Automation {
  id: string;
  name: string;
  trigger: AutomationTrigger;
  conditions: AutomationCondition[];
  action: AutomationAction;
  targetName: string;
}

type Firing =
  | { trigger: 'schedule'; scheduledFor: number }
  | { trigger: 'manual'; requestedBy: string }
  | { trigger: 'event'; event: AutomationEvent; replayedBy: string | null };

/** The workspace an event's subject reaches, and how. */
interface LinkedTarget { workspaceId: string; name: string; source: AutomationLinkSource; detail: string }

/** What one automation does with one firing, before it is recorded. */
interface RunPlan {
  checks: AutomationCheck[];
  /** Why it does not run ("Skipped: …" or "Failed: …"), or null. */
  ended: { state: 'skipped' | 'failed'; outcome: string } | null;
  kind: RunKind;
  workspaceId: string | null;
  targetName: string;
  message: string;
  start: Start | null;
  /** Timeline entries after the firing's own. */
  timeline: string[];
  /** What a test says it would do. */
  would: string;
  /** A send to a linked workspace: later automations matching the same delivery do not send to it again. */
  sendsTo: string | null;
}

/** What evaluating one event reads at most once, whatever number of automations match it. */
interface EventContext {
  event: AutomationEvent;
  bot: string | null;
  trust(): Promise<{ trusted: boolean; label: string } | { error: string }>;
  linked(): Promise<LinkedTarget | null>;
  changedFiles(): Promise<string[]>;
  /** Linked workspaces this delivery was already sent to, with the automation that sent it. */
  sentTo: Map<string, string>;
}

/** Remembers one call's promise: the first call runs it. */
function once<T>(work: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => pending ??= work();
}

/**
 * One project's automations (docs/AUTOMATIONS-DESIGN.md §4–§7): their definitions, runs, limits and trust list, and the
 * links between the project's pull requests, issues and branches and its workspaces. The GitHub App sends each delivery
 * for the project's repository here (`receive`). One alarm drives schedules and the queue; it is set only for a
 * deadline the work names (the next schedule time, a queued run's expiry, a retry) or to resume a run that holds a slot
 * but was not yet submitted. A submitted run learns its turn started and ended from its workspace (`runTurnChanged`),
 * never by asking.
 */
export class ProjectAutomationsDO extends BudgetedDurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS automation_identity(id INTEGER PRIMARY KEY CHECK (id = 1), project_id TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS automation_settings(id INTEGER PRIMARY KEY CHECK (id = 1), concurrency INTEGER NOT NULL, daily_run_cap INTEGER NOT NULL, defaults_added INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS automation_trusted(login TEXT PRIMARY KEY COLLATE NOCASE);
        CREATE TABLE IF NOT EXISTS automations(
          id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL,
          name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          trigger_json TEXT NOT NULL,
          conditions_json TEXT NOT NULL,
          action_json TEXT NOT NULL,
          cron TEXT,
          target_name TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_by TEXT NOT NULL CHECK (created_by IN ('person', 'projectAgent')),
          default_key TEXT,
          proposal_json TEXT,
          next_run_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS automation_runs(
          id TEXT PRIMARY KEY,
          automation_id TEXT NOT NULL,
          automation_name TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'github', 'label')),
          kind TEXT NOT NULL CHECK (kind IN ('message', 'start', 'notice')),
          event TEXT,
          subject_json TEXT,
          event_json TEXT,
          checks_json TEXT NOT NULL,
          start_json TEXT,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'skipped', 'failed')),
          workspace_id TEXT,
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
        CREATE TABLE IF NOT EXISTS automation_links(
          subject_key TEXT PRIMARY KEY,
          subject_json TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('person', 'agent', 'started', 'branch', 'closes')),
          detail TEXT NOT NULL,
          linked_at INTEGER NOT NULL,
          activity_label TEXT,
          activity_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS automation_watches(
          automation_id TEXT PRIMARY KEY,
          trigger_json TEXT NOT NULL,
          repository TEXT,
          next_check_at INTEGER NOT NULL,
          baseline INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS automation_watch_seen(
          automation_id TEXT NOT NULL,
          key TEXT NOT NULL,
          seen_at INTEGER NOT NULL,
          PRIMARY KEY (automation_id, key)
        );
        CREATE TABLE IF NOT EXISTS automation_defaults_offered(key TEXT PRIMARY KEY);
      `);
    });
  }

  /** Objects written before GitHub events: their automations kept a schedule and a message target in columns, and their
   * runs table refused event triggers. */
  private migrate(): void {
    const sql = this.ctx.storage.sql;
    const columns = (table: string) => sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(column => column.name);
    const settings = columns('automation_settings');
    if (settings.length > 0 && !settings.includes('defaults_added')) sql.exec('ALTER TABLE automation_settings ADD COLUMN defaults_added INTEGER NOT NULL DEFAULT 0');
    if (columns('automations').includes('instruction')) {
      this.ctx.storage.transactionSync(() => sql.exec(`
        ALTER TABLE automations ADD COLUMN trigger_json TEXT;
        ALTER TABLE automations ADD COLUMN conditions_json TEXT;
        ALTER TABLE automations ADD COLUMN action_json TEXT;
        ALTER TABLE automations ADD COLUMN default_key TEXT;
        UPDATE automations SET conditions_json='[]',
          trigger_json=CASE WHEN cron IS NULL THEN json_object('kind', 'manual') ELSE json_object('kind', 'schedule', 'cron', cron) END,
          action_json=CASE WHEN workspace_id IS NULL THEN json_object('kind', 'messageProjectAgent', 'instruction', instruction)
            ELSE json_object('kind', 'messageWorkspace', 'workspaceId', workspace_id, 'instruction', instruction) END;
        ALTER TABLE automations DROP COLUMN workspace_id;
        ALTER TABLE automations DROP COLUMN instruction;
      `));
    }
    const runs = columns('automation_runs');
    if (runs.length > 0 && !runs.includes('kind')) {
      this.ctx.storage.transactionSync(() => sql.exec(`
        DROP INDEX IF EXISTS automation_runs_automation;
        DROP INDEX IF EXISTS automation_runs_state;
        ALTER TABLE automation_runs RENAME TO automation_runs_schedules;
        CREATE TABLE automation_runs(
          id TEXT PRIMARY KEY, automation_id TEXT NOT NULL, automation_name TEXT NOT NULL,
          trigger TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual', 'github', 'label')),
          kind TEXT NOT NULL CHECK (kind IN ('message', 'start', 'notice')),
          event TEXT, subject_json TEXT, event_json TEXT, checks_json TEXT NOT NULL, start_json TEXT,
          state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'finished', 'skipped', 'failed')),
          workspace_id TEXT, target_name TEXT NOT NULL, message TEXT NOT NULL, outcome TEXT, timeline_json TEXT NOT NULL,
          scheduled_for INTEGER NOT NULL, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
          submitted INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER
        );
        INSERT INTO automation_runs(id, automation_id, automation_name, trigger, kind, checks_json, state, workspace_id, target_name, message, outcome, timeline_json, scheduled_for, created_at, started_at, finished_at, submitted, attempts, retry_at)
          SELECT id, automation_id, automation_name, trigger, 'message', '[]', state, workspace_id, target_name, message, outcome, timeline_json, scheduled_for, created_at, started_at, finished_at, submitted, attempts, retry_at FROM automation_runs_schedules;
        DROP TABLE automation_runs_schedules;
      `));
    }
  }

  /** The project's automations, the limits and trust list they run under, its subject links, and the model roles a
   * started workspace may run as. */
  async list(projectIdInput: string): Promise<{ automations: AutomationView[]; settings: AutomationSettings; links: AutomationLinkView[]; modelRoles: string[] }> {
    const projectId = this.ensureProject(projectIdInput);
    return {
      automations: this.rows<AutomationRow>('SELECT * FROM automations ORDER BY name, id').map(row => this.automationView(projectId, row)),
      settings: this.settings(),
      links: this.rows<LinkRow>('SELECT * FROM automation_links ORDER BY COALESCE(activity_at, linked_at) DESC, subject_key').map(linkView),
      modelRoles: await this.modelRoles(projectId),
    };
  }

  /** A person's automation: it takes effect at once. */
  async create(input: { projectId: string; draft: AutomationDraft }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const draft = checkDraft(input.draft);
      const id = this.save({ id: null, draft, targetName: await this.targetName(projectId, draft.action), proposal: null, createdBy: 'person', defaultKey: null });
      await this.changed(projectId);
      return this.automationView(projectId, this.requiredAutomation(id));
    });
  }

  /** A person's change: it takes effect at once and clears a proposal. */
  async update(input: { projectId: string; automationId: string; draft: AutomationDraft }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const current = this.requiredAutomation(input.automationId);
      const draft = checkDraft(input.draft);
      this.save({ id: input.automationId, draft, targetName: await this.targetName(projectId, draft.action), proposal: null, createdBy: 'person', defaultKey: current.default_key });
      await this.changed(projectId);
      return this.automationView(projectId, this.requiredAutomation(input.automationId));
    });
  }

  /** The project agent's automation, new or a change to one: it is Proposed and does not run until a person approves
   * it. Its test is kept with it: the coming schedule times, or what it would do with recent recorded events. */
  async propose(input: { projectId: string; automationId?: string; draft: AutomationDraft; conversationId: string; asked: string; reason: string }): Promise<AutomationOutcome<AutomationView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const current = input.automationId === undefined ? null : this.requiredAutomation(input.automationId);
      const draft = checkDraft({ ...input.draft, enabled: false });
      const targetName = await this.targetName(projectId, draft.action);
      const now = Date.now();
      const tested = draft.trigger.kind === 'schedule' || draft.trigger.kind === 'manual' ? dryRun(draft, targetName, 'a person', now).results
        : [...(await this.eventTest(projectId, { ...draft, targetName, id: '' }, null).catch((error: unknown) => ({ results: [{ label: 'Recorded events', result: `Not tested: ${errorMessage(error)}`, runs: false }] }))).results];
      const proposal = { conversationId: input.conversationId, asked: input.asked, reason: input.reason, tested, proposedAt: now };
      const id = this.save({ id: input.automationId ?? null, draft, targetName, proposal, createdBy: 'projectAgent', defaultKey: current?.default_key ?? null });
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

  /** A person starts one run now of a schedule or manual automation, or of a watch on what its repository published
   * last; a proposal never runs. An automation that runs on GitHub events runs on one with `runOnEvent`. */
  async runNow(input: { projectId: string; automationId: string; requestedBy: string }): Promise<AutomationOutcome<AutomationRunView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const row = this.requiredAutomation(input.automationId);
      if (row.proposal_json !== null) refuse('proposal', 'Approve this automation before it runs');
      const automation = this.automation(row);
      if (automation.trigger.kind === 'github' || automation.trigger.kind === 'label') refuse('trigger', 'This automation runs on GitHub events: test it with a past event, then choose Run it');
      const active = this.activeRun(automation.id);
      if (active) throw new AutomationRefusal({ kind: 'alreadyRunning', automationId: automation.id, runId: active.id });
      const now = Date.now();
      let runId: string;
      if (automation.trigger.kind === 'watch') {
        const [event] = await this.watchedEvents(projectId, automation.trigger, 1);
        if (!event) refuse('trigger', `${await this.watchedRepository(projectId, automation.trigger)} has published no ${AUTOMATION_WATCH_LABEL[automation.trigger.on].toLowerCase()} yet`);
        const plan = await this.evaluate(projectId, automation, this.eventContext(projectId, event, await this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID).botHandle()));
        runId = this.ctx.storage.transactionSync(() => this.recordRun(automation, { trigger: 'event', event, replayedBy: input.requestedBy }, plan, now));
      } else {
        const firing: Firing = { trigger: 'manual', requestedBy: input.requestedBy };
        runId = this.ctx.storage.transactionSync(() => this.recordRun(automation, firing, this.messagePlan(projectId, automation, firing), now));
      }
      await this.changed(projectId);
      return this.runView(projectId, this.requiredRun(runId));
    });
  }

  /** Run it: a saved automation acts once on a recorded delivery, its trust and conditions checked as on arrival. */
  async runOnEvent(input: { projectId: string; automationId: string; deliveryId: string; requestedBy: string }): Promise<AutomationOutcome<AutomationRunView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const row = this.requiredAutomation(input.automationId);
      if (row.proposal_json !== null) refuse('proposal', 'Approve this automation before it runs');
      const automation = this.automation(row);
      const event = await this.recordedEvent(projectId, input.deliveryId);
      if (!triggerMatches(automation.trigger, event)) refuse('deliveryId', `${automation.name} does not run on ${automationEventName(event)}`);
      const context = this.eventContext(projectId, event, await this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID).botHandle());
      const plan = await this.evaluate(projectId, automation, context);
      const runId = this.ctx.storage.transactionSync(() => this.recordRun(automation, { trigger: 'event', event, replayedBy: input.requestedBy }, plan, Date.now()));
      await this.changed(projectId);
      return this.runView(projectId, this.requiredRun(runId));
    });
  }

  /** A GitHub delivery: for this project's repository, or a release, tag or deployment of any repository (a watch may
   * name any). Links by branch first, then every switched-on automation whose trigger starts on it records a run, skipped
   * ones included; a watch records each release, tag or deployment it has seen, so one a check also finds runs once.
   * Returns the number of runs recorded. */
  async receive(input: { projectId: string; event: AutomationEvent; bot: string | null }): Promise<number> {
    const projectId = this.ensureProject(input.projectId);
    const event = AutomationEventSchema.parse(input.event);
    const own = (await this.repository(projectId))?.toLowerCase() === event.repository.toLowerCase();
    if (own && input.bot !== null) this.addDefaultAutomations(input.bot);
    const context = this.eventContext(projectId, event, input.bot);
    if (own) await this.linkFromEvent(projectId, event);
    const matching: Automation[] = [];
    for (const row of this.rows<AutomationRow>('SELECT * FROM automations WHERE enabled=1 AND proposal_json IS NULL ORDER BY default_key IS NOT NULL, name, id')) {
      const automation = this.automation(row);
      if (automation.trigger.kind === 'watch') {
        if (event.watchKey === null || !triggerMatches(automation.trigger, event, await this.watchedRepository(projectId, automation.trigger))) continue;
        if (!this.markSeen(automation.id, event.watchKey, Date.now())) continue;
      } else if (!own || !triggerMatches(automation.trigger, event)) continue;
      matching.push(automation);
    }
    if (!own && matching.length === 0) return 0;
    for (const automation of matching) {
      const plan = await this.evaluate(projectId, automation, context)
        .catch((error: unknown) => failedPlan(`Failed: ${errorMessage(error)}`));
      const runId = this.ctx.storage.transactionSync(() => this.recordRun(automation, { trigger: 'event', event, replayedBy: null }, plan, Date.now()));
      if (plan.sendsTo !== null && this.requiredRun(runId).state === 'queued') context.sentTo.set(plan.sendsTo, automation.name);
    }
    await this.changed(projectId);
    return matching.length;
  }

  /** The four default automations, added once per project (a person may delete or change them afterwards). */
  async addDefaults(input: { projectId: string; bot: string }): Promise<void> {
    const projectId = this.ensureProject(input.projectId);
    if (this.addDefaultAutomations(input.bot)) await this.changed(projectId);
  }

  /** The GitSpace project's release automation, added once (a person may change or delete it afterwards). */
  async addGitSpaceReleases(input: { projectId: string }): Promise<void> {
    const projectId = this.ensureProject(input.projectId);
    if (this.ctx.storage.sql.exec("INSERT OR IGNORE INTO automation_defaults_offered(key) VALUES('gitspace-releases')").rowsWritten === 0) return;
    if (this.rows('SELECT id FROM automations WHERE name=? OR default_key=?', GITSPACE_RELEASES_AUTOMATION.name, 'gitspace-releases').length === 0) {
      this.save({ id: null, draft: checkDraft(GITSPACE_RELEASES_AUTOMATION), targetName: 'the project agent', proposal: null, createdBy: 'person', defaultKey: 'gitspace-releases' });
    }
    await this.changed(projectId);
  }

  /** A queued run, or one its workspace has not started, is skipped; one whose agent has started stops that agent. */
  async cancelRun(input: { projectId: string; runId: string }): Promise<AutomationOutcome<AutomationRunView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const run = this.requiredRun(input.runId);
      const unstarted = run.kind === 'start' && !StartSchema.parse(JSON.parse(run.start_json ?? 'null')).created;
      if (run.state === 'queued' || (run.state === 'running' && unstarted)) this.finish(run, 'skipped', 'Cancelled', Date.now());
      else if (run.state === 'running' && run.workspace_id !== null) {
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

  /** What a draft would do, without saving or running it: a schedule's coming times; for GitHub events, what it would do
   * with recent recorded deliveries, or with one (`deliveryId`) its checks and instruction. Trust is checked as it would
   * be on arrival. (`test` names a Workers event handler; RPC cannot call it.) */
  async testDraft(input: { projectId: string; draft: AutomationDraft; requestedBy: string; deliveryId?: string }): Promise<AutomationOutcome<AutomationTest>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const draft = checkDraft(input.draft);
      const targetName = await this.targetName(projectId, draft.action);
      if (draft.trigger.kind === 'schedule' || draft.trigger.kind === 'manual') return { ...dryRun(draft, targetName, input.requestedBy, Date.now()), checks: [] };
      return this.eventTest(projectId, { ...draft, targetName, id: '' }, draft.trigger.kind === 'watch' ? null : input.deliveryId ?? null);
    });
  }

  /** The repository's recorded deliveries, newest first, for Test with a past event. */
  async recordedEvents(input: { projectId: string; limit: number }): Promise<AutomationRecordedEvent[]> {
    const projectId = this.ensureProject(input.projectId);
    const repository = await this.repository(projectId);
    if (repository === null) return [];
    const events = await this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID).recordedEvents(repository, input.limit);
    return events.map(event => ({ deliveryId: event.deliveryId, event: automationEventName(event), label: describeAutomationEvent(event), receivedAt: new Date(event.receivedAt) }));
  }

  /** A person or an agent links a pull request, issue or branch to a workspace, replacing any link it had. A link to a
   * closed workspace reopens it. */
  async link(input: { projectId: string; subject: AutomationSubjectRef; workspaceId: string; source: 'person' | 'agent'; detail: string }): Promise<AutomationOutcome<AutomationLinkView>> {
    return settled(async () => {
      const projectId = this.ensureProject(input.projectId);
      const workspace = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getWorkspace(input.workspaceId);
      if (!workspace || workspace.kind !== 'worktree' || workspace.lifecycle === 'deleting') refuse('workspaceId', `Workspace ${input.workspaceId} is not a workspace of this project`);
      if (workspace.lifecycle !== 'active' && workspace.lifecycle !== 'archived') refuse('workspaceId', `Workspace ${workspace.name} is ${workspace.lifecycle}; link an active or closed workspace`);
      if (workspace.lifecycle === 'archived') await this.reopen(projectId, workspace.id);
      const key = automationSubjectKey(input.subject);
      const known = this.linkRow(key);
      const subject: AutomationSubject = known ? AutomationSubjectSchema.parse(JSON.parse(known.subject_json))
        : { kind: input.subject.kind, number: input.subject.kind === 'branch' ? null : input.subject.number, branch: input.subject.kind === 'branch' ? input.subject.branch : null, title: '', url: null };
      this.putLink(subject, workspace.id, input.source, input.detail, Date.now());
      await this.changed(projectId);
      const row = this.linkRow(key);
      if (!row) throw new Error(`The link for ${key} was not stored`);
      return linkView(row);
    });
  }

  async unlink(input: { projectId: string; subject: AutomationSubjectRef }): Promise<boolean> {
    const projectId = this.ensureProject(input.projectId);
    const removed = this.ctx.storage.sql.exec('DELETE FROM automation_links WHERE subject_key=? RETURNING subject_key', automationSubjectKey(input.subject)).toArray().length > 0;
    if (removed) await this.changed(projectId);
    return removed;
  }

  /** Only people change the limits and the trust list; every automation of the project runs under them. */
  async updateSettings(input: { projectId: string; settings: AutomationSettings }): Promise<AutomationSettings> {
    const projectId = this.ensureProject(input.projectId);
    const settings = SettingsSchema.parse(input.settings);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('INSERT INTO automation_settings(id, concurrency, daily_run_cap) VALUES(1, ?, ?) ON CONFLICT(id) DO UPDATE SET concurrency=excluded.concurrency, daily_run_cap=excluded.daily_run_cap', settings.concurrency, settings.dailyRunCap);
      this.ctx.storage.sql.exec('DELETE FROM automation_trusted');
      for (const login of settings.trusted) this.ctx.storage.sql.exec('INSERT OR IGNORE INTO automation_trusted(login) VALUES(?)', login);
    });
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

  /** The project is deleted: its automations, runs, links and alarm go with it. */
  async erase(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  async alarm(): Promise<void> {
    const projectId = this.rows<{ project_id: string }>('SELECT project_id FROM automation_identity WHERE id=1')[0]?.project_id;
    if (projectId === undefined) return;
    await this.checkWatches(projectId);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      for (const row of this.rows<AutomationRow>('SELECT * FROM automations WHERE next_run_at <= ? ORDER BY next_run_at, id', now)) {
        if (row.cron === null || row.next_run_at === null) continue;
        const automation = this.automation(row);
        const firing: Firing = { trigger: 'schedule', scheduledFor: row.next_run_at };
        this.recordRun(automation, firing, this.messagePlan(projectId, automation, firing), now);
        this.ctx.storage.sql.exec('UPDATE automations SET next_run_at=? WHERE id=?', nextAutomationRunAt(row.cron, now), row.id);
      }
      for (const run of this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='queued' AND created_at <= ?", now - AUTOMATION_MAX_QUEUE_MS)) {
        this.finish(run, 'skipped', 'Skipped: waited more than a day for a slot', now);
      }
      // A notice wakes no agent, so it takes no slot.
      for (const run of this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='queued' AND kind='notice'")) {
        this.ctx.storage.sql.exec("UPDATE automation_runs SET state='running' WHERE id=?", run.id);
      }
      const free = this.settings().concurrency - this.working();
      for (const run of free > 0 ? this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='queued' ORDER BY created_at, rowid LIMIT ?", free) : []) {
        this.ctx.storage.sql.exec("UPDATE automation_runs SET state='running', timeline_json=? WHERE id=?", timelineWith(run, now, run.kind === 'start' ? `Starting workspace ${run.target_name}` : `Sent to ${run.target_name}`), run.id);
      }
    });
    await this.submit(projectId);
    await this.changed(projectId);
  }

  /** Delivers each run that holds a slot (and each notice) and has not reached its workspace: a `start` run first starts
   * its workspace and links it, a closed target workspace is reopened. The request id makes a submission whose reply
   * was lost, or one resumed after a restart, deliver its message once. */
  private async submit(projectId: string): Promise<void> {
    const due = this.rows<RunRow>("SELECT * FROM automation_runs WHERE state='running' AND submitted=0 AND (retry_at IS NULL OR retry_at <= ?)", Date.now());
    await Promise.all(due.map(async run => {
      const workspaceId = run.workspace_id;
      try {
        if (workspaceId === null) throw new Error('The run has no workspace');
        if (run.kind === 'start') await this.startWorkspace(projectId, run);
        else if (workspaceId !== projectId) await this.reopen(projectId, workspaceId, run);
        // Cancelled meanwhile: nothing is delivered.
        if (this.run(run.id)?.state !== 'running') return;
        const space = this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${workspaceId}`);
        const role = run.kind === 'start' ? StartSchema.parse(JSON.parse(run.start_json ?? 'null')).role : null;
        const delivery = { projectId, workspaceId, requestId: `${AUTOMATION_REQUEST_PREFIX}${run.id}`, text: run.message, ...(role === null ? {} : { role }) };
        if (run.kind === 'notice') {
          await space.runtimeAutomationNotice(delivery);
          const current = this.run(run.id);
          if (current?.state === 'running') this.finish(current, 'finished', 'Notice added; the agent stays asleep', Date.now());
          return;
        }
        await space.runtimeAutomationSubmit(delivery);
        this.ctx.storage.sql.exec('UPDATE automation_runs SET submitted=1, retry_at=NULL WHERE id=?', run.id);
      } catch (error) {
        const current = this.run(run.id);
        if (current?.state !== 'running' || current.submitted === 1) return;
        const reason = errorMessage(error);
        const delay = SUBMIT_RETRY_MS[current.attempts];
        const now = Date.now();
        const unreached = current.kind === 'start' && !StartSchema.parse(JSON.parse(current.start_json ?? 'null')).created ? `Could not start workspace ${current.target_name}` : `Could not reach ${current.target_name}`;
        if (delay === undefined) this.finish(current, 'failed', `Failed: ${unreached.charAt(0).toLowerCase()}${unreached.slice(1)}: ${reason}`, now);
        else this.ctx.storage.sql.exec('UPDATE automation_runs SET attempts=attempts+1, retry_at=?, timeline_json=? WHERE id=?', now + delay, timelineWith(current, now, `${unreached} (${reason}); trying again`), current.id);
      }
    }));
  }

  /** A `start` run's workspace, created once under the id chosen when the run was recorded (a retried creation
   * resumes it), then linked to the run's subject. A model role the project's profile no longer offers fails the run
   * before the workspace exists. */
  private async startWorkspace(projectId: string, run: RunRow): Promise<void> {
    const start = StartSchema.parse(JSON.parse(run.start_json ?? 'null'));
    if (start.created || run.workspace_id === null) return;
    const workspaceId = run.workspace_id;
    if (start.role !== null) {
      const roles = await this.modelRoles(projectId);
      if (!roles.includes(start.role)) {
        const current = this.run(run.id);
        if (current?.state === 'running') this.finish(current, 'failed', `Failed: model role ${start.role} is no longer in the project's inference profile; it offers ${roles.join(', ')}`, Date.now());
        return;
      }
    }
    const existing = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getWorkspace(workspaceId);
    if (!existing) await createCloudWorkspace(this.env, this.env.ACCOUNT_ID, { id: workspaceId, projectId, name: start.name, branch: start.name, phase: start.mode, sourceKind: start.sourceKind, sourceRef: start.sourceRef });
    else if (existing.lifecycle === 'provisioning' || existing.lifecycle === 'failed') await retryCloudWorkspaceCreation(this.env, this.env.ACCOUNT_ID, workspaceId);
    else if (existing.lifecycle !== 'active') throw new Error(`Workspace ${existing.name} is ${existing.lifecycle}`);
    const now = Date.now();
    const current = this.run(run.id);
    if (current?.state !== 'running') return;
    // A link a person or agent made meanwhile stays; one found by branch gives way to the started workspace.
    const linked = this.putLink(start.subject, workspaceId, 'started', start.detail, now);
    const timeline = [...TimelineSchema.parse(JSON.parse(current.timeline_json)), { at: now, label: `Started workspace ${start.name} in ${MODE_LABEL[start.mode]} with model role ${MODEL_ROLE_LABELS[start.role ?? 'default'] ?? start.role}` },
      { at: now, label: linked ? `Linked to ${automationSubjectName(start.subject)}` : `${automationSubjectName(start.subject)} stays linked to another workspace` }];
    this.ctx.storage.sql.exec('UPDATE automation_runs SET start_json=?, timeline_json=? WHERE id=?', JSON.stringify({ ...start, created: true }), JSON.stringify(timeline), run.id);
  }

  /** A closed (archived) workspace an automation sends to is reopened. */
  private async reopen(projectId: string, workspaceId: string, run?: RunRow): Promise<void> {
    const workspace = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getWorkspace(workspaceId);
    if (workspace?.lifecycle !== 'archived') return;
    const placement = await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${workspaceId}`).get();
    await restoreCloudWorkspace(this.env, this.env.ACCOUNT_ID, { spaceId: workspaceId, expectedGeneration: placement?.generation ?? 0 });
    const current = run ? this.run(run.id) : undefined;
    if (current) this.ctx.storage.sql.exec('UPDATE automation_runs SET timeline_json=? WHERE id=?', timelineWith(current, Date.now(), `Reopened ${workspace.name}`), current.id);
  }

  /** What one event reads once for every automation it reaches: trust, the linked workspace, a pull request's files. */
  private eventContext(projectId: string, event: AutomationEvent, bot: string | null): EventContext {
    const github = this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID);
    const workspaces = once(() => this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).listWorkspaces());
    return {
      event,
      bot,
      sentTo: new Map(),
      trust: once(async () => {
        const actor = event.actor;
        // Choosing to watch a repository trusts what its maintainers publish (docs/AUTOMATIONS-DESIGN.md §4a).
        if (event.watchKey !== null && (await this.repository(projectId))?.toLowerCase() !== event.repository.toLowerCase()) return { trusted: true, label: `You watch ${event.repository}; what it publishes reaches the agent as trusted` };
        if (actor === null) return { trusted: true, label: event.event === 'check_suite' ? 'A check suite carries only GitHub\'s result' : 'Only people with write access can tag the repository' };
        if (event.fromApp) return { trusted: true, label: 'Sent by this account\'s GitHub App' };
        if (this.rows('SELECT login FROM automation_trusted WHERE login=?', actor).length > 0) return { trusted: true, label: `@${actor} is on the trust list` };
        try {
          return await github.canWrite(event.repository, actor)
            ? { trusted: true, label: `@${actor} has write access` }
            : { trusted: false, label: `@${actor} has no write access and is not on the trust list` };
        } catch (error) {
          return { error: `could not check whether @${actor} may write to ${event.repository}: ${errorMessage(error)}` };
        }
      }),
      linked: once(() => this.linkedWorkspace(event.subjects, workspaces)),
      changedFiles: once(async () => {
        if (event.changedFiles !== null) return event.changedFiles;
        const pull = event.subjects.find(subject => subject.kind === 'pullRequest');
        if (!pull?.number) return [];
        return github.pullRequestFiles(event.repository, pull.number);
      }),
    };
  }

  /** The workspace an event's subjects reach: a stored link, else a workspace on the subject's branch (the one active
   * most recently when several are). A link whose workspace was deleted is removed. */
  private async linkedWorkspace(subjects: readonly AutomationSubject[], workspaces: () => Promise<CloudWorkspaceDefinition[]>): Promise<LinkedTarget | null> {
    for (const subject of subjects) {
      const key = automationSubjectKey(subject);
      const row = this.linkRow(key);
      if (row) {
        const workspace = (await workspaces()).find(entry => entry.id === row.workspace_id && entry.kind === 'worktree' && entry.lifecycle !== 'deleting');
        if (workspace) return { workspaceId: workspace.id, name: workspace.name, source: row.source, detail: row.detail };
        this.ctx.storage.sql.exec('DELETE FROM automation_links WHERE subject_key=?', key);
      }
      const branch = subject.branch;
      if (branch === null) continue;
      const onBranch = (await workspaces())
        .filter(entry => entry.kind === 'worktree' && entry.branch === branch && (entry.lifecycle === 'active' || entry.lifecycle === 'archived'))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
      const [chosen, ...others] = onBranch;
      if (chosen) return { workspaceId: chosen.id, name: chosen.name, source: 'branch', detail: `branch ${branch}${others.length > 0 ? `; chosen over ${others.map(other => other.name).join(', ')} as the one active most recently` : ''}` };
    }
    return null;
  }

  /** Links an event makes by branch: a pull request whose head branch is a workspace's links to it, and so do the issues
   * its description closes. A linked subject records the event as its latest activity. */
  private async linkFromEvent(projectId: string, event: AutomationEvent): Promise<void> {
    const now = Date.now();
    const pull = event.event === 'pull_request' || event.event === 'pull_request_review' || event.event === 'pull_request_review_comment' ? event.subjects[0] : undefined;
    if (pull?.kind === 'pullRequest' && pull.branch !== null) {
      if (!this.linkRow(automationSubjectKey(pull))) {
        const workspaces = once(() => this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).listWorkspaces());
        const target = await this.linkedWorkspace([{ ...pull, kind: 'branch' }], workspaces);
        if (target) this.putLink(pull, target.workspaceId, 'branch', `head branch ${pull.branch}`, now);
      }
      const linked = this.linkRow(automationSubjectKey(pull));
      if (linked) {
        for (const number of event.closes) this.putLink({ kind: 'issue', number, branch: null, title: '', url: null }, linked.workspace_id, 'closes', `${automationSubjectName(pull)} closes it`, now);
      }
    }
    const activity = describeAutomationEvent(event);
    for (const subject of event.subjects) {
      const row = this.linkRow(automationSubjectKey(subject));
      if (!row) continue;
      const stored = AutomationSubjectSchema.parse(JSON.parse(row.subject_json));
      const updated = { ...stored, title: subject.title || stored.title, url: subject.url ?? stored.url };
      this.ctx.storage.sql.exec('UPDATE automation_links SET subject_json=?, activity_label=?, activity_at=? WHERE subject_key=?', JSON.stringify(updated), activity, now, row.subject_key);
    }
  }

  /** Stores a link unless the subject has a stronger one; true when the subject is now linked to `workspaceId`. */
  private putLink(subject: AutomationSubject, workspaceId: string, source: AutomationLinkSource, detail: string, now: number): boolean {
    const key = automationSubjectKey(subject);
    const current = this.linkRow(key);
    if (current && current.workspace_id !== workspaceId && LINK_STRENGTH[current.source] > LINK_STRENGTH[source]) return false;
    const stored = current ? AutomationSubjectSchema.parse(JSON.parse(current.subject_json)) : null;
    const merged = { ...subject, title: subject.title || stored?.title || '', url: subject.url ?? stored?.url ?? null };
    this.ctx.storage.sql.exec(`
      INSERT INTO automation_links(subject_key, subject_json, workspace_id, source, detail, linked_at) VALUES(?, ?, ?, ?, ?, ?)
      ON CONFLICT(subject_key) DO UPDATE SET subject_json=excluded.subject_json, workspace_id=excluded.workspace_id, source=excluded.source, detail=excluded.detail, linked_at=excluded.linked_at
    `, key, JSON.stringify(merged), workspaceId, source, detail, now);
    return true;
  }

  /** What an automation does with an event: trust, then its conditions in order (the first that fails skips it), then
   * its action's target. */
  private async evaluate(projectId: string, automation: Automation, context: EventContext): Promise<RunPlan> {
    const { event } = context;
    const pending = automation.conditions.map(condition => ({ label: conditionLabel(condition, context.bot), passed: null }));
    const trust = await context.trust();
    if ('error' in trust) return { ...failedPlan(`Failed: ${trust.error}`), checks: [{ label: 'The author\'s access', passed: null }, ...pending] };
    if (!trust.trusted) return { ...failedPlan(`Skipped: author not trusted (@${event.actor ?? 'unknown'})`, 'skipped'), checks: [{ label: trust.label, passed: false }, ...pending], timeline: [trust.label] };
    const checks: AutomationCheck[] = [{ label: trust.label, passed: true }];
    const timeline = [trust.label];
    for (const [index, condition] of automation.conditions.entries()) {
      const linked = condition.kind === 'linked' ? await context.linked() : null;
      const files = condition.kind === 'changedFiles' ? await context.changedFiles() : [];
      const result = checkCondition(condition, event, { linked, files, bot: context.bot });
      checks.push({ label: result.label, passed: result.passed });
      if (!result.passed) return { ...failedPlan(`Skipped: ${result.reason}`, 'skipped'), checks: [...checks, ...pending.slice(index + 1)], timeline };
    }
    if (automation.conditions.length > 0) timeline.push('Conditions passed');
    const subject = event.subjects[0];
    const summary = describeAutomationEvent(event);
    const instruction = renderAutomationInstruction(automation.action.instruction, { ...event.fields, 'automation.name': automation.name });
    const message = `Automation "${automation.name}" · ${automationEventName(event)} · ${summary}\n\n${instruction}\n\nThe event:\n${JSON.stringify(event.fields, null, 2)}`;
    const plan = { checks, ended: null, message, start: null, timeline, sendsTo: null };
    const { action } = automation;
    switch (action.kind) {
      case 'messageProjectAgent': return { ...plan, kind: 'message', workspaceId: projectId, targetName: 'the project agent', would: 'Would message the project agent' };
      case 'messageWorkspace': return { ...plan, kind: 'message', workspaceId: action.workspaceId, targetName: automation.targetName, would: `Would message ${automation.targetName}` };
      case 'startWorkspace': {
        if (event.watchKey !== null && action.mode !== null) {
          // A release, tag or deployment names no pull request, issue or branch: the workspace starts from the base on a
          // new branch of its own, which is its subject.
          const label = (event.tag ?? event.environment ?? event.event).toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40);
          const name = `${action.mode}-${label}`;
          const own: AutomationSubject = { kind: 'branch', number: null, branch: name, title: summary, url: event.fields['release.url'] ?? event.fields['tag.url'] ?? event.fields['deployment.url'] ?? null };
          const starting = this.rows<RunRow>("SELECT * FROM automation_runs WHERE kind='start' AND state IN ('queued', 'running') AND target_name=?", name)[0];
          if (starting || (await context.linked()) !== null || (await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).listWorkspaces()).some(workspace => workspace.branch === name && workspace.lifecycle !== 'deleting')) {
            return { ...failedPlan(`Skipped: workspace ${name} already exists`, 'skipped'), checks, timeline };
          }
          const start: Start = { name, mode: action.mode, role: action.role ?? null, subject: own, created: false, sourceKind: 'base', sourceRef: '', detail: automation.name };
          return { ...plan, kind: 'start', start, workspaceId: cloudResourceId(name), targetName: name, would: `Would start workspace ${name} in ${MODE_LABEL[action.mode]} with model role ${MODEL_ROLE_LABELS[start.role ?? 'default'] ?? start.role}` };
        }
        if (!subject) return { ...failedPlan('Skipped: the event names no pull request, issue or branch', 'skipped'), checks, timeline };
        const linked = await context.linked();
        if (linked) return { ...failedPlan(`Skipped: ${automationSubjectName(subject)} already has workspace ${linked.name}`, 'skipped'), checks, timeline };
        // A workspace already starting for the subject (from this delivery or an earlier one) is its workspace.
        const key = automationSubjectKey(subject);
        const starting = this.rows<RunRow>("SELECT * FROM automation_runs WHERE kind='start' AND state IN ('queued', 'running') AND subject_json IS NOT NULL")
          .find(run => automationSubjectKey(AutomationSubjectSchema.parse(JSON.parse(run.subject_json ?? 'null'))) === key);
        if (starting) return { ...failedPlan(`Skipped: ${automationSubjectName(subject)} already has workspace ${starting.target_name} starting`, 'skipped'), checks, timeline };
        const mode = action.mode ?? (event.label === null ? undefined : AUTOMATION_START_LABELS[event.label]);
        if (mode === undefined) return { ...failedPlan('Skipped: the label names no mode', 'skipped'), checks, timeline };
        const number = subject.number ?? 0;
        const name = `${mode}-${subject.kind === 'pullRequest' ? `pr-${number}` : subject.kind === 'issue' ? `issue-${number}` : (subject.branch ?? 'branch').toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 40)}`;
        const start: Start = {
          name, mode, role: action.role ?? null, subject, created: false,
          sourceKind: subject.kind === 'pullRequest' ? 'pull-request' : subject.kind === 'issue' ? 'base' : 'branch',
          sourceRef: subject.kind === 'pullRequest' ? String(number) : subject.kind === 'issue' ? '' : subject.branch ?? '',
          detail: event.label === null ? automation.name : `${automation.name} · ${event.label}`,
        };
        return { ...plan, kind: 'start', start, workspaceId: cloudResourceId(name), targetName: name, would: `Would start workspace ${name} in ${MODE_LABEL[mode]} with model role ${MODEL_ROLE_LABELS[start.role ?? 'default'] ?? start.role}, linked to ${automationSubjectName(subject)}` };
      }
      case 'sendToLinked': {
        const linked = await context.linked();
        if (linked) {
          const sender = context.sentTo.get(linked.workspaceId);
          if (sender !== undefined) return { ...failedPlan(`Skipped: already sent to ${linked.name} by ${sender}`, 'skipped'), checks, timeline };
          const how = action.wake ? 'wakes its agent' : 'a notice; the agent stays asleep';
          return {
            ...plan, kind: action.wake ? 'message' : 'notice', workspaceId: linked.workspaceId, targetName: linked.name, sendsTo: linked.workspaceId,
            message: action.wake ? message : `${summary}\n\n${instruction}`,
            timeline: [...timeline, `Linked to ${linked.name} (${LINK_LABEL[linked.source]})`, `${summary}: ${how}`],
            would: action.wake ? `Would wake the agent of ${linked.name}` : `Would add a notice to ${linked.name}`,
          };
        }
        const name = subject ? automationSubjectName(subject) : 'The event';
        if (!action.orProjectAgent) return { ...failedPlan('Skipped: no linked workspace', 'skipped'), checks, timeline };
        return { ...plan, kind: 'message', workspaceId: projectId, targetName: 'the project agent', timeline: [...timeline, `${name} has no linked workspace: sent to the project agent`], would: 'Would send it to the project agent: it has no linked workspace' };
      }
    }
  }

  /** A schedule or manual run's message to the project agent or a workspace. */
  private messagePlan(projectId: string, automation: Automation, firing: Firing): RunPlan {
    const when = firing.trigger === 'schedule' ? { label: 'Scheduled for', detail: utcLabel(firing.scheduledFor) } : { label: 'Started by', detail: firing.trigger === 'manual' ? firing.requestedBy : 'a person' };
    const values: Record<string, string> = firing.trigger === 'schedule'
      ? { 'automation.name': automation.name, scheduled_for: new Date(firing.scheduledFor).toISOString() }
      : { 'automation.name': automation.name, requested_by: when.detail };
    const workspaceId = automation.action.kind === 'messageWorkspace' ? automation.action.workspaceId : projectId;
    return {
      checks: [], ended: null, kind: 'message', workspaceId, targetName: automation.targetName, start: null, timeline: [], would: '', sendsTo: null,
      message: `Automation "${automation.name}" (${when.label.toLowerCase()} ${when.detail}):\n\n${renderAutomationInstruction(automation.action.instruction, values)}`,
    };
  }

  /** A draft's test against recorded deliveries: one, or the recent ones its trigger starts on. A watch is tested on
   * what its repository published lately, read now. */
  private async eventTest(projectId: string, automation: Automation, deliveryId: string | null): Promise<AutomationTest> {
    const github = this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID);
    const bot = await github.botHandle();
    const { trigger } = automation;
    let events: AutomationEvent[];
    let source: string;
    if (trigger.kind === 'watch') {
      events = await this.watchedEvents(projectId, trigger, TESTED_EVENTS);
      source = `${await this.watchedRepository(projectId, trigger)} has published no ${AUTOMATION_WATCH_LABEL[trigger.on].toLowerCase()} yet`;
    } else {
      const repository = await this.repository(projectId);
      if (repository === null) refuse('trigger', 'This project has no GitHub repository, so it receives no GitHub events');
      if (deliveryId !== null) events = [await this.recordedEvent(projectId, deliveryId)];
      else {
        const recent = await github.recordedEvents(repository, TESTED_DELIVERIES);
        events = recent.map(event => AutomationEventSchema.parse(event)).filter(event => triggerMatches(trigger, event)).slice(0, TESTED_EVENTS);
      }
      source = `GitSpace has recorded no event for ${repository} that this trigger starts on`;
    }
    if (events.length === 0) return { results: [{ label: trigger.kind === 'watch' ? 'Published' : 'Recorded events', result: source, runs: false }], instruction: '', checks: [] };
    const watched = trigger.kind === 'watch' ? await this.watchedRepository(projectId, trigger) : null;
    const tested = await Promise.all(events.map(async event => {
      const label = `${describeAutomationEvent(event)} · ${automationEventName(event)} · ${utcLabel(event.receivedAt)}`;
      if (!triggerMatches(trigger, event, watched)) return { result: { label, result: `Would not run: this trigger does not start on ${automationEventName(event)}`, runs: false }, checks: [], event };
      const plan = await this.evaluate(projectId, automation, this.eventContext(projectId, event, bot)).catch((error: unknown) => failedPlan(`Failed: ${errorMessage(error)}`));
      return { result: { label, result: plan.ended?.outcome ?? plan.would, runs: plan.ended === null }, checks: plan.checks, event };
    }));
    const first = tested[0];
    return {
      results: tested.map(entry => entry.result),
      instruction: first ? renderAutomationInstruction(automation.action.instruction, { ...first.event.fields, 'automation.name': automation.name }) : '',
      checks: deliveryId !== null && first ? first.checks : [],
    };
  }

  /** Records a run: queued, or skipped (its plan skipped it, the automation's previous scheduled or manual run still
   * works, or the daily cap is reached), or failed. */
  private recordRun(automation: Automation, firing: Firing, plan: RunPlan, now: number): string {
    const id = crypto.randomUUID();
    const event = firing.trigger === 'event' ? firing.event : null;
    const scheduledFor = firing.trigger === 'schedule' ? firing.scheduledFor : now;
    const first = firing.trigger === 'schedule' ? `Scheduled for ${utcLabel(scheduledFor)}`
      : firing.trigger === 'manual' ? `Started by ${firing.requestedBy}`
        : firing.replayedBy === null ? 'Delivery received' : `Run it by ${firing.replayedBy} on a delivery received ${utcLabel(firing.event.receivedAt)}`;
    const today = this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE automation_id=? AND created_at >= ? AND state != 'skipped'", automation.id, utcDay(now));
    const skippedFor = plan.ended === null && firing.trigger !== 'event' && this.activeRun(automation.id) ? 'Skipped: its previous run is still working'
      : plan.ended === null && today >= this.settings().dailyRunCap ? 'Skipped: daily run cap' : null;
    const ended: RunPlan['ended'] = plan.ended ?? (skippedFor === null ? null : { state: 'skipped', outcome: skippedFor });
    const labels = [first, ...plan.timeline, ended?.outcome ?? 'Queued'];
    const timeline: Timeline = labels.map(label => ({ at: now, label }));
    const trigger = event === null ? firing.trigger === 'schedule' ? 'schedule' : 'manual' : automation.trigger.kind === 'label' ? 'label' : 'github';
    this.ctx.storage.sql.exec(`
      INSERT INTO automation_runs(id, automation_id, automation_name, trigger, kind, event, subject_json, event_json, checks_json, start_json, state, workspace_id, target_name, message, outcome, timeline_json, scheduled_for, created_at, finished_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, id, automation.id, automation.name, trigger, plan.kind, event === null ? null : automationEventName(event), event?.subjects[0] ? JSON.stringify(event.subjects[0]) : null,
    event === null ? null : JSON.stringify(event), JSON.stringify(plan.checks), plan.start === null ? null : JSON.stringify(plan.start), ended?.state ?? 'queued',
    plan.ended === null ? plan.workspaceId : null, plan.targetName, plan.message, ended?.outcome ?? null, JSON.stringify(timeline),
    scheduledFor, now, ended === null ? null : now);
    this.ctx.storage.sql.exec(`
      DELETE FROM automation_runs WHERE automation_id=? AND state IN ('finished', 'skipped', 'failed')
        AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?)
    `, automation.id, automation.id, KEPT_RUNS);
    return id;
  }

  private finish(run: RunRow, state: 'finished' | 'skipped' | 'failed', outcome: string, now: number, label: string = outcome): void {
    this.ctx.storage.sql.exec('UPDATE automation_runs SET state=?, outcome=?, finished_at=?, retry_at=NULL, timeline_json=? WHERE id=?', state, outcome, now, timelineWith(run, now, label), run.id);
  }

  /** Adds the default automations unless this project already had them; true when it added them now. */
  private addDefaultAutomations(bot: string): boolean {
    if (this.rows<{ defaults_added: number }>('SELECT defaults_added FROM automation_settings WHERE id=1')[0]?.defaults_added === 1) return false;
    const settings = this.settings();
    this.ctx.storage.sql.exec('INSERT INTO automation_settings(id, concurrency, daily_run_cap, defaults_added) VALUES(1, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET defaults_added=1', settings.concurrency, settings.dailyRunCap);
    for (const entry of defaultAutomations(bot)) {
      if (this.rows('SELECT id FROM automations WHERE name=? OR default_key=?', entry.draft.name, entry.key).length > 0) continue;
      this.save({ id: null, draft: checkDraft(entry.draft), targetName: 'the linked workspace', proposal: null, createdBy: 'person', defaultKey: entry.key });
    }
    return true;
  }

  /** Writes a checked draft over automation `id`, or as a new automation; returns its id. */
  private save(input: { id: string | null; draft: AutomationDraft; targetName: string; proposal: StoredProposal | null; createdBy: 'person' | 'projectAgent'; defaultKey: string | null }): string {
    const { draft } = input;
    const now = Date.now();
    const cron = draft.trigger.kind === 'schedule' ? draft.trigger.cron : null;
    const enabled = input.proposal === null && draft.enabled;
    const nextRunAt = cron !== null && enabled ? nextAutomationRunAt(cron, now) : null;
    const proposal = input.proposal === null ? null : JSON.stringify(input.proposal);
    const definition = [JSON.stringify(draft.trigger), JSON.stringify(draft.conditions), JSON.stringify(draft.action)];
    return this.ctx.storage.transactionSync(() => {
      if (this.rows('SELECT id FROM automations WHERE name=? AND id IS NOT ?', draft.name, input.id).length > 0) refuse('name', `An automation named "${draft.name}" already exists`);
      if (input.id === null) {
        const id = crypto.randomUUID();
        this.ctx.storage.sql.exec(`
          INSERT INTO automations(id, revision, name, trigger_json, conditions_json, action_json, cron, target_name, enabled, created_by, default_key, proposal_json, next_run_at, created_at, updated_at)
          VALUES(?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, id, draft.name, ...definition, cron, input.targetName, enabled ? 1 : 0, input.createdBy, input.defaultKey, proposal, nextRunAt, now, now);
        return id;
      }
      this.ctx.storage.sql.exec(`
        UPDATE automations SET revision=revision+1, name=?, trigger_json=?, conditions_json=?, action_json=?, cron=?, target_name=?, enabled=?, proposal_json=?, next_run_at=?, updated_at=?
        WHERE id=?
      `, draft.name, ...definition, cron, input.targetName, enabled ? 1 : 0, proposal, nextRunAt, now, input.id);
      return input.id;
    });
  }

  /** The name runs show for an action's target; a named workspace must be an active workspace of the project, and a
   * started workspace's model role one its inference profile offers. */
  private async targetName(projectId: string, action: AutomationAction): Promise<string> {
    switch (action.kind) {
      case 'messageProjectAgent': return 'the project agent';
      case 'startWorkspace': {
        if (action.role !== undefined) {
          const roles = await this.modelRoles(projectId);
          if (!roles.includes(action.role)) refuse('action.role', `${action.role} is not a model role of this project's inference profile; it offers ${roles.join(', ')}`);
        }
        return 'a new workspace';
      }
      case 'sendToLinked': return 'the linked workspace';
      case 'messageWorkspace': {
        const workspace = await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getWorkspace(action.workspaceId);
        if (!workspace || workspace.kind !== 'worktree') refuse('action.workspaceId', `Workspace ${action.workspaceId} is not a workspace of this project`);
        if (workspace.lifecycle !== 'active') refuse('action.workspaceId', `Workspace ${workspace.name} is ${workspace.lifecycle}; choose an active workspace`);
        return workspace.name;
      }
    }
  }

  /** The model roles the project's inference profile offers: those every profile has, and its own. */
  private async modelRoles(projectId: string): Promise<string[]> {
    const catalog = await this.env.CREDENTIALS.getByName(this.env.ACCOUNT_ID).cloudInferenceCatalog(projectId);
    return [...new Set([...BUILT_IN_MODEL_ROLES, ...(catalog ? profileModelRoles(catalog.profile.settings) : [])])];
  }

  /** The project's GitHub repository (`owner/name`), or null when its remote is not on GitHub. */
  private async repository(projectId: string): Promise<string | null> {
    const reference = (await this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${projectId}`).getProject())?.repositoryReference ?? null;
    return reference === null ? null : githubRepositoryOf(reference);
  }

  /** Forks' upstream parents, as GitHub named them while this object ran. */
  private readonly upstreams = new Map<string, string | null>();

  /** The repository a watch reads: the one it names, else the project's own, or that one's upstream parent when the
   * project's repository is a fork. Null for a project with no GitHub repository. */
  private async watchedRepository(projectId: string, trigger: Extract<AutomationTrigger, { kind: 'watch' }>): Promise<string | null> {
    if (trigger.repository !== null) return trigger.repository;
    const own = await this.repository(projectId);
    if (own === null) return null;
    if (!this.upstreams.has(own.toLowerCase())) this.upstreams.set(own.toLowerCase(), await this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID).upstreamOf(own));
    return this.upstreams.get(own.toLowerCase()) ?? own;
  }

  /** What a watch's repository published lately, newest first, as events (`limit` at most). */
  private async watchedEvents(projectId: string, trigger: Extract<AutomationTrigger, { kind: 'watch' }>, limit = Infinity): Promise<AutomationEvent[]> {
    const repository = await this.watchedRepository(projectId, trigger);
    if (repository === null) refuse('trigger.repository', 'This project has no GitHub repository: name the repository to watch');
    const items = await this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID).watchedItems(repository, trigger.on);
    return items.slice(0, limit).map(item => {
      const event = watchedEvent({ repository, item, deliveryId: `watch:${repository}`, receivedAt: Date.now(), fromApp: false });
      return { ...event, deliveryId: `watch:${repository}:${event.watchKey ?? ''}` };
    });
  }

  /** Records that a watch has seen `key`; false when it already had. A watch keeps its newest seen keys. */
  private markSeen(automationId: string, key: string, now: number): boolean {
    const added = this.ctx.storage.sql.exec('INSERT OR IGNORE INTO automation_watch_seen(automation_id, key, seen_at) VALUES(?, ?, ?)', automationId, key, now).rowsWritten > 0;
    if (added) this.ctx.storage.sql.exec(`DELETE FROM automation_watch_seen WHERE automation_id=? AND key NOT IN (
      SELECT key FROM automation_watch_seen WHERE automation_id=? ORDER BY seen_at DESC LIMIT ?)`, automationId, automationId, WATCH_SEEN_KEPT);
    return added;
  }

  /**
   * Checks each watch whose interval came: its repository's releases, tags or deployments. The first check of a watch
   * (created, switched on, or its trigger changed) records what exists, so it runs only on what comes after; later
   * checks run on what it has not seen, oldest first. A failed check is tried at the next interval.
   */
  private async checkWatches(projectId: string): Promise<void> {
    const now = Date.now();
    for (const watch of this.rows<{ automation_id: string; next_check_at: number; baseline: number }>('SELECT automation_id, next_check_at, baseline FROM automation_watches WHERE next_check_at <= ?', now)) {
      const row = this.rows<AutomationRow>('SELECT * FROM automations WHERE id=? AND enabled=1 AND proposal_json IS NULL', watch.automation_id)[0];
      const automation = row ? this.automation(row) : null;
      if (automation?.trigger.kind !== 'watch') continue;
      const trigger = automation.trigger;
      try {
        const events = await this.watchedEvents(projectId, trigger);
        const fresh = events.filter(event => event.watchKey !== null && this.markSeen(automation.id, event.watchKey, now)).reverse();
        if (watch.baseline === 1) {
          for (const event of fresh) {
            const plan = await this.evaluate(projectId, automation, this.eventContext(projectId, event, null)).catch((error: unknown) => failedPlan(`Failed: ${errorMessage(error)}`));
            this.ctx.storage.transactionSync(() => this.recordRun(automation, { trigger: 'event', event, replayedBy: null }, plan, Date.now()));
          }
        }
        this.ctx.storage.sql.exec('UPDATE automation_watches SET baseline=1, next_check_at=? WHERE automation_id=?', now + AUTOMATION_WATCH_EVERY_MS[trigger.every], automation.id);
      } catch (error) {
        console.warn(JSON.stringify({ event: 'automation_watch_check_failed', projectId, automationId: automation.id, message: errorMessage(error) }));
        this.ctx.storage.sql.exec('UPDATE automation_watches SET next_check_at=? WHERE automation_id=?', now + AUTOMATION_WATCH_EVERY_MS[trigger.every], automation.id);
      }
    }
  }

  /** A switched-on watch has a row, checked now when it is new or its trigger changed (what it had seen is forgotten);
   * any other automation has none. */
  private syncWatches(): void {
    const watches = new Map(this.rows<{ automation_id: string; trigger_json: string }>('SELECT automation_id, trigger_json FROM automation_watches').map(row => [row.automation_id, row.trigger_json]));
    for (const row of this.rows<AutomationRow>("SELECT * FROM automations WHERE enabled=1 AND proposal_json IS NULL AND json_extract(trigger_json, '$.kind')='watch'")) {
      const stored = watches.get(row.id);
      watches.delete(row.id);
      if (stored === row.trigger_json) continue;
      this.ctx.storage.sql.exec('DELETE FROM automation_watch_seen WHERE automation_id=?', row.id);
      this.ctx.storage.sql.exec('INSERT INTO automation_watches(automation_id, trigger_json, next_check_at, baseline) VALUES(?, ?, ?, 0) ON CONFLICT(automation_id) DO UPDATE SET trigger_json=excluded.trigger_json, next_check_at=excluded.next_check_at, baseline=0',
        row.id, row.trigger_json, Date.now());
    }
    for (const automationId of watches.keys()) {
      this.ctx.storage.sql.exec('DELETE FROM automation_watches WHERE automation_id=?', automationId);
      this.ctx.storage.sql.exec('DELETE FROM automation_watch_seen WHERE automation_id=?', automationId);
    }
  }

  private async recordedEvent(projectId: string, deliveryId: string): Promise<AutomationEvent> {
    const repository = await this.repository(projectId);
    const event = repository === null ? null : await this.env.GITHUB_APP.getByName(this.env.ACCOUNT_ID).recordedEvent(repository, deliveryId);
    if (!event) refuse('deliveryId', `GitSpace has no recorded delivery ${deliveryId} for this project's repository`);
    return AutomationEventSchema.parse(event);
  }

  /** Sets the one alarm to the earliest deadline the work names, or now for a run that holds a slot and has not been
   * submitted (a restart resumes it), a queued notice, or a queued run with a free slot. */
  private async reschedule(): Promise<void> {
    const now = Date.now();
    const immediate = this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='running' AND submitted=0 AND retry_at IS NULL") > 0
      || this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='queued' AND kind='notice'") > 0
      || (this.working() < this.settings().concurrency && this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='queued'") > 0);
    const due = immediate ? now : this.rows<{ at: number | null }>(`
      SELECT MIN(at) AS at FROM (
        SELECT MIN(next_run_at) AS at FROM automations
        UNION ALL SELECT MIN(next_check_at) FROM automation_watches
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
    this.syncWatches();
    await this.reschedule();
    const now = Date.now();
    const day = utcDay(now);
    const summary: AutomationProjectSummary = {
      projectId,
      total: this.count('SELECT COUNT(*) AS count FROM automations'),
      on: this.count('SELECT COUNT(*) AS count FROM automations WHERE enabled=1 AND proposal_json IS NULL'),
      proposed: this.count('SELECT COUNT(*) AS count FROM automations WHERE proposal_json IS NOT NULL'),
      working: this.working(),
      queued: this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='queued'"),
      failedToday: this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='failed' AND finished_at >= ?", day),
    };
    const runs = this.rows<RunRow>('SELECT * FROM automation_runs ORDER BY created_at DESC, rowid DESC LIMIT ?', INDEXED_RUNS).map(row => runRecord(projectId, row));
    try { await this.env.USER_PROJECTS.getByName(this.env.ACCOUNT_ID).setAutomationSummary({ summary, day, runs }); }
    catch (error) { console.error(JSON.stringify({ event: 'automation_summary_unsent', projectId, error: errorMessage(error) })); }
    await notifyBrowsers(this.env, [{ ...accountLiveKey('automations'), version: now }]);
  }

  /** Runs holding a slot: their agent works, or their workspace is being started. */
  private working(): number {
    return this.count("SELECT COUNT(*) AS count FROM automation_runs WHERE state='running' AND kind != 'notice'");
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
    const trusted = this.rows<{ login: string }>('SELECT login FROM automation_trusted ORDER BY login').map(entry => entry.login);
    return row ? { concurrency: row.concurrency, dailyRunCap: row.daily_run_cap, trusted } : { ...AUTOMATION_DEFAULT_SETTINGS, trusted };
  }

  private automation(row: AutomationRow): Automation {
    return {
      id: row.id, name: row.name, targetName: row.target_name,
      trigger: AutomationTriggerSchema.parse(JSON.parse(row.trigger_json)),
      conditions: z.array(AutomationConditionSchema).parse(JSON.parse(row.conditions_json)),
      action: AutomationActionSchema.parse(JSON.parse(row.action_json)),
    };
  }

  private automationView(projectId: string, row: AutomationRow): AutomationView {
    const last = this.rows<{ state: AutomationRunState; at: number }>('SELECT state, COALESCE(finished_at, started_at, created_at) AS at FROM automation_runs WHERE automation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', row.id)[0];
    const proposal = row.proposal_json === null ? null : ProposalSchema.parse(JSON.parse(row.proposal_json));
    const automation = this.automation(row);
    return {
      id: row.id,
      projectId,
      revision: row.revision,
      name: row.name,
      trigger: automation.trigger,
      conditions: automation.conditions,
      action: automation.action,
      enabled: row.enabled === 1,
      createdBy: row.created_by,
      isDefault: row.default_key !== null,
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

  private linkRow(subjectKey: string): LinkRow | undefined {
    return this.rows<LinkRow>('SELECT * FROM automation_links WHERE subject_key=?', subjectKey)[0];
  }

  private count(query: string, ...bindings: SqlStorageValue[]): number {
    return this.rows<{ count: number }>(query, ...bindings)[0]?.count ?? 0;
  }

  private rows<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray();
  }
}

/** A plan that does not run: skipped or failed with `outcome`. */
function failedPlan(outcome: string, state: 'skipped' | 'failed' = 'failed'): RunPlan {
  return { checks: [], ended: { state, outcome }, kind: 'message', workspaceId: null, targetName: '', message: '', start: null, timeline: [], would: '', sendsTo: null };
}

/** A condition as the run's checks read it ("base branch is main"), whether the event passes it, and why not. */
function checkCondition(condition: AutomationCondition, event: AutomationEvent, read: { linked: LinkedTarget | null; files: readonly string[]; bot: string | null }): { label: string; passed: boolean; reason: string } {
  const label = conditionLabel(condition, read.bot);
  const values = 'values' in condition ? condition.values : [];
  const any = values.join(' or ');
  switch (condition.kind) {
    case 'linked': return condition.linked
      ? { label, passed: read.linked !== null, reason: 'it has no linked workspace' }
      : { label, passed: read.linked === null, reason: `it is linked to ${read.linked?.name ?? 'a workspace'}` };
    case 'mentionsBot': return { label, passed: event.mentionsBot, reason: `it does not mention ${read.bot ?? 'the bot'}` };
    case 'baseBranch':
    case 'headBranch':
    case 'branch': {
      const value = condition.kind === 'baseBranch' ? event.baseBranch : condition.kind === 'headBranch' ? event.headBranch : event.branch;
      const matched = value !== null && values.some(pattern => globMatches(pattern, value, false));
      return { label, passed: condition.mode === 'oneOf' ? matched : !matched, reason: `${BRANCH_NAME[condition.kind]} is ${value ?? 'unknown'}` };
    }
    case 'author': {
      const matched = event.author !== null && values.some(pattern => globMatches(pattern, event.author ?? '', true));
      return { label, passed: condition.mode === 'oneOf' ? matched : !matched, reason: `the author is ${event.author ?? 'unknown'}` };
    }
    case 'labels': {
      const matched = (event.labels ?? []).find(name => values.some(pattern => globMatches(pattern, name, true)));
      return condition.mode === 'oneOf'
        ? { label, passed: matched !== undefined, reason: `it has none of the labels ${values.join(', ')}` }
        : { label, passed: matched === undefined, reason: `it has the label ${matched ?? ''}` };
    }
    case 'changedFiles': {
      const matched = read.files.find(path => values.some(pattern => globMatches(pattern, path, false)));
      return condition.mode === 'oneOf'
        ? { label, passed: matched !== undefined, reason: `it changes no file matching ${any}` }
        : { label, passed: matched === undefined, reason: `it changes ${matched ?? ''}` };
    }
    case 'draft': return condition.draft
      ? { label, passed: event.draft === true, reason: 'the pull request is not a draft' }
      : { label, passed: event.draft !== true, reason: 'the pull request is a draft' };
    case 'conclusion': return { label, passed: event.conclusion !== null && values.includes(event.conclusion), reason: `the conclusion is ${event.conclusion ?? 'none yet'}` };
    case 'reviewState': return { label, passed: event.reviewState !== null && values.some(value => value.toLowerCase() === event.reviewState), reason: `the review is ${(event.reviewState ?? 'unknown').replaceAll('_', ' ')}` };
    case 'tag': {
      const matched = event.tag !== null && values.some(pattern => globMatches(pattern, event.tag ?? '', false));
      return { label, passed: condition.mode === 'oneOf' ? matched : !matched, reason: `the tag is ${event.tag ?? 'unknown'}` };
    }
    case 'prerelease': return condition.prerelease
      ? { label, passed: event.prerelease === true, reason: 'it is not a prerelease' }
      : { label, passed: event.prerelease !== true, reason: 'it is a prerelease' };
    case 'environment': {
      const matched = event.environment !== null && values.some(pattern => globMatches(pattern, event.environment ?? '', true));
      return { label, passed: condition.mode === 'oneOf' ? matched : !matched, reason: `the environment is ${event.environment ?? 'unknown'}` };
    }
    case 'deploymentState': return { label, passed: event.deploymentState !== null && values.some(value => value.toLowerCase() === event.deploymentState), reason: `the deployment is ${event.deploymentState ?? 'unknown'}` };
  }
}

const BRANCH_NAME: Record<'baseBranch' | 'headBranch' | 'branch', string> = { baseBranch: 'the base branch', headBranch: 'the head branch', branch: 'the branch' };

/** A condition as checks and tests read it: "base branch is main", "not a draft". */
function conditionLabel(condition: AutomationCondition, bot: string | null): string {
  const values = 'values' in condition ? condition.values.join(' or ') : '';
  const not = 'mode' in condition && condition.mode === 'noneOf' ? 'not ' : '';
  switch (condition.kind) {
    case 'linked': return condition.linked ? 'it is linked to a workspace' : 'it has no linked workspace';
    case 'mentionsBot': return `it mentions ${bot ?? 'the bot'}`;
    case 'baseBranch': return `base branch is ${not}${values}`;
    case 'headBranch': return `head branch is ${not}${values}`;
    case 'branch': return `branch is ${not}${values}`;
    case 'author': return `author is ${not}${values}`;
    case 'labels': return condition.mode === 'oneOf' ? `has the label ${values}` : `has no label ${values}`;
    case 'changedFiles': return condition.mode === 'oneOf' ? `changes files matching ${values}` : `changes no file matching ${values}`;
    case 'draft': return condition.draft ? 'a draft' : 'not a draft';
    case 'conclusion': return `conclusion is ${values}`;
    case 'reviewState': return `review is ${values.replaceAll('_', ' ')}`;
    case 'tag': return `tag is ${not}${values}`;
    case 'prerelease': return condition.prerelease ? 'a prerelease' : 'not a prerelease';
    case 'environment': return `environment is ${not}${values}`;
    case 'deploymentState': return `state is ${values}`;
  }
}

function timelineWith(run: RunRow, at: number, label: string): string {
  return JSON.stringify([...TimelineSchema.parse(JSON.parse(run.timeline_json)), { at, label }]);
}

function linkView(row: LinkRow): AutomationLinkView {
  return {
    subject: AutomationSubjectSchema.parse(JSON.parse(row.subject_json)),
    workspaceId: row.workspace_id,
    source: row.source,
    detail: row.detail,
    linkedAt: new Date(row.linked_at),
    lastActivity: row.activity_at === null || row.activity_label === null ? null : { at: new Date(row.activity_at), label: row.activity_label },
  };
}

function runRecord(projectId: string, row: RunRow): AutomationRunRecord {
  return {
    id: row.id,
    projectId,
    automationId: row.automation_id,
    automationName: row.automation_name,
    trigger: row.trigger,
    event: row.event,
    subject: row.subject_json === null ? null : AutomationSubjectSchema.parse(JSON.parse(row.subject_json)),
    state: row.state,
    workspaceId: row.workspace_id,
    outcome: row.outcome,
    checks: ChecksSchema.parse(JSON.parse(row.checks_json)),
    timeline: TimelineSchema.parse(JSON.parse(row.timeline_json)),
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/** What a schedule or manual draft would do: for a schedule its next three run times, for manual that it runs only
 * when started; and its instruction rendered with sample values. */
function dryRun(draft: AutomationDraft, targetName: string, requestedBy: string, now: number): { results: AutomationTestResult[]; instruction: string } {
  const values: Record<string, string> = { 'automation.name': draft.name, requested_by: requestedBy };
  if (draft.trigger.kind !== 'schedule') {
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
