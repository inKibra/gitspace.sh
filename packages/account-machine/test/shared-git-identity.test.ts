import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
    expect(await git(repository, 'config', 'user.name')).toBe('Brad');
    expect(await git(repository, 'config', 'user.email')).toBe('brad@example.com');
    expect(await git(repository, 'config', 'core.sshCommand')).toContain('git-identity/id_ed25519');

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
    expect(await git(repository, 'config', 'user.name')).toBe('Brad 5');
  });
});
