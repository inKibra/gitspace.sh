import { watch } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type GitWorktreeClock = { schedule(milliseconds: number, action: () => void): () => void };
export const gitWorktreeClock: GitWorktreeClock = {
  schedule(milliseconds, action) { const timer = setTimeout(action, milliseconds); return () => clearTimeout(timer); },
};
export type GitWorktreeEvents = (root: string, changed: (path: string) => Promise<void>, failed: (error: Error) => void) => () => void;
export const gitWorktreeEvents: GitWorktreeEvents = (root, changed, failed) => {
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

/** Git is the authority for untracked inclusion, both here and during capture.
 * Cache exact paths only: an ignored directory can still contain tracked files.
 * Metadata polling covers external/global config and excludes files, including
 * replacement or a newly configured path outside the recursive worktree watch.
 */
export async function watchGitWorktree(options: {
  root: string;
  clock: GitWorktreeClock;
  events: GitWorktreeEvents;
  changed(): void;
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
  const metadata = async () => {
    const [configured, infoPath, indexPath] = await Promise.all([
      watchGit(options.root, ['config', '--path', '--get', 'core.excludesFile']),
      watchGit(options.root, ['rev-parse', '--git-path', 'info/exclude']),
      watchGit(options.root, ['rev-parse', '--git-path', 'index']),
    ]);
    const excludes = configured === '' ? join(Bun.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'ignore') : configured.replace(/\n$/, '');
    const index = await lstat(resolve(options.root, indexPath.trim()), { bigint: true }).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
      throw error;
    });
    return JSON.stringify([
      excludes,
      excludes === '' ? null : await readOptional(resolve(options.root, excludes)),
      await readOptional(resolve(options.root, infoPath.trim())),
      index && [index.ino.toString(), index.size.toString(), index.mtimeNs.toString(), index.ctimeNs.toString()],
    ]);
  };
  let previousMetadata = await metadata();
  const invalidate = () => { generation++; cache.clear(); };
  const refresh = async () => {
    const next = await metadata();
    if (closed || next === previousMetadata) return;
    previousMetadata = next;
    invalidate();
    options.changed();
  };
  const poll = () => {
    pollCancel = options.clock.schedule(5000, () => {
      void refresh().catch(error => options.failed(error instanceof Error ? error : new Error(String(error))))
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
      if (relevant) options.changed();
    }
  };
  const stopEvents = options.events(options.root, async name => {
    if (closed || name.startsWith('.git/objects/') || name.startsWith('.git/refs/gitspace/') || name.startsWith('.git/logs/refs/gitspace/') || (name.startsWith('.git/') && name.endsWith('.lock'))) return;
    if (!name || name === '.git' || name === '.git/index' || name === '.git/config' || name === '.git/info/exclude' || name === '.gitignore' || name.endsWith('/.gitignore')) {
      invalidate();
      // Refresh the external ignore baseline now, so subsequent external edits
      // are compared to this config, not to a stale path from watcher startup.
      await refresh();
      if (!closed) options.changed();
      return;
    }
    if (name.startsWith('.git/')) { options.changed(); return; }
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
