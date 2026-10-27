// Throwaway design mock for the Automations page (docs/AUTOMATIONS-DESIGN.md). Static data only; not part of the app.
import {
  Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle,
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
  DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, MenuItem,
  Select, SelectContent, SelectItem, SelectTrigger, ShapeProvider, SizeProvider, Switch,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TooltipProvider, untitledIcons, useShape,
} from '@gitspace/ui';
import { CheckCircle, ChevronDown, DotsHorizontal, MessageChatCircle, Edit03, Link01, LinkBroken01, MinusCircle, Play, Plus, RefreshCcw01, Trash01, XCircle } from '@untitledui/icons';
import { StrictMode, useState, type ReactElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { glyph } from './glyph.js';
import { PageCanvas, PageHeader } from './GitSpaceShell.js';
import { restoreAppearance } from './appearance.js';

const BOT = '@gitspace-bradleat';

type RunStatus = 'running' | 'queued' | 'finished' | 'skipped' | 'failed';
type Mode = 'Plan' | 'Code' | 'Review';
const STATUS_COLOR: Record<RunStatus, 'blue' | 'gray' | 'green' | 'amber' | 'red'> = { running: 'blue', queued: 'amber', finished: 'green', skipped: 'gray', failed: 'red' };
const MODE_COLOR: Record<Mode, 'indigo' | 'emerald' | 'violet'> = { Plan: 'indigo', Code: 'emerald', Review: 'violet' };

const code = (text: string) => <code className="font-mono text-caption">{text}</code>;

interface Automation {
  id: string;
  name: string;
  enabled: boolean;
  when: ReactNode;
  onlyIf: readonly ReactNode[];
  then: ReactNode;
  modes: readonly Mode[];
  last: { at: string; status: RunStatus } | null;
  /** Sends events on a linked pull request or issue to its workspace. */
  linked?: true;
  /** Installed with the project's GitHub App; editable and removable like any other. */
  builtIn?: true;
  /** Made by the project agent and not yet switched on by a person. */
  proposed?: { at: string; asked: string; reason: string; tested: readonly { event: string; result: string; runs: boolean }[] };
}

const AUTOMATIONS: readonly Automation[] = [
  {
    id: 'review', name: 'Review pull requests', enabled: true,
    when: <>GitHub · pull request {code('opened')}, {code('ready_for_review')}</>,
    onlyIf: [<>base branch is {code('main')}</>, <>not a draft</>, <>author is not {code('dependabot[bot]')}</>],
    then: <>Start a workspace for the pull request with agent {code('reviewer')} · starts in <strong className="font-semibold">Review</strong></>,
    modes: ['Review'], last: { at: '1 min ago', status: 'queued' },
  },
  {
    id: 'labels', name: 'Start work from labels', enabled: true,
    when: <>GitHub · label {code('gitspace:plan')}, {code('gitspace:code')} or {code('gitspace:review')} added to an issue or pull request</>,
    onlyIf: [],
    then: <>Start a workspace for it in the label's mode, with agent {code('default')}</>,
    modes: ['Plan', 'Code', 'Review'], last: { at: '9 min ago', status: 'running' },
  },
  {
    id: 'triage', name: 'Triage new issues', enabled: true,
    when: <>GitHub · issue {code('opened')}</>,
    onlyIf: [<>no label {code('wontfix')}</>],
    then: <>Ask the project agent: it starts a workspace, links the issue to one that already covers it, or skips</>,
    modes: [], last: { at: '2 h ago', status: 'finished' },
  },
  {
    id: 'audit', name: 'Nightly dependency audit', enabled: true,
    when: <>Schedule · {code('0 6 * * *')} · daily 06:00 UTC · next in 9 h</>,
    onlyIf: [],
    then: <>Message the project agent</>,
    modes: [], last: { at: '7 h ago', status: 'failed' },
  },
  {
    id: 'dependabot', name: 'Check dependency updates', enabled: false,
    when: <>GitHub · pull request {code('opened')}</>,
    onlyIf: [<>author is {code('dependabot[bot]')}</>, <>changed paths match {code('**/package.json')}</>],
    then: <>Start a workspace for the pull request with agent {code('reviewer')} · starts in <strong className="font-semibold">Review</strong></>,
    modes: ['Review'], last: null,
    proposed: {
      at: '2 h ago', asked: 'Can dependency bumps get built and smoke-tested before we merge them?',
      reason: 'Dependabot opens about 6 pull requests a week here. Bumps that change only workflow files need no build, so they are left out.',
      tested: [
        { event: 'PR #1137 · Bump vite to 7.3.6', result: 'Would start a Review workspace', runs: true },
        { event: 'PR #1135 · Bump zod to 4.4.3', result: 'Would start a Review workspace', runs: true },
        { event: 'PR #1136 · Bump actions/checkout to 5', result: 'Skipped: changes only .github/workflows/ci.yml', runs: false },
      ],
    },
  },
  {
    id: 'ci', name: 'Fix failing CI on main', enabled: false,
    when: <>GitHub · check suite {code('completed')}</>,
    onlyIf: [<>conclusion is {code('failure')}</>, <>branch is {code('main')}</>],
    then: <>Start a workspace for the branch with agent {code('default')} · starts in <strong className="font-semibold">Code</strong></>,
    modes: ['Code'], last: { at: '3 d ago', status: 'finished' },
  },
  {
    id: 'feedback', name: 'Review feedback to its workspace', enabled: true, linked: true, builtIn: true,
    when: <>GitHub · pull request review {code('submitted')}, review comment {code('created')}</>,
    onlyIf: [<>the pull request is linked</>, <>author is a person, not a bot</>],
    then: <>Send to its linked workspace · <strong className="font-semibold">wakes the agent</strong></>,
    modes: [], last: { at: '3 min ago', status: 'running' },
  },
  {
    id: 'checks', name: 'Failed checks to its workspace', enabled: true, linked: true, builtIn: true,
    when: <>GitHub · check suite {code('completed')}</>,
    onlyIf: [<>the branch is linked</>, <>conclusion is {code('failure')}</>],
    then: <>Send to its linked workspace · <strong className="font-semibold">wakes the agent</strong></>,
    modes: [], last: { at: '2 d ago', status: 'finished' },
  },
  {
    id: 'mentions', name: `Mentions of ${BOT}`, enabled: true, linked: true, builtIn: true,
    when: <>GitHub · comment {code('created')} on an issue or pull request</>,
    onlyIf: [<>mentions {code(BOT)}</>],
    then: <>Send to its linked workspace, or to the project agent when it has none · <strong className="font-semibold">wakes the agent</strong></>,
    modes: [], last: { at: '41 min ago', status: 'finished' },
  },
  {
    id: 'closed', name: 'Merged or closed', enabled: true, linked: true, builtIn: true,
    when: <>GitHub · pull request {code('closed')}, issue {code('closed')}</>,
    onlyIf: [<>it is linked</>],
    then: <>Send to its linked workspace as a notice · the agent stays asleep</>,
    modes: [], last: { at: '1 h ago', status: 'finished' },
  },
];

type LinkSource = 'started' | 'agent' | 'person' | 'branch' | 'closes';
const LINK_LABEL: Record<LinkSource, string> = {
  started: 'Started for it', agent: 'Linked by an agent', person: 'Linked by you', branch: 'Same branch', closes: 'Closed by a linked pull request',
};

interface SubjectLink {
  subject: string;
  workspace: string;
  source: LinkSource;
  detail: string;
  activity: string;
}

const LINKS: readonly SubjectLink[] = [
  { subject: 'PR #1140 · Bounded history for sessions', workspace: 'session-recovery', source: 'branch', detail: 'head branch session-recovery', activity: 'Review comment from @dana · 3 min ago' },
  { subject: 'Issue #386 · Bounded history loses ordinals', workspace: 'session-recovery', source: 'closes', detail: 'PR #1140 says "Fixes #386"', activity: 'Opened · 2 d ago' },
  { subject: 'Issue #391 · Coach subscriptions renew twice', workspace: 'plan-issue-391', source: 'started', detail: 'Start work from labels · gitspace:plan', activity: 'Labeled · 9 min ago' },
  { subject: 'Issue #392 · Renewal emails go to the old address', workspace: 'plan-issue-391', source: 'agent', detail: 'the project agent, after a mention', activity: `Mentioned ${BOT} · 41 min ago` },
  { subject: 'PR #1131 · Storybook JIT server memory', workspace: 'storybook-jit', source: 'person', detail: 'Bradley Leatherwood', activity: 'Checks passed · 1 h ago' },
];

interface Run {
  id: string;
  project: string;
  status: RunStatus;
  /** The automation, or "Linked" when the event reached a linked workspace without one. */
  by: string;
  event: string;
  subject: string;
  workspace: string | null;
  outcome: string;
  at: string;
  checks: readonly { label: string; passed: boolean | null }[];
  timeline: readonly { at: string; label: string }[];
}

const REVIEW_CHECKS = (draft: boolean | null, author: boolean | null) => [
  { label: 'base branch is main', passed: true }, { label: 'not a draft', passed: draft }, { label: 'author is not dependabot[bot]', passed: author },
];

const RUNS: readonly Run[] = [
  {
    id: 'r9', project: 'inkibra core', status: 'queued', by: 'Review pull requests', event: 'pull_request.opened', subject: 'PR #1143 · Drop .omp agent support',
    workspace: null, outcome: 'Waiting for a slot: 2 of 2 runs are working', at: '1 min ago', checks: REVIEW_CHECKS(true, true),
    timeline: [{ at: '14:02:11', label: 'Delivery received' }, { at: '14:02:11', label: 'Author has write access' }, { at: '14:02:11', label: 'Conditions passed' }, { at: '14:02:11', label: 'Queued: 2 of 2 runs working' }],
  },
  {
    id: 'r8', project: 'inkibra core', status: 'running', by: 'Review feedback to its workspace', event: 'pull_request_review_comment.created', subject: 'PR #1140 · Bounded history for sessions',
    workspace: 'session-recovery', outcome: 'Review comment from @dana: woke its agent', at: '3 min ago', checks: [],
    timeline: [{ at: '13:59:02', label: 'Delivery received' }, { at: '13:59:02', label: 'Linked to session-recovery (same branch)' }, { at: '13:59:02', label: 'Review comment from a person: wakes the agent' }, { at: '13:59:03', label: 'Round 2 of 5 today on this pull request' }, { at: '13:59:03', label: 'Sent; agent working' }],
  },
  {
    id: 'r7', project: 'inkibra core', status: 'running', by: 'Start work from labels', event: 'issues.labeled · gitspace:plan', subject: 'Issue #391 · Coach subscriptions renew twice',
    workspace: 'plan-issue-391', outcome: 'Started in Plan and linked to the issue', at: '9 min ago', checks: [],
    timeline: [{ at: '13:53:40', label: 'Delivery received' }, { at: '13:53:40', label: 'Label gitspace:plan added by @bradleat (write access)' }, { at: '13:53:41', label: 'Started workspace plan-issue-391 in Plan' }, { at: '13:53:41', label: 'Linked to Issue #391' }],
  },
  {
    id: 'r6', project: 'inkibra core', status: 'skipped', by: 'Review pull requests', event: 'pull_request.opened', subject: 'PR #1144 · Faster tone detection',
    workspace: null, outcome: 'Author not trusted: @outside-dev', at: '20 min ago', checks: REVIEW_CHECKS(true, true),
    timeline: [{ at: '13:42:15', label: 'Delivery received' }, { at: '13:42:15', label: 'Skipped: @outside-dev has no write access and is not on the trust list' }],
  },
  {
    id: 'r5', project: 'inkibra core', status: 'finished', by: `Mentions of ${BOT}`, event: 'issue_comment.created', subject: 'Issue #392 · Renewal emails go to the old address',
    workspace: 'plan-issue-391', outcome: 'No linked workspace: the project agent linked it to plan-issue-391', at: '41 min ago', checks: [],
    timeline: [{ at: '13:21:08', label: 'Delivery received' }, { at: '13:21:08', label: `Comment by @bradleat mentions ${BOT}` }, { at: '13:21:08', label: 'Issue #392 has no linked workspace: sent to the project agent' }, { at: '13:21:40', label: 'Project agent linked Issue #392 to plan-issue-391 and sent it the comment' }],
  },
  {
    id: 'r4', project: 'inkibra core', status: 'skipped', by: 'Review pull requests', event: 'pull_request.opened', subject: 'PR #1141 · WIP: automations run model',
    workspace: null, outcome: 'Conditions: the pull request is a draft', at: '38 min ago', checks: REVIEW_CHECKS(false, null),
    timeline: [{ at: '13:24:19', label: 'Delivery received' }, { at: '13:24:19', label: 'Skipped: the pull request is a draft' }],
  },
  {
    id: 'r3', project: 'inkibra core', status: 'finished', by: 'Merged or closed', event: 'pull_request.closed · merged', subject: 'PR #1131 · Storybook JIT server memory',
    workspace: 'storybook-jit', outcome: 'Merged: a notice to its workspace; the agent stays asleep', at: '1 h ago', checks: [],
    timeline: [{ at: '12:58:51', label: 'Delivery received' }, { at: '12:58:51', label: 'Linked to storybook-jit (linked by you)' }, { at: '12:58:51', label: 'Notice added; the agent stays asleep' }],
  },
  {
    id: 'r2', project: 'inkibra core', status: 'finished', by: 'Triage new issues', event: 'issues.opened', subject: 'Issue #387 · Settings page loses scroll',
    workspace: 'inkibra core', outcome: 'The project agent started triage-issue-387 in Plan', at: '2 h ago', checks: [{ label: "no label 'wontfix'", passed: true }],
    timeline: [{ at: '11:40:55', label: 'Delivery received' }, { at: '11:40:55', label: 'Conditions passed' }, { at: '11:40:56', label: 'Asked the project agent' }, { at: '11:41:30', label: 'Project agent started triage-issue-387 in Plan and linked it' }],
  },
  {
    id: 'r1', project: 'inkibra core', status: 'failed', by: 'Nightly dependency audit', event: 'schedule 06:00 UTC', subject: '—',
    workspace: 'inkibra core', outcome: 'anthropic/claude-sonnet-5-5: every Anthropic account is out until 08:00', at: '7 h ago', checks: [],
    timeline: [{ at: '06:00:00', label: 'Tick' }, { at: '06:00:01', label: 'Sent to the project agent' }, { at: '06:00:04', label: 'Failed: anthropic/claude-sonnet-5-5: every Anthropic account is out until 08:00' }],
  },
];

const OTHER_RUNS: readonly Run[] = [
  {
    id: 'g2', project: 'GitSpace', status: 'running', by: 'Failed checks to its workspace', event: 'check_suite.completed · failure', subject: 'PR #212 · Extension 5.13.0',
    workspace: 'cross-machine-browser-relay', outcome: 'Failed checks: woke its agent', at: '6 min ago', checks: [],
    timeline: [{ at: '13:56:10', label: 'Delivery received' }, { at: '13:56:10', label: 'Linked to cross-machine-browser-relay (same branch)' }, { at: '13:56:11', label: 'Failed checks: wakes the agent' }],
  },
];

const PROJECTS: readonly { name: string; on: string; failed: number }[] = [
  { name: 'inkibra core', on: '8 of 10 on · 1 proposed', failed: 1 },
  { name: 'GitSpace', on: '4 defaults on · 1 linked pull request', failed: 0 },
  { name: 'Golconda IDF Data Vault', on: 'No automations · GitHub App not installed', failed: 0 },
  { name: 'Golconda PPVA Enrollment', on: 'No automations · GitHub App not installed', failed: 0 },
];
const ALL_PROJECTS = 'All projects';

const PAST_EVENTS = [
  'PR #1143 · pull_request.opened · 1 min ago',
  'PR #1144 · pull_request.opened · @outside-dev · 20 min ago',
  'PR #1141 · pull_request.opened · draft · 38 min ago',
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
    <dd className="min-w-0 text-body text-foreground">{children}</dd>
  </>;
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }): ReactElement {
  return <label className="flex min-w-0 flex-col gap-1"><span className="text-caption font-medium text-muted-foreground">{label}</span>{children}</label>;
}

