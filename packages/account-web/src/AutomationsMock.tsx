// Throwaway design mock for the Automations page. Static data only; not part of the app.
import {
  Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, InputField, InputGroup, MenuItem,
  Select, SelectContent, SelectItem, SelectTrigger, ShapeProvider, SizeProvider, Switch,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TooltipProvider, untitledIcons, useShape,
} from '@gitspace/ui';
import { CheckCircle, DotsHorizontal, Edit03, File02, MinusCircle, Play, Plus, Trash01, XCircle } from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';

type RunStatus = 'running' | 'queued' | 'finished' | 'skipped' | 'failed';
type Mode = 'Plan' | 'Code' | 'Review';
const STATUS_COLOR: Record<RunStatus, 'blue' | 'gray' | 'green' | 'amber' | 'red'> = { running: 'blue', queued: 'amber', finished: 'green', skipped: 'gray', failed: 'red' };
const MODE_COLOR: Record<Mode, 'indigo' | 'emerald' | 'violet'> = { Plan: 'indigo', Code: 'emerald', Review: 'violet' };

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  source: { kind: 'account' } | { kind: 'repository'; path: string; branch: string };
  when: ReactNode;
  onlyIf: readonly ReactNode[];
  then: ReactNode;
  mode?: Mode;
  again: string;
  last: { at: string; status: RunStatus };
}

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

const AUTOMATIONS: readonly Automation[] = [
  {
    id: 'review', name: 'Review pull requests', enabled: true, source: { kind: 'account' },
    when: <>GitHub · pull request {code('opened')}, {code('ready_for_review')}, {code('synchronize')}</>,
    onlyIf: [<>base branch is {code('main')}</>, <>not a draft</>, <>author is not {code('dependabot[bot]')}</>],
    then: <>Start a workspace for the pull request with agent {code('reviewer')}</>, mode: 'Review',
    again: 'Send the event to its workspace', last: { at: '4 min ago', status: 'running' },
  },
  {
    id: 'triage', name: 'Triage new issues', enabled: true,
    source: { kind: 'repository', path: '.gitspace/automations/triage-issues.md', branch: 'main' },
    when: <>GitHub · issue {code('opened')}</>,
    onlyIf: [<>no label {code('wontfix')}</>],
    then: <>Start a workspace for the issue with agent {code('default')}</>, mode: 'Plan',
    again: 'Send the event to its workspace', last: { at: '12 min ago', status: 'running' },
  },
  {
    id: 'audit', name: 'Nightly dependency audit', enabled: true, source: { kind: 'account' },
    when: <>Schedule · {code('0 6 * * *')} · daily 06:00 UTC · next in 9 h</>,
    onlyIf: [],
    then: <>Message the project agent</>,
    again: 'Every tick is a new message', last: { at: '7 h ago', status: 'failed' },
  },
  {
    id: 'ci', name: 'Fix failing CI on main', enabled: false, source: { kind: 'account' },
    when: <>GitHub · check suite {code('completed')}</>,
    onlyIf: [<>conclusion is {code('failure')}</>, <>branch is {code('main')}</>],
    then: <>Start a workspace for the commit with agent {code('default')}</>, mode: 'Code',
    again: 'Send the event to its workspace', last: { at: '3 d ago', status: 'finished' },
  },
];

interface Run {
  id: string;
  status: RunStatus;
  automation: string;
  event: string;
  subject: string;
  workspace: string | null;
  outcome: string;
  at: string;
  checks: readonly { label: string; passed: boolean | null }[];
  timeline: readonly { at: string; label: string }[];
}

