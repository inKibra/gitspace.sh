import { ArtifactsCodeStore, artifactsWorkspaceRepository } from '@gitspace/runtime-workspace-do';
import { RuntimeIdentitySchema, type RuntimeGitCheckpoint } from '@gitspace/protocol-runtime';
import { collectBytes, parseGitLfsPointer } from '@gitspace/protocol-workspace';
import {
  repositoryFileViewSchema, repositoryStatusEntrySchema, repositoryTreeEntrySchema,
  type RepositoryFileView, type RepositoryMode, type RepositoryStatus, type RepositoryStatusEntry, type RepositoryTreeEntry,
} from '@gitspace/protocol/inspector-contract';
import type { InspectorCloudContext } from './account-inspector-data.js';
import { createAccountGitLfsStore } from './git-lfs-store.js';

/** The same limits the cloud `read` tool enforces. */
const CLOUD_FILE_READ_LIMIT = 8 * 1024 * 1024;
const LFS_POINTER_LIMIT = 1024;
/** First-parent history searched for the comparison base; matches Artifacts' log cap. */
const BASE_HISTORY_LIMIT = 1000;

type Inventory = Map<string, { oid: string; mode: string; type: 'blob' | 'commit' }>;
type Change = { path: string; status: RepositoryStatus; staged: boolean; working: boolean };

/** A cloud workspace's committed checkout: HEAD, index and worktree trees of its runtime checkpoint. */
interface CloudCheckout {
  source: InspectorCloudContext;
  generation: number;
  repository: string;
  checkpoint: RuntimeGitCheckpoint;
  headCommit: string;
  baseCommit: string;
  head: Inventory;
  index: Inventory;
  worktree: Inventory;
  base: Inventory;
}

function difference(before: Inventory, after: Inventory, path: string): 'added' | 'deleted' | 'modified' | null {
  const previous = before.get(path);
  const next = after.get(path);
  if (!previous) return next ? 'added' : null;
  if (!next) return 'deleted';
  return previous.oid === next.oid && previous.mode === next.mode ? null : 'modified';
}

export async function readCloudCheckout(env: Env, userId: string, source: InspectorCloudContext, mode: RepositoryMode): Promise<CloudCheckout> {
  const identity = RuntimeIdentitySchema.parse({ projectId: source.project.id, workspaceId: source.workspace.id });
  const checkpoint = await env.SPACE_AUTHORITY.getByName(`${userId}:${source.workspace.id}`).runtimeRepositoryCheckpoint(identity);
  const code = new ArtifactsCodeStore(env.ARTIFACTS);
  const repository = artifactsWorkspaceRepository(source.workspace.id);
  // A just-initialized scratch workspace has no HEAD yet: its initial index commit stands in for it.
  const headCommit = checkpoint.headCommit ?? checkpoint.indexCommit;
  let baseCommit = headCommit;
  if (mode === 'base' && source.workspace.kind !== 'base' && checkpoint.headCommit) {
    const tip = await code.resolveRef(repository, source.project.baseBranch);
    if (!tip) throw new Error(`Base branch ${source.project.baseBranch} is not in this workspace's cloud repository`);
    const history = new Set((await code.log(repository, checkpoint.headCommit, BASE_HISTORY_LIMIT)).map(commit => commit.hash));
    const common = (await code.log(repository, tip, BASE_HISTORY_LIMIT)).find(commit => history.has(commit.hash));
    if (!common) throw new Error(`No common ancestor with ${source.project.baseBranch} within the last ${BASE_HISTORY_LIMIT} commits`);
    baseCommit = common.hash;
  }
  const commitTree = async (commit: string | null) => {
    if (commit === null) return null;
    const metadata = await code.readCommit(repository, commit);
    if (!metadata) throw new Error(`Committed source ${commit} is missing from the cloud repository`);
    return metadata.treeHash;
  };
  const [headTree, baseTree] = await Promise.all([commitTree(checkpoint.headCommit), mode === 'base' ? commitTree(baseCommit) : null]);
  const trees = [checkpoint.indexTree, checkpoint.worktreeTree, ...(headTree ? [headTree] : []), ...(baseTree ? [baseTree] : [])];
  // Submodule links are not files the Inspector can show, as on a machine.
  const [index, worktree, ...rest] = (await code.listSnapshotInventories(repository, trees)).map((inventory): Inventory => new Map([...inventory].filter(([, entry]) => entry.type === 'blob')));
  const head = headTree ? rest.shift()! : new Map();
  const base = baseTree ? rest.shift()! : head;
  return { source, generation: source.placement?.generation ?? 0, repository, checkpoint, headCommit, baseCommit, head, index: index!, worktree: worktree!, base };
}