function TextInput({ label, value, onChange, mono = false }: { label: string; value: string; onChange(value: string): void; mono?: boolean }): ReactElement {
  const shape = useShape();
  return <input aria-label={label} placeholder={label} value={value} onChange={e => onChange(e.currentTarget.value)}
    className={`${shape.input} w-full min-w-0 border border-border bg-background px-2 py-1.5 text-body text-foreground outline-none ${mono ? 'font-mono' : ''}`} />;
}

function options(values: readonly string[]): ReactElement {
  return <SelectContent>{values.map((value, index) => <SelectItem value={value} index={index} key={value}>{value}</SelectItem>)}</SelectContent>;
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }): ReactElement {
  return <section aria-label={title} className="mb-8 flex flex-col gap-3">
    <div className="flex flex-wrap items-end justify-between gap-2"><h2 className="text-subtitle font-semibold">{title}</h2>{aside}</div>
    {children}
  </section>;
}

function CheckList({ checks }: { checks: Run['checks'] }): ReactElement {
  return <ul className="flex flex-col gap-1.5">{checks.map(check => <li key={check.label} className="flex items-center gap-2 text-body">
    {check.passed === true ? <CheckCircle className="text-success" width={16} height={16} strokeWidth={1.5} />
      : check.passed === false ? <XCircle className="text-destructive" width={16} height={16} strokeWidth={1.5} />
        : <MinusCircle className="text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
    <span className={check.passed === null ? 'text-muted-foreground' : 'text-foreground'}>{check.label}{check.passed === null ? ' (not checked)' : ''}</span>
  </li>)}</ul>;
}

function AutomationCard({ automation, index, onEdit }: { automation: Automation; index: number; onEdit(): void }): ReactElement {
  const [enabled, setEnabled] = useState(automation.enabled);
  return <Card index={index}>
    <CardHeader>
      <CardTitle><span className="flex flex-wrap items-center gap-2">{automation.name}
        {automation.modes.map(mode => <Badge key={mode} size="compact" color={MODE_COLOR[mode]}>{mode}</Badge>)}
        {automation.builtIn ? <Badge size="compact" color="gray">Default</Badge> : null}
      </span></CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">
        {automation.proposed ? <><Badge size="compact" color="amber">Proposed</Badge><span>by the project agent · {automation.proposed.at}</span></>
          : automation.last ? <><span>Last run {automation.last.at}</span><Badge variant="dot" size="compact" color={STATUS_COLOR[automation.last.status]}>{automation.last.status}</Badge></> : <span>No runs yet</span>}
      </span></CardDescription>
      {automation.proposed ? null : <CardAction>
        <div className="flex items-center gap-2">
          <Switch label={enabled ? 'On' : 'Off'} checked={enabled} onToggle={() => setEnabled(value => !value)} />
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automation.name}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
            <DropdownContent align="end" className="min-w-[220px] w-[220px]">
              <MenuItem index={0} icon={glyph(Play)} label="Run now" onSelect={() => undefined} />
              <MenuItem index={1} icon={glyph(RefreshCcw01)} label="Test with a past event" onSelect={onEdit} />
              <MenuItem index={2} icon={glyph(Edit03)} label="Edit" onSelect={onEdit} />
              <MenuItem index={3} icon={glyph(Trash01)} label="Delete" onSelect={() => undefined} />
            </DropdownContent>
          </DropdownMenu>
        </div>
      </CardAction>}
    </CardHeader>
    <CardContent>
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
        <Row label="When">{automation.when}</Row>
        <Row label="Only if">{automation.onlyIf.length === 0 ? <span className="text-muted-foreground">Always</span>
          : <span className="flex flex-wrap gap-x-1.5">{automation.onlyIf.map((condition, at) => <span key={at}>{at > 0 ? '· ' : ''}{condition}</span>)}</span>}</Row>
        <Row label="Then">{automation.then}</Row>
      </dl>
    </CardContent>
    {automation.proposed ? <CardFooter><div className="flex w-full flex-col gap-3">
      <p className="flex items-start gap-2 text-body"><MessageChatCircle className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} /><span><span className="text-muted-foreground">You asked: </span>“{automation.proposed.asked}”</span></p>
      <p className="text-body text-muted-foreground">{automation.proposed.reason}</p>
      <div className="flex flex-col gap-1.5">
        <strong className="text-caption font-medium text-muted-foreground">Tested against {automation.proposed.tested.length} recent events</strong>
        <ul className="flex flex-col gap-1">{automation.proposed.tested.map(test => <li key={test.event} className="flex items-start gap-2 text-body">
          {test.runs ? <CheckCircle className="mt-0.5 shrink-0 text-success" width={16} height={16} strokeWidth={1.5} /> : <MinusCircle className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} />}
          <span className="min-w-0">{test.event}<span className="text-muted-foreground"> · {test.result}</span></span>
        </li>)}</ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button">Switch on</Button>
        <Button variant="secondary" size="compact" type="button" onClick={onEdit}>Edit first</Button>
        <Button variant="ghost" size="compact" type="button">Open conversation</Button>
        <Button variant="ghost" size="compact" type="button">Dismiss</Button>
      </div>
    </div></CardFooter>
      : enabled ? null : <CardFooter><span className="text-caption text-muted-foreground">Off: events are not recorded as runs</span></CardFooter>}
  </Card>;
}

