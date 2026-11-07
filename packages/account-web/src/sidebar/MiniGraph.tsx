import { StatusDot, workspaceStatusColor, workspaceStatusLabel } from '../GitSpaceShell.js';
import { laneLayout, lit, neighbourhood, relation, type Lit } from './graph.js';
import { DOWNSTREAM_TONE, UPSTREAM_TONE } from './parts.js';
import type { ChainWorkspace } from './StackChain.js';

export interface MiniGraphProps {
  items: readonly ChainWorkspace[];
  /** The workspace the graph is drawn around. */
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
export function MiniGraph({ items, open, hovered, onHover, onOpen }: MiniGraphProps) {
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
