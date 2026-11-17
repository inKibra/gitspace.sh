// Blocks that explain by shape and colour rather than prose: a call stack before and after, numbers that moved, log lines,
// events in time, options scored, checks in a grid, a schema change, workspaces by dependency, a ranking, a budget.
import type { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import { Button, Tooltip, badgeColors } from '@gitspace/ui';
import { useActions } from '@json-render/react';
import { ArrowRight, Check, ChevronDown } from '@untitledui/icons';
import { getSharedHighlighter, type ThemedToken } from '@pierre/diffs';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useDarkScheme } from '../appearance.js';
import type { z } from 'zod';
import { ResourceNavigation } from '../ResourceNavigation.js';
import { formatChartValue } from './ChartView.js';
import { RefChip } from './references.js';
import { ItemComment, commentItem } from '../comments/CommentLayer.js';

type Props<K extends keyof typeof gitspaceUiCatalog.components> = z.output<(typeof gitspaceUiCatalog.components)[K]['props']>;
type Change = 'added' | 'removed' | 'changed' | 'same';

/** A change's colour: added green, removed red, changed amber; unchanged has none. */
const CHANGE: Record<Change, string | null> = { added: badgeColors.green, removed: badgeColors.red, changed: badgeColors.amber, same: null };

function tint(tone: string | null, percent: number): string {
  return tone ? `color-mix(in oklab, ${tone} ${percent}%, transparent)` : 'transparent';
}

// ── CallDiff ──

/** Whether a line deeper than `level` continues the branch at `level` below it, so the guide at `level` goes on. */
function guideContinues(lines: Props<'CallDiff'>['lines'], index: number, level: number): boolean {
  for (const line of lines.slice(index + 1)) {
    if (line.depth < level) return false;
    if (line.depth === level) return true;
  }
  return false;
}

