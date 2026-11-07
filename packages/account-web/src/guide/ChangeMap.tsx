// The Change Guide's map, in two views. The overview (IsoMap.tsx) draws each package as a plate and each area as a box
// as tall as the lines its files change; the flow view draws packages as columns and areas as boxes in them. In both,
// paths between areas are green when the change adds them, red and dashed when it removes them, grey when they stay.
// The agent names the areas, paths and steps; GitSpace lays them out (map-layout.ts, iso-layout.ts). Playing the
// steps lights each step's areas and paths in either view and names the section that explains it.
import type { ChangeMap } from '@gitspace/protocol';
import { Button, TabsSubtle, TabsSubtleItem, badgeColors, useShape } from '@gitspace/ui';
import { ChevronLeft, ChevronRight, PauseCircle, Play } from '@untitledui/icons';
import { Handle, MarkerType, Position, ReactFlow, getBezierPath, type Edge, type EdgeProps, type FitViewOptions, type Node, type NodeProps, type ProOptions, type ReactFlowInstance } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useDarkScheme } from '../appearance.js';
import { Source } from './Authorship.js';
import type { FileChange } from './iso-layout.js';
import { IsoMap, PATH_COLOR, PATH_STATES } from './IsoMap.js';
import { AREA_HEIGHT, AREA_WIDTH, layoutChangeMap, mapAround, type MapArea, type MapPath, type MapSide } from './map-layout.js';

const STEP_MS = 2400;
const FIT: FitViewOptions = { padding: 0.04, maxZoom: 1 };
const PRO_OPTIONS: ProOptions = { hideAttribution: true };
/** Past this many areas or packages, the map opens in the flow view. */
const CROWDED_AREAS = 12;
const CROWDED_PACKAGES = 5;
const SIDE_POSITION: Record<MapSide, Position> = { top: Position.Top, right: Position.Right, bottom: Position.Bottom, left: Position.Left };
const SIDES: readonly MapSide[] = ['top', 'right', 'bottom', 'left'];
const HANDLE_TYPES: readonly ('source' | 'target')[] = ['source', 'target'];
const HIDDEN_HANDLE: CSSProperties = { opacity: 0, width: 1, height: 1, minWidth: 0, minHeight: 0, border: 'none', pointerEvents: 'none' };
/** Where each side's handle sits on an area box, for edges drawn before the browser measures the box. */
const HANDLE_AT: Record<MapSide, { x: number; y: number }> = { top: { x: AREA_WIDTH / 2, y: 0 }, right: { x: AREA_WIDTH, y: AREA_HEIGHT / 2 }, bottom: { x: AREA_WIDTH / 2, y: AREA_HEIGHT }, left: { x: 0, y: AREA_HEIGHT / 2 } };

type PackageNode = Node<{ name: string }, 'package'>;
type AreaNode = Node<{ area: MapArea; lit: boolean; faded: boolean }, 'area'>;
type PathEdge = Edge<{ path: MapPath; lit: boolean; faded: boolean; passesOver: boolean }, 'path'>;
/** Where a label sits beside the area a path leaves, for a path whose middle lies on another area. */
const LABEL_NEAR: Record<Position, { dx: number; dy: number; anchor: 'start' | 'end' }> = {
  [Position.Right]: { dx: 10, dy: -9, anchor: 'start' }, [Position.Left]: { dx: -10, dy: -9, anchor: 'end' },
  [Position.Bottom]: { dx: 8, dy: 12, anchor: 'start' }, [Position.Top]: { dx: 8, dy: -12, anchor: 'start' },
};

function PackageNodeView({ data }: NodeProps<PackageNode>) {
  const shape = useShape();
  return <div className={`h-full w-full border border-dashed border-border bg-surface-1 px-3 pt-2 ${shape.container}`}>
    <span className="block truncate font-mono text-caption font-medium text-muted-foreground">{data.name}</span>
  </div>;
}

