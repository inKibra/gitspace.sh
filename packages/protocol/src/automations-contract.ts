import { defineErrors, type InputOf } from 'result-rpc';
import { z } from 'zod';
import { wire } from './json-wire.js';

/** A queued run older than this is skipped ("Skipped: waited more than a day for a slot"). */
export const AUTOMATION_MAX_QUEUE_MS = 24 * 60 * 60_000;

// Schedules: five-field cron expressions (minute hour day-of-month month day-of-week), always in UTC.

export interface AutomationSchedule {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Day of month was `*`: with a restricted weekday, only the weekday decides (cron's either-or rule). */
  anyDay: boolean;
  anyWeekday: boolean;
}

interface ScheduleField { name: string; min: number; max: number }
const SCHEDULE_FIELDS: readonly ScheduleField[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
];
const WEEKDAY_NAMES: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** Schedules that cannot run within this many years (e.g. February 30) are refused. */
const SCHEDULE_HORIZON_YEARS = 5;

function parseScheduleField(text: string, field: ScheduleField): Set<number> | string {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const [range = '', stepText, extra] = part.split('/');
    if (extra !== undefined) return `The ${field.name} field "${part}" has more than one step`;
    if (!/^(\*|\d+|\d+-\d+)$/u.test(range)) return `The ${field.name} field "${part}" is not a number, range or *`;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isSafeInteger(step) || step < 1) return `The ${field.name} field "${part}" has an invalid step`;
    let low: number;
    let high: number;
    if (range === '*') {
      low = field.min;
      high = field.max;
    } else if (range.includes('-')) {
      const [from = '', to = ''] = range.split('-');
      low = Number(from);
      high = Number(to);
    } else {
      low = Number(range);
      high = stepText === undefined ? low : field.max;
    }
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low < field.min || high > field.max || low > high) {
      return `The ${field.name} field "${part}" is outside ${field.min}-${field.max}`;
    }
    for (let value = low; value <= high; value += step) values.add(field.name === 'day of week' && value === 7 ? 0 : value);
  }
  return values;
}

