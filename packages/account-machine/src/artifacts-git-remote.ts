export type ArtifactsRepositoryBinding = { projectId: string; repository: string };
export type ArtifactsRepositoryCredentials = { remote: string; plaintext: string; expiresAt: string };
export type ArtifactsGitRemoteOptions = {
  credentials(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write'): Promise<ArtifactsRepositoryCredentials>;
  /** Origin-backed Git LFS retains its own project credential authority. */
  lfsEnvironment(repositoryPath: string): Promise<Record<string, string>>;
};

export class ArtifactsGitError extends Error {
  constructor(readonly operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'ArtifactsGitError';
  }
}

async function git(repositoryPath: string, args: string[], environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, env: { ...Bun.env, ...environment }, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new ArtifactsGitError(args[0] ?? 'git', stderr.trim() || `exited with ${exitCode}`);
  return stdout.trim();
}

/** No daemon, S3 authority, persisted credential URL, or credential cache. */
export class ArtifactsGitRemote {
  constructor(private readonly options: ArtifactsGitRemoteOptions) {}

  async publishCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string }): Promise<void> {
    this.checkRef(input.checkpointRef);
    // Upload every LFS object reachable through the checkpoint's HEAD/index/worktree chain.
    // git-lfs is mandatory for repositories with LFS pointers; origin auth stays separate.
    const lfs = await git(input.repositoryPath, ['lfs', 'ls-files', '--all']);
    if (lfs) {
      await git(input.repositoryPath, ['lfs', 'fsck', '--objects', input.checkpointRef]);
      await git(input.repositoryPath, ['lfs', 'push', '--all', 'origin', input.checkpointRef], await this.options.lfsEnvironment(input.repositoryPath));
    }
    const auth = await this.auth(input.binding, 'write');
    await git(input.repositoryPath, ['push', auth.remote, `${input.checkpointRef}:${input.checkpointRef}`], auth.environment);
  }

  async fetchCheckpoint(input: { binding: ArtifactsRepositoryBinding; repositoryPath: string; checkpointRef: string; commit?: string }): Promise<void> {
    this.checkRef(input.checkpointRef);
    if (input.commit !== undefined && !/^[0-9a-f]{40}$/u.test(input.commit)) throw new ArtifactsGitError('checkpoint', 'Invalid immutable checkpoint commit');
    const auth = await this.auth(input.binding, 'read');
    await git(input.repositoryPath, ['fetch', '--no-write-fetch-head', auth.remote, `${input.commit ?? input.checkpointRef}:${input.checkpointRef}`], { ...auth.environment, GIT_LFS_SKIP_SMUDGE: '1' });
    const lfs = await git(input.repositoryPath, ['lfs', 'ls-files', '--all']);
    if (lfs) {
      await git(input.repositoryPath, ['lfs', 'fetch', '--all', 'origin', input.checkpointRef], await this.options.lfsEnvironment(input.repositoryPath));
      await git(input.repositoryPath, ['lfs', 'fsck', '--objects', input.checkpointRef]);
    }
  }

  private checkRef(ref: string): void {
    if (!ref.startsWith('refs/gitspace/') || ref.includes('..') || !/^[A-Za-z0-9._/-]+$/u.test(ref)) throw new ArtifactsGitError('checkpoint', 'Invalid private checkpoint ref');
  }

  private async auth(binding: ArtifactsRepositoryBinding, scope: 'read' | 'write') {
    const credential = await this.options.credentials(binding, scope);
    const remote = new URL(credential.remote);
    if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new ArtifactsGitError('credentials', 'Invalid credential-free repository URL');
    if (Date.parse(credential.expiresAt) <= Date.now() + 60_000 || !Number.isFinite(Date.parse(credential.expiresAt))) throw new ArtifactsGitError('credentials', 'Repository token expires too soon');
    if (!credential.plaintext || /[\r\n]/u.test(credential.plaintext)) throw new ArtifactsGitError('credentials', 'Invalid repository token');
    return { remote: remote.href, environment: {
      GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: `http.${remote.href}.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${credential.plaintext}`,
      GIT_CONFIG_KEY_1: 'http.followRedirects', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'credential.helper', GIT_CONFIG_VALUE_2: '', GIT_TERMINAL_PROMPT: '0',
    } };
  }
}
