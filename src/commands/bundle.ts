/**
 * Bundle CLI commands
 *
 * Commands for managing bundle configuration and refresh.
 */

import { logger } from '../utils/logger.js';
import { SpacesError } from '../types/errors.js';
import { getProjectWorkspacesDir } from '../core/config.js';
import {
  applyBundleConfigSubmission,
  detectBundleChanges,
  formatBundleChangeDetails,
  getBundleConfigState,
  refreshBundle,
  type BundleRefreshOptions,
} from '../core/bundle-refresh.js';
import { join } from 'path';
import { existsSync } from 'fs';
import type { BundleConfigSubmission } from '../types/bundle-config.js';
import { promptPassword } from '../utils/prompts.js';

/**
 * Options for bundle refresh command
 */
export interface BundleRefreshCommandOptions {
  /** Force refresh even if no changes detected */
  force?: boolean;
  /** Only inspect a workspace-local bundle instead of falling back to the project base bundle */
  noBaseFallback?: boolean;
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

export interface BundleShowOptions {
  project: string;
  workspace: string;
}

export interface BundleEditOptions {
  project: string;
  workspace: string;
  input?: string[];
  secret?: string[];
  secretUnset?: string[];
  confirm?: string[];
}

function resolveWorkspacePath(projectName: string, workspaceName: string): string {
  const workspacePath = join(getProjectWorkspacesDir(projectName), workspaceName);
  if (!existsSync(workspacePath)) {
    throw new SpacesError(
      `Workspace not found: ${workspacePath}`,
      'USER_ERROR',
      1,
    );
  }
  return workspacePath;
}

function parseKeyValue(raw: string, label: string): { key: string; value: string } {
  const index = raw.indexOf('=');
  if (index <= 0) {
    throw new SpacesError(`Invalid ${label} value: "${raw}" (expected key=value)`, 'USER_ERROR', 1);
  }
  const key = raw.slice(0, index).trim();
  const value = raw.slice(index + 1);
  if (!key) {
    throw new SpacesError(`Invalid ${label} key in "${raw}"`, 'USER_ERROR', 1);
  }
  return { key, value };
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

  const workspacePath = resolveWorkspacePath(projectName, workspaceName);

  logger.info(`Checking bundle for workspace: ${projectName}/${workspaceName}`);
  logger.dim(`Workspace path: ${workspacePath}`);

  const refreshOptions: BundleRefreshOptions = {
    force: options.force,
    allowBaseFallback: options.noBaseFallback !== true,
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

  const workspacePath = resolveWorkspacePath(projectName, workspaceName);

  const changes = detectBundleChanges(projectName, workspacePath, {
    allowBaseFallback: false,
  });

  logger.bold(`\nBundle Status: ${projectName}/${workspaceName}\n`);

  if (!changes.hasBundle) {
    if (changes.parseError) {
      logger.error('Bundle file exists but could not be parsed:');
      logger.log(`  ${changes.parseError}`);
    } else {
      logger.log('No bundle found for this workspace');
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

export async function bundleShow(options: BundleShowOptions): Promise<void> {
  const projectName = options.project;
  const workspaceName = options.workspace;

  if (!projectName || !workspaceName) {
    throw new SpacesError(
      'Project and workspace are required. Use `--project <name> --workspace <name>`.',
      'USER_ERROR',
      1
    );
  }

  const workspacePath = resolveWorkspacePath(projectName, workspaceName);
  const state = await getBundleConfigState(projectName, workspacePath, `${projectName}:${workspaceName}`);

  logger.bold(`\nBundle Config: ${projectName}/${workspaceName}\n`);

  if (!state.hasBundle) {
    logger.log('No bundle found for this workspace');
    logger.dim('Bundles are defined in .gitspace/bundle.json');
    return;
  }

  logger.log(`Bundle: ${state.bundleName ?? '(unnamed)'}`);
  logger.log(`Version: ${state.bundleVersion ?? '1.0'}`);
  logger.log(`Path: ${state.workspacePath}`);
  logger.log(`Source: ${state.bundleSource === 'workspace' ? 'workspace .gitspace/bundle.json' : 'base .gitspace/bundle.json'}`);
  logger.log('');

  const steps = state.steps;
  if (steps.length === 0) {
    logger.dim('No onboarding steps defined in bundle.json');
    return;
  }

  logger.log('Steps:');
  for (const step of steps) {
    if (step.type === 'input') {
      const value = step.value ?? '';
      logger.log(`  - [input] ${step.configKey}: ${value.length > 0 ? value : '(unset)'}`);
      continue;
    }

    if (step.type === 'secret') {
      logger.log(`  - [secret] ${step.configKey}: ${step.hasSecret ? 'set' : 'unset'}`);
      continue;
    }

    if (step.type === 'confirm') {
      const status = step.confirmResult?.status ?? 'pending';
      const checked = step.confirmCheckedAt ? ` @ ${step.confirmCheckedAt}` : '';
      logger.log(`  - [confirm] ${step.id}: ${status}${checked}`);
      continue;
    }

    logger.log(`  - [info] ${step.id}: ${step.title}`);
  }
}

export async function bundleEdit(options: BundleEditOptions): Promise<void> {
  const projectName = options.project;
  const workspaceName = options.workspace;

  if (!projectName || !workspaceName) {
    throw new SpacesError(
      'Project and workspace are required. Use `--project <name> --workspace <name>`.',
      'USER_ERROR',
      1
    );
  }

  const workspacePath = resolveWorkspacePath(projectName, workspaceName);
  const state = await getBundleConfigState(projectName, workspacePath, `${projectName}:${workspaceName}`);
  if (!state.hasBundle) {
    throw new SpacesError('No bundle found for this workspace', 'USER_ERROR', 1);
  }

  const inputKeys = new Set(
    state.steps.filter((step) => step.type === 'input' && step.configKey).map((step) => step.configKey as string)
  );
  const secretKeys = new Set(
    state.steps.filter((step) => step.type === 'secret' && step.configKey).map((step) => step.configKey as string)
  );
  const confirmIds = new Set(state.steps.filter((step) => step.type === 'confirm').map((step) => step.id));

  const inputValues: Record<string, string> = {};
  for (const pair of options.input ?? []) {
    const parsed = parseKeyValue(pair, '--input');
    if (!inputKeys.has(parsed.key)) {
      throw new SpacesError(`Input key not found in bundle: ${parsed.key}`, 'USER_ERROR', 1);
    }
    inputValues[parsed.key] = parsed.value;
  }

  const secretValues: Record<string, string> = {};
  for (const keyRaw of options.secret ?? []) {
    const key = keyRaw.trim();
    if (!secretKeys.has(key)) {
      throw new SpacesError(`Secret key not found in bundle: ${key}`, 'USER_ERROR', 1);
    }
    const value = await promptPassword(`Enter value for secret ${key}`);
    if (value === null || value.length === 0) {
      throw new SpacesError(`Secret entry cancelled for ${key}`, 'USER_ERROR', 1);
    }
    secretValues[key] = value;
  }

  const unsetSecretKeys = new Set<string>();
  for (const keyRaw of options.secretUnset ?? []) {
    const key = keyRaw.trim();
    if (!secretKeys.has(key)) {
      throw new SpacesError(`Secret key not found in bundle: ${key}`, 'USER_ERROR', 1);
    }
    if (secretValues[key]) {
      throw new SpacesError(`Conflicting secret update for ${key}: cannot set and unset in same command`, 'USER_ERROR', 1);
    }
    unsetSecretKeys.add(key);
    secretValues[key] = '';
  }

  const confirmResults: NonNullable<BundleConfigSubmission['confirmResults']> = {};
  for (const pair of options.confirm ?? []) {
    const parsed = parseKeyValue(pair, '--confirm');
    if (!confirmIds.has(parsed.key)) {
      throw new SpacesError(`Confirm step not found in bundle: ${parsed.key}`, 'USER_ERROR', 1);
    }

    if (parsed.value !== 'passed' && parsed.value !== 'skipped') {
      throw new SpacesError(`Invalid confirm status for ${parsed.key}: ${parsed.value}`, 'USER_ERROR', 1);
    }

    confirmResults[parsed.key] = {
      status: parsed.value,
    };
  }

  if (
    Object.keys(inputValues).length === 0 &&
    Object.keys(secretValues).length === 0 &&
    Object.keys(confirmResults).length === 0
  ) {
    throw new SpacesError('No updates provided. Use --input, --secret, or --confirm.', 'USER_ERROR', 1);
  }

  await applyBundleConfigSubmission(projectName, workspacePath, {
    inputValues,
    secretValues,
    confirmResults,
  });

  logger.success('Bundle configuration updated');
  if (Object.keys(inputValues).length > 0) {
    logger.log(`- inputs: ${Object.keys(inputValues).join(', ')}`);
  }
  if (Object.keys(secretValues).length > 0) {
    const secretSetKeys = Object.keys(secretValues).filter((key) => !unsetSecretKeys.has(key));
    if (secretSetKeys.length > 0) {
      logger.log(`- secrets set: ${secretSetKeys.join(', ')}`);
    }
    if (unsetSecretKeys.size > 0) {
      logger.log(`- secrets unset: ${[...unsetSecretKeys].join(', ')}`);
    }
  }
  if (Object.keys(confirmResults).length > 0) {
    logger.log(`- confirms: ${Object.keys(confirmResults).join(', ')}`);
  }
}
