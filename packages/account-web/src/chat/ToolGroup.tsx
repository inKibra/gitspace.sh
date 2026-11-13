// Consecutive tool calls of one turn as one collapsible group. Closed, it is one line (count, time, tools, failures, a
// tiny waterfall), the files the calls edited, and the images they returned. Open, each call is a row on a shared time
// axis; a selected row shows its diff, its output as a log (or its JSON result as a tree), and its arguments.
import type { ToolCallBlock, TranscriptItem } from '@gitspace/blocks';
import { RuntimeBrowserExecutionSchema, RuntimeCodemodeDetailsSchema, type RuntimeCodemodeCall } from '@gitspace/protocol-runtime';
import { Badge, Button, TabsSubtle, TabsSubtleItem, Tooltip, badgeColors, useShape } from '@gitspace/ui';
import { Check, ChevronDown, ChevronRight, Clock, File02, Loading02, SlashCircle01, XClose } from '@untitledui/icons';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { PierreViewer } from '../inspector/FilesSurface.js';
import type { QuestionCards } from '../QuestionCards.js';
import { JsonTree } from './JsonTree.js';
import { LogView } from './LogView.js';
import { RichContent } from './RichContent.js';
import { isJsonValue, type JsonValue } from './staging.js';
import type { ItemInteractionProps, TranscriptItemState } from './TranscriptItemView.js';
import { fullTime } from './time.js';

const EDIT_TOOLS: Record<string, true> = { edit: true, write: true, apply_patch: true };
/** A `write` call's diff shows at most this many of its lines. */
const WRITE_DIFF_LINES = 400;
const ADDED = badgeColors.green;
const REMOVED = badgeColors.red;
const browserExecutionDetails = z.object({ browser: RuntimeBrowserExecutionSchema });
/** A script call's status as the call rows draw it. */
const SCRIPT_CALL_STATUS: Record<RuntimeCodemodeCall['status'], ToolCallBlock['status']> = { running: 'running', completed: 'done', failed: 'error', interrupted: 'interrupted' };
const pathArgs = z.object({ path: z.string() });
const patchArgs = z.object({ patch: z.string() });
const writeArgs = z.object({ content: z.string() });
const textEdit = z.object({ oldText: z.string(), newText: z.string() });
const editArgs = z.union([z.object({ edits: z.array(textEdit) }), textEdit.transform((edit) => ({ edits: [edit] }))]);
const commandArgs = z.object({ command: z.string() });

/** One call of a group. `complete` is false while `block` is a transcript preview whose args and details are stripped. */
export interface GroupCall {
  block: ToolCallBlock;
  complete: boolean;
  error?: string;
  onRetry?(): void;
}

export type ToolRun<T> = { tools: false; entry: T } | { tools: true; entries: T[] };

/** Custom messages the runtime records as calls, the legacy `todo` call, and calls whose takeover or lifecycle approval
 * card shows in their place stay rows of their own. */
function groupable(item: TranscriptItem, cards: QuestionCards | null): boolean {
  if (item.type !== 'tool-call' || item.tool === 'todo' || item.id.includes(':custom:')) return false;
  if (item.tool === 'ask_takeover') return !cards?.questions.some((question) => question.kind === 'takeover' && question.takeover?.callId === item.toolCallId);
  if (item.tool === 'environment') return !cards?.questions.some((question) => question.kind === 'lifecycle-approval' && question.lifecycle?.callId === item.toolCallId);
  return true;
}

/** Consecutive groupable tool calls of one turn become one run; every other entry is a run of its own. */
export function toolRuns<T extends { item: TranscriptItem; turnId: string }>(entries: readonly T[], cards: QuestionCards | null): ToolRun<T>[] {
  const runs: ToolRun<T>[] = [];
  let open: T[] | null = null;
  for (const entry of entries) {
    if (!groupable(entry.item, cards)) {
      open = null;
      runs.push({ tools: false, entry });
    } else if (open && open[0]!.turnId === entry.turnId) open.push(entry);
    else {
      open = [entry];
      runs.push({ tools: true, entries: open });
    }
  }
  return runs;
}

