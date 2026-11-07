// A JSON value as a collapsible tree: typed colours, indent guides, the hovered row's path, long strings folded.
import { Button, Tooltip, badgeColors, useShape } from '@gitspace/ui';
import { ChevronDown, ChevronRight, Copy01 } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import type { JsonValue } from './staging.js';

function childPath(path: string, key: string | number): string {
  return typeof key === 'number' ? `${path}[${key}]` : /^[A-Za-z_$][\w$]*$/u.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function entriesOf(value: readonly JsonValue[] | { readonly [key: string]: JsonValue }): [string | number, JsonValue][] {
  return Array.isArray(value) ? value.map((item: JsonValue, index): [number, JsonValue] => [index, item]) : Object.entries(value);
}

/** The paths of the containers down to `limit` levels, the ones shown open. */
function containerPaths(value: JsonValue, path: string, depth: number, into: Set<string>, limit: number): Set<string> {
  if (value === null || typeof value !== 'object' || depth >= limit) return into;
  into.add(path);
  for (const [key, child] of entriesOf(value)) containerPaths(child, childPath(path, key), depth + 1, into, limit);
  return into;
}

export function JsonTree({ value, name }: { value: JsonValue; name: string }) {
  const shape = useShape();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => containerPaths(value, name, 0, new Set(), 2));
  const toggle = (path: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    return next;
  });
  return <div className={`min-w-0 overflow-hidden border border-border bg-background ${shape.container}`}>
    <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-caption text-muted-foreground">
      <span className="font-mono">{name}</span>
      <span className="ml-auto" />
      <Button variant="ghost" size="compact" onClick={() => setExpanded(containerPaths(value, name, 0, new Set(), 99))}>Expand all</Button>
      <Button variant="ghost" size="compact" onClick={() => setExpanded(new Set([name]))}>Collapse</Button>
      <Tooltip content="Copy JSON" side="bottom"><Button variant="ghost" size="icon-compact" aria-label="Copy JSON" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(value, null, 2))}><Copy01 width={14} height={14} strokeWidth={1.5} /></Button></Tooltip>
    </div>
    <div role="tree" aria-label={name} className="max-h-80 overflow-auto py-1 font-mono text-[11.5px] leading-[20px]">
      <JsonNode label={name} value={value} path={name} depth={0} expanded={expanded} onToggle={toggle} />
    </div>
  </div>;
}

const TYPE_COLOR = { string: badgeColors.emerald, number: badgeColors.blue, boolean: badgeColors.orange, null: badgeColors.gray };

function JsonNode({ label, value, path, depth, expanded, onToggle }: { label: ReactNode; value: JsonValue; path: string; depth: number; expanded: ReadonlySet<string>; onToggle(path: string): void }) {
  const [full, setFull] = useState(false);
  const indent = { paddingLeft: `${depth * 14 + 6}px` };
  const guides = Array.from({ length: depth }, (_, index) => <span key={index} aria-hidden className="absolute inset-y-0 w-px bg-border" style={{ left: `${index * 14 + 12}px` }} />);
  if (value !== null && typeof value === 'object') {
    const list = Array.isArray(value);
    const entries = entriesOf(value);
    const open = expanded.has(path);
    const Chevron = open ? ChevronDown : ChevronRight;
    const count = list ? `${entries.length} ${entries.length === 1 ? 'item' : 'items'}` : `${entries.length} ${entries.length === 1 ? 'key' : 'keys'}`;
    return <>
      <div role="treeitem" aria-expanded={open} className="group/row relative flex min-h-5 items-center gap-1 pr-2 hover:bg-surface-1" style={indent}>
        {guides}
        <button type="button" onClick={() => onToggle(path)} className="flex items-center gap-1 text-left">
          <Chevron width={12} height={12} strokeWidth={2} className="shrink-0 text-muted-foreground" />
          <span className="text-foreground">{label}</span>
          <span className="text-muted-foreground">{list ? '[' : '{'}{open ? '' : `… ${list ? ']' : '}'}`}</span>
          {open ? null : <span className="rounded-md bg-surface-1 px-1.5 font-sans text-[11px] text-muted-foreground">{count}</span>}
        </button>
        <span className="ml-auto hidden truncate pl-3 font-sans text-[11px] text-muted-foreground group-hover/row:inline">{path}</span>
      </div>
      {open ? <>
        {entries.map(([key, child]) => <JsonNode key={key} label={typeof key === 'number' ? <span className="text-muted-foreground">{key}</span> : <span>{key}<span className="text-muted-foreground">:</span></span>} value={child} path={childPath(path, key)} depth={depth + 1} expanded={expanded} onToggle={onToggle} />)}
        <div className="relative pr-2 text-muted-foreground" style={indent}>{guides}<span className="pl-4">{list ? ']' : '}'}</span></div>
      </> : null}
    </>;
  }
  const text = typeof value === 'string' ? value : String(value);
  const long = typeof value === 'string' && (value.length > 140 || value.includes('\n'));
  const color = typeof value === 'string' ? TYPE_COLOR.string : typeof value === 'number' ? TYPE_COLOR.number : typeof value === 'boolean' ? TYPE_COLOR.boolean : TYPE_COLOR.null;
  return <div role="treeitem" className="group/row relative flex min-h-5 items-start gap-1 pr-2 hover:bg-surface-1" style={indent}>
    {guides}
    <span className="w-3 shrink-0" />
    <span className="shrink-0 text-foreground">{label}</span>
    <span className={`min-w-0 ${full ? 'whitespace-pre-wrap break-all' : 'truncate'}`} style={{ color }}>
      {typeof value === 'string' ? <><span className="opacity-55">"</span>{full || !long ? text : text.split('\n')[0]?.slice(0, 140)}{!full && long ? '…' : ''}<span className="opacity-55">"</span></> : text}
    </span>
    {long ? <button type="button" onClick={() => setFull(!full)} className="ml-1 shrink-0 rounded-md bg-surface-1 px-1.5 font-sans text-[11px] text-muted-foreground hover:text-foreground">{full ? 'Less' : 'More'}</button> : null}
    <span className="ml-auto hidden shrink-0 truncate pl-3 font-sans text-[11px] text-muted-foreground group-hover/row:inline">{path}</span>
  </div>;
}
