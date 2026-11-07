import type { StackStatus } from '@gitspace/protocol';
import { ArrowNarrowDown, ArrowNarrowUp, ChevronDown, ChevronUp, LayersThree01 } from '@untitledui/icons';
import { StatusDot, workspaceStatusColor, workspaceStatusLabel } from '../GitSpaceShell.js';
import { blocks, laneLayout, lit, neighbourhood, relation, stackOf, waitsOn, type Lit } from './graph.js';
import { DOWNSTREAM_TONE, UPSTREAM_TONE } from './parts.js';
import { StackChain, type ChainWorkspace } from './StackChain.js';

export interface LaneProps {
  items: readonly ChainWorkspace[];
  /** The open workspace the lane is drawn around. */
  open: string;
  hovered: string | null;
  onHover(id: string | null): void;
  onOpen(id: string): void;
}

function edgeTone(light: Lit | null, from: string, to: string): string | null {
  if (!light) return null;
  if (light.upstream.has(from) && (to === light.focus || light.upstream.has(to))) return UPSTREAM_TONE;
  if (light.downstream.has(to) && (from === light.focus || light.downstream.has(from))) return DOWNSTREAM_TONE;
  return null;
}

const MINI_WIDTH = 252;
const MINI_LEVEL = 34;
const MINI_PAD = 14;
const MINI_GAP = 8;
const MINI_CHIP_MAX = 150;

/** The open workspace's dependency neighbourhood, layered top to bottom by depth: what it waits on above, what waits on
 * it below. Solid edges are dependencies, dashed ones stack parents. Renders nothing without relations. */
export function MiniGraph({ items, open, hovered, onHover, onOpen }: LaneProps) {
  const lane = laneLayout(items, neighbourhood(items, open));
  if (!lane.nodes.length) return null;
  const light = lit(items, hovered ?? open);
  const across = Math.max(...lane.nodes.map(node => node.row)) + 1;
  const chip = Math.min(MINI_CHIP_MAX, (MINI_WIDTH - MINI_GAP * (across - 1)) / across);
  const left = (MINI_WIDTH - (chip * across + MINI_GAP * (across - 1))) / 2;
  const height = MINI_PAD * 2 + Math.max(lane.columns - 1, 0) * MINI_LEVEL;
  const at = new Map(lane.nodes.map(node => [node.id, { x: left + node.row * (chip + MINI_GAP), y: MINI_PAD + node.column * MINI_LEVEL }]));
  return <div className="relative mx-auto" style={{ width: MINI_WIDTH, height }} data-mini-graph={open}>
    <svg width={MINI_WIDTH} height={height} className="absolute inset-0 overflow-visible" aria-hidden>
      {lane.edges.map(edge => {
        const from = at.get(edge.from);
        const to = at.get(edge.to);
        if (!from || !to) return null;
        const [x1, x2, y1, y2] = [from.x + chip / 2, to.x + chip / 2, from.y + 9, to.y - 9];
        const bend = (y2 - y1) / 2;
        const tone = edgeTone(light, edge.from, edge.to);
        return <path key={`${edge.from}-${edge.to}-${edge.kind}`} d={`M ${x1} ${y1} C ${x1} ${y1 + bend}, ${x2} ${y2 - bend}, ${x2} ${y2}`} fill="none"
          stroke={tone ?? 'var(--muted-foreground)'} strokeOpacity={tone ? 0.95 : 0.4} strokeWidth={tone ? 1.75 : 1.25} strokeDasharray={edge.kind === 'stacked' ? '3 3' : undefined} strokeLinecap="round" />;
      })}
    </svg>
    {lane.nodes.map(node => {
      const item = items.find(entry => entry.id === node.id);
      const point = at.get(node.id);
      if (!item || !point) return null;
      const kin = relation(light, node.id);
      const ring = node.id === open ? 'var(--foreground)' : kin === 'upstream' ? UPSTREAM_TONE : kin === 'downstream' ? DOWNSTREAM_TONE : null;
      const label = item.status ? `${item.name} · ${workspaceStatusLabel(item.status)}` : item.name;
      return <button type="button" key={node.id} data-lane-node={node.id} aria-label={label} title={label} aria-current={node.id === open || undefined}
        onMouseEnter={() => onHover(node.id)} onMouseLeave={() => onHover(null)} onClick={() => onOpen(node.id)}
        className={`absolute flex h-[18px] -translate-y-1/2 items-center gap-1 rounded-md bg-surface-3 px-1.5 text-left transition-opacity duration-150 ${kin === 'unrelated' ? 'opacity-35' : ''}`}
        style={{ left: point.x, top: point.y, width: chip, boxShadow: ring ? `0 0 0 1.5px ${ring}` : '0 0 0 1px var(--border)' }}>
        <StatusDot color={item.status ? workspaceStatusColor(item.status) : 'dim'} />
        <span className={`min-w-0 flex-1 truncate text-[10.5px] ${node.id === open ? 'font-medium text-foreground' : 'text-foreground/85'}`}>{item.name}</span>
      </button>;
    })}
  </div>;
}

/** Directly above the open workspace's row: one line saying what it waits on, what waits on it and the size of its
 * stack; opened, its stack as an ordered chain and its dependency neighbourhood. */
export function SidebarLane({ expanded, inset, onExpanded, baseBranch, statuses, ...lane }: LaneProps & { expanded: boolean; inset: number; onExpanded(expanded: boolean): void; baseBranch: string; statuses: ReadonlyMap<string, StackStatus> }) {
  const item = lane.items.find(entry => entry.id === lane.open);
  if (!item) return null;
  const up = waitsOn(item).length;
  const down = blocks(lane.items, lane.open).length;
  const stack = stackOf(lane.items, lane.open).length;
  const related = up + down > 0 || item.stackedOn !== null || lane.items.some(other => other.stackedOn === item.id);
  return <div data-sidebar-lane className="relative my-0.5 mr-1 rounded-[10px]" style={{ marginLeft: Math.max(inset - 4, 0) }}>
    <button type="button" aria-expanded={expanded} disabled={!related} onClick={() => onExpanded(!expanded)} className="flex h-6 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap pl-1.5 pr-1 text-left text-[11px] text-muted-foreground enabled:hover:text-foreground">
      <span className="inline-flex items-center gap-0.5" style={{ color: `color-mix(in oklab, ${UPSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowUp width={11} height={11} strokeWidth={2} />waits on {up}</span>
      <span>·</span>
      <span className="inline-flex items-center gap-0.5" style={{ color: `color-mix(in oklab, ${DOWNSTREAM_TONE} 75%, var(--muted-foreground))` }}><ArrowNarrowDown width={11} height={11} strokeWidth={2} />blocks {down}</span>
      {stack > 1 ? <><span>·</span><span className="inline-flex items-center gap-0.5"><LayersThree01 width={11} height={11} strokeWidth={1.75} />stack {stack}</span></> : null}
      {related ? expanded ? <ChevronUp width={12} height={12} strokeWidth={1.75} className="ml-auto" /> : <ChevronDown width={12} height={12} strokeWidth={1.75} className="ml-auto" /> : null}
    </button>
    {expanded && stack > 1 ? <div className="mb-1 rounded-[10px] bg-surface-2 p-1 shadow-surface-1"><StackChain items={lane.items} id={lane.open} baseBranch={baseBranch} statuses={statuses} compact onOpen={lane.onOpen} /></div> : null}
    {expanded && up + down > 0 ? <div className="mb-1 overflow-x-auto rounded-[10px] bg-surface-2 shadow-surface-1"><MiniGraph {...lane} /></div> : null}
  </div>;
}