function clock(ms: number): string {
  const time = new Date(ms);
  return [time.getHours(), time.getMinutes(), time.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
}

export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  if (seconds < 3600) {
    const rest = Math.round(seconds % 60);
    return rest ? `${Math.floor(seconds / 60)}m ${rest}s` : `${Math.floor(seconds / 60)}m`;
  }
  const minutes = Math.round((seconds % 3600) / 60);
  return minutes ? `${Math.floor(seconds / 3600)}h ${minutes}m` : `${Math.floor(seconds / 3600)}h`;
}

/** Ticks at a round step that gives at most six labels over the span. */
function ticks(span: number): number[] {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map((seconds) => seconds * 1000);
  const step = steps.find((candidate) => span / candidate <= 6) ?? 7_200_000;
  const marks: number[] = [];
  for (let at = 0; at <= span; at += step) marks.push(at);
  return marks;
}

function active(block: ToolCallBlock): boolean {
  return block.status === 'running' || block.status === 'pending';
}

/** A call's start and end; `end` is null while it runs. A finished call missing a time is drawn at the one it has. */
interface Timing { start: number | null; end: number | null }

function timingOf(block: ToolCallBlock): Timing {
  const started = block.startedAt ? Date.parse(block.startedAt) : Number.NaN;
  const ended = block.endedAt ? Date.parse(block.endedAt) : Number.NaN;
  const start = Number.isFinite(started) ? started : null;
  if (active(block)) return { start, end: null };
  const end = Number.isFinite(ended) ? ended : start;
  return { start: start ?? end, end };
}

/** The group's time window; `scale` is its width on the axis, at least a second. */
interface Span { start: number; end: number; now: number; scale: number }

function spanOf(timings: readonly Timing[], running: boolean, now: number): Span | null {
  const starts = timings.flatMap((timing) => timing.start === null ? [] : [timing.start]);
  if (!starts.length) return null;
  const start = Math.min(...starts);
  const last = Math.max(start, ...timings.map((timing) => timing.end ?? timing.start ?? start));
  const end = running ? Math.max(now, last) : last;
  return { start, end, now: running ? end : last, scale: Math.max(end - start, 1000) };
}

interface FileChange { path: string; added: number | null; removed: number | null }
/** The files an edit / write / apply_patch call changed, with one git patch per file once its arguments are loaded.
 * `numbered`: the patch's line numbers are the file's (a write); an edit's or patch's hunks do not know where in the
 * file they are, so their numbers are hidden. */
interface CallEdit { files: FileChange[]; diffs: { path: string; patch: string }[]; numbered: boolean; omitted: number }

