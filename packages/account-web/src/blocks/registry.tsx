// The components a gitspace-ui block may use, drawn with @gitspace/ui, and the `$computed` functions. The json-render
// catalog is the protocol catalog's components with their zod props, so a renderer receives the props GitSpace
// validated when it stored the block.
import { gitspaceUiCatalog } from '@gitspace/protocol/gitspace-ui';
import {
  AskUserQuestions, Badge, Button, Card, CardContent, CardDescription, CardEyebrow, CardFooter, CardHeader, CardTitle, CheckboxGroup, CheckboxItem,
  InputField, InputGroup, RadioGroup, RadioItem, Slider, StatTile, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, TabsSubtle,
  TabsSubtleItem, Tooltip, badgeColors, useShape,
} from '@gitspace/ui';
import { defineCatalog, type ComputedFunction } from '@json-render/core';
import { useBoundProp, type Components } from '@json-render/react';
import { schema } from '@json-render/react/schema';
import { FileDiff, parsePatchFiles } from '@pierre/diffs';
import { ArrowRight, PauseCircle, PlayCircle } from '@untitledui/icons';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { useBlockActions } from './BlockActions.js';
import { SvgBlock } from './SvgBlock.js';

/** The protocol catalog as a json-render catalog: its components' zod props type the renderers, its actions the handlers. */
export const blockCatalog = defineCatalog(schema, gitspaceUiCatalog);

const GAPS = { sm: 'gap-1.5', md: 'gap-3', lg: 'gap-5' };
const JUSTIFY = { start: 'justify-start', between: 'justify-between', end: 'justify-end' };
const TEXT_SIZES = { title: 'text-title font-semibold', body: 'text-body', caption: 'text-caption' };
const TONES: Record<'default' | 'muted' | 'good' | 'bad', CSSProperties> = {
  default: {},
  muted: { color: 'var(--muted-foreground)' },
  good: { color: badgeColors.green },
  bad: { color: badgeColors.red },
};

