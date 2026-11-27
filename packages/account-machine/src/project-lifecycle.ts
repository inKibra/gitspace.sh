import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeRemoteRepositoryUrl } from '@gitspace/protocol';
import { readGitCheckpointHead } from './git-checkpoint.js';
import { ArtifactsRefDivergedError, type ArtifactsGitRemote } from './artifacts-git-remote.js';

/** The origin refused a commit asked for by id: none of its refs reaches it. */
class OriginCommitMissingError extends Error {}

async function runGit(args: string[], cwd: string | undefined, environment: Record<string, string>): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      ...environment,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: `${environment.GIT_SSH_COMMAND ?? process.env.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes`,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    if (/not our ref|unadvertised object/iu.test(stderr)) throw new OriginCommitMissingError(`git ${args[0]} failed (exit ${exitCode}): the origin holds no such commit`);
    // Credential helpers and servers can echo secrets supplied through the environment.
    const detail = /Permission denied \(publickey\)/iu.test(stderr)
      ? 'SSH authentication failed. Add the public key from Settings → Git to a GitHub account that can access this repository.'
      : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderr)
        ? 'SSH host verification failed. Check the repository host and its trusted host key; host verification has not been disabled.'
        : /Repository not found|repository .* does not exist/iu.test(stderr)
          ? 'Repository not found or your account lacks access. Check the repository root address and SSH key permissions.'
          : /Remote branch .* not found/iu.test(stderr)
            ? 'The requested base branch was not found. Leave Base branch empty to detect the repository default.'
            : 'Check the repository address, branch, and shared SSH key access.';
    throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${detail}`);
  }
  return stdout.trim();
}

/** A project's copy of its base branch after a copy through a machine: the commit it held before (`previous`, null
 * when it had none) and the origin's tip it holds now (`commit`, equal to `previous` when it was already current). */
export type ProjectCopy = { baseBranch: string; previous: string | null; commit: string };

export interface SeedProjectRepositoryInput {
  projectId: string;
  repositoryUrl: string;
  /** Null selects the remote's default branch. */
  baseBranch: string | null;
  /** Parent for the temporary repository; it is removed afterwards. */
  scratchRoot: string;
  /** SSH environment for the account's shared git identity. */
  gitEnvironment: Record<string, string>;
  projectRepository: Pick<ArtifactsGitRemote, 'readRef' | 'publishRef' | 'advanceRef'>;
}

/**
 * Brings `project-<projectId>`'s copy of a project's base branch to its origin's tip, read over SSH with this machine's
 * git identity, so the cloud can fork workspaces from origins it cannot reach. A copy without the branch gets the tip
 * alone; a copy at an ancestor of the tip is fast-forwarded, the origin and the push sending only the commits after
 * it; a copy at the tip is left as it is. A copy at any other commit is refused: GitSpace only fast-forwards it. An
 * origin with no branches has nothing to copy (`commit` null).
 */
export async function seedProjectRepository(input: SeedProjectRepositoryInput): Promise<ProjectCopy | { baseBranch: string; commit: null }> {
  const repositoryUrl = normalizeRemoteRepositoryUrl(input.repositoryUrl.trim());
  // `ref: refs/heads/<branch>\tHEAD` names the default branch; `<commit>\t<ref>` lines name the branches.
  const advertised = (await runGit(['ls-remote', '--symref', '--', repositoryUrl, 'HEAD', 'refs/heads/*'], undefined, input.gitEnvironment)).split('\n').map(line => line.split('\t'));
  const branches = new Map(advertised.flatMap(([commit, name]): Array<[string, string]> => commit && name?.startsWith('refs/heads/') && /^[0-9a-f]{40}$/u.test(commit) ? [[name, commit]] : []));
  if (branches.size === 0) return { baseBranch: input.baseBranch ?? 'main', commit: null };
  const baseBranch = input.baseBranch ?? advertised.find(([target, name]) => name === 'HEAD' && target?.startsWith('ref: refs/heads/'))?.[0]?.slice('ref: refs/heads/'.length);
  if (baseBranch === undefined) throw new Error(`${input.repositoryUrl} names no default branch: set the project's base branch`);
  const ref = `refs/heads/${baseBranch}`;
  const head = branches.get(ref);
  if (head === undefined) throw new Error('The requested base branch was not found. Leave Base branch empty to detect the repository default.');
  const binding = { projectId: input.projectId, repository: `project-${input.projectId}` };
  const directory = await mkdtemp(join(input.scratchRoot, 'seed-'));
  try {
    const repositoryPath = join(directory, 'repository');
    await runGit(['init', '--quiet', repositoryPath], undefined, {});
    const previous = await input.projectRepository.readRef({ binding, repositoryPath, ref });
    if (previous === head) return { baseBranch, previous, commit: head };
    if (previous === null) {
      // publishRef sends the tip alone (its commit is the push's shallow boundary), so only the tip is fetched.
      await runGit(['fetch', '--quiet', '--no-tags', '--depth', '1', '--', repositoryUrl, head], repositoryPath, input.gitEnvironment);
      await input.projectRepository.publishRef({ binding, repositoryPath, ref, commit: head });
      return { baseBranch, previous, commit: head };
    }
    const diverged = new Error(`The project's copy of ${baseBranch} is at ${previous.slice(0, 7)}, which origin's ${baseBranch} (${head.slice(0, 7)}) does not build on, so it was not moved: GitSpace only fast-forwards it.`);
    // The copy's commit alone, then the tip: a fetch from a repository holding the copy's commit brings only the
    // commits after it.
    try { await runGit(['fetch', '--quiet', '--no-tags', '--depth', '1', '--', repositoryUrl, previous], repositoryPath, input.gitEnvironment); }
    catch (error) { throw error instanceof OriginCommitMissingError ? diverged : error; }
    await runGit(['fetch', '--quiet', '--no-tags', '--', repositoryUrl, head], repositoryPath, input.gitEnvironment);
    try { await input.projectRepository.advanceRef({ binding, repositoryPath, ref, from: previous, commit: head }); }
    catch (error) { throw error instanceof ArtifactsRefDivergedError ? diverged : error; }
    return { baseBranch, previous, commit: head };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export interface ProjectCopyOptions {
  /** The project as the account holds it: its origin and base branch ('HEAD': the origin's default branch). */
  project(projectId: string): Promise<{ repositoryReference: string | null; baseBranch: string } | null>;
  scratchRoot: string;
  /** How Git reaches an origin address with the account's shared git identity. */
  gitEnvironment(repositoryUrl: string): Record<string, string>;
  projectRepository: Pick<ArtifactsGitRemote, 'readRef' | 'publishRef' | 'advanceRef'>;
}

/** Copies a project's base branch from its origin into `project-<projectId>` with this machine's git identity, or
 * fast-forwards the copy already there: the project page's "Copy through <machine>" for a repository the cloud could
 * not import itself, and Update base for one it cannot read. A repository with no commits has nothing to copy and is an
 * error naming it. */
export async function copyProjectThroughMachine(options: ProjectCopyOptions, projectId: string): Promise<ProjectCopy> {
  const project = await options.project(projectId);
  if (!project) throw new Error(`Project ${projectId} is not in this account`);
  if (project.repositoryReference === null) throw new Error('This project has no origin repository to copy');
  const repositoryUrl = normalizeRemoteRepositoryUrl(project.repositoryReference.trim());
  const seeded = await seedProjectRepository({
    projectId, repositoryUrl, baseBranch: project.baseBranch === 'HEAD' ? null : project.baseBranch,
    scratchRoot: options.scratchRoot, gitEnvironment: options.gitEnvironment(repositoryUrl), projectRepository: options.projectRepository,
  });
  if (seeded.commit === null) throw new Error(`${project.repositoryReference} has no commits for GitSpace to copy yet: push a first commit to it, then copy again`);
  return seeded;
}