function scheduleFields(expression: string): AutomationSchedule | string {
  const parts = expression.trim().split(/\s+/u);
  if (parts.length !== 5) return `A schedule has five fields (minute hour day month weekday), e.g. "0 6 * * *"; this one has ${parts.length}`;
  const sets: Set<number>[] = [];
  for (const [index, field] of SCHEDULE_FIELDS.entries()) {
    const parsed = parseScheduleField(parts[index] ?? '', field);
    if (typeof parsed === 'string') return parsed;
    sets.push(parsed);
  }
  const [minutes, hours, days, months, weekdays] = sets;
  if (!minutes || !hours || !days || !months || !weekdays) return 'A schedule has five fields';
  return { minutes, hours, days, months, weekdays, anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' };
}

function dayMatches(schedule: AutomationSchedule, at: Date): boolean {
  const day = schedule.days.has(at.getUTCDate());
  const weekday = schedule.weekdays.has(at.getUTCDay());
  if (schedule.anyDay && schedule.anyWeekday) return true;
  if (schedule.anyDay) return weekday;
  if (schedule.anyWeekday) return day;
  return day || weekday;
}

function nextFromSchedule(schedule: AutomationSchedule, after: number): number | null {
  const limit = new Date(after).getUTCFullYear() + SCHEDULE_HORIZON_YEARS;
  let at = new Date(Math.floor(after / 60_000) * 60_000 + 60_000);
  while (at.getUTCFullYear() <= limit) {
    const year = at.getUTCFullYear(), month = at.getUTCMonth(), date = at.getUTCDate(), hour = at.getUTCHours();
    if (!schedule.months.has(month + 1)) at = new Date(Date.UTC(year, month + 1, 1));
    else if (!dayMatches(schedule, at)) at = new Date(Date.UTC(year, month, date + 1));
    else if (!schedule.hours.has(hour)) at = new Date(Date.UTC(year, month, date, hour + 1));
    else if (!schedule.minutes.has(at.getUTCMinutes())) at = new Date(at.getTime() + 60_000);
    else return at.getTime();
  }
  return null;
}

/** Parses a five-field UTC cron expression; refuses one that never runs within five years. */
export function parseAutomationSchedule(expression: string): { schedule: AutomationSchedule } | { error: string } {
  const schedule = scheduleFields(expression);
  if (typeof schedule === 'string') return { error: schedule };
  if (nextFromSchedule(schedule, Date.UTC(2024, 0, 1)) === null) return { error: `"${expression.trim()}" never runs` };
  return { schedule };
}

/** The first run strictly after `after` (epoch ms), on a whole UTC minute. */
export function nextAutomationRunAt(expression: string, after: number): number {
  const parsed = parseAutomationSchedule(expression);
  if ('error' in parsed) throw new Error(parsed.error);
  const next = nextFromSchedule(parsed.schedule, after);
  if (next === null) throw new Error(`"${expression.trim()}" has no run within ${SCHEDULE_HORIZON_YEARS} years`);
  return next;
}

/** Plain words for the common shapes ("Every day at 06:00 UTC"); anything else reads back as the expression. */
export function describeAutomationSchedule(expression: string): string {
  const trimmed = expression.trim();
  const parsed = parseAutomationSchedule(trimmed);
  if ('error' in parsed) return parsed.error;
  const [minuteText = '', hourText = '', dayText = '', monthText = '', weekdayText = ''] = trimmed.split(/\s+/u);
  const { schedule } = parsed;
  const minute = schedule.minutes.size === 1 ? [...schedule.minutes][0] ?? null : null;
  const hour = schedule.hours.size === 1 ? [...schedule.hours][0] ?? null : null;
  const clock = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} UTC`;
  const everyDay = dayText === '*' && monthText === '*';
  const step = (text: string) => /^\*\/(\d+)$/u.exec(text)?.[1];
  if (everyDay && weekdayText === '*' && hourText === '*' && step(minuteText)) return `Every ${step(minuteText)} minutes`;
  if (everyDay && weekdayText === '*' && hourText === '*' && minute !== null) return `Every hour at :${String(minute).padStart(2, '0')}`;
  if (everyDay && weekdayText === '*' && step(hourText) && minute !== null) return `Every ${step(hourText)} hours at :${String(minute).padStart(2, '0')}`;
  if (everyDay && minute !== null && hour !== null) {
    if (weekdayText === '*') return `Every day at ${clock(hour, minute)}`;
    const weekdays = [...schedule.weekdays].sort((a, b) => a - b);
    if (weekdays.join(',') === '1,2,3,4,5') return `Weekdays at ${clock(hour, minute)}`;
    const names = weekdays.map(day => `${WEEKDAY_NAMES[day]}s`);
    return `${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} at ${clock(hour, minute)}`;
  }
  return `${trimmed} (UTC)`;
}

// GitHub events (docs/AUTOMATIONS-DESIGN.md §4).

/** The events the GitHub App subscribes to that an automation can start on. */
export const AUTOMATION_GITHUB_EVENTS = ['pull_request', 'pull_request_review', 'pull_request_review_comment', 'issues', 'issue_comment', 'push', 'check_suite'] as const;
export type AutomationGitHubEvent = (typeof AUTOMATION_GITHUB_EVENTS)[number];
export const AUTOMATION_EVENT_LABEL: Record<AutomationGitHubEvent, string> = {
  pull_request: 'Pull request', pull_request_review: 'Pull request review', pull_request_review_comment: 'Review comment',
  issues: 'Issue', issue_comment: 'Issue or pull request comment', push: 'Push', check_suite: 'Check suite',
};
/** The actions a trigger may choose per event; a push has none and runs on every push. */
export const AUTOMATION_EVENT_ACTIONS: Record<AutomationGitHubEvent, readonly string[]> = {
  pull_request: ['opened', 'ready_for_review', 'synchronize', 'reopened', 'closed', 'labeled', 'edited', 'converted_to_draft'],
  pull_request_review: ['submitted', 'edited', 'dismissed'],
  pull_request_review_comment: ['created', 'edited'],
  issues: ['opened', 'closed', 'reopened', 'labeled', 'edited'],
  issue_comment: ['created', 'edited'],
  push: [],
  check_suite: ['completed', 'requested', 'rerequested'],
};

export const AUTOMATION_MODES = ['plan', 'code', 'review', 'ship'] as const;
export type AutomationMode = (typeof AUTOMATION_MODES)[number];
/** A label trigger starts on these labels, each naming the mode a started workspace begins in. */
export const AUTOMATION_START_LABELS: Readonly<Record<string, AutomationMode>> = { 'gitspace:plan': 'plan', 'gitspace:code': 'code', 'gitspace:review': 'review', 'gitspace:ship': 'ship' };

/** What a watch trigger starts on (docs/AUTOMATIONS-DESIGN.md §4a): a published GitHub Release, a new tag, or a
 * deployment's status. Each arrives as an event: `release`, `tag` (or a tag `push` by webhook), `deployment_status`. */
export const AutomationWatchOnSchema = z.enum(['release', 'tag', 'deployment']);
export type AutomationWatchOn = z.infer<typeof AutomationWatchOnSchema>;
export const AUTOMATION_WATCH_LABEL: Record<AutomationWatchOn, string> = { release: 'Release', tag: 'Tag', deployment: 'Deployment' };
/** How often a watched repository is checked when its events do not arrive by webhook; daily unless chosen. */
export const AutomationWatchEverySchema = z.enum(['daily', 'every-6-hours', 'hourly', 'every-15-minutes']);
export type AutomationWatchEvery = z.infer<typeof AutomationWatchEverySchema>;
export const AUTOMATION_WATCH_EVERY_MS: Record<AutomationWatchEvery, number> = { daily: 86_400_000, 'every-6-hours': 21_600_000, hourly: 3_600_000, 'every-15-minutes': 900_000 };
export const AUTOMATION_WATCH_EVERY_LABEL: Record<AutomationWatchEvery, string> = { daily: 'Once a day', 'every-6-hours': 'Every 6 hours', hourly: 'Every hour', 'every-15-minutes': 'Every 15 minutes' };

// Triggers, conditions, actions and instructions. Each is one zod schema: the wire codec, the automations object's
// stored JSON and the project agent's tool all read it.

const AutomationEventTriggerSchema = z.object({
  event: z.enum(AUTOMATION_GITHUB_EVENTS),
  actions: z.array(z.string().min(1).max(60)).max(20),
}).strict();
export const AutomationTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule'), cron: z.string().min(1).max(200) }).strict(),
  z.object({ kind: z.literal('manual') }).strict(),
  /** One or more GitHub events, each with the actions it starts on. */
  z.object({ kind: z.literal('github'), events: z.array(AutomationEventTriggerSchema).min(1).max(AUTOMATION_GITHUB_EVENTS.length) }).strict(),
  /** A `gitspace:plan`, `gitspace:code`, `gitspace:review` or `gitspace:ship` label added to an issue or pull request. */
  z.object({ kind: z.literal('label') }).strict(),
  /** A repository publishing something: `repository` null watches the project's own repository, or its upstream parent
   * when it is a fork; any other is an `owner/name` the account can read. */
  z.object({ kind: z.literal('watch'), repository: z.string().regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/u, 'A watched repository is owner/name').nullable(), on: AutomationWatchOnSchema, every: AutomationWatchEverySchema }).strict(),
]);
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>;
export type AutomationTriggerKind = AutomationTrigger['kind'];
export const AutomationTriggerCodec = wire.serializable((value): value is AutomationTrigger => AutomationTriggerSchema.safeParse(value).success, { id: 'gitspace/automation-trigger/v2', jsonSchema: AutomationTriggerSchema });

const conditionValues = z.array(z.string().min(1).max(200)).min(1).max(50);
const listCondition = <K extends string>(kind: K) => z.object({ kind: z.literal(kind), mode: z.enum(['oneOf', 'noneOf']), values: conditionValues }).strict();
/** Filters on the event, at most one of each; all must pass. Values may be patterns: `*` within a path segment, `**`
 * across segments. */
export const AutomationConditionSchema = z.discriminatedUnion('kind', [
  /** The event's pull request, issue or branch has a linked workspace (or has none). */
  z.object({ kind: z.literal('linked'), linked: z.boolean() }).strict(),
  /** The comment or review mentions the tenant's bot. */
  z.object({ kind: z.literal('mentionsBot') }).strict(),
  listCondition('baseBranch'),
  listCondition('headBranch'),
  listCondition('branch'),
  listCondition('author'),
  /** `oneOf`: has any of the labels; `noneOf`: has none of them. */
  listCondition('labels'),
  /** `oneOf`: touches any of the paths; `noneOf`: touches none of them. */
  listCondition('changedFiles'),
  /** `draft: false` passes only pull requests that are not drafts. */
  z.object({ kind: z.literal('draft'), draft: z.boolean() }).strict(),
  z.object({ kind: z.literal('conclusion'), values: conditionValues }).strict(),
  z.object({ kind: z.literal('reviewState'), values: conditionValues }).strict(),
  /** A watched release's or tag's name. */
  listCondition('tag'),
  /** `prerelease: false` passes only releases that are not prereleases. */
  z.object({ kind: z.literal('prerelease'), prerelease: z.boolean() }).strict(),
  /** A watched deployment's environment (`preview`, `production`). */
  listCondition('environment'),
  /** A watched deployment's state (`success`, `failure`, `error`, …). */
  z.object({ kind: z.literal('deploymentState'), values: conditionValues }).strict(),
]);
export type AutomationCondition = z.infer<typeof AutomationConditionSchema>;
export type AutomationConditionKind = AutomationCondition['kind'];
export const AutomationConditionCodec = wire.serializable((value): value is AutomationCondition => AutomationConditionSchema.safeParse(value).success, { id: 'gitspace/automation-condition/v1', jsonSchema: AutomationConditionSchema });

/** The conditions each event offers. */
export const AUTOMATION_EVENT_CONDITIONS: Record<AutomationGitHubEvent, readonly AutomationConditionKind[]> = {
  pull_request: ['linked', 'baseBranch', 'headBranch', 'author', 'draft', 'labels', 'changedFiles'],
  pull_request_review: ['linked', 'mentionsBot', 'baseBranch', 'author', 'reviewState'],
  pull_request_review_comment: ['linked', 'mentionsBot', 'baseBranch', 'author'],
  issues: ['linked', 'author', 'labels'],
  issue_comment: ['linked', 'mentionsBot', 'author', 'labels'],
  push: ['linked', 'branch', 'author', 'changedFiles'],
  check_suite: ['linked', 'branch', 'conclusion'],
};

/** The conditions each watched kind offers. */
export const AUTOMATION_WATCH_CONDITIONS: Record<AutomationWatchOn, readonly AutomationConditionKind[]> = {
  release: ['tag', 'prerelease', 'author'],
  tag: ['tag'],
  deployment: ['environment', 'deploymentState', 'author'],
};

/** The conditions a trigger offers: those every one of its events offers, or its watched kind's. Schedules, manual runs
 * and labels offer none. */
export function automationConditionKinds(trigger: AutomationTrigger): readonly AutomationConditionKind[] {
  if (trigger.kind === 'watch') return AUTOMATION_WATCH_CONDITIONS[trigger.on];
  if (trigger.kind !== 'github') return [];
  const [first, ...rest] = trigger.events;
  if (!first) return [];
  return AUTOMATION_EVENT_CONDITIONS[first.event].filter(kind => rest.every(entry => AUTOMATION_EVENT_CONDITIONS[entry.event].includes(kind)));
}

/** The project agent's workspace id is its project's id. */
export const AutomationActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('messageProjectAgent'), instruction: z.string().max(16_000) }).strict(),
  z.object({ kind: z.literal('messageWorkspace'), workspaceId: z.string().min(1).max(200), instruction: z.string().max(16_000) }).strict(),
  /** A new workspace for the event's pull request, issue or branch, linked to it; the rendered instruction and the event
   * are its first message. `mode` null (a label trigger only) starts in the label's mode. `role` is the model role of
   * the project's inference profile its first run uses, set on its session as a person switching role sets it; absent,
   * the profile's default role. */
  z.object({ kind: z.literal('startWorkspace'), mode: z.enum(AUTOMATION_MODES).nullable(), role: z.string().min(1).max(100).optional(), instruction: z.string().max(16_000) }).strict(),
  /** The workspace linked to the event's subject: `wake` starts its agent, otherwise a notice leaves it asleep. With no
   * linked workspace the run is skipped, or with `orProjectAgent` goes to the project agent. */
  z.object({ kind: z.literal('sendToLinked'), wake: z.boolean(), orProjectAgent: z.boolean(), instruction: z.string().max(16_000) }).strict(),
]);
export type AutomationAction = z.infer<typeof AutomationActionSchema>;
export const AutomationActionCodec = wire.serializable((value): value is AutomationAction => AutomationActionSchema.safeParse(value).success, { id: 'gitspace/automation-action/v2', jsonSchema: AutomationActionSchema });

export interface AutomationField { path: string; label: string }
const NAME_FIELD: AutomationField = { path: 'automation.name', label: 'Automation name' };
/** Every GitHub event and label provides these. */
const EVENT_COMMON_FIELDS: readonly AutomationField[] = [
  NAME_FIELD, { path: 'subject.title', label: 'Pull request, issue or branch' }, { path: 'subject.url', label: 'Its link' },
  { path: 'action', label: 'Action' }, { path: 'sender.login', label: 'Sent by' }, { path: 'repository.full_name', label: 'Repository' },
];
const PULL_REQUEST_FIELDS: readonly AutomationField[] = [
  { path: 'pull_request.html_url', label: 'Pull request link' }, { path: 'pull_request.title', label: 'Pull request title' }, { path: 'pull_request.number', label: 'Pull request number' },
  { path: 'pull_request.user.login', label: 'Pull request author' }, { path: 'pull_request.base.ref', label: 'Base branch' }, { path: 'pull_request.head.ref', label: 'Head branch' },
];
/** Fields an instruction may name in `{{…}}`, per event; the run fills them in from the event. */
export const AUTOMATION_EVENT_FIELDS: Record<AutomationGitHubEvent, readonly AutomationField[]> = {
  pull_request: [...PULL_REQUEST_FIELDS, { path: 'pull_request.body', label: 'Description' }],
  pull_request_review: [{ path: 'review.html_url', label: 'Review link' }, { path: 'review.user.login', label: 'Reviewer' }, { path: 'review.state', label: 'Review state' }, { path: 'review.body', label: 'Review text' }, ...PULL_REQUEST_FIELDS],
  pull_request_review_comment: [{ path: 'comment.html_url', label: 'Comment link' }, { path: 'comment.user.login', label: 'Commenter' }, { path: 'comment.body', label: 'Comment' }, { path: 'comment.path', label: 'File' }, ...PULL_REQUEST_FIELDS],
  issues: [{ path: 'issue.html_url', label: 'Issue link' }, { path: 'issue.title', label: 'Issue title' }, { path: 'issue.number', label: 'Issue number' }, { path: 'issue.user.login', label: 'Issue author' }, { path: 'issue.body', label: 'Description' }],
  issue_comment: [{ path: 'comment.html_url', label: 'Comment link' }, { path: 'comment.user.login', label: 'Commenter' }, { path: 'comment.body', label: 'Comment' }, { path: 'issue.html_url', label: 'Issue or pull request link' }, { path: 'issue.title', label: 'Issue or pull request title' }, { path: 'issue.number', label: 'Number' }],
  push: [{ path: 'ref', label: 'Ref' }, { path: 'after', label: 'New head commit' }, { path: 'compare', label: 'Compare link' }, { path: 'head_commit.message', label: 'Commit message' }],
  check_suite: [{ path: 'check_suite.head_branch', label: 'Branch' }, { path: 'check_suite.head_sha', label: 'Commit' }, { path: 'check_suite.conclusion', label: 'Conclusion' }],
};
/** Fields an instruction may name per watched kind (docs/AUTOMATIONS-DESIGN.md §4a). */
export const AUTOMATION_WATCH_FIELDS: Record<AutomationWatchOn, readonly AutomationField[]> = {
  release: [{ path: 'release.tag', label: 'Release tag' }, { path: 'release.name', label: 'Release name' }, { path: 'release.url', label: 'Release link' }, { path: 'release.notes', label: 'Release notes' }, { path: 'release.published_at', label: 'Published at' }],
  tag: [{ path: 'tag.name', label: 'Tag' }, { path: 'tag.commit', label: 'Tagged commit' }, { path: 'tag.url', label: 'Tag link' }],
  deployment: [{ path: 'deployment.environment', label: 'Environment' }, { path: 'deployment.state', label: 'State' }, { path: 'deployment.sha', label: 'Commit' }, { path: 'deployment.ref', label: 'Ref' }, { path: 'deployment.url', label: 'Deployment link' }, { path: 'deployment.creator', label: 'Created by' }],
};

/** The fields a trigger provides: for several events, those every one of them has. */
export function automationFields(trigger: AutomationTrigger): readonly AutomationField[] {
  switch (trigger.kind) {
    case 'schedule': return [NAME_FIELD, { path: 'scheduled_for', label: 'Scheduled time' }];
    case 'manual': return [NAME_FIELD, { path: 'requested_by', label: 'Requested by' }];
    case 'label': return [...EVENT_COMMON_FIELDS, { path: 'label.name', label: 'Label' }];
    case 'watch': return [NAME_FIELD, { path: 'repository.full_name', label: 'Repository' }, ...AUTOMATION_WATCH_FIELDS[trigger.on]];
    case 'github': {
      const [first, ...rest] = trigger.events;
      const shared = first ? AUTOMATION_EVENT_FIELDS[first.event].filter(field => rest.every(entry => AUTOMATION_EVENT_FIELDS[entry.event].some(other => other.path === field.path))) : [];
      return [...EVENT_COMMON_FIELDS, ...shared];
    }
  }
}

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/gu;

/** Placeholders the trigger does not provide; an automation naming one is refused when saved. */
export function unknownAutomationPlaceholders(instruction: string, trigger: AutomationTrigger): string[] {
  const known = new Set(automationFields(trigger).map(field => field.path));
  return [...new Set([...instruction.matchAll(PLACEHOLDER)].map(match => match[1] ?? ''))].filter(path => !known.has(path));
}

export function renderAutomationInstruction(instruction: string, values: Readonly<Record<string, string>>): string {
  return instruction.replace(PLACEHOLDER, (_text, path: string) => values[path] ?? '');
}

// Subjects and links.

/** What an event is about: a pull request, an issue, or a branch. */
export const AutomationSubjectSchema = z.object({
  kind: z.enum(['pullRequest', 'issue', 'branch']),
  number: z.number().int().positive().nullable(),
  branch: z.string().nullable(),
  title: z.string(),
  url: z.string().nullable(),
}).strict();
export type AutomationSubject = z.infer<typeof AutomationSubjectSchema>;
export const AutomationSubjectCodec = wire.serializable((value): value is AutomationSubject => AutomationSubjectSchema.safeParse(value).success, { id: 'gitspace/automation-subject/v1', jsonSchema: AutomationSubjectSchema });

/** A pull request, issue or branch as a person or agent names one to link. */
export const AutomationSubjectRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pullRequest'), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('issue'), number: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal('branch'), branch: z.string().min(1).max(255) }).strict(),
]);
export type AutomationSubjectRef = z.infer<typeof AutomationSubjectRefSchema>;
export const AutomationSubjectRefCodec = wire.serializable((value): value is AutomationSubjectRef => AutomationSubjectRefSchema.safeParse(value).success, { id: 'gitspace/automation-subject-ref/v1', jsonSchema: AutomationSubjectRefSchema });

/** The key a subject is linked under: `pr:12`, `issue:7`, `branch:main`. */
export function automationSubjectKey(subject: AutomationSubjectRef | AutomationSubject): string {
  return subject.kind === 'branch' ? `branch:${subject.branch ?? ''}` : `${subject.kind === 'pullRequest' ? 'pr' : 'issue'}:${subject.number ?? 0}`;
}

/** "PR #12", "Issue #7", "Branch main". */
export function automationSubjectName(subject: AutomationSubjectRef | AutomationSubject): string {
  return subject.kind === 'branch' ? `Branch ${subject.branch ?? ''}` : `${subject.kind === 'pullRequest' ? 'PR' : 'Issue'} #${subject.number ?? 0}`;
}

