import { ArtifactsCodeStore, artifactsProjectRepository, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import { RuntimeIdentitySchema, type RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { collectBytes, parseGitLfsPointer } from '@gitspace/protocol-workspace';
import {
  repositoryDiffViewSchema, repositoryFileViewSchema, repositoryStatusEntrySchema, repositoryTreeEntrySchema,
  type RepositoryDiffView, type RepositoryFileView, type RepositoryMode, type RepositoryStatus, type RepositoryStatusEntry, type RepositoryTreeEntry,
} from '@gitspace/protocol/inspector-contract';
import type { InspectorCloudContext } from './account-inspector-data.js';
import { createAccountGitLfsStore } from './git-lfs-store.js';
import { compareCloudHistory } from './cloud-stack-status.js';
import { gitFilePatch, type PatchSide } from './git-patch.js';
import { GitObjects, type CachedPatch } from './git-object-cache.js';

/** The same limits the cloud `read` tool enforces. */
const CLOUD_FILE_READ_LIMIT = 8 * 1024 * 1024;
const LFS_POINTER_LIMIT = 1024;
/** File patches one diff request builds at once; the shared content budget still bounds their bytes. */
const DIFF_CONCURRENCY = 8;

type FileEntry = { oid: string; mode: string };
/** A path in one snapshot: a directory's tree, a file, or nothing. Submodule links are not files the Inspector can show, as on a machine. */
type Node = { tree: string } | { file: FileEntry } | null;
type Pair = { before?: FileEntry; after?: FileEntry };
type Change = Pair & { path: string; status: RepositoryStatus; staged: boolean; working: boolean };
/** Content bytes a request may still read; reservations precede materialization. */
type Budget = { remaining: number };

/** A cloud workspace's committed checkout: the HEAD, index and worktree root trees of its runtime checkpoint. */
export interface CloudCheckout {
  source: InspectorCloudContext;
  generation: number;
  objects: GitObjects;
  /** The checkpoint facts diffs consult; a checkout pinned to two commits has neither. */
  checkpoint: Pick<RuntimeGitCheckpoint, 'conflicts' | 'lfs'>;
  headCommit: string;
  baseCommit: string;
  /** Null before the workspace's first commit. */
  head: string | null;
  index: string;
  worktree: string;
  base: string | null;
}

function nodeOf(entry: ArtifactsTreeEntry): Node {
  if (entry.type === 'tree') return { tree: entry.hash };
  return entry.type === 'gitlink' ? null : { file: { oid: entry.hash, mode: entry.mode } };
}

/** The object at `path` in a snapshot, reading only the trees along that path. */
async function resolve(objects: GitObjects, root: string | null, path: string | null): Promise<Node> {
  let node: Node = root === null ? null : { tree: root };
  if (path === null) return node;
  for (const name of path.split('/')) {
    if (!node || !('tree' in node)) return null;
    const child: ArtifactsTreeEntry | undefined = (await objects.tree(node.tree)).find(entry => entry.name === name);
    node = child ? nodeOf(child) : null;
  }
  return node;
}

/** Records every file that differs between two nodes at `path`, as `git diff-tree -r`: equal subtrees are never read. */
async function differences(objects: GitObjects, before: Node, after: Node, path: string, out: Map<string, Pair>): Promise<void> {
  const beforeTree = before && 'tree' in before ? before.tree : null;
  const afterTree = after && 'tree' in after ? after.tree : null;
  if (beforeTree !== null && beforeTree === afterTree) return;
  const beforeFile = before && 'file' in before ? before.file : undefined;
  const afterFile = after && 'file' in after ? after.file : undefined;
  if ((beforeFile || afterFile) && !(beforeFile && afterFile && beforeFile.oid === afterFile.oid && beforeFile.mode === afterFile.mode)) {
    out.set(path, { before: beforeFile, after: afterFile });
  }
  if (beforeTree === null && afterTree === null) return;
  const [beforeEntries, afterEntries] = await Promise.all([beforeTree === null ? [] : objects.tree(beforeTree), afterTree === null ? [] : objects.tree(afterTree)]);
  const children = new Map<string, [Node, Node]>();
  for (const entry of beforeEntries) children.set(entry.name, [nodeOf(entry), null]);
  for (const entry of afterEntries) {
    const pair = children.get(entry.name);
    if (pair) pair[1] = nodeOf(entry);
    else children.set(entry.name, [null, nodeOf(entry)]);
  }
  await Promise.all([...children].map(([name, [left, right]]) => differences(objects, left, right, path ? `${path}/${name}` : name, out)));
}

/** Files under `selected` that differ between two snapshots; a null `before` lists every file of `after`. */
async function treeChanges(objects: GitObjects, before: string | null, after: string | null, selected: string | null): Promise<Map<string, Pair>> {
  const [left, right] = await Promise.all([resolve(objects, before, selected), resolve(objects, after, selected)]);
  const out = new Map<string, Pair>();
  await differences(objects, left, right, selected ?? '', out);
  return out;
}

/** Every file under `path` in a snapshot. */
async function inventory(objects: GitObjects, root: string | null, path: string | null): Promise<Map<string, FileEntry>> {
  const files = await treeChanges(objects, null, root, path);
  return new Map([...files].map(([file, { after }]) => [file, after!]));
}

/**
 * The merge base of `head` and the tip of `branch`. A machine's remote-tracking name (`origin/<name>`) names the same
 * branch. The branch is read from the workspace's repository, else from the project's copy of origin's branches, and
 * history is walked across both: a workspace repository holds only the branches it pushed.
 */
async function mergeBaseWith(env: Env, objects: GitObjects, projectId: string, head: string, branch: string): Promise<string> {
  const name = branch.startsWith('origin/') ? branch.slice('origin/'.length) : branch;
  const store = new ArtifactsCodeStore(env.ARTIFACTS);
  const repositories = [objects.repository, artifactsProjectRepository(projectId)];
  let tip: string | null = null;
  for (const repository of repositories) {
    tip = await store.resolveRef(repository, name);
    if (tip) break;
  }
  if (!tip) throw new Error(`Base branch ${branch} is in neither this workspace's nor the project's cloud repository`);
  const workspace = objects.history();
  const history = {
    readCommit: (repository: string, commit: string) => repository === objects.repository ? workspace.readCommit(repository, commit) : store.readCommit(repository, commit),
    log: (repository: string, commit: string, limit?: number) => repository === objects.repository ? workspace.log(repository, commit, limit) : store.log(repository, commit, limit),
  };
  const found = tip;
  return objects.mergeBase(head, found, async () => {
    const comparison = await compareCloudHistory(history, { head, repositories }, { head: found, repositories });
    if (!comparison.complete) throw new Error(`Base comparison with ${branch} is unavailable because cloud history is shallow or incomplete`);
    const common = comparison.bases[0];
    if (!common) throw new Error(`No common ancestor with ${branch}`);
    return common;
  });
}

/** Base mode compares against the merge base of HEAD and `baseRef`, the project's base branch unless a caller names one. */
async function readCloudCheckout(env: Env, userId: string, source: InspectorCloudContext, mode: RepositoryMode, baseRef: string | null, objects: GitObjects): Promise<CloudCheckout> {
  const identity = RuntimeIdentitySchema.parse({ projectId: source.project.id, workspaceId: source.workspace.id });
  const checkpoint = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeRepositoryCheckpoint(identity);
  // A just-initialized scratch workspace has no HEAD yet: its initial index commit stands in for it.
  const headCommit = checkpoint.headCommit ?? checkpoint.indexCommit;
  const baseCommit = mode === 'base' && source.workspace.kind !== 'base' && checkpoint.headCommit
    ? await mergeBaseWith(env, objects, source.project.id, checkpoint.headCommit, baseRef ?? source.project.baseBranch)
    : headCommit;
  const [head, base] = await Promise.all([
    checkpoint.headCommit === null ? null : objects.commitTree(checkpoint.headCommit),
    mode === 'base' ? objects.commitTree(baseCommit) : null,
  ]);
  return {
    source, generation: source.placement?.generation ?? 0, objects, checkpoint, headCommit, baseCommit,
    head, index: checkpoint.indexTree, worktree: checkpoint.worktreeTree, base: mode === 'base' ? base : head,
  };
}

async function withObjects<T>(env: Env, source: InspectorCloudContext, use: (objects: GitObjects) => Promise<T>): Promise<T> {
  const repository = artifactsWorkspaceRepository(source.workspace.id);
  const objects = new GitObjects(new ArtifactsCodeStore(env.ARTIFACTS).reader(repository), repository);
  try { return await use(objects); }
  finally { await objects.close(); }
}

/** Runs `read` against the workspace's checkout through one Artifacts handle, released afterwards. */
export async function withCloudCheckout<T>(
  env: Env, userId: string, source: InspectorCloudContext, mode: RepositoryMode, baseRef: string | null, read: (checkout: CloudCheckout) => Promise<T>,
): Promise<T> {
  return withObjects(env, source, async objects => read(await readCloudCheckout(env, userId, source, mode, baseRef, objects)));
}

/** Runs `read` against two fixed commits of the workspace's cloud repository: base mode compares `baseCommit` with `headCommit`. */
export async function withPinnedCloudCheckout<T>(
  env: Env, source: InspectorCloudContext, baseCommit: string, headCommit: string, read: (checkout: CloudCheckout) => Promise<T>,
): Promise<T> {
  return withObjects(env, source, async objects => {
    const [head, base] = await Promise.all([objects.commitTree(headCommit), objects.commitTree(baseCommit)]);
    return read({ source, generation: source.placement?.generation ?? 0, objects, checkpoint: {}, headCommit, baseCommit, head, index: head, worktree: head, base });
  });
}

/** The snapshots each mode compares: the same pair as its machine `git status`/`git diff` counterpart. */
function compared(checkout: CloudCheckout, mode: RepositoryMode): { before: string | null; after: string } {
  return {
    before: mode === 'base' ? checkout.base : mode === 'working' ? checkout.index : checkout.head,
    after: mode === 'staged' ? checkout.index : checkout.worktree,
  };
}

/** Changes under `selected`, from tree diffs that read only the subtrees whose ids differ. */
async function changes(checkout: CloudCheckout, mode: RepositoryMode, selected: string | null): Promise<Change[]> {
  const { objects, head, index, worktree } = checkout;
  const { before, after } = compared(checkout, mode);
  const diffs = new Map<string, Promise<Map<string, Pair>>>();
  const diff = (left: string | null, right: string | null) => {
    const key = `${left}:${right}`;
    let pending = diffs.get(key);
    if (!pending) {
      pending = treeChanges(objects, left, right, selected);
      diffs.set(key, pending);
    }
    return pending;
  };
  const [main, staged, working] = await Promise.all([diff(before, after), mode === 'base' ? null : diff(head, index), diff(index, worktree)]);
  const conflicts = new Set((checkout.checkpoint.conflicts ?? []).filter(path => selected === null || path === selected || path.startsWith(`${selected}/`)));
  const result: Change[] = [];
  for (const path of new Set([...main.keys(), ...conflicts])) {
    let pair = main.get(path);
    if (!pair) {
      // A conflicted path whose compared entries are equal or absent.
      const [left, right] = await Promise.all([resolve(objects, before, path), resolve(objects, after, path)]);
      pair = { before: left && 'file' in left ? left.file : undefined, after: right && 'file' in right ? right.file : undefined };
    }
    const change = conflicts.has(path) ? 'conflicted' : !pair.before ? 'added' : !pair.after ? 'deleted' : 'modified';
    // Absent from the index but present in the worktree.
    const untracked = mode !== 'staged' && working.has(path) && working.get(path)!.before === undefined;
    result.push({
      ...pair, path, status: untracked && change === 'added' ? 'untracked' : change,
      staged: mode === 'base' ? !untracked : staged!.has(path), working: mode === 'base' || untracked || working.has(path),
    });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export async function cloudRepositoryStatus(checkout: CloudCheckout, mode: RepositoryMode, path: string | null): Promise<RepositoryStatusEntry[]> {
  return (await changes(checkout, mode, path)).map(change => repositoryStatusEntrySchema.parse({
    spaceId: checkout.source.identity.spaceId, generation: checkout.generation, mode, path: change.path,
    status: change.status, oldPath: null, staged: change.staged, working: change.working,
  }));
}

export async function cloudRepositoryTree(checkout: CloudCheckout, mode: RepositoryMode, path: string | null): Promise<RepositoryTreeEntry[]> {
  const { objects } = checkout;
  const compare = compared(checkout, mode);
  const [changed, before, current, index, head] = await Promise.all([
    changes(checkout, mode, path), inventory(objects, compare.before, path), inventory(objects, compare.after, path),
    inventory(objects, checkout.index, path), inventory(objects, checkout.head, path),
  ]);
  const statusByPath = new Map(changed.map(change => [change.path, change.status]));
  const entries = new Map([...before, ...current]);
  const selected = [...entries.keys()]
    // As on a machine: environment and artifact mounts are never repository content, nor untracked build output.
    .filter(candidate => !candidate.startsWith('.gitspace/environments/') && !candidate.startsWith('.gitspace/artifacts/')
      && (index.has(candidate) || head.has(candidate) || (!candidate.startsWith('node_modules/') && !candidate.startsWith('dist/'))))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  const identity = { spaceId: checkout.source.identity.spaceId, generation: checkout.generation, mode };
  const tree: RepositoryTreeEntry[] = [];
  const directoryStatuses = new Map<string, RepositoryStatus>();
  for (const entryPath of selected) {
    const entry = entries.get(entryPath)!;
    const status = statusByPath.get(entryPath) ?? 'clean';
    const parts = entryPath.split('/');
    for (let depth = 1; depth < parts.length; depth += 1) {
      const directory = parts.slice(0, depth).join('/');
      const existing = directoryStatuses.get(directory);
      if (existing === undefined || existing === 'clean') directoryStatuses.set(directory, status);
    }
    tree.push(repositoryTreeEntrySchema.parse({
      ...identity, path: entryPath, name: parts.at(-1), kind: entry.mode === '120000' ? 'symlink' : 'file',
      status, oldPath: null, blobId: entry.oid, size: null,
    }));
  }
  for (const [directory, status] of directoryStatuses) {
    tree.push(repositoryTreeEntrySchema.parse({ ...identity, path: directory, name: directory.split('/').at(-1), kind: 'directory', status, oldPath: null, blobId: null, size: null }));
  }
  return tree.sort((left, right) => left.path.split('/').length - right.path.split('/').length || left.path.localeCompare(right.path) || (left.kind === 'directory' ? -1 : 1));
}

/** Text when the bytes are NUL-free UTF-8, otherwise base64, exactly as the machine Inspector decides. */
function decodeContents(bytes: Uint8Array): { content: string; encoding: 'utf-8' | 'base64'; binary: boolean } {
  const text = decodeText(bytes);
  if (text !== null) return { content: text, encoding: 'utf-8', binary: false };
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { content: btoa(binary), encoding: 'base64', binary: true };
}

function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}

function reserve(budget: Budget, size: number, tooLarge: (size: number) => Error): void {
  if (size > budget.remaining) throw tooLarge(size);
  budget.remaining -= size;
}

/**
 * A blob's content, with an LFS pointer replaced by its payload. Sizes are reserved from `budget` before any
 * content is materialized; `tooLarge` explains a refusal.
 */
async function readCloudContent(
  env: Env, userId: string, checkout: CloudCheckout, path: string, entry: FileEntry, budget: Budget, tooLarge: (size: number) => Error,
): Promise<{ bytes: Uint8Array; lfs: boolean }> {
  const bytes = await checkout.objects.blob(entry.oid, size => reserve(budget, size, tooLarge));
  if (!bytes) throw new Error(`${path} is missing from the cloud repository`);
  const pointer = entry.mode !== '120000' && bytes.byteLength <= LFS_POINTER_LIMIT ? parseGitLfsPointer(bytes) : null;
  if (!pointer) return { bytes, lfs: false };
  // The payload, not its pointer, counts against the budget.
  budget.remaining += bytes.byteLength;
  reserve(budget, pointer.size, tooLarge);
  // The store verifies oid and size while streaming.
  const payload = await (await createAccountGitLfsStore(env, userId, checkout.source.project.id, `inspector:${checkout.source.workspace.id}`)).get(pointer);
  if (!payload) throw new Error(`LFS file ${path} (${pointer.size} bytes) needs a machine to download its content from origin.`);
  return { bytes: await collectBytes(payload, pointer.size), lfs: true };
}

export async function cloudRepositoryFile(env: Env, userId: string, checkout: CloudCheckout, mode: RepositoryMode, path: string): Promise<RepositoryFileView> {
  const node = await resolve(checkout.objects, mode === 'base' ? checkout.base : mode === 'staged' ? checkout.index : checkout.worktree, path);
  const where = mode === 'base' ? `at ${checkout.baseCommit}` : mode === 'staged' ? 'in the index' : 'in the workspace';
  if (!node || !('file' in node)) throw new Error(`${path} does not exist ${where}`);
  const entry = node.file;
  const { bytes, lfs } = await readCloudContent(env, userId, checkout, path, entry, { remaining: CLOUD_FILE_READ_LIMIT },
    size => new Error(`File ${path} (${size} bytes) exceeds the 8 MiB cloud read limit; use a machine to read its content.`));
  if (!lfs && mode !== 'base' && mode !== 'staged' && checkout.checkpoint.lfs?.heldBack.some(held => held.path === path)) {
    throw new Error(`LFS file ${path} needs a machine to restore committed content.`);
  }
  const status = (await changes(checkout, mode, path)).find(change => change.path === path)?.status ?? 'clean';
  return repositoryFileViewSchema.parse({
    spaceId: checkout.source.identity.spaceId, generation: checkout.generation, mode, path,
    kind: entry.mode === '120000' ? 'symlink' : 'file', ...decodeContents(bytes),
    blobId: entry.oid, commitId: mode === 'base' ? checkout.baseCommit : checkout.headCommit, headCommit: checkout.headCommit, status,
  });
}

/** One changed file's patch, cached by both sides' blob ids, modes and path; a cached patch reserves the bytes it compared. */
async function filePatch(env: Env, userId: string, checkout: CloudCheckout, change: Change, budget: Budget, tooLarge: (size: number) => Error): Promise<CachedPatch> {
  const { path, before, after } = change;
  // A mode-only change, or a conflicted path absent from both sides, needs no content.
  if ((before && after && before.oid === after.oid) || (!before && !after)) {
    return { ...gitFilePatch(path, before ? { ...before, text: '' } : null, after ? { ...after, text: '' } : null), sizes: [null, null] };
  }
  const side = async (entry: FileEntry | undefined): Promise<[PatchSide | null, number | null]> => {
    if (!entry) return [null, null];
    const { bytes } = await readCloudContent(env, userId, checkout, path, entry, budget, tooLarge);
    return [{ oid: entry.oid, mode: entry.mode, text: decodeText(bytes) }, bytes.byteLength];
  };
  const key = `${before?.oid ?? ''}:${before?.mode ?? ''}:${after?.oid ?? ''}:${after?.mode ?? ''}:${path}`;
  const { value, cached } = await checkout.objects.patch(key, async () => {
    const [[left, leftSize], [right, rightSize]] = await Promise.all([side(before), side(after)]);
    return { ...gitFilePatch(path, left, right), sizes: [leftSize, rightSize] };
  });
  if (cached) for (const size of value.sizes) if (size !== null) reserve(budget, size, tooLarge);
  return value;
}

/** Runs `run` over `items` with at most `limit` in flight; the first failure stops new work and is rethrown once all settle. */
async function forEachLimited<T>(items: readonly T[], limit: number, run: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const failures: unknown[] = [];
  const worker = async () => {
    while (failures.length === 0 && next < items.length) {
      const index = next++;
      try { await run(items[index]!, index); }
      catch (error) { failures.push(error); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failures.length > 0) throw failures[0];
}

/**
 * `git diff --full-index` for the paths `cloudRepositoryStatus` reports changed under `path`, between the same
 * snapshots. Only those paths' blobs are read, and at most 8 MiB of content in total, so one request never
 * holds more than a single cloud file read allows. Each file's patch is cached, so a workspace diff reuses
 * the patches single-file diffs already built and the reverse.
 */
export async function cloudRepositoryDiff(env: Env, userId: string, checkout: CloudCheckout, mode: RepositoryMode, path: string | null): Promise<RepositoryDiffView> {
  // Held-back LFS edits exist only on the machine that holds them; the cloud worktree still has committed content.
  if (path !== null && mode !== 'staged' && checkout.checkpoint.lfs?.heldBack.some(held => held.path === path)) {
    throw new Error(`LFS file ${path} has changes held back on a machine; use that machine to diff it.`);
  }
  const listed = await changes(checkout, mode, path);
  const budget: Budget = { remaining: CLOUD_FILE_READ_LIMIT };
  const patches: CachedPatch[] = new Array(listed.length);
  await forEachLimited(listed, DIFF_CONCURRENCY, async (change, index) => {
    patches[index] = await filePatch(env, userId, checkout, change, budget, size => new Error(size > CLOUD_FILE_READ_LIMIT
      ? `File ${change.path} (${size} bytes) exceeds the 8 MiB cloud read limit; use a machine to diff it.`
      : `The diff of ${path ?? 'this workspace'} compares more than 8 MiB of content; open its files one at a time or use a machine.`));
  });
  return repositoryDiffViewSchema.parse({
    spaceId: checkout.source.identity.spaceId, generation: checkout.generation, mode, path, patch: patches.map(file => file.patch).join(''),
    baseCommit: mode === 'base' ? checkout.baseCommit : checkout.headCommit, headCommit: checkout.headCommit,
    files: listed.map((change, index) => ({
      path: change.path, oldPath: null, oldBlobId: change.before?.oid ?? null, newBlobId: change.after?.oid ?? null, status: change.status,
      additions: patches[index]!.additions, deletions: patches[index]!.deletions, binary: patches[index]!.binary,
    })),
  });
}
