import { Edit03, Link01, LinkBroken01, Play, Plus, RefreshCcw01, Settings01, Trash01 } from '@untitledui/icons';
import { AUTOMATION_MODES, AUTOMATION_WATCH_LABEL, automationSubjectName, type AutomationAction, type AutomationCondition, type AutomationConditionKind, type AutomationGitHub, type AutomationGitHubEvent, type AutomationLinkSource, type AutomationMode, type AutomationRunState, type AutomationSubject, type AutomationSubjectRef, type AutomationTrigger, type AutomationTriggerKind, type AutomationWatchEvery, type AutomationWatchOn } from '@gitspace/protocol/automations-contract';
import { glyph } from '../glyph.js';
import { type AutomationsProject } from './AutomationsPage.js';

export const PROJECT_RUN_LIMIT = 50;
export const RECORDED_EVENT_LIMIT = 20;
export const NO_GITHUB: AutomationGitHub = { repository: null, bot: null };

type BadgeColor = 'blue' | 'amber' | 'green' | 'gray' | 'red';
export const RUN_STATE_COLOR: Record<AutomationRunState, BadgeColor> = { running: 'blue', queued: 'amber', finished: 'green', skipped: 'gray', failed: 'red' };
export const MODE_LABEL: Record<AutomationMode, string> = { plan: 'Plan', code: 'Code', review: 'Review', ship: 'Ship' };
export const MODE_COLOR: Record<AutomationMode, 'indigo' | 'emerald' | 'violet' | 'amber'> = { plan: 'indigo', code: 'emerald', review: 'violet', ship: 'amber' };
/** The actions a workspace's phase limits: the others start a workspace or message the project agent. */
export const PHASE_ACTIONS: readonly AutomationAction['kind'][] = ['sendToLinked', 'messageWorkspace'];
export const TRIGGER_KINDS: readonly AutomationTriggerKind[] = ['github', 'label', 'watch', 'schedule', 'manual'];
export const TRIGGER_OPTION_LABEL: Record<AutomationTriggerKind, string> = { github: 'GitHub event', label: 'Label added', watch: 'Watch a repository', schedule: 'Schedule', manual: 'Manual only' };
/** What an instruction's placeholders are checked against, in the editor's refusal. */
export const TRIGGER_NOUN: Record<AutomationTriggerKind, string> = { github: 'the chosen events', label: 'a label event', watch: 'what is watched', schedule: 'a schedule', manual: 'a manual run' };
export const OFF_NOTE: Record<AutomationTriggerKind, string> = { github: 'Off: events are not recorded as runs', label: 'Off: events are not recorded as runs', watch: 'Off: its repository is not watched', schedule: 'Off: its schedule starts no runs', manual: 'Off: it starts no runs' };
export type ActionKind = AutomationAction['kind'];
const EVENT_ACTION_KINDS: readonly ActionKind[] = ['startWorkspace', 'sendToLinked', 'messageWorkspace', 'messageProjectAgent'];
const MESSAGE_ACTION_KINDS: readonly ActionKind[] = ['messageWorkspace', 'messageProjectAgent'];
/** Sending to the linked workspace needs the pull request, issue or branch an event is about; a watched release, tag
 * or deployment can start a workspace of its own. */
export const TRIGGER_ACTIONS: Record<AutomationTriggerKind, readonly ActionKind[]> = { github: EVENT_ACTION_KINDS, label: EVENT_ACTION_KINDS, watch: ['startWorkspace', 'messageWorkspace', 'messageProjectAgent'], schedule: MESSAGE_ACTION_KINDS, manual: MESSAGE_ACTION_KINDS };
export const WATCH_ONS: readonly AutomationWatchOn[] = ['release', 'tag', 'deployment'];
export const WATCH_EVERY: readonly AutomationWatchEvery[] = ['daily', 'every-6-hours', 'hourly', 'every-15-minutes'];
export const WATCH_NOUN: Record<AutomationWatchOn, string> = { release: 'releases', tag: 'tags', deployment: 'deployments' };
export const ACTION_LABEL: Record<ActionKind, string> = { startWorkspace: 'Start a workspace for the subject', sendToLinked: 'Send to the linked workspace', messageWorkspace: 'Message a workspace', messageProjectAgent: 'Message the project agent' };
/** The Mode choice that leaves the mode to the label; only a label trigger offers it. */
export const LABEL_MODE = 'label';
/** The role a started workspace runs as when the action names none. */
export const DEFAULT_ROLE = 'default';
export const DELIVERY_OPTIONS: readonly { value: string; label: string }[] = [{ value: 'wake', label: 'Wakes the agent' }, { value: 'notice', label: 'A notice; the agent stays asleep' }];
/** The Recorded event choice that tests the recent deliveries the trigger starts on. */
export const RECENT_EVENTS = 'recent';

