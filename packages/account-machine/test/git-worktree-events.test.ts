import { afterEach, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxWorktreeEvents } from '../src/git-worktree-watch.js';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...Bun.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@gitspace.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@gitspace.invalid' } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
}

/** Writes `path` until the watcher reports it. Real inotify against a real checkout: a folder's watch is added a moment
 * after the folder appears, and the look after an ignore change finishes on its own, with no signal to await, so this
 * polls (each round a 20 ms wait). */
async function reported(seen: Set<string>, root: string, path: string): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt++) {
    appendFileSync(join(root, path), 'x');
    await Bun.sleep(20);
    if (seen.has(path)) return true;
  }
  return false;
}

/** Writes `path`, then a watched file: every watch shares one inotify instance, read in order, so once the watched
 *  write is reported, a report of `path` would have come before it. */
async function unreported(seen: Set<string>, root: string, path: string): Promise<boolean> {
  seen.delete(path);
  seen.delete('src/app.ts');
  appendFileSync(join(root, path), 'x');
  if (!await reported(seen, root, 'src/app.ts')) throw new Error('The watched file was not reported');
  return !seen.has(path);
}

test('on Linux, watches only the folders where Git sees a change, and follows new folders and ignore rules', async () => {
  if (process.platform !== 'linux') return;
  const root = mkdtempSync(join(tmpdir(), 'gitspace-worktree-events-'));
  roots.push(root);
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\nbuild/\n');
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'app.ts'), 'app\n');
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'pkg\n');
  mkdirSync(join(root, 'build', 'kept'), { recursive: true });
  mkdirSync(join(root, 'build', 'cache'), { recursive: true });
  writeFileSync(join(root, 'build', 'kept', 'version.txt'), '1\n');
  writeFileSync(join(root, 'build', 'cache', 'chunk.js'), 'chunk\n');
  git(root, 'add', '.gitignore', 'src');
  git(root, 'add', '-f', 'build/kept/version.txt');
  git(root, 'commit', '-qm', 'base');
  // An object folder exists before the watch starts, as in any repository.
  mkdirSync(join(root, '.git', 'objects', 'ab'), { recursive: true });
  writeFileSync(join(root, '.git', 'objects', 'ab', 'object'), '');
  const seen = new Set<string>();
  closers.push(linuxWorktreeEvents(root, async path => { seen.add(path); }, error => { throw error; }));

  expect(await reported(seen, root, 'src/app.ts')).toBe(true);
  // A tracked file inside an ignored folder is still a change Git sees; that folder's ignored subfolders are not.
  expect(await reported(seen, root, 'build/kept/version.txt')).toBe(true);
  expect(await unreported(seen, root, 'build/cache/chunk.js')).toBe(true);
  expect(await unreported(seen, root, 'node_modules/pkg/index.js')).toBe(true);
  expect(await unreported(seen, root, '.git/objects/ab/object')).toBe(true);
  // A folder made after the watch started is watched once it appears.
  mkdirSync(join(root, 'src', 'feature'));
  expect(await reported(seen, root, 'src/feature/new.ts')).toBe(true);
  // Ignored from now on: once the watcher has asked Git again, its edits are no longer reported.
  appendFileSync(join(root, '.gitignore'), 'src/feature/\n');
  let attempts = 0;
  while (!await unreported(seen, root, 'src/feature/new.ts') && ++attempts < 50);
  expect(await unreported(seen, root, 'src/feature/new.ts')).toBe(true);
});