function LinksTable({ onLink }: { onLink(): void }): ReactElement {
  return <>
  <ul className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
    {LINKS.map(link => <li key={link.subject} className="flex items-start gap-2 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-body">{link.subject}</span>
        <span className="font-mono text-caption underline decoration-dotted underline-offset-2">{link.workspace}</span>
        <span className="text-caption text-muted-foreground">{LINK_LABEL[link.source]} · {link.detail}</span>
        <span className="text-caption text-muted-foreground">{link.activity}</span>
      </div>
      <Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${link.subject}`} onClick={onLink}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>
    </li>)}
  </ul>
  <div className="hidden sm:block"><Table size="compact">
    <TableHeader><TableRow><TableHead className="w-[32%]">Pull request or issue</TableHead><TableHead className="w-[17%]">Workspace</TableHead><TableHead className="w-[27%]">Linked</TableHead><TableHead className="hidden sm:table-cell">Last activity</TableHead><TableHead className="w-10" /></TableRow></TableHeader>
    <TableBody>
      {LINKS.map((link, index) => <TableRow key={link.subject} index={index}>
        <TableCell className="max-w-0"><span className="block truncate">{link.subject}</span></TableCell>
        <TableCell><span className="font-mono text-caption underline decoration-dotted underline-offset-2">{link.workspace}</span></TableCell>
        <TableCell className="max-w-0">
          <span className="block truncate">{LINK_LABEL[link.source]}</span>
          <span className="block truncate text-caption text-muted-foreground">{link.detail}</span>
        </TableCell>
        <TableCell className="hidden max-w-0 text-caption text-muted-foreground sm:table-cell"><span className="block truncate">{link.activity}</span></TableCell>
        <TableCell>
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${link.subject}`}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
            <DropdownContent align="end" className="min-w-[220px] w-[220px]">
              <MenuItem index={0} icon={glyph(Link01)} label="Link to another workspace" onSelect={onLink} />
              <MenuItem index={1} icon={glyph(LinkBroken01)} label="Unlink" onSelect={() => undefined} />
            </DropdownContent>
          </DropdownMenu>
        </TableCell>
      </TableRow>)}
    </TableBody>
  </Table></div>
  </>;
}

