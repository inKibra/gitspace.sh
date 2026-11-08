// The change map's isometric overview, projected from the flat layout (map-layout.ts): each package column becomes a
// plate along the plane's first axis, and each area a box on its plate at the row the flat layout gave it. A box's
// height grows with the lines its files change, as far as the guide's diffs measured them. The same map and the same
// counts always project the same way.
import type { ChangeMapLayout, MapArea, MapPath } from './map-layout.js';

/** Lines one file adds and removes between the guide's base and head. */
export interface FileChange { additions: number; deletions: number }

/** A box's side on the plane, and the gap between rows and between package plates, in plane units. */
const FOOT = 2;
const ROW_PITCH = 3.2;
const PLATE_PAD = 0.7;
const PLATE_GAP = 1.8;
const COLUMN_PITCH = FOOT + PLATE_PAD * 2 + PLATE_GAP;
/** Pixels per plane unit, and per unit of height. */
const SCALE = 28;
const RISE = SCALE * 0.82;
const COS = Math.cos(Math.PI / 6);
/** Box heights in plane units: an area with no changed files lies flat; one whose lines are not measured stands at a
 * uniform height; measured ones run from LOW to TALL by the square root of their share of the most changed area. */
const FLAT = 0.12;
const UNIFORM = 1.2;
const LOW = 0.45;
const TALL = 3.2;
/** How far apart, in pixels, paths between the same two areas bow. */
const BEND = 22;
/** Room around the drawing, and where labels sit, in pixels. */
const MARGIN = 14;
const NAME_RISE = 7;
const PLATE_LABEL_DROP = 16;
const PATH_LABEL_RISE = 7;
/** Each kind of label: its size on screen and about how wide one of its characters is, in pixels, and where else it
 * may go when its place is taken, in lines up (negative) or down, in the order tried. */
export const ISO_LABEL: Record<IsoLabel['kind'], { size: number; char: number; shifts: readonly number[] }> = {
  name: { size: 12, char: 6, shifts: [0, -1, -2, 1] },
  count: { size: 11, char: 6.4, shifts: [0] },
  plate: { size: 11, char: 6.4, shifts: [0, 1, -1] },
  path: { size: 11, char: 6.6, shifts: [0, -1, 1, -2, 2] },
};
/** A label's line height, and the room kept between two labels, as shares of its size. */
const LABEL_LINE = 1.2;
const LABEL_GAP = 0.2;

export interface IsoPoint { x: number; y: number }
/** A rectangle on the plane: its corner nearest the back, and its sides along the two axes. */
export interface IsoFootprint { u: number; v: number; w: number; d: number }
export interface IsoPlate { name: string; column: number; footprint: IsoFootprint; corners: IsoPoint[]; label: IsoPoint }
export interface IsoBox {
  area: MapArea;
  column: number;
  footprint: IsoFootprint;
  /** Lines added and removed in the area's files that the diffs measured; null when none of its files were. */
  lines: number | null;
  height: number;
  top: IsoPoint[];
  left: IsoPoint[];
  right: IsoPoint[];
  /** Where the name sits (over the box's back corner), the middle of its top, and the middle of its base. */
  name: IsoPoint;
  middle: IsoPoint;
  ground: IsoPoint;
}
export interface IsoPath { path: MapPath; d: string; label: IsoPoint }
export interface IsoMapLayout {
  plates: IsoPlate[];
  /** Back to front, the order they are painted in. */
  boxes: IsoBox[];
  paths: IsoPath[];
  /** The drawing's bounds, for its view box. */
  x: number;
  y: number;
  width: number;
  height: number;
}

function project(u: number, v: number, z: number): IsoPoint {
  return { x: (u - v) * COS * SCALE, y: (u + v) * 0.5 * SCALE - z * RISE };
}

function face(footprint: IsoFootprint, z: number): IsoPoint[] {
  const { u, v, w, d } = footprint;
  return [project(u, v, z), project(u + w, v, z), project(u + w, v + d, z), project(u, v + d, z)];
}