/** Text with `code` spans. */
function InlineText({ text }: { text: string }): ReactNode {
  return text.split(/(`[^`]+`)/u).map((part, index) => part.startsWith('`') && part.endsWith('`') && part.length > 1
    ? <code key={index} className="rounded bg-surface-3 px-1 font-mono text-[0.92em]">{part.slice(1, -1)}</code>
    : part);
}

function formatValue(value: number, unit: 'ms' | 'seconds' | 'count' | 'percent'): string {
  if (unit === 'ms') return `${(value / 1000).toFixed(1)} s`;
  if (unit === 'seconds') return `${value.toFixed(1)} s`;
  if (unit === 'percent') return `${value}%`;
  return value.toLocaleString('en-US');
}

/** Reports a Checklist row's ticked state by row index, for CheckboxGroup's merged highlight. */
const ChecklistContext = createContext<((index: number, checked: boolean) => void) | null>(null);

function ChecklistGroup({ title, children }: { title: string | null; children: ReactNode }) {
  const [checked, setChecked] = useState<ReadonlySet<number>>(new Set());
  const report = useCallback((index: number, isChecked: boolean) => setChecked((current) => {
    if (current.has(index) === isChecked) return current;
    const next = new Set(current);
    if (isChecked) next.add(index);
    else next.delete(index);
    return next;
  }), []);
  return <div className="flex flex-col gap-1">
    {title ? <span className="text-caption font-medium text-muted-foreground">{title}</span> : null}
    <ChecklistContext.Provider value={report}><CheckboxGroup className="w-full" checkedIndices={new Set(checked)}>{children}</CheckboxGroup></ChecklistContext.Provider>
  </div>;
}

function ChecklistRow({ index, label, note, checked, bindingPath, onChanged }: { index: number; label: string; note: string | null; checked: boolean; bindingPath: string | undefined; onChanged: () => void }) {
  const report = useContext(ChecklistContext);
  const [value, setValue] = useBoundProp<boolean>(checked, bindingPath);
  const previous = useRef(checked);
  useEffect(() => { report?.(index, checked); }, [report, index, checked]);
  // "change" fires once the new value has rendered, so the action's params read the row as ticked or unticked.
  useEffect(() => {
    if (previous.current === checked) return;
    previous.current = checked;
    onChanged();
  }, [checked, onChanged]);
  return <div className="flex items-center gap-2">
    <CheckboxItem className="min-w-0 flex-1" index={index} label={label} checked={value ?? false} onToggle={() => setValue(!(value ?? false))} />
    {note ? <span className="shrink-0 pr-2 text-caption text-muted-foreground">{note}</span> : null}
  </div>;
}

interface Step { title: string; detail: string; where?: string | null }

function StepsView({ steps, active, play, intervalMs, onActive }: { steps: readonly Step[]; active: number; play: boolean; intervalMs: number; onActive: (index: number) => void }) {
  const shape = useShape();
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      if (active + 1 >= steps.length) setPlaying(false);
      else onActive(active + 1);
    }, intervalMs);
    return () => clearTimeout(timer);
  }, [playing, active, steps.length, intervalMs, onActive]);
  const toggle = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (active + 1 >= steps.length) onActive(0);
    setPlaying(true);
  };
  const current = steps[active];
  return <div className="flex flex-col gap-3">
    <ol className="flex flex-wrap items-center gap-1">
      {steps.map((step, index) => <li key={`${index}:${step.title}`} className="flex items-center gap-1">
        {index > 0 ? <ArrowRight width={12} height={12} className="text-muted-foreground" /> : null}
        <button type="button" aria-current={index === active ? 'step' : undefined} onClick={() => { setPlaying(false); onActive(index); }}
          className={`border px-2 py-1 font-mono text-[11.5px] transition-colors ${shape.item} ${index === active ? 'border-transparent text-white' : index < active ? 'border-border bg-surface-2 text-foreground' : 'border-border text-muted-foreground'}`}
          style={index === active ? { background: badgeColors.blue } : undefined}>{step.title}</button>
      </li>)}
    </ol>
    {current ? <div className={`flex flex-col gap-1 border border-border bg-surface-2 p-3 ${shape.container}`}>
      <span className="text-caption text-muted-foreground">Step {active + 1} of {steps.length}</span>
      <span className="text-body"><InlineText text={current.detail} /></span>
      {current.where ? <span className="font-mono text-[11px] text-muted-foreground">{current.where}</span> : null}
    </div> : null}
    {play ? <div className="flex items-center gap-2">
      <Button variant="secondary" size="compact" onClick={toggle}>{playing ? <PauseCircle width={14} height={14} /> : <PlayCircle width={14} height={14} />}{playing ? 'Pause' : 'Play'}</Button>
      <span className="text-caption text-muted-foreground">{playing ? 'Stepping through the path' : 'Click a step, or play the path'}</span>
    </div> : null}
  </div>;
}

function DiffView({ patch, title }: { patch: string; title: string | null }) {
  const shape = useShape();
  const host = useRef<HTMLDivElement>(null);
  const fileDiff = useMemo(() => parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0] ?? null, [patch]);
  useEffect(() => {
    const element = host.current;
    if (!element || !fileDiff) return;
    // Both themes render as light-dark() colours; the host below inherits the page's color-scheme to pick one.
    const instance = new FileDiff({ diffStyle: 'unified', theme: { light: 'github-light', dark: 'github-dark' }, themeType: 'system', disableFileHeader: true, hunkSeparators: 'line-info', overflow: 'scroll' });
    instance.render({ fileDiff, containerWrapper: element });
    return () => instance.cleanUp();
  }, [fileDiff]);
  return <div className={`flex flex-col overflow-hidden border border-border ${shape.container}`}>
    {title || fileDiff ? <span className="border-b border-border bg-surface-2 px-3 py-1.5 font-mono text-[11.5px] text-muted-foreground">{title ?? fileDiff?.name}</span> : null}
    {/* FLUID-GAP: diff viewer — @pierre/diffs renders the patch with its own theme, as the Inspector does. */}
    {/* The diff's shadow host sets `color-scheme: light dark` (the OS's); the page's own scheme overrides it here. */}
    {fileDiff ? <div ref={host} className="max-h-[320px] overflow-auto bg-surface-3 [&>*]:[color-scheme:inherit]" />
      : <pre className="overflow-auto bg-surface-3 p-3 font-mono text-[11.5px]">{patch}</pre>}
  </div>;
}

interface Pane { label: string; title?: string | null; body: string }

function PaneView({ pane, after }: { pane: Pane; after: boolean }) {
  const shape = useShape();
  return <div className={`flex h-full min-w-[12rem] flex-col gap-1.5 border border-border bg-surface-1 p-3 ${shape.container}`}>
    <span className="flex items-center gap-1.5"><Badge size="compact" variant="dot" color={after ? 'green' : 'gray'}>{pane.label}</Badge>{pane.title ? <span className="text-body font-medium">{pane.title}</span> : null}</span>
    <div className="text-body"><GitSpaceMarkdown>{pane.body}</GitSpaceMarkdown></div>
  </div>;
}

function BeforeAfterView({ before, after, slider }: { before: Pane; after: Pane; slider: boolean }) {
  const [split, setSplit] = useState(50);
  if (!slider) return <div className="grid gap-2 sm:grid-cols-2"><PaneView pane={before} after={false} /><PaneView pane={after} after /></div>;
  // The slider moves the divider: each pane gets its share of the width and reflows; a pane under 8% is hidden.
  return <div className="flex flex-col gap-2">
    <div className="flex gap-2">
      {split >= 8 ? <div className="min-w-0 overflow-hidden" style={{ flex: `${split} 1 0` }}><PaneView pane={before} after={false} /></div> : null}
      {split <= 92 ? <div className="min-w-0 overflow-hidden" style={{ flex: `${100 - split} 1 0` }}><PaneView pane={after} after /></div> : null}
    </div>
    <Slider size="compact" label={`${before.label} ← → ${after.label}`} value={split} min={0} max={100} step={1} showValue={false} onChange={(value) => { if (typeof value === 'number') setSplit(value); }} />
  </div>;
}

interface AskOption { value: string; label: string; description?: string | null }

function AskCardView({ questionId, question, prompt, options, value, staged, sent, answered, onPick }: { questionId: string; question: string; prompt: string; options: readonly AskOption[]; value: string; staged: string | null; sent: string | null; answered: string | null; onPick: (value: string) => void }) {
  const shape = useShape();
  const canAnswer = useBlockActions() !== null;
  const done = sent ?? answered ?? staged;
  if (done) {
    const status = sent ? 'sent with your message · the agent continues' : answered ? 'answered · the agent continues' : 'staged · in your message';
    return <div className={`flex flex-col gap-1.5 border border-border bg-surface-2 px-3 py-2.5 ${shape.container}`}>
      <span className="text-caption text-muted-foreground">{question}</span>
      <span className="flex flex-wrap items-center gap-2 text-body font-medium">{options.find((option) => option.value === value)?.label ?? done}<Badge size="compact" variant="dot" color={staged && !sent && !answered ? 'amber' : 'green'}>{status}</Badge></span>
    </div>;
  }
  return <div className="flex flex-col gap-1.5">
    {/* FLUID-GAP: AskUserQuestions submits a single-choice question when a row is picked; it has no button to relabel. */}
    <AskUserQuestions
      questions={[{ id: questionId, title: prompt, layout: 'stacked', options: options.map((option) => ({ id: option.value, title: option.label, description: option.description ?? undefined })) }]}
      renderTitle={(title) => <div className="max-h-80 overflow-y-auto"><GitSpaceMarkdown>{title}</GitSpaceMarkdown></div>}
      onComplete={(answers) => { const picked = answers[questionId]?.selectedIds[0]; if (picked) onPick(picked); }}
    />
    <span className="px-1 text-caption text-muted-foreground">{canAnswer ? 'Picking an answer puts it in your message bar; it goes with what you write.' : 'Answering is not available here.'}</span>
  </div>;
}

export const BLOCK_COMPONENTS: Components<typeof blockCatalog> = {
  Card: ({ props, children, slots }) => <Card>
    {props.title || props.description || props.eyebrow ? <CardHeader>
      {props.eyebrow ? <CardEyebrow>{props.eyebrow}</CardEyebrow> : null}
      {props.title ? <CardTitle>{props.title}</CardTitle> : null}
      {props.description ? <CardDescription>{props.description}</CardDescription> : null}
    </CardHeader> : null}
    <CardContent><div className="flex flex-col gap-3">{children}</div></CardContent>
    {slots?.footer ? <CardFooter>{slots.footer}</CardFooter> : null}
  </Card>,
  Stack: ({ props, children }) => <div className={`flex flex-col ${GAPS[props.gap ?? 'md']}`}>{children}</div>,
  Row: ({ props, children }) => <div className={`flex items-center ${GAPS[props.gap ?? 'sm']} ${JUSTIFY[props.justify ?? 'start']} ${props.wrap === false ? '' : 'flex-wrap'}`}>{children}</div>,
  Text: ({ props }) => <p className={`${TEXT_SIZES[props.size ?? 'body']} ${props.mono ? 'font-mono' : ''}`} style={TONES[props.tone ?? 'default']}><InlineText text={props.text} /></p>,
  Markdown: ({ props }) => <div className="text-body"><GitSpaceMarkdown>{props.content}</GitSpaceMarkdown></div>,
  // The span keeps the badge as wide as its label inside a column.
  Badge: ({ props }) => <span className="w-fit"><Badge size="compact" color={props.color ?? 'gray'} variant={props.variant ?? 'solid'}>{props.label}</Badge></span>,
  Table: ({ props }) => <div className="flex flex-col gap-1 overflow-x-auto">
    <Table size="compact">
      <TableHeader><TableRow>{props.columns.map((column) => <TableHead key={column.key} className={column.align === 'right' ? 'text-right' : undefined}><InlineText text={column.label} /></TableHead>)}</TableRow></TableHeader>
      <TableBody>{props.rows.map((row, index) => <TableRow key={index} index={index}>{props.columns.map((column) => {
        const value = row[column.key];
        return <TableCell key={column.key} className={`${column.align === 'right' ? 'text-right' : ''} ${column.mono ? 'font-mono tabular-nums' : ''}`}>{typeof value === 'number' ? value.toLocaleString('en-US') : <InlineText text={value ?? ''} />}</TableCell>;
      })}</TableRow>)}</TableBody>
    </Table>
    {props.caption ? <span className="text-caption text-muted-foreground">{props.caption}</span> : null}
  </div>,
  Stats: ({ props }) => <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-2">
    {props.tiles.map((tile, index) => <StatTile key={`${index}:${tile.label}`} label={tile.label} value={tile.value} detail={tile.detail ?? undefined} tone={tile.tone ?? 'neutral'} />)}
  </div>,
  Chart: ({ props }) => {
    const values = props.rows.flatMap((row) => props.series.map((series) => row.values[series.key] ?? 0));
    const max = props.max ?? Math.max(1, ...values) * 1.15;
    const barHeight = 12;
    const groupHeight = props.series.length * (barHeight + 3) + 10;
    const width = 640;
    const labelWidth = 230;
    const track = width - labelWidth - 70;
    return <figure className="flex flex-col gap-2">
      {props.title ? <figcaption className="text-caption font-medium text-muted-foreground">{props.title}</figcaption> : null}
      <svg viewBox={`0 0 ${width} ${props.rows.length * groupHeight}`} className="w-full" role="img" aria-label={props.title ?? 'Bar chart'}>
        {props.rows.map((row, rowIndex) => {
          const top = rowIndex * groupHeight;
          return <g key={`${rowIndex}:${row.label}`}>
            <text x={0} y={top + groupHeight / 2} dominantBaseline="middle" style={{ font: '12px var(--font-sans, system-ui)', fill: 'var(--foreground)' }}>{row.label}</text>
            <rect x={labelWidth} y={top + 2} width={track} height={groupHeight - 8} rx={4} style={{ fill: 'var(--surface-2)' }} />
            {props.series.map((series, seriesIndex) => {
              const value = row.values[series.key] ?? 0;
              const length = Math.max(2, (value / max) * track);
              const y = top + 5 + seriesIndex * (barHeight + 3);
              return <g key={series.key}>
                <rect x={labelWidth} y={y} height={barHeight} rx={3} style={{ width: length, fill: badgeColors[series.color], transition: 'width 350ms cubic-bezier(.2,.8,.2,1)' }} />
                <text x={labelWidth + length + 6} y={y + barHeight / 2} dominantBaseline="middle" style={{ font: '11px ui-monospace, monospace', fill: 'var(--muted-foreground)', transition: 'x 350ms' }}>{formatValue(value, props.unit)}</text>
              </g>;
            })}
          </g>;
        })}
      </svg>
      <div className="flex flex-wrap gap-3 text-caption text-muted-foreground">
        {props.series.map((series) => <span key={series.key} className="flex items-center gap-1.5"><span className="h-2 w-4 rounded-sm" style={{ background: badgeColors[series.color] }} />{series.label}</span>)}
      </div>
    </figure>;
  },
  Checklist: ({ props, children }) => <ChecklistGroup title={props.title ?? null}>{children}</ChecklistGroup>,
  ChecklistItem: ({ props, bindings, emit }) => <ChecklistRow index={props.index} label={props.label} note={props.note ?? null} checked={props.checked} bindingPath={bindings?.checked} onChanged={() => emit('change')} />,
  Steps: ({ props, bindings }) => {
    const [active, setActive] = useBoundProp<number>(props.active, bindings?.active);
    return <StepsView steps={props.steps} active={active ?? 0} play={props.play ?? false} intervalMs={props.intervalMs ?? 1400} onActive={setActive} />;
  },
  Switch: ({ props, bindings, emit }) => {
    const [checked, setChecked] = useBoundProp<boolean>(props.checked, bindings?.checked);
    return <Switch label={props.label} checked={checked ?? false} onToggle={() => { setChecked(!(checked ?? false)); emit('change'); }} />;
  },
  Segmented: ({ props, bindings, emit }) => {
    const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
    return <div><TabsSubtle size="compact" selectedIndex={props.options.findIndex((option) => option.value === value)} onSelect={(index) => { const option = props.options[index]; if (option) { setValue(option.value); emit('change'); } }} aria-label="View">
      {props.options.map((option, index) => <TabsSubtleItem key={option.value} index={index} label={option.label} />)}
    </TabsSubtle></div>;
  },
  RadioGroup: ({ props, bindings, emit }) => {
    const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
    const selected = props.options.find((option) => option.value === value);
    return <div className="flex flex-col gap-1">
      {props.label ? <span className="text-caption font-medium text-muted-foreground">{props.label}</span> : null}
      <RadioGroup value={value ?? ''} onValueChange={(next) => { setValue(next); emit('change'); }} aria-label={props.label ?? 'Options'}>
        {props.options.map((option, index) => <RadioItem key={option.value} index={index} value={option.value} label={option.label} />)}
      </RadioGroup>
      {selected?.description ? <span className="px-2 text-caption text-muted-foreground"><InlineText text={selected.description} /></span> : null}
    </div>;
  },
  TextField: ({ props, bindings }) => {
    const [value, setValue] = useBoundProp<string>(props.value, bindings?.value);
    return <InputGroup className="w-full"><InputField index={0} label={props.label} value={value ?? ''} placeholder={props.placeholder ?? undefined} onChange={setValue} /></InputGroup>;
  },
  Button: ({ props, emit }) => <Button variant={props.variant ?? 'secondary'} size="compact" disabled={props.disabled ?? false} onClick={() => emit('press')}>{props.label}</Button>,
  Diff: ({ props }) => <DiffView patch={props.patch} title={props.title ?? null} />,
  RunTag: ({ props }) => {
    const text = <span className="inline-flex w-fit max-w-full items-center self-start whitespace-nowrap rounded border border-border bg-background px-1 font-mono text-[10.5px] leading-4 text-muted-foreground"><span className="text-foreground">{props.commit}</span>&nbsp;· {props.machine} · {props.sample}</span>;
    return props.label ? <Tooltip content={props.label} side="top">{text}</Tooltip> : text;
  },
  BeforeAfter: ({ props }) => <BeforeAfterView before={props.before} after={props.after} slider={props.slider ?? false} />,
  AskCard: ({ props, bindings, emit }) => {
    const [, setValue] = useBoundProp<string>(props.value, bindings?.value);
    return <AskCardView questionId={props.questionId} question={props.question} prompt={props.prompt} options={props.options} value={props.value} staged={props.staged ?? null} sent={props.sent ?? null} answered={props.answered ?? null}
      onPick={(picked) => { setValue(picked); emit('answer'); }} />;
  },
  Svg: ({ props }) => <SvgBlock svg={props.svg} />,
  // A Mermaid diagram goes through the Markdown renderer's Mermaid plugin, as a ```mermaid fence does; the fence is
  // longer than any backtick run in the source.
  Mermaid: ({ props }) => {
    const fence = '`'.repeat(Math.max(3, ...[...props.source.matchAll(/`+/gu)].map((run) => run[0].length + 1)));
    return <GitSpaceMarkdown>{`${fence}mermaid\n${props.source}\n${fence}`}</GitSpaceMarkdown>;
  },
};

/** The items of `args.items` whose `args.field` is true. */
function flaggedItems(args: Record<string, unknown>): unknown[] {
  const items = Array.isArray(args.items) ? args.items : [];
  return items.filter((item) => typeof item === 'object' && item !== null && Object.entries(item).some(([key, value]) => key === args.field && value === true));
}

function fieldOf(item: unknown, field: unknown): unknown {
  if (typeof item !== 'object' || item === null) return undefined;
  return Object.entries(item).find(([key]) => key === field)?.[1];
}

/** The catalog's `$computed` functions. */
export const blockFunctions: Record<keyof typeof gitspaceUiCatalog.functions, ComputedFunction> = {
  progress: (args) => `${flaggedItems(args).length} of ${Array.isArray(args.items) ? args.items.length : 0} ${typeof args.noun === 'string' ? args.noun : ''}`.trim(),
  where: flaggedItems,
  pick: (args) => fieldOf(Array.isArray(args.items) && typeof args.index === 'number' ? args.items[args.index] : undefined, args.field),
  lookup: (args) => {
    const items: unknown[] = Array.isArray(args.items) ? args.items : [];
    return fieldOf(items.find((candidate) => typeof candidate === 'object' && candidate !== null && Object.entries(candidate).some(([key, value]) => key === args.key && value === args.value)), args.field);
  },
};
