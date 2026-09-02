import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRepositoryPrefix } from '@gitspace/protocol/space-checkpoint';

export interface WalgitTemporaryCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  expiresAt: Date;
}

export interface WalgitProjectBinding {
  projectId: string;
  bucket: string;
  endpoint: string;
  region: string;
}

export interface WalgitSupervisorOptions {
  binaryPath: string;
  runtimeRoot: string;
  credentials(binding: WalgitProjectBinding): Promise<WalgitTemporaryCredentials>;
  port(binding: WalgitProjectBinding): number;
  readyTimeoutMs?: number;
}

interface LiveWalgit {
  binding: WalgitProjectBinding;
  process: ReturnType<typeof Bun.spawn>;
  credentialsExpireAt: number;
  url: string;
}

export class WalgitProcessError extends Error {
  constructor(readonly operation: string, message: string) {
    super(`${operation}: ${message}`);
    this.name = 'WalgitProcessError';
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

async function git(repositoryPath: string, args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd: repositoryPath, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new WalgitProcessError(`git ${args[0] ?? ''}`.trim(), stderr.trim() || `exited with ${exitCode}`);
  return stdout.trim();
}

function projectRemote(url: string, projectId: string): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(projectId)) throw new WalgitProcessError('remote', `invalid project id ${projectId}`);
  return `${url}/gitspace/${projectId}.git`;
}

export class WalgitSupervisor {
  private readonly live = new Map<string, LiveWalgit>();

  constructor(private readonly options: WalgitSupervisorOptions) {}

  async ensureRunning(binding: WalgitProjectBinding): Promise<string> {
    const current = this.live.get(binding.projectId);
    if (current && current.process.exitCode === null && current.credentialsExpireAt > Date.now() + 60_000) return current.url;
    if (current) await this.stopProject(binding.projectId);
    const credentials = await this.options.credentials(binding);
    if (credentials.expiresAt.getTime() <= Date.now() + 60_000) {
      throw new WalgitProcessError('credentials', 'temporary credentials expire too soon');
    }
    const projectRoot = join(this.options.runtimeRoot, 'walgit', binding.projectId);
    const cacheRoot = join(projectRoot, 'cache');
    const configPath = join(projectRoot, 'walgit.toml');
    await mkdir(cacheRoot, { recursive: true });
    const port = this.options.port(binding);
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65_535) throw new WalgitProcessError('port', `invalid port ${port}`);
    const config = `[server]\nlisten = "127.0.0.1:${port}"\nroles = ["serve"]\nauto_create_on_push = true\n\n[server.auth]\nmode = "none"\nanonymous_read = true\n\n[store]\nbackend = "s3"\nbucket = ${tomlString(binding.bucket)}\nprefix = ${tomlString(projectRepositoryPrefix(binding.projectId))}\n\n[store.s3]\nendpoint = ${tomlString(binding.endpoint)}\nregion = ${tomlString(binding.region)}\naccess_key_env = "AWS_ACCESS_KEY_ID"\nsecret_key_env = "AWS_SECRET_ACCESS_KEY"\nforce_path_style = ${binding.endpoint.includes('r2.cloudflarestorage.com') ? 'false' : 'true'}\n\n[cache]\ndir = ${tomlString(cacheRoot)}\nmode = "disk"\n`;
    await writeFile(configPath, config, { mode: 0o600 });
    const url = `http://127.0.0.1:${port}`;
    const process = Bun.spawn([this.options.binaryPath, 'serve', '--config', configPath], {
      cwd: projectRoot,
      env: {
        ...Bun.env,
        AWS_ACCESS_KEY_ID: credentials.accessKeyId,
        AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
        ...(credentials.sessionToken ? { AWS_SESSION_TOKEN: credentials.sessionToken } : {}),
      },
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
    const live = { binding, process, credentialsExpireAt: credentials.expiresAt.getTime(), url };
    this.live.set(binding.projectId, live);
    try {
      await this.waitUntilReady(live);
      return url;
    } catch (error) {
      await this.stopProject(binding.projectId);
      throw error;
    }
  }

  async publishCheckpoint(input: {
    binding: WalgitProjectBinding;
    repositoryPath: string;
    checkpointRef: string;
  }): Promise<void> {
    const url = await this.ensureRunning(input.binding);
    await git(input.repositoryPath, ['push', projectRemote(url, input.binding.projectId), `${input.checkpointRef}:${input.checkpointRef}`]);
  }

  async fetchCheckpoint(input: {
    binding: WalgitProjectBinding;
    repositoryPath: string;
    checkpointRef: string;
  }): Promise<void> {
    const url = await this.ensureRunning(input.binding);
    await git(input.repositoryPath, ['fetch', projectRemote(url, input.binding.projectId), `${input.checkpointRef}:${input.checkpointRef}`]);
  }

  async stopProject(projectId: string): Promise<void> {
    const current = this.live.get(projectId);
    if (!current) return;
    this.live.delete(projectId);
    current.process.kill('SIGTERM');
    const exited = await Promise.race([
      current.process.exited.then(() => true),
      Bun.sleep(10_000).then(() => false),
    ]);
    if (!exited) {
      current.process.kill('SIGKILL');
      await current.process.exited;
    }
  }

  async removeProjectCache(projectId: string): Promise<void> {
    await this.stopProject(projectId);
    await rm(join(this.options.runtimeRoot, 'walgit', projectId), { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    for (const projectId of [...this.live.keys()]) await this.stopProject(projectId);
  }

  private async waitUntilReady(live: LiveWalgit): Promise<void> {
    const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (live.process.exitCode !== null) throw new WalgitProcessError('start', `walgit exited with ${live.process.exitCode}`);
      try {
        const response = await fetch(`${live.url}/readyz`);
        if (response.ok) return;
      } catch {
        // Process has not bound its loopback listener yet.
      }
      await Bun.sleep(25);
    }
    throw new WalgitProcessError('start', 'walgit readiness timed out');
  }
}