function hunk(before: string, after: string): { lines: string[]; added: number; removed: number } {
  const old = before.split('\n');
  const next = after.split('\n');
  let head = 0;
  while (head < old.length && head < next.length && old[head] === next[head]) head++;
  let tail = 0;
  while (tail < old.length - head && tail < next.length - head && old[old.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
  const removed = old.slice(head, old.length - tail);
  const added = next.slice(head, next.length - tail);
  return {
    lines: [...old.slice(0, head).map((line) => ` ${line}`), ...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`), ...old.slice(old.length - tail).map((line) => ` ${line}`)],
    added: added.length,
    removed: removed.length,
  };
}

/** A git patch of `path` from hunk bodies (` `, `-`, `+` lines), numbered one after another from line 1. */
function filePatch(path: string, hunks: readonly (readonly string[])[]): string {
  let oldLine = 1;
  let newLine = 1;
  const body = hunks.flatMap((lines) => {
    const oldCount = lines.filter((line) => !line.startsWith('+')).length;
    const newCount = lines.filter((line) => !line.startsWith('-')).length;
    const header = `@@ -${oldCount ? oldLine : oldLine - 1},${oldCount} +${newCount ? newLine : newLine - 1},${newCount} @@`;
    oldLine += oldCount;
    newLine += newCount;
    return [header, ...lines];
  });
  return `${[`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, ...body].join('\n')}\n`;
}

function editOf(block: ToolCallBlock): CallEdit | null {
  if (!EDIT_TOOLS[block.tool]) return null;
  const named = pathArgs.safeParse(block.args);
  const path = block.target ?? (named.success ? named.data.path : null);
  const unknown: CallEdit = { files: path ? [{ path, added: null, removed: null }] : [], diffs: [], numbered: false, omitted: 0 };
  if (block.tool === 'apply_patch') {
    const parsed = patchArgs.safeParse(block.args);
    if (!parsed.success) return unknown;
    const files: (FileChange & { hunks: string[][] })[] = [];
    let current: (FileChange & { hunks: string[][] }) | null = null;
    for (const line of parsed.data.patch.split('\n')) {
      const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/u.exec(line);
      if (header) {
        current = { path: header[2]!.trim(), added: 0, removed: 0, hunks: header[1] === 'Delete' ? [] : [[]] };
        files.push(current);
      } else if (current && !line.startsWith('***')) {
        if (line.startsWith('@@')) {
          if (current.hunks.at(-1)?.length) current.hunks.push([]);
          continue;
        }
        if (line.startsWith('+')) current.added = (current.added ?? 0) + 1;
        else if (line.startsWith('-')) current.removed = (current.removed ?? 0) + 1;
        current.hunks.at(-1)?.push(line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') ? line : ` ${line}`);
      }
    }
    // A blank line before the next file header or the patch's end is the patch text's own, not a context line.
    for (const file of files) for (const lines of file.hunks) while (lines.at(-1) === ' ') lines.pop();
    return {
      files: files.map(({ path: filePath, added, removed }) => ({ path: filePath, added, removed })),
      diffs: files.flatMap((file) => file.hunks.some((lines) => lines.length) ? [{ path: file.path, patch: filePatch(file.path, file.hunks.filter((lines) => lines.length)) }] : []),
      numbered: false,
      omitted: 0,
    };
  }
  if (block.tool === 'write') {
    const parsed = writeArgs.safeParse(block.args);
    if (!parsed.success || !path) return unknown;
    const lines = parsed.data.content.replace(/\n$/u, '').split('\n');
    const shown = lines.slice(0, WRITE_DIFF_LINES);
    return { files: [{ path, added: lines.length, removed: null }], diffs: [{ path, patch: filePatch(path, [shown.map((line) => `+${line}`)]) }], numbered: true, omitted: lines.length - shown.length };
  }
  const parsed = editArgs.safeParse(block.args);
  if (!parsed.success || !path || !parsed.data.edits.length) return unknown;
  const hunks = parsed.data.edits.map((edit) => hunk(edit.oldText, edit.newText));
  return {
    files: [{ path, added: hunks.reduce((sum, part) => sum + part.added, 0), removed: hunks.reduce((sum, part) => sum + part.removed, 0) }],
    diffs: [{ path, patch: filePatch(path, hunks.map((part) => part.lines)) }],
    numbered: false,
    omitted: 0,
  };
}

function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

function StatusIcon({ status }: { status: ToolCallBlock['status'] }) {
  const size = { width: 14, height: 14, strokeWidth: 2 };
  if (status === 'running') return <Loading02 {...size} className="shrink-0 animate-spin" style={{ color: badgeColors.blue }} aria-label="Running" />;
  if (status === 'pending') return <Clock {...size} className="shrink-0 text-muted-foreground" aria-label="Pending" />;
  if (status === 'error') return <XClose {...size} className="shrink-0" style={{ color: badgeColors.red }} aria-label="Failed" />;
  if (status === 'interrupted') return <SlashCircle01 {...size} className="shrink-0" style={{ color: badgeColors.amber }} aria-label="Stopped" />;
  return <Check {...size} className="shrink-0 text-muted-foreground" aria-label="Done" />;
}

function ToolChip({ tool }: { tool: string }) {
  return <span className="shrink-0 rounded-[5px] border border-border px-1 font-mono text-[11px] leading-4 text-muted-foreground">{tool}</span>;
}

function Counts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null && removed === null) return null;
  return <span className="shrink-0 font-mono text-[11px] tabular-nums">
    {added === null ? null : <span style={{ color: ADDED }}>+{added}</span>}{added !== null && removed !== null ? ' ' : null}{removed === null ? null : <span style={{ color: REMOVED }}>−{removed}</span>}
  </span>;
}

function barColor(block: ToolCallBlock): string {
  if (block.status === 'error') return badgeColors.red;
  if (block.status === 'interrupted') return badgeColors.amber;
  return EDIT_TOOLS[block.tool] ? ADDED : badgeColors.blue;
}

function MiniWaterfall({ calls, timings, span }: { calls: readonly GroupCall[]; timings: readonly Timing[]; span: Span }) {
  const lanes = Math.min(calls.length, 5);
  const height = 18;
  const step = height / lanes;
  return <svg width="112" height={height} viewBox={`0 0 112 ${height}`} aria-hidden className="shrink-0 overflow-visible">
    <rect x="0" y="0" width="112" height={height} rx="3" className="fill-surface-1" />
    {calls.map(({ block }, index) => {
      const timing = timings[index]!;
      if (timing.start === null) return null;
      const x = ((timing.start - span.start) / span.scale) * 112;
      const width = Math.max(1.5, (((timing.end ?? span.now) - timing.start) / span.scale) * 112);
      return <rect key={block.id} data-call-bar={block.id} x={x} y={(index % lanes) * step + step * 0.15} width={width} height={Math.max(1, step * 0.7)} rx="0.75" fill={active(block) ? badgeColors.blue : barColor(block)} opacity={block.status === 'done' ? 0.55 : 1} />;
    })}
  </svg>;
}

/** A run of tool calls. Interaction (open, the selected call) lives in `state` when given, so virtual rows keep it. */
export function ToolGroup({ calls, state, onStateChange }: { calls: readonly GroupCall[] } & ItemInteractionProps) {
  const shape = useShape();
  const [local, setLocal] = useState<TranscriptItemState>({});
  const interaction = state ?? local;
  const update = (patch: Partial<TranscriptItemState>): void => {
    if (onStateChange) onStateChange(patch);
    else setLocal((previous) => ({ ...previous, ...patch }));
  };
  const open = interaction.open === true;
  const selected = interaction.selectedCall ?? null;
  const running = calls.some((call) => active(call.block));
  const now = useNow(running);
  const timings = useMemo(() => calls.map((call) => timingOf(call.block)), [calls]);
  const span = spanOf(timings, running, now);
  const edits = useMemo(() => calls.map((call) => editOf(call.block)), [calls]);
  const files = useMemo(() => {
    const merged = new Map<string, FileChange & { calls: number; first: string }>();
    edits.forEach((edit, index) => {
      for (const file of edit?.files ?? []) {
        const previous = merged.get(file.path);
        merged.set(file.path, previous ? {
          ...previous,
          added: previous.added === null || file.added === null ? null : previous.added + file.added,
          removed: previous.removed === null || file.removed === null ? null : previous.removed + file.removed,
          calls: previous.calls + 1,
        } : { ...file, calls: 1, first: calls[index]!.block.id });
      }
    });
    return [...merged.values()];
  }, [edits, calls]);
  const tools = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { block } of calls) counts.set(block.tool, (counts.get(block.tool) ?? 0) + 1);
    return [...counts.entries()].sort((left, right) => right[1] - left[1]);
  }, [calls]);
  const failed = calls.filter((call) => call.block.status === 'error').length;
  const stopped = calls.filter((call) => call.block.status === 'interrupted').length;
  const images = calls.flatMap(({ block }) => [...block.input ?? [], ...block.result ?? []].filter((content) => content.type === 'image'));
  const label = calls.length === 1 ? '1 tool call' : `${calls.length} tool calls`;
  const at = (ms: number): string => span ? `${((ms - span.start) / span.scale) * 100}%` : '0%';
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div role="group" aria-label={label} data-tool-group className={`min-w-0 overflow-hidden border bg-surface-2 ${running ? 'border-[#3b82f6]/40' : 'border-border'} ${shape.container}`}>
    <button type="button" aria-expanded={open} onClick={() => update({ open: !open })} title={span ? `Started ${fullTime(span.start)}` : undefined} className="flex min-h-10 w-full min-w-0 items-center gap-2 px-3 py-2 text-left outline-none hover:bg-surface-1 focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]">
      <Chevron width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
      <span className="shrink-0 text-body text-foreground">{label}</span>
      {span ? <span className="shrink-0 text-caption tabular-nums text-muted-foreground" data-group-duration>{running ? `running ${duration(span.now - span.start)}` : duration(span.end - span.start)}</span> : null}
      <span className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-caption text-muted-foreground">
        {tools.slice(0, 4).map(([tool, count]) => <span key={tool} className="flex shrink-0 items-center gap-1"><ToolChip tool={tool} />{count > 1 ? <span className="tabular-nums">×{count}</span> : null}</span>)}
        {tools.length > 4 ? <span className="shrink-0">+{tools.length - 4}</span> : null}
      </span>
      {failed ? <Badge size="compact" variant="dot" color="red">{failed} failed</Badge> : null}
      {stopped ? <Badge size="compact" variant="dot" color="amber">{stopped} stopped</Badge> : null}
      {running ? <Badge size="compact" variant="dot" color="blue">running</Badge> : null}
      {span ? <MiniWaterfall calls={calls} timings={timings} span={span} /> : null}
    </button>
    {files.length ? <div role="list" aria-label="Files these calls edited" className="flex min-w-0 flex-wrap items-center gap-1.5 px-3 pb-2 pl-9 text-caption text-muted-foreground">
      <span className="shrink-0">Edited</span>
      {files.map((file) => <Tooltip key={file.path} content={`${file.path} · ${file.calls} ${file.calls === 1 ? 'edit' : 'edits'}`} side="top">
        <button type="button" role="listitem" data-edited-file={file.path} onClick={() => update({ open: true, selectedCall: file.first })}
          className="inline-flex h-5 items-center gap-1 rounded-md border border-border bg-surface-1 px-1.5 hover:bg-hover">
          <File02 width={11} height={11} strokeWidth={1.75} className="shrink-0" />
          <span className="font-mono text-[11px] text-foreground">{file.path.split('/').at(-1)}</span>
          <Counts added={file.added} removed={file.removed} />
        </button>
      </Tooltip>)}
    </div> : null}
    {images.length ? <div role="group" aria-label="Images from these calls" className="flex min-w-0 flex-wrap gap-2 px-3 pb-3">{images.map((image) => <RichContent block={image} key={image.id} />)}</div> : null}
    {open ? <div className="border-t border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-caption text-muted-foreground">
        {span ? <span className="tabular-nums">{clock(span.start)} → {running ? `now ${clock(span.now)}` : clock(span.end)}</span> : null}
        <span className="ml-auto">{files.length ? 'Select a call for its output or diff' : 'Select a call for its output'}</span>
      </div>
      <div className="max-h-[520px] overflow-y-auto overscroll-contain">
        <div className="sticky top-0 z-10 grid h-6 grid-cols-[minmax(0,17rem)_minmax(0,1fr)_4rem] border-y border-border bg-surface-2 font-mono text-[10.5px] text-muted-foreground">
          <span className="border-r border-border px-3 leading-6">call</span>
          <span className="relative overflow-hidden">{span ? ticks(span.scale).map((mark) => <span key={mark} className="absolute top-0 h-full border-l border-border pl-1 leading-6" style={{ left: at(span.start + mark) }}>{mark === 0 ? '0' : duration(mark)}</span>) : null}</span>
          <span className="px-2 text-right leading-6">took</span>
        </div>
        <ol>{calls.map((call, index) => <CallRow key={call.block.id} call={call} timing={timings[index]!} edit={edits[index]!} span={span} at={at}
          selected={selected === call.block.id} onSelect={() => update({ selectedCall: selected === call.block.id ? null : call.block.id })} />)}</ol>
      </div>
    </div> : null}
  </div>;
}

function browserOf(block: ToolCallBlock): string | null {
  // Cloud agents call it web_browser (an OpenAI-reserved name otherwise); machine sessions keep browser.
  if (block.tool !== 'browser' && block.tool !== 'web_browser') return null;
  const parsed = browserExecutionDetails.safeParse(block.details);
  return parsed.success ? parsed.data.browser.name : null;
}

function CallRow({ call, timing, edit, span, at, selected, onSelect }: { call: GroupCall; timing: Timing; edit: CallEdit | null; span: Span | null; at(ms: number): string; selected: boolean; onSelect(): void }) {
  const { block } = call;
  const end = timing.end ?? span?.now ?? null;
  const took = timing.start === null || end === null ? '—' : active(block) ? `${duration(end - timing.start)}…` : duration(end - timing.start);
  const file = edit?.files.length === 1 ? edit.files[0]! : null;
  const browser = browserOf(block);
  return <li className={`border-b border-border last:border-b-0 ${block.status === 'error' ? 'bg-[#ef4444]/[0.04]' : ''}`} data-call={block.id}>
    <button type="button" onClick={onSelect} aria-expanded={selected} title={timing.start === null ? undefined : `Started ${fullTime(timing.start)}${timing.end === null ? '' : ` · ended ${fullTime(timing.end)}`}`} className={`relative grid h-7 w-full grid-cols-[minmax(0,17rem)_minmax(0,1fr)_4rem] items-center text-left outline-none hover:bg-surface-1 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${selected ? 'bg-surface-1' : ''}`}>
      {block.status === 'error' ? <span aria-hidden className="absolute inset-y-0 left-0 w-0.5" style={{ background: badgeColors.red }} /> : null}
      <span className="flex h-full min-w-0 items-center gap-1.5 border-r border-border px-3">
        <StatusIcon status={block.status} />
        <ToolChip tool={block.tool} />
        {file ? <>
          <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground" title={file.path}>{file.path.split('/').at(-1)}</span>
          <Counts added={file.added} removed={file.removed} />
        </> : <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground" title={block.target}>{block.target || '—'}</span>}
        {browser ? <span className="shrink-0 truncate text-caption text-muted-foreground">· {browser}</span> : null}
      </span>
      <span className="relative h-full">
        {timing.start !== null && end !== null && span ? <span data-call-bar={block.id} className="absolute top-1/2 h-2.5 min-w-[3px] -translate-y-1/2 rounded-[3px]" style={{ left: at(timing.start), width: `${((end - timing.start) / span.scale) * 100}%`, background: active(block) ? badgeColors.blue : barColor(block), opacity: block.status === 'done' ? 0.7 : 1 }}>
          {block.status === 'running' ? <span className="absolute inset-0 animate-pulse rounded-[3px] bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgb(255_255_255/0.35)_4px_8px)]" /> : null}
        </span> : null}
        {block.status === 'running' && span ? <span className="absolute inset-y-0 w-px" style={{ left: at(span.now), background: badgeColors.blue }} aria-hidden /> : null}
      </span>
      <span className="px-2 text-right font-mono text-[11px] tabular-nums text-muted-foreground" data-call-took>{took}</span>
    </button>
    {selected ? <CallDetail call={call} timing={timing} edit={edit} end={end} browser={browser} /> : null}
  </li>;
}

function CallDetail({ call, timing, edit, end, browser }: { call: GroupCall; timing: Timing; edit: CallEdit | null; end: number | null; browser: string | null }) {
  const { block } = call;
  const shape = useShape();
  const [tab, setTab] = useState(0);
  const result = block.result ?? [];
  const text = result.flatMap((content) => content.type === 'code' || content.type === 'markdown' ? [content.text] : []).join('\n');
  const rich = result.filter((content) => content.type !== 'code' && content.type !== 'markdown');
  const commandArg = commandArgs.safeParse(block.args);
  const command = commandArg.success ? commandArg.data.command : block.input?.flatMap((content) => content.type === 'code' ? [content.text] : [])[0] ?? null;
  const json = useMemo((): JsonValue | null => {
    const trimmed = text.trim();
    if (!rich.length && (trimmed.startsWith('{') || trimmed.startsWith('['))) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isJsonValue(parsed)) return parsed;
      } catch {
        return null;
      }
    }
    return null;
  }, [text, rich.length]);
  const argsJson = useMemo((): JsonValue | null => {
    if (block.args === undefined) return null;
    const plain: unknown = JSON.parse(JSON.stringify(block.args) ?? 'null');
    return isJsonValue(plain) ? plain : null;
  }, [block.args]);
  const diffs = call.complete ? edit?.diffs ?? [] : [];
  // A codemode call's script calls ran inside it and have no rows of their own.
  const parsedCalls = block.tool === 'codemode' ? RuntimeCodemodeDetailsSchema.safeParse(block.details) : null;
  const scriptCalls = parsedCalls?.success ? parsedCalls.data.calls : [];
  const labels = [...diffs.length ? ['Diff'] : [], ...scriptCalls.length ? ['Calls'] : [], json === null ? 'Output' : 'Result', 'Arguments'];
  const shown = labels[Math.min(tab, labels.length - 1)];
  const path = edit?.files.length === 1 ? edit.files[0]!.path : null;
  let body = null;
  if (!call.complete) body = call.error
    ? <div role="alert" className="flex min-w-0 flex-wrap items-center gap-2 text-body text-destructive [overflow-wrap:anywhere]">{call.error}{call.onRetry ? <Button variant="ghost" size="compact" onClick={call.onRetry}>Retry</Button> : null}</div>
    : <p role="status" className="text-caption text-muted-foreground">Loading the call…</p>;
  else if (shown === 'Diff' && diffs.length) body = <div className="flex min-w-0 flex-col gap-2">
    {diffs.map((diff) => <div key={diff.path} className={`flex min-w-0 flex-col overflow-hidden border border-border ${shape.container}`} data-call-diff={diff.path}>
      {diffs.length > 1 ? <span className="truncate border-b border-border px-3 py-1.5 font-mono text-caption text-muted-foreground">{diff.path}</span> : null}
      <PierreViewer path={diff.path} patch={diff.patch} lineNumbers={edit?.numbered ?? false} />
    </div>)}
    {edit?.omitted ? <p className="text-caption text-muted-foreground">{edit.omitted} more {edit.omitted === 1 ? 'line' : 'lines'} not shown</p> : null}
  </div>;
  else if (shown === 'Calls') body = <ol className={`flex min-w-0 flex-col overflow-hidden border border-border ${shape.container}`} data-script-calls>
    {scriptCalls.map((item, index) => <li key={index} className="flex min-w-0 flex-col gap-0.5 border-b border-border px-3 py-1.5 last:border-b-0">
      <span className="flex min-w-0 items-center gap-1.5">
        <StatusIcon status={SCRIPT_CALL_STATUS[item.status]} />
        <ToolChip tool={item.tool} />
        <span className="min-w-0 truncate font-mono text-[11.5px] text-foreground" title={item.args}>{item.args}</span>
        <span className="ml-auto shrink-0 pl-2 font-mono text-[11px] tabular-nums text-muted-foreground">{item.durationMs === undefined ? '—' : duration(item.durationMs)}</span>
      </span>
      {item.error ? <span className="font-mono text-caption text-destructive [overflow-wrap:anywhere]">{item.error}</span> : null}
    </li>)}
  </ol>;
  else if (shown === 'Arguments') body = argsJson === null ? <p className="text-caption text-muted-foreground">No arguments recorded.</p> : <JsonTree value={argsJson} name="args" />;
  else if (json !== null) body = <JsonTree value={json} name="result" />;
  else body = <div className="flex min-w-0 flex-col gap-2">
    {text || !rich.length ? <LogView command={command} text={text} running={active(block)} failed={block.status === 'error' || block.status === 'interrupted'} /> : null}
    {rich.map((content) => <RichContent block={content} key={content.id} />)}
  </div>;
  return <div className="flex min-w-0 flex-col gap-2 border-t border-border bg-surface-1 px-3 pb-3 pt-2" data-call-detail>
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
      <span className="font-medium text-foreground">{block.tool}</span>
      {path ? <span className="min-w-0 truncate font-mono">{path}</span> : null}
      {browser ? <span>{browser}</span> : null}
      {timing.start !== null ? <span className="tabular-nums">started {clock(timing.start)}</span> : null}
      {timing.start !== null && end !== null ? <span className="tabular-nums">{active(block) ? `running ${duration(end - timing.start)}` : `ended ${clock(end)} · took ${duration(end - timing.start)}`}</span> : null}
      {block.status === 'error' ? <Badge size="compact" variant="dot" color="red">failed</Badge> : block.status === 'interrupted' ? <Badge size="compact" variant="dot" color="amber">stopped</Badge> : null}
      {call.complete ? <span className="ml-auto">
        <TabsSubtle size="compact" selectedIndex={Math.min(tab, labels.length - 1)} onSelect={setTab} idPrefix={`call-${block.id}`} aria-label="Call detail">
          {labels.map((name, index) => <TabsSubtleItem key={name} index={index} label={name} />)}
        </TabsSubtle>
      </span> : null}
    </div>
    {body}
  </div>;
}
