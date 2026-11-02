import { watch, type FSWatcher } from 'node:fs';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { coalesced } from './coalesced.js';

export type GitWorktreeClock = { schedule(milliseconds: number, action: () => void): () => void };
export const gitWorktreeClock: GitWorktreeClock = {
  schedule(milliseconds, action) { const timer = setTimeout(action, milliseconds); return () => clearTimeout(timer); },
};
export type GitWorktreeEvents = (root: string, changed: (path: string) => Promise<void>, failed: (error: Error) => void) => () => void;
/** One watch over the whole checkout: macOS reports a folder tree as one stream, whatever it holds. */
const recursiveWorktreeEvents: GitWorktreeEvents = (root, changed, failed) => {
  const watcher = watch(root, { recursive: true }, (_event, filename) => { void changed(filename?.toString().replaceAll('\\', '/') ?? '').catch(failed); });
  watcher.on('error', failed);
  return () => watcher.close();
};
export function gitWorktreeDelay(clock: GitWorktreeClock, milliseconds: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const abort = () => { cancel(); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
  const cancel = clock.schedule(milliseconds, () => { signal?.removeEventListener('abort', abort); resolve(); });
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  return promise;
}

async function watchGit(root: string, args: string[], input?: string): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd: root, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, output, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0 && !(code === 1 && (args[0] === 'config' || args[0] === 'check-ignore'))) throw new Error(`git ${args[0]}: ${error.trim()}`);
  return output;
}

/** Under a `.git` folder, the folders of Git's objects, LFS files, logs and refs other than branch heads: many (objects
 *  alone has 256), and nothing written there starts a sync (`GIT_STATE`). */
const GIT_BULK = /(?:^|\/)\.git\/(?:.+\/)?(?:objects|lfs|logs|refs\/(?:remotes|tags|gitspace))$/u;

/**
 * Linux watches each folder on its own (inotify), so one recursive `fs.watch` of a checkout held a watch for every
 * folder in it, `node_modules`, build output and Git's objects included: Darktop held 751,731 of the 1,048,576 its user
 * may, and a checkout whose watch then failed stopped noticing edits (2026-11-02). This watches only the folders where
 * Git sees a change: none Git lists as ignored (`--directory` names a folder only when nothing in it is tracked), and
 * none of Git's bulk folders (`GIT_BULK`). A
 * folder that appears is watched; an ignore file's change (`.gitignore`, `.git/info/exclude`, `.git/config`) asks Git
 * again and lets go of what it now ignores. A folder only a global excludes file stops ignoring is watched from the next
 * look.
 */
