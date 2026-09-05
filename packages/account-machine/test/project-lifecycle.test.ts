import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import type { CloudProjectOperation, CloudProjectSummary, CloudWorkspaceDefinition } from '@gitspace/protocol';
import { ProjectLifecycleManager, type ProjectLifecycleAuthority } from '../src/project-lifecycle.js';

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
  readonly spaces = new Map<string, { projectId: string; spaceId: string }>();
  readonly inspectors = new Map<string, { projectId: string; spaceId: string }>();

  async bootstrap(input: { projectId: string; spaceId: string }) {
    this.spaces.set(input.spaceId, input);
    return input;
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
    const project: CloudProjectSummary = { id: input.projectId, name: input.name, lifecycle: 'provisioning', repositoryReference: input.repositoryReference, baseBranch: input.baseBranch, revision: 1, archivedAt: null, updatedAt: now };
    this.projects.set(project.id, project);
    return project;
  }

  async getProject(projectId: string) { return this.projects.get(projectId) ?? null; }

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

describe('ProjectLifecycleManager', () => {
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
    const stacked = await manager.createWorkspace({ projectId: created.project.id, name: 'Stacked', branch: 'feature/stacked', phase: 'code', sourceKind: 'workspace', sourceRef: 'Feature' });
    expect(stacked.operation.state).toBe('succeeded');
    expect(database.getSpaceRelations(stacked.workspace.id)).toEqual({ dependsOn: [workspace.workspace.id], relatedTo: [], stackedOn: workspace.workspace.id });
    const stackedLocal = database.getWorkspace(stacked.workspace.id)!;
    expect(database.releaseWorkspacePossession({ workspaceId: stackedLocal.id, holderId: 'machine-a', expectedGeneration: stackedLocal.generation }).status).toBe('ok');
    const stackedArchived = await manager.setWorkspaceLifecycle(created.project.id, stackedLocal.id, 'archived');
    expect(await manager.deleteWorkspace(created.project.id, stackedLocal.id, stackedArchived.revision)).toBe(true);

    const local = database.getWorkspace(workspace.workspace.id)!;
    expect(database.releaseWorkspacePossession({ workspaceId: local.id, holderId: 'machine-a', expectedGeneration: local.generation }).status).toBe('ok');
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
