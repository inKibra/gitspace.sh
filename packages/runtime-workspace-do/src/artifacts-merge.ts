import type { RuntimeGitCheckpoint, SnapshotMutation, WriteSnapshotInput } from './artifacts-snapshot.js';
import { parseGitLfsPointer } from '@gitspace/protocol-workspace';

type Reader = Pick<ArtifactsRepo, 'readTree' | 'readBlob' | 'readCommit'>;
type Entry = { oid: string; mode: string; type: 'blob' | 'commit' };
const same = (a: Entry | undefined, b: Entry | undefined) => a?.oid === b?.oid && a?.mode === b?.mode && a?.type === b?.type;
/** Artifacts calls in flight at once while walking a tree: a large repository has thousands of directories, and one
 * call at a time made each walk take minutes. */
const READ_CONCURRENCY = 16;
/** Runs `run` over `items` with at most `limit` in flight. */
async function eachLimited<T>(items: readonly T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await run(items[next++]!);
  }));
}
const fileEntry = (entry: ArtifactsTreeEntry): Entry => ({ oid: entry.hash, mode: entry.mode, type: entry.type === 'gitlink' ? 'commit' : 'blob' });
/** Walks one depth of directories at a time, reading each depth's directories concurrently. Git trees are content
 * addressed, so a cycle can only come from a corrupt repository; it shows as unbounded depth. */
