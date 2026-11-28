import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import type { LifecycleRun, LifecycleRunRequest } from '@gitspace/protocol-environment';
import { machineOperationalTools } from '../src/runtime-operations.js';
import { ArtifactsGitRemote } from '../src/artifacts-git-remote.js';

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: { ...Bun.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

const unexpected = (): never => { throw new Error('Unexpected dependency access'); };

test('a cache accepts the human run the account authorized, including interactive and cloud destruction runs', async () => {
  const run: LifecycleRun = {
    id: 'run', projectId: 'project', spaceId: 'workspace', phase: 'cloud/destroy', status: 'accepted', profile: 'base', machineId: 'machine', generation: 1,
    executionHashes: [], terminalName: null, results: [], output: '', exitCode: null, startedAt: new Date().toISOString(), finishedAt: null,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(), cancelRequestedAt: null, failure: null, incidents: [],
  };
  const accepted: Array<{ spaceId: string; request: LifecycleRunRequest }> = [];
  const operations = machineOperationalTools({
    environments: { async acceptRun(spaceId, request) { accepted.push({ spaceId, request }); return run; } },
    get services() { return unexpected(); }, get reportProcessExit() { return unexpected(); }, get authority() { return unexpected(); },
    get mcp() { return unexpected(); }, get gitRemote() { return unexpected(); }, get originEnvironment() { return unexpected(); },
  });
  const attachment = RuntimeAttachmentSchema.parse({
    projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'machine',
    generation: 1, ownershipGeneration: 1, role: 'cache', checkout: { kind: 'shared', branch: 'main' },
    state: 'ready', capabilities: [], updatedAt: new Date().toISOString(),
  });
  const local = { attachment, rootPath: '/cache', executionSecret: 'secret', prerequisitesComplete: true };
  for (const args of [{ runId: 'destroy', phase: 'cloud/destroy', on: 'machine' }, { runId: 'login', phase: 'machine/prepare', interactive: true, on: 'machine' }]) {
    const dispatch = RuntimeToolDispatchSchema.parse({
      version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache',
      generation: 1, conversationId: 'conversation', conversationKind: 'main', taskId: 'task', requestId: args.runId,
      attemptId: args.runId, tool: 'lifecycle', args, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe',
    });
    expect(await operations.lifecycle!(dispatch, local, new AbortController().signal)).toEqual([{ type: 'text', text: JSON.stringify(run) }]);
  }
  expect(accepted).toEqual([
    { spaceId: 'workspace', request: { runId: 'destroy', phase: 'cloud/destroy' } },
    { spaceId: 'workspace', request: { runId: 'login', phase: 'machine/prepare', interactive: true } },
  ]);
});

test('import_ref publishes the origin ref the base checkout fetched, leaving its HEAD and refs as they were', async () => {
  const root = mkdtempSync(join(tmpdir(), 'import-ref-'));
  try {
    const origin = join(root, 'origin');
    git(root, 'init', '-q', '-b', 'main', origin);
    writeFileSync(join(origin, 'a.txt'), 'main');
    git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'main');
    git(root, 'clone', '-q', origin, 'base');
    const base = join(root, 'base');
    // The branch exists only on the origin, as `staging` did for Northwind.
    git(origin, 'checkout', '-qb', 'staging');
    writeFileSync(join(origin, 'a.txt'), 'staging');
    git(origin, 'commit', '-qam', 'staging');
    const staging = git(origin, 'rev-parse', 'HEAD');
    const head = git(base, 'rev-parse', 'HEAD');
    const before = git(base, 'for-each-ref', '--format=%(refname)');
    const published: Array<{ ref: string; commit: string; repository: string }> = [];
    const operations = machineOperationalTools({
      get environments() { return unexpected(); }, get services() { return unexpected(); }, get reportProcessExit() { return unexpected(); }, get authority() { return unexpected(); }, get mcp() { return unexpected(); },
      gitRemote: { async publishRef(input) { published.push({ ref: input.ref, commit: input.commit, repository: input.binding.repository }); } },
      originEnvironment: async () => ({}),
    });
    const attachment = RuntimeAttachmentSchema.parse({
      projectId: 'project', workspaceId: 'project', attachmentId: 'cache', machineId: 'machine', generation: 1, ownershipGeneration: 1, role: 'cache',
      checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: new Date().toISOString(),
    });
    const dispatch = (workspaceId: string, ref: string) => RuntimeToolDispatchSchema.parse({
      version: 1, projectId: 'project', workspaceId, machineId: 'machine', attachmentId: 'cache', generation: 1, conversationId: 'c', conversationKind: 'main',
      taskId: 't', requestId: 'r', attemptId: 'import:staging', tool: 'import_ref', args: { ref }, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe',
    });
    const local = { attachment, rootPath: base, executionSecret: 'secret', prerequisitesComplete: true };
    const result = await operations.import_ref!(dispatch('project', 'refs/heads/staging'), local, new AbortController().signal);
    expect(result).toEqual([{ type: 'text', text: JSON.stringify({ ref: 'refs/heads/staging', commit: staging }) }]);
    expect(published).toEqual([{ ref: 'refs/heads/staging', commit: staging, repository: 'project-project' }]);
    expect(git(base, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(base, 'for-each-ref', '--format=%(refname)')).toBe(before);
    // Another workspace's checkout is not the project's base and never publishes to the project repository.
    await expect(operations.import_ref!(dispatch('other', 'refs/heads/staging'), local, new AbortController().signal)).rejects.toThrow('project base checkout');
    expect(published).toHaveLength(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publish_commit publishes a commit to the workspace repository, fetching it by id only when the checkout lacks it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'publish-commit-'));
  try {
    const origin = join(root, 'origin');
    git(root, 'init', '-q', '-b', 'main', origin);
    writeFileSync(join(origin, 'a.txt'), 'base');
    git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base');
    const base = git(origin, 'rev-parse', 'HEAD');
    writeFileSync(join(origin, 'a.txt'), 'head');
    git(origin, 'commit', '-qam', 'head');
    const head = git(origin, 'rev-parse', 'HEAD');
    // A checkout copied in from its tip: the merge base the guide compares against is not in it.
    git(root, 'clone', '-q', '--depth=1', `file://${origin}`, 'checkout');
    const checkout = join(root, 'checkout');
    // The workspace's Artifacts repository stand-in, holding only the checkout's HEAD.
    const artifacts = join(root, 'artifacts.git');
    git(root, 'init', '-q', '--bare', artifacts);
    git(artifacts, 'config', 'receive.shallowUpdate', 'true');
    git(checkout, 'config', `url.${artifacts}.insteadOf`, 'https://artifacts.invalid/repository');
    git(checkout, 'push', '-q', artifacts, `${head}:refs/heads/main`);
    const repositories = new Set<string>();
    const gitRemote = new ArtifactsGitRemote({ credentials: async binding => {
      repositories.add(binding.repository);
      return { remote: 'https://artifacts.invalid/repository', plaintext: 'offline', expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
    } });
    let originReads = 0;
    const operations = machineOperationalTools({
      get environments() { return unexpected(); }, get services() { return unexpected(); }, get reportProcessExit() { return unexpected(); }, get authority() { return unexpected(); }, get mcp() { return unexpected(); },
      gitRemote, originEnvironment: async () => { originReads++; return {}; },
    });
    const attachment = RuntimeAttachmentSchema.parse({
      projectId: 'project', workspaceId: 'workspace', attachmentId: 'cache', machineId: 'machine', generation: 1, ownershipGeneration: 1, role: 'cache',
      checkout: { kind: 'shared', branch: 'main' }, state: 'ready', capabilities: [], updatedAt: new Date().toISOString(),
    });
    const publish = (commit: string, rootPath = checkout) => operations.publish_commit!(RuntimeToolDispatchSchema.parse({
      version: 1, projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'cache', generation: 1, conversationId: 'c', conversationKind: 'main',
      taskId: 't', requestId: 'r', attemptId: `publish:${commit}`, tool: 'publish_commit', args: { commit }, deadlineAt: new Date(Date.now() + 30_000).toISOString(), replay: 'unsafe',
    }), { attachment, rootPath, executionSecret: 'secret', prerequisitesComplete: true }, new AbortController().signal);
    const refs = git(checkout, 'for-each-ref', '--format=%(refname)');

    expect(await publish(base)).toEqual([{ type: 'text', text: JSON.stringify({ ref: `refs/gitspace/commits/${base}`, commit: base }) }]);
    expect(originReads).toBe(1);
    expect(repositories).toEqual(new Set(['workspace-workspace']));
    expect(git(artifacts, 'rev-parse', `refs/gitspace/commits/${base}`)).toBe(base);
    expect(git(artifacts, 'rev-parse', `${base}^{tree}`)).toBe(git(origin, 'rev-parse', `${base}^{tree}`));
    expect(git(checkout, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(checkout, 'for-each-ref', '--format=%(refname)')).toBe(refs);

    // A commit the checkout holds is published without asking its origin.
    await publish(head);
    expect(originReads).toBe(1);
    expect(git(artifacts, 'rev-parse', `refs/gitspace/commits/${head}`)).toBe(head);

    // Published again: the remote ref already names it, so nothing is fetched or pushed (the remote now refuses pushes).
    const hook = join(artifacts, 'hooks/pre-receive');
    writeFileSync(hook, '#!/bin/sh\nexit 1\n'); chmodSync(hook, 0o755);
    await publish(base);
    expect(originReads).toBe(1);

    const absent = 'f'.repeat(40);
    await expect(publish(absent)).rejects.toThrow(`Commit ${absent} is not in this checkout and its origin did not serve it`);

    // A full-history checkout lacking a commit fetches it without a depth and stays full-history.
    git(root, 'clone', '-q', origin, 'full');
    const full = join(root, 'full');
    git(origin, 'checkout', '-qb', 'side');
    writeFileSync(join(origin, 'a.txt'), 'side');
    git(origin, 'commit', '-qam', 'side');
    const side = git(origin, 'rev-parse', 'HEAD');
    git(origin, 'checkout', '-q', 'main');
    const fullArtifacts = join(root, 'full-artifacts.git');
    git(root, 'init', '-q', '--bare', fullArtifacts);
    git(fullArtifacts, 'config', 'receive.shallowUpdate', 'true');
    git(full, 'config', `url.${fullArtifacts}.insteadOf`, 'https://artifacts.invalid/repository');
    git(full, 'push', '-q', fullArtifacts, `${head}:refs/heads/main`);
    await publish(side, full);
    // The third origin read: the unfetchable commit above asked once too.
    expect(originReads).toBe(3);
    expect(git(full, 'rev-parse', '--is-shallow-repository')).toBe('false');
    expect(git(fullArtifacts, 'rev-parse', `refs/gitspace/commits/${side}`)).toBe(side);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
