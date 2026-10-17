import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GitIdentityDocument, UserSettings } from '@gitspace/protocol';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import { CloudSpaceAuthorityError } from './cloud-space-authority.js';
import type { GitHubCheckoutAccess } from './github-credential-helper.js';

const SSH_REWRITE = 'url.git@github.com:.insteadOf';
/** A covered checkout's only credential helper for github.com, asked per repository path. An empty value first drops
 * the helpers configured before it: a keychain or `gh` helper would answer with someone's own token, or store this one. */
const GITHUB_HELPER = 'credential.https://github.com.helper';
const GITHUB_HTTP_PATH = 'credential.https://github.com.useHttpPath';

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

/** Runs one `git config` write, retrying the `.git/config.lock` collision git raises when another writer (a workspace
 *  agent, the machine's own concurrent apply, a stale lock) is mid-write. */
async function writeConfig(repository: string, args: string[]): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const result = await git(['-C', repository, 'config', ...args]);
    // 5: `--unset-all` found nothing to remove.
    if (result.code === 0 || (result.code === 5 && args[0] === '--unset-all')) return;
    const locked = /could not lock config file/u.test(result.stderr);
    if (!locked || attempt >= 5) throw new Error(result.stderr || `git config ${args.join(' ')} failed in ${repository}`);
    await Bun.sleep(50 * 2 ** attempt);
  }
}

/** Writes one config key, skipping when the value already matches. */
async function setConfig(repository: string, key: string, value: string): Promise<void> {
  const current = await git(['-C', repository, 'config', '--get', key]);
  if (current.code === 0 && current.stdout === value) return;
  await writeConfig(repository, [key, value]);
}

/** Writes every value of a multi-valued key in the checkout's own config in order, skipping when they already match. */
async function setConfigValues(repository: string, key: string, values: readonly string[]): Promise<void> {
  const current = await git(['-C', repository, 'config', '--local', '--null', '--get-all', key]);
  if (current.code === 0 && current.stdout.split('\0').slice(0, -1).join('\0') === values.join('\0')) return;
  await unsetConfig(repository, key);
  for (const value of values) await writeConfig(repository, ['--add', key, value]);
}

async function unsetConfig(repository: string, key: string): Promise<void> {
  if ((await git(['-C', repository, 'config', '--local', '--get-all', key])).code !== 0) return;
  await writeConfig(repository, ['--unset-all', key]);
}

/** `GIT_CONFIG_*` entries after those the process already carries; callers spread `process.env` first and keep them. */
function configEnvironment(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  const environment: Record<string, string> = { GIT_CONFIG_COUNT: String(count + entries.length) };
  for (const [index, [key, value]] of entries.entries()) {
    environment[`GIT_CONFIG_KEY_${count + index}`] = key;
    environment[`GIT_CONFIG_VALUE_${count + index}`] = value;
  }
  return environment;
}

export class SharedGitIdentityCoordinator {
  private identity: GitIdentityDocument | null = null;
  private readonly privateKeyPath: string;
  private readonly publicKeyPath: string;
  private readonly knownHostsPath: string;

  constructor(
    private readonly cloud: GitIdentityCloud,
    private readonly root: string,
    private readonly checkouts: () => readonly LocalAttachment[],
    private readonly github: GitHubCheckoutAccess,
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
    return repositoryUrl.startsWith('https://github.com/') ? { ...environment, ...configEnvironment([[SSH_REWRITE, 'https://github.com/']]) } : environment;
  }

  /** What a transient fetch through the checkout's `origin` (ref imports, LFS) runs with. A covered origin: HTTPS with
   *  only the checkout's installation-token helper, scp-style and ssh:// GitHub addresses rewritten to HTTPS, no SSH
   *  command, so LFS authenticates with git credentials rather than `git-lfs-authenticate`. Any other origin: the
   *  account SSH key. Never one, then the other. */
  async originEnvironment(checkout: LocalAttachment): Promise<Record<string, string>> {
    const access = await this.github.access(checkout.attachment);
    if (access.kind === 'ssh') {
      const origin = await git(['-C', checkout.rootPath, 'remote', 'get-url', 'origin']);
      if (origin.code !== 0) throw new Error(`The checkout's origin is unavailable: ${origin.stderr}`);
      return this.gitEnvironment(origin.stdout);
    }
    return {
      GIT_TERMINAL_PROMPT: '0',
      ...configEnvironment([
        [GITHUB_HELPER, ''], [GITHUB_HELPER, this.github.helper(checkout.attachment)], [GITHUB_HTTP_PATH, 'true'],
        ['url.https://github.com/.insteadOf', 'git@github.com:'], ['url.https://github.com/.insteadOf', 'ssh://git@github.com/'],
      ]),
    };
  }

  private sshCommand(): string {
    const identity = `'${this.privateKeyPath.replaceAll("'", "'\\''")}'`;
    const knownHosts = `'${`${JSON.stringify(this.knownHostsPath)} ~/.ssh/known_hosts`.replaceAll("'", "'\\''")}'`;
    return `ssh -i ${identity} -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${knownHosts}`;
  }

  private applying: Promise<void> = Promise.resolve();

  /** Applies the identity and each checkout's origin route to every checkout. Calls are serialized:
   *  startup, a settings save, and a cloud settings event can all arrive
   *  together, and two `git config` writers on one repo collide on its lock. */
  apply(settings: UserSettings, checkouts?: readonly LocalAttachment[]): Promise<void> {
    const run = this.applying.then(() => this.applyNow(settings, checkouts ?? this.checkouts()));
    this.applying = run.catch(() => undefined);
    return run;
  }

  private async applyNow(settings: UserSettings, checkouts: readonly LocalAttachment[]): Promise<void> {
    if (!this.identity) throw new Error('Shared Git identity is not initialized');
    const sshCommand = this.sshCommand();
    for (const checkout of checkouts) {
      const repository = checkout.rootPath;
      const access = await this.github.access(checkout.attachment);
      if (access.kind === 'github-app') {
        // Agents' plain fetch, push and LFS reach a covered origin over HTTPS with installation tokens only.
        await unsetConfig(repository, 'core.sshCommand');
        await unsetConfig(repository, SSH_REWRITE);
        const origin = await git(['-C', repository, 'config', '--local', '--get', 'remote.origin.url']);
        const url = `https://github.com/${access.repository}.git`;
        if (origin.code === 0 && origin.stdout !== url) await writeConfig(repository, ['remote.origin.url', url]);
        await setConfigValues(repository, GITHUB_HELPER, ['', this.github.helper(checkout.attachment)]);
        await setConfig(repository, GITHUB_HTTP_PATH, 'true');
      } else {
        await unsetConfig(repository, GITHUB_HELPER);
        await unsetConfig(repository, GITHUB_HTTP_PATH);
        await setConfig(repository, 'core.sshCommand', sshCommand);
        await setConfig(repository, SSH_REWRITE, 'https://github.com/');
      }
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
