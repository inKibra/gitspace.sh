/**
 * `dependsOn` reachability shared by every writer and picker: a workspace may
 * not depend on anything that already depends on it, or the phase ceiling
 * would lock both in place.
 */

/** Ordered ids from `from` to `to` along `dependsOn` edges (both endpoints included), or null when `to` is not reachable. */
export function dependencyPath(from: string, to: string, dependsOn: ReadonlyMap<string, readonly string[]>): string[] | null {
  if (from === to) return [from];
  const previous = new Map<string, string>();
  const queue = [from];
  const seen = new Set(queue);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of dependsOn.get(current) ?? []) {
      if (seen.has(next)) continue;
      previous.set(next, current);
      if (next === to) {
        const path = [to];
        for (let step = current; step !== from; step = previous.get(step)!) path.push(step);
        path.push(from);
        return path.reverse();
      }
      seen.add(next);
      queue.push(next);
    }
  }
  return null;
}

/**
 * The loop that `workspaceId` depending on `proposed` would close, as ids
 * starting and ending at `workspaceId`; null when the edges are acyclic.
 * `dependsOn` is the current graph; the workspace's own entry is replaced by
 * `proposed`, so an unchanged edge set is judged on its own merits.
 */
export function dependencyCycle(workspaceId: string, proposed: readonly string[], dependsOn: ReadonlyMap<string, readonly string[]>): string[] | null {
  const edges = new Map(dependsOn);
  edges.set(workspaceId, proposed);
  for (const dependency of proposed) {
    const back = dependencyPath(dependency, workspaceId, edges);
    if (back) return [workspaceId, ...back];
  }
  return null;
}

/** Ids that transitively depend on `workspaceId`: the candidates it may not depend on. */
export function transitiveDependents(workspaceId: string, dependsOn: ReadonlyMap<string, readonly string[]>): Set<string> {
  const dependents = new Map<string, string[]>();
  for (const [id, targets] of dependsOn) {
    for (const target of targets) {
      let list = dependents.get(target);
      if (!list) dependents.set(target, list = []);
      list.push(id);
    }
  }
  const result = new Set<string>();
  const queue = [workspaceId];
  while (queue.length > 0) {
    for (const dependent of dependents.get(queue.shift()!) ?? []) {
      if (result.has(dependent) || dependent === workspaceId) continue;
      result.add(dependent);
      queue.push(dependent);
    }
  }
  return result;
}
