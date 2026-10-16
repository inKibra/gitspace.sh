import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeAttachmentSchema, RuntimeToolDispatchSchema } from '@gitspace/protocol-runtime';
import type { LifecycleRun, LifecycleRunRequest } from '@gitspace/protocol-environment';
import { machineOperationalTools } from '../src/runtime-operations.js';

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
    get services() { return unexpected(); }, get authority() { return unexpected(); },
    get mcp() { return unexpected(); }, get projectRepository() { return unexpected(); }, get originEnvironment() { return unexpected(); },
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
    // The branch exists only on the origin, as `staging` did for Deedible.
    git(origin, 'checkout', '-qb', 'staging');
    writeFileSync(join(origin, 'a.txt'), 'staging');
    git(origin, 'commit', '-qam', 'staging');
    const staging = git(origin, 'rev-parse', 'HEAD');
    const head = git(base, 'rev-parse', 'HEAD');
    const before = git(base, 'for-each-ref', '--format=%(refname)');
    const published: Array<{ ref: string; commit: string; repository: string }> = [];
    const operations = machineOperationalTools({
      get environments() { return unexpected(); }, get services() { return unexpected(); }, get authority() { return unexpected(); }, get mcp() { return unexpected(); },
      projectRepository: { async publishRef(input) { published.push({ ref: input.ref, commit: input.commit, repository: input.binding.repository }); } },
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
