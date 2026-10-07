import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { streamBytes, GitLfsRestoredSchema, parseGitLfsPointer, type GitLfsObject, type GitLfsOriginConfirmation, type GitLfsRestored, type GitLfsSnapshot, type GitLfsStore } from '@gitspace/protocol-workspace';
import { downloadQueryObject, hydrationEndpoint, originConfirmation } from './git-lfs-origin.js';
import { committedLfsInventory } from './git-lfs-inventory.js';
import { cachedLfsObject, installLfsObject, verifiedLfsSource } from './git-lfs-cache.js';

export type MachineGitLfs = {
  store: GitLfsStore;
  originEnvironment(repositoryPath: string): Promise<Record<string, string>>;
  canonicalOrigin?: string | null;
  confirmOrigin?(receipt: GitLfsOriginConfirmation): Promise<void>;
  resolveSources?(objects: GitLfsSnapshot['objects']): Promise<GitLfsSnapshot['objects']>;
  releasePublication?(): Promise<void>;
};
async function git(root: string, args: string[], env: Record<string, string> = {}, input?: string | Uint8Array): Promise<Uint8Array> {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { ...Bun.env, ...env }, stdin: input === undefined ? 'ignore' : typeof input === 'string' ? new Blob([input]) : input, stdout: 'pipe', stderr: 'pipe' });
  const [code, bytes, error] = await Promise.all([child.exited, new Response(child.stdout).bytes(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Git LFS ${args[0]}: ${error.trim()}`);
  return bytes;
}
async function* gitPayload(root: string, args: string[], env: Record<string, string> = {}, input?: string): AsyncGenerator<Uint8Array> {
  const child = Bun.spawn(['git', ...args], { cwd: root, env: { ...Bun.env, ...env }, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'ignore' });
  try {
    yield* streamBytes(child.stdout);
    if (await child.exited !== 0) throw new Error(`Git LFS ${args[0]} failed`);
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function blobMatches(root: string, oid: string, object: GitLfsObject): Promise<boolean> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of gitPayload(root, ['cat-file', 'blob', oid])) {
    if (chunk.byteLength > object.size - size) return false;
    size += chunk.byteLength;
    hash.update(chunk);
  }
  return size === object.size && hash.digest('hex') === object.oid;
}
async function cachePath(root: string, object: GitLfsObject): Promise<string> {
  const configured = text(await git(root, ['rev-parse', '--git-path', 'lfs/objects'])).trim();
  return resolve(root, configured, object.oid.slice(0, 2), object.oid.slice(2, 4), object.oid);
}
async function cached(root: string, object: GitLfsObject): Promise<string | null> {
  const path = await cachePath(root, object);
  return await cachedLfsObject(path, object) ? path : null;
}
type Entry = { mode: string; oid: string };
async function tree(root: string, ref: string): Promise<Map<string, Entry>> {
  const entries = new Map<string, Entry>();
  for (const record of text(await git(root, ['ls-tree', '-r', '-z', ref])).split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t'); const [mode, kind, oid] = record.slice(0, tab).split(' ');
    if (mode && oid && kind === 'blob') entries.set(record.slice(tab + 1), { mode, oid });
  }
  return entries;
}
async function pointers(root: string, revisions: string[]): Promise<Map<string, GitLfsObject>> {
  const result = new Map<string, GitLfsObject>();
  if (!revisions.length) return result;
  const objects = text(await git(root, ['rev-list', '--objects', '--no-object-names', ...revisions])).trim();
  const metadata = text(await git(root, ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {}, `${objects}\n`));
  for (const line of metadata.trim().split('\n')) {
    const [oid, kind, size] = line.split(' ');
    if (!oid || kind !== 'blob' || Number(size) > 1024) continue;
    const pointer = parseGitLfsPointer(await git(root, ['cat-file', 'blob', oid]));
    if (pointer) result.set(pointer.oid, pointer);
  }
  return result;
}

export async function captureGitLfs(root: string, head: string | null, authorityIndex: string, access?: MachineGitLfs) {
  const snapshot: GitLfsSnapshot = { objects: [], heldBack: [] };
  const headEntries = head ? await tree(root, head) : new Map<string, Entry>();
  const history = await committedLfsInventory(root, head, git, pointers);
  const confirm = await originConfirmation(root, head, git, access?.canonicalOrigin === null ? {} : await access?.originEnvironment(root) ?? {}, access);
  const origin = new Map((await confirm([...history.values()])).map(object => [object.oid, object]));
  const unconfirmed = [...history.values()].filter(object => !origin.has(object.oid));
  const protectedObjects = access?.store.protect ? new Map((await access.store.protect(unconfirmed)).map(object => [object.oid, object.size])) : undefined;
  for (const object of history.values()) {
    const confirmed = origin.get(object.oid);
    if (confirmed) snapshot.objects.push({ ...confirmed, source: 'origin' });
    else if (protectedObjects ? protectedObjects.get(object.oid) === object.size : await access?.store.has(object)) snapshot.objects.push({ ...object, source: 'r2' });
    else {
      if (!access) throw new Error(`Git LFS store required for committed object ${object.oid}`);
      const path = await cached(root, object);
      if (!path) throw new Error(`Missing committed Git LFS object ${object.oid}; fetch it from origin before checkpointing`);
      await access.store.put(object, verifiedLfsSource(object, createReadStream(path)));
      snapshot.objects.push({ ...object, source: 'r2' });
    }
  }
  const available = new Map(snapshot.objects.map(object => [object.oid, object]));
  const held = new Map<string, GitLfsSnapshot['heldBack'][number]>();
  const authorityGit = join(dirname(authorityIndex), 'attributes.git');
  await git(root, ['init', '--bare', authorityGit]);
  const objectDirectory = resolve(root, text(await git(root, ['rev-parse', '--git-path', 'objects'])).trim());
  const authorityEnv = { GIT_INDEX_FILE: authorityIndex, GIT_DIR: authorityGit, GIT_OBJECT_DIRECTORY: objectDirectory, GIT_WORK_TREE: root, GIT_ATTR_NOSYSTEM: '1' };
  await git(root, head ? ['read-tree', head] : ['read-tree', '--empty'], authorityEnv);
  return {
    snapshot,
    async sanitize(index: string, kind: 'staged' | 'modified' | 'added'): Promise<void> {
      const env = { GIT_INDEX_FILE: index };
      const current = await tree(root, text(await git(root, ['write-tree'], env)).trim());
      const paths = [...new Set([...current.keys(), ...headEntries.keys()])];
      const attrs = paths.length ? text(await git(root, ['-c', 'core.attributesFile=/dev/null', 'check-attr', '--cached', '-z', '--stdin', 'filter'], authorityEnv, `${paths.join('\0')}\0`)).split('\0') : [];
      const tracked = new Set<string>();
      for (let i = 0; i + 2 < attrs.length; i += 3) if (attrs[i + 2] === 'lfs' && attrs[i]) tracked.add(attrs[i]!);
      for (const path of paths) {
        const entry = current.get(path); const original = headEntries.get(path);
        if (!entry || entry.oid === original?.oid) continue;
        const oldBytes = original && Number(text(await git(root, ['cat-file', '-s', original.oid]))) <= 1024 ? await git(root, ['cat-file', 'blob', original.oid]) : null;
        const oldPointer = oldBytes ? parseGitLfsPointer(oldBytes) : null;
        if (!tracked.has(path) && !oldPointer) {
          // A working attribute edit may already have run a clean filter in the real index.
          // Recover that ordinary staged content without granting the edited attributes authority.
          if (kind === 'staged' && Number(text(await git(root, ['cat-file', '-s', entry.oid]))) <= 1024) {
            const pointer = parseGitLfsPointer(await git(root, ['cat-file', 'blob', entry.oid]));
            if (pointer && text(await git(root, ['check-attr', '-z', 'filter', '--', path])).split('\0')[2] === 'lfs') {
              const cachedPath = await cached(root, pointer);
              if (!cachedPath) throw new Error(`Cannot recover ordinary staged content for ${path}: missing local Git LFS object ${pointer.oid}`);
              const oid = text(await git(root, ['hash-object', '-w', '--no-filters', cachedPath])).trim();
              await git(root, ['update-index', '--add', '--cacheinfo', `${entry.mode},${oid},${path}`], env);
            }
          }
          continue;
        }
        const size = Number(text(await git(root, ['cat-file', '-s', entry.oid])));
        const pointer = size <= 1024 ? parseGitLfsPointer(await git(root, ['cat-file', 'blob', entry.oid])) : null;
        if (kind !== 'staged' && pointer && !available.has(pointer.oid)) {
          const confirmed = (await confirm([pointer]))[0];
          const source = confirmed ? 'origin' : await access?.store.has(pointer) ? 'r2' : null;
          if (source) {
            const object = { ...(confirmed ?? pointer), source } satisfies GitLfsSnapshot['objects'][number];
            available.set(pointer.oid, object);
            snapshot.objects.push(object);
          }
        }
        const unchangedPayload = oldPointer && size === oldPointer.size && await blobMatches(root, entry.oid, oldPointer);
        let replacement = original;
        if (kind !== 'staged' && pointer && available.has(pointer.oid)) replacement = entry;
        if (!unchangedPayload && replacement?.oid !== entry.oid && !held.has(path)) held.set(path, { path, kind: kind === 'staged' ? 'staged' : original ? 'modified' : 'added' });
        if (replacement && (oldPointer || replacement === entry)) await git(root, ['update-index', '--add', '--cacheinfo', `${replacement.mode},${replacement.oid},${path}`], env);
        else await git(root, ['update-index', '--force-remove', '--', path], env);
      }
      snapshot.heldBack = [...held.values()].sort((a, b) => a.path.localeCompare(b.path));
      snapshot.objects.sort((a, b) => a.oid.localeCompare(b.oid));
    },
  };
}

/** Bounded authenticated retention maintenance; never scans committed history. */
export async function recheckGitLfsOrigin(root: string, access: MachineGitLfs): Promise<void> {
  if (!access.confirmOrigin || access.canonicalOrigin === null) return;
  let head: string | null = null;
  try { head = text(await git(root, ['rev-parse', '--verify', 'HEAD'])).trim(); } catch { /* Unborn repositories have no committed route. */ }
  const confirm = await originConfirmation(root, head, git, await access.originEnvironment(root), { ...access, recheck: true });
  await confirm([]);
}

/** Resolve every required object before changing HEAD, index or worktree. */
export async function hydrateGitLfs(root: string, refs: string[], snapshot: GitLfsSnapshot | undefined, access?: MachineGitLfs): Promise<void> {
  if (snapshot && access?.resolveSources) snapshot.objects = await access.resolveSources(snapshot.objects);
  const required = await pointers(root, refs);
  for (const object of snapshot?.objects ?? []) required.set(object.oid, object);
  const sources = new Map(snapshot?.objects.map(object => [object.oid, object]));
  for (const object of required.values()) {
    if (await cached(root, object)) continue;
    const stored = await access?.store.get(object);
    if (stored) {
      await installLfsObject(await cachePath(root, object), object, stored); continue;
    }
    const routing = await mkdtemp(join(tmpdir(), 'gitspace-lfs-routing-'));
    try {
      const ref = refs[0];
      const config = ref ? (await tree(root, ref)).get('.lfsconfig') : undefined;
      if (config) await writeFile(join(routing, '.lfsconfig'), await git(root, ['cat-file', 'blob', config.oid]));
      const gitDirectory = text(await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
      const source = sources.get(object.oid);
      const location = source?.source === 'origin' ? source.location : undefined;
      const environment = await access?.originEnvironment(root) ?? {};
      const endpoint = location ? await hydrationEndpoint(root, ref, location.endpoint, git, environment) : undefined;
      const route = location ? ['-c', `remote.origin.url=${location.origin}`, '-c', `lfs.url=${endpoint}`] : [];
      const sourceBytes = endpoint && new URL(endpoint).search
        ? await downloadQueryObject(root, endpoint, object, git, environment)
        : gitPayload(root, [...route, '-c', `lfs.storage=${join(routing, 'lfs')}`, '-c', 'remote.lfsdefault=origin', '-c', 'lfs.fetchinclude=', '-c', 'lfs.fetchexclude=', 'lfs', 'smudge'], {
          ...environment, GIT_DIR: gitDirectory, GIT_WORK_TREE: routing,
          GIT_LFS_SKIP_SMUDGE: '0', GIT_LFS_SKIP_DOWNLOAD_ERRORS: '0',
        }, `version https://git-lfs.github.com/spec/v1\noid sha256:${object.oid}\nsize ${object.size}\n`);
      const path = await cachePath(root, object);
      await installLfsObject(path, object, sourceBytes);
    }
    catch (error) { throw new Error(`Missing Git LFS object ${object.oid}: R2 and origin hydration failed`, { cause: error }); }
    finally { await rm(routing, { recursive: true, force: true }); }
    if (!await cached(root, object)) throw new Error(`Missing Git LFS object ${object.oid} after origin hydration`);
  }
}

