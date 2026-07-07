/**
 * Add command implementation
 * Handles project/workspace creation for the namespaced CLI.
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import {
  readProjectConfig,
  createProject,
  setCurrentProject,
  getProjectBaseDir,
  getProjectDir,
  getProjectWorkspacesDir,
  getAllProjectNames,
  projectExists,
} from '../core/config.js';
import { setWorkspaceStatus } from '../core/workspace-metadata.js';
import { bindPlannedGoalForWorkspace } from '../core/goal-chain.js';
import { checkCommandExists, checkGitHubAuth, ensureDependencies } from '../utils/deps.js';
import { selectItem, promptConfirm, promptInput } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { listAllRepos } from '../core/github.js';
import {
  cloneRepository,
  getDefaultBranch,
  createWorktree,
  checkRemoteBranch,
  listRemoteBranches,
} from '../core/git.js';
import { openWorkspaceShell } from '../core/shell.js';
import { fetchUnstartedIssues, getLinearConfig } from '../core/linear.js';
import {
  sanitizeForFileSystem,
  generateWorkspaceName,
  extractRepoName,
  isValidBranchName,
} from '../utils/sanitize.js';
import {
  SpacesError,
  NoProjectError,
  ProjectExistsError,
  WorkspaceExistsError,
} from '../types/errors.js';
import type { CreateWorkspaceOptions } from '../types/workspace.js';
import { generateMarkdown } from '../utils/markdown.js';
import {
  detectBundleInRepo,
  loadBundleFromPath,
  loadBundleFromUrl,
  cleanupBundleDir,
} from '../core/bundle.js';
import {
  syncBundleWorkspaceState,
} from '../core/bundle-refresh.js';
import { KEEP_EXISTING_SECRET, runOnboarding } from '../utils/onboarding.js';
import { applyProjectBundleState } from '../core/project-lifecycle.js';
import type { LoadedBundle, OnboardingResult } from '../types/bundle.js';

/**
 * Add a new project
 */
