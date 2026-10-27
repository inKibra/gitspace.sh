import { defineErrors, type InputOf } from 'result-rpc'; import { wire } from './json-wire.js'

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

// Triggers, actions and instructions.

export const AutomationTriggerCodec = wire.union([
  wire.object({ kind: wire.literal('schedule'), cron: wire.string }),
  wire.object({ kind: wire.literal('manual') }),
]);
export type AutomationTrigger = InputOf<typeof AutomationTriggerCodec>;
export type AutomationTriggerKind = AutomationTrigger['kind'];

/** The project agent's workspace id is its project's id. */
export const AutomationActionCodec = wire.union([
  wire.object({ kind: wire.literal('messageProjectAgent'), instruction: wire.string }),
  wire.object({ kind: wire.literal('messageWorkspace'), workspaceId: wire.string, instruction: wire.string }),
]);
export type AutomationAction = InputOf<typeof AutomationActionCodec>;

/** Fields an instruction may name in `{{…}}`, per trigger; the run fills them in. */
export const AUTOMATION_TRIGGER_FIELDS: Record<AutomationTriggerKind, readonly { path: string; label: string }[]> = {
  schedule: [{ path: 'automation.name', label: 'Automation name' }, { path: 'scheduled_for', label: 'Scheduled time' }],
  manual: [{ path: 'automation.name', label: 'Automation name' }, { path: 'requested_by', label: 'Requested by' }],
};
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/gu;

/** Placeholders the trigger does not provide; an automation naming one is refused when saved. */
export function unknownAutomationPlaceholders(instruction: string, trigger: AutomationTriggerKind): string[] {
  const known = new Set(AUTOMATION_TRIGGER_FIELDS[trigger].map(field => field.path));
  return [...new Set([...instruction.matchAll(PLACEHOLDER)].map(match => match[1] ?? ''))].filter(path => !known.has(path));
}

export function renderAutomationInstruction(instruction: string, values: Readonly<Record<string, string>>): string {
  return instruction.replace(PLACEHOLDER, (_text, path: string) => values[path] ?? '');
}

// Automations, proposals and runs.

export const AutomationDraftCodec = wire.object({
  name: wire.string,
  trigger: AutomationTriggerCodec,
  action: AutomationActionCodec,
  enabled: wire.boolean,
});
export type AutomationDraft = InputOf<typeof AutomationDraftCodec>;

/** One line of a test: what a draft would do with a past event, or at a coming schedule time. */
export const AutomationTestResultCodec = wire.object({ label: wire.string, result: wire.string, runs: wire.boolean });
export type AutomationTestResult = InputOf<typeof AutomationTestResultCodec>;

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
  action: AutomationActionCodec,
  enabled: wire.boolean,
  createdBy: wire.enum(['person', 'projectAgent']),
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
  trigger: wire.enum(['schedule', 'manual']),
  state: AutomationRunStateCodec,
  workspaceId: wire.string,
  /** Why it was skipped or failed, or what it did. */
  outcome: wire.nullable(wire.string),
  timeline: wire.array(wire.object({ at: wire.date, label: wire.string })),
  scheduledFor: wire.date,
  startedAt: wire.nullable(wire.date),
  finishedAt: wire.nullable(wire.date),
});
export type AutomationRunView = InputOf<typeof AutomationRunViewCodec>;

/** Limits every automation of a project runs under; only people change them. */
export const AutomationSettingsCodec = wire.object({
  concurrency: wire.integer({ min: 1, max: 10 }),
  dailyRunCap: wire.integer({ min: 1, max: 1000 }),
});
export type AutomationSettings = InputOf<typeof AutomationSettingsCodec>;
export const AUTOMATION_DEFAULT_SETTINGS: AutomationSettings = { concurrency: 2, dailyRunCap: 50 };

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
