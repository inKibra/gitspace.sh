import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { eq } from 'drizzle-orm';
import { GitSpaceDatabase, artifactScopes, spacePlacements } from '../src/index.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function databasePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-core-'));
  roots.push(root);
  return join(root, 'gitspace.db');
}

function seed(database: GitSpaceDatabase): void {
  const project = database.createProject({
    id: 'project-a',
    name: 'GitSpace',
    repositoryPath: '/repos/gitspace',
    baseBranch: 'develop',
  });
  expect(project.status).toBe('ok');
  const workspace = database.createWorkspace({
    id: 'workspace-a',
    projectId: 'project-a',
    name: 'agent-blame',
    branch: 'agent-blame',
    rootPath: '/repos/gitspace/workspaces/agent-blame',
  });
  expect(workspace.status).toBe('ok');
}

describe('GitSpaceDatabase', () => {
  it('applies Drizzle migrations and restores project state after reopen', () => {
    const path = databasePath();
    const first = new GitSpaceDatabase(path);
    seed(first);
    first.checkpoint();
    first.close();

    const reopened = new GitSpaceDatabase(path);
    expect(reopened.getProject('project-a')).toMatchObject({ name: 'GitSpace', baseBranch: 'develop' });
    expect(reopened.getWorkspace('workspace-a')).toMatchObject({ projectId: 'project-a', phase: 'code' });
    expect(reopened.orm.select().from(artifactScopes).all()).toHaveLength(2);
    reopened.close();
  });


  it('enforces one possession holder with generation-checked transfer', () => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);

    const possessed = database.possessWorkspace('workspace-a', 'machine-a');
    expect(possessed.status).toBe('ok');
    if (possessed.status === 'error') throw possessed.error;
    expect(possessed.value.generation).toBe(1);
    expect(database.possessWorkspace('workspace-a', 'machine-b').status).toBe('error');

    const stale = database.transferWorkspacePossession({
      workspaceId: 'workspace-a',
      fromHolderId: 'machine-a',
      toHolderId: 'machine-b',
      expectedGeneration: 2,
    });
    expect(stale.status).toBe('error');

    const transferred = database.transferWorkspacePossession({
      workspaceId: 'workspace-a',
      fromHolderId: 'machine-a',
      toHolderId: 'machine-b',
      expectedGeneration: 1,
    });
    expect(transferred.status).toBe('ok');
    if (transferred.status === 'error') throw transferred.error;
    expect(transferred.value).toMatchObject({ holderId: 'machine-b', generation: 2 });
    database.close();
  });

  it('realigns stale closed projections without changing an owned or transitioning placement', () => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);
    expect(database.alignClosedSpaceProjection('workspace-a', 8).status).toBe('ok');
    expect(database.alignClosedSpaceProjection('workspace-a', 2).status).toBe('error');
    expect(database.beginSpaceOpen({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 8 }).status).toBe('ok');
    expect(database.alignClosedSpaceProjection('workspace-a', 10).status).toBe('error');
    expect(database.commitSpaceOpen({ spaceId: 'workspace-a', holderId: 'machine-a', generation: 9 }).status).toBe('ok');
    expect(database.alignClosedSpaceProjection('workspace-a', 10).status).toBe('error');
    expect(database.getSpacePlacement('workspace-a')).toMatchObject({ holderId: 'machine-a', state: 'open', generation: 9 });
    expect(database.beginSpaceClose({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 9 }).status).toBe('ok');
    expect(database.alignClosedSpaceProjection('workspace-a', 10).status).toBe('error');
    expect(database.commitSpaceClosed({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 9 }).status).toBe('ok');
    expect(database.alignClosedSpaceProjection('workspace-a', 12).status).toBe('ok');
    expect(database.getSpacePlacement('workspace-a')).toMatchObject({ holderId: 'unassigned', state: 'closed', generation: 12 });
    database.close();
  });

  it('re-adopts a fenced checkout without acquiring a new lease', () => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);
    expect(database.alignClosedSpaceProjection('workspace-a', 4).status).toBe('ok');
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    expect(database.invalidateSpacePossession({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 5 }).status).toBe('ok');
    const acquiredAt = '2025-01-01T00:00:00.000Z';
    const updatedAt = '2025-01-02T00:00:00.000Z';
    database.orm.update(spacePlacements).set({ acquiredAt, updatedAt }).where(eq(spacePlacements.spaceId, 'workspace-a')).run();
    const fenced = database.getSpacePlacement('workspace-a')!;
    expect(database.getWorkspacePossession('workspace-a')).toBeNull();

    const adopted = database.adoptOpenSpaceProjection({
      spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 5, rootPath: fenced.rootPath,
    });
    if (adopted.status === 'error') throw adopted.error;
    expect(adopted.value).toEqual({ ...fenced, state: 'open', holderId: 'machine-a', updatedAt: adopted.value.updatedAt });
    expect(adopted.value.updatedAt).not.toBe(updatedAt);
    expect(database.getWorkspacePossession('workspace-a')).toEqual(adopted.value);
    expect(database.getWorkspace('workspace-a')).toMatchObject({
      holderId: 'machine-a', placementState: 'open', generation: 5, rootPath: fenced.rootPath,
    });
    database.close();
  });

  it('rejects stale authority, changed checkout paths and invalid adoption inputs without changing the fenced projection', () => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);
    const unclaimed = database.getSpacePlacement('workspace-a')!;
    expect(database.adoptOpenSpaceProjection({
      spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 0, rootPath: unclaimed.rootPath,
    }).status).toBe('error');
    expect(database.getSpacePlacement('workspace-a')).toEqual(unclaimed);
    expect(database.possessWorkspace('workspace-a', 'machine-a').status).toBe('ok');
    expect(database.invalidateSpacePossession({ spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 1 }).status).toBe('ok');
    expect(database.alignClosedSpaceProjection('workspace-a', 5).status).toBe('ok');
    const fenced = database.getSpacePlacement('workspace-a')!;
    const input = { spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 5, rootPath: fenced.rootPath };
    for (const override of [
      { expectedGeneration: 4 },
      { expectedGeneration: 6 },
      { rootPath: '/repos/gitspace/workspaces/replaced' },
      { holderId: 'unassigned' },
      { holderId: '' },
      { holderId: 'x'.repeat(161) },
    ]) {
      const rejected = database.adoptOpenSpaceProjection({ ...input, ...override });
      expect(rejected.status).toBe('error');
      if (rejected.status === 'error') expect(rejected.error._tag).toBe('CoreConflict');
      expect(database.getSpacePlacement('workspace-a')).toEqual(fenced);
      expect(database.getWorkspacePossession('workspace-a')).toBeNull();
    }
    database.close();
  });

  it.each([
    { state: 'closed', holderId: 'machine-b' },
    { state: 'opening', holderId: 'unassigned' },
    { state: 'closing', holderId: 'unassigned' },
    { state: 'open', holderId: 'unassigned' },
    { state: 'open', holderId: 'machine-a' },
    { state: 'open', holderId: 'machine-b' },
  ] as const)('does not adopt a $state projection held by $holderId', ({ state, holderId }) => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);
    expect(database.alignClosedSpaceProjection('workspace-a', 5).status).toBe('ok');
    database.orm.update(spacePlacements).set({ state, holderId }).where(eq(spacePlacements.spaceId, 'workspace-a')).run();
    const before = database.getSpacePlacement('workspace-a')!;
    const possessionBefore = database.getWorkspacePossession('workspace-a');
    expect(database.adoptOpenSpaceProjection({
      spaceId: 'workspace-a', holderId: 'machine-a', expectedGeneration: 5, rootPath: before.rootPath,
    }).status).toBe('error');
    expect(database.getSpacePlacement('workspace-a')).toEqual(before);
    expect(database.getWorkspacePossession('workspace-a')).toEqual(possessionBefore);
    database.close();
  });

  it('places base and worktree spaces independently', () => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);
    const base = database.possessSpace('project-a', 'machine-base');
    const worktree = database.possessSpace('workspace-a', 'machine-worktree');
    expect(base.status).toBe('ok');
    expect(worktree.status).toBe('ok');
    if (base.status === 'error' || worktree.status === 'error') throw new Error('Expected independent placements');
    expect(database.getBaseSpace('project-a')).toMatchObject({ id: 'project-a', kind: 'base', holderId: 'machine-base', placementState: 'open' });
    expect(database.getWorkspace('workspace-a')).toMatchObject({ kind: 'worktree', holderId: 'machine-worktree', placementState: 'open' });
    expect(database.releaseSpacePossession({ spaceId: 'project-a', holderId: 'machine-base', expectedGeneration: base.value.generation }).status).toBe('ok');
    expect(database.getBaseSpace('project-a')).toMatchObject({ placementState: 'closed' });
    expect(database.getWorkspacePossession('workspace-a')).toMatchObject({ holderId: 'machine-worktree' });
    database.close();
  });

  it('creates project and workspace artifact scopes atomically', () => {
    const database = new GitSpaceDatabase(databasePath());
    seed(database);
    const scopes = database.orm.select().from(artifactScopes).orderBy(artifactScopes.id).all();
    expect(scopes).toEqual([
      expect.objectContaining({ id: 'space:project-a', spaceId: 'project-a', generation: 0 }),
      expect.objectContaining({ id: 'space:workspace-a', spaceId: 'workspace-a', generation: 0 }),
    ]);
    database.close();
  });
});
