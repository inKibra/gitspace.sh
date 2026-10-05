import git from 'isomorphic-git';
import { Volume, createFsFromVolume } from 'memfs';
import { Result, TaggedError } from 'better-result';
import { RuntimeGitCheckpointSchema } from '@gitspace/protocol-runtime/workspace-controls';
import { z } from 'zod';

export type RuntimeGitCheckpoint = z.infer<typeof RuntimeGitCheckpointSchema>;
export type SnapshotMutation = { path: string; content: Uint8Array | null };
export type WriteSnapshotInput = { repository: string; workspaceId: string; previous: RuntimeGitCheckpoint; mutations: SnapshotMutation[]; signal?: AbortSignal };
export interface ArtifactsFetch { (input: string, init?: RequestInit): Promise<Response> }
export class ArtifactsSnapshotError extends TaggedError('ArtifactsSnapshotError')<{ operation: string; message: string; certainty: 'not-published' | 'unknown' }> {}

export function validateSnapshotPath(path: string): void {
  if (!path || path.length > 4096 || path.split('/').length > 128 || path.includes('\\') || path.includes('\0') || path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')) throw new Error('Invalid repository-relative path');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const zero = '0'.repeat(40);
function packet(text: string): Uint8Array {
  const bytes = encoder.encode(text);
  return encoder.encode((bytes.length + 4).toString(16).padStart(4, '0') + text);
}
function packets(bytes: Uint8Array): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < bytes.length;) {
    const prefix = decoder.decode(bytes.subarray(offset, offset + 4));
    if (!/^[0-9a-f]{4}$/u.test(prefix)) throw new Error('Invalid Git packet header');
    const size = Number.parseInt(prefix, 16);
    offset += 4;
    if (size === 0) continue;
    if (size < 4 || offset + size - 4 > bytes.length) throw new Error('Truncated Git packet');
    result.push(decoder.decode(bytes.subarray(offset, offset + size - 4)));
    offset += size - 4;
  }
  return result;
}