/** How a link was made, strongest first: a person or an agent, a workspace started for it, or its branch (a pull
 * request from a workspace's branch, or an issue that pull request closes). */
export const AutomationLinkSourceCodec = wire.enum(['person', 'agent', 'started', 'branch', 'closes']);
export type AutomationLinkSource = InputOf<typeof AutomationLinkSourceCodec>;

export const AutomationLinkViewCodec = wire.object({
  subject: AutomationSubjectCodec,
  workspaceId: wire.string,
  source: AutomationLinkSourceCodec,
  /** Who linked it, or the automation and label, or the branch. */
  detail: wire.string,
  linkedAt: wire.date,
  lastActivity: wire.nullable(wire.object({ at: wire.date, label: wire.string })),
});
export type AutomationLinkView = InputOf<typeof AutomationLinkViewCodec>;

/** A delivery the GitHub App recorded for the project's repository, as Test with a past event offers it. */
export const AutomationRecordedEventCodec = wire.object({
  deliveryId: wire.string,
  event: wire.string,
  label: wire.string,
  receivedAt: wire.date,
});
export type AutomationRecordedEvent = InputOf<typeof AutomationRecordedEventCodec>;

// Automations, proposals and runs.

export const AutomationDraftSchema = z.object({
  name: z.string().max(200),
  trigger: AutomationTriggerSchema,
  conditions: z.array(AutomationConditionSchema).max(12),
  action: AutomationActionSchema,
  enabled: z.boolean(),
}).strict();
export type AutomationDraft = z.infer<typeof AutomationDraftSchema>;
export const AutomationDraftCodec = wire.serializable((value): value is AutomationDraft => AutomationDraftSchema.safeParse(value).success, { id: 'gitspace/automation-draft/v2', jsonSchema: AutomationDraftSchema });

