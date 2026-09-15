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
const selectionColor: Record<Selection, NonNullable<BadgeProps['color']>> = { role: 'green', pinned: 'amber', inherited: 'gray', unknown: 'gray' };

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
function Figures({ totals }: { totals: Pick<UsageTotals, 'requests' | 'totalTokens' | 'costUsd'> }) {
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
    <TableHead className="text-right">Recorded cost</TableHead>
  </>;
}
function Section({ title, children }: { title: string; children: ReactNode }) {
  return <section className="flex flex-col gap-2"><h3 className="text-caption font-medium text-muted-foreground">{title}</h3>{children}</section>;
}

function Report({ report }: { report: SessionUsageReport }) {
  const { totals, totalsDeep } = report;
  const hasChildren = report.childSessions > 0;
  const childTotals = { requests: totalsDeep.requests - totals.requests, totalTokens: totalsDeep.totalTokens - totals.totalTokens, costUsd: totalsDeep.costUsd - totals.costUsd };
  const buckets: ReadonlyArray<{ label: string; value: number }> = [
    { label: 'Input', value: totalsDeep.input },
    { label: 'Output', value: totalsDeep.output },
    { label: 'Cache read', value: totalsDeep.cacheRead },
    { label: 'Cache write', value: totalsDeep.cacheWrite },
  ];
  const bucketTotal = totalsDeep.input + totalsDeep.output + totalsDeep.cacheRead + totalsDeep.cacheWrite;
  return <>
    <CardGroup columns={2} separated border="outlined">
      <MetaCard label="Total recorded cost">{usd(totalsDeep.costUsd)}</MetaCard>
      <MetaCard label="Total tokens">{tokens(totalsDeep.totalTokens)}</MetaCard>
      <MetaCard label="Child sessions">{report.childSessions}</MetaCard>
      <MetaCard label="Total requests">{requests(totalsDeep.requests)}</MetaCard>
    </CardGroup>
    <p className="text-caption text-muted-foreground">Combined totals include this session, every recorded descendant, and direct model calls. SDK-recorded cost is an estimate, not account billing; zero can mean pricing was unavailable.</p>
    <Section title="Session scope">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Scope</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>
          <TableRow index={0}><TableCell>This session</TableCell><Figures totals={totals} /></TableRow>
          <TableRow index={1}><TableCell>All child sessions</TableCell><Figures totals={childTotals} /></TableRow>
        </TableBody>
      </Table>
    </Section>
    <Section title="Token buckets · entire tree">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Bucket</TableHead><TableHead className="text-right">Tokens</TableHead><TableHead className="text-right">Share</TableHead></TableRow></TableHeader>
        <TableBody>{buckets.map((bucket, index) => <TableRow index={index} key={bucket.label}>
          <TableCell className="text-foreground">{bucket.label}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{tokens(bucket.value)}</TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{bucketTotal > 0 ? `${Math.round(bucket.value / bucketTotal * 100)}%` : '—'}</TableCell>
        </TableRow>)}</TableBody>
      </Table>
      {totalsDeep.reasoningTokens > 0 ? <span className="text-caption text-muted-foreground tabular-nums">{tokens(totalsDeep.reasoningTokens)} recorded reasoning tokens (may overlap output).</span> : null}
    </Section>
    {report.byModel.length ? <Section title="By provider · model · entire tree">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Provider · model</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>{report.byModel.map((row, index) => <TableRow index={index} key={`${row.provider}/${row.model}`}>
          <TableCell className="max-w-0"><span className="flex min-w-0 flex-col"><span className="truncate font-mono text-foreground">{row.model}</span><span className="truncate text-caption text-muted-foreground">{row.provider}</span></span></TableCell>
          <Figures totals={row.totals} />
        </TableRow>)}</TableBody>
      </Table>
    </Section> : null}
    {report.byRole.length ? <Section title="By historical role · entire tree">
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Role</TableHead><TableHead>Models</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>{report.byRole.map((row, index) => <TableRow index={index} key={JSON.stringify(row.role)}>
          <TableCell className="text-foreground">{row.role ?? 'Not recorded'}</TableCell>
          <TableCell className="max-w-0"><span className="block truncate font-mono text-caption text-muted-foreground" title={row.models.join(', ')}>{row.models.join(', ') || '—'}</span></TableCell>
          <Figures totals={row.totals} />
        </TableRow>)}</TableBody>
      </Table>
    </Section> : null}
    {hasChildren || report.byAgent.length ? <Section title="By agent definition">
      {report.byAgent.length ? <Table size="compact">
        <TableHeader><TableRow><TableHead>Definition · historical role · actual model</TableHead><TableHead className="text-right">Sessions</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>{report.byAgent.map((row, index) => <TableRow index={index} key={JSON.stringify([row.agentId, row.definitionSource, row.definitionPath, row.definitionRevision, row.role, row.selection, row.provider, row.model])}>
          <TableCell>
            <div className="flex min-w-40 flex-col gap-1">
              <span className="font-medium text-foreground">{row.agent}</span>
              <span className="break-all font-mono text-caption text-muted-foreground">{row.definitionPath ?? 'Definition path not recorded'}</span>
              <span className="text-caption text-muted-foreground">{row.definitionSource ?? 'Source not recorded'} · {row.definitionRevision ? <span title={row.definitionRevision}>{row.definitionRevision.slice(0, 8)}</span> : 'Revision not recorded'}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-caption"><span>Role: {row.role ?? 'Not recorded'}</span><Badge variant="dot" size="compact" color={selectionColor[row.selection]}>{row.selection === 'unknown' ? 'Selection not recorded' : row.selection}</Badge></span>
              <span className="break-all font-mono text-caption text-muted-foreground">{row.provider ? `${row.provider} / ` : ''}{row.model || 'Model not recorded'}</span>
              <span className="text-caption text-muted-foreground tabular-nums" title={row.firstAt ? `${new Date(row.firstAt).toLocaleString()} → ${new Date(row.lastAt ?? row.firstAt).toLocaleString()}` : undefined}>{dateRange(row.firstAt, row.lastAt)}</span>
            </div>
          </TableCell>
          <TableCell className="text-right tabular-nums text-muted-foreground">{row.spawns}</TableCell>
          <Figures totals={row.totals} />
        </TableRow>)}</TableBody>
      </Table> : <p className="text-caption text-muted-foreground">Child usage is included in the combined totals, but no definition was recorded.</p>}
      <p className="text-caption text-muted-foreground">Roles, definitions, and serving models describe recorded history, not current Agent setup. A child using multiple models appears in multiple rows; session counts are not additive.</p>
    </Section> : null}
    {report.byCompletion.length ? <Section title="Direct model calls">
      <p className="text-caption text-muted-foreground">Already included in the totals and breakdowns above. These calls run inside a session; they are not child agents.</p>
      <Table size="compact">
        <TableHeader><TableRow><TableHead>Call · historical role · actual model</TableHead><FigureHeads /></TableRow></TableHeader>
        <TableBody>{report.byCompletion.map((row, index) => <TableRow index={index} key={JSON.stringify([row.kind, row.role, row.provider, row.model])}>
          <TableCell><div className="flex min-w-32 flex-col gap-1"><span className="text-foreground">{row.kind}</span><span className="text-caption text-muted-foreground">Role: {row.role ?? 'Not recorded'}</span><span className="break-all font-mono text-caption text-muted-foreground">{row.provider} / {row.model}</span></div></TableCell>
          <Figures totals={row.totals} />
        </TableRow>)}</TableBody>
      </Table>
    </Section> : null}
    {report.warnings.length ? <ul className="flex flex-col gap-1 text-caption text-muted-foreground">{report.warnings.map((warning, index) => <li className="flex items-start gap-1.5" key={index}><span className="mt-px shrink-0">{ic(AlertCircle, 12)}</span><span>{warning}</span></li>)}</ul> : null}
  </>;
}