function AreaNodeView({ data }: NodeProps<AreaNode>) {
  const shape = useShape();
  const { area } = data;
  return <div data-area={area.id} data-lit={data.lit} title={area.whatItDoes || undefined}
    className={`flex flex-col gap-0.5 border bg-surface-3 px-3 py-2 text-left transition-opacity ${shape.container} ${data.lit ? 'border-transparent' : 'border-border'}`}
    style={{ width: AREA_WIDTH, height: AREA_HEIGHT, opacity: data.faded ? 0.35 : 1, boxShadow: data.lit ? `0 0 0 2px ${badgeColors.blue}` : undefined }}>
    {SIDES.flatMap((side) => [
      <Handle key={`${side}-source`} id={`${side}-source`} type="source" position={SIDE_POSITION[side]} isConnectable={false} style={HIDDEN_HANDLE} />,
      <Handle key={`${side}-target`} id={`${side}-target`} type="target" position={SIDE_POSITION[side]} isConnectable={false} style={HIDDEN_HANDLE} />,
    ])}
    <span className="truncate text-body font-medium text-foreground">{area.name}</span>
    <span className="line-clamp-1 text-caption text-muted-foreground">{area.role || area.note}</span>
    <span className="mt-auto text-caption tabular-nums text-muted-foreground">{area.files.length ? `${area.files.length} file${area.files.length === 1 ? '' : 's'}` : area.note ? 'no changed files' : 'context'}</span>
  </div>;
}

