/** A workspace as the sidebar's stack tree and the Relations tab's chain and graph read it: `stackedOn` is the branch it
 * builds on and merges after (always also one of `dependsOn`). */
export interface GraphWorkspace { id: string; dependsOn: readonly string[]; stackedOn: string | null }

/** What the focused workspace waits on (transitively) and what waits on it. */
export interface Lit { focus: string; upstream: ReadonlySet<string>; downstream: ReadonlySet<string> }
export type Relation = 'none' | 'focus' | 'upstream' | 'downstream' | 'unrelated';

/** What a workspace waits on directly: its dependencies, its stack parent among them. */
export function directUpstream(item: GraphWorkspace): readonly string[] {
  return item.stackedOn && !item.dependsOn.includes(item.stackedOn) ? [...item.dependsOn, item.stackedOn] : item.dependsOn;
}

/** The dependencies a row writes out as "waits on": its stack parent is told by the nesting instead. */
export function waitsOn(item: GraphWorkspace): readonly string[] {
  return item.dependsOn.filter(id => id !== item.stackedOn);
}

/** The workspaces that write "waits on" this one. */
export function blocks(items: readonly GraphWorkspace[], id: string): readonly string[] {
  return items.filter(item => waitsOn(item).includes(id)).map(item => item.id);
}

function closure(start: string, next: (id: string) => readonly string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...next(start)];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    if (seen.has(id) || id === start) continue;
    seen.add(id);
    queue.push(...next(id));
  }
  return seen;
}

export function lit(items: readonly GraphWorkspace[], focus: string | null): Lit | null {
  if (focus === null) return null;
  const byId = new Map(items.map(item => [item.id, item]));
  if (!byId.has(focus)) return null;
  return {
    focus,
    upstream: closure(focus, id => { const item = byId.get(id); return item ? directUpstream(item).filter(other => byId.has(other)) : []; }),
    downstream: closure(focus, id => items.filter(item => directUpstream(item).includes(id)).map(item => item.id)),
  };
}

export function relation(light: Lit | null, id: string): Relation {
  if (!light) return 'none';
  if (light.focus === id) return 'focus';
  if (light.upstream.has(id)) return 'upstream';
  if (light.downstream.has(id)) return 'downstream';
  return 'unrelated';
}

/** Everything stacked on `id`, depth-first: each branch of a fork fully before the next, in list order. */
export function stackBelow<T extends GraphWorkspace>(items: readonly T[], id: string, seen: ReadonlySet<string> = new Set([id])): readonly T[] {
  return items.filter(item => item.stackedOn === id && !seen.has(item.id)).flatMap(child => {
    const visited = new Set([...seen, child.id]);
    return [child, ...stackBelow(items, child.id, visited)];
  });
}

/** The bottom of the stack a workspace is in: itself when it is stacked on nothing listed. */
export function stackRoot(items: readonly GraphWorkspace[], id: string): string {
  const byId = new Map(items.map(item => [item.id, item]));
  const seen = new Set<string>();
  let current = id;
  for (let parent = byId.get(current)?.stackedOn; parent && byId.has(parent) && !seen.has(parent); parent = byId.get(current)?.stackedOn) {
    seen.add(current);
    current = parent;
  }
  return current;
}

/** The whole stack a workspace is in, bottom first, depth-first through forks; one entry when it is in no stack. */
export function stackOf<T extends GraphWorkspace>(items: readonly T[], id: string): readonly T[] {
  const root = items.find(item => item.id === stackRoot(items, id));
  return root ? [root, ...stackBelow(items, root.id)] : [];
}

/** Group by none: every workspace stacked on nothing listed, each followed by its whole stack (depth-first, a fork's
 * branches one after another). `stacked` rows sit one level in; there is no third level. */