/** One line of a test: what a draft would do with a past event, or at a coming schedule time. */
export const AutomationTestResultCodec = wire.object({ label: wire.string, result: wire.string, runs: wire.boolean });
export type AutomationTestResult = InputOf<typeof AutomationTestResultCodec>;

/** A trust or condition check of a run: passed, failed, or not checked because an earlier one failed. */
export const AutomationCheckCodec = wire.object({ label: wire.string, passed: wire.nullable(wire.boolean) });
export type AutomationCheck = InputOf<typeof AutomationCheckCodec>;

/** A test: one line per schedule time or recorded event; for one recorded event, its checks and the instruction as the
 * agent would read it. */
export const AutomationTestCodec = wire.object({ results: wire.array(AutomationTestResultCodec), instruction: wire.string, checks: wire.array(AutomationCheckCodec) });
export type AutomationTest = InputOf<typeof AutomationTestCodec>;

/** A new automation or a change made by the project agent; it does not run until a person approves it. */
export const AutomationProposalCodec = wire.object({
  conversationId: wire.string,
  asked: wire.string,
  reason: wire.string,
  tested: wire.array(AutomationTestResultCodec),
  proposedAt: wire.date,
});
export type AutomationProposal = InputOf<typeof AutomationProposalCodec>;

export const AutomationRunStateCodec = wire.enum(['queued', 'running', 'finished', 'skipped', 'failed']);
export type AutomationRunState = InputOf<typeof AutomationRunStateCodec>;

