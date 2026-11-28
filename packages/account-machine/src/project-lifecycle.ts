import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { normalizeRemoteRepositoryUrl } from '@gitspace/protocol';
import type { ProjectCopyOperation } from '@gitspace/protocol/rpc-contract';
import { ArtifactsRefDivergedError, type ArtifactsGitRemote } from './artifacts-git-remote.js';
import { atomicJson } from './machine-update.js';

/** The origin refused a commit asked for by id: none of its refs reaches it. */
class OriginCommitMissingError extends Error {}

/** What of git's stderr a failure keeps, from its end. */
const STDERR_KEPT = 16_384;
/** A line of git's progress meter, e.g. `Receiving objects:  45% (1234/2700), 120.50 MiB | 3.20 MiB/s`. */
const PROGRESS_LINE = /^(?:remote: )?[A-Z][a-z]+(?: [a-z]+)*: +\d+% \(/u;

/** The last lines git printed that are not its progress meter, as one line, without credentials it may echo. */
function gitSaid(stderr: string): string {
  const lines = stderr.split(/[\r\n]/u).map(line => line.trim()).filter(line => line && !PROGRESS_LINE.test(line));
  return lines.slice(-4).join(' / ')
    .replace(/(authorization: *\w+) +\S+/giu, '$1 [redacted]')
    .replace(/(\/\/)[^/@\s]+@/gu, '$1[redacted]@')
    .slice(-600);
}

type GitRun = {
  cwd?: string;
  environment: Record<string, string>;
  /** Kills git when it aborts. */
  signal?: AbortSignal;
  /** Receives each line git prints on stderr, progress meter included, as it prints it. */
  progress?(line: string): void;
};

async function runGit(args: string[], run: GitRun): Promise<string> {
  run.signal?.throwIfAborted();
  const child = Bun.spawn(['git', ...args], {
    ...(run.cwd ? { cwd: run.cwd } : {}),
    env: {
      ...process.env,
      ...run.environment,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: `${run.environment.GIT_SSH_COMMAND ?? process.env.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes`,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const kill = () => child.kill();
  run.signal?.addEventListener('abort', kill, { once: true });
  let stderr = '';
  const readStderr = async () => {
    const decoder = new TextDecoder();
    let partial = '';
    for await (const chunk of child.stderr) {
      const text = decoder.decode(chunk, { stream: true });
      stderr = (stderr + text).slice(-STDERR_KEPT);
      if (!run.progress) continue;
      // The meter rewrites its line with `\r`; each rewrite is a line here.
      const lines = (partial + text).split(/[\r\n]/u);
      partial = lines.pop() ?? '';
      for (const line of lines) if (line.trim()) run.progress(line.trim());
    }
  };
  const output = Promise.all([new Response(child.stdout).text(), readStderr()]);
  let exitCode: number;
  try { exitCode = await child.exited; }
  finally { run.signal?.removeEventListener('abort', kill); }
  if (run.signal?.aborted) {
    // A transport git started (ssh, a remote helper) can hold its pipes open after it was killed.
    void output.catch(() => undefined);
    throw run.signal.reason;
  }
  const [stdout] = await output;
  if (exitCode !== 0) {
    if (/not our ref|unadvertised object/iu.test(stderr)) throw new OriginCommitMissingError(`git ${args[0]} failed (exit ${exitCode}): the origin holds no such commit`);
    const said = gitSaid(stderr);
    const remote = args[0] === 'ls-remote' || args[0] === 'fetch';
    const detail = /Permission denied \(publickey\)/iu.test(stderr)
      ? ' SSH authentication failed. Add the public key from Settings → Git to a GitHub account that can access this repository.'
      : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderr)
        ? ' SSH host verification failed. Check the repository host and its trusted host key; host verification has not been disabled.'
        : /Repository not found|repository .* does not exist/iu.test(stderr)
          ? ' Repository not found or your account lacks access. Check the repository root address and SSH key permissions.'
          : /Remote branch .* not found/iu.test(stderr)
            ? ' The requested base branch was not found. Leave Base branch empty to detect the repository default.'
            : remote ? ' Check the repository address, branch, and shared SSH key access.' : '';
    throw new Error(`git ${args[0]} failed (exit ${exitCode}).${detail}${said ? ` Git said: ${said}` : ''}`);
  }
  return stdout.trim();
}

/** Whether git exits 0: a question such as `merge-base --is-ancestor`, whose no is exit 1. */
async function gitSucceeds(args: string[], cwd: string): Promise<boolean> {
  return await Bun.spawn(['git', ...args], { cwd, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).exited === 0;
}

/** Bytes per unit of git's progress meter. */
const SIZE_UNITS: Record<string, number> = { bytes: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

/** A project's copy of its base branch after a copy through a machine: the commit it held before (`previous`, null
 * when it had none) and the origin's tip it holds now (`commit`, equal to `previous` when it was already current). */
export type ProjectCopy = { baseBranch: string; previous: string | null; commit: string };

/** How a copy ended: the copy `moved` from `previous` to `commit`, was `current` already, or `diverged` (it is at
 * `previous`, which `commit`, origin's tip, does not build on); or the origin has no branches (`empty`). */
export type ProjectCopyOutcome = ProjectCopy & { state: 'moved' | 'current' | 'diverged' } | { state: 'empty'; baseBranch: string };

export interface SeedProjectRepositoryInput {
  projectId: string;
  repositoryUrl: string;
  /** Null selects the remote's default branch. */
  baseBranch: string | null;
  /** The project's origin cache: a bare repository this machine keeps across copies, created when missing. */
  cachePath: string;
  /** Checkouts of the project on this machine, its base checkout first, whose objects fill an empty cache. */
  checkouts: readonly string[];
  /** Whether git checks the cache for missing objects before it is continued: after a copy that did not finish
   * cleanly (it failed, the watchdog stopped it, or the machine stopped during it). */
  verify: boolean;
  /** SSH environment for the account's shared git identity. */
  gitEnvironment: Record<string, string>;
  projectRepository: Pick<ArtifactsGitRemote, 'readRef' | 'publishRef' | 'advanceRef' | 'clearStaging'>;
  /** Receives each change to the copy while it runs. */
  report(change: Partial<ProjectCopyOperation>): void;
  /** Kills the git the copy runs. */
  signal: AbortSignal;
}

/** Why the origin cache at `path` cannot be continued, or null when it can (or does not exist yet): it records another
 * origin, or, when `verify`, git finds objects missing from it. */
async function cacheProblem(path: string, repositoryUrl: string, verify: boolean, signal: AbortSignal): Promise<string | null> {
  if (!existsSync(path)) return null;
  let recorded = '';
  try { recorded = await runGit(['config', '--file', join(path, 'config'), '--get', 'gitspace.origin'], { environment: {}, signal }); }
  catch { signal.throwIfAborted(); }
  if (recorded === '') return 'the cache records no origin';
  if (recorded !== repositoryUrl) return `the project's origin changed from ${recorded} to ${repositoryUrl}`;
  if (!verify) return null;
  try { await runGit(['fsck', '--connectivity-only', '--no-dangling', '--no-progress'], { cwd: path, environment: {}, signal }); }
  catch (error) {
    signal.throwIfAborted();
    return `the cache failed git fsck --connectivity-only: ${error instanceof Error ? error.message : String(error)}`;
  }
  return null;
}

/** An empty origin cache at `path` for `repositoryUrl`, replacing whatever is there. */
async function createCache(path: string, repositoryUrl: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
  await mkdir(dirname(path), { recursive: true });
  await runGit(['init', '--quiet', '--bare', path], { environment: {} });
  await runGit(['config', 'gitspace.origin', repositoryUrl], { cwd: path, environment: {} });
}

/** Removes what a git killed mid-run leaves in a repository: partial packs (`objects/pack/tmp_*`), quarantined
 * objects (`objects/incoming-*`) and lock files. Runs only while no git uses the repository. */
async function clearInterruptedGit(path: string): Promise<void> {
  const objects = join(path, 'objects');
  for (const name of await readdir(join(objects, 'pack')).catch(() => [])) if (name.startsWith('tmp_')) await rm(join(objects, 'pack', name), { force: true });
  for (const name of await readdir(objects).catch(() => [])) if (name.startsWith('incoming-')) await rm(join(objects, name), { recursive: true, force: true });
  for (const name of await readdir(path).catch(() => [])) if (name.endsWith('.lock')) await rm(join(path, name), { force: true });
  for (const name of await readdir(join(path, 'refs'), { recursive: true }).catch(() => [])) if (name.endsWith('.lock')) await rm(join(path, 'refs', name), { force: true });
}

/**
 * Brings `project-<projectId>`'s copy of a project's base branch to its origin's tip, read over SSH with this machine's
 * git identity, so the cloud can fork workspaces from origins it cannot reach. Git reads the origin into the project's
 * origin cache on this machine, which every later copy continues: a fetch sends only what the cache lacks, and one cut
 * short loses only its own partial pack. A new cache is filled from a checkout of the project on this machine first.
 * The cache starts over only when it cannot be continued (`cacheProblem`), or when it is shallow between the copy's
 * commit and the tip, so their ancestry cannot be read from it; `fresh` reports why.
 * A copy without the branch gets the tip alone; a copy at an ancestor of the tip is fast-forwarded, the push sending
 * only the commits after it; a copy at the tip is left as it is. A copy at any other commit is not moved (`diverged`):
 * GitSpace only fast-forwards it. An origin with no branches has nothing to copy (`empty`).
 */
export async function seedProjectRepository(input: SeedProjectRepositoryInput): Promise<ProjectCopyOutcome> {
  const { signal, report } = input;
  const repositoryUrl = normalizeRemoteRepositoryUrl(input.repositoryUrl.trim());
  report({ phase: 'reading-origin' });
  // `ref: refs/heads/<branch>\tHEAD` names the default branch; `<commit>\t<ref>` lines name the branches.
  const advertised = (await runGit(['ls-remote', '--symref', '--', repositoryUrl, 'HEAD', 'refs/heads/*'], { environment: input.gitEnvironment, signal })).split('\n').map(line => line.split('\t'));
  const branches = new Map(advertised.flatMap(([commit, name]): Array<[string, string]> => commit && name?.startsWith('refs/heads/') && /^[0-9a-f]{40}$/u.test(commit) ? [[name, commit]] : []));
  if (branches.size === 0) return { state: 'empty', baseBranch: input.baseBranch ?? 'main' };
  const baseBranch = input.baseBranch ?? advertised.find(([target, name]) => name === 'HEAD' && target?.startsWith('ref: refs/heads/'))?.[0]?.slice('ref: refs/heads/'.length);
  if (baseBranch === undefined) throw new Error(`${input.repositoryUrl} names no default branch: set the project's base branch`);
  const ref = `refs/heads/${baseBranch}`;
  const head = branches.get(ref);
  if (head === undefined) throw new Error('The requested base branch was not found. Leave Base branch empty to detect the repository default.');
  report({ phase: 'checking-cache', baseBranch });
  const cache = input.cachePath;
  const fresh = await cacheProblem(cache, repositoryUrl, input.verify, signal);
  const created = fresh !== null || !existsSync(cache);
  if (created) await createCache(cache, repositoryUrl);
  if (fresh !== null) report({ fresh });
  const binding = { projectId: input.projectId, repository: `project-${input.projectId}` };
  /** The publication's steps, and git's own progress lines, reach the copy; aborting kills its git. */
  const watch = { signal, progress: (step: string) => report({ progress: step }) };
  const previous = await input.projectRepository.readRef({ binding, repositoryPath: cache, ref, watch });
  report({ previous, progress: previous === null ? `${binding.repository} has no ${ref} yet` : `${binding.repository} holds ${baseBranch} at ${previous}` });
  if (previous === head) return { state: 'current', baseBranch, previous, commit: head };
  if (created) {
    report({ phase: 'filling-cache' });
    for (const checkout of input.checkouts) {
      try {
        // A checkout copied in from a tip is shallow; its boundaries become the cache's.
        await runGit(['fetch', '--progress', '--no-tags', '--update-shallow', '--', checkout, '+HEAD:refs/gitspace/fill/head'], {
          cwd: cache, environment: {}, signal, progress: line => report(PROGRESS_LINE.test(line) ? { progress: line } : {}),
        });
        report({ filledFrom: checkout });
        break;
      } catch (error) {
        signal.throwIfAborted();
        console.warn('[gitspace-project-copy] the cache was not filled from a checkout', { checkout, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const received = { objects: 0, bytes: 0 };
  const fromOrigin = async (args: string[]) => {
    const before = { ...received };
    await runGit(['fetch', '--progress', '--no-tags', ...args], {
      cwd: cache, environment: input.gitEnvironment, signal, progress: line => {
        const total = /^remote: Total (\d+)/u.exec(line);
        if (total) received.objects = before.objects + Number(total[1]);
        const size = /^Receiving objects: .*?, ([\d.]+) (bytes|KiB|MiB|GiB)/u.exec(line);
        if (size) received.bytes = before.bytes + Math.round(Number(size[1]) * (SIZE_UNITS[size[2] ?? 'bytes'] ?? 1));
        report({ ...PROGRESS_LINE.test(line) ? { progress: line } : {}, received: { ...received } });
      },
    });
  };
  /** Origin's tip in the cache, with the copy's commit, or null when the origin no longer holds that commit. */
  const fetchTip = async (): Promise<string | null> => {
    report({ phase: 'fetching' });
    if (previous !== null && !await gitSucceeds(['cat-file', '-e', `${previous}^{commit}`], cache)) {
      // The copy's commit alone, then the tip: a fetch into a repository holding the copy's commit brings only the
      // commits after it. It lands on a ref, since only commits refs reach are offered to the origin as held.
      try { await fromOrigin(['--depth', '1', '--', repositoryUrl, `+${previous}:refs/gitspace/previous`]); }
      catch (error) { if (error instanceof OriginCommitMissingError) return null; throw error; }
    }
    // A first copy publishes the tip alone, so an empty cache fetches only the tip.
    const empty = await runGit(['for-each-ref', '--count=1', '--format=%(refname)'], { cwd: cache, environment: {}, signal }) === '';
    await fromOrigin([...previous === null && empty ? ['--depth', '1'] : [], '--', repositoryUrl, `+${ref}:${ref}`]);
    // The tip as fetched: the branch may have moved since it was listed.
    const tip = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: cache, environment: {}, signal });
    // The filled objects and the copy's commit are the fetched tip's history now, or unrelated to it.
    for (const filled of (await runGit(['for-each-ref', '--format=%(refname)', 'refs/gitspace/'], { cwd: cache, environment: {}, signal })).split('\n').filter(Boolean)) {
      await runGit(['update-ref', '-d', filled], { cwd: cache, environment: {}, signal });
    }
    return tip;
  };
  const diverged = (commit: string): ProjectCopyOutcome => ({ state: 'diverged', baseBranch, previous, commit });
  let tip = await fetchTip();
  if (tip === null) return diverged(head);
  if (previous === tip) return { state: 'current', baseBranch, previous, commit: tip };
  // A publication cut short (a stopped copy, a killed machine) leaves staging refs only the next one deletes.
  report({ phase: 'publishing' });
  await input.projectRepository.clearStaging({ binding, repositoryPath: cache, watch });
  if (previous === null) {
    const objects = await runGit(['rev-list', '--objects', '--count', '--no-walk', tip], { cwd: cache, environment: {}, signal });
    report({ phase: 'publishing', commit: tip, progress: `Publishing ${baseBranch} at ${tip.slice(0, 7)} into ${binding.repository}, its tree alone: ${objects} objects` });
    await input.projectRepository.publishRef({ binding, repositoryPath: cache, ref, commit: tip, watch });
    return { state: 'moved', baseBranch, previous, commit: tip };
  }
  if (!await gitSucceeds(['merge-base', '--is-ancestor', previous, tip], cache)) {
    // The tip's history in the cache ends at one of its shallow boundaries, below which the copy's commit may lie: from
    // the cache alone it is unknown whether the tip builds on it. A history that ends at its root proves it does not.
    const shallow = join(cache, 'shallow');
    let cut = false;
    for (const boundary of existsSync(shallow) ? (await readFile(shallow, 'utf8')).split('\n').filter(Boolean) : []) {
      if (await gitSucceeds(['merge-base', '--is-ancestor', boundary, tip], cache)) { cut = true; break; }
    }
    if (!cut) return diverged(tip);
    report({ fresh: `the cache is shallow between the project's copy of ${baseBranch} (${previous.slice(0, 7)}) and origin's tip (${tip.slice(0, 7)})` });
    await createCache(cache, repositoryUrl);
    tip = await fetchTip();
    if (tip === null) return diverged(head);
    if (previous === tip) return { state: 'current', baseBranch, previous, commit: tip };
    if (!await gitSucceeds(['merge-base', '--is-ancestor', previous, tip], cache)) return diverged(tip);
  }
  const objects = await runGit(['rev-list', '--objects', '--count', tip, '--not', previous], { cwd: cache, environment: {}, signal });
  report({ phase: 'publishing', commit: tip, progress: `Publishing ${baseBranch} into ${binding.repository}: ${previous.slice(0, 7)} → ${tip.slice(0, 7)}, ${objects} objects` });
  try { await input.projectRepository.advanceRef({ binding, repositoryPath: cache, ref, from: previous, commit: tip, watch }); }
  catch (error) { if (error instanceof ArtifactsRefDivergedError) return diverged(tip); throw error; }
  return { state: 'moved', baseBranch, previous, commit: tip };
}

export interface ProjectCopyOptions {
  /** The project as the account holds it: its origin and base branch ('HEAD': the origin's default branch). */
  project(projectId: string): Promise<{ repositoryReference: string | null; baseBranch: string } | null>;
  /** This machine's data directory. Origin caches (`origins/<projectId>.git`) and each project's latest copy
   * (`origins/<projectId>.copy.json`) live under it. */
  root: string;
  /** Checkouts of the project on this machine, its base checkout first. */
  checkouts(projectId: string): readonly string[];
  /** How Git reaches an origin address with the account's shared git identity. */
  gitEnvironment(repositoryUrl: string): Record<string, string>;
  projectRepository: Pick<ArtifactsGitRemote, 'readRef' | 'publishRef' | 'advanceRef' | 'clearStaging'>;
  /** Asks the account for Update base with a copy that moved or was current (`project.base.update`); the queued
   * operation's id. */
  updateBase(projectId: string, copied: ProjectCopy): Promise<string>;
  /** How long a copy may go without progress before it fails, in ms: `STALL_MS` unless given. */
  stallMs?: number;
}

/** A copy fails after ten minutes without a line from git or a step reached; its total time has no limit. */
const STALL_MS = 10 * 60_000;
/** A running copy's record is written at most this often for progress alone; a new step and the end at once. */
const RECORD_INTERVAL_MS = 5_000;
/** How long a stopped copy's git gets to exit before its leftovers are cleared. */
const GIT_EXIT_MS = 5_000;
/** How many copies that ended stay readable per project. */
const KEPT_COPIES = 5;

const PHASES: Record<NonNullable<ProjectCopyOperation['phase']>, string> = {
  'reading-origin': 'reading the origin', 'checking-cache': 'checking the cache of the origin', 'filling-cache': 'filling the cache from a checkout',
  fetching: 'fetching from the origin', publishing: 'publishing into GitSpace', 'updating-base': 'asking the account for Update base',
};

const ProjectCopyRecordSchema = z.object({
  operationId: z.string(),
  projectId: z.string(),
  state: z.enum(['running', 'moved', 'current', 'diverged', 'failed']),
  phase: z.enum(['reading-origin', 'checking-cache', 'filling-cache', 'fetching', 'publishing', 'updating-base']).nullable(),
  progress: z.string().nullable(),
  received: z.object({ objects: z.number(), bytes: z.number() }),
  fresh: z.string().nullable(),
  filledFrom: z.string().nullable(),
  baseBranch: z.string().nullable(),
  previous: z.string().nullable(),
  commit: z.string().nullable(),
  error: z.string().nullable(),
  then: z.enum(['updateBase']).nullable(),
  updatedBase: z.object({ state: z.enum(['done', 'failed']), message: z.string() }).nullable(),
  startedAt: z.string(),
  updatedAt: z.string(),
});

type RunningCopy = { view: ProjectCopyOperation; controller: AbortController; stopping: boolean; recorded: Promise<void>; done: Promise<void> };

/**
 * The machine's project copies (`project.seed`): each runs in the background, one per project at a time, and its record
 * (`origins/<projectId>.copy.json`) keeps its step, progress and outcome for `project.seedOperation`; the last
 * `KEPT_COPIES` copies that ended stay readable (`origins/<projectId>.copies.json`). A copy has no time limit; it fails
 * only after `stallMs` without progress. A machine stopping (a release update) leaves its running copies recorded as
 * running, and the next start continues them from the origin cache (`resume`). The record's `state` also says whether
 * the last copy finished cleanly: after one that `failed` (the watchdog's stops included) or was left `running`, the
 * next copy checks the cache with `git fsck` first; after any other it continues the cache unchecked.
 */
export class ProjectCopies {
  private readonly running = new Map<string, RunningCopy>();
  private readonly origins: string;

  constructor(private readonly options: ProjectCopyOptions) {
    this.origins = join(options.root, 'origins');
  }

  /** Starts copying the project, or returns its copy already running, which takes on `then`. */
  async start(projectId: string, then: 'updateBase' | null = null): Promise<ProjectCopyOperation> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) throw new Error(`Invalid project id ${projectId}`);
    let held = this.running.get(projectId);
    // A copy that ended clears what its git left before the next one starts.
    if (held && held.view.state !== 'running') await held.done;
    const previous = this.running.has(projectId) ? null : await this.record(join(this.origins, `${projectId}.copy.json`));
    held = this.running.get(projectId);
    if (held) {
      if (then !== null) held.view = { ...held.view, then };
      return held.view;
    }
    const now = new Date().toISOString();
    const copy = this.launch({
      operationId: crypto.randomUUID(), projectId, state: 'running', phase: 'reading-origin', progress: null, received: { objects: 0, bytes: 0 },
      fresh: null, filledFrom: null, baseBranch: null, previous: null, commit: null, error: null, then, updatedBase: null, startedAt: now, updatedAt: now,
    }, previous === null || previous.state === 'failed' || previous.state === 'running');
    await copy.recorded;
    return copy.view;
  }

  /** The project's copy `operationId` as it stands, or null when this machine holds no such copy, running or among the
   * last `KEPT_COPIES` that ended. */
  async read(projectId: string, operationId: string): Promise<ProjectCopyOperation | null> {
    const held = this.running.get(projectId);
    if (held?.view.operationId === operationId) return held.view;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(projectId)) return null;
    const record = await this.record(join(this.origins, `${projectId}.copy.json`));
    if (record?.operationId === operationId) return record;
    return (await this.ended(projectId)).find(copy => copy.operationId === operationId) ?? null;
  }

  /** The project's last `KEPT_COPIES` copies that ended, newest first. */
  private async ended(projectId: string): Promise<ProjectCopyOperation[]> {
    try {
      const parsed = z.array(ProjectCopyRecordSchema).safeParse(JSON.parse(await readFile(join(this.origins, `${projectId}.copies.json`), 'utf8')));
      return parsed.success ? parsed.data : [];
    } catch { return []; }
  }

  /** At machine start: removes what copies cut short left behind, and continues every copy recorded as running. */
  async resume(): Promise<void> {
    // Copies before origin caches cloned into `seed-*` directories under the data directory.
    for (const entry of await readdir(this.options.root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isDirectory() && entry.name.startsWith('seed-')) await rm(join(this.options.root, entry.name), { recursive: true, force: true });
    }
    await mkdir(this.origins, { recursive: true });
    for (const entry of await readdir(this.origins, { withFileTypes: true })) {
      const path = join(this.origins, entry.name);
      if (entry.isDirectory() && entry.name.endsWith('.git') && !this.running.has(entry.name.slice(0, -'.git'.length))) await clearInterruptedGit(path);
      // A record write cut short (`atomicJson` writes `<name>.<uuid>` first).
      else if (entry.isFile() && /\.(?:copy|copies)\.json\./u.test(entry.name)) await rm(path, { force: true });
    }
    for (const entry of await readdir(this.origins, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.copy.json')) continue;
      const record = await this.record(join(this.origins, entry.name));
      if (record?.state !== 'running' || this.running.has(record.projectId)) continue;
      this.launch({ ...record, progress: 'Continuing after the machine restarted', updatedAt: new Date().toISOString() }, true);
    }
  }

  /** Stops every running copy's git and leaves it recorded as running, for `resume` to continue. */
  async stop(): Promise<void> {
    const copies = [...this.running.values()];
    for (const copy of copies) {
      copy.stopping = true;
      copy.controller.abort(new Error('The machine is stopping'));
    }
    await Promise.all(copies.map(copy => copy.done));
  }

  private async record(path: string): Promise<ProjectCopyOperation | null> {
    try {
      const parsed = ProjectCopyRecordSchema.safeParse(JSON.parse(await readFile(path, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch { return null; }
  }

  private launch(initial: ProjectCopyOperation, verify: boolean): RunningCopy {
    const { projectId } = initial;
    const path = join(this.origins, `${projectId}.copy.json`);
    const cachePath = join(this.origins, `${projectId}.git`);
    const controller = new AbortController();
    let lastProgress = Date.now();
    let written = 0;
    let ended = false;
    let writes: Promise<void> = mkdir(this.origins, { recursive: true }).then(() => undefined);
    const record = (snapshot: ProjectCopyOperation): Promise<void> => {
      written = Date.now();
      writes = writes.then(() => atomicJson(path, snapshot)).catch((error: unknown) => console.error('[gitspace-project-copy] record not written', error));
      return writes;
    };
    const report = (change: Partial<ProjectCopyOperation>): void => {
      if (ended) return;
      const stepped = change.phase !== undefined && change.phase !== copy.view.phase;
      copy.view = { ...copy.view, ...change, updatedAt: new Date().toISOString() };
      lastProgress = Date.now();
      if (stepped || Date.now() - written >= RECORD_INTERVAL_MS) void record(copy.view);
    };
    const copy: RunningCopy = { view: initial, controller, stopping: false, recorded: record(initial), done: Promise.resolve() };
    this.running.set(projectId, copy);
    const stallMs = this.options.stallMs ?? STALL_MS;
    copy.done = (async () => {
      const watchdog = setInterval(() => {
        if (Date.now() - lastProgress < stallMs) return;
        const phase = copy.view.phase === null ? 'copying' : PHASES[copy.view.phase];
        const quiet = stallMs >= 60_000 ? `${Math.round(stallMs / 60_000)} minutes` : `${Math.round(stallMs / 1000)} seconds`;
        const last = copy.view.progress === null ? '' : ` (last: ${copy.view.progress})`;
        controller.abort(new Error(`No progress for ${quiet} while ${phase}${last}, so GitSpace stopped the copy. What it fetched stays in this machine's cache of the origin: copy again to continue from there.`));
      }, Math.max(50, Math.min(30_000, stallMs / 4)));
      const { promise: aborted, reject } = Promise.withResolvers<never>();
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      const copying = this.copy(projectId, cachePath, verify, report, controller.signal);
      let ending: Partial<ProjectCopyOperation> | null = null;
      try {
        const outcome = await Promise.race([copying, aborted]);
        if (outcome.state === 'diverged') {
          ending = { state: 'diverged', baseBranch: outcome.baseBranch, previous: outcome.previous, commit: outcome.commit, error: `The project's copy of ${outcome.baseBranch} is at ${outcome.previous?.slice(0, 7)}, which origin's ${outcome.baseBranch} (${outcome.commit.slice(0, 7)}) does not build on, so it was not moved: GitSpace only fast-forwards it.` };
        } else {
          const copied = { baseBranch: outcome.baseBranch, previous: outcome.previous, commit: outcome.commit };
          let updatedBase: ProjectCopyOperation['updatedBase'] = null;
          if (copy.view.then === 'updateBase') {
            report({ phase: 'updating-base', ...copied });
            try {
              const operationId = await Promise.race([this.options.updateBase(projectId, copied), aborted]);
              updatedBase = { state: 'done', message: `Update base is moving the base workspace (operation ${operationId})` };
            } catch (error) {
              if (copy.stopping) throw error;
              updatedBase = { state: 'failed', message: error instanceof Error ? error.message : String(error) };
            }
          }
          ending = { state: outcome.state, ...copied, updatedBase };
        }
      } catch (error) {
        // A stopped copy stays recorded as running.
        if (!copy.stopping) ending = { state: 'failed', error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearInterval(watchdog);
        ended = true;
        // Readers see the end once it is recorded, before anything else is awaited.
        const final: ProjectCopyOperation = ending === null ? copy.view : { ...copy.view, ...ending, phase: null, updatedAt: new Date().toISOString() };
        await record(final);
        copy.view = final;
        if (ending !== null) {
          const kept = [final, ...(await this.ended(projectId)).filter(other => other.operationId !== final.operationId)].slice(0, KEPT_COPIES);
          await atomicJson(join(this.origins, `${projectId}.copies.json`), kept).catch((error: unknown) => console.error('[gitspace-project-copy] ended copies not written', error));
          if (final.state === 'failed') console.warn(`[gitspace-project-copy] copy ${final.operationId} of ${projectId} failed: ${final.error}`);
        }
        if (final.state === 'failed') {
          // A git that outlived the stop (killed, or a push the watchdog cannot kill) gets a moment to exit first.
          controller.abort();
          await Promise.race([copying.catch(() => undefined), Bun.sleep(GIT_EXIT_MS)]);
          await clearInterruptedGit(cachePath);
        }
        this.running.delete(projectId);
      }
    })();
    return copy;
  }

  private async copy(projectId: string, cachePath: string, verify: boolean, report: (change: Partial<ProjectCopyOperation>) => void, signal: AbortSignal): Promise<Exclude<ProjectCopyOutcome, { state: 'empty' }>> {
    const project = await this.options.project(projectId);
    if (!project) throw new Error(`Project ${projectId} is not in this account`);
    if (project.repositoryReference === null) throw new Error('This project has no origin repository to copy');
    const repositoryUrl = normalizeRemoteRepositoryUrl(project.repositoryReference.trim());
    const outcome = await seedProjectRepository({
      projectId, repositoryUrl, baseBranch: project.baseBranch === 'HEAD' ? null : project.baseBranch, cachePath,
      checkouts: this.options.checkouts(projectId), verify, gitEnvironment: this.options.gitEnvironment(repositoryUrl),
      projectRepository: this.options.projectRepository, report, signal,
    });
    if (outcome.state === 'empty') throw new Error(`${project.repositoryReference} has no commits for GitSpace to copy yet: push a first commit to it, then copy again`);
    return outcome;
  }
}

/** The named `branches` of a project's origin that the origin holds and the commit each names, read with this machine's
 * git identity: Check origin for a repository the cloud cannot read. */
export async function readProjectOriginBranches(options: Pick<ProjectCopyOptions, 'project' | 'gitEnvironment'>, projectId: string, branches: readonly string[]): Promise<Array<{ branch: string; commit: string }>> {
  const project = await options.project(projectId);
  if (!project) throw new Error(`Project ${projectId} is not in this account`);
  if (project.repositoryReference === null) throw new Error('This project has no origin repository to read');
  const repositoryUrl = normalizeRemoteRepositoryUrl(project.repositoryReference.trim());
  const advertised = await runGit(['ls-remote', '--heads', '--', repositoryUrl], { environment: options.gitEnvironment(repositoryUrl) });
  const named = new Set(branches.map(branch => `refs/heads/${branch}`));
  return advertised.split('\n').flatMap(line => {
    const [commit, name] = line.split('\t');
    return commit && name !== undefined && named.has(name) ? [{ branch: name.slice('refs/heads/'.length), commit }] : [];
  });
}
