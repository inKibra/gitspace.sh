import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  MenuItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ThinkingIndicator,
  useShape,
} from '@gitspace/ui';
import { CheckCircle, ChevronDown, DotsHorizontal, Edit03, Link01, LinkBroken01, MessageChatCircle, MinusCircle, Play, Plus, RefreshCcw01, Settings01, Trash01, XCircle } from '@untitledui/icons';
import { useEffect, useId, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useResultQuery } from 'result-rpc/react';
import {
  AUTOMATION_DEFAULT_SETTINGS,
  AUTOMATION_EVENT_ACTIONS,
  AUTOMATION_EVENT_LABEL,
  AUTOMATION_GITHUB_EVENTS,
  AUTOMATION_MODES,
  AUTOMATION_START_LABELS,
  automationConditionKinds,
  automationErrors,
  automationFields,
  automationSubjectKey,
  automationSubjectName,
  describeAutomationSchedule,
  nextAutomationRunAt,
  parseAutomationSchedule,
  unknownAutomationPlaceholders,
  type AutomationAction,
  type AutomationCheck,
  type AutomationCondition,
  type AutomationConditionKind,
  type AutomationDraft,
  type AutomationGitHub,
  type AutomationGitHubEvent,
  type AutomationLinkSource,
  type AutomationLinkView,
  type AutomationMode,
  type AutomationRunState,
  type AutomationRunView,
  type AutomationSettings,
  type AutomationSubject,
  type AutomationSubjectRef,
  type AutomationTest,
  type AutomationTestResult,
  type AutomationTrigger,
  type AutomationTriggerKind,
  type AutomationView,
} from '@gitspace/protocol/automations-contract';
import { accountLiveKey } from '@gitspace/protocol/live-notice';
import { glyph } from './glyph.js';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';
import { useLiveChanges } from './live-notices.js';
import { formatRelativeTime } from './relative-time.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useEventRefresh } from './SynchronizationProvider.js';
import { useRetainedRead } from './useRetainedRead.js';

export interface AutomationWorkspace {
  id: string;
  name: string;
  /** Closed (archived) workspaces only name past runs; automations cannot message them. */
  active: boolean;
}

export interface AutomationsProject {
  id: string;
  name: string;
  workspaces: readonly AutomationWorkspace[];
}

export interface AutomationsPageProps {
  projects: readonly AutomationsProject[];
  /** The project chosen in the header; null shows every project. */
  projectId: string | null;
  onSelectProject(projectId: string | null): void;
  /** `workspaceId` equal to `projectId` is the project agent. */
  onOpenWorkspace(projectId: string, workspaceId: string): void;
}

/** The page and the sidebar's failed-runs badge read the same overview entry. */
export const AUTOMATIONS_OVERVIEW_INPUT = { limit: 50 };
const PROJECT_RUN_LIMIT = 50;
const RECORDED_EVENT_LIMIT = 20;
const NO_GITHUB: AutomationGitHub = { repository: null, bot: null };

type BadgeColor = 'blue' | 'amber' | 'green' | 'gray' | 'red';
const RUN_STATE_COLOR: Record<AutomationRunState, BadgeColor> = { running: 'blue', queued: 'amber', finished: 'green', skipped: 'gray', failed: 'red' };
const MODE_LABEL: Record<AutomationMode, string> = { plan: 'Plan', code: 'Code', review: 'Review' };
const MODE_COLOR: Record<AutomationMode, 'indigo' | 'emerald' | 'violet'> = { plan: 'indigo', code: 'emerald', review: 'violet' };
const TRIGGER_KINDS: readonly AutomationTriggerKind[] = ['github', 'label', 'schedule', 'manual'];
const TRIGGER_OPTION_LABEL: Record<AutomationTriggerKind, string> = { github: 'GitHub event', label: 'Label added', schedule: 'Schedule', manual: 'Manual only' };
/** What an instruction's placeholders are checked against, in the editor's refusal. */
const TRIGGER_NOUN: Record<AutomationTriggerKind, string> = { github: 'the chosen events', label: 'a label event', schedule: 'a schedule', manual: 'a manual run' };
const OFF_NOTE: Record<AutomationTriggerKind, string> = { github: 'Off: events are not recorded as runs', label: 'Off: events are not recorded as runs', schedule: 'Off: its schedule starts no runs', manual: 'Off: it starts no runs' };
type ActionKind = AutomationAction['kind'];
const EVENT_ACTION_KINDS: readonly ActionKind[] = ['startWorkspace', 'sendToLinked', 'messageWorkspace', 'messageProjectAgent'];
const MESSAGE_ACTION_KINDS: readonly ActionKind[] = ['messageWorkspace', 'messageProjectAgent'];
/** Starting a workspace and sending to the linked one need the pull request, issue or branch an event is about. */
const TRIGGER_ACTIONS: Record<AutomationTriggerKind, readonly ActionKind[]> = { github: EVENT_ACTION_KINDS, label: EVENT_ACTION_KINDS, schedule: MESSAGE_ACTION_KINDS, manual: MESSAGE_ACTION_KINDS };
const ACTION_LABEL: Record<ActionKind, string> = { startWorkspace: 'Start a workspace for the subject', sendToLinked: 'Send to the linked workspace', messageWorkspace: 'Message a workspace', messageProjectAgent: 'Message the project agent' };
/** The Starts in choice that leaves the mode to the label; only a label trigger offers it. */
const LABEL_MODE = 'label';
const DELIVERY_OPTIONS: readonly { value: string; label: string }[] = [{ value: 'wake', label: 'Wakes the agent' }, { value: 'notice', label: 'A notice; the agent stays asleep' }];
/** The Recorded event choice that tests the recent deliveries the trigger starts on. */
const RECENT_EVENTS = 'recent';

interface EventChoice {
  event: AutomationGitHubEvent;
  actions: readonly string[];
}
const NEW_EVENT: EventChoice = { event: 'pull_request', actions: ['opened', 'ready_for_review'] };
const EVENT_NOUN: Record<AutomationGitHubEvent, string> = {
  pull_request: 'pull requests', pull_request_review: 'reviews', pull_request_review_comment: 'review comments', issues: 'issues', issue_comment: 'comments', push: 'pushes', check_suite: 'check suites',
};
/** What a workspace started for an event is for. */
const EVENT_SUBJECT: Record<AutomationGitHubEvent, string> = {
  pull_request: 'the pull request', pull_request_review: 'the pull request', pull_request_review_comment: 'the pull request', issues: 'the issue', issue_comment: 'the pull request or issue', push: 'the branch', check_suite: 'the branch',
};

type ListConditionKind = Extract<AutomationCondition, { mode: 'oneOf' | 'noneOf' }>['kind'];
type ValuesConditionKind = Extract<AutomationCondition, { values: string[] }>['kind'];
type ListMode = 'oneOf' | 'noneOf';
const LIST_MODES: readonly ListMode[] = ['oneOf', 'noneOf'];
const CONDITION_LABEL: Record<AutomationConditionKind, string> = {
  linked: 'Linked', mentionsBot: 'Mentions', baseBranch: 'Base branch', headBranch: 'Head branch', branch: 'Branch', author: 'Author', draft: 'Draft', labels: 'Labels', changedFiles: 'Changed files', conclusion: 'Conclusion', reviewState: 'Review state',
};
const LIST_RULE: Record<ListConditionKind, Record<ListMode, string>> = {
  baseBranch: { oneOf: 'is one of', noneOf: 'is not one of' },
  headBranch: { oneOf: 'is one of', noneOf: 'is not one of' },
  branch: { oneOf: 'is one of', noneOf: 'is not one of' },
  author: { oneOf: 'is one of', noneOf: 'is not one of' },
  labels: { oneOf: 'has any of', noneOf: 'has none of' },
  changedFiles: { oneOf: 'touch any of', noneOf: 'touch none of' },
};
const LINKED_RULES: readonly { value: string; label: string }[] = [{ value: 'linked', label: 'Is linked' }, { value: 'unlinked', label: 'Is not linked' }];
const DRAFT_RULES: readonly { value: string; label: string }[] = [{ value: 'ready', label: 'Not a draft' }, { value: 'draft', label: 'Only drafts' }];
const VALUE_PLACEHOLDER: Record<ValuesConditionKind, string> = {
  baseBranch: 'main', headBranch: 'dependabot/*', branch: 'main', author: 'dependabot[bot]', labels: 'wontfix', changedFiles: 'docs/**', conclusion: 'failure', reviewState: 'approved',
};
/** GitHub's own values; branches, authors, labels and paths are typed. */
const VALUE_SUGGESTIONS: Partial<Record<ValuesConditionKind, readonly string[]>> = {
  conclusion: ['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure'],
  reviewState: ['approved', 'changes_requested', 'commented', 'dismissed'],
};

const LINK_LABEL: Record<AutomationLinkSource, string> = {
  started: 'Started for it', agent: 'Linked by an agent', person: 'Linked by a person', branch: 'Same branch', closes: 'Closed by a linked pull request',
};
type SubjectKind = AutomationSubjectRef['kind'];
const SUBJECT_KINDS: readonly SubjectKind[] = ['pullRequest', 'issue', 'branch'];
const SUBJECT_KIND_LABEL: Record<SubjectKind, string> = { pullRequest: 'Pull request', issue: 'Issue', branch: 'Branch' };

type SchedulePreset = 'hourly' | 'daily' | 'weekly' | 'custom';
const SCHEDULE_PRESETS: readonly SchedulePreset[] = ['hourly', 'daily', 'weekly', 'custom'];
const PRESET_LABEL: Record<SchedulePreset, string> = { hourly: 'Every hour', daily: 'Every day', weekly: 'Every week', custom: 'Custom cron expression' };
const WEEKDAYS: readonly string[] = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MINUTES: readonly number[] = Array.from({ length: 60 }, (_, minute) => minute);
const NEW_AUTOMATION_CRON = '0 6 * * *';

const PlayGlyph = glyph(Play);
const EditGlyph = glyph(Edit03);
const DeleteGlyph = glyph(Trash01);
const PlusGlyph = glyph(Plus);
const TestGlyph = glyph(RefreshCcw01);
const LimitsGlyph = glyph(Settings01);
const LinkGlyph = glyph(Link01);
const UnlinkGlyph = glyph(LinkBroken01);

const UTC_TIME = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });
const UTC_CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZone: 'UTC' });

