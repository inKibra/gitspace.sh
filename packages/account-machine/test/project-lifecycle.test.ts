import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GitSpaceDatabase } from '@gitspace/core';
import type { CloudProjectOperation, CloudProjectSummary, CloudWorkspaceDefinition } from '@gitspace/protocol';
import { ProjectLifecycleManager, type ProjectLifecycleAuthority } from '../src/project-lifecycle.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'ignore', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
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
    return [...this.projects.values()].filter((project) => !lifecycle || (lifecycle === 'archived' ? project.lifecycle === 'archived' : project.lifecycle !== 'archived'));
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

    const created = await manager.createProject({ name: 'Example', baseBranch: 'main', repositoryUrl: null });
    expect(created.project.lifecycle).toBe('active');
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

  it('imports an existing repository into the managed project projection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gitspace-project-import-'));
    roots.push(root);
    const source = join(root, 'source');
    mkdirSync(source);
    git(source, 'init', '-b', 'main');
    writeFileSync(join(source, 'README.txt'), 'imported\n');
    git(source, 'add', 'README.txt');
    git(source, '-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '-m', 'seed');
    const database = new GitSpaceDatabase(join(root, 'gitspace.db'));
    const authority = new MemoryProjectAuthority();
    const manager = new ProjectLifecycleManager(database, authority, 'machine-a', join(root, 'spaces'));

    const imported = await manager.createProject({ name: 'Imported', baseBranch: 'main', repositoryUrl: source });
    expect(imported.project).toMatchObject({ lifecycle: 'active', repositoryReference: source });
    expect(existsSync(join(database.getBaseSpace(imported.project.id)!.rootPath, 'README.txt'))).toBe(true);
    database.close();
  });
});
