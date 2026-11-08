// The change map's overview, drawn isometrically: a tinted plate per package, a box per area as tall as the lines its
// files change, and the paths between areas, green when the change adds them, red and dashed when it removes them, grey
// when they stay. GitSpace places all of it (iso-layout.ts); colours come from the theme. Hovering an area tells what it
// is and what changed in it; pressing it opens the flow view there. The drawing shrinks to its box but its labels keep
// their size on screen; a label that would cover another moves or, with nowhere to go, is left for the area's card, the
// path's tooltip and the lightbox.
import type { ChangeMap } from '@gitspace/protocol';
import { badgeColors, useShape } from '@gitspace/ui';
import { useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useBoxSize } from '../use-box-size.js';
import { placeIsoLabels, projectIsoMap, type FileChange, type IsoBox, type IsoLabel } from './iso-layout.js';
import { layoutChangeMap, type MapPath } from './map-layout.js';

export const PATH_COLOR: Record<MapPath['state'], string> = { added: badgeColors.green, removed: badgeColors.red, same: 'var(--muted-foreground)' };
export const PATH_STATES: readonly MapPath['state'][] = ['added', 'removed', 'same'];
/** Package tones in column order; green, red and grey are left to the paths. */
const TONES: readonly string[] = [badgeColors.blue, badgeColors.violet, badgeColors.amber, badgeColors.cyan, badgeColors.pink, badgeColors.indigo, badgeColors.teal, badgeColors.orange];
const HALO = { stroke: 'var(--surface-2)', strokeWidth: 4, paintOrder: 'stroke' } satisfies CSSProperties;

function tone(column: number): string {
  return TONES[column % TONES.length]!;
}

/** What the hover card and the box's label say about an area's lines; `counted` once the guide's diffs are read. */
function linesNote(box: IsoBox, counted: boolean): string {
  if (!box.area.files.length) return box.area.note || 'context: no changed files';
  if (box.lines !== null) return `${box.lines} line${box.lines === 1 ? '' : 's'} changed`;
  return counted ? 'lines not counted: the guide shows none of its files' : 'lines not counted yet';
}

function AreaCard({ box, changes, x, y, below }: { box: IsoBox; changes: ReadonlyMap<string, FileChange> | null; x: number; y: number; below: boolean }) {
  const shape = useShape();
  const { area } = box;
  return <div role="tooltip" data-area-card={area.id} className={`pointer-events-none absolute z-10 flex w-72 max-w-[90vw] -translate-x-1/2 flex-col gap-1 border border-border bg-surface-3 p-3 text-left shadow-surface-3 ${below ? '' : '-translate-y-full'} ${shape.container}`}
    style={{ left: `${Math.min(80, Math.max(20, x))}%`, top: `${y}%` }}>
    <span className="flex items-center gap-1.5 text-body font-medium text-foreground"><span className="size-2.5 shrink-0 rounded-sm" style={{ background: tone(box.column) }} />{area.name}</span>
    <span className="text-caption text-muted-foreground"><span className="font-mono">{area.package}</span>{area.role ? ` · ${area.role}` : ''}</span>
    {area.whatItDoes ? <p className="text-caption text-foreground">{area.whatItDoes}</p> : null}
    <span className="text-caption tabular-nums text-muted-foreground">{linesNote(box, changes !== null)}</span>
    {area.files.length ? <ul className="flex flex-col gap-0.5">{area.files.map((file) => {
      const change = changes?.get(file);
      return <li key={file} className="flex gap-2 font-mono text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate" title={file}>{file}</span>
        {change ? <span className="shrink-0 tabular-nums"><span style={{ color: badgeColors.green }}>+{change.additions}</span> <span style={{ color: badgeColors.red }}>−{change.deletions}</span></span> : null}
      </li>;
    })}</ul> : null}
  </div>;
}

const LABEL_FONT: Record<IsoLabel['kind'], { weight: number; family: string }> = {
  name: { weight: 500, family: 'ui-sans-serif, system-ui, sans-serif' }, count: { weight: 600, family: 'ui-sans-serif, system-ui, sans-serif' },
  plate: { weight: 500, family: 'ui-monospace, monospace' }, path: { weight: 400, family: 'ui-monospace, monospace' },
};

/** The overview: `lit` paths and areas stand out and, while a step plays, the rest fade. `changes` holds the lines each
 * file changes once the guide's diffs are measured; until then (null) every box with changed files stands as tall. With
 * `natural`, it is drawn at its natural size for the lightbox. */
