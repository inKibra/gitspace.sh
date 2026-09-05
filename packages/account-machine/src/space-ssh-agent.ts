import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export interface SpaceGitSshCredential {
  privateKey: string;
  fingerprint?: string;
}

export interface SpaceSshAgentManagerOptions {
  credential(spaceId: string): Promise<SpaceGitSshCredential>;
  knownHostsPath?: string;
  startupTimeoutMs?: number;
}

interface LiveAgent {
  process: ReturnType<typeof Bun.spawn>;
  socketPath: string;
  runtimeDir: string;
}

export class SpaceSshAgentManager {
  private readonly live = new Map<string, LiveAgent>();

  constructor(private readonly options: SpaceSshAgentManagerOptions) {}

  async start(spaceId: string, repositoryPath: string): Promise<{ socketPath: string }> {
    const current = this.live.get(spaceId);
    if (current?.process.exitCode === null) return { socketPath: current.socketPath };
    if (current) await this.stop(spaceId);
    if (!/^[A-Za-z0-9._-]{1,160}$/u.test(spaceId)) throw new Error('Space id is invalid');
    const digest = new Bun.CryptoHasher('sha256').update(spaceId).digest('hex').slice(0, 16);
    const runtimeDir = join(tmpdir(), 'gitspace-ssh', digest);
    const socketPath = join(runtimeDir, 'agent.sock');
    await rm(runtimeDir, { recursive: true, force: true });
    await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
    const process = Bun.spawn(['ssh-agent', '-D', '-a', socketPath], {
      stdin: 'ignore', stdout: 'ignore', stderr: 'pipe',
    });
    const live = { process, socketPath, runtimeDir };
    this.live.set(spaceId, live);
    try {
      await this.waitForSocket(live);
      const credential = await this.options.credential(spaceId);
      const added = Bun.spawn(['ssh-add', '-'], {
        env: { ...Bun.env, SSH_AUTH_SOCK: socketPath },
        stdin: new Blob([credential.privateKey]),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [exitCode, stderr] = await Promise.all([added.exited, new Response(added.stderr).text()]);
      if (exitCode !== 0) throw new Error(stderr.trim() || `ssh-add exited with ${exitCode}`);
      await this.configureRepository(repositoryPath, socketPath);
      return { socketPath };
    } catch (error) {
      await this.stop(spaceId);
      throw error;
    }
  }

  async stop(spaceId: string): Promise<void> {
    const current = this.live.get(spaceId);
    if (!current) return;
    this.live.delete(spaceId);
    if (current.process.exitCode === null) {
      current.process.kill('SIGTERM');
      await current.process.exited;
    }
    await rm(current.runtimeDir, { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    for (const spaceId of [...this.live.keys()]) await this.stop(spaceId);
  }

  private async configureRepository(repositoryPath: string, socketPath: string): Promise<void> {
    await git(repositoryPath, ['config', 'extensions.worktreeConfig', 'true']);
    const knownHosts = this.options.knownHostsPath ? ` -o UserKnownHostsFile=${shellWord(this.options.knownHostsPath)}` : '';
    const command = `ssh -o IdentityAgent=${shellWord(socketPath)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes${knownHosts}`;
    await git(repositoryPath, ['config', '--worktree', 'core.sshCommand', command]);
  }

  private async waitForSocket(agent: LiveAgent): Promise<void> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 5_000);
    while (Date.now() < deadline) {
      if (agent.process.exitCode !== null) throw new Error(`ssh-agent exited with ${agent.process.exitCode}`);
      try {
        const value = await stat(agent.socketPath);
        if (value.isSocket()) return;
      } catch {}
      await Bun.sleep(20);
    }
    throw new Error('ssh-agent did not create its socket');
  }
}

async function git(cwd: string, args: string[]): Promise<void> {
  const process = Bun.spawn(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args[0] ?? ''} exited with ${exitCode}`);
}

function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
