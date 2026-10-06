import type { RuntimeGitCheckpoint, SnapshotMutation, WriteSnapshotInput } from './artifacts-snapshot.js';
import { parseGitLfsPointer } from '@gitspace/protocol-workspace';

type Reader = Pick<ArtifactsRepo, 'readTree' | 'readBlob' | 'readCommit'>;
type Entry = { oid: string; mode: string; type: 'blob' | 'commit' };
const same = (a: Entry | undefined, b: Entry | undefined) => a?.oid === b?.oid && a?.mode === b?.mode && a?.type === b?.type;
export async function snapshotEntries(repo: Pick<Reader, 'readTree'>, tree: string): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  const walk = async (oid: string, prefix: string, ancestors: Set<string>) => {
    if (ancestors.has(oid) || ancestors.size > 128) throw new Error('Invalid snapshot tree depth');
    const children = await repo.readTree(oid);
    if (!children) throw new Error(`Missing snapshot tree ${oid}`);
    for (const entry of children) {
      const path = prefix + entry.name;
      if (entry.type === 'tree') await walk(entry.hash, `${path}/`, new Set([...ancestors, oid]));
      else entries.set(path, { oid: entry.hash, mode: entry.mode, type: entry.type === 'gitlink' ? 'commit' : 'blob' });
    }
  };
  await walk(tree, '', new Set());
  return entries;
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
  const layer = async (baseTree: string, cloudTree: string, machineTree: string, worktree = false): Promise<SnapshotMutation[]> => {
    const [original, current, incoming] = await Promise.all([inventory(baseTree), inventory(cloudTree), inventory(machineTree)]);
    const mutations: SnapshotMutation[] = [];
    const paths = new Set([...original.keys(), ...current.keys(), ...incoming.keys()]);
    const reserve = (path: string, entry: Entry) => {
      let target = `${path}.gitspace-machine-${machine.worktreeCommit.slice(0, 12)}`;
      while (paths.has(target)) target += '-copy';
      paths.add(target); mutations.push({ path: target, content: null, ...entry });
    };
    const updateMarkers = (path: string, marked: boolean) => {
      if (!worktree || path === 'HEAD') return;
      if (marked) introduced.add(path);
      else if (conflicts.has(path)) resolved.add(path);
    };
    for (const path of [...paths].sort()) {
      const a = original.get(path), b = current.get(path), c = incoming.get(path);
      if (same(a, c)) {
        if (options.forcePublication && worktree && path !== 'HEAD' && await entryHasMarkers(b)) introduced.add(path);
        continue;
      }
      if (same(b, c)) { if (worktree) updateMarkers(path, await entryHasMarkers(c)); continue; }
      const structural = [...current.keys()].some(other => other !== path && (other.startsWith(`${path}/`) || path.startsWith(`${other}/`)) && !(same(original.get(other), current.get(other)) && !incoming.has(other)));
      if (same(a, b) && !structural) { mutations.push({ path, content: null, ...(c ?? {}) }); if (worktree) updateMarkers(path, await entryHasMarkers(c)); continue; }
      const [before, ours, theirs] = await Promise.all([text(a), text(b), text(c)]);
      if (!structural && before !== null && ours !== null && theirs !== null && b && c && (b.mode === c.mode || a?.mode === b.mode || a?.mode === c.mode)) {
        const merged = mergeSnapshotText(before, ours, theirs);
        mutations.push({ path, content: new TextEncoder().encode(merged.text), mode: a?.mode === b.mode ? c.mode : b.mode });
        if (merged.conflict) introduced.add(path);
        else updateMarkers(path, hasSnapshotConflictMarkers(merged.text));
      } else {
        introduced.add(path);
        // Keep cloud at its path; preserve the incoming object under a collision-free sibling.
        if (c) reserve(path.split('/').slice(0, structural ? 1 : undefined).join('/'), c);
        else if (b && before !== null && ours !== null) mutations.push({ path, content: new TextEncoder().encode(mergeSnapshotText(before, ours, '').text), mode: b.mode });
      }
    }
    return mutations;
  };
  const trackedTrees = await Promise.all([base, cloud, machine].map(checkpoint => repo.readCommit(checkpoint.trackedWorktreeCommit)));
  if (!trackedTrees[0] || !trackedTrees[1] || !trackedTrees[2]) throw new Error('Missing tracked merge snapshot');
  const mutations = await layer(base.worktreeTree, cloud.worktreeTree, machine.worktreeTree, true);
  const indexMutations = await layer(base.indexTree, cloud.indexTree, machine.indexTree);
  const trackedMutations = await layer(trackedTrees[0].treeHash, trackedTrees[1].treeHash, trackedTrees[2].treeHash);
  for (const path of resolved) conflicts.delete(path);
  for (const path of introduced) conflicts.add(path);
  const headChanged = machine.headCommit !== base.headCommit, branchChanged = machine.branch !== base.branch;
  if (headChanged && cloud.headCommit !== base.headCommit && cloud.headCommit !== machine.headCommit) conflicts.add('HEAD');
  const objects = new Map([...cloud.lfs?.objects ?? [], ...machine.lfs?.objects ?? []].map(object => [object.oid, object]));
  const heldBack = new Map([...cloud.lfs?.heldBack ?? [], ...machine.lfs?.heldBack ?? []].map(entry => [entry.path, entry]));
  return { mutations, indexMutations, trackedMutations, conflicts: [...conflicts].sort(), machine: { ...machine, headCommit: headChanged && cloud.headCommit === base.headCommit ? machine.headCommit : cloud.headCommit, branch: branchChanged && cloud.branch === base.branch ? machine.branch : cloud.branch, ...(cloud.lfs || machine.lfs ? { lfs: { objects: [...objects.values()], heldBack: [...heldBack.values()] } } : {}) } };
}
