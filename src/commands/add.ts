/**
 * Add command implementation
 * Handles both 'gssh add project' and 'gssh add [workspace-name]'
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  readProjectConfig,
  createProject,
  setCurrentProject,
  getProjectBaseDir,
  getProjectWorkspacesDir,
  getCurrentProject,
  getAllProjectNames,
  projectExists,
  updateProjectConfig,
} from '../core/config.js';
import { checkGitHubAuth, ensureDependencies } from '../utils/deps.js';
import { selectItem, promptConfirm, promptInput } from '../utils/prompts.js';
import { logger } from '../utils/logger.js';
import { listAllRepos, cloneRepository } from '../core/github.js';
import {
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
import { runScriptsInTerminal } from '../utils/run-scripts.js';
import { hasSetupBeenRun } from '../utils/workspace-state.js';
import { generateMarkdown } from '../utils/markdown.js';
import {
  detectBundleInRepo,
  loadBundleFromPath,
  loadBundleFromUrl,
  cleanupBundleDir,
} from '../core/bundle.js';
import { checkAndRefreshBundle, hashBundle } from '../core/bundle-refresh.js';
import { runOnboarding } from '../utils/onboarding.js';
import { preloadProjectSecrets } from '../utils/secrets.js';
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
  await checkGitHubAuth();

  // List all GitHub repositories
  logger.info('Fetching repositories...');
  const repos = await listAllRepos(options.org);

  if (repos.length === 0) {
    throw new SpacesError(
      'No repositories found',
      'USER_ERROR',
      1
    );
  }

  // Select repository
  const selectedRepo = await selectItem(repos, 'Select a repository:');

  if (!selectedRepo) {
    logger.info('Cancelled');
    return;
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
        `Repository ${selectedRepo} is already tracked by project "${existingProject}"\n\nTo use that project:\n  gssh switch project ${existingProject}`,
        'USER_ERROR',
        1
      );
    }
  }

  // Clone the repository unless --no-clone
  const baseDir = getProjectBaseDir(projectName);

  if (!options.noClone) {
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
    // Store bundle values and info in project config
    const configUpdates: Record<string, unknown> = {};

    if (onboardingResult?.completed && Object.keys(onboardingResult.configValues).length > 0) {
      configUpdates.bundleValues = onboardingResult.configValues;
    }

    configUpdates.appliedBundle = {
      name: loadedBundle.bundle.name,
      version: loadedBundle.bundle.version,
      source: loadedBundle.source,
      appliedAt: new Date().toISOString(),
    };

    // Store the bundle hash to prevent false "bundle has changed" on first workspace
    configUpdates.appliedBundleHash = hashBundle(loadedBundle.bundle);

    updateProjectConfig(projectName, configUpdates);

    // Clean up temp directory if bundle was from URL
    cleanupBundleDir(loadedBundle.bundleDir);
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
  workspaceNameArg?: string,
  options: Partial<CreateWorkspaceOptions> = {}
): Promise<void> {
  // Get current project
  const currentProject = getCurrentProject();
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

  logger.success(`Created worktree from ${baseBranch}`);

  // Preload project secrets into cache to minimize keychain prompts
  // This ensures subsequent getProjectSecret calls use cached values
  if (projectConfig.bundleSecretKeys && projectConfig.bundleSecretKeys.length > 0) {
    await preloadProjectSecrets(currentProject, projectConfig.bundleSecretKeys);
  }

  // Check if bundle has changed and run refresh if needed
  await checkAndRefreshBundle(currentProject, workspacePath);

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

  // Check if this is first-time setup (no marker exists)
  const isFirstTime = !hasSetupBeenRun(workspacePath);

  // Run pre scripts if this is the first time (before tmux/setup)
  if (isFirstTime && !options.noSetup) {
    const preScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'pre');
    await runScriptsInTerminal(preScriptsDir, workspacePath, workspaceName, projectConfig.repository);
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