const RUNS: readonly Run[] = [
  {
    id: 'r7', status: 'queued', automation: 'Review pull requests', event: 'pull_request.opened', subject: 'PR #1143 · Drop .omp agent support',
    workspace: null, outcome: 'Waiting for a slot: 2 of 2 runs are working', at: '1 min ago',
    checks: [{ label: 'base branch is main', passed: true }, { label: 'not a draft', passed: true }, { label: 'author is not dependabot[bot]', passed: true }],
    timeline: [{ at: '14:02:11', label: 'Delivery received' }, { at: '14:02:11', label: 'Filter passed' }, { at: '14:02:11', label: 'Queued: 2 of 2 runs working' }],
  },
  {
    id: 'r6', status: 'running', automation: 'Review pull requests', event: 'pull_request.synchronize', subject: 'PR #1142 · Narrow combined programs',
    workspace: 'review-pr-1142', outcome: 'Reviewer agent working', at: '4 min ago',
    checks: [{ label: 'base branch is main', passed: true }, { label: 'not a draft', passed: true }, { label: 'author is not dependabot[bot]', passed: true }],
    timeline: [{ at: '13:58:40', label: 'Delivery received' }, { at: '13:58:40', label: 'Filter passed' }, { at: '13:58:41', label: 'Started workspace review-pr-1142 in Review' }, { at: '13:58:52', label: 'Agent working' }],
  },
  {
    id: 'r5', status: 'running', automation: 'Triage new issues', event: 'issues.opened', subject: 'Issue #388 · LFS download stalls on attach',
    workspace: 'triage-issue-388', outcome: 'Agent working', at: '12 min ago',
    checks: [{ label: "no label 'wontfix'", passed: true }],
    timeline: [{ at: '13:50:03', label: 'Delivery received' }, { at: '13:50:03', label: 'Filter passed' }, { at: '13:50:04', label: 'Started workspace triage-issue-388 in Plan' }],
  },
  {
    id: 'r4', status: 'skipped', automation: 'Review pull requests', event: 'pull_request.opened', subject: 'PR #1141 · WIP: automations run model',
    workspace: null, outcome: 'Filter: the pull request is a draft', at: '38 min ago',
    checks: [{ label: 'base branch is main', passed: true }, { label: 'not a draft', passed: false }, { label: 'author is not dependabot[bot]', passed: null }],
    timeline: [{ at: '13:24:19', label: 'Delivery received' }, { at: '13:24:19', label: 'Skipped: the pull request is a draft' }],
  },
  {
    id: 'r3', status: 'finished', automation: 'Review pull requests', event: 'pull_request.synchronize', subject: 'PR #1139 · Machine shutdown escalation',
    workspace: 'review-pr-1139', outcome: 'Sent to existing workspace; agent finished its turn', at: '1 h ago',
    checks: [{ label: 'base branch is main', passed: true }, { label: 'not a draft', passed: true }, { label: 'author is not dependabot[bot]', passed: true }],
    timeline: [{ at: '12:57:30', label: 'Delivery received' }, { at: '12:57:30', label: 'Filter passed' }, { at: '12:57:30', label: 'Sent to existing workspace review-pr-1139' }, { at: '13:04:12', label: 'Agent finished its turn' }],
  },
  {
    id: 'r2', status: 'finished', automation: 'Triage new issues', event: 'issues.opened', subject: 'Issue #387 · Settings page loses scroll',
    workspace: 'triage-issue-387', outcome: 'Agent waiting for plan approval', at: '2 h ago',
    checks: [{ label: "no label 'wontfix'", passed: true }],
    timeline: [{ at: '11:40:55', label: 'Delivery received' }, { at: '11:40:55', label: 'Filter passed' }, { at: '11:40:56', label: 'Started workspace triage-issue-387 in Plan' }, { at: '11:46:20', label: 'Agent waiting for plan approval' }],
  },
  {
    id: 'r1', status: 'failed', automation: 'Nightly dependency audit', event: 'schedule 06:00 UTC', subject: '—',
    workspace: 'inkibra core', outcome: 'Darktop was offline; the message was not delivered', at: '7 h ago',
    checks: [],
    timeline: [{ at: '06:00:00', label: 'Tick' }, { at: '06:00:01', label: 'Failed: Darktop was offline' }],
  },
];

function Stat({ value, label }: { value: ReactNode; label: string }): ReactElement {
  return <div className="flex flex-col gap-0.5 px-5 py-4">
    <strong className="text-title font-semibold tabular-nums text-foreground">{value}</strong>
    <span className="text-caption text-muted-foreground">{label}</span>
  </div>;
}

function Row({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return <>
    <dt className="pt-0.5 text-caption font-medium text-muted-foreground">{label}</dt>
    <dd className="text-body text-foreground">{children}</dd>
  </>;
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }): ReactElement {
  return <label className="flex min-w-0 flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">{label}</span>{children}</label>;
}

