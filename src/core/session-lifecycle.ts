import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import {
  createProject,
  getAllProjectNames,
  getProjectBaseDir,
  getProjectDir,
  getProjectWorkspacesDir,
  projectExists,
  readProjectConfig,
  setCurrentProject,
} from './config.js';
import { cloneRepository, checkRemoteBranch, createWorktree, getDefaultBranch, listRemoteBranches } from './git.js';
import { listAllRepos } from './github.js';
import { fetchUnstartedIssues, getLinearConfig } from './linear.js';
import { deleteProjectCore } from './workspace.js';
import { syncBundleWorkspaceState } from './bundle-refresh.js';
import { bindPlannedGoalForWorkspace } from './goal-chain.js';
import { detectBundleInRepo, loadBundleFromPath } from './bundle.js';
import { applyProjectBundleState } from './project-lifecycle.js';
import { SpacesError } from '../types/errors.js';
import { extractRepoName, isValidBranchName, sanitizeForFileSystem } from '../utils/sanitize.js';
import { generateMarkdown } from '../utils/markdown.js';
import type { SessionLinearIssueSummary, WorkspaceSource } from '../types/lifecycle.js';
import type { ConfirmStep, ConfirmStepResult, SpacesBundle } from '../types/bundle.js';
import { checkCommandExists } from '../utils/deps.js';

export interface SessionCreateProjectParams {
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
  /** Create a from-scratch project: git init the base repo locally instead of
   *  cloning (`repository` is ignored). GitHub is a later, optional attachment
   *  (docs/ARTIFACTS-FS.md — project creation & FTUE). */
  scratch?: boolean;
}

export interface SessionCreateProjectResult {
  projectName: string;
  repository: string;
  baseBranch: string;
}

export interface SessionPrepareProjectResult {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  confirmStatuses?: Record<string, 'found' | 'missing'>;
}

export interface SessionFinalizeProjectParams {
  projectName: string;
  repository: string;
  baseBranch: string;
  bundle?: SpacesBundle;
  inputValues?: Record<string, string>;
  secretValues?: Record<string, string>;
  confirmResults?: Record<string, ConfirmStepResult>;
  setCurrent?: boolean;
}

export interface SessionCreateWorkspaceParams {
  projectName: string;
  workspaceName: string;
  branchName?: string;
  baseBranch?: string;
  workspaceSource?: WorkspaceSource;
  linearIssue?: SessionLinearIssueSummary;
  onProgress?: (message: string) => void;
  parentWorkspaceName?: string;
}

export interface SessionCreateWorkspaceResult {
  projectName: string;
  workspaceName: string;
  workspaceId: string;
  branchName: string;
}

export interface SessionDeleteProjectParams {
  projectName: string;
  onProgress?: (message: string) => void;
}

