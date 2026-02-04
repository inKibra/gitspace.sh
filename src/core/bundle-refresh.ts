/**
 * Bundle refresh detection and execution
 *
 * Detects when a bundle.json has changed and re-runs onboarding
 * with previous values as defaults.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { readProjectConfig, updateProjectConfig, getProjectBaseDir } from './config.js';
import { runOnboarding, KEEP_EXISTING_SECRET, type OnboardingOptions } from '../utils/onboarding.js';
import { setProjectSecret, getProjectSecret } from '../utils/secrets.js';
import type { SpacesBundle, OnboardingStep, SecretStep } from '../types/bundle.js';

const BUNDLE_FILENAME = 'bundle.json';

/**
 * Result of bundle change detection
 */
export interface BundleChangeResult {
  /** Whether a bundle exists */
  hasBundle: boolean;
  /** Whether the bundle has changed since last applied */
  hasChanged: boolean;
  /** The current bundle (if exists) */
  currentBundle?: SpacesBundle;
  /** Hash of the current bundle content */
  currentHash?: string;
  /** Hash of the previously applied bundle (if available) */
  previousHash?: string;
  /** Path to the bundle directory */
  bundlePath?: string;
  /** Parse error if bundle.json is invalid */
  parseError?: string;
}

/**
 * Options for bundle refresh
 */
export interface BundleRefreshOptions {
  /** Force refresh even if no changes detected */
  force?: boolean;
  /** Run in non-interactive mode (skip if changes detected, for automation) */
  nonInteractive?: boolean;
}

/**
 * Result of bundle refresh
 */
export interface BundleRefreshResult {
  /** Whether refresh was performed */
  refreshed: boolean;
  /** Whether onboarding completed successfully */
  completed: boolean;
  /** New values collected (excluding secrets) */
  newValues?: Record<string, string>;
  /** New secret keys added */
  newSecretKeys?: string[];
  /** Error message if failed */
  error?: string;
}

/**
 * Compute a hash of the full bundle content for change detection
 */
