import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
  baseBranch: string | null;
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

function normalizeRepositoryUrl(input: string): string {
  const address = input.trim();
  if (!address || address.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(address)) {
    throw new Error('Enter a repository root HTTPS/SSH URL or GitHub owner/repo, not a Git option.');
  }
  // Keep explicit local paths usable for local imports; bare owner/repo is GitHub shorthand.
  if (isAbsolute(address) || address.startsWith('./') || address.startsWith('../')) return address;
  if (/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+\/?$/iu.test(address)) {
    return normalizeRepositoryUrl(`https://github.com/${address}`);
  }
  const scp = /^(?:[a-z0-9_.-]+@)?([a-z0-9][a-z0-9.-]*):([^:].*)$/iu.exec(address);
  if (scp && !address.includes('://')) {
    normalizeRepositoryUrl(`ssh://${address.slice(0, address.indexOf(':'))}/${scp[2]!.replace(/^\/+/u, '')}`);
    return address;
  }
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error('Enter a repository root HTTPS/SSH URL or GitHub owner/repo.');
  }
  if (!['https:', 'http:', 'ssh:'].includes(url.protocol) || !url.hostname || url.hostname.startsWith('-') || /\s/u.test(address)) {
    throw new Error('Use a repository HTTPS/SSH URL, an explicit local path, or GitHub owner/repo.');
  }
  if (url.password || (url.protocol !== 'ssh:' && url.username)) {
    throw new Error('Do not include credentials in the repository URL. Use the account SSH key instead.');
  }
  if (url.search || url.hash) {
    throw new Error('Use the repository root URL without a query or fragment, not a file or branch page.');
  }
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replace(/\/+$/u, '');
  } catch {
    throw new Error('The repository URL contains an invalid path.');
  }
  if (!path || /[\u0000-\u001f\u007f]/u.test(path) || /^\/[^/]+\/[^/]+\/(?:-\/)?(?:tree|blob|raw)(?:\/|$)/u.test(path)) {
    throw new Error('Use the repository root URL, not a file or branch page.');
  }
  if (url.hostname === 'github.com' || url.hostname === 'www.github.com') {
    if (!/^\/[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/iu.test(path) || /\/(?:\.|\.\.)(?:\.git)?$/u.test(path)) {
      throw new Error('Use the GitHub repository root URL: https://github.com/owner/repo, not a file or branch page.');
    }
    url.hostname = 'github.com';
    if (url.protocol !== 'ssh:') url.pathname = `${path.replace(/\.git$/u, '')}.git`;
  } else {
    url.pathname = url.pathname.replace(/\/+$/u, '');
  }
  return url.toString();
}

async function runGit(args: string[], cwd?: string, environment: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    ...(cwd ? { cwd } : {}),
    env: {
      ...process.env,
      ...environment,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      SSH_ASKPASS_REQUIRE: 'never',
      GIT_SSH_COMMAND: `${environment.GIT_SSH_COMMAND ?? process.env.GIT_SSH_COMMAND ?? 'ssh'} -o BatchMode=yes`,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    // Credential helpers and servers can echo secrets supplied through the environment.
    const detail = /Permission denied \(publickey\)/iu.test(stderr)
      ? 'SSH authentication failed. Add the public key from Settings → Git to a GitHub account that can access this repository.'
      : /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/iu.test(stderr)
        ? 'SSH host verification failed. Check the repository host and its trusted host key; host verification has not been disabled.'
        : /Repository not found|repository .* does not exist/iu.test(stderr)
          ? 'Repository not found or your account lacks access. Check the repository root address and SSH key permissions.'
          : /Remote branch .* not found/iu.test(stderr)
            ? 'The requested base branch was not found. Leave Base branch empty to detect the repository default.'
            : Object.keys(environment).length === 0
              ? stderr.trim().replace(/(https?:\/\/)[^\s/]+@/gu, '$1[redacted]@')
              : 'Check the repository address, branch, and shared SSH key access.';
    throw new Error(`git ${args[0]} failed (exit ${exitCode})${detail ? `: ${detail}` : ''}`);
  }
  return stdout.trim();
}