function runGit(args: string[], cwd: string): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function createStackedWorktreeFromParent(projectName: string, parentWorkspaceName: string, workspacePath: string, branchName: string): boolean {
  const parentPath = join(getProjectWorkspacesDir(projectName), parentWorkspaceName);
  if (!existsSync(parentPath)) {
    return false;
  }
  const parentBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], parentPath);
  const parentRef = parentBranch && parentBranch !== 'HEAD'
    ? parentBranch
    : runGit(['rev-parse', 'HEAD'], parentPath);
  if (!parentRef) {
    return false;
  }
  try {
    execFileSync('git', ['worktree', 'add', '-b', branchName, workspacePath, parentRef, '--no-track'], {
      cwd: getProjectBaseDir(projectName),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function sanitizeProjectName(input: string): string {
  const sanitized = sanitizeForFileSystem(input);
  if (!sanitized) {
    throw new SpacesError('Project name must contain at least one letter or number.', 'USER_ERROR', 1);
  }
  return sanitized;
}

function validateRepository(repository: string): string {
  const trimmed = repository.trim();
  if (!trimmed) {
    throw new SpacesError('Repository is required.', 'USER_ERROR', 1);
  }

  const looksLikeOwnerRepo = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(trimmed);
  const looksLikeRemoteUrl =
    trimmed.includes('://') ||
    trimmed.startsWith('git@') ||
    trimmed.startsWith('ssh://');

  if (!looksLikeOwnerRepo && !looksLikeRemoteUrl) {
    throw new SpacesError(
      'Repository must be a git remote URL or owner/repo shorthand.',
      'USER_ERROR',
      1
    );
  }

  return trimmed;
}

function assertRepositoryNotTracked(repository: string): void {
  const existingProjects = getAllProjectNames();
  for (const existingProject of existingProjects) {
    try {
      const existingConfig = readProjectConfig(existingProject);
      if (existingConfig.repository === repository) {
        throw new SpacesError(
          `Repository ${repository} is already tracked by project "${existingProject}".`,
          'USER_ERROR',
          1
        );
      }
    } catch (error) {
      if (error instanceof SpacesError && error.code === 'USER_ERROR') {
        throw error;
      }
    }
  }
}

async function resolveConfirmStatuses(bundle: SpacesBundle | undefined): Promise<Record<string, 'found' | 'missing'> | undefined> {
  const steps = (bundle?.onboarding ?? []).filter(
    (step): step is ConfirmStep =>
      step.type === 'confirm' && typeof step.checkCommand === 'string' && step.checkCommand.length > 0
  );
  if (!steps || steps.length === 0) {
    return undefined;
  }

  const entries = await Promise.all(
    steps.map(async (step) => {
      const found = step.checkCommand ? await checkCommandExists(step.checkCommand) : false;
      return [step.id, found ? 'found' : 'missing'] as const;
    })
  );

  return Object.fromEntries(entries);
}

function resolveWorkspaceAndBranchNames(
  workspaceNameInput: string,
  branchNameInput?: string
): { workspaceName: string; branchName: string } {
  const rawWorkspaceName = workspaceNameInput.trim();
  if (!rawWorkspaceName) {
    throw new SpacesError('Workspace name is required.', 'USER_ERROR', 1);
  }

  const workspaceName = sanitizeForFileSystem(rawWorkspaceName);
  if (!workspaceName) {
    throw new SpacesError('Workspace name must contain at least one letter or number.', 'USER_ERROR', 1);
  }

  const branchName = branchNameInput?.trim() || rawWorkspaceName;
  if (!isValidBranchName(branchName)) {
    throw new SpacesError(
      `Invalid branch name: ${branchName}. Branch names cannot contain spaces, '..', or characters like : ? * [ \\ ~`,
      'USER_ERROR',
      1
    );
  }

  return { workspaceName, branchName };
}

export async function listGithubReposForSession(org?: string): Promise<string[]> {
  return listAllRepos(org);
}

export async function listRemoteBranchesForSession(projectName: string): Promise<string[]> {
  const trimmedProjectName = projectName.trim();
  if (!trimmedProjectName) {
    throw new SpacesError('Project name is required.', 'USER_ERROR', 1);
  }

  const config = readProjectConfig(trimmedProjectName);
  const baseDir = getProjectBaseDir(trimmedProjectName);
  const branches = await listRemoteBranches(baseDir);
  return branches.filter((branch) => branch !== config.baseBranch);
}

export async function listLinearIssuesForSession(
  projectName: string
): Promise<SessionLinearIssueSummary[]> {
  const trimmedProjectName = projectName.trim();
  if (!trimmedProjectName) {
    throw new SpacesError('Project name is required.', 'USER_ERROR', 1);
  }

  const linearConfig = await getLinearConfig(trimmedProjectName);
  if (!linearConfig.apiKey || linearConfig.teamKeys.length === 0) {
    throw new SpacesError(
      "Linear is not configured. Run 'gssh user config linear setup' to configure.",
      'USER_ERROR',
      1
    );
  }

  const teamKey = linearConfig.teamKeys[0];
  if (!teamKey) {
    throw new SpacesError('No Linear team configured for this project.', 'USER_ERROR', 1);
  }

  const issues = await fetchUnstartedIssues(linearConfig.apiKey, teamKey);
  const summaries: SessionLinearIssueSummary[] = [];

  for (const issue of issues) {
    const [assignee, state, attachments] = await Promise.all([
      issue.assignee,
      issue.state,
      issue.attachments(),
    ]);

    summaries.push({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      assigneeName: assignee?.name ?? null,
      stateName: state?.name ?? null,
      createdAt: issue.createdAt.toISOString(),
      updatedAt: issue.updatedAt.toISOString(),
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        url: attachment.url,
        title: attachment.title,
        sourceType: attachment.sourceType,
        createdAt: attachment.createdAt.toISOString(),
      })),
    });
  }

  return summaries;
}

export async function createProjectForSession(
  params: SessionCreateProjectParams
): Promise<SessionCreateProjectResult> {
  if (params.scratch) return createScratchProjectForSession(params);
  const repository = validateRepository(params.repository);
  const projectName = sanitizeProjectName(params.projectName?.trim() || extractRepoName(repository));

  if (projectExists(projectName)) {
    throw new SpacesError(`Project "${projectName}" already exists.`, 'USER_ERROR', 1);
  }

  assertRepositoryNotTracked(repository);

	const projectDir = getProjectDir(projectName);
  mkdirSync(projectDir, { recursive: true });

  const baseDir = getProjectBaseDir(projectName);
  await cloneRepository(repository, baseDir);

  const baseBranch = params.baseBranch?.trim() || (await getDefaultBranch(baseDir));
  createProject(projectName, repository, baseBranch);

  if (params.setCurrent ?? true) {
    setCurrentProject(projectName);
  }

  await mountProjectArtifacts(projectName, baseDir);

  return {
    projectName,
    repository,
    baseBranch,
  };
}