/** Each mode compares the same pair as its machine `git status`/`git diff` counterpart. */
function changes(checkout: CloudCheckout, mode: RepositoryMode, selected: string | null): Change[] {
  const { head, index, worktree } = checkout;
  const before = mode === 'base' ? checkout.base : mode === 'working' ? index : head;
  const after = mode === 'staged' ? index : worktree;
  const conflicts = new Set(checkout.checkpoint.conflicts ?? []);
  const result: Change[] = [];
  for (const path of new Set([...before.keys(), ...after.keys(), ...conflicts])) {
    if (selected !== null && path !== selected && !path.startsWith(`${selected}/`)) continue;
    const change = conflicts.has(path) ? 'conflicted' : difference(before, after, path);
    if (!change) continue;
    const untracked = mode !== 'staged' && !index.has(path) && worktree.has(path);
    const staged = mode === 'base' ? !untracked : difference(head, index, path) !== null;
    const working = mode === 'base' || untracked || difference(index, worktree, path) !== null;
    result.push({ path, status: untracked && change === 'added' ? 'untracked' : change, staged, working });
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

export function cloudRepositoryStatus(checkout: CloudCheckout, mode: RepositoryMode, path: string | null): RepositoryStatusEntry[] {
  return changes(checkout, mode, path).map(change => repositoryStatusEntrySchema.parse({
    spaceId: checkout.source.identity.spaceId, generation: checkout.generation, mode, path: change.path,
    status: change.status, oldPath: null, staged: change.staged, working: change.working,
  }));
}

export function cloudRepositoryTree(checkout: CloudCheckout, mode: RepositoryMode, path: string | null): RepositoryTreeEntry[] {
  const statusByPath = new Map(changes(checkout, mode, path).map(change => [change.path, change.status]));
  const current = mode === 'staged' ? checkout.index : checkout.worktree;
  const before = mode === 'base' ? checkout.base : mode === 'working' ? checkout.index : checkout.head;
  const entries = new Map([...before, ...current]);
  const selected = [...entries.keys()]
    .filter(candidate => (path === null || candidate === path || candidate.startsWith(`${path}/`))
      // As on a machine: environment and artifact mounts are never repository content, nor untracked build output.
      && !candidate.startsWith('.gitspace/environments/') && !candidate.startsWith('.gitspace/artifacts/')
      && (checkout.index.has(candidate) || checkout.head.has(candidate) || (!candidate.startsWith('node_modules/') && !candidate.startsWith('dist/'))))
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
  if (!bytes.includes(0)) {
    try { return { content: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', binary: false }; }
    catch { /* Not UTF-8: fall through to base64. */ }
  }
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return { content: btoa(binary), encoding: 'base64', binary: true };
}

export async function cloudRepositoryFile(env: Env, userId: string, checkout: CloudCheckout, mode: RepositoryMode, path: string): Promise<RepositoryFileView> {
  const inventory = mode === 'base' ? checkout.base : mode === 'staged' ? checkout.index : checkout.worktree;
  const entry = inventory.get(path);
  const where = mode === 'base' ? `at ${checkout.baseCommit}` : mode === 'staged' ? 'in the index' : 'in the workspace';
  if (!entry) throw new Error(`${path} does not exist ${where}`);
  const blob = await new ArtifactsCodeStore(env.ARTIFACTS).readBlob(checkout.repository, entry.oid);
  if (!blob) throw new Error(`${path} is missing from the cloud repository`);
  if (blob.size > CLOUD_FILE_READ_LIMIT) throw new Error(`File ${path} (${blob.size} bytes) exceeds the 8 MiB cloud read limit; use a machine to read its content.`);
  let bytes: Uint8Array = new Uint8Array(await blob.arrayBuffer());
  const pointer = entry.mode !== '120000' && bytes.byteLength <= LFS_POINTER_LIMIT ? parseGitLfsPointer(bytes) : null;
  if (pointer) {
    if (pointer.size > CLOUD_FILE_READ_LIMIT) throw new Error(`File ${path} (${pointer.size} bytes) exceeds the 8 MiB cloud read limit; use a machine to read its content.`);
    // The store verifies oid and size while streaming.
    const payload = await (await createAccountGitLfsStore(env, userId, checkout.source.project.id, `inspector:${checkout.source.workspace.id}`)).get(pointer);
    if (!payload) throw new Error(`LFS file ${path} (${pointer.size} bytes) needs a machine to download its content from origin.`);
    bytes = await collectBytes(payload, pointer.size);
  } else if (mode !== 'base' && mode !== 'staged' && checkout.checkpoint.lfs?.heldBack.some(held => held.path === path)) {
    throw new Error(`LFS file ${path} needs a machine to restore committed content.`);
  }
  const status = changes(checkout, mode, path).find(change => change.path === path)?.status ?? 'clean';
  return repositoryFileViewSchema.parse({
    spaceId: checkout.source.identity.spaceId, generation: checkout.generation, mode, path,
    kind: entry.mode === '120000' ? 'symlink' : 'file', ...decodeContents(bytes),
    blobId: entry.oid, commitId: mode === 'base' ? checkout.baseCommit : checkout.headCommit, headCommit: checkout.headCommit, status,
  });
}
