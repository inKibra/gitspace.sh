// The Change Guide's map, in two views. The overview (IsoMap.tsx) draws each package as a plate and each area as a box
// as tall as the lines its files change; the flow view draws packages as columns and areas as boxes in them, each with
// what it does and the lines its files change. In both, paths between areas are green when the change adds them, red
// and dashed when it removes them, grey when they stay. The agent names the areas, paths and steps; GitSpace lays them
// out (map-layout.ts, iso-layout.ts). Playing the steps lights each step's areas and paths in either view and names the
// section that explains it. Either view opens in the lightbox to pan and zoom.
//
// The flow view keeps its text readable: it shrinks to fit its box only as far as keeps its smallest text at
// READABLE_TEXT, and past that keeps that size and scrolls sideways. Its columns stay side by side because the paths
// between packages read left to right, and a column is wider than half a narrow Inspector, so stacking them would not
// save scrolling but would turn every path between packages into a long run down past other areas.
import type { ChangeMap } from '@gitspace/protocol';
import { Button, TabsSubtle, TabsSubtleItem, badgeColors, useShape } from '@gitspace/ui';
import { ChevronLeft, ChevronRight, PauseCircle, Play } from '@untitledui/icons';
import { Position, getBezierPath } from '@xyflow/react';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Lightbox } from '../Lightbox.js';
import { useBoxSize } from '../use-box-size.js';
import { Source } from './Authorship.js';
import type { FileChange } from './iso-layout.js';
import { IsoMap, PATH_COLOR, PATH_STATES } from './IsoMap.js';
import { AREA_HEIGHT, AREA_WIDTH, layoutChangeMap, mapAround, type MapSide } from './map-layout.js';

const STEP_MS = 2400;
/** Past this many areas or packages, the map opens in the flow view. */
const CROWDED_AREAS = 12;
const CROWDED_PACKAGES = 5;
/** The smallest text, in pixels, the map views draw. */
export const READABLE_TEXT = 11;
/** The flow view's text, in pixels at its natural size: area names, then what an area does and its lines, then path
 * labels and package names. */
const FLOW_TEXT = { name: 13, detail: 12, label: 12 };
const SMALLEST_FLOW_TEXT = Math.min(FLOW_TEXT.name, FLOW_TEXT.detail, FLOW_TEXT.label);
/** Room around the flow drawing, in pixels. */
const FLOW_PAD = 20;
const SIDE_POSITION: Record<MapSide, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
/** Where each side's handle sits on an area box. */
const HANDLE_AT: Record<MapSide, { x: number; y: number }> = { top: { x: AREA_WIDTH / 2, y: 0 }, right: { x: AREA_WIDTH, y: AREA_HEIGHT / 2 }, bottom: { x: AREA_WIDTH / 2, y: AREA_HEIGHT }, left: { x: 0, y: AREA_HEIGHT / 2 } };
/** Where a label sits beside an area a path leaves or reaches, outside the side it leaves or reaches by. */
const LABEL_NEAR: Record<MapSide, { dx: number; dy: number; anchor: 'start' | 'end' }> = {
  right: { dx: 10, dy: -10, anchor: 'start' }, left: { dx: -10, dy: -10, anchor: 'end' },
  bottom: { dx: 8, dy: 14, anchor: 'start' }, top: { dx: 8, dy: -14, anchor: 'start' },
};
const HALO = { stroke: 'var(--surface-2)', strokeWidth: 4, paintOrder: 'stroke' } satisfies CSSProperties;
/** About how wide a character of a path label is, and how tall a label's line is, as shares of its size; and where
 * else, in lines up (negative) or down, a label goes when its place covers an area or another label. */
const LABEL_CHAR = 0.62;
const LABEL_LINE = 1.35;
const LABEL_SHIFTS = [0, -1, 1, -2, 2];

interface LabelPlace { x: number; y: number; anchor: 'start' | 'middle' | 'end' }

/** The flow view: packages as columns of areas, the paths between them beneath, their labels above. `lit` paths and
 * areas stand out and, while a step plays, the rest fade; `faded` areas fade on their own. With `focus`, the view
 * scrolls that area into sight. With `natural`, it is drawn at its natural size for the lightbox. */