/** Artifacts FS: birth the project's artifacts repo + mount main at the base
 *  clone; if the code repo carries a committed .gitspace/artifacts.json BYO
 *  pointer, attach + fetch the remote (docs/ARTIFACTS-FS.md). Best-effort —
 *  never fail project creation. */
async function mountProjectArtifacts(projectName: string, baseDir: string): Promise<void> {
  try {
    const artifacts = await import('./artifacts.js');
    const projectDir = getProjectDir(projectName);
    // Attach a declared BYO remote BEFORE mounting so the fetched main is what
    // gets checked out (fresh clones rediscover their artifacts automatically).
    const pointer = artifacts.readArtifactsPointerConfig(baseDir);
    if (pointer?.remote) {
      await artifacts.setArtifactsRemote(projectDir, pointer.remote);
      try {
        await artifacts.syncArtifacts(projectDir);
        console.error(`[artifacts] adopted shared remote for ${projectName}: ${pointer.remote}`);
      } catch (e) {
        // Mount proceeds locally, but say so — a teammate who can't reach the
        // remote must not silently believe they're sharing.
        console.error(`[artifacts] ${projectName}: remote ${pointer.remote} configured but first sync FAILED (${e instanceof Error ? e.message.split('\n')[0] : e}) — check access (gh auth login), then \`gssh artifacts sync\``);
      }
    }
    await artifacts.ensureArtifactsMount(projectDir, baseDir, 'main');
  } catch {
    /* artifacts are additive */
  }
}

/** From-scratch project: no repo required. `git init` the base, seed an
 *  initial commit, and attach nothing — GitHub/publish is a later rung. */
async function createScratchProjectForSession(
  params: SessionCreateProjectParams
): Promise<SessionCreateProjectResult> {
  const rawName = params.projectName?.trim() || params.repository?.trim();
  if (!rawName) {
    throw new SpacesError('Project name is required for a from-scratch project.', 'USER_ERROR', 1);
  }
  const projectName = sanitizeProjectName(rawName);
  if (projectExists(projectName)) {
    throw new SpacesError(`Project "${projectName}" already exists.`, 'USER_ERROR', 1);
  }
  const baseBranch = params.baseBranch?.trim() || 'main';
  const projectDir = getProjectDir(projectName);
  const baseDir = getProjectBaseDir(projectName);
  mkdirSync(baseDir, { recursive: true });
  execFileSync('git', ['init', '-q', '--initial-branch', baseBranch, baseDir]);
  writeFileSync(join(baseDir, 'README.md'), `# ${projectName}\n\nCreated with gitspace. Publish to a remote whenever you're ready.\n`);
  execFileSync('git', ['-C', baseDir, 'add', 'README.md']);
  execFileSync('git', [
    '-C', baseDir,
    '-c', 'user.name=gitspace', '-c', 'user.email=init@gitspace.sh', '-c', 'commit.gpgsign=false',
    'commit', '-q', '-m', 'init project',
  ]);

  createProject(projectName, 'local', baseBranch);
  if (params.setCurrent ?? true) {
    setCurrentProject(projectName);
  }
  await mountProjectArtifacts(projectName, baseDir);

  return { projectName, repository: 'local', baseBranch };
}

export async function prepareProjectForSession(
  params: SessionCreateProjectParams
): Promise<SessionPrepareProjectResult> {
  const repository = validateRepository(params.repository);
  const projectName = sanitizeProjectName(params.projectName?.trim() || extractRepoName(repository));

  if (projectExists(projectName)) {
    throw new SpacesError(`Project "${projectName}" already exists.`, 'USER_ERROR', 1);
  }

  assertRepositoryNotTracked(repository);

  const projectDir = getProjectDir(projectName);
  if (existsSync(projectDir)) {
    throw new SpacesError(
      `Project directory already exists for "${projectName}". Remove it or complete the existing setup first.`,
      'USER_ERROR',
      1
    );
  }

  mkdirSync(projectDir, { recursive: true });

  try {
    const baseDir = getProjectBaseDir(projectName);
    await cloneRepository(repository, baseDir);

    const baseBranch = params.baseBranch?.trim() || (await getDefaultBranch(baseDir));
    const bundleDir = detectBundleInRepo(baseDir);
    const loadedBundle = bundleDir ? loadBundleFromPath(bundleDir) : null;

    return {
      projectName,
      repository,
      baseBranch,
      bundle: loadedBundle?.bundle,
      confirmStatuses: await resolveConfirmStatuses(loadedBundle?.bundle),
    };
  } catch (error) {
    rmSync(projectDir, { recursive: true, force: true });
    throw error;
  }
}

