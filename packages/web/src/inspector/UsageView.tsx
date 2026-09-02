import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardGroup,
  CardHeader,
  CardTitle,
  ScrollArea,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ThinkingIndicator,
  type BadgeProps,
} from '@gitspace/ui';
import type { SessionUsageReport } from '@gitspace/protocol';
import { AlertCircle, BarChart01, RefreshCcw01 } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { EmptyState } from '../GitSpaceShell.js';

export type UsageStatus = 'idle' | 'loading' | 'ready' | 'error';
export interface UsageViewProps {
  sessionId: string | null;
  report: SessionUsageReport | null;
  status: UsageStatus;
  error?: string;
  onLoad(): void;
  onRefresh(): void;
}

type UsageTotals = SessionUsageReport['totals'];
type Selection = SessionUsageReport['byAgent'][number]['selection'];

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const selectionColor: Record<Selection, NonNullable<BadgeProps['color']>> = { role: 'green', pinned: 'amber', inherited: 'gray' };

function tokens(value: number): string { return compactNumber.format(value); }
function usd(value: number): string { return value === 0 || value >= 0.01 ? `$${value.toFixed(2)}` : `$${value.toFixed(4)}`; }
function requests(value: number): string { return `${value}×`; }
function dateRange(first: string | null, last: string | null): string {
  if (!first) return '—';
  const from = dayFormat.format(new Date(first));
  const to = dayFormat.format(new Date(last ?? first));
  return from === to ? from : `${from}–${to}`;
}
function ic(Icon: typeof RefreshCcw01, size = 16): ReactNode { return <Icon width={size} height={size} strokeWidth={1.5} />; }

function MetaCard({ label, children }: { label: string; children: ReactNode }) {
  return <Card size="compact"><CardHeader><CardDescription>{label}</CardDescription><CardTitle className="flex items-center gap-2 truncate tabular-nums">{children}</CardTitle></CardHeader></Card>;
}
function Figures({ totals }: { totals: UsageTotals }) {
  return <>
    <TableCell className="text-right tabular-nums text-muted-foreground">{requests(totals.requests)}</TableCell>
    <TableCell className="text-right tabular-nums text-muted-foreground">{tokens(totals.totalTokens)}</TableCell>
    <TableCell className="text-right tabular-nums text-foreground">{usd(totals.costUsd)}</TableCell>
  </>;
}
function FigureHeads() {
  return <>
    <TableHead className="text-right">Requests</TableHead>
    <TableHead className="text-right">Tokens</TableHead>
    <TableHead className="text-right">Cost</TableHead>
  </>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><h3 className="text-caption font-medium text-muted-foreground">{title}</h3>{children}</section>;
}