export const linuxWorktreeEvents: GitWorktreeEvents = (root, changed, failed) => {
  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let ignored = new Set<string>();
  const skipped = (path: string) => GIT_BULK.test(path) || ignored.has(path);
  const fail = (error: unknown) => failed(error instanceof Error ? error : new Error(String(error)));
  const drop = (path: string) => {
    for (const [watched, watcher] of watchers) if (watched === path || watched.startsWith(`${path}/`)) { watcher.close(); watchers.delete(watched); }
  };
  /** Watches `path` and each folder under it that is not skipped. */
  const walk = async (path: string): Promise<void> => {
    if (closed || skipped(path)) return;
    const absolute = path ? join(root, path) : root;
    if (!watchers.has(path)) {
      try {
        const watcher = watch(absolute, (_event, name) => { if (name) void event(path ? `${path}/${name}` : name.toString()); });
        watcher.on('error', fail);
        watchers.set(path, watcher);
      } catch (error) {
        // Gone before it was watched: its parent's event already said so.
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
        throw error;
      }
    }
    const entries = await readdir(absolute, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory()) await walk(path ? `${path}/${entry.name}` : entry.name);
  };
  const look = coalesced(async () => {
    const others = await watchGit(root, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
    if (closed) return;
    ignored = new Set(others.split('\0').filter(path => path.endsWith('/')).map(path => path.slice(0, -1)));
    for (const path of [...watchers.keys()]) if (watchers.has(path) && skipped(path)) drop(path);
    await walk('');
  });
  const event = async (name: string) => {
    if (closed) return;
    void changed(name).catch(fail);
    try {
      if (name === '.gitignore' || name.endsWith('/.gitignore') || name === '.git/info/exclude' || name === '.git/config') { await look(); return; }
      const stat = await lstat(join(root, name)).catch(() => null);
      if (stat?.isDirectory()) await walk(name);
      else if (!stat) drop(name);
    } catch (error) { fail(error); }
  };
  void look().catch(fail);
  return () => { closed = true; for (const watcher of watchers.values()) watcher.close(); watchers.clear(); };
};

export const gitWorktreeEvents: GitWorktreeEvents = process.platform === 'linux' ? linuxWorktreeEvents : recursiveWorktreeEvents;

/** Under `.git/`, what a checkpoint records besides the index: where HEAD points and the branch heads (a submodule's
 * too). Everything else there is Git's or GitSpace's own work (objects, LFS temporary files, logs, fetched refs, GitSpace
 * records) and starts no sync; a denylist kept missing new ones, `.git/lfs/tmp` last (2026-11-02). */
const GIT_STATE = /^\.git\/(?:modules\/.+\/)?(?:HEAD|packed-refs|refs\/heads\/.+)(?<!\.lock)$/u;

/** Git is the authority for untracked inclusion, both here and during capture.
 * Cache exact paths only: an ignored directory can still contain tracked files.
 * Metadata polling covers external/global config and excludes files, including
 * replacement or a newly configured path outside the recursive worktree watch.
 */
export async function watchGitWorktree(options: {
  root: string;
  clock: GitWorktreeClock;
  events: GitWorktreeEvents;
  /** `worktree`: a file in the checkout changed (a person's or tool's edit). `git`: only Git's own metadata or ignore
   * configuration did, which git commands (`git status` refreshing the index) also change. */
  changed(cause: 'worktree' | 'git'): void;
  failed(error: Error): void;
}): Promise<{ close(): void }> {
  const cache = new Map<string, boolean>();
  let generation = 0;
  let closed = false;
  let pollCancel: (() => void) | undefined;
  const readOptional = async (path: string) => {
    try { return await readFile(path, 'utf8'); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    }
  };
  // The index and this checkout's exclude file stay where they are; the excludes file moves only with configuration, so
  // it is looked up again when `.git/config` changes and once a minute for global configuration, which nothing watches.
  // The 5 s poll then only reads files: it ran three `git` processes per checkout (2026-11-02).
  const [info, index] = await Promise.all([
    watchGit(options.root, ['rev-parse', '--git-path', 'info/exclude']),
    watchGit(options.root, ['rev-parse', '--git-path', 'index']),
  ]);
  const infoPath = resolve(options.root, info.trim());
  const indexPath = resolve(options.root, index.trim());
  const excludesFile = async () => {
    const configured = await watchGit(options.root, ['config', '--path', '--get', 'core.excludesFile']);
    return configured === '' ? join(Bun.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'ignore') : configured.replace(/\n$/, '');
  };
  let excludes = await excludesFile();
  const metadata = async () => {
    const index = await lstat(indexPath, { bigint: true }).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    return JSON.stringify([
      excludes,
      excludes === '' ? null : await readOptional(resolve(options.root, excludes)),
      await readOptional(infoPath),
      index && [index.ino.toString(), index.size.toString(), index.mtimeNs.toString(), index.ctimeNs.toString()],
    ]);
  };
  let previousMetadata = await metadata();
  const invalidate = () => { generation++; cache.clear(); };
  /** Starts a `git` sync when Git's index or ignore configuration changed since the last look; true when it did. With
   *  `configuration`, the excludes file is looked up again first. */
  const refresh = async (configuration: boolean) => {
    if (configuration) excludes = await excludesFile();
    const next = await metadata();
    if (closed || next === previousMetadata) return false;
    previousMetadata = next;
    invalidate();
    options.changed('git');
    return true;
  };
  let polls = 0;
  const poll = () => {
    pollCancel = options.clock.schedule(5000, () => {
      void refresh(++polls % 12 === 0).catch(error => options.failed(error instanceof Error ? error : new Error(String(error))))
        .finally(() => { if (!closed) poll(); });
    });
  };
  const pending = new Set<string>();
  let processing: Promise<void> | undefined;
  const classify = async () => {
    while (pending.size > 0 && !closed) {
      const paths = [...pending];
      pending.clear();
      const version = generation;
      const unknown = paths.filter(path => !cache.has(path));
      let relevant = paths.some(path => cache.get(path) === false);
      if (unknown.length) {
        const ignored = new Set((await watchGit(options.root, ['check-ignore', '-z', '--stdin'], `${unknown.join('\0')}\0`)).split('\0').filter(Boolean));
        if (closed) return;
        if (version !== generation) { for (const path of paths) pending.add(path); continue; }
        relevant ||= unknown.some(path => !ignored.has(path));
        // Bound memory without changing this batch's inclusion decisions.
        if (cache.size + unknown.length > 4096) cache.clear();
        for (const path of unknown.slice(-4096)) cache.set(path, ignored.has(path));
      }
      if (relevant) options.changed('worktree');
    }
  };
  // What under `.git/` starts syncs, at most once a minute: an editor's `git status` rewrites the index, for one.
  let gitLogged = 0;
  const gitEvent = (name: string) => {
    if (Date.now() - gitLogged < 60_000) return;
    gitLogged = Date.now();
    console.info(JSON.stringify({ event: 'worktree_git_event', root: options.root, name }));
  };
  const stopEvents = options.events(options.root, async name => {
    if (closed) return;
    if (!name || name === '.git' || name === '.git/index' || name === '.git/config' || name === '.git/info/exclude' || name === '.gitignore' || name.endsWith('/.gitignore')) {
      invalidate();
      // Refresh the external ignore baseline now, so subsequent external edits
      // are compared to this config, not to a stale path from watcher startup.
      // macOS reports `.git/index` changed when nothing in it did, for git commands that only read it (capture's own
      // among them, so each capture started the next): only a real change, which `refresh` compares, starts a sync.
      if (await refresh(!name || name === '.git' || name === '.git/config')) gitEvent(name);
      if (!closed && name.endsWith('.gitignore')) options.changed('worktree');
      return;
    }
    if (name.startsWith('.git/')) {
      if (GIT_STATE.test(name)) { gitEvent(name); options.changed('git'); }
      return;
    }
    pending.add(name);
    do {
      if (!processing) {
        // One microtask batches the filenames from a native event burst.
        processing = Promise.resolve().then(classify).finally(() => { processing = undefined; });
      }
      await processing;
    } while (pending.has(name) && !closed);
  }, options.failed);
  poll();
  return { close() { closed = true; pollCancel?.(); stopEvents(); pending.clear(); cache.clear(); } };
}