export async function finalizePreparedProjectForSession(
  params: SessionFinalizeProjectParams
): Promise<SessionCreateProjectResult> {
  const repository = validateRepository(params.repository);
  const projectName = sanitizeProjectName(params.projectName.trim());

  if (projectExists(projectName)) {
    throw new SpacesError(`Project "${projectName}" already exists.`, 'USER_ERROR', 1);
  }

  const baseDir = getProjectBaseDir(projectName);
  if (!existsSync(baseDir)) {
    throw new SpacesError(
      `Prepared project files for "${projectName}" were not found. Start project creation again.`,
      'USER_ERROR',
      1
    );
  }

  createProject(projectName, repository, params.baseBranch);

  if (params.bundle) {
    await applyProjectBundleState({
      projectName,
      bundle: params.bundle,
      inputValues: params.inputValues,
      secretValues: params.secretValues,
      confirmResults: params.confirmResults,
    });
  }

  if (params.setCurrent ?? true) {
    setCurrentProject(projectName);
  }

  return {
    projectName,
    repository,
    baseBranch: params.baseBranch,
  };
}

export async function cancelPreparedProjectForSession(projectNameInput: string): Promise<void> {
  const projectName = sanitizeProjectName(projectNameInput.trim());
  if (projectExists(projectName)) {
    throw new SpacesError(`Project "${projectName}" already exists.`, 'USER_ERROR', 1);
  }

  const projectDir = getProjectDir(projectName);
  if (!existsSync(projectDir)) {
    return;
  }

  rmSync(projectDir, { recursive: true, force: true });
}

export async function createWorkspaceForSession(
  params: SessionCreateWorkspaceParams
): Promise<SessionCreateWorkspaceResult> {
  const projectName = params.projectName.trim();
  if (!projectName) {
    throw new SpacesError('Project name is required.', 'USER_ERROR', 1);
  }

  const config = readProjectConfig(projectName);
  const { workspaceName, branchName } = resolveWorkspaceAndBranchNames(
    params.workspaceName,
    params.branchName
  );

  const baseDir = getProjectBaseDir(projectName);
  const workspacesDir = getProjectWorkspacesDir(projectName);
  const workspacePath = join(workspacesDir, workspaceName);

  if (existsSync(workspacePath)) {
    throw new SpacesError(`Workspace "${workspaceName}" already exists.`, 'USER_ERROR', 1);
  }

  const createdFromParent = params.parentWorkspaceName
    ? createStackedWorktreeFromParent(projectName, params.parentWorkspaceName, workspacePath, branchName)
    : false;

  if (!createdFromParent) {
    const baseBranch = params.baseBranch?.trim() || config.baseBranch;
    const existsRemotely = await checkRemoteBranch(baseDir, branchName);

    await createWorktree(baseDir, workspacePath, branchName, baseBranch, {
      existsRemotely,
      onProgress: params.onProgress,
    });
  }

  if (params.workspaceSource === 'linear' && params.linearIssue) {
    const linearConfig = await getLinearConfig(projectName);
    const issueArtifactDir = join(workspacePath, 'gitspace', workspaceName);
    mkdirSync(issueArtifactDir, { recursive: true });
    const markdown = await generateMarkdown(
      params.linearIssue,
      issueArtifactDir,
      linearConfig.apiKey ?? undefined
    );
    writeFileSync(join(issueArtifactDir, 'issue.md'), markdown, 'utf-8');
  }
  bindPlannedGoalForWorkspace(projectName, workspaceName);

  syncBundleWorkspaceState(projectName, workspacePath);

  // Artifacts FS: branch-per-workspace mount at .gitspace/artifacts
  // (docs/ARTIFACTS-FS.md). Best-effort — never fail workspace creation.
  try {
    const { ensureArtifactsMount } = await import('./artifacts.js');
    await ensureArtifactsMount(getProjectDir(projectName), workspacePath, workspaceName);
  } catch {
    /* artifacts mount is additive; workspace remains usable without it */
  }

  return {
    projectName,
    workspaceName,
    workspaceId: `${projectName}:${workspaceName}`,
    branchName,
  };
}

export async function deleteProjectForSession(params: SessionDeleteProjectParams): Promise<void> {
  const projectName = params.projectName.trim();
  if (!projectName) {
    throw new SpacesError('Project name is required.', 'USER_ERROR', 1);
  }

  const result = await deleteProjectCore(projectName, {
    nonInteractive: true,
    onProgress: params.onProgress,
  });

  if (!result.success) {
    const details = result.errors.length > 0 ? ` ${result.errors.join('; ')}` : '';
    throw new SpacesError(`Failed to delete project "${projectName}".${details}`.trim(), 'SYSTEM_ERROR', 2);
  }
}
