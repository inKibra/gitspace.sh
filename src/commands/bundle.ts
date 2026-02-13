/**
 * Bundle CLI commands
 *
 * Commands for managing bundle configuration and refresh.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { getCurrentProject, getProjectBaseDir, getProjectWorkspacesDir } from '../core/config.js';
import {
  detectBundleChanges,
  formatBundleChangeDetails,
  refreshBundle,
  type BundleRefreshOptions,
} from '../core/bundle-refresh.js';
import { join, resolve } from 'path';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

/**
 * Options for bundle refresh command
 */
export interface BundleRefreshCommandOptions {
  /** Force refresh even if no changes detected */
  force?: boolean;
  /** Project name (defaults to current project) */
  project?: string;
}

/**
 * Options for bundle status command
 */
export interface BundleStatusOptions {
  /** Project name (defaults to current project) */
  project?: string;
}

/**
 * Detect if the current working directory is inside a workspace
 * Returns the workspace path if found, undefined otherwise
 */
function detectWorkspaceFromCwd(projectName: string): string | undefined {
  const cwd = process.cwd();
  const workspacesDir = getProjectWorkspacesDir(projectName);

  // Check if cwd is inside the workspaces directory
  const resolvedCwd = resolve(cwd);
  const resolvedWorkspacesDir = resolve(workspacesDir);

  if (resolvedCwd.startsWith(resolvedWorkspacesDir + '/') || resolvedCwd === resolvedWorkspacesDir) {
    // Extract the workspace name (first path segment after workspaces/)
    const relativePath = resolvedCwd.slice(resolvedWorkspacesDir.length + 1);
    const workspaceName = relativePath.split('/')[0];

    if (workspaceName) {
      const workspacePath = join(workspacesDir, workspaceName);
      if (existsSync(workspacePath)) {
        return workspacePath;
      }
    }
  }

  return undefined;
}

/**
 * Pull latest changes in the base directory
 */
async function pullBaseRepo(baseDir: string): Promise<void> {
  logger.info('Pulling latest changes in base repository...');

  try {
    await execAsync('git fetch origin', { cwd: baseDir });

    // Get current branch
    const { stdout: branchOutput } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: baseDir });
    const currentBranch = branchOutput.trim();

    // Pull current branch
    await execAsync(`git pull origin ${currentBranch}`, { cwd: baseDir });

    logger.success('Base repository updated');
  } catch (error) {
    logger.warning(`Could not pull latest changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    logger.dim('Continuing with existing bundle state...');
  }
}

/**
 * Refresh bundle onboarding for the current project
 *
 * Re-runs onboarding steps with previous values as defaults.
 * Useful when bundle.json has been updated with new configuration.
 */
export async function bundleRefresh(options: BundleRefreshCommandOptions): Promise<void> {
  const projectName = options.project || getCurrentProject();

  if (!projectName) {
    throw new SpacesError(
      'No project selected. Use "gssh switch project" or specify --project',
      'USER_ERROR',
      1
    );
  }

  logger.info(`Checking bundle for project: ${projectName}`);

  // First, try to detect if user is in a workspace directory
  let workspacePath = detectWorkspaceFromCwd(projectName);

  if (workspacePath) {
    logger.dim(`Using current workspace: ${workspacePath}`);
  } else {
    // Fall back to base directory after pulling latest
    const baseDir = getProjectBaseDir(projectName);

    if (!existsSync(baseDir)) {
      throw new SpacesError(
        `Project base directory not found: ${baseDir}`,
        'USER_ERROR',
        1
      );
    }

    // Pull latest to ensure we have current bundle.json
    await pullBaseRepo(baseDir);
    workspacePath = baseDir;
    logger.dim('Using base repository (no workspace detected in current directory)');
  }

  const refreshOptions: BundleRefreshOptions = {
    force: options.force,
  };

  const result = await refreshBundle(projectName, workspacePath, refreshOptions);

  if (result.error) {
    throw new SpacesError(result.error, 'USER_ERROR', 1);
  }

  if (result.refreshed) {
    logger.success('Bundle configuration updated');

    if (result.newValues && Object.keys(result.newValues).length > 0) {
      logger.log('\nUpdated values:');
      for (const key of Object.keys(result.newValues)) {
        logger.log(`  - ${key}`);
      }
    }

    if (result.newSecretKeys && result.newSecretKeys.length > 0) {
      logger.log('\nSecrets configured:');
      for (const key of result.newSecretKeys) {
        logger.log(`  - ${key}`);
      }
    }
  } else {
    logger.info('No changes to apply');
  }
}

/**
 * Show bundle status for the current project
 *
 * Displays information about the current bundle configuration.
 */
export async function bundleStatus(options: BundleStatusOptions): Promise<void> {
  const projectName = options.project || getCurrentProject();

  if (!projectName) {
    throw new SpacesError(
      'No project selected. Use "gssh switch project" or specify --project',
      'USER_ERROR',
      1
    );
  }

  // First, try to detect if user is in a workspace directory
  let workspacePath = detectWorkspaceFromCwd(projectName);

  if (!workspacePath) {
    // Fall back to base directory after pulling latest
    const baseDir = getProjectBaseDir(projectName);

    if (!existsSync(baseDir)) {
      throw new SpacesError(
        `Project base directory not found: ${baseDir}`,
        'USER_ERROR',
        1
      );
    }

    // Pull latest to ensure we have current bundle.json
    await pullBaseRepo(baseDir);
    workspacePath = baseDir;
  }

  const changes = detectBundleChanges(projectName, workspacePath);

  logger.bold(`\nBundle Status: ${projectName}\n`);

  if (!changes.hasBundle) {
    if (changes.parseError) {
      logger.error('Bundle file exists but could not be parsed:');
      logger.log(`  ${changes.parseError}`);
    } else {
      logger.log('No bundle found in this project');
      logger.dim('Bundles are defined in .gitspace/bundle.json');
    }
    return;
  }

  const bundle = changes.currentBundle!;
  logger.log(`Bundle: ${bundle.name}`);
  logger.log(`Version: ${bundle.version}`);
  logger.log(`Path: ${changes.bundlePath}`);
  logger.log(`Source: ${changes.bundleSource === 'workspace' ? 'workspace .gitspace/bundle.json' : 'base .gitspace/bundle.json'}`);

  if (bundle.onboarding && bundle.onboarding.length > 0) {
    logger.log(`Onboarding steps: ${bundle.onboarding.length}`);
  }

  logger.log('');

  if (changes.hasChanged) {
    logger.warning('Bundle has changed since last applied');
    const details = formatBundleChangeDetails(changes)
      .split('\n')
      .map((line) => `  - ${line}`)
      .join('\n');
    logger.log(details);
    logger.log('Run "gssh bundle refresh" to update configuration');
  } else {
    logger.success('Bundle is up to date');
  }
}