export function IsoMap({ map, changes, litPaths, litAreas, onOpenArea, natural = false }: {
  map: ChangeMap;
  changes: ReadonlyMap<string, FileChange> | null;
  litPaths: ReadonlySet<string>;
  litAreas: ReadonlySet<string>;
  onOpenArea(areaId: string): void;
  natural?: boolean;
}) {
  const shape = useShape();
  const marker = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const layout = useMemo(() => projectIsoMap(layoutChangeMap(map), changes), [map, changes]);
  const host = useRef<HTMLDivElement>(null);
  const box = useBoxSize(host);
  // Screen pixels per drawing unit: the drawing never grows past its natural size.
  const scale = natural || !box?.width ? 1 : Math.min(1, box.width / layout.width);
  const labels = useMemo(() => placeIsoLabels(layout, scale), [layout, scale]);
  const pathStates = useMemo(() => new Map(map.paths.map((path) => [path.id, path.state])), [map.paths]);
  const flatAreas = useMemo(() => new Set(map.areas.filter((area) => !area.files.length).map((area) => area.id)), [map.areas]);
  const [hovered, setHovered] = useState<string | null>(null);
  const playing = litPaths.size > 0;
  const shown = layout.boxes.find((candidate) => candidate.area.id === hovered) ?? null;
  const down = (y: number): number => ((y - layout.y) / layout.height) * 100;
  const below = shown ? down(shown.name.y) < 45 : false;
  return <div role="group" aria-label="The change map overview: each package a plate, each area a box as tall as the lines its files change, and the paths between them"
    className={`w-full bg-surface-2 p-2 ${natural ? '' : 'border border-border'} ${shape.container}`}>
    <div ref={host} className="relative mx-auto" style={natural ? { width: layout.width } : { maxWidth: layout.width }}>
      <svg viewBox={`${layout.x} ${layout.y} ${layout.width} ${layout.height}`} width={layout.width} height={natural ? layout.height : undefined} className={natural ? 'block' : 'block h-auto w-full'}>
        <defs>{PATH_STATES.map((state) => <marker key={state} id={`${marker}-${state}`} viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0L10 5L0 10z" style={{ fill: PATH_COLOR[state] }} />
        </marker>)}</defs>
        {layout.plates.map((plate) => <g key={plate.column} data-plate={plate.name}>
          <title>{plate.name}</title>
          <polygon points={plate.corners.map((point) => `${point.x},${point.y}`).join(' ')} fill={tone(plate.column)} fillOpacity={0.1} stroke={tone(plate.column)} strokeOpacity={0.45} strokeLinejoin="round" />
        </g>)}
        {layout.paths.map(({ path, d }) => {
          const lit = litPaths.has(path.id);
          return <g key={path.id} data-path={path.id} data-state={path.state} data-lit={lit} opacity={playing && !lit ? 0.2 : 1}>
            {path.label ? <title>{path.label}</title> : null}
            <path d={d} fill="none" markerMid={`url(#${marker}-${path.state})`} style={{ stroke: PATH_COLOR[path.state], strokeWidth: lit ? 3 : path.state === 'same' ? 1.25 : 2, strokeDasharray: path.state === 'removed' ? '5 4' : undefined }} />
            {lit ? <circle r={4.5} style={{ fill: PATH_COLOR[path.state] }}><animateMotion dur="1.2s" repeatCount="indefinite" path={d} /></circle> : null}
          </g>;
        })}
        {layout.boxes.map((drawn) => {
          const { area } = drawn;
          const lit = litAreas.has(area.id);
          const color = tone(drawn.column);
          const flat = !area.files.length;
          return <g key={area.id} data-area={area.id} data-lit={lit} data-lines={drawn.lines ?? undefined} role="button" tabIndex={0}
            aria-label={`${area.name}, ${linesNote(drawn, changes !== null)}. Open it in the flow view`}
            className="cursor-pointer outline-none" opacity={playing && !lit ? 0.3 : 1}
            onClick={() => onOpenArea(area.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpenArea(area.id); } }}
            onMouseEnter={() => setHovered(area.id)} onMouseLeave={() => setHovered((current) => current === area.id ? null : current)}
            onFocus={() => setHovered(area.id)} onBlur={() => setHovered((current) => current === area.id ? null : current)}>
            {[{ face: drawn.left, opacity: 0.42 }, { face: drawn.right, opacity: 0.62 }, { face: drawn.top, opacity: 0.9 }].map(({ face, opacity }, index) => <polygon key={index}
              points={face.map((point) => `${point.x},${point.y}`).join(' ')} fill={color} fillOpacity={flat ? 0.08 : opacity}
              stroke={lit ? badgeColors.blue : hovered === area.id ? 'var(--foreground)' : color} strokeOpacity={lit || hovered === area.id ? 1 : 0.85}
              strokeWidth={lit ? 2 : 1} strokeDasharray={flat ? '3 3' : undefined} strokeLinejoin="round" />)}
          </g>;
        })}
        {labels.map((label) => {
          if (!label.shown) return null;
          const state = label.kind === 'path' ? pathStates.get(label.of) : undefined;
          const dim = playing && (label.kind === 'path' ? !litPaths.has(label.of) : label.kind !== 'plate' && !litAreas.has(label.of));
          const font = LABEL_FONT[label.kind];
          const context = label.kind === 'count' && flatAreas.has(label.of);
          return <text key={`${label.kind}:${label.of}`} data-label={`${label.kind}:${label.of}`} x={label.x} y={label.y} textAnchor="middle" className="pointer-events-none select-none tabular-nums" opacity={dim ? (label.kind === 'path' ? 0.2 : 0.3) : 1}
            style={{ ...(label.kind === 'name' || label.kind === 'path' ? HALO : {}), strokeWidth: HALO.strokeWidth / scale, fill: state ? PATH_COLOR[state] : label.kind === 'plate' || context ? 'var(--muted-foreground)' : 'var(--foreground)', font: `${context ? 'italic ' : ''}${font.weight} ${label.size}px ${font.family}` }}>{label.text}</text>;
        })}
      </svg>
      {shown ? <AreaCard box={shown} changes={changes} x={((shown.name.x - layout.x) / layout.width) * 100} y={below ? down(shown.ground.y) + 4 : down(shown.name.y - 14)} below={below} /> : null}
    </div>
  </div>;
}
