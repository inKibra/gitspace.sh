// Where GitSpace draws a Change Guide's map. The agent names areas, their packages and the paths between them, never
// positions. The map is placed as the code stands after the change (removed paths are drawn, but do not place
// anything): each package is a column, in the order whose paths pass over the fewest areas and run right to left the
// least; inside a column, areas stack by how far along the paths they sit. The same map always lays out the same way.
import type { ChangeMap } from '@gitspace/protocol';

export const AREA_WIDTH = 208;
export const AREA_HEIGHT = 72;
const AREA_GAP = 24;
const PACKAGE_PAD = 16;
const PACKAGE_HEAD = 30;
const PACKAGE_GAP = 80;
/** Up to this many packages, every column order is tried; past it, columns keep the order of their first area. */
const ORDERED_PACKAGES = 7;

export type MapArea = ChangeMap['areas'][number];
export type MapPath = ChangeMap['paths'][number];
export type MapSide = 'top' | 'right' | 'bottom' | 'left';

export interface PlacedPackage { name: string; x: number; y: number; width: number; height: number }
export interface PlacedArea { area: MapArea; layer: number; x: number; y: number }
/** `passesOver`: the path crosses a column between its two areas, where its middle would sit on another area. */
export interface PlacedPath { path: MapPath; from: MapSide; to: MapSide; passesOver: boolean }
export interface ChangeMapLayout {
  packages: PlacedPackage[];
  /** Every area, positioned absolutely, in the map's order. */
  areas: PlacedArea[];
  /** Every path whose two areas are on the map, with the sides it leaves and enters by. */
  paths: PlacedPath[];
  width: number;
  height: number;
}

/** Each area's depth: the longest run of paths reaching it. A removed path does not count, nor does a path that
 * closes a cycle (found walking the map in its own order), so a cycle still lays out. */