export async function restoredGitLfsPaths(root: string, worktreeCommit: string, snapshot: GitLfsSnapshot | undefined) {
  const entries = await tree(root, worktreeCommit);
  return (snapshot?.heldBack ?? []).map(item => ({ path: item.path, outcome: entries.has(item.path) ? 'committed' as const : 'omitted' as const }));
}

/** A local-only tree for patch preimages; hydrated payloads are never checkpoint parents. */
export async function gitLfsWorktreeTree(root: string, ref: string, otherRef: string, protectedPaths: readonly string[]): Promise<string> {
  const entries = await tree(root, ref);
  const other = await tree(root, otherRef);
  const temporary = await mkdtemp(join(tmpdir(), 'gitspace-lfs-delta-'));
  const env = { GIT_INDEX_FILE: join(temporary, 'index') };
  try {
    await git(root, ['read-tree', ref], env);
    for (const [path, entry] of entries) {
      if (protectedPaths.includes(path) || other.get(path)?.oid === entry.oid || entry.mode === '120000' || Number(text(await git(root, ['cat-file', '-s', entry.oid]))) > 1024) continue;
      const object = parseGitLfsPointer(await git(root, ['cat-file', 'blob', entry.oid]));
      if (!object) continue;
      const payload = await cached(root, object);
      if (!payload) throw new Error(`Missing Git LFS object ${object.oid} for cache delta`);
      const oid = text(await git(root, ['hash-object', '-w', '--no-filters', '--', payload])).trim();
      await git(root, ['update-index', '--add', '--cacheinfo', entry.mode, oid, path], env);
    }
    return text(await git(root, ['write-tree'], env)).trim();
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export async function checkoutGitLfs(root: string, ref: string, protectedPaths?: readonly string[]): Promise<void> {
  for (const [path, entry] of await tree(root, ref)) {
    if (protectedPaths?.includes(path)) continue;
    if (entry.mode === '120000' || Number(text(await git(root, ['cat-file', '-s', entry.oid]))) > 1024) continue;
    const object = parseGitLfsPointer(await git(root, ['cat-file', 'blob', entry.oid]));
    if (!object) continue;
    if (protectedPaths) {
      const current = parseGitLfsPointer(await readFile(resolve(root, path)));
      // Replica synchronization must not replace hydrated or concurrently edited
      // local content. Only the exact newly installed pointer is hydrated.
      if (!current || current.oid !== object.oid || current.size !== object.size) continue;
    }
    const cachedPath = await cached(root, object);
    if (!cachedPath) throw new Error(`Missing Git LFS object ${object.oid} during checkout`);
    await writeFile(resolve(root, path), createReadStream(cachedPath));
  }
}

export async function gitLfsRestoreReceipt(root: string, action: 'read' | 'clear' | GitLfsRestored[]): Promise<GitLfsRestored[] | undefined> {
  const path = resolve(root, text(await git(root, ['rev-parse', '--git-path', 'gitspace-lfs-restored.json'])).trim());
  if (action === 'clear') { await rm(path, { force: true }); return; }
  if (action !== 'read') { await writeFile(path, JSON.stringify(action)); return action; }
  try { return GitLfsRestoredSchema.array().parse(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}