export interface EventChoice {
  event: AutomationGitHubEvent;
  actions: readonly string[];
}
export const NEW_EVENT: EventChoice = { event: 'pull_request', actions: ['opened', 'ready_for_review'] };
export const EVENT_NOUN: Record<AutomationGitHubEvent, string> = {
  pull_request: 'pull requests', pull_request_review: 'reviews', pull_request_review_comment: 'review comments', issues: 'issues', issue_comment: 'comments', push: 'pushes', check_suite: 'check suites',
};
/** What a workspace started for an event is for. */
const EVENT_SUBJECT: Record<AutomationGitHubEvent, string> = {
  pull_request: 'the pull request', pull_request_review: 'the pull request', pull_request_review_comment: 'the pull request', issues: 'the issue', issue_comment: 'the pull request or issue', push: 'the branch', check_suite: 'the branch',
};

type ListConditionKind = Extract<AutomationCondition, { mode: 'oneOf' | 'noneOf' }>['kind'];
export type ValuesConditionKind = Extract<AutomationCondition, { values: string[] }>['kind'];
type ListMode = 'oneOf' | 'noneOf';
export const LIST_MODES: readonly ListMode[] = ['oneOf', 'noneOf'];
export const CONDITION_LABEL: Record<AutomationConditionKind, string> = {
  linked: 'Linked', mentionsBot: 'Mentions', baseBranch: 'Base branch', headBranch: 'Head branch', branch: 'Branch', author: 'Author', draft: 'Draft', labels: 'Labels', changedFiles: 'Changed files', conclusion: 'Conclusion', reviewState: 'Review state',
  tag: 'Tag', prerelease: 'Prerelease', environment: 'Environment', deploymentState: 'State',
};
export const LIST_RULE: Record<ListConditionKind, Record<ListMode, string>> = {
  baseBranch: { oneOf: 'is one of', noneOf: 'is not one of' },
  headBranch: { oneOf: 'is one of', noneOf: 'is not one of' },
  branch: { oneOf: 'is one of', noneOf: 'is not one of' },
  author: { oneOf: 'is one of', noneOf: 'is not one of' },
  labels: { oneOf: 'has any of', noneOf: 'has none of' },
  changedFiles: { oneOf: 'touch any of', noneOf: 'touch none of' },
  tag: { oneOf: 'is one of', noneOf: 'is not one of' },
  environment: { oneOf: 'is one of', noneOf: 'is not one of' },
};
export const LINKED_RULES: readonly { value: string; label: string }[] = [{ value: 'linked', label: 'Is linked' }, { value: 'unlinked', label: 'Is not linked' }];
export const DRAFT_RULES: readonly { value: string; label: string }[] = [{ value: 'ready', label: 'Not a draft' }, { value: 'draft', label: 'Only drafts' }];
export const PRERELEASE_RULES: readonly { value: string; label: string }[] = [{ value: 'stable', label: 'Not a prerelease' }, { value: 'prerelease', label: 'Only prereleases' }];
export const VALUE_PLACEHOLDER: Record<ValuesConditionKind, string> = {
  baseBranch: 'main', headBranch: 'dependabot/*', branch: 'main', author: 'dependabot[bot]', labels: 'wontfix', changedFiles: 'docs/**', conclusion: 'failure', reviewState: 'approved',
  tag: 'v*', environment: 'preview', deploymentState: 'failure',
};
/** GitHub's own values; branches, authors, labels and paths are typed. */
export const VALUE_SUGGESTIONS: Partial<Record<ValuesConditionKind, readonly string[]>> = {
  conclusion: ['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'],
  reviewState: ['approved', 'changes_requested', 'commented', 'dismissed'],
  deploymentState: ['success', 'failure', 'error', 'inactive', 'in_progress', 'queued', 'pending'],
};