export class ProjectLifecycleManager {
  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly authority: ProjectLifecycleAuthority,
    private readonly machineId: string,
    private readonly managedRoot: string,
    private readonly checkpointSpace?: (spaceId: string) => Promise<void>,
    private readonly gitEnvironment?: (repositoryUrl: string) => Record<string, string> | Promise<Record<string, string>>,
  ) {}

  list(lifecycle: 'all' | 'active' | 'archived'): Promise<CloudProjectSummary[]> {
    return this.authority.listProjects(lifecycle === 'all' ? undefined : lifecycle);
  }

  async createProject(input: CreateProjectInput): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation }> {
    const repositoryUrl = input.repositoryUrl === null ? null : normalizeRepositoryUrl(input.repositoryUrl);
    const projectId = resourceId(input.name);
    const projectRoot = join(this.managedRoot, projectId);
    const repositoryPath = join(projectRoot, 'base');
    let baseBranch = input.baseBranch ?? 'main';
    let project: CloudProjectSummary | null = null;
    let operation: CloudProjectOperation | null = null;
    let ownsRoot = false;
    let createdLocal = false;
    let bootstrapAttempted = false;
    try {
      await mkdir(this.managedRoot, { recursive: true });
      // Exclusive creation ensures rollback never removes an existing user's directory.
      await mkdir(projectRoot);
      ownsRoot = true;
      if (repositoryUrl) {
        const environment = await this.gitEnvironment?.(repositoryUrl) ?? {};
        await runGit(['clone', '--single-branch', ...(input.baseBranch === null ? [] : ['--branch', input.baseBranch]), '--', repositoryUrl, repositoryPath], undefined, environment);
        if (input.baseBranch === null) baseBranch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath);
      } else {
        await mkdir(repositoryPath);
        await runGit(['init', '-b', baseBranch], repositoryPath);
        await runGit(['-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'Initialize GitSpace project'], repositoryPath);
      }
      // Repository failures must not publish a project or leave a local projection.
      if (this.database.getProject(projectId) || await this.authority.getProject(projectId)) {
        throw new Error(`Project ${projectId} already exists`);
      }
      bootstrapAttempted = true;
      project = await this.authority.bootstrapProject({
        projectId,
        name: input.name,
        repositoryReference: repositoryUrl,
        baseBranch,
      });
      if (project.lifecycle !== 'provisioning' || project.revision !== 1 || project.name !== input.name || project.repositoryReference !== repositoryUrl || project.baseBranch !== baseBranch) {
        throw new Error(`Project ${projectId} already exists with different state`);
      }
      operation = await this.authority.createProjectOperation(projectId, {
        projectId,
        workspaceId: null,
        kind: repositoryUrl ? 'project.import' : 'project.create',
        targetMachines: [this.machineId],
        steps: [{ id: 'repository', label: repositoryUrl ? 'Clone repository' : 'Initialize repository' }, { id: 'projection', label: 'Create local projection' }],
        createdBy: this.machineId,
      });
      operation = await this.running(projectId, operation);
      const created = this.database.createProject({
        id: projectId,
        name: input.name,
        repositoryPath,
        baseBranch,
        ...(repositoryUrl ? { repositoryReference: repositoryUrl } : {}),
      });
      if (created.status === 'error') throw created.error;
      createdLocal = true;
      const possessed = this.database.possessSpace(projectId, this.machineId, repositoryPath);
      if (possessed.status === 'error') throw possessed.error;
      await this.authority.putProjectWorkspace(projectId, {
        id: projectId,
        projectId,
        kind: 'base',
        name: input.name,
        branch: baseBranch,
        phase: null,
        sourceKind: 'base',
        sourceRef: baseBranch,
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
      if (operation) await this.failed(projectId, operation, error);
      try {
        let canRemoveLocal = true;
        if (bootstrapAttempted) {
          // A rejected RPC may have committed. Re-read before compensation, and never
          // destroy a project that became active or changed under another operation.
          const current = await this.authority.getProject(projectId);
          canRemoveLocal = current === null;
          if (current?.lifecycle === 'provisioning' && current.revision === 1
            && current.name === input.name && current.repositoryReference === repositoryUrl && current.baseBranch === baseBranch) {
            await this.authority.deleteProject(projectId, current.revision);
            canRemoveLocal = true;
          }
        }
        if (canRemoveLocal) {
          if (createdLocal) this.database.deleteProject(projectId);
          if (ownsRoot) await rm(projectRoot, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Project creation failed: ${error instanceof Error ? error.message : String(error)}. Cleanup for ${projectId} could not finish; its remaining data was preserved.`);
      }
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
        const environment = project.repositoryReference ? await this.gitEnvironment?.(project.repositoryReference) ?? {} : {};
        await runGit(['fetch', 'origin', `pull/${input.sourceRef}/head`], base.rootPath, environment);
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
