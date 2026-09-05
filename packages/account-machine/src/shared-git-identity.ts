import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitIdentityDocument, UserSettings } from '@gitspace/protocol';
import { CloudSpaceAuthorityError } from './cloud-space-authority.js';

export interface GitIdentityCloud {
  getGitIdentity(): Promise<GitIdentityDocument | null>;
  updateGitIdentity(input: { expectedGeneration: number; privateKey: string; publicKey: string; fingerprint: string }): Promise<GitIdentityDocument>;
}

async function generateIdentity(): Promise<{ privateKey: string; publicKey: string; fingerprint: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-ssh-'));
  const path = join(directory, 'id_ed25519');
  try {
    const child = Bun.spawn(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'gitspace', '-f', path], { stdout: 'ignore', stderr: 'pipe' });
    if (await child.exited !== 0) throw new Error((await new Response(child.stderr).text()).trim() || 'ssh-keygen failed');
    const privateKey = await readFile(path, 'utf8');
    const publicKey = (await readFile(`${path}.pub`, 'utf8')).trim();
    const encoded = publicKey.split(/\s+/u)[1];
    if (!encoded) throw new Error('ssh-keygen returned an invalid public key');
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(encoded, 'base64')).digest('base64').replace(/=+$/u, '')}`;
    return { privateKey, publicKey, fingerprint };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function validIdentity(identity: GitIdentityDocument): Promise<boolean> {
  const directory = await mkdtemp(join(tmpdir(), 'gitspace-ssh-check-'));
  const path = join(directory, 'id_ed25519');
  try {
    await writeFile(path, identity.privateKey, { mode: 0o600 });
    const child = Bun.spawn(['ssh-keygen', '-y', '-f', path], { stdout: 'pipe', stderr: 'ignore' });
    const [code, derived] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    return code === 0 && derived.trim().split(/\s+/u)[1] === identity.publicKey.split(/\s+/u)[1];
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
async function git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(['git', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

/** Writes one config key, skipping when the value already matches. Retries the
 *  `.git/config.lock` collision git raises when another writer (a workspace
 *  agent, the machine's own concurrent apply, a stale lock) is mid-write. */
async function setConfig(repository: string, key: string, value: string): Promise<void> {
  const current = await git(['-C', repository, 'config', '--get', key]);
  if (current.code === 0 && current.stdout === value) return;
  for (let attempt = 0; ; attempt += 1) {
    const result = await git(['-C', repository, 'config', key, value]);
    if (result.code === 0) return;
    const locked = /could not lock config file/u.test(result.stderr);
    if (!locked || attempt >= 5) throw new Error(result.stderr || `git config ${key} failed in ${repository}`);
    await Bun.sleep(50 * 2 ** attempt);
  }
}

export class SharedGitIdentityCoordinator {
  private identity: GitIdentityDocument | null = null;
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;
  private readonly knownHostsPath: string;

  constructor(
    private readonly cloud: GitIdentityCloud,
    private readonly root: string,
    private readonly repositories: () => string[],
  ) {
    const directory = join(root, 'git-identity');
    this.privateKeyPath = join(directory, 'id_ed25519');
    this.publicKeyPath = `${this.privateKeyPath}.pub`;
    this.knownHostsPath = join(directory, 'known_hosts');
  }

  async start(): Promise<void> {
    let identity = await this.cloud.getGitIdentity();
    if (!identity || !(await validIdentity(identity))) {
      const generated = await generateIdentity();
      try {
        identity = await this.cloud.updateGitIdentity({ expectedGeneration: identity?.generation ?? 0, ...generated });
      } catch (error) {
        if (!(error instanceof CloudSpaceAuthorityError) || error.code !== 'SETTINGS_CONFLICT') throw error;
        identity = await this.cloud.getGitIdentity();
        if (!identity || !(await validIdentity(identity))) throw new Error('Shared Git identity raced but no valid canonical identity exists');
      }
    }
    this.identity = identity;
    await this.materialize(identity);
  }

  view(): Pick<GitIdentityDocument, 'generation' | 'publicKey' | 'fingerprint' | 'updatedAt' | 'updatedBy'> | null {
    if (!this.identity) return null;
    const { generation, publicKey, fingerprint, updatedAt, updatedBy } = this.identity;
    return { generation, publicKey, fingerprint, updatedAt, updatedBy };
  }

  /** First clone has no repository config yet; use the same account identity
   *  that apply() installs for subsequent Git operations. */
  gitEnvironment(repositoryUrl: string): Record<string, string> {
    if (!this.identity) throw new Error('Shared Git identity is not initialized');
    const environment: Record<string, string> = { GIT_SSH_COMMAND: this.sshCommand(), GIT_TERMINAL_PROMPT: '0' };
    if (repositoryUrl.startsWith('https://github.com/')) {
      const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
      environment.GIT_CONFIG_COUNT = String(count + 1);
      environment[`GIT_CONFIG_KEY_${count}`] = 'url.git@github.com:.insteadOf';
      environment[`GIT_CONFIG_VALUE_${count}`] = 'https://github.com/';
    }
    return environment;
  }

  private sshCommand(): string {
    const identity = `'${this.privateKeyPath.replaceAll("'", "'\\''")}'`;
    const knownHosts = `'${`${JSON.stringify(this.knownHostsPath)} ~/.ssh/known_hosts`.replaceAll("'", "'\\''")}'`;
    return `ssh -i ${identity} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`;
  }

  private applying: Promise<void> = Promise.resolve();

  /** Applies the identity to every project repository. Calls are serialized:
   *  startup, a settings save, and a cloud settings event can all arrive
   *  together, and two `git config` writers on one repo collide on its lock. */
  apply(settings: UserSettings, repositories?: readonly string[]): Promise<void> {
    const run = this.applying.then(() => this.applyNow(settings, repositories ?? this.repositories()));
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async applyNow(settings: UserSettings, repositories: readonly string[]): Promise<void> {
    if (!this.identity) throw new Error('Shared Git identity is not initialized');
    const sshCommand = this.sshCommand();
    for (const repository of repositories) {
      await setConfig(repository, 'core.sshCommand', sshCommand);
      await setConfig(repository, 'url.git@github.com:.insteadOf', 'https://github.com/');
      if (settings.git.authorName) await setConfig(repository, 'user.name', settings.git.authorName);
      if (settings.git.authorEmail) await setConfig(repository, 'user.email', settings.git.authorEmail);
    }
  }

  private async materialize(identity: GitIdentityDocument): Promise<void> {
    await mkdir(join(this.root, 'git-identity'), { recursive: true, mode: 0o700 });
    const privateTemp = `${this.privateKeyPath}.${process.pid}.tmp`;
    const publicTemp = `${this.publicKeyPath}.${process.pid}.tmp`;
    await writeFile(privateTemp, identity.privateKey, { mode: 0o600 });
    await writeFile(publicTemp, `${identity.publicKey}\n`, { mode: 0o644 });
    // GitHub's published Ed25519 host key: https://api.github.com/meta.
    // Pin it rather than disabling host verification on fresh cloud machines.
    await writeFile(this.knownHostsPath, 'github.com,[ssh.github.com]:443 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl\n', { mode: 0o644 });
    await rename(privateTemp, this.privateKeyPath);
    await rename(publicTemp, this.publicKeyPath);
  }
}