/** Only newly written objects are packed. Existing objects remain on the server. */
export async function publishSnapshotPack(input: { remote: string; token: string; ref: string; previous: string; commit: string; pack: Uint8Array; signal?: AbortSignal; onPublicationState?: (certainty: ArtifactsSnapshotError['certainty']) => void }, request: ArtifactsFetch = fetch): Promise<void> {
  const remote = new URL(input.remote);
  if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('Invalid Artifacts Git remote');
  const headers = { Authorization: `Bearer ${input.token}` };
  const base = remote.href.replace(/\/$/u, '');
  const advertised = await request(`${base}/info/refs?service=git-receive-pack`, { headers, signal: input.signal, redirect: 'manual' });
  if (!advertised.ok) throw new Error(`Git discovery failed (${advertised.status})`);
  let old = zero;
  let capabilities: string[] = [];
  for (const line of packets(new Uint8Array(await advertised.arrayBuffer()))) {
    if (line.startsWith('#')) continue;
    const [reference = '', caps] = line.trimEnd().split('\0');
    if (caps !== undefined) capabilities = caps.split(' ');
    const [oid, ref] = reference.split(' ');
    if (ref === input.ref && oid && /^[0-9a-f]{40}$/u.test(oid)) old = oid;
  }
  if (old === input.commit) { input.onPublicationState?.('unknown'); return; }
  if (old !== zero && old !== input.previous) throw new Error('Snapshot conflict: checkpoint ref has advanced');
  if (!capabilities.includes('report-status')) throw new Error('Git server does not support report-status');
  const command = packet(`${old} ${input.commit} ${input.ref}\0report-status\n`);
  const body = new Uint8Array(command.length + 4 + input.pack.length);
  body.set(command); body.set(encoder.encode('0000'), command.length); body.set(input.pack, command.length + 4);
  input.signal?.throwIfAborted();
  input.onPublicationState?.('unknown');
  const response = await request(`${base}/git-receive-pack`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/x-git-receive-pack-request', Accept: 'application/x-git-receive-pack-result' }, body, signal: input.signal, redirect: 'manual' });
  if (!response.ok) throw new Error(`Git push failed (${response.status})`);
  const status = packets(new Uint8Array(await response.arrayBuffer())).map(line => line.trimEnd());
  if (status.some(line => line.startsWith(`ng ${input.ref} `)) && !status.includes(`ok ${input.ref}`)) input.onPublicationState?.('not-published');
  if (!status.includes('unpack ok') || !status.includes(`ok ${input.ref}`)) throw new Error(`Git push rejected: ${status.join('; ')}`);
}

/** Deterministic root objects make interrupted initialization safely replayable. */
export async function initializeArtifactsRepository(repo: Pick<ArtifactsRepo, 'info' | 'createToken' | 'revokeToken'>, input: { branch: string; workspaceId?: string }, request: ArtifactsFetch = fetch) {
  const fs = createFsFromVolume(new Volume());
  const dir = '/initial';
  await git.init({ fs, dir, defaultBranch: input.branch });
  const tree = await git.writeTree({ fs, dir, tree: [] });
  const identity = { name: 'GitSpace', email: 'checkpoint@gitspace.invalid', timestamp: 0, timezoneOffset: 0 };
  const unborn = input.workspaceId !== undefined;
  const indexCommit = await git.writeCommit({ fs, dir, commit: { tree, parent: [], author: identity, committer: identity, message: unborn ? 'GitSpace unborn index snapshot\n' : 'Initialize project\n' } });
  const trackedWorktreeCommit = unborn ? await git.writeCommit({ fs, dir, commit: { tree, parent: [indexCommit], author: identity, committer: identity, message: 'GitSpace unborn tracked worktree snapshot\n' } }) : indexCommit;
  const worktreeCommit = unborn ? await git.writeCommit({ fs, dir, commit: { tree, parent: [trackedWorktreeCommit], author: identity, committer: identity, message: 'GitSpace unborn worktree snapshot\n' } }) : indexCommit;
  const checkpointRef = unborn ? `refs/gitspace/spaces/${input.workspaceId}/checkpoints` : `refs/heads/${input.branch}`;
  const packed = await git.packObjects({ fs, dir, oids: [...new Set([tree, indexCommit, trackedWorktreeCommit, worktreeCommit])] });
  if (!packed.packfile) throw new Error('Git pack writer returned no pack');
  const info = await repo.info();
  const token = await repo.createToken('write', 60);
  try { await publishSnapshotPack({ remote: info.remote, token: token.plaintext, ref: checkpointRef, previous: zero, commit: worktreeCommit, pack: packed.packfile }, request); }
  finally { await repo.revokeToken(token.id); }
  return { indexCommit, trackedWorktreeCommit, worktreeCommit, tree };
}

export async function writeArtifactsSnapshot(repo: Pick<ArtifactsRepo, 'readCommit' | 'readTree' | 'info' | 'createToken' | 'revokeToken'>, input: WriteSnapshotInput, request: ArtifactsFetch = fetch): Promise<Result<RuntimeGitCheckpoint, ArtifactsSnapshotError>> {
  let certainty: ArtifactsSnapshotError['certainty'] = 'not-published';
  return Result.tryPromise({ try: async () => {
    input.signal?.throwIfAborted();
    const previous = RuntimeGitCheckpointSchema.parse(input.previous);
    if (!/^[A-Za-z0-9_-]+$/u.test(input.workspaceId)) throw new Error('Invalid workspace ID');
    const mutations = input.mutations;
    if (mutations.length > 256 || mutations.reduce((bytes, mutation) => bytes + (mutation.content?.byteLength ?? 0), 0) > 32 * 1024 * 1024) throw new Error('Snapshot mutation budget exceeded');
    const paths = new Set<string>();
    for (const mutation of mutations) {
      validateSnapshotPath(mutation.path);
      if (paths.has(mutation.path)) throw new Error('Duplicate snapshot mutation');
      paths.add(mutation.path);
    }
    for (const mutation of mutations) {
      const parts = mutation.path.split('/');
      for (let count = 1; count < parts.length; count++) {
        if (paths.has(parts.slice(0, count).join('/'))) throw new Error('Overlapping snapshot mutations');
      }
    }
    const parent = await repo.readCommit(previous.worktreeCommit);
    if (!parent || parent.treeHash !== previous.worktreeTree) throw new Error('Previous snapshot is missing or inconsistent');
    const fs = createFsFromVolume(new Volume());
    const dir = '/snapshot';
    await git.init({ fs, dir });
    const oids = new Set<string>();
    const trees = new Map<string, ArtifactsTreeEntry[]>();
    let hydratedEntries = 0;
    const loadTree = async (oid: string): Promise<ArtifactsTreeEntry[]> => {
      const cached = trees.get(oid);
      if (cached) return cached;
      input.signal?.throwIfAborted();
      if (trees.size >= 256) throw new Error('Snapshot tree hydration budget exceeded');
      const entries = await repo.readTree(oid);
      if (!entries) throw new Error(`Missing tree ${oid}`);
      hydratedEntries += entries.length;
      if (hydratedEntries > 200_000) throw new Error('Snapshot tree entry budget exceeded');
      trees.set(oid, entries);
      return entries;
    };
    const editTree = async (oid: string | undefined, edits: SnapshotMutation[], tracked: boolean): Promise<string> => {
      const entries = new Map((oid ? await loadTree(oid) : []).map(entry => [entry.name, { mode: entry.mode, path: entry.name, oid: entry.hash, type: entry.type === 'tree' ? 'tree' as const : entry.type === 'gitlink' ? 'commit' as const : 'blob' as const }]));
      const groups = new Map<string, SnapshotMutation[]>();
      for (const edit of edits) {
        const name = edit.path.split('/')[0]!;
        const group = groups.get(name) ?? []; group.push(edit); groups.set(name, group);
      }
      for (const [name, group] of groups) {
        const existing = entries.get(name);
        const direct = group.find(edit => edit.path === name);
        if (direct) {
          if (direct.content === null) { entries.delete(name); continue; }
          if (tracked && !existing) continue;
          if (existing?.type === 'tree' || existing?.type === 'commit') throw new Error('Cannot replace a directory or gitlink with file content');
          const blob = await git.writeBlob({ fs, dir, blob: direct.content }); oids.add(blob);
          entries.set(name, { mode: existing?.mode ?? '100644', path: name, oid: blob, type: 'blob' });
        } else {
          if (existing && existing.type !== 'tree') throw new Error('Cannot traverse a file, symlink, or gitlink');
          if (tracked && !existing) continue;
          const child = await editTree(existing?.oid, group.map(edit => ({ ...edit, path: edit.path.slice(name.length + 1) })), tracked);
          const empty = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
          if (child === empty) entries.delete(name);
          else entries.set(name, { mode: '40000', path: name, oid: child, type: 'tree' });
        }
      }
      const tree = await git.writeTree({ fs, dir, tree: [...entries.values()] });
      if (tree !== oid) oids.add(tree);
      return tree;
    };
    const worktreeTree = await editTree(previous.worktreeTree, mutations, false);
    if (worktreeTree === previous.worktreeTree) return previous;
    const trackedParent = await repo.readCommit(previous.trackedWorktreeCommit);
    if (!trackedParent) throw new Error('Previous tracked snapshot is missing');
    const trackedTree = await editTree(trackedParent.treeHash, mutations, true);
    const identity = { name: 'GitSpace Checkpoint', email: 'checkpoint@gitspace.invalid', timestamp: parent.committedAt + 1, timezoneOffset: 0 };
    const trackedWorktreeCommit = await git.writeCommit({ fs, dir, commit: { tree: trackedTree, parent: [previous.trackedWorktreeCommit], author: identity, committer: identity, message: 'GitSpace cloud tracked worktree snapshot\n' } });
    oids.add(trackedWorktreeCommit);
    const worktreeCommit = await git.writeCommit({ fs, dir, commit: { tree: worktreeTree, parent: [previous.worktreeCommit, trackedWorktreeCommit], author: identity, committer: identity, message: 'GitSpace cloud worktree snapshot\n' } });
    oids.add(worktreeCommit);
    const packed = await git.packObjects({ fs, dir, oids: [...oids] });
    if (!packed.packfile) throw new Error('Git pack writer returned no pack');
    const checkpointRef = `refs/gitspace/spaces/${input.workspaceId}/checkpoints`;
    const info = await repo.info();
    const token = await repo.createToken('write', 60);
    try { await publishSnapshotPack({ remote: info.remote, token: token.plaintext, ref: checkpointRef, previous: previous.worktreeCommit, commit: worktreeCommit, pack: packed.packfile, signal: input.signal, onPublicationState: state => { certainty = state; } }, request); }
    finally { await repo.revokeToken(token.id); }
    return RuntimeGitCheckpointSchema.parse({ ...previous, checkpointRef, trackedWorktreeCommit, worktreeCommit, worktreeTree });
  }, catch: error => new ArtifactsSnapshotError({ operation: 'writeSnapshot', certainty, message: error instanceof Error ? error.message : String(error) }) });
}
