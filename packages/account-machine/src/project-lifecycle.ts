import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { phaseCeilingViolation, type GitSpaceDatabase, type Workspace } from '@gitspace/core';
import type {
  CloudProjectOperation,
  CloudProjectSummary,
  CloudWorkspaceDefinition,
} from '@gitspace/protocol';

export interface ProjectLifecycleAuthority {
  bootstrap(input: { projectId: string; spaceId: string }): Promise<unknown>;
  bootstrapInspector(input: { projectId: string; spaceId: string }): Promise<unknown>;
  listProjects(lifecycle?: 'active' | 'archived'): Promise<CloudProjectSummary[]>;
  bootstrapProject(input: { projectId: string; name: string; repositoryReference: string | null; baseBranch: string }): Promise<CloudProjectSummary>;
  getProject(projectId: string): Promise<CloudProjectSummary | null>;
  setProjectLifecycle(projectId: string, expectedRevision: number, lifecycle: CloudProjectSummary['lifecycle']): Promise<CloudProjectSummary>;
  deleteProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary>;
  listProjectWorkspaces(projectId: string): Promise<CloudWorkspaceDefinition[]>;
  putProjectWorkspace(projectId: string, workspace: Omit<CloudWorkspaceDefinition, 'revision' | 'createdAt' | 'updatedAt' | 'archivedAt'> & { expectedRevision: number }): Promise<CloudWorkspaceDefinition>;
  removeProjectWorkspace(projectId: string, workspaceId: string, expectedRevision: number): Promise<boolean>;
  createProjectOperation(projectId: string, operation: { projectId: string; workspaceId: string | null; kind: string; targetMachines: string[]; steps: Array<{ id: string; label: string }>; createdBy: string }): Promise<CloudProjectOperation>;
  updateProjectOperation(projectId: string, operation: { id: string; expectedRevision: number; state: CloudProjectOperation['state']; steps: CloudProjectOperation['steps']; error: string | null }): Promise<CloudProjectOperation>;
}

export interface CreateProjectInput {
  name: string;
  baseBranch: string;
  repositoryUrl: string | null;
}

export interface CreateWorkspaceInput {
  projectId: string;
  name: string;
  branch: string;
  phase: Workspace['phase'];
  sourceKind: CloudWorkspaceDefinition['sourceKind'];
  sourceRef: string;
  /** Extra dependencies; a `workspace` source is always also a dependency and becomes `stackedOn`. */
  dependsOn?: readonly string[];
}

function resourceId(name: string): string {
  const label = name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 48) || 'space';
  return `${label}-${crypto.randomUUID().slice(0, 8)}`;
}

