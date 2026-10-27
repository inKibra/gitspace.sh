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
import { CheckCircle, ChevronDown, DotsHorizontal, Edit03, MessageChatCircle, MinusCircle, Play, Plus, RefreshCcw01, Settings01, Trash01 } from '@untitledui/icons';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useResultQuery } from 'result-rpc/react';
import {
  AUTOMATION_DEFAULT_SETTINGS,
  AUTOMATION_TRIGGER_FIELDS,
  automationErrors,
  describeAutomationSchedule,
  nextAutomationRunAt,
  parseAutomationSchedule,
  unknownAutomationPlaceholders,
  type AutomationAction,
  type AutomationDraft,
  type AutomationRunState,
  type AutomationRunView,
  type AutomationSettings,
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

type BadgeColor = 'blue' | 'amber' | 'green' | 'gray' | 'red';
const RUN_STATE_COLOR: Record<AutomationRunState, BadgeColor> = { running: 'blue', queued: 'amber', finished: 'green', skipped: 'gray', failed: 'red' };
const TRIGGER_LABEL: Record<AutomationTriggerKind, string> = { schedule: 'Schedule', manual: 'Manual' };
const TRIGGER_KINDS: readonly AutomationTriggerKind[] = ['schedule', 'manual'];
const TRIGGER_OPTION_LABEL: Record<AutomationTriggerKind, string> = { schedule: 'Schedule', manual: 'Manual only' };
type ActionKind = AutomationAction['kind'];
const ACTION_KINDS: readonly ActionKind[] = ['messageProjectAgent', 'messageWorkspace'];
const ACTION_LABEL: Record<ActionKind, string> = { messageProjectAgent: 'Message the project agent', messageWorkspace: 'Message a workspace' };

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
    {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
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

function triggerReadback(automation: AutomationView, now: number): ReactNode {
  if (automation.trigger.kind === 'manual') return <>Manual only: runs when you choose <strong className="font-semibold">Run now</strong></>;
  const next = automation.enabled && automation.proposal === null ? automation.nextRunAt : null;
  const described = describeAutomationSchedule(automation.trigger.cron);
  // An expression with no plain-words form reads back as itself; show it once.
  return <><code className="font-mono text-caption">{automation.trigger.cron}</code>{described === `${automation.trigger.cron.trim()} (UTC)` ? ' (UTC)' : <> · {described}</>}{next ? <> · <span title={formatUtc(next)}>next {formatRelativeTime(next, now)}</span></> : null}</>;
}

interface CardHandlers {
  toggle(automation: AutomationView): void;
  runNow(automation: AutomationView): void;
  edit(automation: AutomationView): void;
  remove(automation: AutomationView): void;
  approve(automation: AutomationView): void;
  dismiss(automation: AutomationView): void;
  openConversation(automation: AutomationView): void;
}

function AutomationCard({ automation, index, project, busy, now, handlers }: { automation: AutomationView; index: number; project: AutomationsProject | undefined; busy: boolean; now: number; handlers: CardHandlers }): ReactElement {
  const { proposal } = automation;
  return <Card index={index}>
    <CardHeader>
      <CardTitle><span className="[overflow-wrap:anywhere]">{automation.name}</span></CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">
        {proposal ? <><Badge size="compact" color="amber">Proposed</Badge><span>by the project agent · {formatRelativeTime(proposal.proposedAt, now)}</span></>
          : automation.lastRun ? <><span>Last run {formatRelativeTime(automation.lastRun.at, now)}</span><RunBadge state={automation.lastRun.state} /></> : <span>No runs yet</span>}
      </span></CardDescription>
      {proposal ? null : <CardAction>
        <div className="flex items-center gap-2">
          <Switch label={automation.enabled ? 'On' : 'Off'} checked={automation.enabled} disabled={busy} onToggle={() => handlers.toggle(automation)} />
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automation.name}`} disabled={busy}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
            <DropdownContent align="end" className="min-w-[200px] w-[200px]">
              <MenuItem index={0} icon={PlayGlyph} label="Run now" onSelect={() => handlers.runNow(automation)} />
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
        <Row label="Then">{automation.action.kind === 'messageProjectAgent' ? 'Message the project agent'
          : <>Message workspace <span className="font-mono text-caption">{workspaceLabel(project, automation.projectId, automation.action.workspaceId)}</span></>}</Row>
        <Row label="Instruction"><span className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{automation.action.instruction}</span></Row>
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
      : automation.enabled ? null : <CardFooter><span className="text-caption text-muted-foreground">Off: {automation.trigger.kind === 'schedule' ? 'its schedule starts no runs' : 'it starts no runs'}</span></CardFooter>}
  </Card>;
}

function RunsTable({ runs, projects, showProject, now, onOpen }: { runs: readonly AutomationRunView[]; projects: readonly AutomationsProject[]; showProject: boolean; now: number; onOpen(run: AutomationRunView): void }): ReactElement {
  const project = (run: AutomationRunView) => projects.find(entry => entry.id === run.projectId);
  return <>
    <ul aria-label="Runs" className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
      {runs.map(run => <li key={run.id}><button type="button" className="flex w-full min-w-0 flex-col gap-0.5 py-3 text-left" onClick={() => onOpen(run)}>
        <span className="flex items-center justify-between gap-2"><RunBadge state={run.state} /><span className="text-caption tabular-nums text-muted-foreground">{formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, now)}</span></span>
        <span className="text-body [overflow-wrap:anywhere]">{showProject ? <span className="text-muted-foreground">{project(run)?.name ?? run.projectId} · </span> : null}{run.automationName}</span>
        {run.outcome ? <span className="text-caption text-muted-foreground [overflow-wrap:anywhere]">{run.outcome}</span> : null}
        <span className="text-caption text-muted-foreground">{TRIGGER_LABEL[run.trigger]} · <span className={run.workspaceId === run.projectId ? undefined : 'font-mono'}>{workspaceLabel(project(run), run.projectId, run.workspaceId)}</span></span>
      </button></li>)}
    </ul>
    <div className="hidden sm:block"><Table size="compact">
      <TableHeader><TableRow>
        <TableHead className="w-24">Status</TableHead>
        {showProject ? <TableHead className="w-[16%]">Project</TableHead> : null}
        <TableHead className={showProject ? 'w-[34%]' : 'w-[44%]'}>Automation</TableHead>
        <TableHead className="w-24">Trigger</TableHead>
        <TableHead>Workspace</TableHead>
        <TableHead className="w-24 text-right">When</TableHead>
      </TableRow></TableHeader>
      <TableBody>
        {runs.map((run, index) => <TableRow key={run.id} index={index} className="cursor-pointer" onClick={() => onOpen(run)}>
          <TableCell><RunBadge state={run.state} /></TableCell>
          {showProject ? <TableCell className="max-w-0"><span className="block truncate">{project(run)?.name ?? run.projectId}</span></TableCell> : null}
          <TableCell className="max-w-0">
            <button type="button" className="block w-full truncate text-left text-foreground" onClick={(event) => { event.stopPropagation(); onOpen(run); }}>{run.automationName}</button>
            {run.outcome ? <span className="block truncate text-caption text-muted-foreground">{run.outcome}</span> : null}
          </TableCell>
          <TableCell className="text-muted-foreground">{TRIGGER_LABEL[run.trigger]}</TableCell>
          <TableCell className="max-w-0"><span className={`block truncate text-caption ${run.workspaceId === run.projectId ? '' : 'font-mono'}`}>{workspaceLabel(project(run), run.projectId, run.workspaceId)}</span></TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{formatRelativeTime(run.finishedAt ?? run.startedAt ?? run.scheduledFor, now)}</TableCell>
        </TableRow>)}
      </TableBody>
    </Table></div>
  </>;
}

function RunDetail({ run, project, busy, onCancel, onOpenWorkspace }: { run: AutomationRunView; project: AutomationsProject | undefined; busy: boolean; onCancel(run: AutomationRunView): void; onOpenWorkspace(run: AutomationRunView): void }): ReactElement {
  const [confirmStop, setConfirmStop] = useState(false);
  const workspace = workspaceLabel(project, run.projectId, run.workspaceId);
  const stopping = run.state === 'running' && confirmStop;
  return <>
    <DialogHeader>
      <DialogTitle><span className="flex flex-wrap items-center gap-2"><span className="[overflow-wrap:anywhere]">{run.automationName}</span><RunBadge state={run.state} /></span></DialogTitle>
      <DialogDescription>{project ? `${project.name} · ` : ''}{run.trigger === 'schedule' ? 'Scheduled for' : 'Run now at'} {formatUtc(run.scheduledFor)}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      {run.outcome ? <p className="text-body [overflow-wrap:anywhere]">{run.outcome}</p> : null}
      <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Sent to</strong>
        <span className={`text-caption ${run.workspaceId === run.projectId ? '' : 'font-mono'}`}>{workspace}</span>
      </section>
      <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Timeline (UTC)</strong>
        {run.timeline.length ? <ol className="flex flex-col gap-1.5">{run.timeline.map((step, index) => <li key={`${index}:${step.label}`} className="flex gap-3 text-body">
          <time dateTime={step.at.toISOString()} className="w-16 shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{UTC_CLOCK.format(step.at)}</time><span className="min-w-0 [overflow-wrap:anywhere]">{step.label}</span>
        </li>)}</ol> : <p className="text-caption text-muted-foreground">Nothing has happened yet.</p>}
      </section>
      {stopping ? <p role="alert" className="text-body">Stopping ends the agent's current turn in {workspace}, including any other work in that turn.</p> : null}
    </div>
    <DialogFooter>
      {run.state === 'queued' ? <Button variant="secondary" type="button" loading={busy} disabled={busy} onClick={() => onCancel(run)}>Cancel run</Button> : null}
      {run.state === 'running' && !confirmStop ? <Button variant="secondary" type="button" disabled={busy} onClick={() => setConfirmStop(true)}>Stop run</Button> : null}
      {stopping ? <>
        <Button variant="secondary" type="button" onClick={() => setConfirmStop(false)}>Keep running</Button>
        <Button variant="primary" type="button" loading={busy} disabled={busy} onClick={() => onCancel(run)}>Stop the turn</Button>
      </> : null}
      {stopping ? null : <Button variant="primary" type="button" onClick={() => onOpenWorkspace(run)}>{run.workspaceId === run.projectId ? 'Open the project agent' : `Open ${workspace}`}</Button>}
    </DialogFooter>
  </>;
}

type EditorField = 'name' | 'cron' | 'workspace' | 'instruction';
/** The `field` an `automationInvalid` error names, mapped to the editor control that shows it. */
const INVALID_FIELD: Record<string, EditorField> = { name: 'name', 'trigger.cron': 'cron', 'action.workspaceId': 'workspace', 'action.instruction': 'instruction' };

function editorFailure(cause: unknown, key: string, operation: string): { key: string; field: EditorField | null; message: string } {
  if (automationErrors.automationInvalid.is(cause)) return { key, field: INVALID_FIELD[cause.data.field] ?? null, message: cause.data.message };
  return { key, field: null, message: rpcErrorMessage(cause, operation) };
}

function AutomationEditor({ projectId, workspaces, source, now, onCancel, onSaved }: { projectId: string; workspaces: readonly AutomationWorkspace[]; source: AutomationView | null; now: number; onCancel(): void; onSaved(): Promise<void> }): ReactElement {
  const shape = useShape();
  const proposal = source?.proposal ?? null;
  const [name, setName] = useState(source?.name ?? '');
  const [triggerKind, setTriggerKind] = useState<AutomationTriggerKind>(source?.trigger.kind ?? 'schedule');
  const [schedule, setSchedule] = useState<ScheduleChoice>(() => scheduleChoice(source?.trigger.kind === 'schedule' ? source.trigger.cron : NEW_AUTOMATION_CRON));
  const [actionKind, setActionKind] = useState<ActionKind>(source?.action.kind ?? 'messageProjectAgent');
  const [workspaceId, setWorkspaceId] = useState(source?.action.kind === 'messageWorkspace' ? source.action.workspaceId : '');
  const [instruction, setInstruction] = useState(source?.action.instruction ?? '');
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | null>(null);
  const [failure, setFailure] = useState<{ key: string; field: EditorField | null; message: string } | null>(null);
  const [tested, setTested] = useState<{ key: string; results: readonly AutomationTestResult[]; instruction: string } | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const instructionFocused = useRef(false);
  const caret = useRef<number | null>(null);

  useEffect(() => {
    const element = instructionRef.current;
    if (caret.current === null || !element) return;
    element.focus();
    element.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [instruction]);

  const cron = scheduleCron(schedule);
  const parsed = triggerKind === 'schedule' ? parseAutomationSchedule(cron) : null;
  const cronError = parsed && 'error' in parsed ? parsed.error : null;
  const trigger: AutomationTrigger = triggerKind === 'schedule' ? { kind: 'schedule', cron } : { kind: 'manual' };
  const action: AutomationAction = actionKind === 'messageWorkspace' ? { kind: 'messageWorkspace', workspaceId, instruction } : { kind: 'messageProjectAgent', instruction };
  // A person's automation runs at once; a proposal edited here is switched on when saved.
  const draft: AutomationDraft = { name: name.trim(), trigger, action, enabled: source === null || proposal !== null || source.enabled };
  const key = JSON.stringify(draft);
  const unknown = unknownAutomationPlaceholders(instruction, triggerKind);
  const incomplete = !draft.name || cronError !== null || (actionKind === 'messageWorkspace' && !workspaceId) || !instruction.trim() || unknown.length > 0;
  const errors: Partial<Record<EditorField, string>> = {};
  if (attempted && !draft.name) errors.name = 'Name the automation.';
  if (cronError) errors.cron = cronError;
  if (attempted && actionKind === 'messageWorkspace' && !workspaceId) errors.workspace = 'Choose the workspace to message.';
  if (unknown.length) errors.instruction = `${unknown.map(path => `{{${path}}}`).join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of ${triggerKind === 'schedule' ? 'a schedule' : 'a manual run'}. Insert a field to see the ones it has.`;
  else if (attempted && !instruction.trim()) errors.instruction = 'Write what the agent should do.';
  if (failure?.key === key && failure.field) errors[failure.field] = failure.message;
  const formError = failure?.key === key && failure.field === null ? failure.message : null;

  const choices = workspaces.filter(workspace => workspace.active || workspace.id === workspaceId);
  const nextRun = triggerKind === 'schedule' && cronError === null ? new Date(nextAutomationRunAt(cron, now)) : null;

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
      const saved = source
        ? await settle(rpcClient.automations.update({ projectId, automationId: source.id, draft }))
        : await settle(rpcClient.automations.create({ projectId, draft }));
      if (proposal && saved.proposal) await settle(rpcClient.automations.approve({ projectId, automationId: saved.id, revision: saved.revision }));
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
      const value = await settle(rpcClient.automations.test({ projectId, draft }));
      setTested({ key, results: value.results, instruction: value.instruction });
      setFailure(null);
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Test automation'));
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
      <DialogDescription>{proposal ? 'Saving switches it on.' : 'Runs on a schedule (UTC) or only when you choose Run now, and messages an agent in this project.'}</DialogDescription>
    </DialogHeader>
    <form id="automation-editor" noValidate className="flex min-w-0 flex-col gap-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field label="Name" error={errors.name}><TextInput label="Name" value={name} onChange={setName} invalid={errors.name !== undefined} placeholder="Nightly dependency audit" /></Field>

      <section aria-label="When" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">When</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Trigger"><Select value={triggerKind} onValueChange={value => { const kind = TRIGGER_KINDS.find(entry => entry === value); if (kind) setTriggerKind(kind); }}>
            <SelectTrigger aria-label="Trigger" />{options(TRIGGER_KINDS.map(kind => ({ value: kind, label: TRIGGER_OPTION_LABEL[kind] })))}
          </Select></Field>
          {triggerKind === 'schedule' ? <Field label="Repeats"><Select value={schedule.preset} onValueChange={setPreset}>
            <SelectTrigger aria-label="Repeats" />{options(SCHEDULE_PRESETS.map(preset => ({ value: preset, label: PRESET_LABEL[preset] })))}
          </Select></Field> : null}
        </div>
        {triggerKind === 'schedule' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {schedule.preset === 'hourly' ? <Field label="At minute"><Select value={String(schedule.minute)} onValueChange={value => setSchedule(current => ({ ...current, minute: Number(value) }))}>
            <SelectTrigger aria-label="At minute" />{options(MINUTES.map(minute => ({ value: String(minute), label: `:${twoDigits(minute)}` })))}
          </Select></Field> : null}
          {schedule.preset === 'weekly' ? <Field label="On"><Select value={String(schedule.weekday)} onValueChange={value => setSchedule(current => ({ ...current, weekday: Number(value) }))}>
            <SelectTrigger aria-label="On" />{options(WEEKDAYS.map((day, index) => ({ value: String(index), label: day })))}
          </Select></Field> : null}
          {schedule.preset === 'daily' || schedule.preset === 'weekly' ? <Field label="At (UTC)"><TextInput label="At (UTC)" type="time" value={clock} onChange={setClock} /></Field> : null}
          {schedule.preset === 'custom' ? <div className="sm:col-span-2"><Field label="Cron expression (UTC)"><TextInput label="Cron expression (UTC)" value={schedule.custom} onChange={custom => setSchedule(current => ({ ...current, custom }))} invalid={errors.cron !== undefined} mono placeholder={NEW_AUTOMATION_CRON} /></Field></div> : null}
        </div> : <p className="text-caption text-muted-foreground">It runs only when you choose Run now on its card.</p>}
        {triggerKind === 'schedule' ? errors.cron
          ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.cron}</p>
          : <p aria-label="Schedule readback" className="text-caption text-muted-foreground"><span className="font-medium text-foreground">{describeAutomationSchedule(cron)}</span>{nextRun ? <> · next {formatUtc(nextRun)} ({formatRelativeTime(nextRun, now)})</> : null}</p>
          : null}
      </section>

      <section aria-label="Then" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">Then</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Action"><Select value={actionKind} onValueChange={value => { const kind = ACTION_KINDS.find(entry => entry === value); if (kind) setActionKind(kind); }}>
            <SelectTrigger aria-label="Action" />{options(ACTION_KINDS.map(kind => ({ value: kind, label: ACTION_LABEL[kind] })))}
          </Select></Field>
          {actionKind === 'messageWorkspace' ? <Field label="Workspace" error={errors.workspace}><Select value={workspaceId} onValueChange={setWorkspaceId} disabled={choices.length === 0}>
            <SelectTrigger aria-label="Workspace" placeholder={choices.length ? 'Choose a workspace' : 'No open workspaces'} />{options(choices.map(workspace => ({ value: workspace.id, label: workspace.active ? workspace.name : `${workspace.name} (archived)` })))}
          </Select></Field> : null}
        </div>
        <Field label="Instruction" error={errors.instruction}>
          <textarea ref={instructionRef} aria-label="Instruction" aria-invalid={errors.instruction !== undefined || undefined} rows={5} value={instruction}
            placeholder="What the agent should do, e.g. Check for outdated dependencies and open a pull request for the ones whose tests pass."
            onFocus={() => { instructionFocused.current = true; }}
            onChange={event => setInstruction(event.currentTarget.value)}
            className={`${shape.input} w-full min-w-0 resize-y border bg-surface-2 p-2 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${errors.instruction ? 'border-destructive' : 'border-border'}`} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" leadingIcon={PlusGlyph}>Insert a field</Button>} />
            <DropdownContent align="start" className="min-w-[260px] w-[260px]">
              {AUTOMATION_TRIGGER_FIELDS[triggerKind].map((field, index) => <MenuItem key={field.path} index={index} label={`${field.label} · {{${field.path}}}`} onSelect={() => insertField(field.path)} />)}
            </DropdownContent>
          </DropdownMenu>
          <span className="min-w-0 text-caption text-muted-foreground">A field in <span className="font-mono">{'{{…}}'}</span> is filled in when it runs; Test shows the result.</span>
        </div>
      </section>

      <section aria-label="Test" className={`${shape.container} flex min-w-0 flex-col gap-3 border border-border p-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="compact" type="button" leadingIcon={TestGlyph} loading={pending === 'test'} disabled={pending !== null || cronError !== null} onClick={() => void test()}>Test</Button>
          <span className="min-w-0 text-caption text-muted-foreground">Shows when it would run and the instruction the agent would read. Nothing runs.</span>
        </div>
        {tested?.key === key ? <div className="flex flex-col gap-3 border-t border-border pt-3">
          <TestResults results={tested.results} />
          <strong className="text-caption font-medium text-muted-foreground">The agent reads</strong>
          <blockquote aria-label="Rendered instruction" className={`${shape.input} whitespace-pre-wrap border border-border bg-surface-2 p-2 text-body [overflow-wrap:anywhere]`}>{tested.instruction}</blockquote>
        </div> : null}
      </section>
      {formError ? <p role="alert" className="text-caption text-destructive">{formError}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-editor" loading={pending === 'save'} disabled={pending !== null}>{proposal ? 'Save and switch on' : source ? 'Save changes' : 'Create automation'}</Button>
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
    try { await onSave({ concurrency: nextConcurrency, dailyRunCap: nextCap }); }
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

  const [editor, setEditor] = useState<{ id: number; source: AutomationView | null } | null>(null);
  const [deleting, setDeleting] = useState<AutomationView | null>(null);
  const [openRun, setOpenRun] = useState<AutomationRunView | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const shownEditor = useClosingValue(editor);
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
  const ordered = [...automations.filter(automation => automation.proposal !== null), ...automations.filter(automation => automation.proposal === null)];
  const totals = (projectId === null ? summaries : summaries.filter(entry => entry.projectId === projectId)).reduce((sum, entry) => ({
    total: sum.total + entry.total, on: sum.on + entry.on, proposed: sum.proposed + entry.proposed,
    working: sum.working + entry.working, queued: sum.queued + entry.queued, failedToday: sum.failedToday + entry.failedToday,
  }), { total: 0, on: 0, proposed: 0, working: 0, queued: 0, failedToday: 0 });
  const empty = projectId !== null && listRead.value !== undefined && automations.length === 0;
  const projectName = projectId === null ? 'All projects' : project?.name ?? projectId;
  const openEditor = (source: AutomationView | null): void => setEditor({ id: Date.now(), source });

  const handlers: CardHandlers = {
    toggle: automation => void perform(automation.id, automation.enabled ? 'Switch off' : 'Switch on', () => settle(rpcClient.automations.update({
      projectId: automation.projectId, automationId: automation.id,
      draft: { name: automation.name, trigger: automation.trigger, action: automation.action, enabled: !automation.enabled },
    }))),
    runNow: automation => void perform(automation.id, 'Run now', () => settle(rpcClient.automations.runNow({ projectId: automation.projectId, automationId: automation.id }))),
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
      description={projectId === null ? 'Every project\'s automations and runs. Choose a project to change its automations.' : 'Message the project agent or a workspace on a schedule, or whenever you choose Run now.'}
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
            : <p className="text-caption text-muted-foreground">No runs yet. Scheduled and manual runs appear here.</p>}
      </Section>
    </> : listRead.initialLoading ? <EmptyState icon={<ThinkingIndicator />} title="Loading automations…" />
      : empty ? <div className={`${shape.container} flex flex-col items-start gap-3 bg-surface-2 px-5 py-6 shadow-surface-1`}>
        <strong className="text-body font-semibold [overflow-wrap:anywhere]">No automations in {projectName}</strong>
        <p className="max-w-xl text-body text-muted-foreground">Message the project agent or a workspace on a schedule, or whenever you choose Run now. You can also ask the project agent to set one up; what it proposes waits here until you switch it on.</p>
        <Button variant="primary" type="button" leadingIcon={PlusGlyph} onClick={() => openEditor(null)}>New automation</Button>
      </div>
        : listRead.value ? <>
          <Section title="Automations">
            <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
              {ordered.map((automation, index) => <AutomationCard key={automation.id} automation={automation} index={index} project={project} busy={busy === automation.id} now={now} handlers={handlers} />)}
            </CardGroup>
          </Section>
          <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Scheduled and manual runs, skipped ones included</span>}>
            {runsRead.value?.length ? <RunsTable runs={runsRead.value} projects={projects} showProject={false} now={now} onOpen={setOpenRun} />
              : <p className="text-caption text-muted-foreground">{runsRead.initialLoading ? 'Loading runs…' : 'No runs yet.'}</p>}
          </Section>
        </> : null}

    <Dialog open={editor !== null} onOpenChange={open => { if (!open) setEditor(null); }}>
      <DialogContent size="lg">{shownEditor && projectId !== null ? <AutomationEditor key={shownEditor.id} projectId={projectId} workspaces={project?.workspaces ?? []} source={shownEditor.source} now={now}
        onCancel={() => setEditor(null)} onSaved={async () => { setEditor(null); await refresh(); }} /> : null}</DialogContent>
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
        onOpenWorkspace={run => { setOpenRun(null); onOpenWorkspace(run.projectId, run.workspaceId); }} /> : null}</DialogContent>
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