function Report({ report }: { report: SessionUsageReport }) {
  const { totals, totalsDeep } = report;
  const hasChildren = report.childSessions > 0;
  const buckets: ReadonlyArray<{ label: string; value: number }> = [
    { label: 'Input', value: totals.input },
    { label: 'Output', value: totals.output },
    { label: 'Cache read', value: totals.cacheRead },
    { label: 'Cache write', value: totals.cacheWrite },
  ];
  const bucketTotal = totals.input + totals.output + totals.cacheRead + totals.cacheWrite;
  return <>
    <CardGroup columns={2} separated border="outlined">
      <MetaCard label="Cost">{usd(totals.costUsd)}</MetaCard>
      <MetaCard label="Tokens">{tokens(totals.totalTokens)}</MetaCard>
      <MetaCard label="With subagents">{usd(totalsDeep.costUsd)}<span className="text-caption font-normal text-muted-foreground">{report.childSessions} sub-session{report.childSessions === 1 ? '' : 's'}</span></MetaCard>
      <MetaCard label="Requests">{requests(totals.requests)}</MetaCard>
    </CardGroup>
    <Section title="Token buckets">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Bucket</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Share</TableHead></TableRow></TableHeader>
        <TableBody>{buckets.map((bucket, index) => <TableRow index={index} key={bucket.label}>
          <TableCell className="text-foreground">{bucket.label}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{tokens(bucket.value)}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{bucketTotal > 0 ? `${Math.round(bucket.value / bucketTotal * 100)}%` : '—'}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {totals.reasoningTokens > 0 ? <span className="text-caption text-muted-foreground tabular-nums">{tokens(totals.reasoningTokens)} reasoning tokens included in output.</span> : null}
    </Section>
    {report.byModel.length ? <Section title="By provider · model">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Provider · model</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>{report.byModel.map((row, index) => <TableRow index={index} key={`${row.provider}/${row.model}`}>
          <TableCell className="max-w-0"><span className="flex min-w-0 flex-col"><span className="truncate font-mono text-foreground">{row.model}</span><span className="truncate text-caption text-muted-foreground">{row.provider}</span></span></TableCell>
          <Figures totals={row.totals} />
        </TableRow>)}</TableBody>
      </Table>
    </Section> : null}
    {report.byRole.length ? <Section title="By role">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Role</TableHead><TableHead>Models</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>{report.byRole.map((row, index) => <TableRow index={index} key={row.role}>
          <TableCell className="text-foreground">{row.role}</TableCell>
          <TableCell className="max-w-0"><span className="block truncate font-mono text-caption text-muted-foreground" title={row.models.join(', ')}>{row.models.join(', ') || '—'}</span></TableCell>
          <Figures totals={row.totals} />
        </TableRow>)}</TableBody>
      </Table>
    </Section> : null}
    {hasChildren || report.byAgent.length ? <Section title="By subagent">
      {report.byAgent.length ? <Table size="compact">
        <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead>Selection</TableHead><TableHead>Model</TableHead><TableHead className="text-right">Spawns</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Cost</TableHead><TableHead className="text-right">When</TableHead></TableRow></TableHeader>
        <TableBody>{report.byAgent.map((row, index) => <TableRow index={index} key={`${row.agentId}|${row.selection}|${row.model}`}>
          <TableCell className="max-w-0"><span className="block truncate text-foreground" title={row.agentId}>{row.agent}</span></TableCell>
          <TableCell><Badge variant="dot" size="compact" color={selectionColor[row.selection]}>{row.selection}</Badge></TableCell>
          <TableCell className="max-w-0"><span className="block truncate font-mono text-caption text-muted-foreground" title={row.model}>{row.model}</span></TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{requests(row.spawns)}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{tokens(row.totals.totalTokens)}</TableCell>
          <TableCell className="text-right tabular-nums text-foreground">{usd(row.totals.costUsd)}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground" title={row.firstAt ? `${new Date(row.firstAt).toLocaleString()} → ${new Date(row.lastAt ?? row.firstAt).toLocaleString()}` : undefined}>{dateRange(row.firstAt, row.lastAt)}</TableCell>
        </TableRow>)}</TableBody>
      </Table> : <p className="text-caption text-muted-foreground">Subagent spend is counted in the deep totals, but no spawn was attributed to a named agent.</p>}
      <span className="text-caption text-muted-foreground">Selection shows how each subagent's model was chosen: a role, an explicit pin, or inherited from the parent session.</span>
    </Section> : null}
    {report.warnings.length ? <ul className="flex flex-col gap-1 text-caption text-muted-foreground">{report.warnings.map((warning, index) => <li className="flex items-start gap-1.5" key={index}><span className="mt-px shrink-0">{ic(AlertCircle, 12)}</span><span>{warning}</span></li>)}</ul> : null}
  </>;
}

export function UsageView({ sessionId, report, status, error, onLoad, onRefresh }: UsageViewProps) {
  if (!sessionId) return <div className="p-4"><EmptyState icon={ic(BarChart01, 22)} title="No live session" description="Usage is attributed per agent session. Start the workspace agent to record requests, tokens, and cost." /></div>;
  let body: ReactNode;
  if (status === 'loading') body = <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label="Loading session usage…" /></div>;
  else if (status === 'error') body = <EmptyState icon={ic(AlertCircle, 22)} title="Usage could not load" description={error ?? 'The session transcript could not be read.'} action={<Button variant="secondary" size="compact" type="button" onClick={onRefresh}>Retry</Button>} />;
  else if (status === 'idle' || !report) body = <EmptyState icon={ic(BarChart01, 22)} title="Usage not loaded" description="Read the session transcript to attribute requests, tokens, and cost by model, role, and subagent." action={<Button variant="secondary" size="compact" type="button" onClick={onLoad}>Load usage</Button>} />;
  else if (report.totals.requests === 0 && report.childSessions === 0) body = <EmptyState icon={ic(BarChart01, 22)} title="No usage yet" description="This session has not completed an assistant request." />;
  else body = <Report report={report} />;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col"><span className="text-caption text-muted-foreground">Session usage</span><span className="truncate font-mono text-caption text-muted-foreground">{sessionId}</span></div>
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Refresh usage" disabled={status === 'loading'} onClick={onRefresh}>{ic(RefreshCcw01)}</Button>
    </header>
    {body}
  </div></ScrollArea>;
}
