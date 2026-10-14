import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { normalizeRemoteRepositoryUrl } from '@gitspace/protocol';
import { readGitCheckpointHead } from './git-checkpoint.js';
import { ArtifactsBranchDivergedError, type ArtifactsGitRemote } from './artifacts-git-remote.js';

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

export interface SeedProjectRepositoryInput {
  projectId: string;
  repositoryUrl: string;
  /** Null selects the remote's default branch. */
  baseBranch: string | null;
  /** Parent for the temporary clone; it is removed afterwards. */
  scratchRoot: string;
  /** SSH environment for the account's shared git identity. */
  gitEnvironment: Record<string, string>;
  projectRepository: Pick<ArtifactsGitRemote, 'publishBranch'>;
}

/**
 * Clones a project repository over SSH with this machine's git identity and publishes its base
 * branch tip to `project-<projectId>`, so the cloud can fork workspaces from origins it cannot reach.
 * An empty remote has nothing to seed. Equal history is a no-op; an existing different branch is
 * kept with a warning.
 */
export async function seedProjectRepository(input: SeedProjectRepositoryInput): Promise<{ baseBranch: string; commit: string | null }> {
  const repositoryUrl = normalizeRemoteRepositoryUrl(input.repositoryUrl.trim());
  if (await runGit(['ls-remote', '--', repositoryUrl], undefined, input.gitEnvironment) === '') {
    return { baseBranch: input.baseBranch ?? 'main', commit: null };
  }
  const directory = await mkdtemp(join(input.scratchRoot, 'seed-'));
  try {
    const repositoryPath = join(directory, 'repository');
    await runGit(['clone', '--single-branch', ...(input.baseBranch === null ? [] : ['--branch', input.baseBranch]), '--', repositoryUrl, repositoryPath], undefined, input.gitEnvironment);
    const baseBranch = input.baseBranch ?? await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath, {});
    const { headCommit } = await readGitCheckpointHead(repositoryPath);
    if (headCommit === null) return { baseBranch, commit: null };
    try {
      await input.projectRepository.publishBranch({ binding: { projectId: input.projectId, repository: `project-${input.projectId}` }, repositoryPath, branch: baseBranch, commit: headCommit });
    } catch (error) {
      if (!(error instanceof ArtifactsBranchDivergedError)) throw error;
      console.warn('[gitspace-project] project repository already holds other base history; keeping it', input.projectId, error.message);
    }
    return { baseBranch, commit: headCommit };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
