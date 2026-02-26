import { existsSync, mkdirSync, writeFileSync } from 'fs';
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
import { SpacesError } from '../types/errors.js';
import { extractRepoName, isValidBranchName, sanitizeForFileSystem } from '../utils/sanitize.js';
import { generateMarkdown } from '../utils/markdown.js';
import type { SessionLinearIssueSummary, WorkspaceSource } from '../types/lifecycle.js';

export interface SessionCreateProjectParams {
  repository: string;
  projectName?: string;
  baseBranch?: string;
  setCurrent?: boolean;
}

export interface SessionCreateProjectResult {
  projectName: string;
  repository: string;
  baseBranch: string;
}

export interface SessionCreateWorkspaceParams {
  projectName: string;
  workspaceName: string;
  branchName?: string;
  baseBranch?: string;
  workspaceSource?: WorkspaceSource;
  linearIssue?: SessionLinearIssueSummary;
  onProgress?: (message: string) => void;
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

  return {
    projectName,
    repository,
    baseBranch,
  };
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

  const baseBranch = params.baseBranch?.trim() || config.baseBranch;
  const existsRemotely = await checkRemoteBranch(baseDir, branchName);

  await createWorktree(baseDir, workspacePath, branchName, baseBranch, {
    existsRemotely,
    onProgress: params.onProgress,
  });

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

  syncBundleWorkspaceState(projectName, workspacePath);

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
