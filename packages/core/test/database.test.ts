import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase, artifactScopes } from '../src/index.js';

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