function FlowMap({ map, changes, litPaths, litAreas, faded, label, focus = null, natural = false }: {
  map: ChangeMap;
  changes: ReadonlyMap<string, FileChange> | null;
  litPaths: ReadonlySet<string>;
  litAreas: ReadonlySet<string>;
  faded: ReadonlySet<string>;
  label: string;
  focus?: string | null;
  natural?: boolean;
}) {
  const shape = useShape();
  const marker = useId().replace(/[^A-Za-z0-9_-]/gu, '');
  const layout = useMemo(() => layoutChangeMap(map), [map]);
  const width = layout.width + FLOW_PAD * 2;
  const height = layout.height + FLOW_PAD * 2;
  const scroller = useRef<HTMLDivElement>(null);
  const box = useBoxSize(scroller);
  const scale = natural || !box?.width ? 1 : Math.min(1, Math.max(READABLE_TEXT / SMALLEST_FLOW_TEXT, box.width / width));
  const playing = litPaths.size > 0;
  const lines = useMemo(() => new Map(layout.areas.flatMap(({ area }): [string, FileChange][] => {
    const counted = area.files.flatMap((file) => changes?.get(file) ?? []);
    return counted.length ? [[area.id, { additions: counted.reduce((sum, change) => sum + change.additions, 0), deletions: counted.reduce((sum, change) => sum + change.deletions, 0) }]] : [];
  })), [layout, changes]);
  const paths = useMemo(() => {
    const at = new Map(layout.areas.map((placed) => [placed.area.id, placed]));
    const taken = layout.areas.map(({ x, y }) => ({ left: x, top: y, right: x + AREA_WIDTH, bottom: y + AREA_HEIGHT }));
    const line = FLOW_TEXT.label * LABEL_LINE;
    return layout.paths.flatMap(({ path, from, to, passesOver }) => {
      const source = at.get(path.from);
      const target = at.get(path.to);
      if (!source || !target) return [];
      const start = { x: source.x + HANDLE_AT[from].x, y: source.y + HANDLE_AT[from].y };
      const end = { x: target.x + HANDLE_AT[to].x, y: target.y + HANDLE_AT[to].y };
      const [d, labelX, labelY] = getBezierPath({ sourceX: start.x, sourceY: start.y, sourcePosition: SIDE_POSITION[from], targetX: end.x, targetY: end.y, targetPosition: SIDE_POSITION[to] });
      const near: LabelPlace = { x: start.x + LABEL_NEAR[from].dx, y: start.y + LABEL_NEAR[from].dy, anchor: LABEL_NEAR[from].anchor };
      const nearTarget: LabelPlace = { x: end.x + LABEL_NEAR[to].dx, y: end.y + LABEL_NEAR[to].dy, anchor: LABEL_NEAR[to].anchor };
      const middle: LabelPlace = { x: labelX, y: labelY, anchor: 'middle' };
      // A label sits at the path's middle or, for a path whose middle lies on another area or when the middle is
      // taken, beside the area it leaves or the one it reaches: the first place a line or two up or down that covers
      // no area and no label placed before it.
      const width = path.label.length * FLOW_TEXT.label * LABEL_CHAR;
      const places = passesOver ? [near, nearTarget] : [middle, near, nearTarget];
      const candidates = places.flatMap((place) => LABEL_SHIFTS.map((shift) => {
        const left = place.anchor === 'start' ? place.x : place.anchor === 'end' ? place.x - width : place.x - width / 2;
        const y = place.y + shift * line;
        return { place: { ...place, y }, box: { left, right: left + width, top: y - line / 2, bottom: y + line / 2 } };
      }));
      const chosen = candidates.find(({ box }) => taken.every((other) => box.right <= other.left || other.right <= box.left || box.bottom <= other.top || other.bottom <= box.top)) ?? candidates[0];
      if (path.label && chosen) taken.push(chosen.box);
      const label = chosen?.place ?? near;
      return [{ path, d, label, lit: litPaths.has(path.id), faded: (playing && !litPaths.has(path.id)) || faded.has(path.from) || faded.has(path.to) }];
    });
  }, [layout, litPaths, faded, playing]);
  // The focused area is scrolled to the middle of the box.
  useEffect(() => {
    const element = scroller.current;
    const placed = layout.areas.find(({ area }) => area.id === focus);
    if (element && placed) element.scrollLeft = (placed.x + FLOW_PAD + AREA_WIDTH / 2) * scale - element.clientWidth / 2;
  }, [focus, layout, scale]);
  const drawing = <div className="relative" data-flow-scale={scale} style={{ width, height, transform: scale === 1 ? undefined : `scale(${scale})`, transformOrigin: '0 0' }}>
    <svg width={width} height={height} viewBox={`${-FLOW_PAD} ${-FLOW_PAD} ${width} ${height}`} className="absolute left-0 top-0" aria-hidden>
      <defs>{PATH_STATES.map((state) => <marker key={state} id={`${marker}-${state}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto">
        <path d="M0 0L10 5L0 10z" style={{ fill: PATH_COLOR[state] }} />
      </marker>)}</defs>
      {layout.packages.map((pkg) => <g key={pkg.name} data-package={pkg.name}>
        <rect x={pkg.x} y={pkg.y} width={pkg.width} height={pkg.height} rx={10} style={{ fill: 'var(--surface-1)', stroke: 'var(--border)', strokeDasharray: '4 4' }} />
        <text x={pkg.x + 12} y={pkg.y + 19} style={{ fill: 'var(--muted-foreground)', font: `500 ${FLOW_TEXT.label}px ui-monospace, monospace` }}>{pkg.name}</text>
      </g>)}
      {paths.map(({ path, d, lit, faded: dim }) => <g key={path.id} data-path={path.id} data-state={path.state} data-lit={lit} opacity={dim ? 0.2 : 1}>
        <path d={d} fill="none" markerEnd={`url(#${marker}-${path.state})`} style={{ stroke: PATH_COLOR[path.state], strokeWidth: lit ? 3 : path.state === 'same' ? 1.25 : 2, strokeDasharray: path.state === 'removed' ? '5 4' : undefined }} />
        {lit ? <circle r={4.5} style={{ fill: PATH_COLOR[path.state] }}><animateMotion dur="1.2s" repeatCount="indefinite" path={d} /></circle> : null}
      </g>)}
    </svg>
    {layout.areas.map(({ area, x, y }) => {
      const lit = litAreas.has(area.id);
      const change = lines.get(area.id);
      const changed = area.files.length > 0;
      return <div key={area.id} data-area={area.id} data-lit={lit} title={area.whatItDoes || undefined}
        className={`absolute flex flex-col gap-0.5 border px-3 py-2 text-left transition-opacity ${shape.container} ${changed ? 'bg-surface-3' : 'border-dashed bg-surface-1'}`}
        style={{
          left: x + FLOW_PAD, top: y + FLOW_PAD, width: AREA_WIDTH, height: AREA_HEIGHT, opacity: faded.has(area.id) || (playing && !lit) ? 0.35 : 1,
          borderColor: lit ? 'transparent' : changed ? `color-mix(in oklab, ${badgeColors.green} 50%, var(--border))` : 'var(--border)', boxShadow: lit ? `0 0 0 2px ${badgeColors.blue}` : undefined,
        }}>
        <span className="truncate font-medium leading-tight text-foreground" style={{ fontSize: FLOW_TEXT.name }}>{area.name}</span>
        <span className="truncate leading-tight text-muted-foreground" style={{ fontSize: FLOW_TEXT.detail }}>{area.whatItDoes || area.role || area.note}</span>
        <span className="mt-auto truncate font-mono leading-tight tabular-nums text-muted-foreground" style={{ fontSize: FLOW_TEXT.detail }}>
          {change ? <><span style={{ color: badgeColors.green }}>+{change.additions}</span> <span style={{ color: badgeColors.red }}>−{change.deletions}</span> · </> : null}
          {changed ? `${area.files.length} file${area.files.length === 1 ? '' : 's'}` : area.note ? 'no changed files' : 'context'}
        </span>
      </div>;
    })}
    <svg width={width} height={height} viewBox={`${-FLOW_PAD} ${-FLOW_PAD} ${width} ${height}`} className="pointer-events-none absolute left-0 top-0" aria-hidden>
      {paths.map(({ path, label: at, faded: dim }) => path.label ? <text key={path.id} x={at.x} y={at.y} textAnchor={at.anchor} dominantBaseline="middle" opacity={dim ? 0.2 : 1}
        style={{ ...HALO, fill: PATH_COLOR[path.state], font: `${FLOW_TEXT.label}px ui-monospace, monospace`, textDecoration: path.state === 'removed' ? 'line-through' : undefined }}>{path.label}</text> : null)}
    </svg>
  </div>;
  if (natural) return <div role="img" aria-label={label} className={`bg-surface-2 ${shape.container}`}>{drawing}</div>;
  return <div ref={scroller} role="region" aria-label={label} tabIndex={0} data-flow
    className={`w-full overflow-x-auto border border-border bg-surface-2 outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${shape.container}`}>
    <div className="mx-auto" style={{ width: width * scale, height: height * scale }}>{drawing}</div>
  </div>;
}

/** The colour key, and who made the map. */
function MapLegend({ map }: { map: ChangeMap }) {
  const packages = new Set(map.areas.map((area) => area.package)).size;
  return <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
    {PATH_STATES.map((state) => <span key={state} className="inline-flex items-center gap-1.5">
      <svg width="18" height="6" aria-hidden><line x1="0" y1="3" x2="18" y2="3" style={{ stroke: PATH_COLOR[state], strokeWidth: 2, strokeDasharray: state === 'removed' ? '4 3' : undefined }} /></svg>
      {state === 'added' ? 'new path' : state === 'removed' ? 'removed' : 'unchanged'}
    </span>)}
    <span className="inline-flex items-center gap-1 tabular-nums">{map.areas.length} area{map.areas.length === 1 ? '' : 's'} in {packages} package{packages === 1 ? '' : 's'}<Source by="agent" what="the areas, their packages and roles, and the paths between them" /><Source by="gitspace" what="where each area and path is drawn, and how tall each area stands: the lines its files change in the guide's diffs" /></span>
  </p>;
}

/** The whole map with its steps: play them, or step through; each step lights its areas and paths in the view shown
 * and names its section. The overview opens first unless the map is crowded; pressing an area there opens the flow
 * view on it. */
export function ChangeMapView({ map, sections, changes = null, onOpenSection, onStep }: {
  map: ChangeMap;
  /** The guide's sections in reading order, for numbering the section each step belongs to. */
  sections: readonly { id: string; title: string }[];
  /** The lines each file changes, once the guide's diffs are measured. */
  changes?: ReadonlyMap<string, FileChange> | null;
  onOpenSection?(sectionId: string): void;
  /** The section of the step shown, or null when no step is. */
  onStep?(sectionId: string | null): void;
}) {
  const [view, setView] = useState<'overview' | 'flow'>(() => map.areas.length > CROWDED_AREAS || new Set(map.areas.map((area) => area.package)).size > CROWDED_PACKAGES ? 'flow' : 'overview');
  const [focus, setFocus] = useState<string | null>(null);
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const steps = map.steps;
  const current = step === null ? null : steps[step] ?? null;
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (step === null || step + 1 >= steps.length) setPlaying(false);
      else setStep(step + 1);
    }, STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step, steps.length]);
  useEffect(() => { onStep?.(current?.sectionId ?? null); }, [current?.sectionId]);
  const litPaths = useMemo(() => new Set(current?.paths ?? []), [current]);
  const litAreas = useMemo(() => {
    if (!current) return new Set<string>();
    const lit = new Set([current.from, current.to]);
    for (const path of map.paths) if (litPaths.has(path.id)) { lit.add(path.from); lit.add(path.to); }
    return lit;
  }, [current, map.paths, litPaths]);
  const none = useMemo(() => new Set<string>(), []);
  const focused = useMemo(() => new Set(focus === null ? [] : [focus]), [focus]);
  const sectionIndex = current ? sections.findIndex((section) => section.id === current.sectionId) : -1;
  const play = (): void => {
    if (playing) { setPlaying(false); return; }
    setStep((value) => value === null || value + 1 >= steps.length ? 0 : value);
    setPlaying(true);
  };
  const openArea = (areaId: string): void => { setFocus(areaId); setView('flow'); };
  const flowLabel = 'The change map: the areas the change touches and the paths between them';
  return <div className="flex flex-col gap-2" data-map-view={view}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TabsSubtle size="compact" selectedIndex={view === 'overview' ? 0 : 1} onSelect={(index) => { setFocus(null); setView(index === 0 ? 'overview' : 'flow'); }} idPrefix="change-map-view" aria-label="Map view">
        <TabsSubtleItem index={0} label="Overview" /><TabsSubtleItem index={1} label="Flow" />
      </TabsSubtle>
      <MapLegend map={map} />
    </div>
    {view === 'overview'
      ? <Lightbox label="The change map, overview" mode="zoom" expanded={<IsoMap map={map} changes={changes} litPaths={litPaths} litAreas={litAreas} onOpenArea={openArea} natural />}>
        <IsoMap map={map} changes={changes} litPaths={litPaths} litAreas={litAreas} onOpenArea={openArea} />
      </Lightbox>
      : <Lightbox label="The change map, flow view" mode="zoom" expanded={<FlowMap map={map} changes={changes} litPaths={litPaths} litAreas={current ? litAreas : focused} faded={none} label={flowLabel} natural />}>
        <FlowMap map={map} changes={changes} litPaths={litPaths} litAreas={current ? litAreas : focused} faded={none} focus={focus} label={flowLabel} />
      </Lightbox>}
    {steps.length ? <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="compact" type="button" onClick={play}>{playing ? <PauseCircle width={14} height={14} /> : <Play width={14} height={14} />}{playing ? 'Pause' : 'Play the steps'}</Button>
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Previous step" disabled={step === null || step === 0} onClick={() => { setPlaying(false); setStep((value) => Math.max(0, (value ?? 0) - 1)); }}><ChevronLeft width={14} height={14} /></Button>
      <Button variant="ghost" size="icon-compact" type="button" aria-label="Next step" disabled={step === steps.length - 1} onClick={() => { setPlaying(false); setStep((value) => value === null ? 0 : Math.min(steps.length - 1, value + 1)); }}><ChevronRight width={14} height={14} /></Button>
      <span className="flex items-center gap-1">{steps.map((_, index) => <button key={index} type="button" aria-label={`Step ${index + 1}`} aria-current={index === step ? 'step' : undefined} onClick={() => { setPlaying(false); setStep(index); }}
        className="h-1.5 w-5 rounded-full" style={{ background: step !== null && index <= step ? badgeColors.green : 'var(--border)' }} />)}</span>
      <p className="basis-full text-caption text-muted-foreground" aria-live="polite">{current ? <>
        <span className="font-medium tabular-nums text-foreground">{(step ?? 0) + 1} / {steps.length} · </span>{current.caption}{' '}
        {sectionIndex >= 0 && onOpenSection ? <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => { setPlaying(false); onOpenSection(current.sectionId); }}>Read §{sectionIndex + 1} {sections[sectionIndex]!.title}</button> : sectionIndex >= 0 ? <span className="font-medium text-foreground">§{sectionIndex + 1} explains it.</span> : null}
      </> : `Play the ${steps.length} step${steps.length === 1 ? '' : 's'} the change takes through the map; each names the section that explains it.`}</p>
    </div> : null}
  </div>;
}

/** The map around the areas a section touches: those areas, the areas one path away (faded), and the paths among them. */
export function SectionMap({ map, focus }: { map: ChangeMap; focus: ReadonlySet<string> }) {
  const around = useMemo(() => mapAround(map, focus), [map, focus]);
  const faded = useMemo(() => new Set(around.areas.filter((area) => !focus.has(area.id)).map((area) => area.id)), [around, focus]);
  const none = useMemo(() => new Set<string>(), []);
  const label = "The change map around this section's areas";
  return <Lightbox label={label} mode="zoom" expanded={<FlowMap map={around} changes={null} litPaths={none} litAreas={none} faded={faded} label={label} natural />}>
    <FlowMap map={around} changes={null} litPaths={none} litAreas={none} faded={faded} label={label} />
  </Lightbox>;
}