export function stackTree<T extends GraphWorkspace>(items: readonly T[]): readonly { item: T; stacked: boolean }[] {
  const listed = new Set(items.map(item => item.id));
  const roots = items.filter(item => !item.stackedOn || !listed.has(item.stackedOn));
  const placed = roots.flatMap(root => [{ item: root, stacked: false }, ...stackBelow(items, root.id).map(item => ({ item, stacked: true }))]);
  // A stack whose parents form a loop has no root; its rows still show, at the first level.
  const shown = new Set(placed.map(entry => entry.item.id));
  return [...placed, ...items.filter(item => !shown.has(item.id)).map(item => ({ item, stacked: false }))];
}

export interface LaneNode { id: string; column: number; row: number }
export interface LaneEdge { from: string; to: string; kind: 'depends' | 'stacked' }
export interface Lane { nodes: readonly LaneNode[]; edges: readonly LaneEdge[]; columns: number }

/** The workspaces the mini graph draws around one: it, everything it waits on and everything that waits on it. */
export function neighbourhood(items: readonly GraphWorkspace[], id: string): ReadonlySet<string> {
  const light = lit(items, id);
  return new Set([id, ...light?.upstream ?? [], ...light?.downstream ?? []]);
}

/** Layers the given workspaces by dependency depth within the set (columns); each connected group gets its own band of
 * rows, and a workspace sits at the mean row of what it waits on, nudged past a taken slot. Workspaces with no relation
 * inside the set are left out. */
export function laneLayout(items: readonly GraphWorkspace[], members: ReadonlySet<string>): Lane {
  const listed = items.filter(item => members.has(item.id));
  const up = (id: string) => directUpstream(listed.find(item => item.id === id) ?? { id, dependsOn: [], stackedOn: null }).filter(other => members.has(other));
  const down = (id: string) => listed.filter(item => directUpstream(item).includes(id)).map(item => item.id);
  const depths = new Map<string, number>();
  const depth = (id: string, visiting: ReadonlySet<string> = new Set()): number => {
    const known = depths.get(id);
    if (known !== undefined) return known;
    const parents = up(id).filter(parent => !visiting.has(parent));
    const value = parents.length ? 1 + Math.max(...parents.map(parent => depth(parent, new Set([...visiting, id])))) : 0;
    depths.set(id, value);
    return value;
  };
  const connected = listed.filter(item => up(item.id).length > 0 || down(item.id).length > 0);
  const group = new Map<string, number>();
  let groups = 0;
  for (const item of connected) {
    if (group.has(item.id)) continue;
    const queue = [item.id];
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      if (group.has(id)) continue;
      group.set(id, groups);
      queue.push(...up(id), ...down(id));
    }
    groups += 1;
  }
  const nodes: LaneNode[] = [];
  let offset = 0;
  for (let index = 0; index < groups; index += 1) {
    const ordered = connected.filter(item => group.get(item.id) === index).sort((a, b) => depth(a.id) - depth(b.id));
    const placed = new Map<string, number>();
    const taken = new Set<string>();
    for (const item of ordered) {
      const column = depth(item.id);
      const parents = up(item.id).flatMap(id => placed.get(id) ?? []);
      let row = parents.length ? Math.round(parents.reduce((sum, value) => sum + value, 0) / parents.length) : 0;
      while (taken.has(`${column}:${row}`)) row += 1;
      taken.add(`${column}:${row}`);
      placed.set(item.id, row);
    }
    for (const [id, row] of placed) nodes.push({ id, column: depth(id), row: row + offset });
    offset += Math.max(...placed.values()) + 1;
  }
  const edges = connected.flatMap((item): LaneEdge[] => waitsOn(item).filter(from => members.has(from)).map((from): LaneEdge => ({ from, to: item.id, kind: 'depends' }))
    .concat(item.stackedOn && members.has(item.stackedOn) ? [{ from: item.stackedOn, to: item.id, kind: 'stacked' }] : []));
  return { nodes, edges, columns: nodes.length ? Math.max(...nodes.map(node => node.column)) + 1 : 0 };
}