function TrustList(): ReactElement {
  const shape = useShape();
  const [trusted, setTrusted] = useState<readonly string[]>(['@mira-contract', '@renovate[bot]']);
  const [draft, setDraft] = useState('');
  return <div className={`${shape.container} flex flex-col gap-3 bg-surface-2 px-5 py-4 shadow-surface-1`}>
    <p className="text-body text-muted-foreground">An event runs only if its author has write access to <span className="font-mono text-caption text-foreground">inKibra/inkibra-core</span> (6 people, checked through the GitHub App when the event arrives) or is listed here. For a comment, the author is the commenter. Events from anyone else do not match any automation; they show as skipped in recent runs. Schedules and manual runs are always trusted.</p>
    <div className="flex flex-wrap gap-2">{trusted.map(login => <span key={login} className={`${shape.input} flex items-center gap-1 border border-border bg-background py-0.5 pl-2 pr-0.5`}>
      <span className="font-mono text-caption">{login}</span>
      <Button variant="ghost" size="icon" type="button" aria-label={`Stop trusting ${login}`} onClick={() => setTrusted(current => current.filter(entry => entry !== login))}><XCircle width={14} height={14} strokeWidth={1.5} /></Button>
    </span>)}</div>
    <div className="flex max-w-md items-center gap-2">
      <div className="min-w-0 flex-1"><TextInput label="GitHub login" value={draft} onChange={setDraft} mono /></div>
      <Button variant="secondary" type="button" leadingIcon={glyph(Plus)} onClick={() => { if (draft.trim()) { setTrusted(current => [...current, draft.trim().startsWith('@') ? draft.trim() : `@${draft.trim()}`]); setDraft(''); } }}>Trust</Button>
    </div>
  </div>;
}