function options(values: readonly string[]): ReactElement {
  return <SelectContent>{values.map((value, index) => <SelectItem value={value} index={index} key={value}>{value}</SelectItem>)}</SelectContent>;
}

function AutomationCard({ automation, index, onEdit }: { automation: Automation; index: number; onEdit(): void }): ReactElement {
  const [enabled, setEnabled] = useState(automation.enabled);
  const repository = automation.source.kind === 'repository' ? automation.source : null;
  return <Card index={index}>
    <CardHeader>
      <CardTitle><span className="flex items-center gap-2">{automation.name}
        {automation.mode ? <Badge size="compact" color={MODE_COLOR[automation.mode]}>{automation.mode}</Badge> : null}
      </span></CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">{repository
        ? <><File02 width={14} height={14} strokeWidth={1.5} />{code(repository.path)} on {code(repository.branch)}</>
        : 'Defined in GitSpace'}
        <span>· last run {automation.last.at}</span><Badge variant="dot" size="compact" color={STATUS_COLOR[automation.last.status]}>{automation.last.status}</Badge>
      </span></CardDescription>
      <CardAction>
        <div className="flex items-center gap-2">
          <Switch label={enabled ? 'On' : 'Off'} checked={enabled} onToggle={() => setEnabled(value => !value)} />
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automation.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
            <DropdownContent align="end" className="min-w-[200px] w-[200px]">
              <MenuItem index={0} icon={glyph(Play)} label="Run now" onSelect={() => undefined} />
              {repository
                ? <MenuItem index={1} icon={glyph(File02)} label="Open file" onSelect={() => undefined} />
                : <MenuItem index={1} icon={glyph(Edit03)} label="Edit" onSelect={onEdit} />}
              {repository ? null : <MenuItem index={2} icon={glyph(Trash01)} label="Delete" onSelect={() => undefined} />}
            </DropdownContent>
          </DropdownMenu>
        </div>
      </CardAction>
    </CardHeader>
    <CardContent>
      <dl className="grid grid-cols-[9rem_1fr] gap-x-4 gap-y-2">
        <Row label="When">{automation.when}</Row>
        <Row label="Only if">{automation.onlyIf.length === 0 ? <span className="text-muted-foreground">Always</span>
          : <span className="flex flex-wrap gap-x-1.5">{automation.onlyIf.map((condition, at) => <span key={at}>{at > 0 ? '· ' : ''}{condition}</span>)}</span>}</Row>
        <Row label="Then">{automation.then}{automation.mode ? <> · starts in <strong className="font-semibold">{automation.mode}</strong></> : null}</Row>
        <Row label="Same subject again">{automation.again}</Row>
      </dl>
    </CardContent>
    {enabled ? null : <CardFooter><span className="text-caption text-muted-foreground">Off: events are not recorded as runs</span></CardFooter>}
  </Card>;
}