export async function addProject(options: {
  noClone?: boolean;
  org?: string;
  linearKey?: string;
  bundleUrl?: string;
  bundlePath?: string;
  skipBundle?: boolean;
}): Promise<void> {
  // Check dependencies
  await ensureDependencies();
  const canUseGitHubPicker = await checkCommandExists('gh');
  let selectedRepo: string;

  if (canUseGitHubPicker) {
    const source = await selectItem([
      'Enter git remote URL',
      'Choose GitHub repository',
    ], 'How would you like to add a project?');

    if (!source) {
      logger.info('Cancelled');
      return;
    }

    if (source === 'Choose GitHub repository') {
      await checkGitHubAuth();
      logger.info('Fetching repositories...');
      const repos = await listAllRepos(options.org);

      if (repos.length === 0) {
        throw new SpacesError(
          'No repositories found',
          'USER_ERROR',
          1
        );
      }

      const pickedRepo = await selectItem(repos, 'Select a repository:');
      if (!pickedRepo) {
        logger.info('Cancelled');
        return;
      }
      selectedRepo = pickedRepo;
    } else {
      const manualRepo = await promptInput('Enter git remote URL (or owner/repo):', {
        validate: (input) => input.trim().length > 0 || 'Repository is required',
      });

      if (!manualRepo) {
        logger.info('Cancelled');
        return;
      }

      selectedRepo = manualRepo.trim();
    }
  } else {
    logger.info('GitHub CLI not found. Using direct git remote flow.');
    const manualRepo = await promptInput('Enter git remote URL (or owner/repo):', {
      validate: (input) => input.trim().length > 0 || 'Repository is required',
    });

    if (!manualRepo) {
      logger.info('Cancelled');
      return;
    }

    selectedRepo = manualRepo.trim();
  }

  logger.success(`Selected: ${selectedRepo}`);

  // Extract repo name for project directory
  const projectName = extractRepoName(selectedRepo);

  // Check if project already exists
  if (projectExists(projectName)) {
    throw new ProjectExistsError(
      projectName,
      getProjectBaseDir(projectName)
    );
  }

  // Check for duplicate repositories
  const existingProjects = getAllProjectNames();
  for (const existingProject of existingProjects) {
    const existingConfig = readProjectConfig(existingProject);
    if (existingConfig.repository === selectedRepo) {
      throw new SpacesError(
        `Repository ${selectedRepo} is already tracked by project "${existingProject}"\n\nUse that project with:\n  gssh workspace list --project ${existingProject}`,
        'USER_ERROR',
        1
      );
    }
  }

  // Clone the repository unless --no-clone
  const baseDir = getProjectBaseDir(projectName);

  if (!options.noClone) {
    mkdirSync(dirname(baseDir), { recursive: true });
    logger.info(`Cloning to ${baseDir}...`);
    await cloneRepository(selectedRepo, baseDir);
    logger.success(`Cloned to ${baseDir}`);
  }

  // Detect default branch
  const baseBranch = await getDefaultBranch(baseDir);
  logger.debug(`Detected default branch: ${baseBranch}`);

  // Handle bundle detection and loading
  let loadedBundle: LoadedBundle | null = null;
  let onboardingResult: OnboardingResult | null = null;

  if (!options.skipBundle) {
    if (options.bundleUrl) {
      // Load from explicit URL
      loadedBundle = await loadBundleFromUrl(options.bundleUrl);
    } else if (options.bundlePath) {
      // Load from explicit local path
      loadedBundle = loadBundleFromPath(options.bundlePath);
    } else if (!options.noClone) {
      // Detect bundle in cloned repo
      const bundleDir = detectBundleInRepo(baseDir);
      if (bundleDir) {
        loadedBundle = loadBundleFromPath(bundleDir);
        logger.info(`Detected spaces bundle: ${loadedBundle.bundle.name}`);
      }
    }

    // Run onboarding if bundle has steps
    if (loadedBundle?.bundle.onboarding && loadedBundle.bundle.onboarding.length > 0) {
      const proceed = await promptConfirm(
        `This repository has ${loadedBundle.bundle.onboarding.length} onboarding step(s). Run them now?`,
        true
      );

      if (proceed) {
        onboardingResult = await runOnboarding(loadedBundle.bundle.onboarding);

        if (!onboardingResult.completed) {
          const continueAnyway = await promptConfirm(
            'Continue creating project without completing onboarding?',
            false
          );
          if (!continueAnyway) {
            // Clean up bundle temp dir if from URL
            if (loadedBundle) {
              cleanupBundleDir(loadedBundle.bundleDir);
            }
            logger.info('Cancelled');
            return;
          }
        }
      }
    }
  }

  // Create project configuration
  createProject(
    projectName,
    selectedRepo,
    baseBranch
  );

  // Store bundle info if bundle was loaded (scripts are read from workspace .gitspace/scripts/)
  if (loadedBundle) {
    if (onboardingResult?.completed) {
      const secretValues = Object.fromEntries(
        Object.entries(onboardingResult.secretValues)
          .filter(([, value]) => value && value !== KEEP_EXISTING_SECRET)
      );

      await applyProjectBundleState({
        projectName,
        bundle: loadedBundle.bundle,
        inputValues: onboardingResult.inputValues,
        secretValues,
        confirmResults: onboardingResult.confirmResults,
      });
    } else {
      await applyProjectBundleState({
        projectName,
        bundle: loadedBundle.bundle,
      });
    }

    // Clean up temp directory if bundle was from URL
    cleanupBundleDir(loadedBundle.bundleDir);
  }

  // Artifacts FS: birth the project's artifacts repo and mount main at the
  // base clone (docs/ARTIFACTS-FS.md). Best-effort — never fail project add.
  // A committed .gitspace/artifacts.json pointer is ADOPTED here — this is
  // the teammate path: clone a repo that shares artifacts, get wired up.
  // (Previously only the web/session project-create path adopted; CLI
  // teammates silently got a local-only repo.)
  try {
    const artifacts = await import('../core/artifacts.js');
    if (existsSync(baseDir)) {
      const pointer = artifacts.readArtifactsPointerConfig(baseDir);
      if (pointer?.remote) {
        await artifacts.setArtifactsRemote(getProjectDir(projectName), pointer.remote);
        try {
          await artifacts.syncArtifacts(getProjectDir(projectName));
          logger.success(`Artifacts sharing adopted from the repo: ${pointer.remote}`);
        } catch (error) {
          logger.warning(`Artifacts remote configured (${pointer.remote}) but the first sync failed: ${error instanceof Error ? error.message.split('\n')[0] : error}`);
          logger.info('Check access (GitHub: `gh auth login`), then run: gssh artifacts sync');
        }
      } else {
        logger.info('Artifacts: local repo only (no sharing pointer in the code repo).');
      }
      await artifacts.ensureArtifactsMount(getProjectDir(projectName), baseDir, 'main');
    }
  } catch (error) {
    logger.warning(`Artifacts repo skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  logger.success(`Project '${projectName}' created`);

  // Set as current project
  setCurrentProject(projectName);
  logger.success('Set as current project');
}

/**
 * Add a new workspace
 */
export async function addWorkspace(
  workspaceNameArg: string | undefined,
  options: (Partial<CreateWorkspaceOptions> & { project: string })
): Promise<void> {
  const currentProject = options.project;
  if (!currentProject) {
    throw new NoProjectError();
  }

  const projectConfig = readProjectConfig(currentProject);
  const baseDir = getProjectBaseDir(currentProject);
  const workspacesDir = getProjectWorkspacesDir(currentProject);

  let workspaceName: string;
  let branchName: string;

  let existsRemotely = false;
  let selectedLinearIssue: Awaited<ReturnType<typeof fetchUnstartedIssues>>[0] | undefined;

  if (workspaceNameArg) {
    // Workspace name provided as argument - sanitize it (allows branch-like names like fix/bla-bla-blah)
    const sanitizedName = sanitizeForFileSystem(workspaceNameArg);
    if (!sanitizedName) {
      throw new SpacesError(
        `Invalid workspace name: ${workspaceNameArg}\nName must contain at least one letter or number.`,
        'USER_ERROR',
        1
      );
    }

    workspaceName = sanitizedName;
    // Use original input as branch name if no explicit branch specified (preserves slashes)
    branchName = options.branchName || workspaceNameArg;

    // Validate the branch name is a valid git ref
    if (!isValidBranchName(branchName)) {
      throw new SpacesError(
        `Invalid branch name: ${branchName}\nBranch names cannot contain spaces, .., or special characters like : ? * [ \\ ~`,
        'USER_ERROR',
        1
      );
    }
  } else {
    // No workspace name provided, prompt for source
    const sourceOptions = ['Create from GitHub branch', 'Create with manual name'];

    // Add Linear option if configured
    const linearConfig = await getLinearConfig(currentProject);
    if (linearConfig.apiKey && linearConfig.teamKeys.length > 0) {
      sourceOptions.splice(1, 0, 'Create from Linear issue');
    }

    const source = await selectItem(sourceOptions, 'How would you like to create the workspace?');

    if (!source) {
      logger.info('Cancelled');
      return;
    }

    if (source === 'Create from GitHub branch') {
      // List remote branches
      logger.info('Fetching remote branches...');
      const allBranches = await listRemoteBranches(baseDir);

      // Filter out the base branch
      const branches = allBranches.filter((branch) => branch !== projectConfig.baseBranch);

      if (branches.length === 0) {
        throw new SpacesError(
          `No remote branches found (excluding base branch ${projectConfig.baseBranch})`,
          'USER_ERROR',
          1
        );
      }

      const selectedBranch = await selectItem(branches, 'Select a branch:');

      if (!selectedBranch) {
        logger.info('Cancelled');
        return;
      }

      // Use branch name as workspace name (sanitize for filesystem safety)
      workspaceName = sanitizeForFileSystem(selectedBranch);
      branchName = selectedBranch;
      existsRemotely = true; // We know it exists remotely
    } else if (source === 'Create from Linear issue') {
      // Fetch unstarted issues from Linear
      logger.info('Fetching Linear issues...');

      const teamKey = linearConfig.teamKeys[0];
      if (!teamKey) {
        throw new SpacesError('No Linear team configured', 'USER_ERROR', 1);
      }
      const issues = await fetchUnstartedIssues(linearConfig.apiKey!, teamKey);

      if (issues.length === 0) {
        throw new SpacesError(
          'No unstarted Linear issues found',
          'USER_ERROR',
          1
        );
      }

      // Format for selection
      const issueOptions = issues.map(
        (issue) => `${issue.identifier} - ${issue.title}`
      );

      const selectedIssueString = await selectItem(issueOptions, 'Select an issue:');

      if (!selectedIssueString) {
        logger.info('Cancelled');
        return;
      }

      // Find the corresponding LinearIssue object
      const [identifier] = selectedIssueString.split(' - ');
      selectedLinearIssue = issues.find(issue => issue.identifier === identifier);

      if (!selectedLinearIssue) {
        throw new SpacesError(
          `Failed to find Linear issue with identifier ${identifier}`,
          'SYSTEM_ERROR',
          2
        );
      }

      // Generate workspace name
      workspaceName = generateWorkspaceName(selectedLinearIssue.identifier, selectedLinearIssue.title);
      branchName = options.branchName || workspaceName;
    } else {
      // Manual entry - accepts branch-like names (e.g., fix/bla-bla-blah) and sanitizes them
      const name = await promptInput('Enter workspace name (branch-like names will be sanitized):', {
        validate: (input) => {
          if (!input || input.trim().length === 0) {
            return 'Workspace name is required';
          }
          const sanitized = sanitizeForFileSystem(input);
          if (!sanitized) {
            return 'Name must contain at least one letter or number';
          }
          // Validate it can be used as a branch name
          if (!isValidBranchName(input)) {
            return 'Invalid branch name (no spaces, .., or special chars like : ? * [ \\ ~)';
          }
          return true;
        },
      });

      if (!name) {
        logger.info('Cancelled');
        return;
      }

      const sanitizedName = sanitizeForFileSystem(name);
      workspaceName = sanitizedName;
      // Use original input as branch name (preserves slashes)
      branchName = options.branchName || name;
    }
  }

  const workspacePath = join(workspacesDir, workspaceName);

  // Check if workspace already exists
  if (existsSync(workspacePath)) {
    throw new WorkspaceExistsError(workspaceName);
  }

  logger.info(`Creating workspace: ${workspaceName}`);

  // Check if branch exists remotely (if we don't already know)
  if (!existsRemotely) {
    existsRemotely = await checkRemoteBranch(baseDir, branchName);

    if (existsRemotely) {
      // Prompt user
      const pullRemote = await promptConfirm(`Branch '${branchName}' exists on remote. Pull it down?`, true);

      if (!pullRemote) {
        logger.info('Cancelled');
        return;
      }
    }
  }

  // Create worktree
  const baseBranch = options.fromBranch || projectConfig.baseBranch;
  await createWorktree(
    baseDir,
    workspacePath,
    branchName,
    baseBranch,
    existsRemotely
  );

  const phase = options.status ?? 'code';
  setWorkspaceStatus(currentProject, workspaceName, phase);
  let boundGoal: ReturnType<typeof bindPlannedGoalForWorkspace> = null;
  try {
    boundGoal = bindPlannedGoalForWorkspace(currentProject, workspaceName);
  } catch (error) {
    logger.warning(`Workspace created, but failed to bind planned goal: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (boundGoal) {
    logger.success(`Created worktree from ${baseBranch} and bound goal '${boundGoal.title}' (phase: ${boundGoal.phase})`);
  } else {
    logger.success(`Created worktree from ${baseBranch} (phase: ${phase})`);
  }

  // Register workspace bundle requirements in project-level metadata.
  const bundleSync = syncBundleWorkspaceState(currentProject, workspacePath);
  if (bundleSync.parseError) {
    logger.warning(`Bundle parse error: ${bundleSync.parseError}`);
  }

  // Artifacts FS: branch-per-workspace mount at .gitspace/artifacts
  // (docs/ARTIFACTS-FS.md). Best-effort — never fail workspace creation.
  try {
    const { ensureArtifactsMount } = await import('../core/artifacts.js');
    await ensureArtifactsMount(getProjectDir(currentProject), workspacePath, workspaceName);
  } catch (error) {
    logger.warning(`Artifacts mount skipped: ${error instanceof Error ? error.message : String(error)}`);
  }

  // If workspace was created from a Linear issue, save issue details as markdown
  if (selectedLinearIssue) {
    const issueLinearConfig = await getLinearConfig(currentProject);
    if (issueLinearConfig.apiKey) {
      const promptDir = join(workspacePath, '.prompt');
      mkdirSync(promptDir, { recursive: true });

      const markdown = await generateMarkdown(selectedLinearIssue, promptDir, issueLinearConfig.apiKey);
      const issueMarkdownPath = join(promptDir, 'issue.md');
      writeFileSync(issueMarkdownPath, markdown, 'utf-8');

      logger.debug('Saved Linear issue details to .prompt/issue.md');
    }
  }

  // Open workspace shell unless --no-shell
  if (!options.noShell) {
    logger.success(`Opening workspace: ${workspaceName}`);
    await openWorkspaceShell(
      workspacePath,
      currentProject,
      projectConfig.repository,
      options.noSetup || false
    );
  } else {
    logger.success(`Workspace created at: ${workspacePath}`);
    logger.log(`\nTo navigate:\n  cd ${workspacePath}`);
  }
}

