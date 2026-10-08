import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { GitSpaceDatabase, MaterializedSpace, Workspace } from '@gitspace/core';
import { assertWorkspacePhase, WorkspacePhaseSchema } from '@gitspace/protocol-workspace';
import type {
  CloudProjectOperation,
  CloudProjectSummary,
  CloudWorkspaceDefinition,
} from '@gitspace/protocol';
import type { CloudSpaceCheckpointAuthority } from './cloud-space-authority.js';
import type { PublishedSpaceHeadResolver } from './inspector-base.js';
import { readGitCheckpointHead } from './git-checkpoint.js';

export interface ProjectLifecycleAuthority extends Pick<CloudSpaceCheckpointAuthority, 'getSpace'> {
  bootstrap(input: { projectId: string; spaceId: string }): Promise<unknown>;
  releaseUnpublishedSource(input: { projectId: string; spaceId: string; expectedGeneration: number; sourceCommit: string }): Promise<void>;
  bootstrapInspector(input: { projectId: string; spaceId: string }): Promise<unknown>;
  listProjects(lifecycle?: 'active' | 'archived'): Promise<CloudProjectSummary[]>;
  bootstrapProject(input: { projectId: string; name: string; repositoryReference: string | null; baseBranch: string }): Promise<CloudProjectSummary>;
  getProject(projectId: string): Promise<CloudProjectSummary | null>;
  activateSourceProject(projectId: string, expectedRevision: number, baseBranch: string): Promise<CloudProjectSummary>;
  setProjectBaseBranch(projectId: string, expectedRevision: number, baseBranch: string): Promise<CloudProjectSummary>;
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
  phase?: Workspace['phase'];
  sourceKind: CloudWorkspaceDefinition['sourceKind'];
  sourceRef: string;
  /** Extra dependencies; a `workspace` source is always also a dependency and becomes `stackedOn`. */
  dependsOn?: readonly string[];
}

export interface ArchiveWorkspaceInput {
  projectId: string;
  spaceId: string;
  expectedRevision: number;
  expectedGeneration: number | null;
}

/** Creation steps in order. The source resolves before the definition enters the catalog, so
 * provisioning starts at `worktree`; a retry resumes at the first step that has not succeeded. */
