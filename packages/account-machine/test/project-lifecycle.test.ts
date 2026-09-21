import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase, type MaterializedSpace } from '@gitspace/core';
import { createWorkspaceContract, type CloudProjectOperation, type CloudProjectSummary, type CloudWorkspaceDefinition } from '@gitspace/protocol';
import { beginSpaceClose, commitSpaceClosed, spaceCheckpointManifestKey, spaceCheckpointManifestSchema, type SpaceAuthorityRecord } from '@gitspace/protocol-workspace';
import { ProjectLifecycleManager, type ProjectLifecycleAuthority } from '../src/project-lifecycle.js';
import type { CloudSpaceCheckpointAuthority } from '../src/cloud-space-authority.js';
import { createSpaceEvalNamespace } from '../src/space-eval-sdk.js';
import { createPublishedSpaceHeadResolver } from '../src/inspector-base.js';
import { createGitIntermediateCheckpoint } from '../src/git-checkpoint.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function seedRepository(root: string, branch = 'trunk'): string {
  const source = join(root, 'source');
  mkdirSync(source);
  git(source, 'init', '-b', branch);
  writeFileSync(join(source, 'README.txt'), 'imported\n');
  git(source, 'add', 'README.txt');
  git(source, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-m', 'seed');
  return source;
}

class MemoryProjectAuthority implements ProjectLifecycleAuthority {
  readonly projects = new Map<string, CloudProjectSummary>();
  readonly workspaces = new Map<string, CloudWorkspaceDefinition>();
  readonly operations = new Map<string, CloudProjectOperation>();
  readonly spaces = new Map<string, SpaceAuthorityRecord>();
  readonly inspectors = new Map<string, { projectId: string; spaceId: string }>();

  async bootstrap(input: { projectId: string; spaceId: string }) {
    const record: SpaceAuthorityRecord = {
      ...input, state: 'open', machineId: 'machine-a', generation: 1, checkpointRevision: 0,
      manifestKey: null, manifestHash: null, failures: { open: null, close: null },
      revision: 1, publishedRevision: 0, resumeMachineId: null, updatedAt: new Date(0).toISOString(),
    };
    this.spaces.set(input.spaceId, record);
    return record;
  }

  async getSpace(projectId: string, spaceId: string) {
    const record = this.spaces.get(spaceId);
    return record?.projectId === projectId ? record : null;
  }

  async bootstrapInspector(input: { projectId: string; spaceId: string }) {
    this.inspectors.set(input.spaceId, input);
    return input;
  }

  async listProjects(lifecycle?: 'active' | 'archived') {
    return [...this.projects.values()].filter((project) => project.lifecycle !== 'deleting' && (!lifecycle || (lifecycle === 'archived' ? project.lifecycle === 'archived' : project.lifecycle !== 'archived')));
  }

  async bootstrapProject(input: { projectId: string; name: string; repositoryReference: string | null; baseBranch: string }) {
    const now = new Date().toISOString();
    const project: CloudProjectSummary = { id: input.projectId, name: input.name, lifecycle: 'provisioning', repositoryReference: input.repositoryReference, baseBranch: input.baseBranch, role: null, source: null, revision: 1, archivedAt: null, updatedAt: now };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(projectId: string) { return this.projects.get(projectId) ?? null; }

  async activateSourceProject(projectId: string, expectedRevision: number, baseBranch: string) {
    const current = this.projects.get(projectId)!;
    this.projects.set(projectId, { ...current, baseBranch, source: { release: current.source?.release ?? null, commit: current.source?.commit ?? null, branch: baseBranch } });
    return this.setProjectLifecycle(projectId, expectedRevision, 'active');
  }

  async setProjectLifecycle(projectId: string, expectedRevision: number, lifecycle: CloudProjectSummary['lifecycle']) {
    const current = this.projects.get(projectId)!;
    expect(current.revision).toBe(expectedRevision);
    const next = { ...current, lifecycle, revision: current.revision + 1, archivedAt: lifecycle === 'archived' ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
    this.projects.set(projectId, next);
    return next;
  }

  async deleteProject(projectId: string, expectedRevision: number) {
    for (const workspace of await this.listProjectWorkspaces(projectId)) this.workspaces.delete(workspace.id);
    return this.setProjectLifecycle(projectId, expectedRevision, 'deleting');
  }

  async listProjectWorkspaces(projectId: string) { return [...this.workspaces.values()].filter((workspace) => workspace.projectId === projectId); }

  async putProjectWorkspace(projectId: string, input: Omit<CloudWorkspaceDefinition, 'revision' | 'createdAt' | 'updatedAt' | 'archivedAt'> & { expectedRevision: number }) {
    const current = this.workspaces.get(input.id);
    expect(current?.revision ?? 0).toBe(input.expectedRevision);
    const now = new Date().toISOString();
    const workspace: CloudWorkspaceDefinition = { ...input, projectId, revision: input.expectedRevision + 1, archivedAt: input.lifecycle === 'archived' ? now : null, createdAt: current?.createdAt ?? now, updatedAt: now };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  async removeProjectWorkspace(_projectId: string, workspaceId: string, expectedRevision: number) {
    expect(this.workspaces.get(workspaceId)?.revision).toBe(expectedRevision);
    return this.workspaces.delete(workspaceId);
  }

  async createProjectOperation(_projectId: string, input: { projectId: string; workspaceId: string | null; kind: string; targetMachines: string[]; steps: Array<{ id: string; label: string }>; createdBy: string }) {
    const now = new Date().toISOString();
    const operation: CloudProjectOperation = { id: crypto.randomUUID(), projectId: input.projectId, workspaceId: input.workspaceId, kind: input.kind, state: 'queued', targetMachines: input.targetMachines, steps: input.steps.map((step) => ({ ...step, state: 'queued', message: null, updatedAt: now })), claimToken: null, leaseExpiresAt: null, error: null, revision: 1, createdBy: input.createdBy, createdAt: now, updatedAt: now };
    this.operations.set(operation.id, operation);
    return operation;
  }

  async updateProjectOperation(_projectId: string, input: { id: string; expectedRevision: number; state: CloudProjectOperation['state']; steps: CloudProjectOperation['steps']; error: string | null }) {
    const current = this.operations.get(input.id)!;
    expect(current.revision).toBe(input.expectedRevision);
    const operation = { ...current, state: input.state, steps: input.steps, error: input.error, revision: current.revision + 1, updatedAt: new Date().toISOString() };
    this.operations.set(operation.id, operation);
    return operation;
  }
}

function archiveFixture(lifecycle: CloudWorkspaceDefinition['lifecycle'] = 'failed', authority = new MemoryProjectAuthority()) {
  const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-archive-'));
  roots.push(root);
  const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
  const now = new Date(0).toISOString();
  const definition: CloudWorkspaceDefinition = {
    id: 'archive-workspace', projectId: 'archive-project', kind: 'worktree', name: 'Archive', branch: 'feature/archive',
    phase: 'plan', sourceKind: 'branch', sourceRef: 'origin/main', sourceCommit: 'a'.repeat(40),
    lifecycle, goalId: 'goal-a', revision: 2, archivedAt: null, createdAt: now, updatedAt: now,
  };
  authority.projects.set(definition.projectId, {
    id: definition.projectId, name: 'Archive project', lifecycle: 'active', repositoryReference: null, baseBranch: 'main',
    role: null, source: null, revision: 2, archivedAt: null, updatedAt: now,
  });
  authority.workspaces.set(definition.id, definition);
  const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'), async () => {
    throw new Error('Archive must not bootstrap a checkpoint');
  });
  return {
    root, database, authority, manager, definition,
    input: { projectId: definition.projectId, spaceId: definition.id, expectedRevision: definition.revision, expectedGeneration: null as number | null },
    materialize(holderId = 'machine-a') {
      const project = database.createProject({ id: definition.projectId, name: 'Archive project', repositoryPath: join(root, 'base') });
      if (project.status === 'error') throw project.error;
      const workspace = database.createWorkspace({
        id: definition.id, projectId: definition.projectId, name: definition.name, branch: definition.branch,
        rootPath: join(root, 'workspace'),
      });
      if (workspace.status === 'error') throw workspace.error;
      const held = database.possessSpace(definition.id, holderId);
      if (held.status === 'error') throw held.error;
      return database.getSpace(definition.id)!;
    },
    async close(space: MaterializedSpace, expectedGeneration: number) {
      const change = { spaceId: space.id, holderId: 'machine-a', expectedGeneration };
      const started = database.beginSpaceClose(change);
      if (started.status === 'error') throw started.error;
      authority.spaces.set(space.id, checkpointedPlacement(authority.spaces.get(space.id)!));
      const closed = database.commitSpaceClosed(change);
      if (closed.status === 'error') throw closed.error;
    },
  };
}

function checkpointedPlacement(placement: SpaceAuthorityRecord): SpaceAuthorityRecord {
  const input = { projectId: placement.projectId, spaceId: placement.spaceId, machineId: 'machine-a', expectedGeneration: placement.generation };
  const now = new Date().toISOString();
  const closing = beginSpaceClose(placement, input, now);
  return commitSpaceClosed(closing.state, {
    ...input, revision: closing.revision, manifestKey: spaceCheckpointManifestKey(input.projectId, input.spaceId, closing.revision),
    manifestHash: `sha256:${'b'.repeat(64)}`,
  }, now);
}

describe('ProjectLifecycleManager.setWorkspaceLifecycle', () => {
  it.each(['failed', 'active'] as const)('retries the initial checkpoint before activating a %s retained workspace', async (lifecycle) => {
    const fixture = archiveFixture(lifecycle);
    const { root, database, authority, definition, input } = fixture;
    const local = fixture.materialize();
    mkdirSync(local.rootPath, { recursive: true });
    writeFileSync(join(local.rootPath, 'retained.txt'), 'unpublished work\n');
    await authority.bootstrap(input);
    let storageAvailable = false;
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'), async () => {
      if (!storageAvailable) throw new Error('s3 put error: dispatch failure');
      await fixture.close(database.getSpace(local.id)!, local.generation);
      const held = database.possessSpace(local.id, 'machine-a');
      if (held.status === 'error') throw held.error;
      authority.spaces.set(local.id, {
        ...authority.spaces.get(local.id)!, state: 'open', machineId: 'machine-a',
        generation: database.getSpace(local.id)!.generation,
      });
    });
    try {
      await expect(manager.setWorkspaceLifecycle(input.projectId, local.id, 'active', definition.revision)).rejects.toThrow('s3 put error');
      expect(authority.workspaces.get(local.id)).toEqual(definition);
      expect(readFileSync(join(local.rootPath, 'retained.txt'), 'utf8')).toBe('unpublished work\n');
      storageAvailable = true;
      const restored = await manager.setWorkspaceLifecycle(input.projectId, local.id, 'active', definition.revision);
      expect(restored).toMatchObject({ lifecycle: 'active', goalId: definition.goalId, sourceCommit: definition.sourceCommit });
      expect(await authority.getSpace(input.projectId, local.id)).toMatchObject({
        state: 'open', machineId: 'machine-a', publishedRevision: 1,
        generation: database.getSpace(local.id)!.generation,
      });
      expect(readFileSync(join(local.rootPath, 'retained.txt'), 'utf8')).toBe('unpublished work\n');
    } finally {
      database.close();
    }
  });
});

