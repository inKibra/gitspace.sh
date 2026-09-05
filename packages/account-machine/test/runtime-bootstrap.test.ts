import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import { possessBootstrapSpace } from '../src/runtime.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('machine runtime bootstrap possession', () => {
  it('does not reopen an existing closed bootstrap space', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-runtime-bootstrap-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'project') }).status).toBe('ok');
    expect(database.createWorkspace({ id: 'workspace-a', projectId: 'project-a', name: 'Workspace', branch: 'main', rootPath: join(root, 'workspace') }).status).toBe('ok');

    possessBootstrapSpace(database, 'workspace-a', 'machine-a', false);

    expect(database.getSpacePlacement('workspace-a')).toMatchObject({ state: 'closed', holderId: 'unassigned', generation: 0 });
    database.close();
  });

  it('possesses a newly created bootstrap space', () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-runtime-bootstrap-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    expect(database.createProject({ id: 'project-a', name: 'Project', repositoryPath: join(root, 'project') }).status).toBe('ok');

    possessBootstrapSpace(database, 'project-a', 'machine-a', true, join(root, 'project'));

    expect(database.getSpacePlacement('project-a')).toMatchObject({ state: 'open', holderId: 'machine-a', generation: 1 });
    database.close();
  });
});