const WORKSPACE_CREATE_STEPS = [
  { id: 'source', label: 'Resolve source' },
  { id: 'worktree', label: 'Create worktree' },
  { id: 'projection', label: 'Create local projection' },
  { id: 'placement', label: 'Record placement' },
  { id: 'checkpoint', label: 'Save first checkpoint' },
  { id: 'activate', label: 'Activate workspace' },
];

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
  private readonly openingProjects = new Map<string, Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation | null }>>();
  /** Workspaces whose creation or retry is running in this process. */
  private readonly creating = new Set<string>();

  constructor(
    private readonly database: GitSpaceDatabase,
    private readonly authority: ProjectLifecycleAuthority,
    private readonly machineId: string,
    private readonly managedRoot: string,
    private readonly checkpointSpace?: (spaceId: string) => Promise<void>,
    private readonly gitEnvironment?: (repositoryUrl: string) => Record<string, string> | Promise<Record<string, string>>,
    private readonly resolvePublishedHead?: PublishedSpaceHeadResolver,
  ) {}

  list(lifecycle: 'all' | 'active' | 'archived'): Promise<CloudProjectSummary[]> {
    return this.authority.listProjects(lifecycle === 'all' ? undefined : lifecycle);
  }

  async findWorkspace(workspaceId: string): Promise<CloudWorkspaceDefinition | null> {
    for (const project of await this.authority.listProjects()) {
      if (project.lifecycle === 'deleting') continue;
      const workspace = (await this.authority.listProjectWorkspaces(project.id)).find((candidate) => candidate.id === workspaceId);
      if (workspace?.projectId === project.id && workspace.kind === 'worktree') return workspace;
    }
    return null;
  }

  openProject(projectId: string): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation | null }> {
    const opening = this.openingProjects.get(projectId);
    if (opening) return opening;
    const operation = this.materializeSourceProject(projectId).finally(() => this.openingProjects.delete(projectId));
    this.openingProjects.set(projectId, operation);
    return operation;
  }

  /** Recover old failed-open clones only from immutable canonical provenance. */
  async releasePristineSource(projectId: string): Promise<boolean> {
    const project = await this.authority.getProject(projectId);
    const base = this.database.getBaseSpace(projectId);
    if (project?.role !== 'gitspace-source' || project.lifecycle !== 'cloud-only' || !project.source?.commit
      || !base || base.rootPath !== join(this.managedRoot, projectId, 'base')
      || this.database.listSpaces(projectId).length !== 1
      || this.database.listSpaceCleanupJobs().some(job => job.projectId === projectId)) return false;
    const placement = await this.authority.getSpace(projectId, projectId);
    if (!placement || placement.publishedRevision !== 0 || placement.manifestKey !== null || placement.manifestHash !== null) return false;
    const held = placement.state === 'open' && placement.machineId === this.machineId && placement.generation === base.generation;
    const released = placement.state === 'closed' && placement.machineId === null && placement.generation === base.generation + 1;
    if (!held && !released) return false;
    if (await runGit(['rev-parse', 'HEAD'], base.rootPath) !== project.source.commit
      || await runGit(['status', '--porcelain', '--untracked-files=all', '--ignored'], base.rootPath) !== ''
      || await runGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], base.rootPath) !== `refs/heads/${project.baseBranch} ${project.source.commit}`) return false;
    const localTags = await runGit(['for-each-ref', '--format=%(objectname)%09%(refname)', 'refs/tags'], base.rootPath);
    if (localTags) {
      if (!project.repositoryReference) return false;
      // A stranded clone may include published tags; only locally unique tag
      // history requires explicit discard. A failed origin check proves nothing.
      const publishedTags = await runGit(['ls-remote', '--tags', '--', project.repositoryReference], undefined,
        await this.gitEnvironment?.(project.repositoryReference) ?? {}).catch(() => null);
      if (publishedTags === null) return false;
      const published = new Set(publishedTags.split('\n'));
      if (localTags.split('\n').some(tag => !published.has(tag))) return false;
    }
    if (held) await this.authority.releaseUnpublishedSource({ projectId, spaceId: projectId, expectedGeneration: placement.generation, sourceCommit: project.source.commit });
    this.database.deleteProject(projectId);
    await rm(join(this.managedRoot, projectId), { recursive: true, force: true });
    return true;
  }

  private async materializeSourceProject(projectId: string): Promise<{ project: CloudProjectSummary; operation: CloudProjectOperation | null }> {
    const project = await this.authority.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} does not exist`);
    if (project.lifecycle === 'active') return { project, operation: null };
    if (project.role !== 'gitspace-source' || project.lifecycle !== 'cloud-only' || !project.repositoryReference) {
      throw new Error(`Project ${projectId} cannot be opened`);
    }
    const projectRoot = join(this.managedRoot, projectId);
    const repositoryPath = join(projectRoot, 'base');
    let ownsRoot = false;
    let createdLocal = false;
    let checkpointAttempted = false;
    let baseline: { commit: string; refs: string } | null = null;
    let operation = await this.authority.createProjectOperation(projectId, {
      projectId, workspaceId: null, kind: 'project.open', targetMachines: [this.machineId],
      steps: [{ id: 'repository', label: 'Clone GitSpace source' }, { id: 'projection', label: 'Open project space' }],
      createdBy: this.machineId,
    });
    operation = await this.running(projectId, operation);
    try {
      let baseBranch = project.source?.branch ?? (project.baseBranch === 'HEAD' ? null : project.baseBranch);
      // Only a fresh checkout establishes provenance; a retained retry may already contain later work.
      let sourceCommit: string | null = null;
      const local = this.database.getProject(projectId);
      if (!local) {
        const environment = await this.gitEnvironment?.(project.repositoryReference) ?? {};
        if (baseBranch) await runGit(['check-ref-format', '--branch', baseBranch]);
        await mkdir(this.managedRoot, { recursive: true });
        await mkdir(projectRoot);
        ownsRoot = true;
        const commit = project.source?.commit;
        await runGit(['clone', ...(commit ? ['--no-checkout'] : baseBranch ? ['--single-branch', '--branch', baseBranch] : []), '--', project.repositoryReference, repositoryPath], undefined, environment);
        baseBranch ??= await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath);
        if (commit) {
          await runGit(['fetch', 'origin', commit], repositoryPath, environment);
          await runGit(['checkout', '-B', baseBranch, commit, '--'], repositoryPath);
        }
        sourceCommit = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repositoryPath);
        baseline = { commit: sourceCommit, refs: await runGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'], repositoryPath) };
        const created = this.database.createProject({
          id: projectId, name: project.name, repositoryPath, baseBranch, repositoryReference: project.repositoryReference,
        });
        if (created.status === 'error') throw created.error;
        createdLocal = true;
      } else {
        // Retry a completed checkout whose cloud publication was interrupted; never reset it.
        baseBranch = local.baseBranch;
        const retained = this.database.getBaseSpace(projectId);
        if (!retained) throw new Error(`Project ${projectId} has no local base space`);
        await runGit(['rev-parse', '--verify', 'HEAD'], retained.rootPath);
      }
      const base = this.database.getBaseSpace(projectId);
      if (!base) throw new Error(`Project ${projectId} has no local base space`);
      if (base.holderId !== this.machineId || base.placementState !== 'open') {
        const possessed = this.database.possessSpace(projectId, this.machineId, base.rootPath);
        if (possessed.status === 'error') throw possessed.error;
      }
      const definition = (await this.authority.listProjectWorkspaces(projectId)).find((workspace) => workspace.id === projectId);
      if (!definition) {
        await this.authority.putProjectWorkspace(projectId, {
          id: projectId, projectId, kind: 'base', name: project.name, branch: baseBranch, phase: null,
          sourceKind: project.source?.commit ? 'commit' : 'base', sourceRef: project.source?.commit ?? baseBranch,
          sourceCommit,
          lifecycle: 'active', goalId: null, expectedRevision: 0,
        });
      } else if (definition.branch !== baseBranch) {
        throw new Error('GitSpace source branch changed while opening. Retry after the other operation finishes.');
      }
      await this.authority.bootstrap({ projectId, spaceId: projectId });
      const placement = await this.authority.getSpace(projectId, projectId);
      const localPlacement = this.database.getSpace(projectId);
      if (createdLocal && placement?.state === 'open' && placement.machineId === this.machineId && localPlacement
        && placement.generation !== localPlacement.generation) {
        const fenced = this.database.invalidateSpacePossession({ spaceId: projectId, holderId: this.machineId, expectedGeneration: localPlacement.generation });
        if (fenced.status === 'error') throw fenced.error;
        const aligned = this.database.alignClosedSpaceProjection(projectId, placement.generation);
        if (aligned.status === 'error') throw aligned.error;
        const adopted = this.database.adoptOpenSpaceProjection({ spaceId: projectId, holderId: this.machineId, expectedGeneration: placement.generation, rootPath: localPlacement.rootPath });
        if (adopted.status === 'error') throw adopted.error;
      }
      await this.authority.bootstrapInspector({ projectId, spaceId: projectId });
      checkpointAttempted = true;
      await this.checkpointSpace?.(projectId);
      const current = await this.authority.getProject(projectId);
      if (!current) throw new Error(`Project ${projectId} disappeared while opening`);
      if (current.source?.commit !== project.source?.commit || current.source?.branch !== project.source?.branch) {
        throw new Error('GitSpace source release changed while opening. The checkout was preserved.');
      }
      const active = current.lifecycle === 'active' ? current : await this.authority.activateSourceProject(projectId, current.revision, baseBranch);
      operation = await this.succeeded(projectId, operation);
      return { project: active, operation };
    } catch (error) {
      await this.failed(projectId, operation, error);
      // A failed first upload is not unpublished user work when this invocation
      // still has the exact clean clone. Ambiguous checkpoint outcomes stay put.
      let removeLocal = !checkpointAttempted;
      if (checkpointAttempted && createdLocal && ownsRoot && baseline && project.source?.commit === baseline.commit
        && !this.database.listSpaceCleanupJobs().some(job => job.spaceId === projectId && job.state === 'prepared')) {
        const placement = await this.authority.getSpace(projectId, projectId);
        if (placement?.state === 'open' && placement.machineId === this.machineId && placement.publishedRevision === 0
          && placement.manifestKey === null && placement.manifestHash === null
          && await runGit(['rev-parse', 'HEAD'], repositoryPath) === baseline.commit
          && await runGit(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads', 'refs/tags'], repositoryPath) === baseline.refs
          && await runGit(['status', '--porcelain', '--untracked-files=all', '--ignored'], repositoryPath) === '') {
          await this.authority.releaseUnpublishedSource({ projectId, spaceId: projectId, expectedGeneration: placement.generation, sourceCommit: baseline.commit });
          removeLocal = true;
        }
      }
      if (removeLocal) {
        if (createdLocal) this.database.deleteProject(projectId);
        if (ownsRoot) await rm(projectRoot, { recursive: true, force: true });
      }
      throw error;
    }
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
        const emptyRemote = input.baseBranch !== null && await runGit(['ls-remote', '--', repositoryUrl], undefined, environment) === '';
        await runGit(['clone', '--single-branch', ...(input.baseBranch === null || emptyRemote ? [] : ['--branch', input.baseBranch]), '--', repositoryUrl, repositoryPath], undefined, environment);
        if (emptyRemote) {
          // An empty remote has no branch to select during clone. Keep HEAD
          // genuinely unborn while honoring the requested initial branch name.
          const cloned = await readGitCheckpointHead(repositoryPath);
          if (cloned.headCommit !== null) throw new Error('Repository acquired a commit while importing its empty branch; retry the import');
          await runGit(['check-ref-format', '--branch', baseBranch], repositoryPath);
          await runGit(['symbolic-ref', 'HEAD', `refs/heads/${baseBranch}`], repositoryPath);
        } else if (input.baseBranch === null) {
          baseBranch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath);
        }
      } else {
        await mkdir(repositoryPath);
        await runGit(['init', '-b', baseBranch], repositoryPath);
        await runGit(['-c', 'user.name=GitSpace', '-c', 'user.email=gitspace@local.invalid', 'commit', '--allow-empty', '-m', 'Initialize GitSpace project'], repositoryPath);
      }
      const { headCommit: sourceCommit } = await readGitCheckpointHead(repositoryPath);
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
        sourceCommit,
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
    const phase = WorkspacePhaseSchema.parse(input.phase ?? 'plan');
    await runGit(['check-ref-format', '--branch', input.branch]);
    await runGit(['check-ref-format', `refs/heads/${input.branch}`]);
    if ((await this.authority.getProject(input.projectId))?.lifecycle === 'cloud-only') await this.openProject(input.projectId);
    const project = await this.authority.getProject(input.projectId);
    if (!project || project.lifecycle !== 'active') throw new Error(`Project ${input.projectId} is not active`);
    // Definitions and phase ceilings are canonical even when this machine has no projection.
    const workspaces = (await this.authority.listProjectWorkspaces(input.projectId))
      .filter((workspace): workspace is CloudWorkspaceDefinition & { phase: Workspace['phase'] } => workspace.kind === 'worktree' && workspace.phase !== null);
    const sourceWorkspace = input.sourceKind === 'workspace'
      ? workspaces.find((candidate) => candidate.id === input.sourceRef) ?? workspaces.find((candidate) => candidate.name === input.sourceRef) ?? null
      : null;
    if (input.sourceKind === 'workspace' && !sourceWorkspace) throw new Error(`Source workspace ${input.sourceRef} does not exist`);
    const dependencies = [...new Set([...(sourceWorkspace ? [sourceWorkspace.id] : []), ...(input.dependsOn ?? [])])].map((id) => {
      const dependency = workspaces.find((candidate) => candidate.id === id);
      if (!dependency) throw new Error(`Dependency workspace ${id} does not exist in project ${input.projectId}`);
      return dependency;
    });
    assertWorkspacePhase(phase, dependencies);
    const workspaceId = resourceId(input.name);
    const rootPath = join(this.managedRoot, input.projectId, workspaceId);
    this.creating.add(workspaceId);
    try {
      await mkdir(join(this.managedRoot, input.projectId), { recursive: true });
      // Each creation owns its object store and fetch ref; no shared clone or FETCH_HEAD races.
      await mkdir(rootPath);
      let sourceCommit: string;
      try {
        await runGit(['init', '-b', input.branch], rootPath);
        sourceCommit = await this.resolveWorkspaceSource(input, project, sourceWorkspace, rootPath);
      } catch (error) {
        await rm(rootPath, { recursive: true, force: true });
        throw error;
      }
      // Invalid branches, missing sources, and unavailable checkpoints never enter the catalog.
      const definition = await this.authority.putProjectWorkspace(input.projectId, {
        id: workspaceId,
        projectId: input.projectId,
        kind: 'worktree',
        name: input.name,
        branch: input.branch,
        phase,
        sourceKind: input.sourceKind,
        sourceRef: input.sourceRef,
        sourceCommit,
        lifecycle: 'provisioning',
        goalId: null,
        expectedRevision: 0,
      });
      const operation = await this.authority.createProjectOperation(input.projectId, {
        projectId: input.projectId,
        workspaceId,
        kind: 'workspace.create',
        targetMachines: [this.machineId],
        steps: WORKSPACE_CREATE_STEPS,
        createdBy: this.machineId,
      });
      return await this.provisionWorkspace({ project, definition, operation, rootPath, sourceCommit, dependencies, stackedOn: sourceWorkspace?.id ?? null });
    } finally {
      this.creating.delete(workspaceId);
    }
  }

  /** Resumes a failed or interrupted creation. Every step is safe to repeat: the kept checkout,
   * the local projection, and this machine's cloud placement are reused rather than recreated. */
  async retryCreateWorkspace(workspaceId: string): Promise<{ workspace: Workspace; operation: CloudProjectOperation }> {
    const found = await this.findWorkspace(workspaceId);
    if (!found) throw new Error(`Workspace ${workspaceId} does not exist`);
    if (found.lifecycle !== 'failed' && found.lifecycle !== 'provisioning') {
      throw new Error(`Workspace ${found.name} is ${found.lifecycle}; only a failed or unfinished creation can be retried`);
    }
    if (this.creating.has(workspaceId)) throw new Error(`Workspace ${found.name} is already being created on this machine`);
    this.creating.add(workspaceId);
    try {
      const project = await this.authority.getProject(found.projectId);
      if (!project || project.lifecycle !== 'active') throw new Error(`Project ${found.projectId} is not active`);
      const placement = await this.authority.getSpace(found.projectId, workspaceId);
      // The first checkpoint releases and reopens; a release that committed leaves a published checkpoint to reopen.
      const published = placement?.state === 'closed' && placement.machineId === null && placement.publishedRevision > 0;
      if (placement && !published && (placement.state !== 'open' || placement.machineId !== this.machineId)) {
        throw new Error('This workspace\'s placement is held by another machine or is changing; retry its creation there');
      }
      const workspaces = (await this.authority.listProjectWorkspaces(found.projectId))
        .filter((workspace): workspace is CloudWorkspaceDefinition & { phase: Workspace['phase'] } => workspace.kind === 'worktree' && workspace.phase !== null);
      const sourceWorkspace = found.sourceKind === 'workspace'
        ? workspaces.find((candidate) => candidate.id === found.sourceRef) ?? workspaces.find((candidate) => candidate.name === found.sourceRef) ?? null
        : null;
      if (found.sourceKind === 'workspace' && !sourceWorkspace) throw new Error(`Source workspace ${found.sourceRef} no longer exists`);
      const rootPath = join(this.managedRoot, found.projectId, workspaceId);
      const retained = found.sourceCommit !== null && (published || (existsSync(join(rootPath, '.git'))
        && await runGit(['rev-parse', '--verify', '--quiet', `${found.sourceCommit}^{commit}`], rootPath).then(() => true, () => false)));
      let sourceCommit = found.sourceCommit;
      if (!retained || sourceCommit === null) {
        await mkdir(rootPath, { recursive: true });
        if (!existsSync(join(rootPath, '.git'))) await runGit(['init', '-b', found.branch], rootPath);
        sourceCommit = await this.resolveWorkspaceSource({
          projectId: found.projectId, name: found.name, branch: found.branch, sourceKind: found.sourceKind, sourceRef: found.sourceRef,
        }, project, sourceWorkspace, rootPath);
      }
      const definition = await this.authority.putProjectWorkspace(found.projectId, {
        id: found.id,
        projectId: found.projectId,
        kind: found.kind,
        name: found.name,
        branch: found.branch,
        phase: found.phase,
        sourceKind: found.sourceKind,
        sourceRef: found.sourceRef,
        sourceCommit,
        lifecycle: 'provisioning',
        goalId: found.goalId,
        expectedRevision: found.revision,
      });
      const operation = await this.authority.createProjectOperation(found.projectId, {
        projectId: found.projectId,
        workspaceId,
        kind: 'workspace.create',
        targetMachines: [this.machineId],
        steps: WORKSPACE_CREATE_STEPS,
        createdBy: this.machineId,
      });
      // Extra dependencies from the original request live only in an existing local projection.
      return await this.provisionWorkspace({
        project, definition, operation, rootPath, sourceCommit, published,
        dependencies: sourceWorkspace ? [sourceWorkspace] : [], stackedOn: sourceWorkspace?.id ?? null,
      });
    } finally {
      this.creating.delete(workspaceId);
    }
  }

  /** Runs creation from the worktree step, or from the first checkpoint once its release published.
   * The cloud grants the placement generation before the local projection opens, so a failure
   * never leaves a local open holder the cloud lacks. */
  private async provisionWorkspace(input: {
    project: CloudProjectSummary;
    definition: CloudWorkspaceDefinition;
    operation: CloudProjectOperation;
    rootPath: string;
    sourceCommit: string;
    published?: boolean;
    dependencies: Array<CloudWorkspaceDefinition & { phase: Workspace['phase'] }>;
    stackedOn: string | null;
  }): Promise<{ workspace: Workspace; operation: CloudProjectOperation }> {
    const { project, rootPath, definition } = input;
    const workspaceId = definition.id;
    let operation = input.operation;
    let completed = input.published ? WORKSPACE_CREATE_STEPS.findIndex((step) => step.id === 'checkpoint') : 1;
    const advance = async () => {
      completed += 1;
      operation = await this.creationProgress(project.id, operation, completed, null);
    };
    try {
      operation = await this.creationProgress(project.id, operation, completed, null);
      if (!input.published) {
        // A portable checkout owns all its objects and never changes the source branch or dirty files.
        // A kept checkout already on its branch is reused so a retry never resets retained changes.
        const branch = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], rootPath).catch(() => '');
        const hasHead = await runGit(['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], rootPath).then(() => true, () => false);
        if (branch !== definition.branch || !hasHead) await runGit(['checkout', '-B', definition.branch, input.sourceCommit, '--'], rootPath);
        if (project.repositoryReference && !await runGit(['remote', 'get-url', 'origin'], rootPath).catch(() => '')) {
          await runGit(['remote', 'add', 'origin', project.repositoryReference], rootPath);
        }
        await advance();
        if (!this.database.getProject(project.id)) {
          const createdProject = this.database.createProject({
            id: project.id, name: project.name, baseBranch: project.baseBranch,
            repositoryPath: join(this.managedRoot, project.id, 'base'),
            ...(project.repositoryReference ? { repositoryReference: project.repositoryReference } : {}),
          });
          if (createdProject.status === 'error') throw createdProject.error;
        }
        if (!this.database.getWorkspace(workspaceId)) {
          // Relations require local FK targets, not possession or a restored checkout.
          for (const dependency of input.dependencies) {
            if (this.database.getWorkspace(dependency.id)) continue;
            const projected = this.database.createWorkspace({
              id: dependency.id, projectId: project.id, name: dependency.name, branch: dependency.branch,
              phase: dependency.phase, rootPath: join(this.managedRoot, project.id, dependency.id),
            });
            if (projected.status === 'error') throw projected.error;
            if (dependency.lifecycle === 'archived') this.database.setSpaceClosed(dependency.id, true);
          }
          const created = this.database.createWorkspace({ id: workspaceId, projectId: project.id, name: definition.name, branch: definition.branch, phase: definition.phase ?? 'plan', rootPath });
          if (created.status === 'error') throw created.error;
          if (input.dependencies.length > 0) {
            const related = this.database.setSpaceRelations(workspaceId, { dependsOn: input.dependencies.map((dependency) => dependency.id), relatedTo: [], stackedOn: input.stackedOn });
            if (related.status === 'error') throw related.error;
          }
        }
        await advance();
        await this.authority.bootstrap({ projectId: project.id, spaceId: workspaceId });
        await this.authority.bootstrapInspector({ projectId: project.id, spaceId: workspaceId });
        const placement = await this.authority.getSpace(project.id, workspaceId);
        if (!placement || placement.state !== 'open' || placement.machineId !== this.machineId) {
          throw new Error('The cloud did not record this machine as the workspace holder');
        }
        const local = this.database.getSpace(workspaceId);
        if (!local) throw new Error(`Local workspace ${workspaceId} is missing`);
        if (local.placementState !== 'open' || local.holderId !== this.machineId || local.generation !== placement.generation) {
          const aligned = local.placementState === 'closed' && local.generation === placement.generation - 1
            ? this.database.possessWorkspace(workspaceId, this.machineId)
            : this.database.adoptOpenSpaceProjection({ spaceId: workspaceId, holderId: this.machineId, expectedGeneration: placement.generation, rootPath });
          if (aligned.status === 'error') throw aligned.error;
        }
        await advance();
      }
      await this.checkpointSpace?.(workspaceId);
      await advance();
      await this.authority.putProjectWorkspace(project.id, {
        id: definition.id,
        projectId: definition.projectId,
        kind: definition.kind,
        name: definition.name,
        branch: definition.branch,
        phase: definition.phase,
        sourceKind: definition.sourceKind,
        sourceRef: definition.sourceRef,
        sourceCommit: definition.sourceCommit,
        lifecycle: 'active',
        goalId: definition.goalId,
        expectedRevision: definition.revision,
      });
      operation = await this.succeeded(project.id, operation);
      return { workspace: this.database.getWorkspace(workspaceId)!, operation };
    } catch (error) {
      // Completed steps and the checkout stay in place; Retry resumes at the failed step.
      await this.creationProgress(project.id, operation, completed, error instanceof Error ? error.message : String(error)).catch(() => undefined);
      await this.authority.putProjectWorkspace(project.id, {
        id: definition.id,
        projectId: definition.projectId,
        kind: definition.kind,
        name: definition.name,
        branch: definition.branch,
        phase: definition.phase,
        sourceKind: definition.sourceKind,
        sourceRef: definition.sourceRef,
        sourceCommit: definition.sourceCommit,
        lifecycle: 'failed',
        goalId: definition.goalId,
        expectedRevision: definition.revision,
      }).catch(() => undefined);
      throw error;
    }
  }

  /** Steps before `completed` succeeded; the step at `completed` runs, or failed with `failure`. */
  private creationProgress(projectId: string, operation: CloudProjectOperation, completed: number, failure: string | null): Promise<CloudProjectOperation> {
    const now = new Date().toISOString();
    return this.authority.updateProjectOperation(projectId, {
      id: operation.id,
      expectedRevision: operation.revision,
      state: failure === null ? 'running' : 'failed',
      steps: operation.steps.map((step, index) => ({
        ...step,
        state: index < completed ? 'succeeded' : index > completed ? 'queued' : failure === null ? 'running' : 'failed',
        message: index === completed ? failure : null,
        updatedAt: now,
      })),
      error: failure,
    });
  }

  private async liveSourceRoot(space: MaterializedSpace | null): Promise<string | null> {
    if (!space || space.holderId !== this.machineId || space.placementState !== 'open' || !existsSync(join(space.rootPath, '.git'))) return null;
    const placement = await this.authority.getSpace(space.projectId, space.id);
    return placement?.state === 'open' && placement.machineId === this.machineId && placement.generation === space.generation
      ? space.rootPath : null;
  }

  private async resolveWorkspaceSource(
    input: CreateWorkspaceInput,
    project: CloudProjectSummary,
    sourceWorkspace: CloudWorkspaceDefinition | null,
    repositoryPath: string,
  ): Promise<string> {
    const sourceRef = input.sourceKind === 'base' ? project.baseBranch : input.sourceRef || project.baseBranch;
    const fetchCommit = async (repository: string, ref: string, environment: Record<string, string> = {}): Promise<string> => {
      await runGit(['fetch', '--no-tags', '--no-write-fetch-head', '--', repository, `${ref}:refs/gitspace/source`], repositoryPath, environment);
      return runGit(['rev-parse', '--verify', 'refs/gitspace/source^{commit}'], repositoryPath);
    };
    const publishedHead = (spaceId: string, branch?: string): Promise<string> => {
      if (!this.resolvePublishedHead) throw new Error(`Workspace source ${spaceId} requires a published repository checkpoint resolver`);
      return this.resolvePublishedHead({ projectId: project.id, spaceId, branch, repositoryPath });
    };
    if (sourceWorkspace) {
      const sourceRoot = await this.liveSourceRoot(this.database.getWorkspace(sourceWorkspace.id));
      if (!sourceRoot) return publishedHead(sourceWorkspace.id);
      const head = await runGit(['rev-parse', '--verify', 'HEAD^{commit}'], sourceRoot);
      return fetchCommit(sourceRoot, head);
    }
    if (sourceRef.startsWith('-') || /[\u0000-\u001f\u007f]/u.test(sourceRef)) throw new Error('Invalid workspace source ref');

    const base = this.database.getBaseSpace(project.id);
    const baseRoot = await this.liveSourceRoot(base);
    const remoteUrl = async (remote: string): Promise<string> => {
      // origin is the canonical repository, not an old local clone's filesystem URL.
      if (remote === 'origin' && project.repositoryReference) return project.repositoryReference;
      if (base && existsSync(join(base.rootPath, '.git'))) return runGit(['remote', 'get-url', '--', remote], base.rootPath);
      throw new Error(`Project ${project.id} has no ${remote} repository for source ${sourceRef}`);
    };
    const fetchRemote = async (remote: string, ref: string): Promise<string> => {
      const repository = await remoteUrl(remote);
      return fetchCommit(repository, ref, await this.gitEnvironment?.(repository) ?? {});
    };
    if (input.sourceKind === 'base') {
      if (!baseRoot) return publishedHead(project.id, project.baseBranch);
      return fetchCommit(baseRoot, await runGit(['rev-parse', '--verify', '--end-of-options', `refs/heads/${project.baseBranch}^{commit}`], baseRoot));
    }
    if (input.sourceKind === 'pull-request') {
      if (!/^[1-9]\d*$/u.test(input.sourceRef)) throw new Error('Pull request source must be a positive pull request number');
      return fetchRemote('origin', `refs/pull/${input.sourceRef}/head`);
    }
    if (input.sourceKind === 'branch') {
      const qualified = /^refs\/remotes\/([^/]+)\/(.+)$/u.exec(sourceRef);
      let remote = qualified?.[1];
      let branch = qualified?.[2] ?? sourceRef.replace(/^refs\/heads\//u, '');
      if (!qualified && !sourceRef.startsWith('refs/heads/')) {
        const separator = sourceRef.indexOf('/');
        if (separator > 0) {
          const prefix = sourceRef.slice(0, separator);
          const remotes = base && existsSync(join(base.rootPath, '.git')) ? (await runGit(['remote'], base.rootPath)).split('\n') : [];
          if (prefix === 'origin' || remotes.includes(prefix)) {
            remote = prefix;
            branch = sourceRef.slice(separator + 1);
          }
        }
      }
      await runGit(['check-ref-format', `refs/heads/${branch}`]);
      if (remote) return fetchRemote(remote, `refs/heads/${branch}`);
      if (baseRoot) {
        const commit = await runGit(['rev-parse', '--verify', '--end-of-options', `refs/heads/${branch}^{commit}`], baseRoot).catch(() => null);
        if (commit) return fetchCommit(baseRoot, commit);
      } else if (branch === project.baseBranch) {
        return publishedHead(project.id, project.baseBranch);
      }
      return fetchRemote('origin', `refs/heads/${branch}`);
    }
    const ref = input.sourceKind === 'tag' ? (sourceRef.startsWith('refs/tags/') ? sourceRef : `refs/tags/${sourceRef}`) : sourceRef;
    if (input.sourceKind === 'tag') await runGit(['check-ref-format', ref]);
    if (baseRoot) {
      const commit = await runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], baseRoot).catch(() => null);
      if (commit) return fetchCommit(baseRoot, commit);
    }
    if (!project.repositoryReference && input.sourceKind === 'commit') {
      await publishedHead(project.id, project.baseBranch);
      return runGit(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], repositoryPath);
    }
    return fetchRemote('origin', ref);
  }

  archiveWorkspace(
    input: ArchiveWorkspaceInput,
    close: (space: MaterializedSpace, expectedGeneration: number) => Promise<unknown>,
  ): Promise<CloudWorkspaceDefinition> {
    return this.runLifecycleOperation(input.projectId, input.spaceId, 'workspace.archive', ['Checkpoint workspace', 'Archive workspace'], async () => {
      const definition = (await this.authority.listProjectWorkspaces(input.projectId)).find((workspace) => workspace.id === input.spaceId);
      if (!definition || definition.projectId !== input.projectId || definition.kind !== 'worktree') {
        throw new Error(`Workspace ${input.spaceId} is not a worktree in project ${input.projectId}`);
      }
      if (definition.revision !== input.expectedRevision) {
        throw new Error(`Workspace revision conflict: expected ${input.expectedRevision}, actual ${definition.revision}`);
      }
      const placement = await this.authority.getSpace(input.projectId, input.spaceId);
      if (placement && (placement.projectId !== input.projectId || placement.spaceId !== input.spaceId)) {
        throw new Error('Workspace placement identity does not match');
      }
      if ((placement?.generation ?? null) !== input.expectedGeneration) {
        throw new Error(`Workspace generation conflict: expected ${input.expectedGeneration}, actual ${placement?.generation ?? null}`);
      }
      const local = this.database.getSpace(input.spaceId);
      if (local && (local.projectId !== input.projectId || local.kind !== 'worktree')) {
        throw new Error('Local workspace identity does not match');
      }
      let closedGeneration = input.expectedGeneration;
      if (!placement) {
        if (definition.lifecycle !== 'failed') {
          throw new Error('Workspace has no authoritative placement; only failed workspaces can be archived without one');
        }
        if (local && local.placementState !== 'closed') {
          throw new Error('Local workspace must be safely closed before archiving without authority placement');
        }
      } else if (placement.state === 'open') {
        if (placement.machineId !== this.machineId) throw new Error('Workspace is held by another machine');
        if (!local || local.holderId !== this.machineId || local.placementState !== 'open' || local.generation !== placement.generation) {
          throw new Error('Workspace requires a matching locally held open generation before archiving');
        }
        await close(local, placement.generation);
        closedGeneration = placement.generation + 1;
      } else if (placement.state !== 'closed' || placement.machineId !== null) {
        throw new Error('Workspace placement must be open here or safely closed before archiving');
      }
      // Closing may race a new holder or canonical lifecycle edit. Never archive
      // an unverified placement or replace a revision newer than the caller saw.
      const currentPlacement = await this.authority.getSpace(input.projectId, input.spaceId);
      if (closedGeneration === null ? currentPlacement !== null : (
        !currentPlacement
        || currentPlacement.projectId !== input.projectId
        || currentPlacement.spaceId !== input.spaceId
        || currentPlacement.state !== 'closed'
        || currentPlacement.machineId !== null
        || currentPlacement.generation !== closedGeneration
        || currentPlacement.publishedRevision <= 0
        || !currentPlacement.manifestKey
        || !currentPlacement.manifestHash
      )) {
        throw new Error('Workspace placement changed before archiving');
      }
      const archived = await this.setWorkspaceLifecycle(input.projectId, input.spaceId, 'archived', input.expectedRevision);
      if (this.database.getSpace(input.spaceId)) this.database.setSpaceClosed(input.spaceId, true);
      return archived;
    });
  }

  private async requireClosedProjectWorkspaces(projectId: string): Promise<void> {
    for (const workspace of await this.authority.listProjectWorkspaces(projectId)) {
      if (workspace.kind !== 'worktree') continue;
      const placement = await this.authority.getSpace(projectId, workspace.id);
      if (!placement && workspace.lifecycle === 'failed') continue;
      if (!placement || placement.projectId !== projectId || placement.spaceId !== workspace.id
          || placement.state !== 'closed' || placement.machineId !== null
          || placement.publishedRevision <= 0 || !placement.manifestKey || !placement.manifestHash) {
        throw new Error(`Workspace ${workspace.id} must be safely closed before changing project lifecycle`);
      }
    }
  }

  archiveProject(projectId: string, expectedRevision: number): Promise<CloudProjectSummary> {
    return this.runLifecycleOperation(projectId, null, 'project.archive', ['Archive project'], async () => {
      const activeWorkspace = this.database.listWorkspaces(projectId).find((workspace) => workspace.placementState !== 'closed');
      if (activeWorkspace) throw new Error(`Workspace ${activeWorkspace.id} must be archived before archiving the project`);
      await this.requireClosedProjectWorkspaces(projectId);
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

  /** Existing workspaces keep their branches; only the base checkout and its canonical records move. */
  async setBaseBranch(projectId: string, expectedRevision: number, baseBranch: string): Promise<CloudProjectSummary> {
    const project = await this.authority.getProject(projectId);
    if (!project) throw new Error(`Project ${projectId} does not exist`);
    if (project.role === 'gitspace-source') throw new Error('The built-in GitSpace project base branch is managed by GitSpace releases');
    if (project.lifecycle !== 'active') throw new Error(`Project ${projectId} must be active to change its base branch`);
    if (project.revision !== expectedRevision) throw new Error(`Project revision conflict: expected ${expectedRevision}, actual ${project.revision}`);
    if (project.baseBranch === baseBranch) return project;
    try {
      await runGit(['check-ref-format', '--branch', baseBranch]);
      await runGit(['check-ref-format', `refs/heads/${baseBranch}`]);
    } catch {
      throw new Error(`${baseBranch} is not a valid branch name`);
    }
    return this.runLifecycleOperation(projectId, null, 'project.setBaseBranch', ['Switch base checkout', 'Update project'], async () => {
      const repositoryPath = await this.liveSourceRoot(this.database.getBaseSpace(projectId));
      if (!repositoryPath) throw new Error('Open this project\'s base space before changing its base branch.');
      if (await runGit(['status', '--porcelain', '--untracked-files=no'], repositoryPath)) {
        throw new Error('The base checkout has uncommitted changes. Commit or discard them before changing the base branch.');
      }
      const environment = project.repositoryReference ? await this.gitEnvironment?.(project.repositoryReference) ?? {} : {};
      if (project.repositoryReference) {
        if (!await runGit(['ls-remote', '--heads', 'origin', `refs/heads/${baseBranch}`], repositoryPath, environment)) {
          throw new Error(`Branch ${baseBranch} does not exist on the repository remote`);
        }
      } else if (!await runGit(['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}^{commit}`], repositoryPath).catch(() => '')) {
        throw new Error(`Branch ${baseBranch} does not exist in the base repository`);
      }
      const previous = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath)
        .catch(() => runGit(['rev-parse', '--verify', 'HEAD^{commit}'], repositoryPath));
      const definition = (await this.authority.listProjectWorkspaces(projectId)).find((workspace) => workspace.id === projectId && workspace.kind === 'base');
      const publishDefinition = (current: CloudWorkspaceDefinition, branch: string, sourceRef: string, revision: number) => this.authority.putProjectWorkspace(projectId, {
        id: current.id, projectId, kind: current.kind, name: current.name, branch, phase: current.phase,
        sourceKind: current.sourceKind, sourceRef, sourceCommit: current.sourceCommit,
        lifecycle: current.lifecycle, goalId: current.goalId, expectedRevision: revision,
      });
      let published: CloudWorkspaceDefinition | null = null;
      let localUpdated = false;
      try {
        if (project.repositoryReference) {
          await runGit(['fetch', '--no-tags', 'origin', `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`], repositoryPath, environment);
          await runGit(['remote', 'set-branches', '--add', 'origin', baseBranch], repositoryPath);
          await runGit(['checkout', '-B', baseBranch, `refs/remotes/origin/${baseBranch}`, '--'], repositoryPath);
          await runGit(['branch', `--set-upstream-to=origin/${baseBranch}`, baseBranch], repositoryPath);
        } else {
          await runGit(['checkout', baseBranch, '--'], repositoryPath);
        }
        if (definition) published = await publishDefinition(definition, baseBranch, definition.sourceKind === 'base' ? baseBranch : definition.sourceRef, definition.revision);
        localUpdated = this.database.setProjectBaseBranch(projectId, baseBranch) !== null;
        // The canonical project commits last, so a retry after any earlier failure repeats the whole switch.
        return await this.authority.setProjectBaseBranch(projectId, expectedRevision, baseBranch);
      } catch (error) {
        await runGit(['checkout', previous, '--'], repositoryPath).catch(() => undefined);
        if (definition && published) await publishDefinition(definition, definition.branch, definition.sourceRef, published.revision).catch(() => undefined);
        if (localUpdated) this.database.setProjectBaseBranch(projectId, project.baseBranch);
        throw error;
      }
    });
  }

  deleteWorkspace(projectId: string, workspaceId: string, expectedRevision?: number): Promise<boolean> {
    return this.runLifecycleOperation(projectId, workspaceId, 'workspace.delete', ['Remove worktree', 'Delete workspace authority'], async () => {
      const workspace = this.database.getWorkspace(workspaceId);
      if (workspace && workspace.projectId !== projectId) throw new Error('Local workspace identity does not match');
      if (workspace && workspace.placementState !== 'closed') throw new Error('Workspace must be archived before permanent deletion');
      const definition = (await this.authority.listProjectWorkspaces(projectId)).find((candidate) => candidate.id === workspaceId);
      if (!definition) return false;
      if (definition.projectId !== projectId || definition.kind !== 'worktree') throw new Error('Workspace identity does not match');
      const placement = await this.authority.getSpace(projectId, workspaceId);
      if (placement && (placement.projectId !== projectId || placement.spaceId !== workspaceId
          || placement.state !== 'closed' || placement.machineId !== null
          || placement.publishedRevision <= 0 || !placement.manifestKey || !placement.manifestHash)) {
        throw new Error('Workspace must be safely closed before permanent deletion');
      }
      // The cloud enforces completed resource retirement before any local data can be removed.
      if (!await this.authority.removeProjectWorkspace(projectId, workspaceId, expectedRevision ?? definition.revision)) return false;
      if (workspace) {
        const base = this.database.getBaseSpace(projectId);
        if (base) await runGit(['worktree', 'remove', '--force', workspace.rootPath], base.rootPath).catch(() => undefined);
        await rm(workspace.rootPath, { recursive: true, force: true });
        this.database.deleteWorkspace(workspaceId);
      }
      return true;
    });
  }

  deleteProject(projectId: string, expectedRevision: number): Promise<boolean> {
    return this.runLifecycleOperation(projectId, null, 'project.delete', ['Delete project authority', 'Remove local projection'], async () => {
      const project = await this.authority.getProject(projectId);
      if (!project) return false;
      if (project.lifecycle !== 'archived') throw new Error('Project must be archived before permanent deletion');
      const open = this.database.listWorkspaces(projectId).find((workspace) => workspace.placementState !== 'closed');
      if (open) throw new Error(`Workspace ${open.id} must be archived before deleting the project`);
      await this.requireClosedProjectWorkspaces(projectId);
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
    expectedRevision?: number,
  ): Promise<CloudWorkspaceDefinition> {
    const current = (await this.authority.listProjectWorkspaces(projectId)).find((workspace) => workspace.id === workspaceId);
    if (!current) throw new Error(`Workspace ${workspaceId} does not exist in project authority`);
    if (current.projectId !== projectId || current.kind !== 'worktree') throw new Error('Workspace identity does not match');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error(`Workspace revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
    if (lifecycle === 'active') {
      const placement = await this.authority.getSpace(projectId, workspaceId);
      if (!placement) throw new Error(`Workspace ${workspaceId} has no placement to recover`);
      if (placement.projectId !== projectId || placement.spaceId !== workspaceId) throw new Error('Workspace placement identity does not match');
      if ((placement.state !== 'closed' || placement.machineId !== null)
          && (placement.state !== 'open' || placement.machineId !== this.machineId)) {
        throw new Error('Workspace is transitioning or active on another machine');
      }
      if (placement.publishedRevision > 0 && (!placement.manifestKey || !placement.manifestHash)) {
        throw new Error('Workspace has no committed checkpoint to recover');
      }
      if (placement.publishedRevision === 0) {
        const local = this.database.getSpace(workspaceId);
        if (placement.state !== 'open' || placement.machineId !== this.machineId ||
            !local || local.placementState !== 'open' || local.holderId !== this.machineId ||
            local.generation !== placement.generation) {
          throw new Error('Initial checkpoint recovery requires the matching locally held open generation');
        }
        if (!this.checkpointSpace) throw new Error('Initial checkpoint recovery is unavailable');
        // Release publishes without removing the retained checkout; reopen before activation.
        await this.checkpointSpace(workspaceId);
        const recovered = await this.authority.getSpace(projectId, workspaceId);
        if (!recovered || recovered.publishedRevision === 0 || !recovered.manifestKey ||
            recovered.state !== 'open' || recovered.machineId !== this.machineId) {
          throw new Error('Initial checkpoint recovery did not publish and reopen the workspace');
        }
      }
    }
    return this.authority.putProjectWorkspace(projectId, {
      id: current.id,
      projectId: current.projectId,
      kind: current.kind,
      name: current.name,
      branch: current.branch,
      phase: current.phase,
      sourceKind: current.sourceKind,
      sourceRef: current.sourceRef,
      sourceCommit: current.sourceCommit,
      lifecycle,
      goalId: current.goalId,
      expectedRevision: current.revision,
    });
  }

  async setWorkspacePhase(projectId: string, workspaceId: string, phase: Workspace['phase'], expectedRevision?: number): Promise<CloudWorkspaceDefinition> {
    const current = (await this.authority.listProjectWorkspaces(projectId)).find((workspace) => workspace.id === workspaceId);
    if (!current) throw new Error(`Workspace ${workspaceId} does not exist in project authority`);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error(`Workspace revision conflict: expected ${expectedRevision}, actual ${current.revision}`);
    return this.authority.putProjectWorkspace(projectId, {
      id: current.id,
      projectId: current.projectId,
      kind: current.kind,
      name: current.name,
      branch: current.branch,
      phase,
      sourceKind: current.sourceKind,
      sourceRef: current.sourceRef,
      sourceCommit: current.sourceCommit,
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