function RunsTable({ runs, showProject, onOpen }: { runs: readonly Run[]; showProject: boolean; onOpen(run: Run): void }): ReactElement {
  return <>
  <ul className="flex flex-col divide-y divide-border border-y border-border sm:hidden">
    {runs.map(run => <li key={run.id}><button type="button" className="flex w-full flex-col gap-0.5 py-3 text-left" onClick={() => onOpen(run)}>
      <span className="flex items-center justify-between gap-2"><Badge variant="dot" size="compact" color={STATUS_COLOR[run.status]}>{run.status}</Badge><span className="text-caption tabular-nums text-muted-foreground">{run.at}</span></span>
      <span className="text-body">{showProject ? <span className="text-muted-foreground">{run.project} · </span> : null}{run.subject}</span>
      <span className="text-caption text-muted-foreground">{run.outcome}</span>
      <span className="text-caption text-muted-foreground">{run.by} · <span className="font-mono">{run.event}</span></span>
    </button></li>)}
  </ul>
  <div className="hidden sm:block"><Table size="compact">
    <TableHeader><TableRow><TableHead className="w-24">Status</TableHead>{showProject ? <TableHead className="w-[14%]">Project</TableHead> : null}<TableHead className={showProject ? 'w-[30%]' : 'w-[40%]'}>Subject</TableHead><TableHead>From · event</TableHead><TableHead className="hidden sm:table-cell">Workspace</TableHead><TableHead className="w-24 text-right">When</TableHead></TableRow></TableHeader>
    <TableBody>
      {runs.map((run, index) => <TableRow key={run.id} index={index} className="cursor-pointer" onClick={() => onOpen(run)}>
        <TableCell><Badge variant="dot" size="compact" color={STATUS_COLOR[run.status]}>{run.status}</Badge></TableCell>
        {showProject ? <TableCell className="max-w-0"><span className="block truncate">{run.project}</span></TableCell> : null}
        <TableCell className="max-w-0">
          <span className="block truncate">{run.subject}</span>
          <span className="block truncate text-caption text-muted-foreground">{run.outcome}</span>
        </TableCell>
        <TableCell className="max-w-0">
          <span className="block truncate">{run.by}</span>
          <span className="block truncate font-mono text-caption text-muted-foreground">{run.event}</span>
        </TableCell>
        <TableCell className="hidden sm:table-cell">{run.workspace ? <span className="font-mono text-caption underline decoration-dotted underline-offset-2">{run.workspace}</span> : <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell className="text-right tabular-nums text-muted-foreground">{run.at}</TableCell>
      </TableRow>)}
    </TableBody>
  </Table></div>
  </>;
}

function RunDetail({ run }: { run: Run }): ReactElement {
  return <>
    <DialogHeader>
      <DialogTitle><span className="flex items-center gap-2">{run.subject}<Badge variant="dot" size="compact" color={STATUS_COLOR[run.status]}>{run.status}</Badge></span></DialogTitle>
      <DialogDescription>{run.by} · <span className="font-mono">{run.event}</span> · {run.at}</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      {run.checks.length ? <section className="flex flex-col gap-2">
        <strong className="text-caption font-medium text-muted-foreground">Only if</strong>
        <CheckList checks={run.checks} />
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

function TestWithPastEvent(): ReactElement {
  const shape = useShape();
  const [event, setEvent] = useState(PAST_EVENTS[0] ?? '');
  const [tested, setTested] = useState<string | null>(null);
  const untrusted = tested?.includes('@outside-dev') ?? false;
  const draft = tested?.includes('draft') ?? false;
  return <section className={`${shape.container} flex flex-col gap-3 border border-border p-4`}>
    <strong className="text-body font-semibold">Test with a past event</strong>
    <p className="text-caption text-muted-foreground">Runs the trigger and conditions against a delivery GitSpace recorded and shows what would happen. Nothing is started until you choose Run it.</p>
    <div className="flex items-end gap-2">
      <Field label="Recorded event"><Select value={event} onValueChange={value => { setEvent(value); setTested(null); }}><SelectTrigger aria-label="Recorded event" />{options(PAST_EVENTS)}</Select></Field>
      <Button variant="secondary" type="button" leadingIcon={glyph(RefreshCcw01)} onClick={() => setTested(event)}>Test</Button>
    </div>
    {tested ? <div className="flex flex-col gap-3 border-t border-border pt-3">
      <CheckList checks={[{ label: untrusted ? 'author @outside-dev is not trusted' : 'author has write access', passed: !untrusted }, ...REVIEW_CHECKS(untrusted ? null : !draft, untrusted || draft ? null : true)]} />
      {untrusted || draft
        ? <p className="text-body">Would skip: {untrusted ? 'the author is not trusted' : 'the pull request is a draft'}.</p>
        : <>
          <p className="text-body">Would start workspace <span className="font-mono text-caption">review-pr-1143</span> in <strong className="font-semibold">Review</strong> with agent <span className="font-mono text-caption">reviewer</span>, linked to PR #1143. Its first message:</p>
          <blockquote className={`${shape.input} border border-border bg-surface-2 p-2 text-body`}>Review https://github.com/inKibra/inkibra-core/pull/1143 against main. Leave one review with inline comments; request changes only for correctness or security problems.</blockquote>
        </>}
      <div><Button variant="primary" size="compact" type="button" leadingIcon={glyph(Play)} disabled={untrusted || draft}>Run it</Button></div>
    </div> : null}
  </section>;
}

type FilterKind = 'linked' | 'mentions' | 'base' | 'head' | 'branch' | 'author' | 'draft' | 'labels' | 'paths' | 'conclusion' | 'review';
interface Filter { kind: FilterKind; mode: string; values: readonly string[] }
const FILTER_LABEL: Record<FilterKind, string> = {
  linked: 'Linked', mentions: 'Mentions',
  base: 'Base branch', head: 'Head branch', branch: 'Branch', author: 'Author', draft: 'Draft', labels: 'Labels', paths: 'Changed files', conclusion: 'Conclusion', review: 'Review',
};
const FILTER_MODES: Record<FilterKind, readonly string[]> = {
  linked: ['Is linked', 'Is not linked'], mentions: [`Mentions ${BOT}`],
  base: ['is one of', 'is not one of'], head: ['is one of', 'is not one of'], branch: ['is one of', 'is not one of'], author: ['is one of', 'is not one of'],
  draft: ['Not a draft', 'Only drafts'], labels: ['has any of', 'has none of'], paths: ['touch any of', 'touch none of'], conclusion: ['is one of'], review: ['is one of'],
};
/** In the product these come from the repository through the GitHub App: its branches, labels and recent authors. */
const FILTER_SUGGESTIONS: Record<FilterKind, readonly string[]> = {
  linked: [], mentions: [],
  base: ['main', 'develop', 'release/*'], head: ['dependabot/*', 'renovate/*', 'gitspace/*'], branch: ['main', 'develop'], author: ['dependabot[bot]', 'renovate[bot]', 'bradleat', 'dana'],
  draft: [], labels: ['bug', 'wontfix', 'needs-design', 'gitspace:plan'], paths: ['**/package.json', 'docs/**', 'packages/account-web/**'], conclusion: ['failure', 'timed_out', 'cancelled'], review: ['approved', 'changes_requested', 'commented'],
};
const FILTERS_BY_EVENT: Record<string, readonly FilterKind[]> = {
  'Pull request': ['linked', 'base', 'head', 'author', 'draft', 'labels', 'paths'], 'Pull request review': ['linked', 'mentions', 'base', 'author', 'review'], 'Issue': ['linked', 'author', 'labels'],
  'Issue comment': ['linked', 'mentions', 'author', 'labels'], 'Push': ['linked', 'branch', 'author', 'paths'], 'Check suite': ['linked', 'branch', 'conclusion'],
};
/** Filters chosen from a list, with no values to enter. */
/** Fields an instruction can insert, per event; in the product they come from the event's schema. */
const EVENT_FIELDS: Record<string, readonly { path: string; label: string }[]> = {
  'Pull request': [
    { path: 'pull_request.html_url', label: 'Link' }, { path: 'pull_request.title', label: 'Title' }, { path: 'pull_request.number', label: 'Number' },
    { path: 'pull_request.user.login', label: 'Author' }, { path: 'pull_request.base.ref', label: 'Base branch' }, { path: 'pull_request.head.ref', label: 'Head branch' },
    { path: 'pull_request.body', label: 'Description' },
  ],
  'Pull request review': [{ path: 'review.html_url', label: 'Link' }, { path: 'review.user.login', label: 'Reviewer' }, { path: 'review.state', label: 'State' }, { path: 'review.body', label: 'Review text' }],
  'Issue': [{ path: 'issue.html_url', label: 'Link' }, { path: 'issue.title', label: 'Title' }, { path: 'issue.number', label: 'Number' }, { path: 'issue.user.login', label: 'Author' }, { path: 'issue.body', label: 'Description' }],
  'Issue comment': [{ path: 'comment.html_url', label: 'Link' }, { path: 'comment.user.login', label: 'Commenter' }, { path: 'comment.body', label: 'Comment' }, { path: 'issue.title', label: 'Issue title' }],
  'Push': [{ path: 'ref', label: 'Branch' }, { path: 'head_commit.message', label: 'Commit message' }, { path: 'compare', label: 'Compare link' }],
  'Check suite': [{ path: 'check_suite.head_branch', label: 'Branch' }, { path: 'check_suite.conclusion', label: 'Conclusion' }, { path: 'check_suite.head_sha', label: 'Commit' }],
};

const CHOICE_ONLY: Partial<Record<FilterKind, true>> = { linked: true, mentions: true, draft: true };
const EVENT_NOUN: Record<string, string> = {
  'Pull request': 'pull requests', 'Pull request review': 'reviews', 'Issue': 'issues', 'Issue comment': 'comments', 'Push': 'pushes', 'Check suite': 'check suites',
};

function filterPhrase(filter: Filter): string {
  const values = filter.values.join(' or ');
  const negative = filter.mode.includes('not') || filter.mode.includes('none');
  switch (filter.kind) {
    case 'linked': return filter.mode === 'Is linked' ? 'on a linked pull request or issue' : 'with no linked workspace';
    case 'mentions': return `mentioning ${BOT}`;
    case 'base': return negative ? `not into ${values}` : `into ${values}`;
    case 'head': return negative ? `not from ${values}` : `from ${values}`;
    case 'branch': return negative ? `not on ${values}` : `on ${values}`;
    case 'author': return negative ? `not by ${values}` : `by ${values}`;
    case 'draft': return filter.mode === 'Not a draft' ? 'not drafts' : 'only drafts';
    case 'labels': return negative ? `without the label ${values}` : `labeled ${values}`;
    case 'paths': return negative ? `not touching ${values}` : `touching ${values}`;
    case 'conclusion': return `that ended ${values}`;
    case 'review': return `that are ${values.replaceAll('_', ' ')}`;
  }
}

function ChipsInput({ kind, values, onChange }: { kind: FilterKind; values: readonly string[]; onChange(values: readonly string[]): void }): ReactElement {
  const shape = useShape();
  const [draft, setDraft] = useState('');
  const add = () => { const value = draft.trim(); if (value && !values.includes(value)) onChange([...values, value]); setDraft(''); };
  return <div className={`${shape.input} flex w-full min-w-0 flex-wrap items-center gap-1 border border-border bg-background px-1.5 py-1`}>
    {values.map(value => <span key={value} className="flex min-w-0 max-w-full items-center gap-0.5 rounded bg-surface-2 py-0.5 pl-1.5 pr-0.5 font-mono text-caption [overflow-wrap:anywhere]">
      {value}
      <button type="button" className="rounded p-0.5 text-muted-foreground hover:text-foreground" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter(entry => entry !== value))}><XCircle width={12} height={12} strokeWidth={1.5} /></button>
    </span>)}
    <input list={`suggest-${kind}`} value={draft} placeholder={values.length ? 'Add…' : FILTER_SUGGESTIONS[kind][0]} aria-label={`Add to ${FILTER_LABEL[kind]}`}
      onChange={e => setDraft(e.currentTarget.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} onBlur={add}
      className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 font-mono text-caption text-foreground outline-none" />
    <datalist id={`suggest-${kind}`}>{FILTER_SUGGESTIONS[kind].filter(value => !values.includes(value)).map(value => <option key={value} value={value} />)}</datalist>
  </div>;
}

function Filters({ event }: { event: string }): ReactElement {
  const [filters, setFilters] = useState<readonly Filter[]>([
    { kind: 'base', mode: 'is one of', values: ['main'] },
    { kind: 'draft', mode: 'Not a draft', values: [] },
    { kind: 'author', mode: 'is not one of', values: ['dependabot[bot]'] },
  ]);
  const offered = FILTERS_BY_EVENT[event] ?? [];
  const shown = filters.filter(filter => offered.includes(filter.kind));
  const unused = offered.filter(kind => !filters.some(filter => filter.kind === kind));
  const update = (kind: FilterKind, change: Partial<Filter>) => setFilters(current => current.map(filter => filter.kind === kind ? { ...filter, ...change } : filter));
  const complete = shown.filter(filter => CHOICE_ONLY[filter.kind] || filter.values.length);
  return <section className="flex flex-col gap-3">
    <strong className="text-body font-semibold">Only if</strong>
    <p className="text-body">Runs for {EVENT_NOUN[event] ?? 'events'}{complete.length ? ' ' : ''}{complete.map(filterPhrase).join(', ')}{complete.length ? '' : ' of every kind'}.</p>
    <ul className="flex flex-col divide-y divide-border border-y border-border">
      {shown.map(filter => <li key={filter.kind} className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2 gap-y-1.5 py-2.5 sm:grid-cols-[7.5rem_minmax(0,1fr)_auto]">
        <span className="pt-1.5 text-caption font-medium text-muted-foreground">{FILTER_LABEL[filter.kind]}</span>
        <div className="col-span-2 row-start-2 flex min-w-0 flex-col items-stretch gap-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">
          {FILTER_MODES[filter.kind].length > 1 ? <div className="w-44 max-w-full"><Select value={filter.mode} onValueChange={mode => update(filter.kind, { mode })}><SelectTrigger aria-label={`${FILTER_LABEL[filter.kind]} rule`} />{options(FILTER_MODES[filter.kind])}</Select></div>
            : <span className="pt-1.5 text-body text-muted-foreground">{FILTER_MODES[filter.kind][0]}</span>}
          {CHOICE_ONLY[filter.kind] ? null : <ChipsInput kind={filter.kind} values={filter.values} onChange={values => update(filter.kind, { values })} />}
        </div>
        <Button variant="ghost" size="icon" type="button" className="col-start-2 row-start-1 sm:col-start-3" aria-label={`Remove the ${FILTER_LABEL[filter.kind]} filter`}
          onClick={() => setFilters(current => current.filter(entry => entry.kind !== filter.kind))}><Trash01 width={14} height={14} strokeWidth={1.5} /></Button>
      </li>)}
    </ul>
    {unused.length ? <div><DropdownMenu>
      <DropdownTrigger render={<Button variant="ghost" size="compact" type="button" leadingIcon={glyph(Plus)}>Add a filter</Button>} />
      <DropdownContent align="start" className="min-w-[200px] w-[200px]">
        {unused.map((kind, index) => <MenuItem key={kind} index={index} label={FILTER_LABEL[kind]} onSelect={() => setFilters(current => [...current, { kind, mode: FILTER_MODES[kind][0] ?? '', values: [] }])} />)}
      </DropdownContent>
    </DropdownMenu></div> : null}
    <p className="text-caption text-muted-foreground">Values can be patterns: <span className="font-mono">release/*</span>, <span className="font-mono">docs/**</span>. Events from authors without write access who are not on the trust list never match.</p>
  </section>;
}

function Editor({ onClose }: { onClose(): void }): ReactElement {
  const shape = useShape();
  const [name, setName] = useState('Review pull requests');
  const [trigger, setTrigger] = useState('GitHub event');
  const [event, setEvent] = useState('Pull request');
  const [actions, setActions] = useState<ReadonlySet<string>>(new Set(['opened', 'ready_for_review']));
  const [then, setThen] = useState('Start a workspace for the subject');
  const [mode, setMode] = useState<string>('Review');
  const [delivery, setDelivery] = useState('Wakes the agent');
  const [agent, setAgent] = useState('reviewer');
  const [prompt, setPrompt] = useState('Review {{pull_request.html_url}} against {{pull_request.base.ref}}. Leave one review with inline comments; request changes only for correctness or security problems.');
  return <>
    <DialogHeader>
      <DialogTitle>Edit automation</DialogTitle>
      <DialogDescription>Automations start new work. Later activity on the pull request or issue reaches the workspace through its link, not through this automation.</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-5">
      <Field label="Name"><TextInput label="Name" value={name} onChange={setName} /></Field>

      <section className="flex flex-col gap-3">
        <strong className="text-body font-semibold">When</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Trigger"><Select value={trigger} onValueChange={setTrigger}><SelectTrigger aria-label="Trigger" />{options(['GitHub event', 'Label added', 'Schedule', 'Manual only'])}</Select></Field>
          {trigger === 'Label added'
            ? <Field label="Labels"><span className={`${shape.input} border border-border bg-surface-2 px-2 py-1.5 font-mono text-caption`}>gitspace:plan, gitspace:code, gitspace:review</span></Field>
            : <Field label="Event"><Select value={event} onValueChange={setEvent}><SelectTrigger aria-label="Event" />{options(['Pull request', 'Pull request review', 'Issue', 'Issue comment', 'Push', 'Check suite'])}</Select></Field>}
        </div>
        {trigger === 'GitHub event' ? <div className="flex flex-wrap gap-1.5">{PR_ACTIONS.map(action => <Button key={action} size="compact" type="button"
          variant={actions.has(action) ? 'primary' : 'secondary'}
          onClick={() => setActions(current => { const next = new Set(current); if (next.has(action)) next.delete(action); else next.add(action); return next; })}>
          <span className="font-mono">{action}</span></Button>)}</div> : null}
        {trigger === 'Label added' ? <p className="text-caption text-muted-foreground">Each label starts its own mode: <span className="font-mono">gitspace:plan</span> in Plan, <span className="font-mono">gitspace:code</span> in Code, <span className="font-mono">gitspace:review</span> in Review.</p> : null}
      </section>

      {trigger === 'GitHub event' ? <Filters event={event} /> : null}

      <section className="flex flex-col gap-3">
        <strong className="text-body font-semibold">Then</strong>
        <Field label="Action"><Select value={then} onValueChange={setThen}><SelectTrigger aria-label="Action" />{options(['Start a workspace for the subject', 'Send to the linked workspace', 'Message a workspace', 'Message the project agent', 'Ask the project agent'])}</Select></Field>
        {then === 'Start a workspace for the subject' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Starts in"><Select value={mode} onValueChange={setMode}><SelectTrigger aria-label="Starts in" />{options(['Plan', 'Code', 'Review'])}</Select></Field>
          <Field label="Agent"><Select value={agent} onValueChange={setAgent}><SelectTrigger aria-label="Agent" />{options(['default', 'reviewer', 'scout'])}</Select></Field>
        </div> : null}
        {then === 'Send to the linked workspace' ? <Field label="Delivery"><Select value={delivery} onValueChange={setDelivery}><SelectTrigger aria-label="Delivery" />{options(['Wakes the agent', 'A notice; the agent stays asleep'])}</Select></Field> : null}
        {then === 'Ask the project agent' ? <p className="text-caption text-muted-foreground">The project agent gets the event and decides: start a workspace, link it to one that already covers it, message one, or skip. One agent turn per event.</p> : null}
        <Field label="Instruction">
          <textarea rows={4} value={prompt} onChange={e => setPrompt(e.currentTarget.value)}
            className={`${shape.input} w-full resize-y border border-border bg-surface-2 p-2 text-body text-foreground outline-none`} />
        </Field>
        {trigger === 'GitHub event' ? <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" leadingIcon={glyph(Plus)}>Insert a field</Button>} />
            <DropdownContent align="start" className="min-w-[280px] w-[280px]">
              {(EVENT_FIELDS[event] ?? []).map((field, index) => <MenuItem key={field.path} index={index} label={`${field.label} · {{${field.path}}}`} onSelect={() => setPrompt(current => `${current}{{${field.path}}}`)} />)}
            </DropdownContent>
          </DropdownMenu>
          <span className="text-caption text-muted-foreground">A field in <span className="font-mono">{'{{…}}'}</span> is replaced by the event's value; Test with a past event shows the result.</span>
        </div> : null}
        <p className="text-caption text-muted-foreground">The event arrives with the instruction as the workspace's first message, and the workspace is linked to the pull request.</p>
      </section>

      <TestWithPastEvent />
    </div>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="button" onClick={onClose}>Save changes</Button>
    </DialogFooter>
  </>;
}

function LinkDialog({ onClose }: { onClose(): void }): ReactElement {
  const [workspace, setWorkspace] = useState('session-recovery');
  const [subject, setSubject] = useState('#1140');
  return <>
    <DialogHeader>
      <DialogTitle>Link a pull request or issue</DialogTitle>
      <DialogDescription>Its activity goes to this workspace, and mentions of {BOT} on it reach the workspace's agent.</DialogDescription>
    </DialogHeader>
    <div className="flex flex-col gap-4">
      <Field label="Workspace"><Select value={workspace} onValueChange={setWorkspace}><SelectTrigger aria-label="Workspace" />{options(['session-recovery', 'plan-issue-391', 'storybook-jit', 'review-pr-1142'])}</Select></Field>
      <Field label="Pull request, issue or branch"><TextInput label="Pull request, issue or branch" value={subject} onChange={setSubject} mono /></Field>
      <p className="text-caption text-muted-foreground">A link you or an agent make replaces one found by branch. A pull request or issue has one workspace in this project; linking it here moves it from its current workspace.</p>
    </div>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
      <Button variant="primary" type="button" leadingIcon={glyph(Link01)} onClick={onClose}>Link</Button>
    </DialogFooter>
  </>;
}

function ProjectPicker({ project, onPick }: { project: string; onPick(project: string): void }): ReactElement {
  return <DropdownMenu>
    <DropdownTrigger render={<button type="button" className="-ml-1 flex items-center gap-1 rounded px-1 text-caption font-medium text-muted-foreground hover:text-foreground" aria-label="Project">{project}<ChevronDown width={14} height={14} strokeWidth={1.5} /></button>} />
    <DropdownContent align="start" className="min-w-[240px] w-[240px]">
      {[ALL_PROJECTS, ...PROJECTS.map(entry => entry.name)].map((name, index) => <MenuItem key={name} index={index} label={name} onSelect={() => onPick(name)} />)}
    </DropdownContent>
  </DropdownMenu>;
}

function AllProjects({ onPick, onOpen }: { onPick(project: string): void; onOpen(run: Run): void }): ReactElement {
  const shape = useShape();
  return <>
    <Section title="Projects">
      <ul className={`${shape.container} flex flex-col divide-y divide-border bg-surface-2 shadow-surface-1`}>
        {PROJECTS.map(entry => <li key={entry.name}><button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-3 text-left" onClick={() => onPick(entry.name)}>
          <span className="flex flex-col gap-0.5"><span className="text-body font-medium">{entry.name}</span><span className="text-caption text-muted-foreground">{entry.on}</span></span>
          <span className="flex gap-1.5">
            {entry.failed ? <Badge size="compact" color="red">{entry.failed} failed today</Badge> : null}
          </span>
        </button></li>)}
      </ul>
    </Section>
    <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Every project · choose one to change its automations</span>}>
      <RunsTable runs={[...RUNS.slice(0, 2), ...OTHER_RUNS, ...RUNS.slice(2)]} showProject onOpen={onOpen} />
    </Section>
  </>;
}

function AutomationsMock(): ReactElement {
  const shape = useShape();
  const [project, setProject] = useState('inkibra core');
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const all = project === ALL_PROJECTS;
  const empty = project !== ALL_PROJECTS && project !== 'inkibra core';
  return <div className="flex h-dvh flex-col bg-background">
    <PageCanvas>
      <PageHeader kicker={<ProjectPicker project={project} onPick={setProject} />} title="Automations"
        description={all ? 'Every project\'s automations and runs. Choose a project to change its automations, links and trusted authors.' : 'When something happens in this project, start work. Activity on a linked pull request or issue goes to its workspace.'}
        actions={all || empty ? undefined : <Button variant="primary" type="button" leadingIcon={glyph(Plus)} onClick={() => setEditing(true)}>New automation</Button>} />

      {empty ? null : <section aria-label="Automation summary" className={`${shape.container} mb-6 flex flex-col bg-surface-2 shadow-surface-1`}>
        <div className="grid grid-cols-2 divide-border sm:grid-cols-4 sm:divide-x [&>*:nth-child(-n+2)]:border-b [&>*:nth-child(-n+2)]:border-border sm:[&>*:nth-child(-n+2)]:border-b-0">
          <Stat value={all ? '12 of 14' : '8 of 10'} label="On · 1 proposed" />
          <Stat value={all ? '3 / 4' : '2 / 2'} label="Working now" />
          <Stat value={1} label="Queued" />
          <Stat value={1} label="Failed today" />
        </div>
        <p className="border-t border-border px-5 py-3 text-caption text-muted-foreground">{all ? 'Each project runs at most 2 at once.' : 'At most 2 runs work at once.'} A run holds a slot only while its agent works; a workspace waiting for you does not.</p>
      </section>}

      {all ? <AllProjects onPick={setProject} onOpen={setRun} />
        : empty ? <div className={`${shape.container} flex flex-col items-start gap-3 bg-surface-2 px-5 py-6 shadow-surface-1`}>
          <strong className="text-body font-semibold">No automations in {project}</strong>
          <p className="max-w-xl text-body text-muted-foreground">Start work when a pull request opens, an issue is labeled, or on a schedule. Installing the GitSpace GitHub App on its repository adds the default automations that send review feedback, failed checks and mentions to linked workspaces. You can also ask the project agent to set one up; what it proposes waits here until you switch it on.</p>
          <Button variant="primary" type="button" leadingIcon={glyph(Plus)} onClick={() => setEditing(true)}>New automation</Button>
        </div>
        : <>
          <Section title="Start work">
            <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
              {AUTOMATIONS.filter(automation => !automation.linked).map((automation, index) => <AutomationCard key={automation.id} automation={automation} index={index} onEdit={() => setEditing(true)} />)}
            </CardGroup>
          </Section>

          <Section title="Sent to linked workspaces" aside={<span className="text-caption text-muted-foreground">Events on a linked pull request or issue that no automation matches are not sent</span>}>
            <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
              {AUTOMATIONS.filter(automation => automation.linked).map((automation, index) => <AutomationCard key={automation.id} automation={automation} index={index} onEdit={() => setEditing(true)} />)}
            </CardGroup>
          </Section>

          <Section title="Linked pull requests and issues"
            aside={<Button variant="secondary" size="compact" type="button" leadingIcon={glyph(Link01)} onClick={() => setLinking(true)}>Link a pull request or issue</Button>}>
            <p className="text-caption text-muted-foreground">Each has one workspace in this project, linked when GitSpace starts the workspace for it, when an agent or you link it, or by branch. What reaches the workspace is set by the automations under Sent to linked workspaces.</p>
            <LinksTable onLink={() => setLinking(true)} />
          </Section>

          <Section title="Trusted authors">
            <TrustList />
          </Section>

          <Section title="Recent runs" aside={<span className="text-caption text-muted-foreground">Every event seen, skipped ones included</span>}>
            <RunsTable runs={RUNS} showProject={false} onOpen={setRun} />
          </Section>
        </>}

      <Dialog open={editing} onOpenChange={open => { if (!open) setEditing(false); }}>
        <DialogContent size="lg"><Editor onClose={() => setEditing(false)} /></DialogContent>
      </Dialog>
      <Dialog open={linking} onOpenChange={open => { if (!open) setLinking(false); }}>
        <DialogContent><LinkDialog onClose={() => setLinking(false)} /></DialogContent>
      </Dialog>
      <Dialog open={run !== null} onOpenChange={open => { if (!open) setRun(null); }}>
        <DialogContent size="lg">{run ? <RunDetail run={run} /> : null}</DialogContent>
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