async function walkTrees<T extends { depth: number }>(roots: T[], visit: (item: T) => Promise<T[]>): Promise<void> {
  let level = roots;
  while (level.length) {
    if (level[0]!.depth > 128) throw new Error('Invalid snapshot tree depth');
    const next: T[] = [];
    await eachLimited(level, READ_CONCURRENCY, async item => { next.push(...await visit(item)); });
    level = next;
  }
}
export async function snapshotEntries(repo: Pick<Reader, 'readTree'>, tree: string): Promise<Map<string, Entry>> {
  const found: Array<[string, Entry]> = [];
  await walkTrees([{ oid: tree, prefix: '', depth: 0 }], async ({ oid, prefix, depth }) => {
    const children = await repo.readTree(oid);
    if (!children) throw new Error(`Missing snapshot tree ${oid}`);
    const subtrees = [];
    for (const entry of children) {
      const path = prefix + entry.name;
      if (entry.type === 'tree') subtrees.push({ oid: entry.hash, prefix: `${path}/`, depth: depth + 1 });
      else found.push([path, fileEntry(entry)]);
    }
    return subtrees;
  });
  // Paths are unique within a tree; sorting keeps the inventory independent of read completion order.
  return new Map(found.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
type TreeDiffItem = { before?: string; after?: string; prefix: string; depth: number };
/** The file paths that differ between two trees, reading only directories whose hashes differ. */
export async function changedSnapshotEntries(repo: Pick<Reader, 'readTree'>, before: string, after: string): Promise<Array<{ path: string; before?: Entry; after?: Entry }>> {
  const changes: Array<{ path: string; before?: Entry; after?: Entry }> = [];
  const read = async (oid: string | undefined) => {
    if (!oid) return new Map<string, ArtifactsTreeEntry>();
    const children = await repo.readTree(oid);
    if (!children) throw new Error(`Missing snapshot tree ${oid}`);
    return new Map(children.map(entry => [entry.name, entry]));
  };
  const root: TreeDiffItem = { before, after, prefix: '', depth: 0 };
  await walkTrees([root], async item => {
    const [left, right] = await Promise.all([read(item.before), read(item.after)]);
    const subtrees: TreeDiffItem[] = [];
    for (const name of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(name), b = right.get(name);
      if (a && b && a.hash === b.hash && a.mode === b.mode && a.type === b.type) continue;
      const path = item.prefix + name;
      const beforeTree = a?.type === 'tree' ? a.hash : undefined, afterTree = b?.type === 'tree' ? b.hash : undefined;
      if (beforeTree || afterTree) subtrees.push({ before: beforeTree, after: afterTree, prefix: `${path}/`, depth: item.depth + 1 });
      const beforeFile = a && a.type !== 'tree' ? fileEntry(a) : undefined, afterFile = b && b.type !== 'tree' ? fileEntry(b) : undefined;
      if (beforeFile || afterFile) changes.push({ path, ...(beforeFile ? { before: beforeFile } : {}), ...(afterFile ? { after: afterFile } : {}) });
    }
    return subtrees;
  });
  return changes;
}
/** Whether `path` names a file or directory in `tree`, reading only the directories along it. */
async function pathExists(repo: Pick<Reader, 'readTree'>, tree: string, path: string): Promise<boolean> {
  const parts = path.split('/');
  let oid = tree;
  for (const [index, name] of parts.entries()) {
    const children = await repo.readTree(oid);
    if (!children) throw new Error(`Missing snapshot tree ${oid}`);
    const entry = children.find(child => child.name === name);
    if (!entry) return false;
    if (index === parts.length - 1) return true;
    if (entry.type !== 'tree') return false;
    oid = entry.hash;
  }
  return false;
}

type Hunk = { start: number; end: number; lines: string[] };
function changes(base: string[], next: string[]): Hunk[] | null {
  if (base.length * next.length > 4_000_000) return null;
  const width = next.length + 1, matrix = new Uint32Array((base.length + 1) * width);
  for (let i = base.length - 1; i >= 0; i--) for (let j = next.length - 1; j >= 0; j--) matrix[i * width + j] = base[i] === next[j] ? matrix[(i + 1) * width + j + 1]! + 1 : Math.max(matrix[(i + 1) * width + j]!, matrix[i * width + j + 1]!);
  const result: Hunk[] = []; let i = 0, j = 0;
  while (i < base.length || j < next.length) {
    if (i < base.length && j < next.length && base[i] === next[j]) { i++; j++; continue; }
    const hunk: Hunk = { start: i, end: i, lines: [] };
    while (i < base.length || j < next.length) {
      if (i < base.length && j < next.length && base[i] === next[j]) break;
      if (j < next.length && (i === base.length || matrix[i * width + j + 1]! >= matrix[(i + 1) * width + j]!)) hunk.lines.push(next[j++]!);
      else i++;
    }
    hunk.end = i; result.push(hunk);
  }
  return result;
}
export function mergeSnapshotText(base: string, cloud: string, machine: string): { text: string; conflict: boolean } {
  if (cloud === machine || machine === base) return { text: cloud, conflict: false };
  if (cloud === base) return { text: machine, conflict: false };
  const lines = base.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const left = changes(lines, cloud.match(/[^\n]*\n|[^\n]+$/gu) ?? []), right = changes(lines, machine.match(/[^\n]*\n|[^\n]+$/gu) ?? []);
  if (left && right) {
    const combined = [...left]; let overlaps = false;
    for (const b of right) {
      let duplicate = false;
      for (const a of left) {
        if (a.start === b.start && a.end === b.end && a.lines.join('') === b.lines.join('')) { duplicate = true; break; }
        if (Math.max(a.start, b.start) < Math.min(a.end, b.end) || (a.start === a.end && a.start >= b.start && a.start <= b.end) || (b.start === b.end && b.start >= a.start && b.start <= a.end)) overlaps = true;
      }
      if (!duplicate) combined.push(b);
    }
    if (!overlaps) {
      combined.sort((a, b) => a.start - b.start); let cursor = 0, text = '';
      for (const hunk of combined) { text += lines.slice(cursor, hunk.start).join('') + hunk.lines.join(''); cursor = hunk.end; }
      return { text: text + lines.slice(cursor).join(''), conflict: false };
    }
  }
  const terminated = (text: string) => text && !text.endsWith('\n') ? `${text}\n` : text;
  return { text: `<<<<<<< cloud\n${terminated(cloud)}||||||| base\n${terminated(base)}=======\n${terminated(machine)}>>>>>>> machine\n`, conflict: true };
}

export function hasSnapshotConflictMarkers(text: string): boolean {
  return /^(?:<<<<<<< cloud|\|\|\|\|\|\|\| base|>>>>>>> machine)\r?$/mu.test(text);
}

/** Replaces every conflict region written by `mergeSnapshotText` with one side. Text outside regions is kept. */
export function resolveSnapshotConflictText(text: string, keep: 'cloud' | 'machine'): string {
  let section: 'outside' | 'cloud' | 'base' | 'machine' = 'outside';
  let resolved = '';
  for (const line of text.split(/(?<=\n)/u)) {
    const marker = line.replace(/\r?\n$/u, '');
    if (section === 'outside' && marker === '<<<<<<< cloud') { section = 'cloud'; continue; }
    if (section === 'cloud' && marker === '||||||| base') { section = 'base'; continue; }
    if (section === 'base' && marker === '=======') { section = 'machine'; continue; }
    if (section === 'machine' && marker === '>>>>>>> machine') { section = 'outside'; continue; }
    if (section === 'outside' || section === keep) resolved += line;
  }
  if (section !== 'outside') throw new Error('Conflict markers are incomplete; edit the file directly');
  return resolved;
}

const snapshotTextLimit = 8 * 1024 * 1024;
export function isSnapshotTextEntry(entry: Pick<Entry, 'type' | 'mode'>): boolean {
  return entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755');
}

function snapshotText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > snapshotTextLimit || bytes.includes(0) || parseGitLfsPointer(bytes)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

export async function readSnapshotText(blob: Blob): Promise<string | null> {
  if (blob.size > snapshotTextLimit) return null;
  return snapshotText(new Uint8Array(await blob.arrayBuffer()));
}

export function isCleanSnapshotContent(bytes: Uint8Array): boolean {
  const text = snapshotText(bytes);
  return text === null || !hasSnapshotConflictMarkers(text);
}

export async function planSnapshotMerge(repo: Reader, base: RuntimeGitCheckpoint, cloud: RuntimeGitCheckpoint, machine: RuntimeGitCheckpoint, options: Pick<WriteSnapshotInput, 'forcePublication'> = {}) {
  const conflicts = new Set(cloud.conflicts ?? []);
  const resolved = new Set<string>(), introduced = new Set<string>();
  const inventories = new Map<string, Promise<Map<string, Entry>>>();
  const inventory = (tree: string) => { let promise = inventories.get(tree); if (!promise) { promise = snapshotEntries(repo, tree); inventories.set(tree, promise); } return promise; };
  const text = async (entry: Entry | undefined): Promise<string | null> => {
    if (!entry) return '';
    if (!isSnapshotTextEntry(entry)) return null;
    const blob = await repo.readBlob(entry.oid); if (!blob) throw new Error(`Missing merge blob ${entry.oid}`);
    return readSnapshotText(blob);
  };
  const entryHasMarkers = async (entry: Entry | undefined): Promise<boolean> => {
    const content = await text(entry);
    return content !== null && hasSnapshotConflictMarkers(content);
  };
  // Conflict markers come from merges in the working copy, so a machine's change is read for them only where it differs
  // from the machine's own HEAD: a pull's committed files are the repository's content (null: no HEAD, read all).
  let uncommittedPaths: Promise<Set<string> | null> | undefined;
  const uncommitted = () => uncommittedPaths ??= (async () => {
    if (!machine.headCommit) return null;
    const head = await repo.readCommit(machine.headCommit);
    if (!head) throw new Error('Missing machine HEAD commit');
    return new Set((await changedSnapshotEntries(repo, head.treeHash, machine.worktreeTree)).map(change => change.path));
  })();
  const machineHasMarkers = async (path: string, entry: Entry | undefined) => {
    const local = await uncommitted();
    return (!local || local.has(path)) && entryHasMarkers(entry);
  };
  /** A worktree path's markers after this publication: added when present, a recorded conflict resolved when gone. */
  const updateMarkers = (path: string, marked: boolean) => {
    if (path === 'HEAD') return;
    if (marked) introduced.add(path);
    else if (conflicts.has(path)) resolved.add(path);
  };
  /** What a layer merge reads: full inventories when every path is rescanned (a forced publication), otherwise only the
   * paths that changed from the base on either side, each with its entry on all three sides. */
  const sides = async (baseTree: string, cloudTree: string, machineTree: string) => {
    if (options.forcePublication) {
      const [original, current, incoming] = await Promise.all([inventory(baseTree), inventory(cloudTree), inventory(machineTree)]);
      const paths = new Set([...original.keys(), ...current.keys(), ...incoming.keys()]);
      // Cloud paths that can collide with a path above or below them: changed in the cloud, or still on the machine.
      const occupied = new Set([...current.keys()].filter(other => !(same(original.get(other), current.get(other)) && !incoming.has(other))));
      return { original, current, incoming, paths, occupied, taken: async (path: string) => paths.has(path) };
    }
    const [cloudChanges, machineChanges] = await Promise.all([changedSnapshotEntries(repo, baseTree, cloudTree), changedSnapshotEntries(repo, baseTree, machineTree)]);
    const original = new Map<string, Entry>(), current = new Map<string, Entry>(), incoming = new Map<string, Entry>();
    for (const change of [...cloudChanges, ...machineChanges]) if (change.before) original.set(change.path, change.before);
    for (const change of cloudChanges) if (change.after) current.set(change.path, change.after);
    for (const change of machineChanges) if (change.after) incoming.set(change.path, change.after);
    const cloudPaths = new Set(cloudChanges.map(change => change.path)), machinePaths = new Set(machineChanges.map(change => change.path));
    // A side that left a path alone still holds the base entry there.
    for (const [path, entry] of original) {
      if (!cloudPaths.has(path)) current.set(path, entry);
      if (!machinePaths.has(path)) incoming.set(path, entry);
    }
    const paths = new Set([...cloudPaths, ...machinePaths]);
    // Only a path the cloud changed and still holds can collide: one the cloud left alone is the machine's own tree's,
    // which cannot hold a file and a directory at one path.
    const occupied = new Set(cloudChanges.flatMap(change => change.after ? [change.path] : []));
    const roots = [baseTree, cloudTree, machineTree];
    return { original, current, incoming, paths, occupied, taken: async (path: string) => paths.has(path) || (await Promise.all(roots.map(tree => pathExists(repo, tree, path)))).some(Boolean) };
  };
  const layer = async (baseTree: string, cloudTree: string, machineTree: string, worktree = false): Promise<SnapshotMutation[]> => {
    const { original, current, incoming, paths, occupied, taken } = await sides(baseTree, cloudTree, machineTree);
    const mutations: SnapshotMutation[] = [];
    const occupiedDirectories = new Set<string>();
    for (const other of occupied) for (let slash = other.indexOf('/'); slash !== -1; slash = other.indexOf('/', slash + 1)) occupiedDirectories.add(other.slice(0, slash));
    const structuralAt = (path: string) => occupiedDirectories.has(path) || path.split('/').slice(0, -1).some((_, index, parts) => occupied.has(parts.slice(0, index + 1).join('/')));
    const reserve = async (path: string, entry: Entry) => {
      let target = `${path}.gitspace-machine-${machine.worktreeCommit.slice(0, 12)}`;
      while (await taken(target)) target += '-copy';
      paths.add(target); mutations.push({ path: target, content: null, ...entry });
    };
    for (const path of [...paths].sort()) {
      const a = original.get(path), b = current.get(path), c = incoming.get(path);
      if (same(a, c)) {
        if (options.forcePublication && worktree && path !== 'HEAD' && await entryHasMarkers(b)) introduced.add(path);
        continue;
      }
      if (same(b, c)) { if (worktree) updateMarkers(path, await entryHasMarkers(c)); continue; }
      const structural = structuralAt(path);
      if (same(a, b) && !structural) { mutations.push({ path, content: null, ...(c ?? {}) }); if (worktree) updateMarkers(path, await machineHasMarkers(path, c)); continue; }
      const [before, ours, theirs] = await Promise.all([text(a), text(b), text(c)]);
      if (!structural && before !== null && ours !== null && theirs !== null && b && c && (b.mode === c.mode || a?.mode === b.mode || a?.mode === c.mode)) {
        const merged = mergeSnapshotText(before, ours, theirs);
        mutations.push({ path, content: new TextEncoder().encode(merged.text), mode: a?.mode === b.mode ? c.mode : b.mode });
        if (merged.conflict) introduced.add(path);
        else if (worktree) updateMarkers(path, hasSnapshotConflictMarkers(merged.text));
      } else {
        introduced.add(path);
        // Keep cloud at its path; preserve the incoming object under a collision-free sibling.
        if (c) await reserve(path.split('/').slice(0, structural ? 1 : undefined).join('/'), c);
        else if (b && before !== null && ours !== null) mutations.push({ path, content: new TextEncoder().encode(mergeSnapshotText(before, ours, '').text), mode: b.mode });
      }
    }
    return mutations;
  };
  const headChanged = machine.headCommit !== base.headCommit, branchChanged = machine.branch !== base.branch;
  const objects = new Map([...cloud.lfs?.objects ?? [], ...machine.lfs?.objects ?? []].map(object => [object.oid, object]));
  const heldBack = new Map([...cloud.lfs?.heldBack ?? [], ...machine.lfs?.heldBack ?? []].map(entry => [entry.path, entry]));
  const merged = { ...machine, headCommit: headChanged && cloud.headCommit === base.headCommit ? machine.headCommit : cloud.headCommit, branch: branchChanged && cloud.branch === base.branch ? machine.branch : cloud.branch, ...(cloud.lfs || machine.lfs ? { lfs: { objects: [...objects.values()], heldBack: [...heldBack.values()] } } : {}) };
  // The cloud has not changed since the machine's base: every path takes the machine's version, so its trees are the
  // result as they stand. A fast-forward of thousands of files in a large repository otherwise walked every tree of
  // three versions and rebuilt them.
  if (!options.forcePublication && base.worktreeCommit === cloud.worktreeCommit && base.headCommit === cloud.headCommit && base.branch === cloud.branch) {
    const tracked = await repo.readCommit(machine.trackedWorktreeCommit);
    if (!tracked) throw new Error('Missing tracked merge snapshot');
    const changes = await changedSnapshotEntries(repo, base.worktreeTree, machine.worktreeTree);
    await eachLimited(changes, READ_CONCURRENCY, async change => updateMarkers(change.path, await machineHasMarkers(change.path, change.after)));
    for (const path of resolved) conflicts.delete(path);
    for (const path of introduced) conflicts.add(path);
    return { forcePublication: false, mutations: [], conflicts: [...conflicts].sort(), adopt: { worktreeTree: machine.worktreeTree, indexTree: machine.indexTree, trackedTree: tracked.treeHash }, machine: merged };
  }
  const trackedTrees = await Promise.all([base, cloud, machine].map(checkpoint => repo.readCommit(checkpoint.trackedWorktreeCommit)));
  if (!trackedTrees[0] || !trackedTrees[1] || !trackedTrees[2]) throw new Error('Missing tracked merge snapshot');
  const mutations = await layer(base.worktreeTree, cloud.worktreeTree, machine.worktreeTree, true);
  const indexMutations = await layer(base.indexTree, cloud.indexTree, machine.indexTree);
  const trackedMutations = await layer(trackedTrees[0].treeHash, trackedTrees[1].treeHash, trackedTrees[2].treeHash);
  for (const path of resolved) conflicts.delete(path);
  for (const path of introduced) conflicts.add(path);
  if (headChanged && cloud.headCommit !== base.headCommit && cloud.headCommit !== machine.headCommit) conflicts.add('HEAD');
  return { forcePublication: options.forcePublication === true, mutations, indexMutations, trackedMutations, conflicts: [...conflicts].sort(), machine: merged };
}