describe('ProjectLifecycleManager.archiveWorkspace', () => {
  it('archives a cloud-only failed creation without inventing a projection, placement, or checkout', async () => {
    const { root, database, authority, manager, definition, input } = archiveFixture();
    try {
      const archived = await manager.archiveWorkspace(input, async () => { throw new Error('No local workspace to close'); });
      expect(authority.workspaces.get(definition.id)).toEqual(archived);
      expect(archived).toMatchObject({
        ...definition, lifecycle: 'archived', revision: 3, archivedAt: expect.any(String), updatedAt: expect.any(String),
      });
      expect(database.getProject(input.projectId)).toBeNull();
      expect(database.getSpace(input.spaceId)).toBeNull();
      expect(database.getSpacePlacement(input.spaceId)).toBeNull();
      expect(await authority.getSpace(input.projectId, input.spaceId)).toBeNull();
      expect(authority.inspectors.size).toBe(0);
      expect(existsSync(join(root, 'spaces'))).toBe(false);
      expect([...authority.operations.values()]).toMatchObject([{ kind: 'workspace.archive', state: 'succeeded' }]);
    } finally {
      database.close();
    }
  });

  it('retains a closed published checkpoint when no local workspace exists', async () => {
    const { root, database, authority, manager, definition, input } = archiveFixture('active');
    try {
      const placement = checkpointedPlacement(await authority.bootstrap(input));
      authority.spaces.set(input.spaceId, placement);
      const archived = await manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, async () => {
        throw new Error('Closed checkpoint must not be replaced');
      });
      expect(archived).toMatchObject({ lifecycle: 'archived', sourceCommit: definition.sourceCommit, archivedAt: expect.any(String) });
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toBeNull();
      expect(database.getSpacePlacement(input.spaceId)).toBeNull();
      expect(existsSync(join(root, 'spaces'))).toBe(false);
    } finally {
      database.close();
    }
  });

  it('archives after safe close removes both local workspace and project records', async () => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, definition, input } = fixture;
    try {
      fixture.materialize();
      const placement = await authority.bootstrap(input);
      const archived = await manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, async (space, generation) => {
        await fixture.close(space, generation);
        database.deleteWorkspace(space.id);
        database.deleteProject(space.projectId);
      });
      expect(archived).toMatchObject({ lifecycle: 'archived', sourceCommit: definition.sourceCommit, goalId: definition.goalId });
      expect(database.getSpace(input.spaceId)).toBeNull();
      expect(database.getProject(input.projectId)).toBeNull();
      expect(await authority.getSpace(input.projectId, input.spaceId)).toMatchObject({ state: 'closed', publishedRevision: 1 });
      expect([...authority.operations.values()]).toMatchObject([{ kind: 'workspace.archive', state: 'succeeded' }]);
    } finally {
      database.close();
    }
  });

  it.each(['unpublished', 'missing-manifest', 'missing-hash', 'remote', 'closing'] as const)('rejects cloud-only %s placement without changing lifecycle', async (scenario) => {
    const { database, authority, manager, definition, input } = archiveFixture('active');
    try {
      const closed = checkpointedPlacement(await authority.bootstrap(input));
      const placement = {
        ...closed,
        ...(scenario === 'unpublished' ? { publishedRevision: 0 } : {}),
        ...(scenario === 'missing-manifest' ? { manifestKey: null } : {}),
        ...(scenario === 'missing-hash' ? { manifestHash: null } : {}),
        ...(scenario === 'remote' ? { state: 'open' as const, machineId: 'machine-b' } : {}),
        ...(scenario === 'closing' ? { state: 'closing' as const, machineId: 'machine-a' } : {}),
      };
      authority.spaces.set(input.spaceId, placement);
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, async () => {
        throw new Error('Cloud-only placement must not invoke close');
      })).rejects.toThrow();
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(database.getSpace(input.spaceId)).toBeNull();
      expect([...authority.operations.values()]).toMatchObject([{ state: 'failed' }]);
    } finally {
      database.close();
    }
  });

  it('restores and deletes a cloud-only definition without creating operational rows', async () => {
    const { database, authority, manager, input } = archiveFixture('archived');
    try {
      const placement = checkpointedPlacement(await authority.bootstrap(input));
      authority.spaces.set(input.spaceId, placement);
      expect(await manager.findWorkspace(input.spaceId)).toMatchObject({ id: input.spaceId, lifecycle: 'archived' });
      const restored = await manager.setWorkspaceLifecycle(input.projectId, input.spaceId, 'active', input.expectedRevision);
      expect(restored.lifecycle).toBe('active');
      const archived = await manager.archiveWorkspace({ ...input, expectedRevision: restored.revision, expectedGeneration: placement.generation }, async () => {
        throw new Error('Cloud-only workspace must not close');
      });
      expect(await manager.deleteWorkspace(input.projectId, input.spaceId, archived.revision)).toBe(true);
      expect(await manager.findWorkspace(input.spaceId)).toBeNull();
      expect(database.getProject(input.projectId)).toBeNull();
      expect(database.getSpace(input.spaceId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('archives, restores and deletes a cloud-only project without projecting it locally', async () => {
    const { database, authority, manager, input } = archiveFixture('archived');
    try {
      authority.spaces.set(input.spaceId, checkpointedPlacement(await authority.bootstrap(input)));
      const archived = await manager.archiveProject(input.projectId, 2);
      const restored = await manager.restoreProject(input.projectId, archived.revision);
      expect(restored.lifecycle).toBe('active');
      const rearchived = await manager.archiveProject(input.projectId, restored.revision);
      expect(await manager.deleteProject(input.projectId, rearchived.revision)).toBe(true);
      expect(await authority.getProject(input.projectId)).toMatchObject({ lifecycle: 'deleting' });
      expect(database.getProject(input.projectId)).toBeNull();
      expect([...authority.operations.values()].map((operation) => operation.state)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    } finally {
      database.close();
    }
  });

  it.each(['remote', 'uncommitted'] as const)('does not archive a project with a cloud-only %s workspace', async (scenario) => {
    const { database, authority, manager, input } = archiveFixture('active');
    try {
      const placement = await authority.bootstrap(input);
      authority.spaces.set(input.spaceId, scenario === 'remote'
        ? { ...placement, machineId: 'machine-b' }
        : { ...placement, state: 'closed', machineId: null });
      await expect(manager.deleteWorkspace(input.projectId, input.spaceId, input.expectedRevision)).rejects.toThrow('safely closed');
      await expect(manager.archiveProject(input.projectId, 2)).rejects.toThrow('safely closed');
      expect(await authority.getProject(input.projectId)).toMatchObject({ lifecycle: 'active', revision: 2 });
      expect(database.getProject(input.projectId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('archives a held workspace only after its checkpoint closes and preserves retained disk data', async () => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, input } = fixture;
    try {
      const local = fixture.materialize();
      mkdirSync(local.rootPath);
      writeFileSync(join(local.rootPath, 'keep.txt'), 'uncommitted user data');
      const placement = await authority.bootstrap(input);
      await manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, fixture.close);
      expect(authority.workspaces.get(input.spaceId)).toMatchObject({ lifecycle: 'archived', archivedAt: expect.any(String) });
      expect(await authority.getSpace(input.projectId, input.spaceId)).toMatchObject({
        state: 'closed', machineId: null, generation: 2, publishedRevision: 1,
        manifestKey: spaceCheckpointManifestKey(input.projectId, input.spaceId, 1), manifestHash: `sha256:${'b'.repeat(64)}`,
      });
      expect(database.getSpace(input.spaceId)).toMatchObject({ placementState: 'closed', generation: 2, closedAt: expect.any(String) });
      expect(readFileSync(join(local.rootPath, 'keep.txt'), 'utf8')).toBe('uncommitted user data');
    } finally {
      database.close();
    }
  });

  it('rejects a stale canonical revision before closing a held workspace', async () => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, definition, input } = fixture;
    try {
      const local = fixture.materialize();
      const placement = await authority.bootstrap(input);
      await expect(manager.archiveWorkspace({ ...input, expectedRevision: 1, expectedGeneration: placement.generation }, fixture.close)).rejects.toThrow('revision conflict');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toEqual(local);
    } finally {
      database.close();
    }
  });

  it.each([
    { present: false, expectedGeneration: 0 },
    { present: true, expectedGeneration: null },
    { present: true, expectedGeneration: 2 },
  ])('rejects stale generation $expectedGeneration with placement present=$present', async ({ present, expectedGeneration }) => {
    const fixture = archiveFixture();
    const { database, authority, manager, definition, input } = fixture;
    try {
      const placement = present ? await authority.bootstrap(input) : null;
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration }, fixture.close)).rejects.toThrow('generation conflict');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it.each(['active', 'provisioning'] as const)('does not hide a %s workspace with missing placement', async (lifecycle) => {
    const fixture = archiveFixture(lifecycle);
    const { database, authority, manager, definition, input } = fixture;
    try {
      await expect(manager.archiveWorkspace(input, fixture.close)).rejects.toThrow('no authoritative placement');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toBeNull();
      expect(database.getSpace(input.spaceId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it('does not hide a held local checkout when failed creation placement is missing', async () => {
    const fixture = archiveFixture();
    const { database, authority, manager, definition, input } = fixture;
    try {
      const held = fixture.materialize();
      await expect(manager.archiveWorkspace(input, fixture.close)).rejects.toThrow('Local workspace must be safely closed');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(database.getSpace(input.spaceId)).toEqual(held);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it.each([
    { state: 'open', machineId: 'machine-b' },
    { state: 'opening', machineId: 'machine-a' },
    { state: 'closing', machineId: 'machine-a' },
  ] as const)('rejects a $state placement held by $machineId even with a local projection', async ({ state, machineId }) => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, definition, input } = fixture;
    try {
      const local = fixture.materialize();
      const placement = { ...await authority.bootstrap(input), state, machineId };
      authority.spaces.set(input.spaceId, placement);
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, fixture.close)).rejects.toThrow();
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toEqual(local);
    } finally {
      database.close();
    }
  });

  it.each(['missing', 'foreign', 'stale', 'closing'] as const)('rejects a locally held authority with %s local data', async (scenario) => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, definition, input } = fixture;
    try {
      if (scenario !== 'missing') fixture.materialize(scenario === 'foreign' ? 'machine-b' : 'machine-a');
      if (scenario === 'closing') {
        const started = database.beginSpaceClose({ spaceId: input.spaceId, holderId: 'machine-a', expectedGeneration: 1 });
        if (started.status === 'error') throw started.error;
      }
      const placement = { ...await authority.bootstrap(input), generation: scenario === 'stale' ? 2 : 1 };
      authority.spaces.set(input.spaceId, placement);
      const local = database.getSpace(input.spaceId);
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, fixture.close)).rejects.toThrow('matching locally held open generation');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toEqual(local);
    } finally {
      database.close();
    }
  });

  it('leaves canonical lifecycle and local archival state intact after checkpoint failure', async () => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, definition, input } = fixture;
    try {
      const local = fixture.materialize();
      const placement = await authority.bootstrap(input);
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, async () => {
        throw new Error('Checkpoint upload failed');
      })).rejects.toThrow('Checkpoint upload failed');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toEqual(local);
      expect([...authority.operations.values()]).toMatchObject([{ kind: 'workspace.archive', state: 'failed' }]);
    } finally {
      database.close();
    }
  });

  it('retains a concurrent canonical edit after closing rather than overwriting its revision', async () => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, input } = fixture;
    try {
      fixture.materialize();
      const placement = await authority.bootstrap(input);
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, async (space, generation) => {
        await fixture.close(space, generation);
        await manager.setWorkspacePhase(input.projectId, input.spaceId, 'review', input.expectedRevision);
      })).rejects.toThrow('revision conflict');
      expect(authority.workspaces.get(input.spaceId)).toMatchObject({ lifecycle: 'active', phase: 'review', revision: 3, archivedAt: null });
      expect(await authority.getSpace(input.projectId, input.spaceId)).toMatchObject({ state: 'closed', publishedRevision: 1 });
      expect(database.getSpace(input.spaceId)).toMatchObject({ placementState: 'closed', closedAt: null });
    } finally {
      database.close();
    }
  });

  it('rejects a close that did not leave authority safely closed', async () => {
    const fixture = archiveFixture('active');
    const { database, authority, manager, definition, input } = fixture;
    try {
      const local = fixture.materialize();
      const placement = await authority.bootstrap(input);
      await expect(manager.archiveWorkspace({ ...input, expectedGeneration: placement.generation }, async () => {})).rejects.toThrow('placement changed');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toEqual(placement);
      expect(database.getSpace(input.spaceId)).toEqual(local);
    } finally {
      database.close();
    }
  });

  it('rejects a placement created while a cloud-only failed workspace is being archived', async () => {
    class ConcurrentPlacementAuthority extends MemoryProjectAuthority {
      private reads = 0;
      override async getSpace(projectId: string, spaceId: string) {
        if (++this.reads === 2) await this.bootstrap({ projectId, spaceId });
        return super.getSpace(projectId, spaceId);
      }
    }
    const fixture = archiveFixture('failed', new ConcurrentPlacementAuthority());
    const { database, authority, manager, definition, input } = fixture;
    try {
      await expect(manager.archiveWorkspace(input, fixture.close)).rejects.toThrow('placement changed');
      expect(authority.workspaces.get(input.spaceId)).toEqual(definition);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toMatchObject({ state: 'open', generation: 1 });
      expect(database.getSpace(input.spaceId)).toBeNull();
    } finally {
      database.close();
    }
  });

  it.each(['project', 'base'] as const)('rejects mismatched %s identity without touching canonical state', async (scenario) => {
    const fixture = archiveFixture();
    const { database, authority, manager, definition, input } = fixture;
    try {
      const current = scenario === 'base' ? { ...definition, kind: 'base' as const, phase: null } : definition;
      authority.workspaces.set(input.spaceId, current);
      await expect(manager.archiveWorkspace({
        ...input, projectId: scenario === 'project' ? 'other-project' : input.projectId,
      }, fixture.close)).rejects.toThrow('not a worktree');
      expect(authority.workspaces.get(input.spaceId)).toEqual(current);
      expect(await authority.getSpace(input.projectId, input.spaceId)).toBeNull();
      expect(database.getSpace(input.spaceId)).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe('ProjectLifecycleManager', () => {
  it('records the resolved creation commit before checkpointing and retains it after local work and lifecycle updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-source-provenance-'));
    roots.push(root);
    const source = seedRepository(root);
    const sourceCommit = git(source, 'rev-parse', 'HEAD');
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'), async (spaceId) => {
      const definition = authority.workspaces.get(spaceId)!;
      expect(definition.sourceCommit).toBe(sourceCommit);
      if (definition.kind === 'base') return;
      expect(definition.lifecycle).toBe('provisioning');
      const checkout = database.getWorkspace(spaceId)!.rootPath;
      git(checkout, 'switch', '-c', 'local-work');
      git(checkout, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'local work');
    });
    try {
      const { project } = await manager.createProject({ name: 'Provenance', baseBranch: 'trunk', repositoryUrl: source });
      const { workspace } = await manager.createWorkspace({ projectId: project.id, name: 'Feature', branch: 'feature', sourceKind: 'branch', sourceRef: 'origin/trunk' });
      const placement = authority.spaces.get(workspace.id)!;
      authority.spaces.set(workspace.id, { ...placement, checkpointRevision: 1, publishedRevision: 1, manifestKey: 'provenance-checkpoint', manifestHash: `sha256:${'1'.repeat(64)}` });
      expect(git(workspace.rootPath, 'rev-parse', 'HEAD')).not.toBe(sourceCommit);
      expect(authority.workspaces.get(workspace.id)).toMatchObject({ sourceCommit, sourceKind: 'branch', sourceRef: 'origin/trunk', lifecycle: 'active' });
      expect(await manager.setWorkspacePhase(project.id, workspace.id, 'review')).toMatchObject({ phase: 'review', sourceCommit });
      expect(await manager.setWorkspaceLifecycle(project.id, workspace.id, 'archived')).toMatchObject({ lifecycle: 'archived', sourceCommit });
      expect(await manager.setWorkspaceLifecycle(project.id, workspace.id, 'active')).toMatchObject({ lifecycle: 'active', sourceCommit });
    } finally {
      database.close();
    }
  });

  it('creates Plan by default through RPC and code mode while preserving explicit phases and dependency ceilings', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-creation-phase-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));
    try {
      const { project } = await manager.createProject({ name: 'Phases', baseBranch: null, repositoryUrl: null });
      const namespace = createSpaceEvalNamespace(authority as unknown as CloudSpaceCheckpointAuthority, project.id, null, {
        create: (input) => manager.createWorkspace(input),
        manage: async () => { throw new Error('Unexpected management operation'); },
        instructionsChanged: async () => { throw new Error('Unexpected instruction change'); },
        refreshArtifacts: async () => { throw new Error('Unexpected artifact refresh'); },
        environment: async () => { throw new Error('Unexpected environment operation'); },
      });
      const schema = await namespace.call('describe', { method: 'create' }) as { required: string[]; properties: { phase: { default: string } } };
      expect(schema.required).not.toContain('phase');
      expect(schema.properties.phase.default).toBe('plan');
      let parentId = '';
      for (const path of ['rpc', 'code-mode']) {
        for (const phase of [undefined, 'code'] as const) {
          const name = `${path}-${phase ?? 'default'}`;
          const input = { name, branch: name, sourceKind: 'base' as const, sourceRef: 'main', ...(phase ? { phase } : {}) };
          let id: string;
          if (path === 'rpc') {
            const decoded = createWorkspaceContract._def.input.decode({ ...input, projectId: project.id });
            if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
            id = (await manager.createWorkspace(decoded.value)).workspace.id;
          } else {
            const created = await namespace.call('create', input) as { workspace: { id: string }; ready: boolean };
            expect(created.ready).toBe(true);
            id = created.workspace.id;
          }
          expect(database.getWorkspace(id)?.phase).toBe(phase ?? 'plan');
          expect(authority.workspaces.get(id)).toMatchObject({ phase: phase ?? 'plan', lifecycle: 'active' });
          if (!phase) parentId = id;
        }
      }
      const child = await manager.createWorkspace({ projectId: project.id, name: 'Child', branch: 'child', sourceKind: 'workspace', sourceRef: parentId });
      expect(child.workspace.phase).toBe('plan');
      expect(database.getSpaceRelations(child.workspace.id)).toMatchObject({ dependsOn: [parentId], stackedOn: parentId });
      const workspaceIds = [...authority.workspaces.keys()];
      await expect(manager.createWorkspace({ projectId: project.id, name: 'Ahead', branch: 'ahead', phase: 'code', sourceKind: 'workspace', sourceRef: parentId })).rejects.toThrow('ahead');
      await expect(manager.createWorkspace({ projectId: project.id, name: 'Missing', branch: 'missing', sourceKind: 'base', sourceRef: 'main', dependsOn: ['missing'] })).rejects.toThrow('does not exist');
      expect([...authority.workspaces.keys()]).toEqual(workspaceIds);
      expect(database.getBaseSpace(project.id)?.phase).toBeNull();
      expect(authority.workspaces.get(project.id)?.phase).toBeNull();
    } finally {
      database.close();
    }
  });

  it('materializes cloud-only source at the pinned release commit once, then creates normal workspaces', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-source-open-'));
    roots.push(root);
    const source = seedRepository(root, 'release/test');
    const commit = git(source, 'rev-parse', 'HEAD');
    writeFileSync(join(source, 'README.txt'), 'newer branch content\n');
    git(source, 'add', 'README.txt');
    git(source, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-m', 'advance branch');
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    authority.projects.set('source', {
      id: 'source', name: 'GitSpace', lifecycle: 'cloud-only', repositoryReference: source, baseBranch: 'release/test',
      role: 'gitspace-source', source: { release: commit, branch: 'release/test', commit },
      revision: 1, archivedAt: null, updatedAt: new Date(0).toISOString(),
    });
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));
    expect(database.getProject('source')).toBeNull();
    const [first, second] = await Promise.all([manager.openProject('source'), manager.openProject('source')]);
    expect(second.operation?.id).toBe(first.operation?.id);
    expect(first.project.lifecycle).toBe('active');
    const base = database.getBaseSpace('source')!;
    expect(git(base.rootPath, 'rev-parse', 'HEAD')).toBe(commit);
    expect(authority.workspaces.get('source')?.sourceCommit).toBe(commit);
    expect(git(base.rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('release/test');
    expect(git(base.rootPath, 'show', 'HEAD:README.txt')).toBe('imported');
    const workspace = await manager.createWorkspace({ projectId: 'source', name: 'Change', branch: 'change', phase: 'code', sourceKind: 'base', sourceRef: '' });
    expect(git(workspace.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(commit);
    expect((await manager.openProject('source')).operation).toBeNull();
    expect(authority.projects.size).toBe(1);
    database.close();
  });

  it('preserves a cloud-only definition and leaves no fake local repository after a failed source clone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-source-failed-'));
    roots.push(root);
    const source = seedRepository(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    authority.projects.set('source', {
      id: 'source', name: 'GitSpace', lifecycle: 'cloud-only', repositoryReference: join(root, 'missing-repository'), baseBranch: 'trunk',
      role: 'gitspace-source', source: { release: null, branch: 'trunk', commit: null },
      revision: 1, archivedAt: null, updatedAt: new Date(0).toISOString(),
    });
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));
    await expect(manager.openProject('source')).rejects.toThrow('git clone failed');
    expect(database.getProject('source')).toBeNull();
    expect(database.getBaseSpace('source')).toBeNull();
    expect(existsSync(join(root, 'spaces', 'source'))).toBe(false);
    expect(await authority.getProject('source')).toMatchObject({ lifecycle: 'cloud-only', role: 'gitspace-source' });
    expect(await authority.listProjectWorkspaces('source')).toEqual([]);
    authority.projects.set('source', { ...authority.projects.get('source')!, repositoryReference: source });
    expect((await manager.openProject('source')).project.lifecycle).toBe('active');
    database.close();
  });

  it('creates empty projects and sourced workspaces through durable operations, then permanently deletes archived state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-lifecycle-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));

    const created = await manager.createProject({ name: 'Example', baseBranch: null, repositoryUrl: null });
    expect(created.project).toMatchObject({ lifecycle: 'active', baseBranch: 'main' });
    expect(created.operation).toMatchObject({ state: 'succeeded', revision: 3 });
    expect(existsSync(database.getBaseSpace(created.project.id)!.rootPath)).toBe(true);

    const workspace = await manager.createWorkspace({ projectId: created.project.id, name: 'Feature', branch: 'feature/demo', phase: 'code', sourceKind: 'base', sourceRef: 'main' });
    expect(workspace.operation.state).toBe('succeeded');
    expect(database.getWorkspace(workspace.workspace.id)).toMatchObject({ holderId: 'machine-a', placementState: 'open' });
    expect(database.getSpaceRelations(workspace.workspace.id)).toEqual({ dependsOn: [], relatedTo: [], stackedOn: null });

    await expect(manager.createWorkspace({ projectId: created.project.id, name: 'Too far', branch: 'feature/too-far', phase: 'review', sourceKind: 'workspace', sourceRef: 'Feature' }))
      .rejects.toThrow('Phase review is ahead of Feature (code)');
    const sourcePath = workspace.workspace.rootPath;
    git(sourcePath, 'switch', '-c', 'actual-source-head');
    writeFileSync(join(sourcePath, 'work.txt'), 'committed source\n');
    git(sourcePath, 'add', 'work.txt');
    git(sourcePath, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-m', 'source work');
    const sourceHead = git(sourcePath, 'rev-parse', 'HEAD');
    writeFileSync(join(sourcePath, 'work.txt'), 'staged source\n');
    git(sourcePath, 'add', 'work.txt');
    writeFileSync(join(sourcePath, 'work.txt'), 'dirty source\n');
    writeFileSync(join(sourcePath, 'untracked.txt'), 'local only\n');
    const sourceIndex = readFileSync(join(sourcePath, '.git', 'index'));
    const sourceRefs = git(sourcePath, 'show-ref');
    const stacked = await manager.createWorkspace({ projectId: created.project.id, name: 'Stacked', branch: 'feature/stacked', phase: 'code', sourceKind: 'workspace', sourceRef: 'Feature' });
    expect(stacked.operation.state).toBe('succeeded');
    expect(database.getSpaceRelations(stacked.workspace.id)).toEqual({ dependsOn: [workspace.workspace.id], relatedTo: [], stackedOn: workspace.workspace.id });
    expect(git(stacked.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(sourceHead);
    expect(authority.workspaces.get(stacked.workspace.id)?.sourceCommit).toBe(sourceHead);
    expect(git(stacked.workspace.rootPath, 'show', 'HEAD:work.txt')).toBe('committed source');
    expect(existsSync(join(stacked.workspace.rootPath, 'untracked.txt'))).toBe(false);
    expect(git(sourcePath, 'symbolic-ref', '--short', 'HEAD')).toBe('actual-source-head');
    expect(git(sourcePath, 'show-ref')).toBe(sourceRefs);
    expect(readFileSync(join(sourcePath, '.git', 'index'))).toEqual(sourceIndex);
    expect(readFileSync(join(sourcePath, 'work.txt'), 'utf8')).toBe('dirty source\n');
    expect(readFileSync(join(sourcePath, 'untracked.txt'), 'utf8')).toBe('local only\n');
    const stackedLocal = database.getWorkspace(stacked.workspace.id)!;
    expect(database.releaseWorkspacePossession({ workspaceId: stackedLocal.id, holderId: 'machine-a', expectedGeneration: stackedLocal.generation }).status).toBe('ok');
    authority.spaces.set(stackedLocal.id, checkpointedPlacement(authority.spaces.get(stackedLocal.id)!));
    const stackedArchived = await manager.setWorkspaceLifecycle(created.project.id, stackedLocal.id, 'archived');
    expect(await manager.deleteWorkspace(created.project.id, stackedLocal.id, stackedArchived.revision)).toBe(true);

    const local = database.getWorkspace(workspace.workspace.id)!;
    expect(database.releaseWorkspacePossession({ workspaceId: local.id, holderId: 'machine-a', expectedGeneration: local.generation }).status).toBe('ok');
    authority.spaces.set(local.id, checkpointedPlacement(authority.spaces.get(local.id)!));
    const archived = await manager.setWorkspaceLifecycle(created.project.id, local.id, 'archived');
    expect(await manager.deleteWorkspace(created.project.id, local.id, archived.revision)).toBe(true);
    expect(database.getWorkspace(local.id)).toBeNull();

    const project = await manager.archiveProject(created.project.id, created.project.revision);
    expect(project.lifecycle).toBe('archived');
    expect(await manager.deleteProject(project.id, project.revision)).toBe(true);
    expect(database.getProject(project.id)).toBeNull();
    expect([...authority.operations.values()].map((operation) => operation.kind)).toEqual([
      'project.create',
      'workspace.create',
      'workspace.create',
      'workspace.delete',
      'workspace.delete',
      'project.archive',
      'project.delete',
    ]);
    database.close();
  });

  it('fetches uncached remote branch refs with repository credentials without changing the base', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-remote-'));
    roots.push(root);
    const source = seedRepository(root);
    const trunk = git(source, 'rev-parse', 'HEAD');
    git(source, 'switch', '-c', 'develop');
    writeFileSync(join(source, 'README.txt'), 'develop\n');
    git(source, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-am', 'develop');
    const develop = git(source, 'rev-parse', 'HEAD');
    git(source, 'switch', 'trunk');
    git(source, 'branch', 'release');
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const repositoryReference = 'https://git.example.invalid/team/repository.git';
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'), undefined, () => ({
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.${source}.insteadOf`, GIT_CONFIG_VALUE_0: repositoryReference,
    }));
    try {
      const { project } = await manager.createProject({ name: 'Remote', baseBranch: 'trunk', repositoryUrl: repositoryReference });
      const base = database.getBaseSpace(project.id)!;
      const refs = git(base.rootPath, 'show-ref');
      expect(refs).not.toContain('refs/remotes/origin/develop');
      writeFileSync(join(base.rootPath, 'README.txt'), 'do not disturb\n');
      const index = readFileSync(join(base.rootPath, '.git', 'index'));
      const [feature, release] = await Promise.all([
        manager.createWorkspace({ projectId: project.id, name: 'Develop', branch: 'feature', sourceKind: 'branch', sourceRef: 'origin/develop' }),
        manager.createWorkspace({ projectId: project.id, name: 'Release', branch: 'release-work', sourceKind: 'branch', sourceRef: 'refs/heads/release' }),
      ]);
      expect(git(feature.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(develop);
      expect(git(feature.workspace.rootPath, 'show', 'HEAD:README.txt')).toBe('develop');
      expect(git(feature.workspace.rootPath, 'merge-base', 'HEAD', trunk)).toBe(trunk);
      expect(git(release.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(trunk);
      expect(git(base.rootPath, 'show-ref')).toBe(refs);
      expect(git(base.rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
      expect(readFileSync(join(base.rootPath, '.git', 'index'))).toEqual(index);
      expect(readFileSync(join(base.rootPath, 'README.txt'), 'utf8')).toBe('do not disturb\n');
      expect(existsSync(join(base.rootPath, '.git', 'FETCH_HEAD'))).toBe(false);

      // Explicit remote sources do not require any base checkout or cached tracking refs.
      rmSync(base.rootPath, { recursive: true, force: true });
      const qualified = await manager.createWorkspace({ projectId: project.id, name: 'Qualified', branch: 'qualified', sourceKind: 'branch', sourceRef: 'refs/remotes/origin/develop' });
      expect(git(qualified.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(develop);
      expect(existsSync(base.rootPath)).toBe(false);
    } finally {
      database.close();
    }
  });

  it('keeps pull request, tag, commit, and local branch sources distinct during concurrent creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-refs-'));
    roots.push(root);
    const source = seedRepository(root);
    const original = git(source, 'rev-parse', 'HEAD');
    git(source, 'tag', 'v1');
    writeFileSync(join(source, 'README.txt'), 'pull request\n');
    git(source, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-am', 'pull request');
    const pullRequest = git(source, 'rev-parse', 'HEAD');
    git(source, 'update-ref', 'refs/pull/7/head', pullRequest);
    git(source, 'reset', '--hard', original);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));
    try {
      const { project } = await manager.createProject({ name: 'Refs', baseBranch: null, repositoryUrl: source });
      const base = database.getBaseSpace(project.id)!;
      writeFileSync(join(base.rootPath, 'README.txt'), 'local branch\n');
      git(base.rootPath, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-am', 'local branch');
      const local = git(base.rootPath, 'rev-parse', 'HEAD');
      const requests = [
        { sourceKind: 'pull-request' as const, sourceRef: '7', expected: pullRequest },
        { sourceKind: 'tag' as const, sourceRef: 'refs/tags/v1', expected: original },
        { sourceKind: 'commit' as const, sourceRef: original, expected: original },
        { sourceKind: 'branch' as const, sourceRef: 'trunk', expected: local },
      ];
      const results = await Promise.all(requests.map(({ sourceKind, sourceRef }) =>
        manager.createWorkspace({ projectId: project.id, name: sourceKind, branch: `test-${sourceKind}`, sourceKind, sourceRef })));
      for (const [index, result] of results.entries()) expect(git(result.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(requests[index]!.expected);
      expect(git(base.rootPath, 'rev-parse', 'HEAD')).toBe(local);
    } finally {
      database.close();
    }
  });

  it('uses canonical saved HEAD and relations after the source checkout and local catalog are gone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-checkpoint-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'original.db'));
    const targetDatabase = new GitSpaceDatabase(join(root, 'target.db'));
    const authority = new MemoryProjectAuthority();
    const originalManager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'original'));
    try {
      const { project } = await originalManager.createProject({ name: 'Canonical', baseBranch: null, repositoryUrl: null });
      const baseHead = git(database.getBaseSpace(project.id)!.rootPath, 'rev-parse', 'HEAD');
      const { workspace: source } = await originalManager.createWorkspace({ projectId: project.id, name: 'Saved source', branch: 'catalog-branch', sourceKind: 'base', sourceRef: '' });
      const { workspace: dependency } = await originalManager.createWorkspace({ projectId: project.id, name: 'Dependency', branch: 'dependency', phase: 'code', sourceKind: 'base', sourceRef: '' });
      git(source.rootPath, 'switch', '-c', 'actual-saved-branch');
      writeFileSync(join(source.rootPath, 'saved.txt'), 'committed source\n');
      git(source.rootPath, 'add', 'saved.txt');
      git(source.rootPath, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-m', 'saved source');
      writeFileSync(join(source.rootPath, 'saved.txt'), 'staged snapshot\n');
      git(source.rootPath, 'add', 'saved.txt');
      writeFileSync(join(source.rootPath, 'saved.txt'), 'dirty snapshot\n');
      writeFileSync(join(source.rootPath, 'untracked.txt'), 'not committed\n');
      const checkpoint = await createGitIntermediateCheckpoint({ repositoryPath: source.rootPath, spaceId: source.id, revision: 1 });
      const remote = join(root, 'checkpoints.git');
      git(root, 'init', '--bare', remote);
      git(source.rootPath, 'push', remote, `${checkpoint.checkpointRef}:${checkpoint.checkpointRef}`);
      const manifest = spaceCheckpointManifestSchema.parse({
        version: 1, projectId: project.id, spaceId: source.id, revision: 1, previousRevision: null, repository: checkpoint,
        agent: { sessionId: 'session-a', ompSessionId: 'omp-a', ompCheckpointHash: `sha256:${'1'.repeat(64)}` },
        artifacts: { manifestHash: `sha256:${'2'.repeat(64)}`, generation: 0 }, createdAt: new Date(0).toISOString(),
      });
      const bytes = new TextEncoder().encode(JSON.stringify(manifest));
      const manifestHash = `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}` as const;
      const manifestKey = spaceCheckpointManifestKey(project.id, source.id, 1);
      const placement = { ...authority.spaces.get(source.id)!, state: 'closed' as const, machineId: null, checkpointRevision: 1, publishedRevision: 1, manifestKey, manifestHash };
      authority.spaces.set(source.id, placement);
      await originalManager.setWorkspaceLifecycle(project.id, source.id, 'archived');
      rmSync(join(root, 'original'), { recursive: true, force: true });
      const resolver = createPublishedSpaceHeadResolver({
        authority,
        blobs: { async get(key, hash) { if (key !== manifestKey || hash !== manifestHash) throw new Error('Checkpoint identity mismatch'); return bytes; } },
        gitRemote: { async fetchCheckpoint(input) { git(input.repositoryPath, 'fetch', '--no-write-fetch-head', remote, `${input.checkpointRef}:${input.checkpointRef}`); } },
        binding: (projectId) => ({ projectId, bucket: 'test', endpoint: 'https://storage.invalid', region: 'auto' }),
      });
      const manager = new ProjectLifecycleManager(targetDatabase, authority, 'machine-b', join(root, 'target'), undefined, undefined, resolver);
      const before = [...authority.workspaces.keys()];
      await expect(manager.createWorkspace({ projectId: project.id, name: 'Too far', branch: 'too-far', phase: 'code', sourceKind: 'workspace', sourceRef: source.name })).rejects.toThrow('ahead');
      await expect(manager.createWorkspace({ projectId: project.id, name: 'Ahead of dependency', branch: 'ahead-dependency', phase: 'review', sourceKind: 'base', sourceRef: '', dependsOn: [dependency.id] })).rejects.toThrow('ahead');
      authority.spaces.set(source.id, { ...placement, manifestKey: null, manifestHash: null });
      await expect(manager.createWorkspace({ projectId: project.id, name: 'Unavailable', branch: 'unavailable', sourceKind: 'workspace', sourceRef: source.id })).rejects.toThrow('no published repository checkpoint');
      authority.spaces.set(source.id, placement);
      expect([...authority.workspaces.keys()]).toEqual(before);
      expect(targetDatabase.getProject(project.id)).toBeNull();

      const { workspace } = await manager.createWorkspace({ projectId: project.id, name: 'From saved', branch: 'from-saved', sourceKind: 'workspace', sourceRef: source.name, dependsOn: [dependency.id] });
      expect(git(workspace.rootPath, 'rev-parse', 'HEAD')).toBe(checkpoint.headCommit);
      expect(git(workspace.rootPath, 'merge-base', 'HEAD', baseHead)).toBe(baseHead);
      expect(readFileSync(join(workspace.rootPath, 'saved.txt'), 'utf8')).toBe('committed source\n');
      expect(existsSync(join(workspace.rootPath, 'untracked.txt'))).toBe(false);
      expect(targetDatabase.getSpaceRelations(workspace.id)).toEqual({ dependsOn: [dependency.id, source.id].sort(), relatedTo: [], stackedOn: source.id });
      expect(targetDatabase.getWorkspace(source.id)).toMatchObject({ holderId: 'unassigned', placementState: 'closed', phase: 'plan' });
      expect(targetDatabase.getWorkspace(source.id)?.closedAt).not.toBeNull();
      expect(existsSync(targetDatabase.getWorkspace(source.id)!.rootPath)).toBe(false);
      expect(existsSync(source.rootPath)).toBe(false);
      expect(authority.spaces.get(source.id)).toEqual(placement);

      // A still-present but stale local checkout held elsewhere must also use the published head.
      const projected = targetDatabase.getWorkspace(source.id)!;
      mkdirSync(projected.rootPath, { recursive: true });
      git(projected.rootPath, 'init', '-b', 'unpublished');
      git(projected.rootPath, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'unrelated local checkout');
      const staleHead = git(projected.rootPath, 'rev-parse', 'HEAD');
      targetDatabase.possessWorkspace(source.id, 'machine-b');
      const elsewhere = { ...placement, state: 'open' as const, machineId: 'machine-c' };
      authority.spaces.set(source.id, elsewhere);
      const other = await manager.createWorkspace({ projectId: project.id, name: 'From elsewhere', branch: 'from-elsewhere', sourceKind: 'workspace', sourceRef: source.id });
      expect(git(other.workspace.rootPath, 'rev-parse', 'HEAD')).toBe(checkpoint.headCommit);
      expect(git(projected.rootPath, 'rev-parse', 'HEAD')).toBe(staleHead);
      expect(authority.spaces.get(source.id)).toEqual(elsewhere);
    } finally {
      database.close();
      targetDatabase.close();
    }
  });

  it('does not publish workspace ghosts for invalid Git sources or destination branches', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-workspace-invalid-'));
    roots.push(root);
    const source = seedRepository(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const managedRoot = join(root, 'spaces');
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', managedRoot);
    try {
      const { project } = await manager.createProject({ name: 'Valid', baseBranch: null, repositoryUrl: source });
      const before = [...authority.workspaces.keys()];
      const operations = [...authority.operations.keys()];
      const invalid = [
        { sourceKind: 'branch' as const, sourceRef: 'origin/missing', branch: 'missing-remote' },
        { sourceKind: 'base' as const, sourceRef: '', branch: 'bad..branch' },
        { sourceKind: 'workspace' as const, sourceRef: 'missing', branch: 'missing-workspace' },
        { sourceKind: 'commit' as const, sourceRef: 'f'.repeat(40), branch: 'missing-commit' },
        { sourceKind: 'pull-request' as const, sourceRef: '../main', branch: 'invalid-pr' },
      ];
      for (const input of invalid) await expect(manager.createWorkspace({ ...input, projectId: project.id, name: input.branch })).rejects.toThrow();
      expect([...authority.workspaces.keys()]).toEqual(before);
      expect([...authority.operations.keys()]).toEqual(operations);
      expect(database.listWorkspaces(project.id)).toEqual([]);
      expect(readdirSync(join(managedRoot, project.id))).toEqual(['base']);
    } finally {
      database.close();
    }
  });

  it('imports the remote default branch when it is not main', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-import-'));
    roots.push(root);
    const source = seedRepository(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));

    const imported = await manager.createProject({ name: 'Imported', baseBranch: null, repositoryUrl: source });
    expect(imported.project).toMatchObject({ lifecycle: 'active', repositoryReference: source, baseBranch: 'trunk' });
    const base = database.getBaseSpace(imported.project.id)!;
    expect(database.getProject(imported.project.id)?.baseBranch).toBe('trunk');
    expect((await authority.listProjectWorkspaces(imported.project.id))[0]?.branch).toBe('trunk');
    expect(git(base.rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('trunk');
    expect(git(base.rootPath, 'show', 'HEAD:README.txt')).toBe('imported');
    database.close();
  });

  it('preserves an explicit imported branch override', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-branch-'));
    roots.push(root);
    const source = seedRepository(root);
    git(source, 'checkout', '-b', 'release');
    writeFileSync(join(source, 'README.txt'), 'release\n');
    git(source, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-am', 'release');
    git(source, 'checkout', 'trunk');
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));

    const imported = await manager.createProject({ name: 'Release', baseBranch: 'release', repositoryUrl: source });
    const base = database.getBaseSpace(imported.project.id)!;
    expect(imported.project.baseBranch).toBe('release');
    expect(git(base.rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('release');
    expect(git(base.rootPath, 'show', 'HEAD:README.txt')).toBe('release');
    database.close();
  });

  it('leaves no published project or local folder after clone failure and preserves unrelated work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-clone-failure-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const managedRoot = join(root, 'spaces');
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', managedRoot);
    const existing = await manager.createProject({ name: 'Keep', baseBranch: null, repositoryUrl: null });
    const existingPath = database.getBaseSpace(existing.project.id)!.rootPath;
    writeFileSync(join(existingPath, 'keep.txt'), 'uncommitted user work');

    await expect(manager.createProject({ name: 'Broken', baseBranch: null, repositoryUrl: join(root, 'missing-repository') })).rejects.toThrow();
    expect((await manager.list('all')).map((project) => project.id)).toEqual([existing.project.id]);
    expect(database.listProjects().map((project) => project.id)).toEqual([existing.project.id]);
    expect(readdirSync(managedRoot)).toEqual([existing.project.id]);
    expect(await Bun.file(join(existingPath, 'keep.txt')).text()).toBe('uncommitted user work');
    expect([...authority.operations.values()]).toEqual([existing.operation]);
    database.close();
  });

  it.each([
    '--upload-pack=unexpected-command',
    'ext::unexpected-command',
    'https://github.com/owner/repo/tree/main',
    'https://github.com/owner/repo/blob/main/file.ts',
    'owner/repo/tree/main',
    'https://token@github.com/owner/repo',
  ])('rejects malformed repository address %s before publication', async (repositoryUrl) => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-address-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const managedRoot = join(root, 'spaces');
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', managedRoot);

    await expect(manager.createProject({ name: 'Invalid', baseBranch: null, repositoryUrl })).rejects.toThrow();
    expect(await manager.list('all')).toEqual([]);
    expect(database.listProjects()).toEqual([]);
    expect(existsSync(managedRoot)).toBe(false);
    database.close();
  });

  it.each([
    ['https://github.com/owner/repo', 'https://github.com/owner/repo.git'],
    ['https://github.com/owner/repo.git', 'https://github.com/owner/repo.git'],
    ['owner/repo', 'https://github.com/owner/repo.git'],
    ['git@github.com:owner/repo.git', 'git@github.com:owner/repo.git'],
    ['ssh://git@git.example.com/team/repo.git', 'ssh://git@git.example.com/team/repo.git'],
    ['https://git.example.com/team/repo.git', 'https://git.example.com/team/repo.git'],
  ])('imports normalized repository address %s through repository-scoped Git settings', async (repositoryUrl, repositoryReference) => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-normalized-'));
    roots.push(root);
    const source = seedRepository(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'), undefined, () => ({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${source}.insteadOf`,
      GIT_CONFIG_VALUE_0: repositoryReference,
    }));

    const imported = await manager.createProject({ name: 'Normalized', baseBranch: null, repositoryUrl });
    expect(imported.project.repositoryReference).toBe(repositoryReference);
    expect(database.getProject(imported.project.id)?.repositoryReference).toBe(repositoryReference);
    expect(git(database.getBaseSpace(imported.project.id)!.rootPath, 'show', 'HEAD:README.txt')).toBe('imported');
    database.close();
  });

  it('rolls back local and canonical provisioning while retaining a failed operation', async () => {
    class FailingInspectorAuthority extends MemoryProjectAuthority {
      override async bootstrapInspector(_input: { projectId: string; spaceId: string }): Promise<never> {
        throw new Error('Inspector unavailable');
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-projection-failure-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new FailingInspectorAuthority();
    const managedRoot = join(root, 'spaces');
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', managedRoot);

    await expect(manager.createProject({ name: 'Partial', baseBranch: null, repositoryUrl: null })).rejects.toThrow('Inspector unavailable');
    expect(await manager.list('all')).toEqual([]);
    expect(database.listProjects()).toEqual([]);
    expect(readdirSync(managedRoot)).toEqual([]);
    const operation = [...authority.operations.values()][0]!;
    expect(operation).toMatchObject({ state: 'failed', kind: 'project.create' });
    expect(database.getBaseSpace(operation.projectId)).toBeNull();
    expect(await authority.listProjectWorkspaces(operation.projectId)).toEqual([]);
    expect((await authority.getProject(operation.projectId))?.lifecycle).toBe('deleting');
    database.close();
  });

  it('compensates a bootstrap that committed before its response failed', async () => {
    class FailedBootstrapResponseAuthority extends MemoryProjectAuthority {
      override async bootstrapProject(input: Parameters<MemoryProjectAuthority['bootstrapProject']>[0]): Promise<never> {
        await super.bootstrapProject(input);
        throw new Error('Bootstrap response lost');
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-bootstrap-failure-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new FailedBootstrapResponseAuthority();
    const managedRoot = join(root, 'spaces');
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', managedRoot);

    await expect(manager.createProject({ name: 'Partial', baseBranch: null, repositoryUrl: null })).rejects.toThrow('Bootstrap response lost');
    expect(await manager.list('all')).toEqual([]);
    expect(database.listProjects()).toEqual([]);
    expect(readdirSync(managedRoot)).toEqual([]);
    database.close();
  });

  it('preserves an activated project if its activation response is lost', async () => {
    class FailedActivationResponseAuthority extends MemoryProjectAuthority {
      override async setProjectLifecycle(projectId: string, expectedRevision: number, lifecycle: CloudProjectSummary['lifecycle']) {
        const project = await super.setProjectLifecycle(projectId, expectedRevision, lifecycle);
        if (lifecycle === 'active') throw new Error('Activation response lost');
        return project;
      }
    }
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-activation-failure-'));
    roots.push(root);
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new FailedActivationResponseAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));

    await expect(manager.createProject({ name: 'Activated', baseBranch: null, repositoryUrl: null })).rejects.toThrow('Activation response lost');
    const project = (await manager.list('active'))[0]!;
    expect(project.lifecycle).toBe('active');
    const base = database.getBaseSpace(project.id)!;
    expect(git(base.rootPath, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect([...authority.operations.values()][0]?.state).toBe('failed');
    database.close();
  });
});
