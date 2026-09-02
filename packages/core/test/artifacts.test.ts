import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  GitSpaceDatabase,
  LocalArtifactResolver,
  MemoryArtifactObjectStore,
  artifactScopes,
} from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): {
  database: GitSpaceDatabase;
  resolver: LocalArtifactResolver;
  store: MemoryArtifactObjectStore;
  root: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-artifacts-'));
  roots.push(root);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  expect(database.createProject({ id: 'project-a', name: 'A', repositoryPath: '/repo/a' }).status).toBe('ok');
  expect(database.createWorkspace({
    id: 'workspace-a', projectId: 'project-a', name: 'A', branch: 'a', rootPath: '/repo/a/workspaces/a',
  }).status).toBe('ok');
  expect(database.createWorkspace({
    id: 'workspace-b', projectId: 'project-a', name: 'B', branch: 'b', rootPath: '/repo/a/workspaces/b',
  }).status).toBe('ok');
  const store = new MemoryArtifactObjectStore();
  const resolver = new LocalArtifactResolver(
    database,
    store,
    join(root, 'cache'),
    Uint8Array.from({ length: 32 }, (_, index) => index + 1),
  );
  return { database, resolver, store, root };
}

const workspaceA = { kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-a' } as const;
const workspaceB = { kind: 'workspace', projectId: 'project-a', workspaceId: 'workspace-b' } as const;
const project = { kind: 'project', projectId: 'project-a', currentWorkspaceId: 'workspace-a' } as const;

describe('LocalArtifactResolver', () => {
  it('writes, commits, evicts, and lazily restores encrypted workspace bytes', async () => {
    const { database, resolver, store } = fixture();
    const written = await resolver.write(
      workspaceA,
      'local://workspace/apps/demo/index.html',
      new TextEncoder().encode('<h1>private demo</h1>'),
      'text/html',
    );
    expect(written.status).toBe('ok');
    expect(store.objects.size).toBe(0);

    const committed = await resolver.commit(workspaceA, 'local://workspace/');
    expect(committed.status).toBe('ok');
    if (committed.status === 'error') throw committed.error;
    expect(committed.value.generation).toBe(1);
    expect(store.objects.size).toBe(2);
    for (const sealed of store.objects.values()) {
      expect(new TextDecoder().decode(sealed)).not.toContain('private demo');
    }

    await resolver.evictCachedBytes();
    const restored = await resolver.read(workspaceA, 'local://workspace/apps/demo/index.html');
    expect(restored.status).toBe('ok');
    if (restored.status === 'error') throw restored.error;
    expect(new TextDecoder().decode(restored.value)).toBe('<h1>private demo</h1>');
    expect(store.reads).toHaveLength(1);
    database.close();
  });

  it('hides sibling scopes from workspace capabilities while project capability can inspect them', async () => {
    const { database, resolver } = fixture();
    expect((await resolver.write(workspaceB, 'local://workspace/report.txt', new TextEncoder().encode('B'))).status).toBe('ok');
    expect((await resolver.commit(workspaceB, 'local://workspace/')).status).toBe('ok');

    expect(resolver.list(workspaceA, 'local://workspaces/workspace-b/').status).toBe('error');
    const visible = resolver.list(project, 'local://workspaces/workspace-b/');
    expect(visible.status).toBe('ok');
    if (visible.status === 'error') throw visible.error;
    expect(visible.value.map((entry) => entry.url)).toEqual(['local://workspaces/workspace-b/report.txt']);
    database.close();
  });

  it('keeps base read-only for workspace agents and materializes requested subtrees only', async () => {
    const { database, resolver, root } = fixture();
    expect((await resolver.write(project, 'local://base/reference.txt', new TextEncoder().encode('shared'))).status).toBe('ok');
    expect((await resolver.commit(project, 'local://base/')).status).toBe('ok');
    expect((await resolver.write(workspaceA, 'local://base/forbidden.txt', new TextEncoder().encode('no'))).status).toBe('error');
    expect((await resolver.write(workspaceA, 'local://workspace/apps/demo/a.txt', new TextEncoder().encode('A'))).status).toBe('ok');
    expect((await resolver.write(workspaceA, 'local://workspace/other/b.txt', new TextEncoder().encode('B'))).status).toBe('ok');

    const destination = join(root, 'materialized');
    const materialized = await resolver.materialize(workspaceA, 'local://workspace/apps/demo/', destination);
    expect(materialized.status).toBe('ok');
    if (materialized.status === 'error') throw materialized.error;
    expect(materialized.value.files).toEqual([join(destination, 'a.txt')]);
    expect(readFileSync(join(destination, 'a.txt'), 'utf8')).toBe('A');
    expect(resolver.list(workspaceA, 'local://base/').status).toBe('ok');
    expect(database.orm.select().from(artifactScopes).all()).toHaveLength(3);
    database.close();
  });

  it('does not republish unchanged bytes and commits deletions as a new manifest generation', async () => {
    const { database, resolver, store } = fixture();
    const bytes = new TextEncoder().encode('stable');
    expect((await resolver.write(workspaceA, 'local://workspace/stable.txt', bytes)).status).toBe('ok');
    const first = await resolver.commit(workspaceA, 'local://workspace/');
    expect(first.status).toBe('ok');
    if (first.status === 'error') throw first.error;
    expect(first.value.generation).toBe(1);
    expect(store.objects.size).toBe(2);

    expect((await resolver.write(workspaceA, 'local://workspace/stable.txt', bytes)).status).toBe('ok');
    const unchanged = await resolver.commit(workspaceA, 'local://workspace/');
    expect(unchanged.status).toBe('ok');
    if (unchanged.status === 'error') throw unchanged.error;
    expect(unchanged.value.generation).toBe(1);
    expect(store.objects.size).toBe(2);

    expect(resolver.remove(workspaceA, 'local://workspace/stable.txt').status).toBe('ok');
    const removed = await resolver.commit(workspaceA, 'local://workspace/');
    expect(removed.status).toBe('ok');
    if (removed.status === 'error') throw removed.error;
    expect(removed.value.generation).toBe(2);
    expect((await resolver.read(workspaceA, 'local://workspace/stable.txt')).status).toBe('error');
    database.close();
  });
});