export const LINK_LABEL: Record<AutomationLinkSource, string> = {
  started: 'Started for it', agent: 'Linked by an agent', person: 'Linked by a person', branch: 'Same branch', closes: 'Closed by a linked pull request',
};
export type SubjectKind = AutomationSubjectRef['kind'];
export const SUBJECT_KINDS: readonly SubjectKind[] = ['pullRequest', 'issue', 'branch'];
export const SUBJECT_KIND_LABEL: Record<SubjectKind, string> = { pullRequest: 'Pull request', issue: 'Issue', branch: 'Branch' };

type SchedulePreset = 'hourly' | 'daily' | 'weekly' | 'custom';
export const SCHEDULE_PRESETS: readonly SchedulePreset[] = ['hourly', 'daily', 'weekly', 'custom'];
export const PRESET_LABEL: Record<SchedulePreset, string> = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week', custom: 'Custom cron expression' };
export const WEEKDAYS: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const MINUTES: readonly number[] = Array.from({ length: 60 }, (_, minute) => minute);
export const NEW_AUTOMATION_CRON = '0 6 * * *';

export const PlayGlyph = glyph(Play);
export const EditGlyph = glyph(Edit03);
export const DeleteGlyph = glyph(Trash01);
export const PlusGlyph = glyph(Plus);
export const TestGlyph = glyph(RefreshCcw01);
export const LimitsGlyph = glyph(Settings01);
export const LinkGlyph = glyph(Link01);
export const UnlinkGlyph = glyph(LinkBroken01);

const UTC_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
export const UTC_CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

export function formatUtc(at: Date): string {
  return `${UTC_TIME.format(at)} UTC`;
}

export function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

export async function settle<T>(request: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: Error }>): Promise<T> {
  const result = await request;
  if (result.status === 'error') throw result.error;
  return result.value;
}

/** The editor's schedule: a preset with its time, or a cron expression typed by hand. Times are UTC. */
export interface ScheduleChoice {
  preset: SchedulePreset;
  minute: number;
  hour: number;
  weekday: number;
  custom: string;
}

export function scheduleChoice(cron: string): ScheduleChoice {
  const fields = cron.trim().split(/\s+/u);
  const [minuteText = '', hourText = '', dayText, monthText, weekdayText = ''] = fields;
  const bounded = (text: string, max: number): number | null => /^\d{1,2}$/u.test(text) && Number(text) <= max ? Number(text) : null;
  const minute = bounded(minuteText, 59);
  const hour = bounded(hourText, 23);
  const weekday = bounded(weekdayText, 7);
  const choice: ScheduleChoice = { preset: 'custom', minute: minute ?? 0, hour: hour ?? 6, weekday: 1, custom: cron.trim() };
  if (fields.length !== 5 || minute === null || dayText !== '*' || monthText !== '*') return choice;
  if (hourText === '*' && weekdayText === '*') return { ...choice, preset: 'hourly' };
  if (hour !== null && weekdayText === '*') return { ...choice, preset: 'daily' };
  if (hour !== null && weekday !== null) return { ...choice, preset: 'weekly', weekday: weekday % 7 };
  return choice;
}

export function scheduleCron(choice: ScheduleChoice): string {
  switch (choice.preset) {
    case 'hourly': return `${choice.minute} * * * *`;
    case 'daily': return `${choice.minute} ${choice.hour} * * *`;
    case 'weekly': return `${choice.minute} ${choice.hour} * * ${choice.weekday}`;
    case 'custom': return choice.custom.trim();
  }
}

export function workspaceLabel(project: AutomationsProject | undefined, projectId: string, workspaceId: string): string {
  if (workspaceId === projectId) return 'Project agent';
  return project?.workspaces.find(workspace => workspace.id === workspaceId)?.name ?? workspaceId;
}

