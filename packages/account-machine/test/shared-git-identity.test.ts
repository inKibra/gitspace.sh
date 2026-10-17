import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import type { z } from 'zod';
import type { ControlOperation, GitIdentityDocument, UserSettings } from '@gitspace/protocol';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import { SharedGitIdentityCoordinator, type GitIdentityCloud } from '../src/shared-git-identity.js';
import { createGitHubCredentialHelper, type GitHubCheckoutAccess } from '../src/github-credential-helper.js';

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
/** Origins no installation covers: the account SSH key. */
const sshOrigins: GitHubCheckoutAccess = {
  access: async () => ({ kind: 'ssh' }),
  helper: () => { throw new Error('An uncovered checkout has no GitHub credential helper'); },
};
function checkout(rootPath: string, state: 'attaching' | 'ready' = 'ready', generation = 3): LocalAttachment {
  return {
    attachment: RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', attachmentId: 'attachment', machineId: 'machine', generation, checkout: { kind: 'shared', branch: 'main' }, state, capabilities: [], updatedAt: new Date().toISOString() }),
    rootPath, executionSecret: 'secret', prerequisitesComplete: true,
  };
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('shared Git identity', () => {
  it('generates once, materializes securely, and applies shared author settings to repositories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-git-identity-'));
    roots.push(root);
    const repository = join(root, 'repo');
    mkdirSync(repository, { recursive: true });
    await git(repository, 'init', '-q');
    const cloud = new FakeGitCloud();
    const coordinator = new SharedGitIdentityCoordinator(cloud, root, () => [checkout(repository)], sshOrigins);
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
    const second = new SharedGitIdentityCoordinator(cloud, secondRoot, () => [], sshOrigins);
    await second.start();
    if (!cloud.identity) throw new Error('Expected the shared Git identity to be retained');
    expect(readFileSync(join(secondRoot, 'git-identity', 'id_ed25519.pub'), 'utf8').trim()).toBe(cloud.identity.publicKey);
  });

  it('applies concurrently without colliding on the repository config lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-git-identity-race-'));
    roots.push(root);
    const repository = join(root, 'repo');
    mkdirSync(repository, { recursive: true });
    await git(repository, 'init', '-q');
    const coordinator = new SharedGitIdentityCoordinator(new FakeGitCloud(), root, () => [checkout(repository)], sshOrigins);
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
    const coordinator = new SharedGitIdentityCoordinator(cloud, root, () => [], sshOrigins);
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

const TOKEN = 'ghs_installationTokenForOwnerRepo';
const settings: UserSettings = {
  version: 1, revision: 1, onboardingComplete: true, profile: { displayName: 'Brad', handle: 'brad' },
  git: { authorName: 'Brad', authorEmail: 'brad@example.com' },
  defaults: { machineId: null, enterAction: 'queue', appearance: 'system' }, updatedAt: new Date().toISOString(), updatedBy: 'machine-a',
};

/** A checkout of `git@github.com:Owner/Repo.git` on a machine whose global Git config, like a developer's, has a
 *  credential store and a `gh`-style github.com helper with a personal token. The account's decision is switchable. */
