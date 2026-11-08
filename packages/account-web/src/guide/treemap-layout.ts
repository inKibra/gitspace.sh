// Where the "Where it changed" treemap draws the files a Change Guide shows: each package a rectangle as large as the
// lines its files change, and in it a tile per file as large as that file's lines, squarified (Bruls, Huizing and van
// Wijk) so tiles stay near square. A package's files too small to read share one tile that says how many they are. The
// same files at the same size always lay out the same way.
import type { ChangeGuideSection, ChangeMap } from '@gitspace/protocol';
import type { FileChange } from './iso-layout.js';

/** The height of a package's name row, in pixels. */
export const TREEMAP_HEADER = 22;
/** The gap inside a package's border, in pixels. */
const INSET = 2;
/** A file's tile smaller than this, in square pixels, is too small to read; two or more of them share one tile. */
export const SMALLEST_TILE = 64 * 40;
/** A package shows its name row when it is at least this wide and twice as tall as the row. */
const HEADER_WIDTH = 64;
/** Test files, by the rule account-machine's change guide analysis uses. */
const TEST_FILE = /(\.test\.|\.spec\.|__tests__\/)/u;
/** How many leading folders a file no map area lists must share with a mapped file to take its package. */
const NEAR_FOLDERS = 2;

export interface Rect { x: number; y: number; w: number; h: number }

/** A file the guide shows: its package (null when it has none, see guideFiles), and the first section in reading order
 * that shows it. */
export interface GuideFile {
  path: string;
  package: string | null;
  section: { id: string; index: number; title: string; kind: ChangeGuideSection['kind'] };
  test: boolean;
}
export type ChangedFile = GuideFile & FileChange;

/** One file's tile, or the tile a package's smallest files share. */
export interface TreemapTile { rect: Rect; files: readonly ChangedFile[]; additions: number; deletions: number }
export interface TreemapPackage { name: string | null; rect: Rect; additions: number; deletions: number; header: boolean; tiles: TreemapTile[] }

function linesOf(files: readonly FileChange[]): number {
  return files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
}

/** How badly a row of areas laid along a side of `side` pixels keeps its rectangles square: the worst aspect ratio. */
function worst(areas: readonly number[], side: number): number {
  const sum = areas.reduce((total, area) => total + area, 0);
  return Math.max(...areas.map((area) => Math.max((side * side * area) / (sum * sum), (sum * sum) / (side * side * area))));
}

/** Rectangles for `items` in `rect`, each as large as its value: largest first, rows along the shorter free side, a row
 * growing while that keeps its rectangles squarer. */
function squarify<T>(items: readonly { value: number; item: T }[], rect: Rect): { rect: Rect; item: T }[] {
  const total = items.reduce((sum, entry) => sum + entry.value, 0);
  if (total <= 0 || rect.w <= 0 || rect.h <= 0) return [];
  const sorted = [...items].sort((left, right) => right.value - left.value).map((entry) => ({ area: (entry.value / total) * rect.w * rect.h, item: entry.item }));
  const placed: { rect: Rect; item: T }[] = [];
  let free = rect;
  let row: typeof sorted = [];
  const lay = (): void => {
    const sum = row.reduce((total, entry) => total + entry.area, 0);
    if (free.w >= free.h) {
      const width = sum / free.h;
      let y = free.y;
      for (const entry of row) { const height = entry.area / width; placed.push({ rect: { x: free.x, y, w: width, h: height }, item: entry.item }); y += height; }
      free = { x: free.x + width, y: free.y, w: free.w - width, h: free.h };
    } else {
      const height = sum / free.w;
      let x = free.x;
      for (const entry of row) { const width = entry.area / height; placed.push({ rect: { x, y: free.y, w: width, h: height }, item: entry.item }); x += width; }
      free = { x: free.x, y: free.y + height, w: free.w, h: free.h - height };
    }
    row = [];
  };
  for (const entry of sorted) {
    const side = Math.min(free.w, free.h);
    if (row.length && worst([...row, entry].map((candidate) => candidate.area), side) > worst(row.map((candidate) => candidate.area), side)) lay();
    row.push(entry);
  }
  if (row.length) lay();
  return placed;
}