export const AutomationViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  revision: wire.integer({ min: 1 }),
  name: wire.string,
  trigger: AutomationTriggerCodec,
  conditions: wire.array(AutomationConditionCodec),
  action: AutomationActionCodec,
  enabled: wire.boolean,
  createdBy: wire.enum(['person', 'projectAgent']),
  /** One of the automations installing the GitHub App adds; editable and removable like any other. */
  isDefault: wire.boolean,
  /** Set while it waits for a person; a proposed automation never runs. */
  proposal: wire.nullable(AutomationProposalCodec),
  nextRunAt: wire.nullable(wire.date),
  lastRun: wire.nullable(wire.object({ at: wire.date, state: AutomationRunStateCodec })),
  createdAt: wire.date,
  updatedAt: wire.date,
});
export type AutomationView = InputOf<typeof AutomationViewCodec>;

export const AutomationRunViewCodec = wire.object({
  id: wire.string,
  projectId: wire.string,
  automationId: wire.string,
  automationName: wire.string,
  trigger: wire.enum(['schedule', 'manual', 'github', 'label']),
  /** The GitHub event and action, `pull_request.opened`; null for a schedule or manual run. */
  event: wire.nullable(wire.string),
  subject: wire.nullable(AutomationSubjectCodec),
  state: AutomationRunStateCodec,
  /** Null until it has a target: skipped before it had one, or a workspace not yet started. */
  workspaceId: wire.nullable(wire.string),
  /** Why it was skipped or failed, or what it did. */
  outcome: wire.nullable(wire.string),
  checks: wire.array(AutomationCheckCodec),
  timeline: wire.array(wire.object({ at: wire.date, label: wire.string })),
  scheduledFor: wire.date,
  startedAt: wire.nullable(wire.date),
  finishedAt: wire.nullable(wire.date),
});
export type AutomationRunView = InputOf<typeof AutomationRunViewCodec>;