function RunsTable({ onOpen }: { onOpen(run: Run): void }): ReactElement {
  return <Table size="compact">
    <TableHeader><TableRow><TableHead className="w-24">Status</TableHead><TableHead className="w-[42%]">Subject</TableHead><TableHead>Automation · event</TableHead><TableHead>Workspace</TableHead><TableHead className="w-24 text-right">When</TableHead></TableRow></TableHeader>
    <TableBody>
      {RUNS.map((run, index) => <TableRow key={run.id} index={index} className="cursor-pointer" onClick={() => onOpen(run)}>
        <TableCell><Badge variant="dot" size="compact" color={STATUS_COLOR[run.status]}>{run.status}</Badge></TableCell>
        <TableCell className="max-w-0">
          <span className="block truncate">{run.subject}</span>
          <span className="block truncate text-caption text-muted-foreground">{run.outcome}</span>
        </TableCell>
        <TableCell className="max-w-0">
          <span className="block truncate">{run.automation}</span>
          <span className="block truncate font-mono text-caption text-muted-foreground">{run.event}</span>
        </TableCell>
        <TableCell>{run.workspace ? <span className="font-mono text-caption underline decoration-dotted underline-offset-2">{run.workspace}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">{run.at}</TableCell>
      </TableRow>)}
    </TableBody>
  </Table>;
}

function RunDetail({ run }: { run: Run }): ReactElement {
  return <>
    <DialogHeader>
      <DialogTitle><span className="flex items-center gap-2">{run.subject}<Badge variant="dot" size="compact" color={STATUS_COLOR[run.status]}>{run.status}</Badge></span></DialogTitle>
      <DialogDescription>{run.automation} · <span className="font-mono">{run.event}</span> · {run.at}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      {run.checks.length ? <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Only if</strong>
        <ul className="flex flex-col gap-1.5">{run.checks.map(check => <li key={check.label} className="flex items-center gap-2 text-body">
          {check.passed === true ? <CheckCircle className="text-success" width={16} height={16} strokeWidth={1.5} />
            : check.passed === false ? <XCircle className="text-destructive" width={16} height={16} strokeWidth={1.5} />
              : <MinusCircle className="text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
          <span className={check.passed === null ? 'text-muted-foreground' : 'text-foreground'}>{check.label}{check.passed === null ? ' (not checked)' : ''}</span>
        </li>)}</ul>
      </section> : null}
      <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Timeline</strong>
        <ol className="flex flex-col gap-1.5">{run.timeline.map(step => <li key={step.at + step.label} className="flex gap-3 text-body">
          <span className="w-16 shrink-0 font-mono text-caption tabular-nums text-muted-foreground">{step.at}</span><span>{step.label}</span>
        </li>)}</ol>
      </section>
    </div>
    <DialogFooter>
      <Button variant="secondary" type="button">View event payload</Button>
      {run.workspace ? <Button variant="primary" type="button">Open {run.workspace}</Button> : null}
    </DialogFooter>
  </>;
}

const PR_ACTIONS = ['opened', 'ready_for_review', 'synchronize', 'reopened', 'closed', 'labeled'];

function Editor({ onClose }: { onClose(): void }): ReactElement {
  const shape = useShape();
  const [name, setName] = useState('Review pull requests');
  const [trigger, setTrigger] = useState('GitHub event');
  const [event, setEvent] = useState('Pull request');
  const [actions, setActions] = useState<ReadonlySet<string>>(new Set(['opened', 'ready_for_review', 'synchronize']));
  const [then, setThen] = useState('Start a workspace for the subject');
  const [mode, setMode] = useState<string>('Review');
  const [agent, setAgent] = useState('reviewer');
  const [again, setAgain] = useState('Send the event to its workspace');
  const [prompt, setPrompt] = useState('Review {{pull_request.html_url}} against {{pull_request.base.ref}}. Leave one review with inline comments; request changes only for correctness or security problems.');
  const conditions = [['Base branch', 'is', 'main'], ['Draft', 'is', 'false'], ['Author', 'is not', 'dependabot[bot]']];
  return <>
    <DialogHeader>
      <DialogTitle>Edit automation</DialogTitle>
      <DialogDescription>When something happens in this project, do something. Each firing is recorded as a run.</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      <InputGroup><InputField index={0} label="Name" value={name} onChange={setName} /></InputGroup>

      <section className="flex flex-col gap-3">
        <strong className="text-body font-semibold">When</strong>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Trigger"><Select value={trigger} onValueChange={setTrigger}><SelectTrigger aria-label="Trigger" />{options(['GitHub event', 'Schedule', 'Manual only'])}</Select></Field>
          <Field label="Event"><Select value={event} onValueChange={setEvent}><SelectTrigger aria-label="Event" />{options(['Pull request', 'Pull request review', 'Issue', 'Issue comment', 'Push', 'Check suite'])}</Select></Field>
        </div>
        <div className="flex flex-wrap gap-1.5">{PR_ACTIONS.map(action => <Button key={action} size="compact" type="button"
          variant={actions.has(action) ? 'primary' : 'secondary'}
          onClick={() => setActions(current => { const next = new Set(current); if (next.has(action)) next.delete(action); else next.add(action); return next; })}>
          <span className="font-mono">{action}</span></Button>)}</div>
      </section>

      <section className="flex flex-col gap-3">
        <strong className="text-body font-semibold">Only if</strong>
        {conditions.map(([field, op, value]) => <div key={field} className="grid grid-cols-[minmax(0,1fr)_minmax(0,10rem)_minmax(0,1fr)_auto] items-center gap-2 [&>*]:min-w-0">
          <Select value={field} onValueChange={() => undefined}><SelectTrigger aria-label="Field" />{options(['Base branch', 'Head branch', 'Author', 'Draft', 'Label', 'Changed paths'])}</Select>
          <Select value={op} onValueChange={() => undefined}><SelectTrigger aria-label="Operator" />{options(['is', 'is not', 'matches'])}</Select>
          <span className={`${shape.input} border border-border bg-surface-2 px-2 py-1.5 font-mono text-caption`}>{value}</span>
          <Button variant="ghost" size="icon" type="button" aria-label="Remove condition"><Trash01 width={14} height={14} strokeWidth={1.5} /></Button>
        </div>)}
        <div><Button variant="ghost" size="compact" type="button" leadingIcon={glyph(Plus)}>Add condition</Button></div>
      </section>

      <section className="flex flex-col gap-3">
        <strong className="text-body font-semibold">Then</strong>
        <Field label="Action"><Select value={then} onValueChange={setThen}><SelectTrigger aria-label="Action" />{options(['Start a workspace for the subject', 'Message a workspace', 'Message the project agent'])}</Select></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Starts in"><Select value={mode} onValueChange={setMode}><SelectTrigger aria-label="Starts in" />{options(['Plan', 'Code', 'Review'])}</Select></Field>
          <Field label="Agent"><Select value={agent} onValueChange={setAgent}><SelectTrigger aria-label="Agent" />{options(['default', 'reviewer', 'scout'])}</Select></Field>
          <Field label="Same subject again"><Select value={again} onValueChange={setAgain}><SelectTrigger aria-label="Same subject again" />{options(['Send the event to its workspace', 'Ignore'])}</Select></Field>
        </div>
        <Field label="Instruction">
          <textarea rows={4} value={prompt} onChange={e => setPrompt(e.currentTarget.value)}
            className={`${shape.input} w-full resize-y border border-border bg-surface-2 p-2 text-body text-foreground outline-none`} />
        </Field>
        <p className="text-caption text-muted-foreground">The event arrives with the instruction as the workspace's first message. Workspaces stay open when the pull request closes; they get a notice.</p>
      </section>
    </div>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="button" onClick={onClose}>Save changes</Button>
    </DialogFooter>
  </>;
}

function AutomationsMock(): ReactElement {
  const shape = useShape();
  const [editing, setEditing] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  return <div className="flex h-dvh flex-col bg-background">
    <PageCanvas>
      <PageHeader kicker="inkibra core" title="Automations"
        description="When something happens in this project, do something. Each firing is a run."
        actions={<Button variant="primary" type="button" leadingIcon={glyph(Plus)} onClick={() => setEditing(true)}>New automation</Button>} />

      <section aria-label="Automation summary" className={`${shape.container} mb-6 flex flex-col bg-surface-2 shadow-surface-1`}>
        <div className="grid grid-cols-4 divide-x divide-border">
          <Stat value="3 of 4" label="On" />
          <Stat value="2 / 2" label="Working now" />
          <Stat value={1} label="Queued" />
          <Stat value={1} label="Failed today" />
        </div>
        <p className="border-t border-border px-5 py-3 text-caption text-muted-foreground">At most 2 runs work at once. A run holds a slot only while its agent works; a workspace waiting for you does not.</p>
      </section>

      <section aria-label="Automations" className="mb-8 flex flex-col gap-3">
        <h2 className="text-subtitle font-semibold">Automations</h2>
        <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
          {AUTOMATIONS.map((automation, index) => <AutomationCard key={automation.id} automation={automation} index={index} onEdit={() => setEditing(true)} />)}
        </CardGroup>
      </section>

      <section aria-label="Recent runs" className="flex flex-col gap-3">
        <div className="flex items-end justify-between"><h2 className="text-subtitle font-semibold">Recent runs</h2><span className="text-caption text-muted-foreground">Every event an automation saw, including skipped ones</span></div>
        <RunsTable onOpen={setRun} />
      </section>

      <Dialog open={editing} onOpenChange={open => { if (!open) setEditing(false); }}>
        <DialogContent size="lg"><Editor onClose={() => setEditing(false)} /></DialogContent>
      </Dialog>
      <Dialog open={run !== null} onOpenChange={open => { if (!open) setRun(null); }}>
        <DialogContent>{run ? <RunDetail run={run} /> : null}</DialogContent>
      </Dialog>
    </PageCanvas>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <AutomationsMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