async function runGit(args: string[], cwd?: string): Promise<void> {
  const process = Bun.spawn(['git', ...args], { ...(cwd ? { cwd } : {}), stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `git ${args.join(' ')} exited with ${exitCode}`);
}

export class ProjectLifecycleManager {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly authority: ProjectLifecycleAuthority,
    private readonly machineId: string,
    private readonly managedRoot: string,
    private readonly checkpointSpace?: (spaceId: string) => Promise<void>,
  ) {}

  list(lifecycle: 'all' | 'active' | 'archived'): Promise<CloudProjectSummary[]> {
    return this.authority.listProjects(lifecycle === 'all' ? undefined : lifecycle);
  }

  async createProject(input: CreateProjectInput): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation }> {
    const projectId = resourceId(input.name);
    let project = await this.authority.bootstrapProject({
      projectId,
      name: input.name,
      repositoryReference: input.repositoryUrl,
      baseBranch: input.baseBranch,
    });
    let operation = await this.authority.createProjectOperation(projectId, {
      projectId,
      workspaceId: null,
      kind: input.repositoryUrl ? 'project.import' : 'project.create',
      targetMachines: [this.machineId],
      steps: [{ id: 'repository', label: input.repositoryUrl ? 'Clone repository' : 'Initialize repository' }, { id: 'projection', label: 'Create local projection' }],
      createdBy: this.machineId,
    });
    operation = await this.running(projectId, operation);
    const repositoryPath = join(this.managedRoot, projectId, 'base');
    try {
      await mkdir(join(this.managedRoot, projectId), { recursive: true });
      if (input.repositoryUrl) {
        await runGit(['clone', '--branch', input.baseBranch, '--single-branch', input.repositoryUrl, repositoryPath]);
      } else {
        await mkdir(repositoryPath, { recursive: true });
        await runGit(['init', '-b', input.baseBranch], repositoryPath);
        await runGit(['-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'Initialize GitSpace project'], repositoryPath);
      }
      const created = this.database.createProject({
        id: projectId,
        name: input.name,
        repositoryPath,
        baseBranch: input.baseBranch,
        ...(input.repositoryUrl ? { repositoryReference: input.repositoryUrl } : {}),
      });
      if (created.status === 'error') throw created.error;
      const possessed = this.database.possessSpace(projectId, this.machineId, repositoryPath);
      if (possessed.status === 'error') throw possessed.error;
      await this.authority.putProjectWorkspace(projectId, {
        id: projectId,
        projectId,
        kind: 'base',
        name: input.name,
        branch: input.baseBranch,
        phase: null,
        sourceKind: 'base',
        sourceRef: input.baseBranch,
        lifecycle: 'active',
        goalId: null,
        expectedRevision: 0,
      });
      await this.authority.bootstrap({ projectId, spaceId: projectId });
      await this.authority.bootstrapInspector({ projectId, spaceId: projectId });
      await this.checkpointSpace?.(projectId);
      project = await this.authority.setProjectLifecycle(projectId, project.revision, 'active');
      operation = await this.succeeded(projectId, operation);
      return { project, operation };
    } catch (error) {
      await rm(join(this.managedRoot, projectId), { recursive: true, force: true });
      await this.failed(projectId, operation, error);
      if (project.lifecycle === 'provisioning') await this.authority.setProjectLifecycle(projectId, project.revision, 'failed').catch(() => undefined);
      throw error;
    }
  }

  async createWorkspace(input: CreateWorkspaceInput): Promise<{ workspace: Workspace; operation: CloudProjectOperation }> {
    const project = this.database.getProject(input.projectId);
    const cloudProject = await this.authority.getProject(input.projectId);
    if (!project || !cloudProject || cloudProject.lifecycle !== 'active') throw new Error(`Project ${input.projectId} is not active`);
    const workspaces = this.database.listWorkspaces(input.projectId);
    const sourceWorkspace = input.sourceKind === 'workspace'
      ? workspaces.find((candidate) => candidate.id === input.sourceRef) ?? workspaces.find((candidate) => candidate.name === input.sourceRef) ?? null
      : null;
    if (input.sourceKind === 'workspace' && !sourceWorkspace) throw new Error(`Source workspace ${input.sourceRef} does not exist`);
    const dependencies = [...(sourceWorkspace ? [sourceWorkspace.id] : []), ...(input.dependsOn ?? [])].map((id) => {
      const dependency = workspaces.find((candidate) => candidate.id === id);
      if (!dependency) throw new Error(`Dependency workspace ${id} does not exist in project ${input.projectId}`);
      return dependency;
    });
    const ceiling = phaseCeilingViolation(input.phase, dependencies);
    if (ceiling) throw new Error(`Phase ${input.phase} is ahead of ${ceiling.name} (${ceiling.phase}); a workspace cannot pass the phase of what it depends on`);
    const workspaceId = resourceId(input.name);
    const rootPath = join(this.managedRoot, input.projectId, workspaceId);
    let definition = await this.authority.putProjectWorkspace(input.projectId, {
      id: workspaceId,
      projectId: input.projectId,
      kind: 'worktree',
      name: input.name,
      branch: input.branch,
      phase: input.phase,
      sourceKind: input.sourceKind,
      sourceRef: input.sourceRef,
      lifecycle: 'provisioning',
      goalId: null,
      expectedRevision: 0,
    });
    let operation = await this.authority.createProjectOperation(input.projectId, {
      projectId: input.projectId,
      workspaceId,
      kind: 'workspace.create',
      targetMachines: [this.machineId],
      steps: [{ id: 'source', label: 'Resolve source' }, { id: 'worktree', label: 'Create worktree' }, { id: 'projection', label: 'Create local projection' }],
      createdBy: this.machineId,
    });
    operation = await this.running(input.projectId, operation);
    try {
      const base = this.database.getBaseSpace(input.projectId);
      if (!base) throw new Error(`Project ${input.projectId} has no base repository`);
      let sourceRef = input.sourceRef || project.baseBranch;
      if (input.sourceKind === 'base') sourceRef = project.baseBranch;
      if (sourceWorkspace) sourceRef = sourceWorkspace.branch;
      if (input.sourceKind === 'pull-request') {
        await runGit(['fetch', 'origin', `pull/${input.sourceRef}/head`], base.rootPath);
        sourceRef = 'FETCH_HEAD';
      }
      await mkdir(join(this.managedRoot, input.projectId), { recursive: true });
      try {
        await runGit(['worktree', 'add', '-b', input.branch, rootPath, sourceRef], base.rootPath);
      } catch (error) {
        if (input.sourceKind !== 'branch' || input.branch !== sourceRef) throw error;
        await runGit(['worktree', 'add', rootPath, input.branch], base.rootPath);
      }
      const created = this.database.createWorkspace({ id: workspaceId, projectId: input.projectId, name: input.name, branch: input.branch, phase: input.phase, rootPath });
      if (created.status === 'error') throw created.error;
      if (dependencies.length > 0) {
        const related = this.database.setSpaceRelations(workspaceId, { dependsOn: dependencies.map((dependency) => dependency.id), relatedTo: [], stackedOn: sourceWorkspace?.id ?? null });
        if (related.status === 'error') throw related.error;
      }
      const possessed = this.database.possessWorkspace(workspaceId, this.machineId);
      if (possessed.status === 'error') throw possessed.error;
      await this.authority.bootstrap({ projectId: input.projectId, spaceId: workspaceId });
      await this.authority.bootstrapInspector({ projectId: input.projectId, spaceId: workspaceId });
      await this.checkpointSpace?.(workspaceId);
      definition = await this.authority.putProjectWorkspace(input.projectId, {
        id: definition.id,
        projectId: definition.projectId,
        kind: definition.kind,
        name: definition.name,
        branch: definition.branch,
        phase: definition.phase,
        sourceKind: definition.sourceKind,
        sourceRef: definition.sourceRef,
        lifecycle: 'active',
        goalId: definition.goalId,
        expectedRevision: definition.revision,
      });
      operation = await this.succeeded(input.projectId, operation);
      return { workspace: this.database.getWorkspace(workspaceId)!, operation };
    } catch (error) {
      await rm(rootPath, { recursive: true, force: true });
      await this.failed(input.projectId, operation, error);
      await this.authority.putProjectWorkspace(input.projectId, {
        id: definition.id,
        projectId: definition.projectId,
        kind: definition.kind,
        name: definition.name,
        branch: definition.branch,
        phase: definition.phase,
        sourceKind: definition.sourceKind,
        sourceRef: definition.sourceRef,
        lifecycle: 'failed',
        goalId: definition.goalId,
        expectedRevision: definition.revision,
      }).catch(() => undefined);
      throw error;
    }
  }

  archiveProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
    return this.runLifecycleOperation(projectId, null, 'project.archive', ['Archive project'], async () => {
      const activeWorkspace = this.database.listWorkspaces(projectId).find((workspace) => workspace.placementState !== 'closed');
      if (activeWorkspace) throw new Error(`Workspace ${activeWorkspace.id} must be archived before archiving the project`);
      const current = await this.authority.setProjectLifecycle(projectId, expectedRevision, 'archiving');
      return this.authority.setProjectLifecycle(projectId, current.revision, 'archived');
    });
  }

  restoreProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
    return this.runLifecycleOperation(projectId, null, 'project.restore', ['Restore project'], async () => {
      const current = await this.authority.setProjectLifecycle(projectId, expectedRevision, 'restoring');
      return this.authority.setProjectLifecycle(projectId, current.revision, 'active');
    });
  }

  deleteWorkspace(projectId: string, workspaceId: string, expectedRevision?: number): Promise<boolean> {
    return this.runLifecycleOperation(projectId, workspaceId, 'workspace.delete', ['Remove worktree', 'Delete workspace authority'], async () => {
      const workspace = this.database.getWorkspace(workspaceId);
      if (workspace && workspace.placementState !== 'closed') throw new Error('Workspace must be archived before permanent deletion');
      if (workspace) {
        const base = this.database.getBaseSpace(projectId);
        if (base) await runGit(['worktree', 'remove', '--force', workspace.rootPath], base.rootPath).catch(() => undefined);
        await rm(workspace.rootPath, { recursive: true, force: true });
        this.database.deleteWorkspace(workspaceId);
      }
      const definition = (await this.authority.listProjectWorkspaces(projectId)).find((candidate) => candidate.id === workspaceId);
      if (!definition) return false;
      return this.authority.removeProjectWorkspace(projectId, workspaceId, expectedRevision ?? definition.revision);
    });
  }

  deleteProject(projectId: string, expectedRevision: number): Promise<boolean> {
    return this.runLifecycleOperation(projectId, null, 'project.delete', ['Delete project authority', 'Remove local projection'], async () => {
      const project = await this.authority.getProject(projectId);
      if (!project) return false;
      if (project.lifecycle !== 'archived') throw new Error('Project must be archived before permanent deletion');
      const open = this.database.listWorkspaces(projectId).find((workspace) => workspace.placementState !== 'closed');
      if (open) throw new Error(`Workspace ${open.id} must be archived before deleting the project`);
      await this.authority.deleteProject(projectId, expectedRevision);
      const local = this.database.getBaseSpace(projectId);
      if (local) await rm(join(this.managedRoot, projectId), { recursive: true, force: true });
      this.database.deleteProject(projectId);
      return true;
    });
  }

  async setWorkspaceLifecycle(
    projectId: string,
    workspaceId: string,
    lifecycle: CloudWorkspaceDefinition['lifecycle'],
  ): Promise<CloudWorkspaceDefinition> {
    const current = (await this.authority.listProjectWorkspaces(projectId)).find((workspace) => workspace.id === workspaceId);
    if (!current) throw new Error(`Workspace ${workspaceId} does not exist in project authority`);
    return this.authority.putProjectWorkspace(projectId, {
      id: current.id,
      projectId: current.projectId,
      kind: current.kind,
      name: current.name,
      branch: current.branch,
      phase: current.phase,
      sourceKind: current.sourceKind,
      sourceRef: current.sourceRef,
      lifecycle,
      goalId: current.goalId,
      expectedRevision: current.revision,
    });
  }

  async setWorkspacePhase(projectId: string, workspaceId: string, phase: Workspace['phase']): Promise<CloudWorkspaceDefinition> {
    const current = (await this.authority.listProjectWorkspaces(projectId)).find((workspace) => workspace.id === workspaceId);
    if (!current) throw new Error(`Workspace ${workspaceId} does not exist in project authority`);
    return this.authority.putProjectWorkspace(projectId, {
      id: current.id,
      projectId: current.projectId,
      kind: current.kind,
      name: current.name,
      branch: current.branch,
      phase,
      sourceKind: current.sourceKind,
      sourceRef: current.sourceRef,
      lifecycle: current.lifecycle,
      goalId: current.goalId,
      expectedRevision: current.revision,
    });
  }

  async runLifecycleOperation<T>(
    projectId: string,
    workspaceId: string | null,
    kind: string,
    labels: string[],
    action: () => Promise<T>,
  ): Promise<T> {
    let operation = await this.authority.createProjectOperation(projectId, {
      projectId,
      workspaceId,
      kind,
      targetMachines: [this.machineId],
      steps: labels.map((label, index) => ({ id: `step-${index + 1}`, label })),
      createdBy: this.machineId,
    });
    operation = await this.running(projectId, operation);
    try {
      const value = await action();
      await this.succeeded(projectId, operation);
      return value;
    } catch (error) {
      await this.failed(projectId, operation, error);
      throw error;
    }
  }

  private async running(projectId: string, operation: CloudProjectOperation): Promise<CloudProjectOperation> {
    return this.authority.updateProjectOperation(projectId, {
      id: operation.id,
      expectedRevision: operation.revision,
      state: 'running',
      steps: operation.steps.map((step) => ({ ...step, state: 'running', updatedAt: new Date().toISOString() })),
      error: null,
    });
  }

  private async succeeded(projectId: string, operation: CloudProjectOperation): Promise<CloudProjectOperation> {
    return this.authority.updateProjectOperation(projectId, {
      id: operation.id,
      expectedRevision: operation.revision,
      state: 'succeeded',
      steps: operation.steps.map((step) => ({ ...step, state: 'succeeded', updatedAt: new Date().toISOString() })),
      error: null,
    });
  }

  private async failed(projectId: string, operation: CloudProjectOperation, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.authority.updateProjectOperation(projectId, {
      id: operation.id,
      expectedRevision: operation.revision,
      state: 'failed',
      steps: operation.steps.map((step) => ({ ...step, state: 'failed', message, updatedAt: new Date().toISOString() })),
      error: message,
    }).catch(() => undefined);
  }
}