async function coveredFixture() {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-github-origin-'));
  roots.push(root);
  const store = join(root, 'personal-credentials');
  const global = join(root, 'global.gitconfig');
  writeFileSync(global, `[credential]\n\thelper = store --file=${store}\n[credential "https://github.com"]\n\thelper =\n\thelper = "!f() { echo username=someone; echo password=personal-token; }; f"\n`);
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const run = async (cwd: string, args: string[], extra: Record<string, string> = {}, input?: string) => {
    const child = Bun.spawn(['git', ...args], { cwd, env: { ...environment, ...extra }, stdin: input === undefined ? 'ignore' : new Blob([input]), stdout: 'pipe', stderr: 'pipe' });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    return { code, stdout, stderr };
  };
  const repository = join(root, 'checkout');
  mkdirSync(repository);
  await run(repository, ['init', '-q']);
  await run(repository, ['remote', 'add', 'origin', 'git@github.com:Owner/Repo.git']);
  const state = { covered: true, held: [checkout(repository)] };
  const requests: Array<{ operation: ControlOperation; payload: Record<string, unknown> }> = [];
  const cloud = {
    async call<S extends z.ZodType>(operation: ControlOperation, payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
      requests.push({ operation, payload });
      if (operation === 'runtime.repository.originAccess') return schema.parse(state.covered ? { kind: 'github-app', repository: 'Owner/Repo' } : { kind: 'ssh' });
      if (operation === 'runtime.repository.githubToken') return schema.parse({ token: TOKEN, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      throw new Error(`Unexpected control operation ${operation}`);
    },
  };
  const github = await createGitHubCredentialHelper(join(root, 'github-credentials'), cloud, () => state.held);
  cleanups.push(() => github.close());
  const coordinator = new SharedGitIdentityCoordinator(new FakeGitCloud(), root, () => state.held, github);
  await coordinator.start();
  return {
    root, store, repository, state, coordinator, run,
    local: async (key: string) => (await run(repository, ['config', '--local', '--get-all', key])).stdout.split('\n').slice(0, -1),
    fill: (cwd: string, extra: Record<string, string> = {}) => run(cwd, ['credential', 'fill'], extra, 'protocol=https\nhost=github.com\npath=Owner/Repo.git\n\n'),
    tokenRequests: () => requests.filter(request => request.operation === 'runtime.repository.githubToken').map(request => request.payload),
  };
}

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

describe('checkout origin routes', () => {
  it('reaches a covered origin only with installation tokens and an uncovered one only with the account SSH key', async () => {
    const f = await coveredFixture();
    f.state.covered = false;
    await f.coordinator.apply(settings);
    expect(await f.local('core.sshCommand')).toEqual([expect.stringMatching(/^ssh -i /u)]);
    expect(await f.local('url.git@github.com:.insteadOf')).toEqual(['https://github.com/']);
    expect(await f.local('credential.https://github.com.helper')).toEqual([]);

    // The App now covers the repository: the same checkout keeps no SSH route and answers with installation tokens.
    f.state.covered = true;
    await f.coordinator.apply(settings);
    expect(await f.local('core.sshCommand')).toEqual([]);
    expect(await f.local('url.git@github.com:.insteadOf')).toEqual([]);
    expect(await f.local('remote.origin.url')).toEqual(['https://github.com/Owner/Repo.git']);
    expect(await f.local('credential.https://github.com.useHttpPath')).toEqual(['true']);
    expect(await f.local('user.name')).toEqual(['Brad']);
    expect((await f.run(f.repository, ['remote', 'get-url', '--push', 'origin'])).stdout.trim()).toBe('https://github.com/Owner/Repo.git');
    const filled = await f.fill(f.repository);
    expect(filled.code).toBe(0);
    expect(filled.stdout).toContain('username=x-access-token\n');
    expect(filled.stdout).toContain(`password=${TOKEN}\n`);
    // A ready checkout may push; the grant names this machine's attachment at its generation.
    expect(f.tokenRequests()).toEqual([{ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'attachment', generation: 3, access: 'write' }]);
    // Applying again leaves the checkout as it is.
    const config = readFileSync(join(f.repository, '.git', 'config'), 'utf8');
    await f.coordinator.apply(settings);
    expect(readFileSync(join(f.repository, '.git', 'config'), 'utf8')).toBe(config);

    // Coverage removed: back to exactly the SSH route, with no helper left behind.
    f.state.covered = false;
    await f.coordinator.apply(settings);
    expect(await f.local('core.sshCommand')).toEqual([expect.stringMatching(/^ssh -i /u)]);
    expect(await f.local('url.git@github.com:.insteadOf')).toEqual(['https://github.com/']);
    expect(await f.local('credential.https://github.com.helper')).toEqual([]);
    expect(await f.local('credential.https://github.com.useHttpPath')).toEqual([]);
  });

  it('never writes an installation token to git config, a credential store or any file', async () => {
    const f = await coveredFixture();
    await f.coordinator.apply(settings);
    const filled = await f.fill(f.repository);
    expect(filled.stdout).toContain(`password=${TOKEN}\n`);
    expect(filled.stdout).not.toContain('personal-token');
    // Git hands a working credential to every configured helper to store; the checkout's helper list holds only its own.
    expect((await f.run(f.repository, ['credential', 'approve'], {}, `${filled.stdout}\n`)).code).toBe(0);
    expect(existsSync(f.store)).toBe(false);
    for (const path of files(f.root)) expect({ path, leaked: readFileSync(path, 'utf8').includes(TOKEN) }).toEqual({ path, leaked: false });
  });

  it('runs transient origin fetches of a covered checkout over HTTPS with its token, never through SSH', async () => {
    const f = await coveredFixture();
    // A checkout still being prepared: its origin is the project's SSH address and nothing was applied yet.
    f.state.held = [checkout(f.repository, 'attaching')];
    const [held] = f.state.held;
    if (!held) throw new Error('The fixture holds no checkout');
    const covered = await f.coordinator.originEnvironment(held);
    expect(covered.GIT_SSH_COMMAND).toBeUndefined();
    expect((await f.run(f.repository, ['remote', 'get-url', 'origin'], covered)).stdout.trim()).toBe('https://github.com/Owner/Repo.git');
    const filled = await f.fill(f.repository, covered);
    expect(filled.stdout).toContain(`password=${TOKEN}\n`);
    // Not ready yet: it may only read.
    expect(f.tokenRequests()).toEqual([expect.objectContaining({ generation: 3, access: 'read' })]);

    f.state.covered = false;
    const uncovered = await f.coordinator.originEnvironment(held);
    expect(uncovered.GIT_SSH_COMMAND).toStartWith('ssh -i ');
    expect(Object.values(uncovered).some(value => value.includes('git-credential-github'))).toBe(false);
  });

  it('answers only for a checkout generation this machine still holds', async () => {
    const f = await coveredFixture();
    await f.coordinator.apply(settings);
    // Reattached at a newer generation: the checkout's config still carries the old grant until it is applied again.
    f.state.held = [checkout(f.repository, 'ready', 4)];
    const refused = await f.fill(f.repository);
    expect(refused.code).not.toBe(0);
    expect(refused.stdout).not.toContain('password=');
    f.state.held = [];
    expect((await f.fill(f.repository)).stdout).not.toContain('password=');
    expect(f.tokenRequests()).toEqual([]);
  });
});