export function CallDiffView({ title, language, lines }: Props<'CallDiff'>) {
  const open = useContext(ResourceNavigation);
  const dark = useDarkScheme();
  const code = lines.map((line) => line.code).join('\n');
  const lang = language ?? 'typescript';
  /** Each line's tokens, highlighted together so a construct spanning lines reads right; plain until the grammar loads. */
  const [tokens, setTokens] = useState<ThemedToken[][] | null>(null);
  useEffect(() => {
    let live = true;
    const theme = dark ? 'github-dark' : 'github-light';
    getSharedHighlighter({ themes: [theme], langs: [lang] })
      .then((highlighter) => { if (live) setTokens(highlighter.codeToTokens(code, { lang, theme }).tokens); })
      .catch(() => { if (live) setTokens(null); });
    return () => { live = false; };
  }, [code, lang, dark]);
  return <figure className="overflow-hidden rounded-lg bg-surface-1 shadow-surface-1">
    {title ? <figcaption className="border-b border-border px-3 py-1.5 text-caption text-muted-foreground">{title}</figcaption> : null}
    <div className="overflow-x-auto py-1 font-mono text-[12px] leading-[22px]">
      {lines.map((line, index) => {
        const tone = CHANGE[line.change];
        const guides = Array.from({ length: line.depth }, (_, level) => level + 1 === line.depth ? (guideContinues(lines, index, line.depth) ? '├─' : '└─') : (guideContinues(lines, index, level + 1) ? '│ ' : '  '));
        const lineTokens = tokens?.[index];
        const row = <div className="flex min-w-max items-center whitespace-pre pr-3" style={{ background: tint(tone, 12), boxShadow: tone ? `inset 2px 0 0 ${tone}` : undefined }}>
          <span className="w-4 shrink-0 text-center" style={{ color: tone ?? 'var(--muted-foreground)' }}>{line.change === 'added' ? '+' : line.change === 'removed' ? '−' : ''}</span>
          <span className="text-muted-foreground/60">{guides.join('')}</span>
          <span className={line.change === 'removed' ? 'opacity-70' : undefined}>
            {lineTokens ? lineTokens.map((token, tokenIndex) => <span key={tokenIndex} style={{ color: token.color, fontStyle: token.fontStyle === 1 ? 'italic' : undefined }}>{token.content}</span>) : <span className="text-foreground">{line.code}</span>}
          </span>
          {line.note ? <span className="pl-3 text-muted-foreground"># {line.note}</span> : null}
          {line.path ? <span className="pl-2 text-muted-foreground/70">↗</span> : null}
        </div>;
        // The comment icon stays at the visible right edge while the line scrolls sideways.
        return <div key={index} className="group/item flex min-w-max items-stretch" {...commentItem(`lines/${index}`, `line ${index + 1}`)}>
          {line.path && open
            ? <button type="button" className="block flex-1 cursor-pointer text-left hover:brightness-95" title={line.path} onClick={() => open({ uri: `repo://${line.path}` })}>{row}</button>
            : <div className="flex-1">{row}</div>}
          <span className="sticky right-0 flex items-center bg-surface-1 px-1" style={tone ? { boxShadow: `inset 0 0 0 999px ${tint(tone, 12)}` } : undefined}><ItemComment path={`lines/${index}`} label={`line ${index + 1}`} quote={line.code} /></span>
        </div>;
      })}
    </div>
  </figure>;
}

// ── MetricDelta ──

function Sparkline({ values, tone }: { values: readonly number[]; tone: string }) {
  if (values.length < 2) return null;
  const min = Math.min(...values), max = Math.max(...values), span = max - min || 1;
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 80},${22 - ((value - min) / span) * 20}`).join(' ');
  return <svg viewBox="0 0 80 24" className="h-6 w-20" aria-hidden><polyline points={points} fill="none" stroke={tone} strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" /></svg>;
}

export function MetricDeltaView({ metrics }: Props<'MetricDelta'>) {
  return <div className="grid grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] gap-2">
    {metrics.map((metric, index) => {
      const change = metric.before === 0 ? null : (metric.after - metric.before) / Math.abs(metric.before) * 100;
      const improved = metric.better === 'lower' ? metric.after < metric.before : metric.after > metric.before;
      // A metric that did not exist before is neither better nor worse.
      const tone = metric.after === metric.before || change === null ? 'var(--muted-foreground)' : improved ? badgeColors.green : badgeColors.red;
      return <div key={index} className="flex flex-col gap-1 rounded-lg bg-surface-1 p-3 shadow-surface-1" style={{ boxShadow: `inset 0 3px 0 0 ${tone}` }}>
        <span className="text-caption text-muted-foreground">{metric.label}</span>
        <span className="flex items-baseline gap-1.5 tabular-nums">
          <span className="text-caption text-muted-foreground line-through decoration-muted-foreground/50">{formatChartValue(metric.before, metric.unit)}</span>
          <ArrowRight width={12} height={12} className="self-center text-muted-foreground" />
          <span className="text-title font-semibold text-foreground">{formatChartValue(metric.after, metric.unit)}</span>
        </span>
        <span className="flex items-center justify-between">
          <span className="rounded-full px-1.5 text-[11px] font-semibold tabular-nums" style={{ color: tone, background: tint(tone === 'var(--muted-foreground)' ? null : tone, 14) }}>
            {change === null ? 'new' : `${change > 0 ? '+' : ''}${change.toFixed(change > -10 && change < 10 ? 1 : 0)}%`}
          </span>
          {metric.trend?.length ? <Sparkline values={metric.trend} tone={tone} /> : null}
        </span>
      </div>;
    })}
  </div>;
}

// ── LogTable ──

const LEVEL: Record<Props<'LogTable'>['lines'][number]['level'], string> = { debug: 'var(--muted-foreground)', info: badgeColors.blue, warn: badgeColors.amber, error: badgeColors.red };

export function LogTableView({ title, lines }: Props<'LogTable'>) {
  const [all, setAll] = useState(false);
  const highlighted = lines.some(line => line.highlight);
  // Around the lines that matter, quiet lines fold away until asked for.
  const shown = all || !highlighted ? lines : lines.filter((line, index) => line.highlight || line.level === 'error' || lines[index - 1]?.highlight || lines[index + 1]?.highlight);
  return <figure className="overflow-hidden rounded-lg bg-surface-1 shadow-surface-1">
    {title ? <figcaption className="border-b border-border px-3 py-1.5 text-caption text-muted-foreground">{title}</figcaption> : null}
    <div className="overflow-x-auto font-mono text-[11.5px] leading-[20px]">
      {shown.map((line, index) => <div key={index} className="flex min-w-max items-start gap-2 pr-3" style={{ background: line.highlight ? tint(LEVEL[line.level], 12) : undefined, boxShadow: `inset 3px 0 0 ${LEVEL[line.level]}` }}>
        <span className="shrink-0 whitespace-nowrap pl-3 text-muted-foreground">{line.at ?? ''}</span>
        <span className="w-10 shrink-0 font-semibold uppercase" style={{ color: LEVEL[line.level] }}>{line.level}</span>
        {line.source ? <span className="shrink-0 text-muted-foreground">{line.source}</span> : null}
        <span className={`whitespace-pre-wrap ${line.highlight ? 'font-semibold text-foreground' : 'text-foreground/85'}`}>{line.text}</span>
        {line.repeat ? <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[10.5px] text-muted-foreground">×{line.repeat}</span> : null}
      </div>)}
    </div>
    {shown.length < lines.length ? <button type="button" className="flex w-full items-center justify-center gap-1 border-t border-border py-1 text-caption text-muted-foreground hover:text-foreground" onClick={() => setAll(true)}>
      <ChevronDown width={13} height={13} />{lines.length - shown.length} quieter lines
    </button> : null}
  </figure>;
}

// ── Timeline ──

const EVENT: Record<Props<'Timeline'>['events'][number]['kind'], { tone: string; shape: 'diamond' | 'dot' | 'triangle' | 'check' | 'ring' }> = {
  deploy: { tone: badgeColors.violet, shape: 'diamond' },
  error: { tone: badgeColors.red, shape: 'dot' },
  alert: { tone: badgeColors.amber, shape: 'triangle' },
  fix: { tone: badgeColors.green, shape: 'check' },
  note: { tone: 'var(--muted-foreground)', shape: 'ring' },
};

function EventMark({ kind }: { kind: Props<'Timeline'>['events'][number]['kind'] }) {
  const { tone, shape } = EVENT[kind];
  if (shape === 'diamond') return <span className="size-2.5 rotate-45 rounded-[2px]" style={{ background: tone }} />;
  if (shape === 'triangle') return <span className="size-0 border-x-[6px] border-b-[10px] border-x-transparent" style={{ borderBottomColor: tone }} />;
  if (shape === 'check') return <span className="flex size-3.5 items-center justify-center rounded-full" style={{ background: tone }}><Check width={9} height={9} strokeWidth={3.5} className="text-white" /></span>;
  if (shape === 'ring') return <span className="size-2.5 rounded-full border-2" style={{ borderColor: tone }} />;
  return <span className="size-3 rounded-full" style={{ background: tone, boxShadow: `0 0 0 3px ${tint(tone, 25)}` }} />;
}

export function TimelineView({ title, events }: Props<'Timeline'>) {
  const ordered = useMemo(() => [...events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at)), [events]);
  const [selected, setSelected] = useState(() => Math.max(0, ordered.findIndex(event => event.kind === 'error')));
  const start = Date.parse(ordered[0]?.at ?? ''), end = Date.parse(ordered.at(-1)?.at ?? '');
  const span = end - start || 1;
  const time = (at: string) => new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const current = ordered[selected];
  return <figure className="flex flex-col gap-2 rounded-lg bg-surface-1 p-3 shadow-surface-1">
    {title ? <figcaption className="text-caption text-muted-foreground">{title}</figcaption> : null}
    <div className="relative mx-2 mt-7 h-10">
      <div className="absolute inset-x-0 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-border" />
      {ordered.map((event, index) => {
        const left = `${((Date.parse(event.at) - start) / span) * 100}%`;
        return <Tooltip key={index} content={`${time(event.at)} · ${event.label}`} side="top">
          <button type="button" aria-label={`${event.kind}: ${event.label}`} className={`absolute top-1/2 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full ${index === selected ? 'bg-surface-3 ring-1 ring-border' : ''}`} style={{ left }} onClick={() => setSelected(index)}>
            <EventMark kind={event.kind} />
          </button>
        </Tooltip>;
      })}
      {current ? <span className="pointer-events-none absolute -top-6 -translate-x-1/2 whitespace-nowrap rounded-full px-2 text-[11px] font-medium" style={{ left: `${((Date.parse(current.at) - start) / span) * 100}%`, color: EVENT[current.kind].tone, background: tint(EVENT[current.kind].tone, 14) }}>{current.label}</span> : null}
    </div>
    <div className="flex justify-between text-[10.5px] tabular-nums text-muted-foreground"><span>{time(ordered[0]?.at ?? '')}</span><span>{time(ordered.at(-1)?.at ?? '')}</span></div>
    {current?.detail ? <p className="text-caption text-foreground/85"><span className="font-semibold tabular-nums">{time(current.at)}</span> · {current.detail}</p> : null}
  </figure>;
}

// ── Tradeoffs ──

const SCORE = [badgeColors.red, badgeColors.amber, badgeColors.lime, badgeColors.green];

export function TradeoffsView({ question, options, criteria, recommended, note }: Props<'Tradeoffs'>) {
  const { execute } = useActions();
  const [picked, setPicked] = useState<string | null>(null);
  const totals = options.map((_, column) => criteria.reduce((sum, criterion) => sum + (criterion.scores[column] ?? 0), 0));
  return <figure className="flex flex-col gap-2 overflow-x-auto rounded-lg bg-surface-1 p-3 shadow-surface-1">
    <figcaption className="text-body font-semibold text-foreground">{question}</figcaption>
    <table className="border-separate border-spacing-1 text-caption">
      <thead><tr><th />{options.map(option => <th key={option.id} className="px-1 pb-1 text-center align-bottom font-semibold text-foreground">
        {option.id === recommended ? <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide" style={{ color: badgeColors.blue }}>recommended</span> : null}{option.label}
      </th>)}</tr></thead>
      <tbody>
        {criteria.map((criterion, row) => <tr key={row}>
          <td className="pr-2 text-muted-foreground">{criterion.note ? <Tooltip content={criterion.note} side="top"><span className="underline decoration-dotted underline-offset-2">{criterion.label}</span></Tooltip> : criterion.label}</td>
          {options.map((option, column) => {
            const score = criterion.scores[column] ?? 0;
            return <td key={option.id} className="h-7 min-w-20 rounded-md text-center" style={{ background: tint(SCORE[score] ?? null, 22), boxShadow: option.id === recommended ? `inset 0 0 0 1.5px ${tint(badgeColors.blue, 60)}` : undefined }}>
              <span className="inline-flex gap-0.5" aria-label={`${score} of 3`}>{[0, 1, 2].map(dot => <span key={dot} className="size-1.5 rounded-full" style={{ background: dot < score ? SCORE[score] : 'var(--border)' }} />)}</span>
            </td>;
          })}
        </tr>)}
        <tr><td />{options.map((option, column) => <td key={option.id} className="pt-1 text-center">
          <Button size="compact" variant={picked === option.id ? 'primary' : option.id === recommended ? 'secondary' : 'ghost'} onClick={() => {
            setPicked(option.id);
            void execute({ action: 'stage', params: { kind: 'decision', key: 'tradeoff', label: option.label, detail: question, payload: { option: option.id, score: totals[column] } } });
          }}>{picked === option.id ? 'Picked' : 'Pick'}</Button>
        </td>)}</tr>
      </tbody>
    </table>
    {note ? <p className="text-caption text-muted-foreground">{note}</p> : null}
  </figure>;
}

// ── CheckGrid ──

const CELL: Record<Props<'CheckGrid'>['rows'][number]['cells'][number], { tone: string; label: string }> = {
  pass: { tone: badgeColors.green, label: 'passed' }, fail: { tone: badgeColors.red, label: 'failed' }, running: { tone: badgeColors.amber, label: 'running' },
  skip: { tone: 'var(--muted-foreground)', label: 'skipped' }, none: { tone: 'var(--border)', label: 'not run' },
};

export function CheckGridView({ title, columns, rows }: Props<'CheckGrid'>) {
  return <figure className="flex flex-col gap-2 overflow-x-auto rounded-lg bg-surface-1 p-3 shadow-surface-1">
    {title ? <figcaption className="text-caption text-muted-foreground">{title}</figcaption> : null}
    <table className="border-separate border-spacing-[3px] text-caption">
      <thead><tr><th />{columns.map(column => <th key={column} className="px-1 text-center text-[11px] font-medium text-muted-foreground">{column}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>
        <td className="whitespace-nowrap pr-3 text-foreground">{row.label}</td>
        {columns.map((column, cell) => {
          const state = CELL[row.cells[cell] ?? 'none'];
          return <td key={column} className="p-0"><Tooltip content={`${row.label} · ${column}: ${state.label}`} side="top">
            <span className={`block h-5 min-w-9 rounded ${row.cells[cell] === 'running' ? 'animate-pulse motion-reduce:animate-none' : ''}`} style={{ background: row.cells[cell] === 'none' ? 'var(--surface-3)' : tint(state.tone, row.cells[cell] === 'skip' ? 25 : 70) }} />
          </Tooltip></td>;
        })}
      </tr>)}</tbody>
    </table>
  </figure>;
}

// ── SchemaDiff ──

const COST: Record<NonNullable<Props<'SchemaDiff'>['tables'][number]['cost']>, { label: string; tone: string } | null> = {
  none: null,
  lock: { label: 'locks the table', tone: badgeColors.amber },
  rewrite: { label: 'rewrites every row', tone: badgeColors.red },
  backfill: { label: 'backfills rows', tone: badgeColors.amber },
};
/** The changes the summary line counts, in its order. */
const SUMMARIZED: readonly Exclude<Change, 'same'>[] = ['added', 'changed', 'removed'];

function Marker({ change }: { change: Change }) {
  return <span className="w-3 shrink-0 text-center font-semibold" style={{ color: CHANGE[change] ?? undefined }}>{change === 'added' ? '+' : change === 'removed' ? '−' : change === 'changed' ? '~' : ''}</span>;
}

export function SchemaDiffView({ title, tables }: Props<'SchemaDiff'>) {
  const frame = useRef<HTMLDivElement>(null);
  const rows = useRef(new Map<string, HTMLElement>());
  const [links, setLinks] = useState<{ from: string; d: string; tone: string }[]>([]);
  const [focus, setFocus] = useState<string | null>(null);
  // Foreign keys drawn as curves from the column to the column it references, measured after layout and on resize.
  useLayoutEffect(() => {
    const measure = () => {
      const origin = frame.current?.getBoundingClientRect();
      if (!origin) return;
      const next: typeof links = [];
      for (const table of tables) for (const column of table.columns) {
        if (!column.references) continue;
        const from = rows.current.get(`${table.name}.${column.name}`)?.getBoundingClientRect();
        const to = rows.current.get(column.references)?.getBoundingClientRect();
        if (!from || !to) continue;
        // Tables in one column link along their right edges, bowed out past them; across columns, edge to facing edge.
        const sameColumn = Math.abs(to.left - from.left) < from.width / 2;
        const rightward = !sameColumn && to.left > from.left;
        const x1 = (sameColumn || rightward ? from.right : from.left) - origin.left, y1 = from.top + from.height / 2 - origin.top;
        const x2 = (sameColumn || !rightward ? to.right : to.left) - origin.left, y2 = to.top + to.height / 2 - origin.top;
        const d = sameColumn
          ? `M${x1},${y1} C${x1 + 28},${y1} ${x2 + 28},${y2} ${x2},${y2}`
          : `M${x1},${y1} C${x1 + (rightward ? 1 : -1) * Math.max(24, Math.abs(x2 - x1) / 2)},${y1} ${x2 - (rightward ? 1 : -1) * Math.max(24, Math.abs(x2 - x1) / 2)},${y2} ${x2},${y2}`;
        next.push({ from: `${table.name}.${column.name}`, d, tone: CHANGE[column.change] ?? 'var(--muted-foreground)' });
      }
      setLinks(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    if (frame.current) observer.observe(frame.current);
    return () => observer.disconnect();
  }, [tables]);
  const summary = [
    ...SUMMARIZED.flatMap((change) => { const count = tables.filter((table) => table.change === change).length; return count ? [{ text: `${count} table${count === 1 ? '' : 's'} ${change}`, tone: CHANGE[change] }] : []; }),
    ...SUMMARIZED.flatMap((change) => {
      const count = tables.reduce((sum, table) => sum + table.columns.filter((column) => column.change === change).length, 0);
      return count ? [{ text: `${change === 'added' ? '+' : change === 'removed' ? '−' : '~'}${count} column${count === 1 ? '' : 's'}`, tone: CHANGE[change] }] : [];
    }),
  ];
  return <figure className="flex flex-col gap-2">
    <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption">
      {title ? <span className="text-muted-foreground">{title}</span> : null}
      {summary.map((item) => <span key={item.text} className="font-medium tabular-nums" style={{ color: item.tone ?? undefined }}>{item.text}</span>)}
    </figcaption>
    <div ref={frame} className="relative grid grid-cols-[repeat(auto-fit,minmax(15rem,1fr))] gap-x-10 gap-y-3">
      <svg className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible" aria-hidden>
        <defs><marker id="schema-fk" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><circle cx="4" cy="4" r="3" fill="var(--muted-foreground)" /></marker></defs>
        {links.map((link) => <path key={link.from} d={link.d} fill="none" stroke={link.tone} strokeWidth={focus === link.from ? 2.25 : 1.5} strokeDasharray={focus && focus !== link.from ? '3 4' : undefined} opacity={focus && focus !== link.from ? 0.35 : 0.9} markerEnd="url(#schema-fk)" />)}
      </svg>
      {tables.map((table) => {
        const tone = CHANGE[table.change];
        const cost = table.cost ? COST[table.cost] : null;
        return <div key={table.name} className={`flex flex-col self-start overflow-hidden rounded-lg bg-surface-1 font-mono text-[12px] ${table.change === 'removed' ? 'opacity-70' : ''}`}
          style={{ boxShadow: `inset 0 3px 0 0 ${tone ?? 'var(--border)'}, 0 1px 2px rgb(0 0 0 / 0.08), 0 0 0 1px var(--border)` }}>
          <div className="flex flex-col gap-0.5 border-b border-border px-3 py-1.5">
            <span className="flex items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-1.5">
                {table.renamedFrom ? <span className="text-muted-foreground line-through">{table.renamedFrom}</span> : null}
                {table.renamedFrom ? <span className="text-muted-foreground">→</span> : null}
                <span className={`font-semibold text-foreground ${table.change === 'removed' ? 'line-through' : ''}`}>{table.name}</span>
              </span>
              <span className="shrink-0 font-sans text-[11px] text-muted-foreground">{table.rows ?? ''}{table.change !== 'same' ? <span className="font-medium" style={{ color: tone ?? undefined }}> · {table.change}</span> : null}</span>
            </span>
            {cost ? <span className="w-fit rounded-full px-1.5 font-sans text-[10.5px] font-medium" style={{ color: cost.tone, background: tint(cost.tone, 14) }}>⚠ {cost.label}{table.rows ? ` · ${table.rows}` : ''}</span> : null}
          </div>
          {table.columns.map((column) => {
            const id = `${table.name}.${column.name}`;
            return <div key={column.name} ref={(element) => { if (element) rows.current.set(id, element); else rows.current.delete(id); }}
              className="flex items-center gap-1.5 px-2 py-[3px]" style={{ background: tint(CHANGE[column.change], 12) }} title={column.note ?? undefined}
              onMouseEnter={() => setFocus(column.references ? id : null)} onMouseLeave={() => setFocus(null)}>
              <Marker change={column.change} />
              {column.key ? <span className="rounded px-1 font-sans text-[9.5px] font-semibold" style={{ color: badgeColors.amber, background: tint(badgeColors.amber, 16) }}>{column.key === 'primary' ? 'PK' : 'UQ'}</span> : null}
              {column.renamedFrom ? <><span className="text-muted-foreground line-through">{column.renamedFrom}</span><span className="text-muted-foreground">→</span></> : null}
              <span className={`text-foreground ${column.change === 'removed' ? 'line-through opacity-70' : ''} ${column.note ? 'underline decoration-dotted decoration-muted-foreground/60 underline-offset-2' : ''}`}>{column.name}</span>
              {column.references ? <span className="truncate font-sans text-[10.5px]" style={{ color: badgeColors.violet }}>→ {column.references}</span> : null}
              <span className="ml-auto flex shrink-0 items-baseline gap-1">
                {column.typeFrom ? <><span className="text-muted-foreground line-through">{column.typeFrom}</span><span className="text-muted-foreground">→</span></> : null}
                <span style={{ color: column.typeFrom ? badgeColors.amber : 'var(--muted-foreground)' }}>{column.type}{column.nullable ? '?' : ''}</span>
              </span>
            </div>;
          })}
          {table.indexes?.length ? <div className="flex flex-col border-t border-dashed border-border py-0.5">
            {table.indexes.map((index) => <div key={index.name} className="flex items-center gap-1.5 px-2 py-[2px] text-[11px]" style={{ background: tint(CHANGE[index.change], 10) }}>
              <Marker change={index.change} />
              <span className={`text-muted-foreground ${index.change === 'removed' ? 'line-through' : ''}`}>{index.unique ? 'unique ' : ''}index</span>
              <span className={`truncate text-foreground/85 ${index.change === 'removed' ? 'line-through' : ''}`}>({index.columns.join(', ')})</span>
            </div>)}
          </div> : null}
        </div>;
      })}
    </div>
  </figure>;
}

// ── WorkspaceGraph ──

export function WorkspaceGraphView({ workspaces }: Props<'WorkspaceGraph'>) {
  // Layer by longest dependency chain: a workspace sits one column right of everything it depends on.
  const layers = useMemo(() => {
    const byId = new Map(workspaces.map(item => [item.workspace, item]));
    const depth = new Map<string, number>();
    const visit = (id: string, seen: ReadonlySet<string>): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      const parents = (byId.get(id)?.dependsOn ?? []).filter(parent => byId.has(parent) && !seen.has(parent));
      const value = parents.length ? Math.max(...parents.map(parent => visit(parent, new Set([...seen, id])))) + 1 : 0;
      depth.set(id, value);
      return value;
    };
    const columns: (typeof workspaces)[] = [];
    for (const item of workspaces) (columns[visit(item.workspace, new Set())] ??= []).push(item);
    return columns;
  }, [workspaces]);
  return <div className="flex items-stretch gap-2 overflow-x-auto rounded-lg bg-surface-1 p-3 shadow-surface-1">
    {layers.map((column, index) => <div key={index} className="flex items-center gap-2">
      {index > 0 ? <ArrowRight width={16} height={16} className="shrink-0 text-muted-foreground" /> : null}
      <div className="flex flex-col justify-center gap-2">
        {column.map(item => <div key={item.workspace} className="flex flex-col gap-0.5">
          <RefChip reference={{ workspace: item.workspace }} />
          {item.note ? <span className="max-w-48 pl-1 text-[11px] leading-snug text-muted-foreground">{item.note}</span> : null}
        </div>)}
      </div>
    </div>)}
  </div>;
}

// ── Rank ──

export function RankView({ question, items }: Props<'Rank'>) {
  const { execute } = useActions();
  const [order, setOrder] = useState(() => items.map(item => item.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const labels: Record<string, string> = Object.fromEntries(items.map(item => [item.id, item.label]));
  return <figure className="flex flex-col gap-2 rounded-lg bg-surface-1 p-3 shadow-surface-1">
    <figcaption className="text-body font-semibold text-foreground">{question}</figcaption>
    <ol className="flex flex-col gap-1">
      {order.map((id, index) => <li key={id} draggable onDragStart={() => setDragging(id)} onDragEnd={() => setDragging(null)}
        onDragOver={event => {
          event.preventDefault();
          if (!dragging || dragging === id) return;
          setOrder(current => { const next = current.filter(item => item !== dragging); next.splice(index, 0, dragging); return next; });
        }}
        className={`flex cursor-grab items-center gap-2 rounded-md bg-background px-2 py-1.5 text-caption shadow-[inset_0_0_0_1px_var(--border)] transition-transform active:cursor-grabbing ${dragging === id ? 'scale-[1.02] opacity-70' : ''}`}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold tabular-nums text-white" style={{ background: `color-mix(in oklab, ${badgeColors.blue} ${100 - index * (60 / Math.max(1, order.length - 1))}%, var(--muted-foreground))` }}>{index + 1}</span>
        <span className="flex-1 text-foreground">{labels[id] ?? id}</span>
        <span className="text-muted-foreground" aria-hidden>⋮⋮</span>
      </li>)}
    </ol>
    <div><Button size="compact" variant="secondary" onClick={() => void execute({ action: 'stage', params: { kind: 'decision', key: 'rank', label: order.map(id => labels[id] ?? id).join(' › '), detail: question, payload: { order } } })}>Use this order</Button></div>
  </figure>;
}

// ── Budget ──

export function BudgetView({ label, unit, limit, days }: Props<'Budget'>) {
  const used = days.reduce((sum, day) => sum + day.used, 0);
  const pace = limit / days.length;
  const tallest = Math.max(pace, ...days.map(day => day.used));
  const share = Math.min(1, used / limit);
  const tone = share >= 1 ? badgeColors.red : share > 0.8 ? badgeColors.amber : badgeColors.green;
  const ring: CSSProperties = { background: `conic-gradient(${tone} ${share * 360}deg, var(--surface-3) 0)` };
  return <figure className="flex items-center gap-4 rounded-lg bg-surface-1 p-3 shadow-surface-1">
    <div className="relative size-20 shrink-0 rounded-full" style={ring}>
      <div className="absolute inset-[7px] flex flex-col items-center justify-center rounded-full bg-surface-1">
        <span className="text-body font-semibold tabular-nums text-foreground">{Math.round(share * 100)}%</span>
        <span className="text-[10px] text-muted-foreground">used</span>
      </div>
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-caption text-muted-foreground">{label} · <span className="font-semibold text-foreground tabular-nums">{formatChartValue(used, unit)}</span> of {formatChartValue(limit, unit)} · {formatChartValue(Math.max(0, limit - used), unit)} left</span>
      <div className="relative flex h-12 items-end gap-[3px]">
        <div className="absolute inset-x-0 border-t border-dashed border-muted-foreground/50" style={{ bottom: `${(pace / tallest) * 100}%` }} title="Daily pace" />
        {days.map(day => <Tooltip key={day.day} content={`${day.day}: ${formatChartValue(day.used, unit)}`} side="top">
          <span className="flex-1 rounded-t-sm" style={{ height: `${Math.max(4, (day.used / tallest) * 100)}%`, background: day.used > pace ? badgeColors.amber : tint(badgeColors.blue, 70) }} />
        </Tooltip>)}
      </div>
    </div>
  </figure>;
}
