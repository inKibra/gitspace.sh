/**
 * Bundle CLI commands
 *
 * Commands for managing bundle configuration and refresh.
 */

import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { getProjectWorkspacesDir } from '../core/config.js';
import {
  detectBundleChanges,
  formatBundleChangeDetails,
  refreshBundle,
  type BundleRefreshOptions,
} from '../core/bundle-refresh.js';
import { join } from 'path';
import { existsSync } from 'fs';

/**
 * Options for bundle refresh command
 */
export interface BundleRefreshCommandOptions {
  /** Force refresh even if no changes detected */
  force?: boolean;
  /** Project name */
  project: string;
  /** Workspace name */
  workspace: string;
}

/**
 * Options for bundle status command
 */
export interface BundleStatusOptions {
  /** Project name */
  project: string;
  /** Workspace name */
  workspace: string;
}

/**
 * Refresh bundle onboarding for a project
 *
 * Re-runs onboarding steps with previous values as defaults.
 * Useful when bundle.json has been updated with new configuration.
 */
export async function bundleRefresh(options: BundleRefreshCommandOptions): Promise<void> {
  const projectName = options.project;
  const workspaceName = options.workspace;

  if (!projectName || !workspaceName) {
    throw new SpacesError(
      'Project and workspace are required. Use `--project <name> --workspace <name>`.',
      'USER_ERROR',
      1
    );
  }

  const workspacePath = join(getProjectWorkspacesDir(projectName), workspaceName);
  if (!existsSync(workspacePath)) {
    throw new SpacesError(
      `Workspace not found: ${workspacePath}`,
      'USER_ERROR',
      1,
    );
  }

  logger.info(`Checking bundle for workspace: ${projectName}/${workspaceName}`);
  logger.dim(`Workspace path: ${workspacePath}`);

  const refreshOptions: BundleRefreshOptions = {
    force: options.force,
    allowBaseFallback: false,
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
 * Show bundle status for a project
 *
 * Displays information about the current bundle configuration.
 */
export async function bundleStatus(options: BundleStatusOptions): Promise<void> {
  const projectName = options.project;
  const workspaceName = options.workspace;

  if (!projectName || !workspaceName) {
    throw new SpacesError(
      'Project and workspace are required. Use `--project <name> --workspace <name>`.',
      'USER_ERROR',
      1
    );
  }

  const workspacePath = join(getProjectWorkspacesDir(projectName), workspaceName);
  if (!existsSync(workspacePath)) {
    throw new SpacesError(
      `Workspace not found: ${workspacePath}`,
      'USER_ERROR',
      1,
    );
  }

  const changes = detectBundleChanges(projectName, workspacePath, {
    allowBaseFallback: false,
  });

  logger.bold(`\nBundle Status: ${projectName}/${workspaceName}\n`);

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
    logger.log('Run "gssh workspace bundle refresh --project <name> --workspace <name>" to update configuration');
  } else {
    logger.success('Bundle is up to date');
  }
}