/** "Every phase" (no phases), "Review only", "Code · Review"; all four read as every phase. */
export function phasesLabel(phases: readonly AutomationMode[] | undefined | null): string {
  if (!phases || phases.length === AUTOMATION_MODES.length) return 'Every phase';
  const [only] = phases;
  if (phases.length === 1 && only) return `${MODE_LABEL[only]} only`;
  return AUTOMATION_MODES.filter(mode => phases.includes(mode)).map(mode => MODE_LABEL[mode]).join(' · ');
}

/** "PR #1140 · Bounded history for sessions". */
export function subjectTitle(subject: AutomationSubject): string {
  return subject.title ? `${automationSubjectName(subject)} · ${subject.title}` : automationSubjectName(subject);
}

export function subjectRef(subject: AutomationSubject): AutomationSubjectRef | null {
  if (subject.kind === 'branch') return subject.branch ? { kind: 'branch', branch: subject.branch } : null;
  return subject.number ? { kind: subject.kind, number: subject.number } : null;
}

/** A pull request or issue typed as `#1140`, `1140` or its GitHub link (a link names its own kind), or a branch name. */
export function parseSubjectRef(kind: SubjectKind, text: string): AutomationSubjectRef | null {
  const value = text.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues)\/(\d+)(?:[/?#]\S*)?$/u.exec(value);
  if (link) return { kind: link[1] === 'pull' ? 'pullRequest' : 'issue', number: Number(link[2]) };
  if (kind === 'branch') return value ? { kind, branch: value } : null;
  const number = /^#?(\d+)$/u.exec(value);
  return number && Number(number[1]) > 0 ? { kind, number: Number(number[1]) } : null;
}

export function newCondition(kind: AutomationConditionKind): AutomationCondition {
  switch (kind) {
    case 'linked': return { kind, linked: true };
    case 'mentionsBot': return { kind };
    case 'draft': return { kind, draft: false };
    case 'prerelease': return { kind, prerelease: false };
    case 'conclusion':
    case 'reviewState':
    case 'deploymentState': return { kind, values: [] };
    default: return { kind, mode: 'oneOf', values: [] };
  }
}

/** The editor's readback ("into main", "not by dependabot[bot]"), one phrase per condition. */
export function conditionPhrase(condition: AutomationCondition, bot: string): string {
  if (condition.kind === 'linked') return condition.linked ? 'on a linked pull request or issue' : 'with no linked workspace';
  if (condition.kind === 'mentionsBot') return `mentioning ${bot}`;
  if (condition.kind === 'draft') return condition.draft ? 'only drafts' : 'not drafts';
  if (condition.kind === 'prerelease') return condition.prerelease ? 'only prereleases' : 'not prereleases';
  const values = condition.values.join(' or ');
  switch (condition.kind) {
    case 'conclusion': return `that ended ${values}`;
    case 'reviewState': return `that are ${values.replaceAll('_', ' ')}`;
    case 'deploymentState': return `that ended ${values}`;
    case 'tag': return condition.mode === 'noneOf' ? `not tagged ${values}` : `tagged ${values}`;
    case 'environment': return condition.mode === 'noneOf' ? `not to ${values}` : `to ${values}`;
    case 'baseBranch': return condition.mode === 'noneOf' ? `not into ${values}` : `into ${values}`;
    case 'headBranch': return condition.mode === 'noneOf' ? `not from ${values}` : `from ${values}`;
    case 'branch': return condition.mode === 'noneOf' ? `not on ${values}` : `on ${values}`;
    case 'author': return condition.mode === 'noneOf' ? `not by ${values}` : `by ${values}`;
    case 'labels': return condition.mode === 'noneOf' ? `without the label ${values}` : `labeled ${values}`;
    case 'changedFiles': return condition.mode === 'noneOf' ? `not touching ${values}` : `touching ${values}`;
  }
}

export function subjectNoun(trigger: AutomationTrigger): string {
  if (trigger.kind === 'watch') return `the ${AUTOMATION_WATCH_LABEL[trigger.on].toLowerCase()}, on a branch of its own`;
  if (trigger.kind !== 'github') return 'the pull request or issue';
  const [only, ...others] = [...new Set(trigger.events.map(entry => EVENT_SUBJECT[entry.event]))];
  return only && others.length === 0 ? only : 'the pull request, issue or branch';
}