/** Limits and the trust list every automation of a project runs under; only people change them. */
export const AutomationSettingsCodec = wire.object({
  concurrency: wire.integer({ min: 1, max: 10 }),
  dailyRunCap: wire.integer({ min: 1, max: 1000 }),
  /** GitHub logins whose events run without write access to the repository. */
  trusted: wire.array(wire.string),
});
export type AutomationSettings = InputOf<typeof AutomationSettingsCodec>;
export const AUTOMATION_DEFAULT_SETTINGS: AutomationSettings = { concurrency: 2, dailyRunCap: 50, trusted: [] };

/** The project's GitHub side, as the page shows it: its repository and the tenant's bot to mention. */
export const AutomationGitHubCodec = wire.object({ repository: wire.nullable(wire.string), bot: wire.nullable(wire.string) });
export type AutomationGitHub = InputOf<typeof AutomationGitHubCodec>;

export const AutomationProjectSummaryCodec = wire.object({
  projectId: wire.string,
  total: wire.integer({ min: 0 }),
  on: wire.integer({ min: 0 }),
  proposed: wire.integer({ min: 0 }),
  working: wire.integer({ min: 0 }),
  queued: wire.integer({ min: 0 }),
  failedToday: wire.integer({ min: 0 }),
});
export type AutomationProjectSummary = InputOf<typeof AutomationProjectSummaryCodec>;

export const automationErrors = defineErrors('gitspace-automations', {
  automationNotFound: { data: wire.object({ projectId: wire.string, automationId: wire.string }), httpStatus: 404 },
  automationInvalid: { data: wire.object({ field: wire.string, message: wire.string }), httpStatus: 400 },
  automationAlreadyRunning: { data: wire.object({ automationId: wire.string, runId: wire.string }), httpStatus: 409 },
  runNotFound: { data: wire.object({ projectId: wire.string, runId: wire.string }), httpStatus: 404 },
});
