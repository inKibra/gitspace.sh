import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitSpaceDatabase } from '@gitspace/core';
import { possessBootstrapSpace, reconcileOpenSpaceProjection } from '../src/runtime.js';
import type { SpaceAuthorityRecord } from '@gitspace/protocol-workspace';

const roots: string[] = [];
const databases: GitSpaceDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
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

describe('machine runtime authoritative projection reconciliation', () => {
  function retainedCheckout(holderId = 'machine-a') {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-runtime-reconcile-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    databases.push(database);
    const checkout = join(root, 'project');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    writeFileSync(join(checkout, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(checkout, 'uncommitted.txt'), 'retained local work\n');
    const created = database.createProject({ id: 'project-a', name: 'Project', repositoryPath: checkout });
    if (created.status === 'error') throw created.error;
    const possessed = database.possessSpace('project-a', holderId, checkout);
    if (possessed.status === 'error') throw possessed.error;
    const cloud: SpaceAuthorityRecord = {
      projectId: 'project-a',
      spaceId: 'project-a',
      state: 'open',
      machineId: holderId,
      generation: possessed.value.generation,
      checkpointRevision: 0,
      manifestKey: null,
      manifestHash: null,
      failures: { open: null, close: null },
      revision: 1,
      publishedRevision: 0,
      resumeMachineId: null,
      updatedAt: possessed.value.updatedAt,
    };
    return { root, database, checkout, cloud };
  }

  it('recovers an intact fenced checkout after cloud cancels an interrupted close', () => {
    const { root, database, checkout, cloud } = retainedCheckout();
    const original = database.getSpacePlacement(cloud.spaceId)!;

    expect(reconcileOpenSpaceProjection(database, cloud.spaceId, 'machine-a', { ...cloud, state: 'closing' })).toBe(false);
    expect(database.getSpacePlacement(cloud.spaceId)).toMatchObject({
      state: 'closed', holderId: 'unassigned', generation: original.generation, rootPath: checkout,
    });
    database.close();
    databases.splice(databases.indexOf(database), 1);

    const restarted = new GitSpaceDatabase(join(root, 'gitspace.db'));
    databases.push(restarted);
    expect(reconcileOpenSpaceProjection(restarted, cloud.spaceId, 'machine-a', cloud)).toBe(true);
    expect(restarted.getSpacePlacement(cloud.spaceId)).toMatchObject({
      state: 'open',
      holderId: 'machine-a',
      generation: original.generation,
      rootPath: checkout,
      acquiredAt: original.acquiredAt,
    });
    expect(readFileSync(join(checkout, 'uncommitted.txt'), 'utf8')).toBe('retained local work\n');
    expect(readFileSync(join(checkout, '.git', 'HEAD'), 'utf8')).toBe('ref: refs/heads/main\n');
    expect(reconcileOpenSpaceProjection(restarted, cloud.spaceId, 'machine-a', cloud)).toBe(true);
    expect(restarted.getSpacePlacement(cloud.spaceId)?.generation).toBe(original.generation);
  });

  it.each([
    { name: 'another cloud owner', overrides: { machineId: 'machine-b' } },
    { name: 'an older cloud generation', overrides: { generation: 0 } },
    { name: 'a newer cloud generation', overrides: { generation: 2 } },
    { name: 'a closed cloud placement', overrides: { state: 'closed', machineId: null, resumeMachineId: 'machine-a' } },
    { name: 'a closing cloud placement', overrides: { state: 'closing' } },
    { name: 'an opening cloud placement', overrides: { state: 'opening' } },
  ] satisfies { name: string; overrides: Partial<SpaceAuthorityRecord> }[])('does not adopt $name', ({ overrides }) => {
    const { database, checkout, cloud } = retainedCheckout();
    const fenced = database.invalidateSpacePossession({ spaceId: cloud.spaceId, holderId: 'machine-a', expectedGeneration: cloud.generation });
    if (fenced.status === 'error') throw fenced.error;

    expect(reconcileOpenSpaceProjection(database, cloud.spaceId, 'machine-a', { ...cloud, ...overrides })).toBe(false);
    expect(database.getSpacePlacement(cloud.spaceId)).toEqual(fenced.value);
    expect(readFileSync(join(checkout, 'uncommitted.txt'), 'utf8')).toBe('retained local work\n');
  });

  it('does not steal a local projection held by another machine', () => {
    const { database, cloud } = retainedCheckout('machine-b');
    const original = database.getSpacePlacement(cloud.spaceId);

    expect(reconcileOpenSpaceProjection(database, cloud.spaceId, 'machine-a', { ...cloud, machineId: 'machine-a' })).toBe(false);
    expect(database.getSpacePlacement(cloud.spaceId)).toEqual(original);
  });

  it('does not adopt a retained directory without its checkout', () => {
    const { database, checkout, cloud } = retainedCheckout();
    const fenced = database.invalidateSpacePossession({ spaceId: cloud.spaceId, holderId: 'machine-a', expectedGeneration: cloud.generation });
    if (fenced.status === 'error') throw fenced.error;
    rmSync(join(checkout, '.git'), { recursive: true });

    expect(reconcileOpenSpaceProjection(database, cloud.spaceId, 'machine-a', cloud)).toBe(false);
    expect(database.getSpacePlacement(cloud.spaceId)).toEqual(fenced.value);
    expect(readFileSync(join(checkout, 'uncommitted.txt'), 'utf8')).toBe('retained local work\n');
  });
});