/** A package's files as tiles' members: one file each, except that two or more too small to read share the last tile,
 * which takes the next smallest files until it is large enough itself, short of the largest file. */
function tileMembers(files: readonly ChangedFile[], area: number): ChangedFile[][] {
  const perLine = area / Math.max(1, linesOf(files));
  const sorted = [...files].sort((left, right) => (right.additions + right.deletions) - (left.additions + left.deletions));
  const small = sorted.filter((file) => (file.additions + file.deletions) * perLine < SMALLEST_TILE).length;
  if (small < 2) return sorted.map((file) => [file]);
  let kept = sorted.length - small;
  while (kept > 1 && linesOf(sorted.slice(kept)) * perLine < SMALLEST_TILE) kept -= 1;
  return [...sorted.slice(0, kept).map((file) => [file]), sorted.slice(kept)];
}

/** The treemap of `files` in a `width` × `height` pixel box. Files that change no lines take no room. */
export function layoutTreemap(files: readonly ChangedFile[], width: number, height: number): TreemapPackage[] {
  const groups = new Map<string | null, ChangedFile[]>();
  for (const file of files) if (file.additions + file.deletions > 0) groups.set(file.package, [...groups.get(file.package) ?? [], file]);
  return squarify([...groups].map(([name, members]) => ({ value: linesOf(members), item: { name, members } })), { x: 0, y: 0, w: width, h: height }).map(({ rect, item }) => {
    const header = rect.h >= TREEMAP_HEADER * 2 && rect.w >= HEADER_WIDTH;
    const top = header ? TREEMAP_HEADER : INSET;
    const inner = { x: rect.x + INSET, y: rect.y + top, w: Math.max(0, rect.w - INSET * 2), h: Math.max(0, rect.h - top - INSET) };
    const tiles = squarify(tileMembers(item.members, inner.w * inner.h).map((members) => ({ value: linesOf(members), item: members })), inner).map(({ rect: tile, item: members }): TreemapTile => ({
      rect: tile, files: members,
      additions: members.reduce((sum, file) => sum + file.additions, 0),
      deletions: members.reduce((sum, file) => sum + file.deletions, 0),
    }));
    return {
      name: item.name, rect, header, tiles,
      additions: item.members.reduce((sum, file) => sum + file.additions, 0),
      deletions: item.members.reduce((sum, file) => sum + file.deletions, 0),
    };
  });
}

/** The package of the mapped file nearest `path` in the tree: one in the same folder, or sharing at least its first
 * NEAR_FOLDERS folders (a test beside its code, or under the same package's test folder); null when none is. */
function nearestPackage(path: string, packages: ReadonlyMap<string, string>): string | null {
  const folders = path.split('/').slice(0, -1);
  let nearest: { name: string; shared: number } | null = null;
  for (const [file, name] of packages) {
    const other = file.split('/').slice(0, -1);
    let shared = 0;
    while (shared < folders.length && shared < other.length && folders[shared] === other[shared]) shared += 1;
    if ((shared >= NEAR_FOLDERS || (shared === other.length && shared === folders.length)) && shared > (nearest?.shared ?? 0)) nearest = { name, shared };
  }
  return nearest?.name ?? null;
}

/** Each file the guide's sections show, once, in reading order, with the package of the map area that lists it or,
 * for a file no area lists, of the nearest file one does. */
export function guideFiles(sections: readonly ChangeGuideSection[], map: ChangeMap | undefined): GuideFile[] {
  const packages = new Map<string, string>();
  for (const area of map?.areas ?? []) for (const file of area.files) if (!packages.has(file)) packages.set(file, area.package);
  const files = new Map<string, GuideFile>();
  for (const [index, section] of sections.entries()) {
    for (const { path } of section.exhibits) {
      if (!files.has(path)) files.set(path, { path, package: packages.get(path) ?? nearestPackage(path, packages), section: { id: section.id, index, title: section.title, kind: section.kind }, test: TEST_FILE.test(path) });
    }
  }
  return [...files.values()];
}