export function projectIsoMap(layout: ChangeMapLayout, changes: ReadonlyMap<string, FileChange> | null): IsoMapLayout {
  const measured = new Map<string, number>();
  if (changes) {
    for (const { area } of layout.areas) {
      const counted = area.files.flatMap((file) => changes.get(file) ?? []);
      if (counted.length) measured.set(area.id, counted.reduce((sum, change) => sum + change.additions + change.deletions, 0));
    }
  }
  const most = Math.max(1, ...measured.values());
  const rows = new Map<number, number>();
  for (const placed of layout.areas) rows.set(placed.column, Math.max(rows.get(placed.column) ?? 0, placed.row + 1));
  const plates = layout.packages.map((pkg, column): IsoPlate => {
    const footprint = { u: column * COLUMN_PITCH, v: 0, w: FOOT + PLATE_PAD * 2, d: FOOT + PLATE_PAD * 2 + Math.max(0, (rows.get(column) ?? 1) - 1) * ROW_PITCH };
    const edge = project(footprint.u + footprint.w / 2, footprint.d, 0);
    return { name: pkg.name, column, footprint, corners: face(footprint, 0), label: { x: edge.x, y: edge.y + PLATE_LABEL_DROP } };
  });
  const boxes = layout.areas.map(({ area, column, row }): IsoBox => {
    const footprint = { u: column * COLUMN_PITCH + PLATE_PAD, v: PLATE_PAD + row * ROW_PITCH, w: FOOT, d: FOOT };
    const lines = measured.get(area.id) ?? null;
    const height = !area.files.length ? FLAT : lines === null ? UNIFORM : LOW + (TALL - LOW) * Math.sqrt(lines / most);
    const { u, v, w, d } = footprint;
    const top = face(footprint, height);
    const back = top[0]!;
    return {
      area, column, footprint, lines, height, top,
      left: [project(u, v + d, 0), project(u + w, v + d, 0), project(u + w, v + d, height), project(u, v + d, height)],
      right: [project(u + w, v, 0), project(u + w, v + d, 0), project(u + w, v + d, height), project(u + w, v, height)],
      name: { x: back.x, y: back.y - NAME_RISE },
      middle: project(u + w / 2, v + d / 2, height),
      ground: project(u + w / 2, v + d / 2, 0),
    };
  }).sort((left, right) => (left.footprint.u + left.footprint.v) - (right.footprint.u + right.footprint.v) || left.footprint.u - right.footprint.u);
  const at = new Map(boxes.map((box) => [box.area.id, box]));
  // Paths run along the ground between box centres; a second path between the same two areas bows to one side, a
  // third to the other, and so on.
  const between = new Map<string, number>();
  const paths = layout.paths.flatMap(({ path }): IsoPath[] => {
    const from = at.get(path.from);
    const to = at.get(path.to);
    if (!from || !to) return [];
    const [first, second] = path.from < path.to ? [from, to] : [to, from];
    const pair = `${first.area.id}\n${second.area.id}`;
    const index = between.get(pair) ?? 0;
    between.set(pair, index + 1);
    const a = from.ground;
    const b = to.ground;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const offset = Math.ceil(index / 2) * BEND * (index % 2 ? 1 : -1);
    const along = { x: second.ground.x - first.ground.x, y: second.ground.y - first.ground.y };
    const length = Math.hypot(along.x, along.y) || 1;
    const bow = { x: mid.x - (along.y / length) * offset, y: mid.y + (along.x / length) * offset };
    const control = { x: 2 * bow.x - mid.x, y: 2 * bow.y - mid.y };
    // Drawn in two halves, so the arrow at their joint points along the path.
    const d = offset === 0
      ? `M${a.x} ${a.y}L${mid.x} ${mid.y}L${b.x} ${b.y}`
      : `M${a.x} ${a.y}Q${(a.x + control.x) / 2} ${(a.y + control.y) / 2} ${bow.x} ${bow.y}Q${(control.x + b.x) / 2} ${(control.y + b.y) / 2} ${b.x} ${b.y}`;
    return [{ path, d, label: { x: bow.x, y: bow.y - PATH_LABEL_RISE } }];
  });
  const spans = [
    ...plates.flatMap((plate) => [...plate.corners.map((point) => ({ point, half: 0 })), { point: plate.label, half: (plate.name.length * ISO_LABEL.plate.char) / 2 }]),
    ...boxes.flatMap((box) => [...box.left, ...box.right].map((point) => ({ point, half: 0 })).concat({ point: { x: box.name.x, y: box.name.y - 10 }, half: (box.area.name.length * ISO_LABEL.name.char) / 2 })),
    ...paths.map((drawn) => ({ point: drawn.label, half: (drawn.path.label.length * ISO_LABEL.path.char) / 2 })),
  ];
  const x = Math.min(...spans.map(({ point, half }) => point.x - half)) - MARGIN;
  const y = Math.min(...spans.map(({ point }) => point.y)) - MARGIN;
  const right = Math.max(...spans.map(({ point, half }) => point.x + half)) + MARGIN;
  const bottom = Math.max(...spans.map(({ point }) => point.y)) + MARGIN;
  return { plates, boxes, paths, x, y, width: right - x, height: bottom - y };
}