export function UsageView({ sessionId, report, status, error, onLoad, onRefresh }: UsageViewProps) {
  if (!sessionId) return <div className="p-4"><EmptyState icon={ic(BarChart01, 22)} title="No live session" description="Usage is attributed per agent session. Start the workspace agent to record requests, tokens, and cost." /></div>;
  let body: ReactNode;
  if (!report && status === 'loading') body = <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label="Loading session usage…" /></div>;
  else if (!report && status === 'error') body = <EmptyState icon={ic(AlertCircle, 22)} title="Usage could not load" description={error ?? 'The session transcript could not be read.'} action={<Button variant="secondary" size="compact" type="button" onClick={onRefresh}>Retry</Button>} />;
  else if (!report) body = <EmptyState icon={ic(BarChart01, 22)} title="Usage not loaded" description="Read the session tree to attribute requests, tokens, and recorded cost by model, historical role, and definition." action={<Button variant="secondary" size="compact" type="button" onClick={onLoad}>Load usage</Button>} />;
  else if (report.totalsDeep.requests === 0 && report.childSessions === 0 && report.warnings.length === 0) body = <EmptyState icon={ic(BarChart01, 22)} title="No usage yet" description="This session tree has no recorded model requests." />;
  else body = <Report report={report} />;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex items-center justify-between gap-2">
      <div className="flex min-w-0 flex-col"><span className="text-caption text-muted-foreground">Session usage</span><span className="truncate font-mono text-caption text-muted-foreground">{sessionId}</span></div>
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Refresh usage" disabled={status === 'loading'} onClick={onRefresh}>{ic(RefreshCcw01)}</Button>
    </header>
    {report && status === 'loading' ? <p role="status" className="text-caption text-muted-foreground">Refreshing usage; showing the last report.</p> : null}
    {report && error ? <div role="alert" className="flex flex-col gap-1 text-caption text-destructive"><span>Usage refresh failed: {error}</span><span>The last report is still shown.</span><Button variant="ghost" size="compact" type="button" onClick={onRefresh} disabled={status === 'loading'}>Retry usage</Button></div> : null}
    {body}
  </div></ScrollArea>;
}
