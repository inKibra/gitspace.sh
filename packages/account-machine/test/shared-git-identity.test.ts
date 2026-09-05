import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import type { GitIdentityDocument, UserSettings } from '@gitspace/protocol';
import { SharedGitIdentityCoordinator, type GitIdentityCloud } from '../src/shared-git-identity.js';

const roots: string[] = [];
async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(stderr);
  return stdout.trim();
}
class FakeGitCloud implements GitIdentityCloud {
  identity: GitIdentityDocument | null = null;
  async getGitIdentity(): Promise<GitIdentityDocument | null> { return this.identity; }
  async updateGitIdentity(input: { expectedGeneration: number; privateKey: string; publicKey: string; fingerprint: string }): Promise<GitIdentityDocument> {
    if (this.identity || input.expectedGeneration !== 0) throw new Error('conflict');
    this.identity = { generation: 1, privateKey: input.privateKey, publicKey: input.publicKey, fingerprint: input.fingerprint, updatedAt: new Date().toISOString(), updatedBy: 'machine-a' };
    return this.identity;
  }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('shared Git identity', () => {
  it('generates once, materializes securely, and applies shared author settings to repositories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-git-identity-'));
    roots.push(root);
    const repository = join(root, 'repo');
    mkdirSync(repository, { recursive: true });
    await git(repository, 'init', '-q');
    const cloud = new FakeGitCloud();
    const coordinator = new SharedGitIdentityCoordinator(cloud, root, () => [repository]);
    await coordinator.start();
    expect(cloud.identity?.publicKey).toStartWith('ssh-ed25519 ');
    expect(statSync(join(root, 'git-identity', 'id_ed25519')).mode & 0o777).toBe(0o600);
    const settings: UserSettings = {
      version: 1,
      revision: 1,
      onboardingComplete: true,
      profile: { displayName: 'Brad', handle: 'brad' },
      git: { authorName: 'Brad', authorEmail: 'brad@example.com' },
      defaults: { machineId: null, enterAction: 'queue', appearance: 'system' },
      updatedAt: new Date().toISOString(),
      updatedBy: 'machine-a',
    };
    await coordinator.apply(settings);
    await git(repository, 'commit', '--allow-empty', '-m', 'Verify shared author');
    expect(await git(repository, 'log', '-1', '--format=%an <%ae>')).toBe('Brad <brad@example.com>');

    const secondRoot = mkdtempSync(join(tmpdir(), 'gitspace-git-identity-second-'));
    roots.push(secondRoot);
    const second = new SharedGitIdentityCoordinator(cloud, secondRoot, () => []);
    await second.start();
    expect(readFileSync(join(secondRoot, 'git-identity', 'id_ed25519.pub'), 'utf8').trim()).toBe(cloud.identity?.publicKey);
  });

  it('applies concurrently without colliding on the repository config lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-git-identity-race-'));
    roots.push(root);
    const repository = join(root, 'repo');
    mkdirSync(repository, { recursive: true });
    await git(repository, 'init', '-q');
    const coordinator = new SharedGitIdentityCoordinator(new FakeGitCloud(), root, () => [repository]);
    await coordinator.start();
    const settings = (authorName: string): UserSettings => ({
      version: 1,
      revision: 1,
      onboardingComplete: true,
      profile: { displayName: 'Brad', handle: 'brad' },
      git: { authorName, authorEmail: 'brad@example.com' },
      defaults: { machineId: null, enterAction: 'queue', appearance: 'system' },
      updatedAt: new Date().toISOString(),
      updatedBy: 'machine-a',
    });
    // Startup, a settings save, and a cloud settings event used to race here
    // and fail with "could not lock config file .git/config: File exists".
    await Promise.all(Array.from({ length: 6 }, (_, index) => coordinator.apply(settings(`Brad ${index}`))));
    await git(repository, 'commit', '--allow-empty', '-m', 'Verify latest author');
    expect(await git(repository, 'log', '-1', '--format=%an')).toBe('Brad 5');
  });
  it('clones a pasted GitHub HTTPS address using the shared SSH key before any repository exists', async () => {
    const root = mkdtempSync(join(tmpdir(), "gitspace ssh '$identity-"));
    roots.push(root);
    const source = join(root, 'source');
    const bin = join(root, 'bin');
    mkdirSync(source);
    mkdirSync(bin);
    await git(source, 'init', '-q', '-b', 'trunk');
    writeFileSync(join(source, 'proof.txt'), 'authenticated clone\n');
    await git(source, 'add', 'proof.txt');
    await git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'Source');
    const cloud = new FakeGitCloud();
    const coordinator = new SharedGitIdentityCoordinator(cloud, root, () => []);
    await coordinator.start();
    const ssh = join(bin, 'ssh');
    writeFileSync(ssh, `#!${process.execPath}
const args = process.argv.slice(2);
const index = args.indexOf('-i');
if (index < 0 || !args.includes('git@github.com')) process.exit(41);
const key = Bun.spawnSync(['ssh-keygen', '-y', '-f', args[index + 1]]);
if (key.exitCode !== 0 || key.stdout.toString().trim().split(' ').slice(0, 2).join(' ') !== process.env.AUTHORIZED_KEY) process.exit(42);
const child = Bun.spawn(['git-upload-pack', process.env.SOURCE_REPOSITORY], { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
process.exit(await child.exited);
`);
    chmodSync(ssh, 0o755);
    const destination = join(root, 'imported');
    const child = Bun.spawn(['git', 'clone', '--', 'https://github.com/owner/private.git', destination], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_ALLOW_PROTOCOL: 'ssh',
        GIT_SSH_VARIANT: 'ssh',
        AUTHORIZED_KEY: cloud.identity!.publicKey.split(' ').slice(0, 2).join(' '),
        SOURCE_REPOSITORY: source,
        ...coordinator.gitEnvironment('https://github.com/owner/private.git'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
    expect({ code, stderr: code === 0 ? '' : stderr }).toEqual({ code: 0, stderr: '' });
    expect(readFileSync(join(destination, 'proof.txt'), 'utf8')).toBe('authenticated clone\n');
    expect(await git(destination, 'branch', '--show-current')).toBe('trunk');
  });
});