/** A label of the overview: an area's name, the lines or "context" on its box's top, a package's name or a path's label
 * (`of` names the area, package or path), where it is drawn and how large, in drawing units, and whether it is drawn. */
export interface IsoLabel { kind: 'name' | 'count' | 'plate' | 'path'; of: string; text: string; x: number; y: number; size: number; shown: boolean }

type IsoLabelPlace = Omit<IsoLabel, 'size' | 'shown'>;

/** The overview's labels for a drawing shown at `scale` screen pixels per drawing unit, each at its size on screen. A
 * box's count is drawn only where it fits on the box's top. Any other label is kept inside the drawing and moved a line
 * or two where it would cover a label placed before it (counts first, then area names, packages and paths); one with
 * nowhere left to go is hidden. */
export function placeIsoLabels(layout: IsoMapLayout, scale: number): IsoLabel[] {
  const counts = layout.boxes.flatMap((box): IsoLabelPlace[] => {
    const text = !box.area.files.length ? 'context' : box.lines === null ? '' : String(box.lines);
    const top = Math.max(...box.top.map((point) => point.x)) - Math.min(...box.top.map((point) => point.x));
    const fits = text && (text.length * ISO_LABEL.count.char) / scale < top * 0.8;
    return fits ? [{ kind: 'count', of: box.area.id, text, x: box.middle.x, y: box.middle.y + (ISO_LABEL.count.size / scale) * 0.35 }] : [];
  });
  const wanted = [
    ...counts,
    ...layout.boxes.map((box): IsoLabelPlace => ({ kind: 'name', of: box.area.id, text: box.area.name, x: box.name.x, y: box.name.y })),
    ...layout.plates.map((plate): IsoLabelPlace => ({ kind: 'plate', of: plate.name, text: plate.name, x: plate.label.x, y: plate.label.y })),
    ...layout.paths.filter((drawn) => drawn.path.label).map((drawn): IsoLabelPlace => ({ kind: 'path', of: drawn.path.id, text: drawn.path.label, x: drawn.label.x, y: drawn.label.y })),
  ];
  const taken: { left: number; top: number; right: number; bottom: number }[] = [];
  return wanted.map((label): IsoLabel => {
    const { size: pixels, char, shifts } = ISO_LABEL[label.kind];
    const size = pixels / scale;
    const half = (label.text.length * char) / scale / 2;
    const gap = size * LABEL_GAP;
    const x = half * 2 >= layout.width ? layout.x + layout.width / 2 : Math.min(layout.x + layout.width - half, Math.max(layout.x + half, label.x));
    for (const shift of shifts) {
      const y = Math.min(layout.y + layout.height - size * (LABEL_LINE - 1), Math.max(layout.y + size, label.y + shift * size * LABEL_LINE));
      const box = { left: x - half, top: y - size, right: x + half, bottom: y + size * (LABEL_LINE - 1) };
      const clear = taken.every((other) => box.right + gap <= other.left || other.right + gap <= box.left || box.bottom + gap <= other.top || other.bottom + gap <= box.top);
      if (clear) {
        taken.push(box);
        return { ...label, x, y, size, shown: true };
      }
    }
    return { ...label, size, shown: false };
  });
}