function hashBundle(bundle: SpacesBundle): string {
  // Hash the full bundle content (sorted keys for consistency)
  const content = JSON.stringify(bundle, Object.keys(bundle).sort());
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Result of loading a bundle
 */
interface LoadBundleResult {
  bundle: SpacesBundle | null;
  error?: string;
}

/**
 * Load bundle from a directory
 */
function loadBundle(bundleDir: string): LoadBundleResult {
  const bundlePath = join(bundleDir, BUNDLE_FILENAME);
  if (!existsSync(bundlePath)) {
    return { bundle: null };
  }

  try {
    const content = readFileSync(bundlePath, 'utf-8');
    const bundle = JSON.parse(content) as SpacesBundle;
    return { bundle };
  } catch (error) {
    const errorMessage = error instanceof SyntaxError
      ? `Invalid JSON in bundle.json: ${error.message}`
      : `Failed to load bundle: ${error}`;
    logger.warning(errorMessage);
    return { bundle: null, error: errorMessage };
  }
}

/**
 * Detect if bundle has changed since last applied
 *
 * Checks the workspace's .gitspace/bundle.json against what was previously applied.
 * Falls back to base repo if workspace path not provided.
 */
export function detectBundleChanges(
  projectName: string,
  workspacePath?: string
): BundleChangeResult {
  const result: BundleChangeResult = {
    hasBundle: false,
    hasChanged: false,
  };

  // Try to load bundle from workspace first, then fall back to base
  let bundleDir: string | null = null;

  if (workspacePath) {
    const workspaceBundleDir = join(workspacePath, '.gitspace');
    if (existsSync(join(workspaceBundleDir, BUNDLE_FILENAME))) {
      bundleDir = workspaceBundleDir;
    }
  }

  if (!bundleDir) {
    const baseDir = getProjectBaseDir(projectName);
    const baseBundleDir = join(baseDir, '.gitspace');
    if (existsSync(join(baseBundleDir, BUNDLE_FILENAME))) {
      bundleDir = baseBundleDir;
    }
  }

  if (!bundleDir) {
    return result;
  }

  const { bundle, error } = loadBundle(bundleDir);
  if (!bundle) {
    // If there was a parse error, include it in the result
    if (error) {
      result.parseError = error;
    }
    return result;
  }

  result.hasBundle = true;
  result.currentBundle = bundle;
  result.currentHash = hashBundle(bundle);
  result.bundlePath = bundleDir;

  // Check if we have a previously applied bundle
  const config = readProjectConfig(projectName);
  if (config.appliedBundle) {
    // Compare hashes if we have one stored, otherwise compare versions
    if ((config as any).appliedBundleHash) {
      result.previousHash = (config as any).appliedBundleHash;
      result.hasChanged = result.currentHash !== result.previousHash;
    } else {
      // No hash stored, assume changed if version differs
      result.hasChanged = config.appliedBundle.version !== bundle.version;
    }
  } else {
    // No applied bundle, this is first time
    result.hasChanged = true;
  }

  return result;
}

/**
 * Refresh bundle onboarding
 *
 * Re-runs onboarding steps with previous values as defaults.
 * Only updates values that the user changes.
 */
export async function refreshBundle(
  projectName: string,
  workspacePath?: string,
  options: BundleRefreshOptions = {}
): Promise<BundleRefreshResult> {
  const result: BundleRefreshResult = {
    refreshed: false,
    completed: false,
  };

  // Detect changes
  const changes = detectBundleChanges(projectName, workspacePath);

  if (!changes.hasBundle) {
    result.error = 'No bundle found';
    return result;
  }

  if (!changes.hasChanged && !options.force) {
    logger.info('Bundle has not changed since last applied');
    result.refreshed = false;
    result.completed = true;
    return result;
  }

  if (options.nonInteractive) {
    logger.info('Bundle has changed but running in non-interactive mode, skipping refresh');
    result.refreshed = false;
    return result;
  }

  const bundle = changes.currentBundle!;
  const steps = bundle.onboarding || [];

  if (steps.length === 0) {
    logger.info('Bundle has no onboarding steps');
    result.refreshed = false;
    result.completed = true;
    return result;
  }

  // Get previous values
  const config = readProjectConfig(projectName);
  const previousValues = config.bundleValues || {};
  const configuredSecretKeys = config.bundleSecretKeys || [];

  // Verify which secrets actually exist in keychain
  // Only offer "keep existing" for secrets that are actually present
  const existingSecretKeys: string[] = [];
  for (const key of configuredSecretKeys) {
    const exists = await getProjectSecret(projectName, key);
    if (exists !== null) {
      existingSecretKeys.push(key);
    } else {
      logger.debug(`Secret '${key}' not found in keychain, will prompt for new value`);
    }
  }

  // Run onboarding with previous values
  const onboardingOptions: OnboardingOptions = {
    previousValues,
    previousSecretKeys: existingSecretKeys,
    title: 'Bundle Refresh',
    isRefresh: true,
  };

  const onboardingResult = await runOnboarding(steps, onboardingOptions);

  if (!onboardingResult.completed) {
    result.error = 'Onboarding cancelled';
    return result;
  }

  // Process results - merge with previous values
  const newValues: Record<string, string> = { ...previousValues };
  const newSecretKeys: string[] = [...configuredSecretKeys];

  for (const step of steps) {
    if (step.type === 'secret' || step.type === 'input') {
      const configKey = (step as SecretStep).configKey;
      const value = onboardingResult.configValues[configKey];

      if (step.type === 'secret') {
        if (value && value !== KEEP_EXISTING_SECRET) {
          // User provided a new secret - store it
          await setProjectSecret(projectName, configKey, value);
          if (!newSecretKeys.includes(configKey)) {
            newSecretKeys.push(configKey);
          }
        }
        // If KEEP_EXISTING_SECRET, we don't need to do anything - it's already stored
      } else {
        // Input step - update value
        if (value !== undefined) {
          newValues[configKey] = value;
        }
      }
    }
  }

  // Update project config
  updateProjectConfig(projectName, {
    bundleValues: Object.keys(newValues).length > 0 ? newValues : undefined,
    bundleSecretKeys: newSecretKeys.length > 0 ? newSecretKeys : undefined,
    appliedBundle: {
      name: bundle.name,
      version: bundle.version,
      source: changes.bundlePath!,
      appliedAt: new Date().toISOString(),
    },
    // Store hash for future change detection
    appliedBundleHash: changes.currentHash,
  } as any);

  result.refreshed = true;
  result.completed = true;
  result.newValues = newValues;
  result.newSecretKeys = newSecretKeys;

  return result;
}

/**
 * Check if bundle refresh is needed and prompt user
 *
 * Returns true if refresh was performed or not needed,
 * false if user cancelled or error occurred.
 */
export async function checkAndRefreshBundle(
  projectName: string,
  workspacePath: string
): Promise<boolean> {
  const changes = detectBundleChanges(projectName, workspacePath);

  if (!changes.hasBundle) {
    return true; // No bundle, nothing to do
  }

  if (!changes.hasChanged) {
    return true; // No changes, nothing to do
  }

  logger.info('Bundle configuration has changed');

  const result = await refreshBundle(projectName, workspacePath);

  if (result.error) {
    logger.warning(`Bundle refresh failed: ${result.error}`);
    return false;
  }

  return result.completed;
}