function formatUtc(at: Date): string {
  return `${UTC_TIME.format(at)} UTC`;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

async function settle<T>(request: Promise<{ status: 'ok'; value: T } | { status: 'error'; error: Error }>): Promise<T> {
  const result = await request;
  if (result.status === 'error') throw result.error;
  return result.value;
}

/** The editor's schedule: a preset with its time, or a cron expression typed by hand. Times are UTC. */
interface ScheduleChoice {
  preset: SchedulePreset;
  minute: number;
  hour: number;
  weekday: number;
  custom: string;
}

function scheduleChoice(cron: string): ScheduleChoice {
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

function scheduleCron(choice: ScheduleChoice): string {
  switch (choice.preset) {
    case 'hourly': return `${choice.minute} * * * *`;
    case 'daily': return `${choice.minute} ${choice.hour} * * *`;
    case 'weekly': return `${choice.minute} ${choice.hour} * * ${choice.weekday}`;
    case 'custom': return choice.custom.trim();
  }
}

function workspaceLabel(project: AutomationsProject | undefined, projectId: string, workspaceId: string): string {
  if (workspaceId === projectId) return 'Project agent';
  return project?.workspaces.find(workspace => workspace.id === workspaceId)?.name ?? workspaceId;
}

/** "PR #1140 · Bounded history for sessions". */
function subjectTitle(subject: AutomationSubject): string {
  return subject.title ? `${automationSubjectName(subject)} · ${subject.title}` : automationSubjectName(subject);
}

function subjectRef(subject: AutomationSubject): AutomationSubjectRef | null {
  if (subject.kind === 'branch') return subject.branch ? { kind: 'branch', branch: subject.branch } : null;
  return subject.number ? { kind: subject.kind, number: subject.number } : null;
}

/** A pull request or issue typed as `#1140`, `1140` or its GitHub link (a link names its own kind), or a branch name. */
function parseSubjectRef(kind: SubjectKind, text: string): AutomationSubjectRef | null {
  const value = text.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/(pull|issues)\/(\d+)(?:[/?#]\S*)?$/u.exec(value);
  if (link) return { kind: link[1] === 'pull' ? 'pullRequest' : 'issue', number: Number(link[2]) };
  if (kind === 'branch') return value ? { kind, branch: value } : null;
  const number = /^#?(\d+)$/u.exec(value);
  return number && Number(number[1]) > 0 ? { kind, number: Number(number[1]) } : null;
}

function newCondition(kind: AutomationConditionKind): AutomationCondition {
  switch (kind) {
    case 'linked': return { kind, linked: true };
    case 'mentionsBot': return { kind };
    case 'draft': return { kind, draft: false };
    case 'conclusion':
    case 'reviewState': return { kind, values: [] };
    default: return { kind, mode: 'oneOf', values: [] };
  }
}

/** The editor's readback ("into main", "not by dependabot[bot]"), one phrase per condition. */
function conditionPhrase(condition: AutomationCondition, bot: string): string {
  if (condition.kind === 'linked') return condition.linked ? 'on a linked pull request or issue' : 'with no linked workspace';
  if (condition.kind === 'mentionsBot') return `mentioning ${bot}`;
  if (condition.kind === 'draft') return condition.draft ? 'only drafts' : 'not drafts';
  const values = condition.values.join(' or ');
  switch (condition.kind) {
    case 'conclusion': return `that ended ${values}`;
    case 'reviewState': return `that are ${values.replaceAll('_', ' ')}`;
    case 'baseBranch': return condition.mode === 'noneOf' ? `not into ${values}` : `into ${values}`;
    case 'headBranch': return condition.mode === 'noneOf' ? `not from ${values}` : `from ${values}`;
    case 'branch': return condition.mode === 'noneOf' ? `not on ${values}` : `on ${values}`;
    case 'author': return condition.mode === 'noneOf' ? `not by ${values}` : `by ${values}`;
    case 'labels': return condition.mode === 'noneOf' ? `without the label ${values}` : `labeled ${values}`;
    case 'changedFiles': return condition.mode === 'noneOf' ? `not touching ${values}` : `touching ${values}`;
  }
}

function Code({ children }: { children: ReactNode }): ReactElement {
  return <code className="font-mono text-caption">{children}</code>;
}

/** `opened`, `ready_for_review` or `closed`: code-styled values with `last` before the final one. */
function CodeList({ values, last }: { values: readonly string[]; last: string }): ReactElement {
  return <>{values.map((value, index) => <span key={value}>{index === 0 ? '' : index === values.length - 1 ? last : ', '}<Code>{value}</Code></span>)}</>;
}

/** A card's Only if, one phrase per condition. */
function ConditionReadback({ condition, bot }: { condition: AutomationCondition; bot: string }): ReactNode {
  switch (condition.kind) {
    case 'linked': return condition.linked ? 'it is linked' : 'it has no linked workspace';
    case 'mentionsBot': return <>mentions <Code>{bot}</Code></>;
    case 'draft': return condition.draft ? 'a draft' : 'not a draft';
    case 'conclusion': return <>conclusion is <CodeList values={condition.values} last=" or " /></>;
    case 'reviewState': return <>review is <CodeList values={condition.values} last=" or " /></>;
    case 'labels': return <>{condition.mode === 'oneOf' ? 'labeled' : 'no label'} <CodeList values={condition.values} last=" or " /></>;
    case 'changedFiles': return <>{condition.mode === 'oneOf' ? 'changed files match' : 'no changed file matches'} <CodeList values={condition.values} last=" or " /></>;
    case 'baseBranch': return <>base branch is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'headBranch': return <>head branch is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'branch': return <>branch is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
    case 'author': return <>author is {condition.mode === 'oneOf' ? '' : 'not '}<CodeList values={condition.values} last=" or " /></>;
  }
}

function subjectNoun(trigger: AutomationTrigger): string {
  if (trigger.kind !== 'github') return 'the pull request or issue';
  const [only, ...others] = [...new Set(trigger.events.map(entry => EVENT_SUBJECT[entry.event]))];
  return only && others.length === 0 ? only : 'the pull request, issue or branch';
}

function Stat({ value, label }: { value: ReactNode; label: string }): ReactElement {
  return <div className="flex min-w-0 flex-col gap-0.5 px-5 py-4">
    <strong className="text-title font-semibold tabular-nums text-foreground">{value}</strong>
    <span className="text-caption text-muted-foreground">{label}</span>
  </div>;
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <>
    <dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-body text-foreground [overflow-wrap:anywhere]">{children}</dd>
  </>;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }): ReactElement {
  return <section aria-label={title} className="mb-8 flex flex-col gap-3">
    <div className="flex flex-wrap items-end justify-between gap-2"><h2 className="text-subtitle font-semibold">{title}</h2>{aside}</div>
    {children}
  </section>;
}

function Field({ label, error, children }: { label: string; error?: string; children: ReactNode }): ReactElement {
  return <div className="flex min-w-0 flex-col gap-1">
    <label className="flex min-w-0 flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">{label}</span>{children}</label>
    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

function TextInput({ label, value, onChange, invalid = false, mono = false, placeholder, type = 'text', min, max }: { label: string; value: string; onChange(value: string): void; invalid?: boolean; mono?: boolean; placeholder?: string; type?: 'text' | 'number' | 'time'; min?: number; max?: number }): ReactElement {
  const shape = useShape();
  return <input aria-label={label} aria-invalid={invalid || undefined} placeholder={placeholder} value={value} type={type} min={min} max={max} onChange={event => onChange(event.currentTarget.value)}
    className={`${shape.input} h-9 w-full min-w-0 border bg-background px-2 text-body text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${invalid ? 'border-destructive' : 'border-border'} ${mono ? 'font-mono' : ''}`} />;
}

function options(values: readonly { value: string; label: string }[]): ReactElement {
  return <SelectContent>{values.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}

function RunBadge({ state }: { state: AutomationRunState }): ReactElement {
  return <Badge variant="dot" size="compact" color={RUN_STATE_COLOR[state]}>{state}</Badge>;
}

function TestResults({ results }: { results: readonly AutomationTestResult[] }): ReactElement {
  return <ul className="flex flex-col gap-1">{results.map((test, index) => <li key={`${index}:${test.label}`} className="flex items-start gap-2 text-body">
    {test.runs ? <CheckCircle className="mt-0.5 shrink-0 text-success" width={16} height={16} strokeWidth={1.5} /> : <MinusCircle className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
    <span className="min-w-0 [overflow-wrap:anywhere]">{test.label}<span className="text-muted-foreground"> · {test.result}</span></span>
  </li>)}</ul>;
}

function CheckList({ checks }: { checks: readonly AutomationCheck[] }): ReactElement {
  return <ul aria-label="Checks" className="flex flex-col gap-1.5">{checks.map((check, index) => <li key={`${index}:${check.label}`} className="flex items-start gap-2 text-body">
    {check.passed === true ? <CheckCircle aria-label="Passed" className="mt-0.5 shrink-0 text-success" width={16} height={16} strokeWidth={1.5} />
      : check.passed === false ? <XCircle aria-label="Failed" className="mt-0.5 shrink-0 text-destructive" width={16} height={16} strokeWidth={1.5} />
        : <MinusCircle aria-label="Not checked" className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
    <span className={`min-w-0 [overflow-wrap:anywhere] ${check.passed === null ? 'text-muted-foreground' : 'text-foreground'}`}>{check.label}{check.passed === null ? ' (not checked)' : ''}</span>
  </li>)}</ul>;
}

function triggerReadback(automation: AutomationView, now: number): ReactNode {
  const { trigger } = automation;
  switch (trigger.kind) {
    case 'manual': return <>Manual only: runs when you choose <strong className="font-semibold">Run now</strong></>;
    case 'label': return <>GitHub · label <CodeList values={Object.keys(AUTOMATION_START_LABELS)} last=" or " /> added to an issue or pull request</>;
    case 'github': return <>GitHub · {trigger.events.map((entry, index) => <span key={entry.event}>{index === 0 ? '' : ' · '}{AUTOMATION_EVENT_LABEL[entry.event].toLowerCase()}{entry.actions.length ? <> <CodeList values={entry.actions} last=", " /></> : null}</span>)}</>;
    case 'schedule': {
      const next = automation.enabled && automation.proposal === null ? automation.nextRunAt : null;
      const described = describeAutomationSchedule(trigger.cron);
      // An expression with no plain-words form reads back as itself; show it once.
      return <><Code>{trigger.cron}</Code>{described === `${trigger.cron.trim()} (UTC)` ? ' (UTC)' : <> · {described}</>}{next ? <> · <span title={formatUtc(next)}>next {formatRelativeTime(next, now)}</span></> : null}</>;
    }
  }
}

function actionReadback(automation: AutomationView, project: AutomationsProject | undefined): ReactNode {
  const { action } = automation;
  switch (action.kind) {
    case 'messageProjectAgent': return 'Message the project agent';
    case 'messageWorkspace': return <>Message workspace <span className="font-mono text-caption">{workspaceLabel(project, automation.projectId, action.workspaceId)}</span></>;
    case 'startWorkspace': return <>Start a workspace for {subjectNoun(automation.trigger)} · starts in <strong className="font-semibold">{action.mode ? MODE_LABEL[action.mode] : 'the label\'s mode'}</strong></>;
    case 'sendToLinked': return <>Send to its linked workspace{action.orProjectAgent ? ', or to the project agent when it has none' : ''}{action.wake ? <> · <strong className="font-semibold">wakes the agent</strong></> : ' as a notice · the agent stays asleep'}</>;
  }
}

interface CardHandlers {
  toggle(automation: AutomationView): void;
  runNow(automation: AutomationView): void;
  test(automation: AutomationView): void;
  edit(automation: AutomationView): void;
  remove(automation: AutomationView): void;
  approve(automation: AutomationView): void;
  dismiss(automation: AutomationView): void;
  openConversation(automation: AutomationView): void;
}

function AutomationCard({ automation, index, project, bot, busy, now, handlers }: { automation: AutomationView; index: number; project: AutomationsProject | undefined; bot: string; busy: boolean; now: number; handlers: CardHandlers }): ReactElement {
  const { proposal, action, trigger } = automation;
  const modes = action.kind === 'startWorkspace' ? action.mode ? [action.mode] : AUTOMATION_MODES : [];
  const runsNow = trigger.kind === 'schedule' || trigger.kind === 'manual';
  return <Card index={index}>
    <CardHeader>
      <CardTitle><span className="flex flex-wrap items-center gap-2"><span className="[overflow-wrap:anywhere]">{automation.name}</span>
        {modes.map(mode => <Badge key={mode} size="compact" color={MODE_COLOR[mode]}>{MODE_LABEL[mode]}</Badge>)}
        {automation.isDefault ? <Badge size="compact" color="gray">Default</Badge> : null}
      </span></CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">
        {proposal ? <><Badge size="compact" color="amber">Proposed</Badge><span>by the project agent · {formatRelativeTime(proposal.proposedAt, now)}</span></>
          : automation.lastRun ? <><span>Last run {formatRelativeTime(automation.lastRun.at, now)}</span><RunBadge state={automation.lastRun.state} /></> : <span>No runs yet</span>}
      </span></CardDescription>
      {proposal ? null : <CardAction>
        <div className="flex items-center gap-2">
          <Switch label={automation.enabled ? 'On' : 'Off'} checked={automation.enabled} disabled={busy} onToggle={() => handlers.toggle(automation)} />
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automation.name}`} disabled={busy}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
            <DropdownContent align="end" className="min-w-[220px] w-[220px]">
              {runsNow ? <MenuItem index={0} icon={PlayGlyph} label="Run now" onSelect={() => handlers.runNow(automation)} />
                : <MenuItem index={0} icon={TestGlyph} label="Test with a past event" onSelect={() => handlers.test(automation)} />}
              <MenuItem index={1} icon={EditGlyph} label="Edit" onSelect={() => handlers.edit(automation)} />
              <MenuItem index={2} icon={DeleteGlyph} label="Delete" onSelect={() => handlers.remove(automation)} />
            </DropdownContent>
          </DropdownMenu>
        </div>
      </CardAction>}
    </CardHeader>
    <CardContent>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
        <Row label="When">{triggerReadback(automation, now)}</Row>
        <Row label="Only if">{automation.conditions.length ? <span className="flex flex-wrap gap-x-1.5">{automation.conditions.map((condition, at) => <span key={condition.kind}>{at > 0 ? '· ' : ''}<ConditionReadback condition={condition} bot={bot} /></span>)}</span>
          : <span className="text-muted-foreground">Always</span>}</Row>
        <Row label="Then">{actionReadback(automation, project)}</Row>
        <Row label="Instruction"><span className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{action.instruction}</span></Row>
      </dl>
    </CardContent>
    {proposal ? <CardFooter><div className="flex w-full min-w-0 flex-col gap-3">
      <p className="flex items-start gap-2 text-body"><MessageChatCircle className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} /><span className="min-w-0 [overflow-wrap:anywhere]"><span className="text-muted-foreground">You asked: </span>“{proposal.asked}”</span></p>
      <p className="text-body text-muted-foreground [overflow-wrap:anywhere]">{proposal.reason}</p>
      {proposal.tested.length ? <div className="flex flex-col gap-1.5">
        <strong className="text-caption font-medium text-muted-foreground">The agent's test</strong>
        <TestResults results={proposal.tested} />
      </div> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button" disabled={busy} onClick={() => handlers.approve(automation)}>Switch on</Button>
        <Button variant="secondary" size="compact" type="button" disabled={busy} onClick={() => handlers.edit(automation)}>Edit first</Button>
        <Button variant="ghost" size="compact" type="button" onClick={() => handlers.openConversation(automation)}>Open conversation</Button>
        <Button variant="ghost" size="compact" type="button" disabled={busy} onClick={() => handlers.dismiss(automation)}>Dismiss</Button>
      </div>
    </div></CardFooter>
      : automation.enabled ? null : <CardFooter><span className="text-caption text-muted-foreground">{OFF_NOTE[trigger.kind]}</span></CardFooter>}
  </Card>;
}

function SubjectLabel({ subject }: { subject: AutomationSubject }): ReactElement {
  const title = subjectTitle(subject);
  return subject.url ? <a href={subject.url} target="_blank" rel="noreferrer" className="hover:underline">{title}</a> : <>{title}</>;
}

function LinkMenu({ link, busy, onRelink, onUnlink }: { link: AutomationLinkView; busy: boolean; onRelink(subject: AutomationSubjectRef): void; onUnlink(subject: AutomationSubjectRef): void }): ReactElement | null {
  const ref = subjectRef(link.subject);
  if (!ref) return null;
  return <DropdownMenu>
    <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automationSubjectName(link.subject)}`} disabled={busy}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
    <DropdownContent align="end" className="min-w-[220px] w-[220px]">
      <MenuItem index={0} icon={LinkGlyph} label="Link to another workspace" onSelect={() => onRelink(ref)} />
      <MenuItem index={1} icon={UnlinkGlyph} label="Unlink" onSelect={() => onUnlink(ref)} />
    </DropdownContent>
  </DropdownMenu>;
}

function LinksTable({ links, project, projectId, busy, now, onOpenWorkspace, onRelink, onUnlink }: { links: readonly AutomationLinkView[]; project: AutomationsProject | undefined; projectId: string; busy: string | null; now: number; onOpenWorkspace(workspaceId: string): void; onRelink(subject: AutomationSubjectRef): void; onUnlink(subject: AutomationSubjectRef): void }): ReactElement {
  const rows = links.map(link => ({
    link,
    key: automationSubjectKey(link.subject),
    activity: link.lastActivity ? `${link.lastActivity.label} · ${formatRelativeTime(link.lastActivity.at, now)}` : 'No activity yet',
    workspace: <button type="button" className="max-w-full truncate text-left font-mono text-caption underline decoration-dotted underline-offset-2" onClick={() => onOpenWorkspace(link.workspaceId)}>{workspaceLabel(project, projectId, link.workspaceId)}</button>,
  }));
  return <>
    <ul aria-label="Links" className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
      {rows.map(({ link, key, activity, workspace }) => <li key={key} className="flex items-start gap-2 py-3">
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="text-body [overflow-wrap:anywhere]"><SubjectLabel subject={link.subject} /></span>
          {workspace}
          <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{LINK_LABEL[link.source]}{link.detail ? ` · ${link.detail}` : ''}</span>
          <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{activity}</span>
        </div>
        <LinkMenu link={link} busy={busy === key} onRelink={onRelink} onUnlink={onUnlink} />
      </li>)}
    </ul>
    <div className="hidden sm:block"><Table size="compact">
      <TableHeader><TableRow>
        <TableHead className="w-[32%]">Pull request or issue</TableHead>
        <TableHead className="w-[17%]">Workspace</TableHead>
        <TableHead className="w-[27%]">Linked</TableHead>
        <TableHead>Last activity</TableHead>
        <TableHead className="w-10" />
      </TableRow></TableHeader>
      <TableBody>
        {rows.map(({ link, key, activity, workspace }, index) => <TableRow key={key} index={index}>
          <TableCell className="max-w-0"><span className="block truncate"><SubjectLabel subject={link.subject} /></span></TableCell>
          <TableCell className="max-w-0">{workspace}</TableCell>
          <TableCell className="max-w-0">
            <span className="block truncate">{LINK_LABEL[link.source]}</span>
            {link.detail ? <span className="block truncate text-caption text-muted-foreground">{link.detail}</span> : null}
          </TableCell>
          <TableCell className="max-w-0 text-caption text-muted-foreground"><span className="block truncate">{activity}</span></TableCell>
          <TableCell><LinkMenu link={link} busy={busy === key} onRelink={onRelink} onUnlink={onUnlink} /></TableCell>
        </TableRow>)}
      </TableBody>
    </Table></div>
  </>;
}

function TrustList({ repository, trusted, onSave }: { repository: string | null; trusted: readonly string[]; onSave(trusted: string[]): Promise<void> }): ReactElement {
  const shape = useShape();
  const [login, setLogin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = async (next: string[]): Promise<boolean> => {
    setPending(true);
    setError(null);
    try {
      await onSave(next);
      return true;
    } catch (cause) {
      setError(rpcErrorMessage(cause, 'Save trusted authors'));
      return false;
    } finally {
      setPending(false);
    }
  };
  const trust = async (): Promise<void> => {
    const entry = login.trim().replace(/^@+/u, '');
    if (!entry || pending) return;
    if (trusted.some(known => known.toLowerCase() === entry.toLowerCase())) {
      setLogin('');
      return;
    }
    if (await save([...trusted, entry])) setLogin('');
  };
  return <div className={`${shape.container} flex flex-col gap-3 bg-surface-2 px-5 py-4 shadow-surface-1`}>
    <p className="text-body text-muted-foreground">An event runs only if its author has write access to {repository ? <span className="font-mono text-caption text-foreground">{repository}</span> : 'the project\'s repository'} (checked through the GitHub App when the event arrives) or is listed here. For a comment, the author is the commenter. Events from anyone else do not match any automation; they show as skipped in recent runs. Schedules and manual runs are always trusted.</p>
    {trusted.length ? <ul aria-label="Trusted logins" className="flex flex-wrap gap-2">{trusted.map(entry => <li key={entry} className={`${shape.input} flex min-w-0 items-center gap-1 border border-border bg-background py-0.5 pl-2 pr-0.5`}>
      <span className="font-mono text-caption [overflow-wrap:anywhere]">@{entry}</span>
      <Button variant="ghost" size="icon" type="button" aria-label={`Stop trusting @${entry}`} disabled={pending} onClick={() => void save(trusted.filter(other => other !== entry))}><XCircle width={14} height={14} strokeWidth={1.5} /></Button>
    </li>)}</ul> : <p className="text-caption text-muted-foreground">No one is listed.</p>}
    <form noValidate className="flex max-w-md items-center gap-2" onSubmit={event => { event.preventDefault(); void trust(); }}>
      <div className="min-w-0 flex-1"><TextInput label="GitHub login" value={login} onChange={setLogin} mono placeholder="GitHub login" /></div>
      <Button variant="secondary" type="submit" leadingIcon={PlusGlyph} loading={pending} disabled={pending}>Trust</Button>
    </form>
    {error ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

function RunsTable({ runs, projects, showProject, now, onOpen }: { runs: readonly AutomationRunView[]; projects: readonly AutomationsProject[]; showProject: boolean; now: number; onOpen(run: AutomationRunView): void }): ReactElement {
  const project = (run: AutomationRunView) => projects.find(entry => entry.id === run.projectId);
  return <>
    <ul aria-label="Runs" className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
      {runs.map(run => <li key={run.id}><button type="button" className="flex w-full min-w-0 flex-col gap-0.5 py-3 text-left" onClick={() => onOpen(run)}>
        <span className="flex items-center justify-between gap-2"><RunBadge state={run.state} /><span className="text-caption tabular-nums text-muted-foreground">{formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, now)}</span></span>
        <span className="text-body [overflow-wrap:anywhere]">{showProject ? <span className="text-muted-foreground">{project(run)?.name ?? run.projectId} · </span> : null}{run.subject ? subjectTitle(run.subject) : run.automationName}</span>
        {run.outcome ? <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{run.outcome}</span> : null}
        <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{run.automationName} · <span className="font-mono">{run.event ?? run.trigger}</span></span>
      </button></li>)}
    </ul>
    <div className="hidden sm:block"><Table size="compact">
      <TableHeader><TableRow>
        <TableHead className="w-24">Status</TableHead>
        {showProject ? <TableHead className="w-[14%]">Project</TableHead> : null}
        <TableHead className={showProject ? 'w-[30%]' : 'w-[40%]'}>Subject</TableHead>
        <TableHead>From · event</TableHead>
        <TableHead>Workspace</TableHead>
        <TableHead className="w-24 text-right">When</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {runs.map((run, index) => <TableRow key={run.id} index={index} className="cursor-pointer" onClick={() => onOpen(run)}>
          <TableCell><RunBadge state={run.state} /></TableCell>
          {showProject ? <TableCell className="max-w-0"><span className="block truncate">{project(run)?.name ?? run.projectId}</span></TableCell> : null}
          <TableCell className="max-w-0">
            <button type="button" className="block w-full truncate text-left text-foreground" onClick={(event) => { event.stopPropagation(); onOpen(run); }}>{run.subject ? subjectTitle(run.subject) : run.automationName}</button>
            {run.outcome ? <span className="block truncate text-caption text-muted-foreground">{run.outcome}</span> : null}
          </TableCell>
          <TableCell className="max-w-0">
            <span className="block truncate">{run.automationName}</span>
            <span className="block truncate font-mono text-caption text-muted-foreground">{run.event ?? run.trigger}</span>
          </TableCell>
          <TableCell className="max-w-0">{run.workspaceId === null ? <span className="text-muted-foreground">—</span>
            : <span className={`block truncate text-caption ${run.workspaceId === run.projectId ? '' : 'font-mono underline decoration-dotted underline-offset-2'}`}>{workspaceLabel(project(run), run.projectId, run.workspaceId)}</span>}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, now)}</TableCell>
        </TableRow>)}
      </TableBody>
    </Table></div>
  </>;
}

function RunDetail({ run, project, busy, onCancel, onOpenWorkspace }: { run: AutomationRunView; project: AutomationsProject | undefined; busy: boolean; onCancel(run: AutomationRunView): void; onOpenWorkspace(workspaceId: string): void }): ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const { workspaceId } = run;
  const workspace = workspaceId === null ? null : workspaceLabel(project, run.projectId, workspaceId);
  const stopping = run.state === 'running' && confirmStop;
  return <>
    <DialogHeader>
      <DialogTitle><span className="flex flex-wrap items-center gap-2"><span className="[overflow-wrap:anywhere]">{run.subject ? subjectTitle(run.subject) : run.automationName}</span><RunBadge state={run.state} /></span></DialogTitle>
      <DialogDescription>{run.automationName} · <span className="font-mono">{run.event ?? run.trigger}</span> · {formatUtc(run.scheduledFor)}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      {run.outcome ? <p className="text-body [overflow-wrap:anywhere]">{run.outcome}</p> : null}
      {run.checks.length ? <section aria-label="Only if" className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Only if</strong>
        <CheckList checks={run.checks} />
      </section> : null}
      <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Timeline (UTC)</strong>
        {run.timeline.length ? <ol className="flex flex-col gap-1.5">{run.timeline.map((step, index) => <li key={`${index}:${step.label}`} className="flex gap-3 text-body">
          <time dateTime={step.at.toISOString()} className="w-16 shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{UTC_CLOCK.format(step.at)}</time><span className="min-w-0 [overflow-wrap:anywhere]">{step.label}</span>
        </li>)}</ol> : <p className="text-caption text-muted-foreground">Nothing has happened yet.</p>}
      </section>
      {stopping ? <p role="alert" className="text-body">Stopping ends the agent's current turn in {workspace ?? 'its workspace'}, including any other work in that turn.</p> : null}
    </div>
    <DialogFooter>
      {run.state === 'queued' ? <Button variant="secondary" type="button" loading={busy} disabled={busy} onClick={() => onCancel(run)}>Cancel run</Button> : null}
      {run.state === 'running' && !confirmStop ? <Button variant="secondary" type="button" disabled={busy} onClick={() => setConfirmStop(true)}>Stop run</Button> : null}
      {stopping ? <>
        <Button variant="secondary" type="button" onClick={() => setConfirmStop(false)}>Keep running</Button>
        <Button variant="primary" type="button" loading={busy} disabled={busy} onClick={() => onCancel(run)}>Stop the turn</Button>
      </> : null}
      {!stopping && run.subject?.url ? <Button variant="secondary" asChild><a href={run.subject.url} target="_blank" rel="noreferrer">Open on GitHub</a></Button> : null}
      {stopping || workspaceId === null ? null : <Button variant="primary" type="button" onClick={() => onOpenWorkspace(workspaceId)}>{workspaceId === run.projectId ? 'Open the project agent' : `Open ${workspace}`}</Button>}
    </DialogFooter>
  </>;
}

function RuleSelect({ label, value, choices, onChange }: { label: string; value: string; choices: readonly { value: string; label: string }[]; onChange(value: string): void }): ReactElement {
  return <div className="w-44 max-w-full"><Select value={value} onValueChange={onChange}><SelectTrigger aria-label={label} />{options(choices)}</Select></div>;
}

function ConditionRule({ condition, bot, onChange }: { condition: AutomationCondition; bot: string; onChange(condition: AutomationCondition): void }): ReactElement {
  const label = `${CONDITION_LABEL[condition.kind]} rule`;
  switch (condition.kind) {
    case 'linked': return <RuleSelect label={label} value={condition.linked ? 'linked' : 'unlinked'} choices={LINKED_RULES} onChange={value => onChange({ kind: 'linked', linked: value === 'linked' })} />;
    case 'draft': return <RuleSelect label={label} value={condition.draft ? 'draft' : 'ready'} choices={DRAFT_RULES} onChange={value => onChange({ kind: 'draft', draft: value === 'draft' })} />;
    case 'mentionsBot': return <span className="pt-1.5 text-body text-muted-foreground [overflow-wrap:anywhere]">Mentions {bot}</span>;
    case 'conclusion':
    case 'reviewState': return <span className="pt-1.5 text-body text-muted-foreground">is one of</span>;
    default: return <RuleSelect label={label} value={condition.mode} choices={LIST_MODES.map(mode => ({ value: mode, label: LIST_RULE[condition.kind][mode] }))}
      onChange={value => { const mode = LIST_MODES.find(entry => entry === value); if (mode) onChange({ ...condition, mode }); }} />;
  }
}

function ChipsInput({ kind, values, invalid, onChange }: { kind: ValuesConditionKind; values: readonly string[]; invalid: boolean; onChange(values: string[]): void }): ReactElement {
  const shape = useShape();
  const listId = useId();
  const [draft, setDraft] = useState('');
  const suggestions = (VALUE_SUGGESTIONS[kind] ?? []).filter(value => !values.includes(value));
  const add = (): void => {
    const value = draft.trim();
    if (value && !values.includes(value)) onChange([...values, value]);
    setDraft('');
  };
  return <div className={`${shape.input} flex w-full min-w-0 flex-wrap items-center gap-1 border bg-background px-1.5 py-1 ${invalid ? 'border-destructive' : 'border-border'}`}>
    {values.map(value => <span key={value} className="flex min-w-0 max-w-full items-center gap-0.5 rounded bg-surface-2 py-0.5 pl-1.5 pr-0.5 font-mono text-caption [overflow-wrap:anywhere]">
      {value}
      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter(entry => entry !== value))}><XCircle width={12} height={12} strokeWidth={1.5} /></button>
    </span>)}
    <input list={suggestions.length ? listId : undefined} value={draft} placeholder={values.length ? 'Add…' : VALUE_PLACEHOLDER[kind]} aria-label={`Add to ${CONDITION_LABEL[kind]}`} aria-invalid={invalid || undefined}
      onChange={event => setDraft(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} onBlur={add}
      className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 font-mono text-caption text-foreground outline-none" />
    {suggestions.length ? <datalist id={listId}>{suggestions.map(value => <option key={value} value={value} />)}</datalist> : null}
  </div>;
}

function ConditionRow({ condition, bot, missing, onChange, onRemove }: { condition: AutomationCondition; bot: string; missing: boolean; onChange(condition: AutomationCondition): void; onRemove(): void }): ReactElement {
  const label = CONDITION_LABEL[condition.kind];
  return <li className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1.5 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
    <span className="pt-1.5 text-caption font-medium text-muted-foreground">{label}</span>
    <div className="col-span-2 row-start-2 flex min-w-0 flex-col items-stretch gap-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">
      <ConditionRule condition={condition} bot={bot} onChange={onChange} />
      {'values' in condition ? <ChipsInput kind={condition.kind} values={condition.values} invalid={missing} onChange={values => onChange({ ...condition, values })} /> : null}
      {missing ? <p role="alert" className="text-caption text-destructive">Add at least one value, or remove this filter.</p> : null}
    </div>
    <Button variant="ghost" size="icon" type="button" className="col-start-2 row-start-1 sm:col-start-3" aria-label={`Remove the ${label} filter`} onClick={onRemove}><Trash01 width={14} height={14} strokeWidth={1.5} /></Button>
  </li>;
}

type EditorField = 'name' | 'cron' | 'events' | 'conditions' | 'action' | 'mode' | 'workspace' | 'instruction';
/** The `field` an `automationInvalid` error names, mapped to the editor control that shows it. */
const INVALID_FIELD: Record<string, EditorField> = {
  name: 'name', 'trigger.cron': 'cron', 'trigger.events': 'events', conditions: 'conditions', 'action.kind': 'action', 'action.mode': 'mode', 'action.workspaceId': 'workspace', 'action.instruction': 'instruction',
};

function editorFailure(cause: unknown, key: string, operation: string): { key: string; field: EditorField | null; message: string } {
  if (automationErrors.automationInvalid.is(cause)) return { key, field: INVALID_FIELD[cause.data.field] ?? null, message: cause.data.message };
  return { key, field: null, message: rpcErrorMessage(cause, operation) };
}

function AutomationEditor({ projectId, workspaces, github, source, testFirst, now, onCancel, onSaved, onRan }: {
  projectId: string; workspaces: readonly AutomationWorkspace[]; github: AutomationGitHub; source: AutomationView | null; testFirst: boolean; now: number;
  onCancel(): void; onSaved(): Promise<void>; onRan(run: AutomationRunView): Promise<void>;
}): ReactElement {
  const shape = useShape();
  const proposal = source?.proposal ?? null;
  const bot = github.bot ?? 'the GitSpace bot';
  const initialTrigger = source?.trigger.kind ?? (github.repository === null ? 'schedule' : 'github');
  const [name, setName] = useState(source?.name ?? '');
  const [triggerKind, setTriggerKind] = useState<AutomationTriggerKind>(initialTrigger);
  const [schedule, setSchedule] = useState<ScheduleChoice>(() => scheduleChoice(source?.trigger.kind === 'schedule' ? source.trigger.cron : NEW_AUTOMATION_CRON));
  const [events, setEvents] = useState<readonly EventChoice[]>(source?.trigger.kind === 'github' ? source.trigger.events : [NEW_EVENT]);
  const [conditions, setConditions] = useState<readonly AutomationCondition[]>(source?.conditions ?? []);
  const [actionKind, setActionKind] = useState<ActionKind>(source?.action.kind ?? (TRIGGER_ACTIONS[initialTrigger].includes('startWorkspace') ? 'startWorkspace' : 'messageProjectAgent'));
  const [mode, setMode] = useState<AutomationMode | null>(source?.action.kind === 'startWorkspace' ? source.action.mode : initialTrigger === 'label' ? null : 'review');
  const [wake, setWake] = useState(source?.action.kind === 'sendToLinked' ? source.action.wake : true);
  const [orProjectAgent, setOrProjectAgent] = useState(source?.action.kind === 'sendToLinked' ? source.action.orProjectAgent : false);
  const [workspaceId, setWorkspaceId] = useState(source?.action.kind === 'messageWorkspace' ? source.action.workspaceId : '');
  const [instruction, setInstruction] = useState(source?.action.instruction ?? '');
  const [deliveryChoice, setDeliveryChoice] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | 'run' | null>(null);
  const [failure, setFailure] = useState<{ key: string; field: EditorField | null; message: string } | null>(null);
  const [tested, setTested] = useState<{ key: string; deliveryId: string | null; value: AutomationTest } | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const instructionFocused = useRef(false);
  const caret = useRef<number | null>(null);
  const testSection = useRef<HTMLElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  const eventTrigger = triggerKind === 'github' || triggerKind === 'label';
  const recordedQuery = useResultQuery(rpcClient.automations.events, { projectId, limit: RECORDED_EVENT_LIMIT }, { enabled: eventTrigger });
  const recorded = eventTrigger && recordedQuery.state === 'success' ? recordedQuery.value : [];

  useEffect(() => {
    const element = instructionRef.current;
    if (caret.current === null || !element) return;
    element.focus();
    element.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [instruction]);

  // Opened from a card's Test with a past event: the dialog's first focus lands on Test, with its section in view.
  useEffect(() => {
    if (!testFirst) return;
    testButton.current?.focus();
    testSection.current?.scrollIntoView({ block: 'nearest' });
  }, [testFirst]);

  const cron = scheduleCron(schedule);
  const parsed = triggerKind === 'schedule' ? parseAutomationSchedule(cron) : null;
  const cronError = parsed && 'error' in parsed ? parsed.error : null;
  const trigger: AutomationTrigger = triggerKind === 'github' ? { kind: 'github', events: events.map(entry => ({ event: entry.event, actions: [...entry.actions] })) }
    : triggerKind === 'label' ? { kind: 'label' } : triggerKind === 'schedule' ? { kind: 'schedule', cron } : { kind: 'manual' };
  const offered = automationConditionKinds(trigger);
  // Conditions the chosen events do not offer stay out of the draft.
  const shownConditions = conditions.filter(condition => offered.includes(condition.kind));
  const action: AutomationAction = actionKind === 'messageWorkspace' ? { kind: 'messageWorkspace', workspaceId, instruction }
    : actionKind === 'startWorkspace' ? { kind: 'startWorkspace', mode, instruction }
      : actionKind === 'sendToLinked' ? { kind: 'sendToLinked', wake, orProjectAgent, instruction }
        : { kind: 'messageProjectAgent', instruction };
  // A person's automation runs at once; a proposal edited here is switched on when saved.
  const draft: AutomationDraft = { name: name.trim(), trigger, conditions: shownConditions, action, enabled: source === null || proposal !== null || source.enabled };
  const key = JSON.stringify(draft);
  const savedKey = useRef(key).current;
  const unknown = unknownAutomationPlaceholders(instruction, trigger);
  const missingActions = triggerKind === 'github' ? events.filter(entry => AUTOMATION_EVENT_ACTIONS[entry.event].length > 0 && entry.actions.length === 0) : [];
  const emptyConditions = shownConditions.filter(condition => 'values' in condition && condition.values.length === 0);
  const incomplete = !draft.name || cronError !== null || missingActions.length > 0 || emptyConditions.length > 0 || (actionKind === 'messageWorkspace' && !workspaceId) || !instruction.trim() || unknown.length > 0;
  const errors: Partial<Record<EditorField, string>> = {};
  if (attempted && !draft.name) errors.name = 'Name the automation.';
  if (cronError) errors.cron = cronError;
  if (attempted && missingActions.length) errors.events = `Choose at least one action for ${missingActions.map(entry => AUTOMATION_EVENT_LABEL[entry.event].toLowerCase()).join(' and ')}.`;
  if (attempted && actionKind === 'messageWorkspace' && !workspaceId) errors.workspace = 'Choose the workspace to message.';
  if (unknown.length) errors.instruction = `${unknown.map(path => `{{${path}}}`).join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of ${TRIGGER_NOUN[triggerKind]}. Insert a field to see the ones it has.`;
  else if (attempted && !instruction.trim()) errors.instruction = 'Write what the agent should do.';
  if (failure?.key === key && failure.field) errors[failure.field] = failure.message;
  const formError = failure?.key === key && failure.field === null ? failure.message : null;

  const choices = workspaces.filter(workspace => workspace.active || workspace.id === workspaceId);
  const nextRun = triggerKind === 'schedule' && cronError === null ? new Date(nextAutomationRunAt(cron, now)) : null;
  const unusedConditions = offered.filter(kind => !shownConditions.some(condition => condition.kind === kind));
  const completeConditions = shownConditions.filter(condition => !('values' in condition) || condition.values.length > 0);
  const [onlyEvent] = events;
  const conditionsReadback = `Runs for ${events.length === 1 && onlyEvent ? EVENT_NOUN[onlyEvent.event] : 'events'}${completeConditions.length ? ` ${completeConditions.map(condition => conditionPhrase(condition, bot)).join(', ')}` : ' of every kind'}.`;
  const modeChoices = [...(triggerKind === 'label' ? [{ value: LABEL_MODE, label: 'The label\'s mode' }] : []), ...AUTOMATION_MODES.map(entry => ({ value: entry, label: MODE_LABEL[entry] }))];

  const chosenDelivery = deliveryChoice ?? recorded[0]?.deliveryId ?? RECENT_EVENTS;
  const delivery = eventTrigger && chosenDelivery !== RECENT_EVENTS ? chosenDelivery : null;
  const shownTest = tested?.key === key && tested.deliveryId === delivery ? tested : null;
  const [firstResult] = shownTest?.value.results ?? [];
  const saved = source !== null && proposal === null && key === savedKey;
  const canRun = saved && shownTest !== null && shownTest.deliveryId !== null && firstResult?.runs === true;

  const chooseTrigger = (value: string): void => {
    const kind = TRIGGER_KINDS.find(entry => entry === value);
    if (!kind) return;
    setTriggerKind(kind);
    if (!TRIGGER_ACTIONS[kind].includes(actionKind)) setActionKind('messageProjectAgent');
    if (kind === 'label') setMode(null);
    else if (mode === null) setMode('review');
  };
  const chooseEvent = (index: number, value: string): void => {
    const event = AUTOMATION_GITHUB_EVENTS.find(entry => entry === value);
    if (!event) return;
    setEvents(current => current.map((entry, at) => at === index ? { event, actions: AUTOMATION_EVENT_ACTIONS[event].slice(0, 1) } : entry));
  };
  const toggleAction = (index: number, action: string): void => setEvents(current => current.map((entry, at) => at === index
    ? { ...entry, actions: AUTOMATION_EVENT_ACTIONS[entry.event].filter(known => known === action ? !entry.actions.includes(action) : entry.actions.includes(known)) }
    : entry));
  const addEvent = (): void => {
    const event = AUTOMATION_GITHUB_EVENTS.find(entry => !events.some(chosen => chosen.event === entry));
    if (event) setEvents(current => [...current, { event, actions: AUTOMATION_EVENT_ACTIONS[event].slice(0, 1) }]);
  };

  const insertField = (path: string): void => {
    const token = `{{${path}}}`;
    const element = instructionRef.current;
    const start = element && instructionFocused.current ? element.selectionStart : instruction.length;
    const end = element && instructionFocused.current ? element.selectionEnd : instruction.length;
    caret.current = start + token.length;
    setInstruction(`${instruction.slice(0, start)}${token}${instruction.slice(end)}`);
  };

  const save = async (): Promise<void> => {
    setAttempted(true);
    if (incomplete || pending) return;
    setPending('save');
    try {
      const result = source
        ? await settle(rpcClient.automations.update({ projectId, automationId: source.id, draft }))
        : await settle(rpcClient.automations.create({ projectId, draft }));
      if (proposal && result.proposal) await settle(rpcClient.automations.approve({ projectId, automationId: result.id, revision: result.revision }));
      await onSaved();
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Save automation'));
    } finally {
      setPending(null);
    }
  };

  const test = async (): Promise<void> => {
    if (pending) return;
    setPending('test');
    try {
      const value = await settle(rpcClient.automations.test(delivery === null ? { projectId, draft } : { projectId, draft, deliveryId: delivery }));
      setTested({ key, deliveryId: delivery, value });
      setFailure(null);
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Test automation'));
    } finally {
      setPending(null);
    }
  };

  const runIt = async (): Promise<void> => {
    if (pending || !source || !canRun || delivery === null) return;
    setPending('run');
    try {
      await onRan(await settle(rpcClient.automations.runOnEvent({ projectId, automationId: source.id, deliveryId: delivery })));
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Run it'));
    } finally {
      setPending(null);
    }
  };

  const setPreset = (value: string): void => {
    const preset = SCHEDULE_PRESETS.find(entry => entry === value);
    if (!preset) return;
    setSchedule(current => ({ ...current, preset, custom: preset === 'custom' && current.preset !== 'custom' ? scheduleCron(current) : current.custom }));
  };
  const setClock = (value: string): void => {
    const match = /^(\d{2}):(\d{2})$/u.exec(value);
    if (!match) return;
    setSchedule(current => ({ ...current, hour: Number(match[1]), minute: Number(match[2]) }));
  };
  const clock = `${twoDigits(schedule.hour)}:${twoDigits(schedule.minute)}`;

  return <>
    <DialogHeader>
      <DialogTitle>{proposal ? 'Edit the proposal' : source ? 'Edit automation' : 'New automation'}</DialogTitle>
      <DialogDescription>{proposal ? 'Saving switches it on.' : 'When something happens in this project, start a workspace for it, send it to the workspace linked to it, or message an agent.'}</DialogDescription>
    </DialogHeader>
    <form id="automation-editor" noValidate className="flex min-w-0 flex-col gap-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field label="Name" error={errors.name}><TextInput label="Name" value={name} onChange={setName} invalid={errors.name !== undefined} placeholder="Review pull requests" /></Field>

      <section aria-label="When" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">When</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Trigger"><Select value={triggerKind} onValueChange={chooseTrigger}>
            <SelectTrigger aria-label="Trigger" />{options(TRIGGER_KINDS.map(kind => ({ value: kind, label: TRIGGER_OPTION_LABEL[kind] })))}
          </Select></Field>
          {triggerKind === 'schedule' ? <Field label="Repeats"><Select value={schedule.preset} onValueChange={setPreset}>
            <SelectTrigger aria-label="Repeats" />{options(SCHEDULE_PRESETS.map(preset => ({ value: preset, label: PRESET_LABEL[preset] })))}
          </Select></Field> : null}
          {triggerKind === 'label' ? <Field label="Labels"><span className={`${shape.input} min-h-9 border border-border bg-surface-2 px-2 py-2 font-mono text-caption`}>{Object.keys(AUTOMATION_START_LABELS).join(', ')}</span></Field> : null}
        </div>
        {triggerKind === 'github' ? <>
          <ul aria-label="Events" className="flex flex-col gap-3">
            {events.map((entry, index) => {
              const label = AUTOMATION_EVENT_LABEL[entry.event];
              const actions = AUTOMATION_EVENT_ACTIONS[entry.event];
              return <li key={entry.event} className="flex min-w-0 flex-col gap-2">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 sm:max-w-[calc(50%-0.375rem)]"><Field label="Event"><Select value={entry.event} onValueChange={value => chooseEvent(index, value)}>
                    <SelectTrigger aria-label={`Event ${index + 1}`} />{options(AUTOMATION_GITHUB_EVENTS.filter(event => event === entry.event || !events.some(other => other.event === event)).map(event => ({ value: event, label: AUTOMATION_EVENT_LABEL[event] })))}
                  </Select></Field></div>
                  {events.length > 1 ? <Button variant="ghost" size="icon" type="button" aria-label={`Remove ${label}`} onClick={() => setEvents(current => current.filter((_, at) => at !== index))}><Trash01 width={14} height={14} strokeWidth={1.5} /></Button> : null}
                </div>
                {actions.length ? <div role="group" aria-label={`${label} actions`} className="flex flex-wrap gap-1.5">{actions.map(known => <Button key={known} size="compact" type="button" aria-pressed={entry.actions.includes(known)}
                  variant={entry.actions.includes(known) ? 'primary' : 'secondary'} onClick={() => toggleAction(index, known)}><span className="font-mono">{known}</span></Button>)}</div>
                  : <p className="text-caption text-muted-foreground">Every push</p>}
              </li>;
            })}
          </ul>
          {errors.events ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.events}</p> : null}
          {events.length < AUTOMATION_GITHUB_EVENTS.length ? <div><Button variant="ghost" size="compact" type="button" leadingIcon={PlusGlyph} onClick={addEvent}>Add an event</Button></div> : null}
        </> : null}
        {triggerKind === 'label' ? <p className="text-caption text-muted-foreground">Each label starts its own mode: <span className="font-mono">gitspace:plan</span> in Plan, <span className="font-mono">gitspace:code</span> in Code, <span className="font-mono">gitspace:review</span> in Review.</p> : null}
        {triggerKind === 'schedule' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {schedule.preset === 'hourly' ? <Field label="At minute"><Select value={String(schedule.minute)} onValueChange={value => setSchedule(current => ({ ...current, minute: Number(value) }))}>
            <SelectTrigger aria-label="At minute" />{options(MINUTES.map(minute => ({ value: String(minute), label: `:${twoDigits(minute)}` })))}
          </Select></Field> : null}
          {schedule.preset === 'weekly' ? <Field label="On"><Select value={String(schedule.weekday)} onValueChange={value => setSchedule(current => ({ ...current, weekday: Number(value) }))}>
            <SelectTrigger aria-label="On" />{options(WEEKDAYS.map((day, index) => ({ value: String(index), label: day })))}
          </Select></Field> : null}
          {schedule.preset === 'daily' || schedule.preset === 'weekly' ? <Field label="At (UTC)"><TextInput label="At (UTC)" type="time" value={clock} onChange={setClock} /></Field> : null}
          {schedule.preset === 'custom' ? <div className="sm:col-span-2"><Field label="Cron expression (UTC)"><TextInput label="Cron expression (UTC)" value={schedule.custom} onChange={custom => setSchedule(current => ({ ...current, custom }))} invalid={errors.cron !== undefined} mono placeholder={NEW_AUTOMATION_CRON} /></Field></div> : null}
        </div> : null}
        {triggerKind === 'manual' ? <p className="text-caption text-muted-foreground">It runs only when you choose Run now on its card.</p> : null}
        {triggerKind === 'schedule' ? errors.cron
          ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.cron}</p>
          : <p aria-label="Schedule readback" className="text-caption text-muted-foreground"><span className="font-medium text-foreground">{describeAutomationSchedule(cron)}</span>{nextRun ? <> · next {formatUtc(nextRun)} ({formatRelativeTime(nextRun, now)})</> : null}</p>
          : null}
      </section>

      {triggerKind === 'github' ? <section aria-label="Only if" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">Only if</strong>
        <p aria-label="Conditions readback" className="text-body [overflow-wrap:anywhere]">{conditionsReadback}</p>
        {shownConditions.length ? <ul aria-label="Filters" className="flex flex-col divide-y divide-border border-y border-border">
          {shownConditions.map(condition => <ConditionRow key={condition.kind} condition={condition} bot={bot} missing={attempted && 'values' in condition && condition.values.length === 0}
            onChange={next => setConditions(current => current.map(entry => entry.kind === next.kind ? next : entry))}
            onRemove={() => setConditions(current => current.filter(entry => entry.kind !== condition.kind))} />)}
        </ul> : null}
        {unusedConditions.length ? <div><DropdownMenu>
          <DropdownTrigger render={<Button variant="ghost" size="compact" type="button" leadingIcon={PlusGlyph}>Add a filter</Button>} />
          <DropdownContent align="start" className="min-w-[200px] w-[200px]">
            {unusedConditions.map((kind, index) => <MenuItem key={kind} index={index} label={CONDITION_LABEL[kind]} onSelect={() => setConditions(current => [...current.filter(entry => entry.kind !== kind), newCondition(kind)])} />)}
          </DropdownContent>
        </DropdownMenu></div> : null}
        {errors.conditions ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.conditions}</p> : null}
        <p className="text-caption text-muted-foreground">Values can be patterns: <span className="font-mono">release/*</span>, <span className="font-mono">docs/**</span>. Events from authors without write access who are not on the trust list never match.</p>
      </section> : null}

      <section aria-label="Then" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">Then</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Action" error={errors.action}><Select value={actionKind} onValueChange={value => { const kind = TRIGGER_ACTIONS[triggerKind].find(entry => entry === value); if (kind) setActionKind(kind); }}>
            <SelectTrigger aria-label="Action" />{options(TRIGGER_ACTIONS[triggerKind].map(kind => ({ value: kind, label: ACTION_LABEL[kind] })))}
          </Select></Field>
          {actionKind === 'startWorkspace' ? <Field label="Starts in" error={errors.mode}><Select value={mode ?? LABEL_MODE} onValueChange={value => setMode(AUTOMATION_MODES.find(entry => entry === value) ?? null)}>
            <SelectTrigger aria-label="Starts in" />{options(modeChoices)}
          </Select></Field> : null}
          {actionKind === 'sendToLinked' ? <Field label="Delivery"><Select value={wake ? 'wake' : 'notice'} onValueChange={value => setWake(value === 'wake')}>
            <SelectTrigger aria-label="Delivery" />{options(DELIVERY_OPTIONS)}
          </Select></Field> : null}
          {actionKind === 'messageWorkspace' ? <Field label="Workspace" error={errors.workspace}><Select value={workspaceId} onValueChange={setWorkspaceId} disabled={choices.length === 0}>
            <SelectTrigger aria-label="Workspace" placeholder={choices.length ? 'Choose a workspace' : 'No open workspaces'} />{options(choices.map(workspace => ({ value: workspace.id, label: workspace.active ? workspace.name : `${workspace.name} (archived)` })))}
          </Select></Field> : null}
        </div>
        {actionKind === 'sendToLinked' ? <Switch label="When it has no linked workspace, send it to the project agent" checked={orProjectAgent} onToggle={() => setOrProjectAgent(current => !current)} /> : null}
        <Field label="Instruction" error={errors.instruction}>
          <textarea ref={instructionRef} aria-label="Instruction" aria-invalid={errors.instruction !== undefined || undefined} rows={5} value={instruction}
            placeholder={eventTrigger ? 'What the agent should do, e.g. Review {{pull_request.html_url}} against {{pull_request.base.ref}}.' : 'What the agent should do, e.g. Check for outdated dependencies and open a pull request for the ones whose tests pass.'}
            onFocus={() => { instructionFocused.current = true; }}
            onChange={event => setInstruction(event.currentTarget.value)}
            className={`${shape.input} w-full min-w-0 resize-y border bg-surface-2 p-2 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${errors.instruction ? 'border-destructive' : 'border-border'}`} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" leadingIcon={PlusGlyph}>Insert a field</Button>} />
            <DropdownContent align="start" className="min-w-[280px] w-[280px]">
              {automationFields(trigger).map((field, index) => <MenuItem key={field.path} index={index} label={`${field.label} · {{${field.path}}}`} onSelect={() => insertField(field.path)} />)}
            </DropdownContent>
          </DropdownMenu>
          <span className="min-w-0 text-caption text-muted-foreground">A field in <span className="font-mono">{'{{…}}'}</span> is {eventTrigger ? 'replaced by the event\'s value; Test with a past event shows the result.' : 'filled in when it runs; Test shows the result.'}</span>
        </div>
        {actionKind === 'startWorkspace' ? <p className="text-caption text-muted-foreground">The event arrives with the instruction as the workspace's first message, and the workspace is linked to {subjectNoun(trigger)}.</p> : null}
      </section>

      {eventTrigger ? <section ref={testSection} aria-label="Test with a past event" className={`${shape.container} flex min-w-0 flex-col gap-3 border border-border p-4`}>
        <strong className="text-body font-semibold">Test with a past event</strong>
        <p className="text-caption text-muted-foreground">Runs the trigger and conditions against a delivery GitSpace recorded and shows what would happen. Nothing is started until you choose Run it.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[1_1_16rem]"><Field label="Recorded event"><Select value={recorded.length ? chosenDelivery : ''} onValueChange={setDeliveryChoice} disabled={recorded.length === 0}>
            <SelectTrigger aria-label="Recorded event" placeholder={recordedQuery.state === 'pending' ? 'Loading recorded events…' : 'No recorded events yet'} />
            {options(recorded.length ? [...recorded.map(event => ({ value: event.deliveryId, label: `${event.label} · ${formatRelativeTime(event.receivedAt, now)}` })), { value: RECENT_EVENTS, label: 'Recent events this trigger starts on' }] : [])}
          </Select></Field></div>
          <Button ref={testButton} variant="secondary" type="button" leadingIcon={TestGlyph} loading={pending === 'test'} disabled={pending !== null} onClick={() => void test()}>Test</Button>
        </div>
        {recordedQuery.state === 'failure' && eventTrigger ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{rpcErrorMessage(recordedQuery.error, 'Read recorded events')}</p> : null}
        {shownTest ? <div className="flex flex-col gap-3 border-t border-border pt-3">
          {shownTest.deliveryId === null ? <TestResults results={shownTest.value.results} /> : <>
            {shownTest.value.checks.length ? <CheckList checks={shownTest.value.checks} /> : null}
            {firstResult ? <p aria-label="Test result" className="text-body [overflow-wrap:anywhere]">{firstResult.result}</p> : null}
            {firstResult?.runs ? <>
              <strong className="text-caption font-medium text-muted-foreground">Its first message:</strong>
              <blockquote aria-label="Rendered instruction" className={`${shape.input} whitespace-pre-wrap border border-border bg-surface-2 p-2 text-body [overflow-wrap:anywhere]`}>{shownTest.value.instruction}</blockquote>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="compact" type="button" leadingIcon={PlayGlyph} loading={pending === 'run'} disabled={!canRun || pending !== null} onClick={() => void runIt()}>Run it</Button>
                {canRun ? null : <span className="text-caption text-muted-foreground">{proposal ? 'Switch it on first to run it' : 'Save it first to run it'}</span>}
              </div>
            </> : null}
          </>}
        </div> : null}
      </section> : <section aria-label="Test" className={`${shape.container} flex min-w-0 flex-col gap-3 border border-border p-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="compact" type="button" leadingIcon={TestGlyph} loading={pending === 'test'} disabled={pending !== null || cronError !== null} onClick={() => void test()}>Test</Button>
          <span className="min-w-0 text-caption text-muted-foreground">Shows when it would run and the instruction the agent would read. Nothing runs.</span>
        </div>
        {shownTest ? <div className="flex flex-col gap-3 border-t border-border pt-3">
          <TestResults results={shownTest.value.results} />
          <strong className="text-caption font-medium text-muted-foreground">The agent reads</strong>
          <blockquote aria-label="Rendered instruction" className={`${shape.input} whitespace-pre-wrap border border-border bg-surface-2 p-2 text-body [overflow-wrap:anywhere]`}>{shownTest.value.instruction}</blockquote>
        </div> : null}
      </section>}
      {formError ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{formError}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-editor" loading={pending === 'save'} disabled={pending !== null}>{proposal ? 'Save and switch on' : source ? 'Save changes' : 'Create automation'}</Button>
    </DialogFooter>
  </>;
}

function LinkDialog({ projectId, workspaces, subject, bot, onCancel, onLinked }: { projectId: string; workspaces: readonly AutomationWorkspace[]; subject: AutomationSubjectRef | null; bot: string | null; onCancel(): void; onLinked(): Promise<void> }): ReactElement {
  const [workspaceId, setWorkspaceId] = useState('');
  const [kind, setKind] = useState<SubjectKind>(subject?.kind ?? 'pullRequest');
  const [text, setText] = useState(subject ? subject.kind === 'branch' ? subject.branch : `#${subject.number}` : '');
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const parsed = parseSubjectRef(kind, text);
  const key = `${workspaceId}\n${kind}\n${text}`;
  const workspace = workspaces.find(entry => entry.id === workspaceId);
  const subjectLabel = kind === 'branch' ? 'Branch' : 'Number or link';

  const link = async (): Promise<void> => {
    setAttempted(true);
    if (!parsed || !workspaceId || pending) return;
    setPending(true);
    try {
      await settle(rpcClient.automations.link({ projectId, subject: parsed, workspaceId }));
      await onLinked();
    } catch (cause) {
      setFailure({ key, message: automationErrors.automationInvalid.is(cause) ? cause.data.message : rpcErrorMessage(cause, 'Link') });
    } finally {
      setPending(false);
    }
  };

  return <>
    <DialogHeader>
      <DialogTitle>{subject ? `Link ${automationSubjectName(subject)} to another workspace` : 'Link a pull request or issue'}</DialogTitle>
      <DialogDescription>Its activity goes to this workspace{bot ? `, and mentions of ${bot} on it reach the workspace's agent` : ''}.</DialogDescription>
    </DialogHeader>
    <form id="automation-link" noValidate className="flex min-w-0 flex-col gap-4" onSubmit={event => { event.preventDefault(); void link(); }}>
      <Field label="Workspace" error={attempted && !workspaceId ? 'Choose the workspace to link it to.' : undefined}><Select value={workspaceId} onValueChange={setWorkspaceId} disabled={workspaces.length === 0}>
        <SelectTrigger aria-label="Workspace" placeholder={workspaces.length ? 'Choose a workspace' : 'No workspaces in this project'} />{options(workspaces.map(entry => ({ value: entry.id, label: entry.active ? entry.name : `${entry.name} (closed)` })))}
      </Select></Field>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[11rem_minmax(0,1fr)]">
        <Field label="Kind"><Select value={kind} onValueChange={value => { const next = SUBJECT_KINDS.find(entry => entry === value); if (next) setKind(next); }}>
          <SelectTrigger aria-label="Kind" />{options(SUBJECT_KINDS.map(entry => ({ value: entry, label: SUBJECT_KIND_LABEL[entry] })))}
        </Select></Field>
        <Field label={subjectLabel} error={attempted && !parsed ? kind === 'branch' ? 'Name the branch.' : 'Enter a number such as #1140, or paste the pull request or issue link.' : undefined}>
          <TextInput label={subjectLabel} value={text} onChange={setText} invalid={attempted && !parsed} mono placeholder={kind === 'branch' ? 'feature/login' : '#1140'} />
        </Field>
      </div>
      <p className="text-caption text-muted-foreground">A link you or an agent make replaces one found by branch. A pull request or issue has one workspace in this project; linking it here moves it from its current workspace.{workspace && !workspace.active ? ' Linking it reopens the closed workspace.' : ''}</p>
      {failure?.key === key ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{failure.message}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-link" leadingIcon={LinkGlyph} loading={pending} disabled={pending}>Link</Button>
    </DialogFooter>
  </>;
}

function LimitsEditor({ settings, onCancel, onSave }: { settings: AutomationSettings; onCancel(): void; onSave(settings: AutomationSettings): Promise<void> }): ReactElement {
  const [concurrency, setConcurrency] = useState(String(settings.concurrency));
  const [dailyRunCap, setDailyRunCap] = useState(String(settings.dailyRunCap));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const concurrencyValue = Number(concurrency);
  const capValue = Number(dailyRunCap);
  const nextConcurrency = concurrency.trim() && Number.isInteger(concurrencyValue) && concurrencyValue >= 1 && concurrencyValue <= 10 ? concurrencyValue : null;
  const nextCap = dailyRunCap.trim() && Number.isInteger(capValue) && capValue >= 1 && capValue <= 1000 ? capValue : null;
  const save = async (): Promise<void> => {
    if (nextConcurrency === null || nextCap === null) return;
    setPending(true);
    setError(null);
    try { await onSave({ ...settings, concurrency: nextConcurrency, dailyRunCap: nextCap }); }
    catch (cause) { setError(rpcErrorMessage(cause, 'Save limits')); }
    finally { setPending(false); }
  };
  return <>
    <DialogHeader>
      <DialogTitle>Limits</DialogTitle>
      <DialogDescription>Every automation in this project runs under these.</DialogDescription>
    </DialogHeader>
    <form id="automation-limits" noValidate className="flex flex-col gap-4" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field label="Runs working at once" error={nextConcurrency === null ? 'Between 1 and 10.' : undefined}><TextInput label="Runs working at once" type="number" min={1} max={10} value={concurrency} onChange={setConcurrency} invalid={nextConcurrency === null} /></Field>
      <Field label="Runs per automation per day" error={nextCap === null ? 'Between 1 and 1000.' : undefined}><TextInput label="Runs per automation per day" type="number" min={1} max={1000} value={dailyRunCap} onChange={setDailyRunCap} invalid={nextCap === null} /></Field>
      <p className="text-caption text-muted-foreground">A run holds a slot only while its agent works; a workspace waiting for you does not. Runs past the daily cap are skipped.</p>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-limits" loading={pending} disabled={pending || nextConcurrency === null || nextCap === null}>Save limits</Button>
    </DialogFooter>
  </>;
}

function ProjectPicker({ projects, project, onPick }: { projects: readonly AutomationsProject[]; project: string; onPick(projectId: string | null): void }): ReactElement {
  return <DropdownMenu>
    <DropdownTrigger render={<button type="button" className="-ml-1 flex max-w-full items-center gap-1 rounded px-1 text-caption font-medium text-muted-foreground hover:text-foreground" aria-label={`Project: ${project}`}><span className="truncate">{project}</span><ChevronDown className="shrink-0" width={14} height={14} strokeWidth={1.5} /></button>} />
    <DropdownContent align="start" className="min-w-[240px] w-[240px]">
      <MenuItem index={0} label="All projects" onSelect={() => onPick(null)} />
      {projects.map((entry, index) => <MenuItem key={entry.id} index={index + 1} label={entry.name} onSelect={() => onPick(entry.id)} />)}
    </DropdownContent>
  </DropdownMenu>;
}

/** Keeps a closing dialog's last content on screen while it animates out. */
function useClosingValue<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

export function AutomationsPage({ projects, projectId, onSelectProject, onOpenWorkspace }: AutomationsPageProps): ReactElement {
  const shape = useShape();
  const now = Date.now();
  const project = projectId === null ? undefined : projects.find(entry => entry.id === projectId);
  const overview = useResultQuery(rpcClient.automations.overview, AUTOMATIONS_OVERVIEW_INPUT);
  const overviewRead = useRetainedRead(overview, 'automations-overview');
  const list = useResultQuery(rpcClient.automations.list, { projectId: projectId ?? '' }, { enabled: projectId !== null });
  const listRead = useRetainedRead(list, projectId);
  const runs = useResultQuery(rpcClient.automations.runs, { projectId: projectId ?? '', limit: PROJECT_RUN_LIMIT }, { enabled: projectId !== null });
  const runsRead = useRetainedRead(runs, projectId);
  const refresh = (): Promise<unknown> => Promise.all(projectId === null ? [overview.refetch()] : [overview.refetch(), list.refetch(), runs.refetch()]);
  useEventRefresh(useLiveChanges(accountLiveKey('automations')), refresh);

  const [editor, setEditor] = useState<{ id: number; source: AutomationView | null; test: boolean } | null>(null);
  const [linking, setLinking] = useState<{ id: number; subject: AutomationSubjectRef | null } | null>(null);
  const [deleting, setDeleting] = useState<AutomationView | null>(null);
  const [openRun, setOpenRun] = useState<AutomationRunView | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const shownEditor = useClosingValue(editor);
  const shownLink = useClosingValue(linking);
  const shownDelete = useClosingValue(deleting);
  const shownRun = useClosingValue(openRun);

  /** Runs one change, then rereads; the change's value, or null when it failed and its error is shown. */
  const perform = async <T,>(id: string, operation: string, work: () => Promise<T>): Promise<{ value: T } | null> => {
    setBusy(id);
    setActionError(null);
    try {
      const value = await work();
      await refresh();
      return { value };
    } catch (cause) {
      setActionError(rpcErrorMessage(cause, operation));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const summaries = overviewRead.value?.projects ?? [];
  const automations = listRead.value?.automations ?? [];
  const settings = listRead.value?.settings ?? AUTOMATION_DEFAULT_SETTINGS;
  const links = listRead.value?.links ?? [];
  const github = listRead.value?.github ?? NO_GITHUB;
  const bot = github.bot ?? 'the GitSpace bot';
  const ordered = [...automations.filter(automation => automation.proposal !== null), ...automations.filter(automation => automation.proposal === null)];
  const groups = [
    { title: 'Start work', aside: null, automations: ordered.filter(automation => automation.action.kind !== 'sendToLinked') },
    { title: 'Sent to linked workspaces', aside: 'Events on a linked pull request or issue that no automation matches are not sent', automations: ordered.filter(automation => automation.action.kind === 'sendToLinked') },
  ];
  const totals = (projectId === null ? summaries : summaries.filter(entry => entry.projectId === projectId)).reduce((sum, entry) => ({
    total: sum.total + entry.total, on: sum.on + entry.on, proposed: sum.proposed + entry.proposed,
    working: sum.working + entry.working, queued: sum.queued + entry.queued, failedToday: sum.failedToday + entry.failedToday,
  }), { total: 0, on: 0, proposed: 0, working: 0, queued: 0, failedToday: 0 });
  const empty = projectId !== null && listRead.value !== undefined && automations.length === 0;
  const projectName = projectId === null ? 'All projects' : project?.name ?? projectId;
  const openEditor = (source: AutomationView | null, test = false): void => setEditor({ id: Date.now(), source, test });

  const handlers: CardHandlers = {
    toggle: automation => void perform(automation.id, automation.enabled ? 'Switch off' : 'Switch on', () => settle(rpcClient.automations.update({
      projectId: automation.projectId, automationId: automation.id,
      draft: { name: automation.name, trigger: automation.trigger, conditions: [...automation.conditions], action: automation.action, enabled: !automation.enabled },
    }))),
    runNow: automation => void perform(automation.id, 'Run now', () => settle(rpcClient.automations.runNow({ projectId: automation.projectId, automationId: automation.id }))),
    test: automation => openEditor(automation, true),
    edit: automation => openEditor(automation),
    remove: automation => setDeleting(automation),
    approve: automation => void perform(automation.id, 'Switch on', () => settle(rpcClient.automations.approve({ projectId: automation.projectId, automationId: automation.id, revision: automation.revision }))),
    dismiss: automation => void perform(automation.id, 'Dismiss', () => settle(rpcClient.automations.delete({ projectId: automation.projectId, automationId: automation.id }))),
    openConversation: automation => onOpenWorkspace(automation.projectId, automation.projectId),
  };

  const cancelRun = async (run: AutomationRunView): Promise<void> => {
    const done = await perform(run.id, run.state === 'queued' ? 'Cancel run' : 'Stop run', () => settle(rpcClient.automations.cancelRun({ projectId: run.projectId, runId: run.id })));
    if (done) setOpenRun(done.value);
  };

  const readError = [overviewRead.error ? rpcErrorMessage(overviewRead.error, 'Read automations overview') : null, projectId !== null && listRead.error ? rpcErrorMessage(listRead.error, 'Read automations') : null, projectId !== null && runsRead.error ? rpcErrorMessage(runsRead.error, 'Read runs') : null].filter(Boolean).join(' · ');

  return <PageCanvas>
    <PageHeader kicker={<ProjectPicker projects={projects} project={projectName} onPick={onSelectProject} />} title="Automations"
      description={projectId === null ? 'Every project\'s automations and runs. Choose a project to change its automations, links and trusted authors.' : 'When something happens in this project, start work. Activity on a linked pull request or issue goes to its workspace.'}
      actions={projectId !== null && !empty ? <Button variant="primary" type="button" leadingIcon={PlusGlyph} onClick={() => openEditor(null)}>New automation</Button> : undefined} />

    {readError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-caption text-destructive"><span className="min-w-0 [overflow-wrap:anywhere]">{readError}</span><Button variant="ghost" size="compact" type="button" onClick={() => void refresh()}>Retry</Button></div> : null}
    {actionError ? <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 text-caption text-destructive"><span className="min-w-0 [overflow-wrap:anywhere]">{actionError}</span><Button variant="ghost" size="compact" type="button" onClick={() => setActionError(null)}>Dismiss</Button></div> : null}

    {empty ? null : <section aria-label="Automation summary" className={`${shape.container} mb-6 flex flex-col bg-surface-2 shadow-surface-1`}>
      <div className="grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border sm:[&>*:nth-child(-n+2)]:border-b-0">
        <Stat value={`${totals.on} of ${totals.total}`} label={totals.proposed ? `On · ${totals.proposed} proposed` : 'On'} />
        <Stat value={projectId === null ? totals.working : `${totals.working} / ${settings.concurrency}`} label="Working now" />
        <Stat value={totals.queued} label="Queued" />
        <Stat value={totals.failedToday} label="Failed today" />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
        <p className="min-w-0 flex-[1_1_16rem] text-caption text-muted-foreground">{projectId === null
          ? 'Each project has its own limits; choose one to change them.'
          : `At most ${settings.concurrency} ${settings.concurrency === 1 ? 'run works' : 'runs work'} at once, and each automation runs at most ${settings.dailyRunCap} ${settings.dailyRunCap === 1 ? 'time' : 'times'} a day.`} A run holds a slot only while its agent works; a workspace waiting for you does not.</p>
        {projectId !== null && listRead.value ? <Button variant="ghost" size="compact" type="button" leadingIcon={LimitsGlyph} onClick={() => setLimitsOpen(true)}>Limits</Button> : null}
      </div>
    </section>}

    {projectId === null ? <>
      <Section title="Projects">
        {projects.length ? <ul className={`${shape.container} flex flex-col divide-y divide-border bg-surface-2 shadow-surface-1`}>
          {projects.map(entry => {
            const summary = summaries.find(item => item.projectId === entry.id);
            const parts = summary && summary.total ? [`${summary.on} of ${summary.total} on`, summary.proposed ? `${summary.proposed} proposed` : null, summary.working ? `${summary.working} working` : null, summary.queued ? `${summary.queued} queued` : null].filter(Boolean).join(' · ') : 'No automations';
            return <li key={entry.id}><button type="button" aria-label={`Open automations for ${entry.name}`} className="flex w-full min-w-0 flex-wrap items-center justify-between gap-2 px-5 py-3 text-left" onClick={() => onSelectProject(entry.id)}>
              <span className="flex min-w-0 flex-col gap-0.5"><span className="text-body font-medium [overflow-wrap:anywhere]">{entry.name}</span><span className="text-caption text-muted-foreground">{parts}</span></span>
              {summary?.failedToday ? <Badge size="compact" color="red">{summary.failedToday} failed today</Badge> : null}
            </button></li>;
          })}
        </ul> : <p className="text-caption text-muted-foreground">No projects yet.</p>}
      </Section>
      <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Every project · choose one to change its automations</span>}>
        {overviewRead.initialLoading ? <p role="status" className="text-caption text-muted-foreground">Loading runs…</p>
          : overviewRead.value?.runs.length ? <RunsTable runs={overviewRead.value.runs} projects={projects} showProject now={now} onOpen={setOpenRun} />
            : <p className="text-caption text-muted-foreground">No runs yet. Every event an automation sees appears here, skipped ones included.</p>}
      </Section>
    </> : listRead.initialLoading ? <EmptyState icon={<ThinkingIndicator />} title="Loading automations…" />
      : empty ? <div className={`${shape.container} flex flex-col items-start gap-3 bg-surface-2 px-5 py-6 shadow-surface-1`}>
        <strong className="text-body font-semibold [overflow-wrap:anywhere]">No automations in {projectName}</strong>
        <p className="max-w-xl text-body text-muted-foreground">Start work when a pull request opens, an issue is labeled, or on a schedule. Installing the GitSpace GitHub App on its repository adds the default automations that send review feedback, failed checks and mentions to linked workspaces. You can also ask the project agent to set one up; what it proposes waits here until you switch it on.</p>
        <Button variant="primary" type="button" leadingIcon={PlusGlyph} onClick={() => openEditor(null)}>New automation</Button>
      </div>
        : listRead.value ? <>
          {groups.filter(group => group.automations.length).map(group => <Section key={group.title} title={group.title} aside={group.aside ? <span className="text-caption text-muted-foreground">{group.aside}</span> : undefined}>
            <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
              {group.automations.map((automation, index) => <AutomationCard key={automation.id} automation={automation} index={index} project={project} bot={bot} busy={busy === automation.id} now={now} handlers={handlers} />)}
            </CardGroup>
          </Section>)}
          <Section title="Linked pull requests and issues"
            aside={<Button variant="secondary" size="compact" type="button" leadingIcon={LinkGlyph} onClick={() => setLinking({ id: Date.now(), subject: null })}>Link a pull request or issue</Button>}>
            <p className="text-caption text-muted-foreground">Each has one workspace in this project, linked when GitSpace starts the workspace for it, when an agent or you link it, or by branch. What reaches the workspace is set by the automations under Sent to linked workspaces.</p>
            {links.length ? <LinksTable links={links} project={project} projectId={projectId} busy={busy} now={now} onOpenWorkspace={workspaceId => onOpenWorkspace(projectId, workspaceId)}
              onRelink={subject => setLinking({ id: Date.now(), subject })}
              onUnlink={subject => void perform(automationSubjectKey(subject), 'Unlink', () => settle(rpcClient.automations.unlink({ projectId, subject })))} />
              : <p className="text-caption text-muted-foreground">No pull request or issue is linked yet.</p>}
          </Section>
          <Section title="Trusted authors">
            <TrustList repository={github.repository} trusted={settings.trusted} onSave={async trusted => {
              await settle(rpcClient.automations.updateSettings({ projectId, settings: { ...settings, trusted } }));
              await refresh();
            }} />
          </Section>
          <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Every event seen, skipped ones included</span>}>
            {runsRead.value?.length ? <RunsTable runs={runsRead.value} projects={projects} showProject={false} now={now} onOpen={setOpenRun} />
              : <p className="text-caption text-muted-foreground">{runsRead.initialLoading ? 'Loading runs…' : 'No runs yet.'}</p>}
          </Section>
        </> : null}

    <Dialog open={editor !== null} onOpenChange={open => { if (!open) setEditor(null); }}>
      <DialogContent size="lg">{shownEditor && projectId !== null ? <AutomationEditor key={shownEditor.id} projectId={projectId} workspaces={project?.workspaces ?? []} github={github} source={shownEditor.source} testFirst={shownEditor.test} now={now}
        onCancel={() => setEditor(null)} onSaved={async () => { setEditor(null); await refresh(); }}
        onRan={async run => { setEditor(null); await refresh(); setOpenRun(run); }} /> : null}</DialogContent>
    </Dialog>
    <Dialog open={linking !== null} onOpenChange={open => { if (!open) setLinking(null); }}>
      <DialogContent>{shownLink && projectId !== null ? <LinkDialog key={shownLink.id} projectId={projectId} workspaces={project?.workspaces ?? []} subject={shownLink.subject} bot={github.bot}
        onCancel={() => setLinking(null)} onLinked={async () => { setLinking(null); await refresh(); }} /> : null}</DialogContent>
    </Dialog>
    <Dialog open={deleting !== null} onOpenChange={open => { if (!open) setDeleting(null); }}>
      <DialogContent size="sm">{shownDelete ? <>
        <DialogHeader>
          <DialogTitle>Delete {shownDelete.name}?</DialogTitle>
          <DialogDescription>It stops running. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" type="button" onClick={() => setDeleting(null)}>Keep it</Button>
          <Button variant="primary" type="button" loading={busy === shownDelete.id} disabled={busy !== null} onClick={() => void perform(shownDelete.id, 'Delete automation', () => settle(rpcClient.automations.delete({ projectId: shownDelete.projectId, automationId: shownDelete.id }))).then(done => { if (done) setDeleting(null); })}>Delete</Button>
        </DialogFooter>
      </> : null}</DialogContent>
    </Dialog>
    <Dialog open={openRun !== null} onOpenChange={open => { if (!open) setOpenRun(null); }}>
      <DialogContent size="lg">{shownRun ? <RunDetail key={shownRun.id} run={shownRun} project={projects.find(entry => entry.id === shownRun.projectId)} busy={busy === shownRun.id} onCancel={run => void cancelRun(run)}
        onOpenWorkspace={workspaceId => { setOpenRun(null); onOpenWorkspace(shownRun.projectId, workspaceId); }} /> : null}</DialogContent>
    </Dialog>
    <Dialog open={limitsOpen} onOpenChange={setLimitsOpen}>
      <DialogContent size="sm">{limitsOpen && projectId !== null ? <LimitsEditor settings={settings} onCancel={() => setLimitsOpen(false)} onSave={async next => {
        await settle(rpcClient.automations.updateSettings({ projectId, settings: next }));
        setLimitsOpen(false);
        await refresh();
      }} /> : null}</DialogContent>
    </Dialog>
  </PageCanvas>;
}