function depths(map: ChangeMap): Map<string, number> {
  const outgoing = new Map<string, string[]>(map.areas.map((area) => [area.id, []]));
  for (const path of map.paths) if (path.state !== 'removed') outgoing.get(path.from)?.push(path.to);
  const forward = new Map<string, string[]>(map.areas.map((area) => [area.id, []]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const finished: string[] = [];
  const visit = (id: string): void => {
    visiting.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (visiting.has(next) || !outgoing.has(next)) continue;
      forward.get(id)?.push(next);
      if (!done.has(next)) visit(next);
    }
    visiting.delete(id);
    done.add(id);
    finished.push(id);
  };
  for (const area of map.areas) if (!done.has(area.id)) visit(area.id);
  const depth = new Map<string, number>(map.areas.map((area) => [area.id, 0]));
  for (const id of finished.reverse()) {
    const own = depth.get(id) ?? 0;
    for (const next of forward.get(id) ?? []) depth.set(next, Math.max(depth.get(next) ?? 0, own + 1));
  }
  return depth;
}

/** How badly an order of package columns draws the paths that stay: each column a path passes over costs the areas
 * in it, and a path drawn right to left costs one more. */
function columnCost(order: readonly number[], sizes: readonly number[], links: readonly (readonly [number, number])[]): number {
  const at = new Array<number>(order.length);
  order.forEach((column, position) => { at[column] = position; });
  let cost = 0;
  for (const [from, to] of links) {
    const start = at[from]!;
    const end = at[to]!;
    if (end < start) cost += 1;
    for (let position = Math.min(start, end) + 1; position < Math.max(start, end); position += 1) cost += sizes[order[position]!]!;
  }
  return cost;
}

/** The cheapest order of the columns; among equally cheap ones, the first in the columns' own order. */
function orderColumns(sizes: readonly number[], links: readonly (readonly [number, number])[]): number[] {
  const own = sizes.map((_, index) => index);
  if (sizes.length > ORDERED_PACKAGES || !links.length) return own;
  let best = own;
  let bestCost = columnCost(own, sizes, links);
  const permute = (prefix: number[], rest: number[]): void => {
    if (!rest.length) {
      const cost = columnCost(prefix, sizes, links);
      if (cost < bestCost) { best = prefix; bestCost = cost; }
      return;
    }
    rest.forEach((column, index) => permute([...prefix, column], [...rest.slice(0, index), ...rest.slice(index + 1)]));
  };
  permute([], own);
  return best;
}

/** The sides a path leaves and enters by: across columns left to right (or back), within a column down (or up). */
function sides(from: PlacedArea, to: PlacedArea): { from: MapSide; to: MapSide } {
  if (from.area.package === to.area.package) return from.y <= to.y ? { from: 'bottom', to: 'top' } : { from: 'top', to: 'bottom' };
  return from.x <= to.x ? { from: 'right', to: 'left' } : { from: 'left', to: 'right' };
}

export function layoutChangeMap(map: ChangeMap): ChangeMapLayout {
  const depth = depths(map);
  const order = new Map(map.areas.map((area, index) => [area.id, index]));
  const byPackage = new Map<string, MapArea[]>();
  for (const area of map.areas) byPackage.set(area.package, [...byPackage.get(area.package) ?? [], area]);
  const rank = (area: MapArea): [number, number] => [depth.get(area.id) ?? 0, order.get(area.id) ?? 0];
  const before = (left: [number, number], right: [number, number]): number => left[0] - right[0] || left[1] - right[1];
  const byDepth = [...byPackage.entries()]
    .map(([name, areas]) => ({ name, areas: [...areas].sort((left, right) => before(rank(left), rank(right))) }))
    .sort((left, right) => before(rank(left.areas[0]!), rank(right.areas[0]!)));
  const columnOf = new Map<string, number>(byDepth.flatMap((column, index) => column.areas.map((area): [string, number] => [area.id, index])));
  const links = map.paths.flatMap((path): [number, number][] => {
    const from = columnOf.get(path.from);
    const to = columnOf.get(path.to);
    return path.state !== 'removed' && from !== undefined && to !== undefined && from !== to ? [[from, to]] : [];
  });
  const columns = orderColumns(byDepth.map((column) => column.areas.length), links).map((index) => byDepth[index]!);
  const packages: PlacedPackage[] = [];
  const placed = new Map<string, PlacedArea>();
  // Each column after the first stacks its areas level with the areas they are linked to on its left, so paths run
  // straight across where they can; areas linked to nothing on the left keep their depth order below them.
  const row = new Map<string, number>();
  const level = (area: MapArea): number => {
    const rows = map.paths.flatMap((path) => path.state === 'removed' ? [] : path.from === area.id ? row.get(path.to) ?? [] : path.to === area.id ? row.get(path.from) ?? [] : []);
    return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : Number.POSITIVE_INFINITY;
  };
  let x = 0;
  for (const column of columns) {
    const stacked = [...column.areas].sort((left, right) => (level(left) - level(right)) || before(rank(left), rank(right)));
    const width = AREA_WIDTH + PACKAGE_PAD * 2;
    const height = PACKAGE_HEAD + stacked.length * AREA_HEIGHT + (stacked.length - 1) * AREA_GAP + PACKAGE_PAD;
    packages.push({ name: column.name, x, y: 0, width, height });
    for (const [index, area] of stacked.entries()) {
      placed.set(area.id, { area, layer: depth.get(area.id) ?? 0, x: x + PACKAGE_PAD, y: PACKAGE_HEAD + index * (AREA_HEIGHT + AREA_GAP) });
      row.set(area.id, index);
    }
    x += width + PACKAGE_GAP;
  }
  const areas = map.areas.flatMap((area) => placed.get(area.id) ?? []);
  const paths = map.paths.flatMap((path) => {
    const from = placed.get(path.from);
    const to = placed.get(path.to);
    return from && to && from !== to ? [{ path, ...sides(from, to), passesOver: Math.abs(from.x - to.x) > AREA_WIDTH + PACKAGE_PAD * 2 + PACKAGE_GAP }] : [];
  });
  return { packages, areas, paths, width: Math.max(0, x - PACKAGE_GAP), height: Math.max(0, ...packages.map((pkg) => pkg.height)) };
}

/** The part of the map around some areas: them, the areas one path away, and the paths among those. */
export function mapAround(map: ChangeMap, focus: ReadonlySet<string>): ChangeMap {
  const near = new Set(focus);
  for (const path of map.paths) {
    if (focus.has(path.from)) near.add(path.to);
    if (focus.has(path.to)) near.add(path.from);
  }
  return {
    areas: map.areas.filter((area) => near.has(area.id)),
    paths: map.paths.filter((path) => near.has(path.from) && near.has(path.to)),
    steps: [],
  };
}

/** The areas whose files a set of repository paths touch. */
export function areasTouching(map: ChangeMap, paths: readonly string[]): Set<string> {
  const touched = new Set(paths);
  return new Set(map.areas.filter((area) => area.files.some((file) => touched.has(file))).map((area) => area.id));
}