function PathEdgeView({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, data }: EdgeProps<PathEdge>) {
  const [d, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  if (!data) return null;
  const { path, lit, faded, passesOver } = data;
  const color = PATH_COLOR[path.state];
  const near = LABEL_NEAR[sourcePosition];
  const label: { x: number; y: number; anchor: 'start' | 'middle' | 'end' } = passesOver ? { x: sourceX + near.dx, y: sourceY + near.dy, anchor: near.anchor } : { x: labelX, y: labelY, anchor: 'middle' };
  return <g data-path={path.id} data-state={path.state} data-lit={lit} opacity={faded ? 0.2 : 1}>
    <path id={id} d={d} fill="none" markerEnd={markerEnd} style={{ stroke: color, strokeWidth: lit ? 3 : path.state === 'same' ? 1.25 : 2, strokeDasharray: path.state === 'removed' ? '5 4' : undefined }} />
    {path.label ? <text x={label.x} y={label.y} textAnchor={label.anchor} dominantBaseline="middle"
      style={{ fill: color, font: '11px ui-monospace, monospace', stroke: 'var(--surface-2)', strokeWidth: 4, paintOrder: 'stroke' }}>{path.label}</text> : null}
    {lit ? <circle r={4.5} style={{ fill: color }}><animateMotion dur="1.2s" repeatCount="indefinite" path={d} /></circle> : null}
  </g>;
}

const nodeTypes = { package: PackageNodeView, area: AreaNodeView };
const edgeTypes = { path: PathEdgeView };

/** The map drawn: `lit` paths and areas stand out and the rest fade; `faded` areas fade on their own. With `focus`,
 * the view fits that area and the areas one path away instead of the whole map. */
function MapCanvas({ map, litPaths, litAreas, faded, label, focus = null }: { map: ChangeMap; litPaths: ReadonlySet<string>; litAreas: ReadonlySet<string>; faded: ReadonlySet<string>; label: string; focus?: string | null }) {
  const shape = useShape();
  // React Flow marks its canvas light or dark, and the theme's tokens resolve again under that class.
  const dark = useDarkScheme();
  const layout = useMemo(() => layoutChangeMap(map), [map]);
  const playing = litPaths.size > 0;
  const nodes = useMemo(() => [
    ...layout.packages.map((pkg, index): PackageNode => ({ id: `package:${index}`, type: 'package', position: { x: pkg.x, y: pkg.y }, width: pkg.width, height: pkg.height, data: { name: pkg.name }, selectable: false, draggable: false, zIndex: 0 })),
    ...layout.areas.map(({ area, x, y }): AreaNode => ({
      id: area.id, type: 'area', position: { x, y }, width: AREA_WIDTH, height: AREA_HEIGHT, selectable: false, draggable: false, zIndex: 2,
      handles: SIDES.flatMap((side) => HANDLE_TYPES.map((type) => ({ id: `${side}-${type}`, type, position: SIDE_POSITION[side], ...HANDLE_AT[side], width: 1, height: 1 }))),
      data: { area, lit: litAreas.has(area.id), faded: faded.has(area.id) || (playing && !litAreas.has(area.id)) },
    })),
  ], [layout, litAreas, faded, playing]);
  // Paths run under the areas: one that crosses a column passes behind the areas in it.
  const edges = useMemo(() => layout.paths.map(({ path, from, to, passesOver }): PathEdge => ({
    id: `path:${path.id}`, type: 'path', source: path.from, target: path.to, sourceHandle: `${from}-source`, targetHandle: `${to}-target`, zIndex: 1, selectable: false, focusable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: PATH_COLOR[path.state], width: 14, height: 14 },
    data: { path, passesOver, lit: litPaths.has(path.id), faded: (playing && !litPaths.has(path.id)) || faded.has(path.from) || faded.has(path.to) },
  })), [layout, litPaths, faded, playing]);
  const fit = useMemo((): FitViewOptions => {
    if (focus === null) return FIT;
    const near = new Set([focus]);
    for (const path of map.paths) {
      if (path.from === focus) near.add(path.to);
      if (path.to === focus) near.add(path.from);
    }
    return { ...FIT, nodes: [...near].map((id) => ({ id })) };
  }, [map.paths, focus]);
  const pad = 48;
  const host = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<PackageNode | AreaNode, PathEdge> | null>(null);
  // The box follows the pane's width; the map is fitted to it again whenever it changes size.
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(() => { void flow.current?.fitView(fit); });
    observer.observe(element);
    return () => observer.disconnect();
  }, [fit]);
  // FLUID-GAP: node graph canvas — @xyflow/react draws the canvas and edges; the area and package chrome is ours.
  return <div ref={host} role="img" aria-label={label} className={`max-h-[480px] min-h-[180px] w-full overflow-hidden border border-border bg-surface-2 ${shape.container}`} style={{ aspectRatio: `${layout.width + pad} / ${layout.height + pad}` }}>
    <ReactFlow<PackageNode | AreaNode, PathEdge> nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes} onInit={(instance) => { flow.current = instance; }} colorMode={dark ? 'dark' : 'light'}
      style={{ background: 'transparent' }} width={layout.width + pad} height={layout.height + pad} fitView fitViewOptions={fit} minZoom={0.15} maxZoom={1.5} proOptions={PRO_OPTIONS}
      nodesDraggable={false} nodesConnectable={false} nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
      zoomOnScroll={false} zoomOnDoubleClick={false} preventScrolling={false} />
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
  return <div className="flex flex-col gap-2" data-map-view={view}>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <TabsSubtle size="compact" selectedIndex={view === 'overview' ? 0 : 1} onSelect={(index) => { setFocus(null); setView(index === 0 ? 'overview' : 'flow'); }} idPrefix="change-map-view" aria-label="Map view">
        <TabsSubtleItem index={0} label="Overview" /><TabsSubtleItem index={1} label="Flow" />
      </TabsSubtle>
      <MapLegend map={map} />
    </div>
    {view === 'overview'
      ? <IsoMap map={map} changes={changes} litPaths={litPaths} litAreas={litAreas} onOpenArea={(areaId) => { setFocus(areaId); setView('flow'); }} />
      : <MapCanvas map={map} litPaths={litPaths} litAreas={current ? litAreas : focused} faded={none} focus={focus} label="The change map: the areas the change touches and the paths between them" />}
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
  return <MapCanvas map={around} litPaths={none} litAreas={none} faded={faded} label="The change map around this section's areas" />;
}
