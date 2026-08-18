/**
 * Bundle loading, validation, and script management
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  statSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { join, resolve, sep } from 'path';
import { tmpdir } from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SpacesError } from '../types/errors.js';
import { logger } from '../utils/logger.js';
import { isShellEnvKey, normalizeEnvKey } from '../utils/normalize-env-key.js';
import type { SpacesBundle, LoadedBundle } from '../types/bundle.js';

const BUNDLE_FILENAME = 'bundle.json';
const BUNDLE_SUBDIRS = ['.gitspace'];

function assertSafeExtractedPaths(rootDir: string): void {
  const rootResolved = resolve(rootDir);
  const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : `${rootResolved}${sep}`;
  const stack: string[] = [''];

  while (stack.length > 0) {
    const relativeDir = stack.pop() ?? '';
    const currentDir = join(rootResolved, relativeDir);
    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryRelative = relativeDir ? join(relativeDir, entry.name) : entry.name;
      const resolvedPath = resolve(rootResolved, entryRelative);

      if (!resolvedPath.startsWith(rootPrefix)) {
        throw new Error(`Zip slip detected: ${entryRelative}`);
      }

      if (entry.isSymbolicLink()) {
        throw new Error(`Zip slip detected: symlink ${entryRelative}`);
      }

      if (entry.isDirectory()) {
        stack.push(entryRelative);
      }
    }
  }
}

/**
 * Detect bundle in cloned repository
 * Checks common subdirectory names for bundle.json
 */
export function detectBundleInRepo(baseDir: string): string | null {
  logger.debug(`Checking for bundle in: ${baseDir}`);

  for (const subdir of BUNDLE_SUBDIRS) {
    const bundlePath = join(baseDir, subdir, BUNDLE_FILENAME);
    logger.debug(`  Checking: ${bundlePath}`);
    if (existsSync(bundlePath)) {
      logger.debug(`  Found bundle at: ${bundlePath}`);
      return join(baseDir, subdir);
    }
  }

  // Check root level
  const rootBundlePath = join(baseDir, BUNDLE_FILENAME);
  logger.debug(`  Checking root: ${rootBundlePath}`);
  if (existsSync(rootBundlePath)) {
    logger.debug(`  Found bundle at root`);
    return baseDir;
  }

  logger.debug(`  No bundle found`);
  return null;
}

/**
 * Load bundle manifest from local path
 */
export function loadBundleFromPath(bundleDir: string): LoadedBundle {
  const manifestPath = join(bundleDir, BUNDLE_FILENAME);

  if (!existsSync(manifestPath)) {
    throw new SpacesError(
      `Bundle manifest not found: ${manifestPath}`,
      'USER_ERROR',
      1
    );
  }

  try {
    const content = readFileSync(manifestPath, 'utf-8');
    const bundle = JSON.parse(content) as SpacesBundle;
    validateBundle(bundle);

    return {
      bundle,
      bundleDir,
      source: bundleDir,
    };
  } catch (error) {
    if (error instanceof SpacesError) throw error;
    throw new SpacesError(
      `Failed to parse bundle manifest: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'USER_ERROR',
      1
    );
  }
}

/**
 * Download and extract bundle from remote URL (zip archive)
 */
export async function loadBundleFromUrl(url: string): Promise<LoadedBundle> {
  const tempDir = join(tmpdir(), `spaces-bundle-${Date.now()}`);

  try {
    logger.info('Downloading bundle...');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Create temp directory
    mkdirSync(tempDir, { recursive: true });

    // Get the response as array buffer
    const arrayBuffer = await response.arrayBuffer();
    const zipPath = join(tempDir, 'bundle.zip');

    // Write zip file
    writeFileSync(zipPath, Buffer.from(arrayBuffer));

    // Extract using unzip command
    const execAsync = promisify(exec);

    await execAsync(`unzip -q "${zipPath}" -d "${tempDir}"`);
    assertSafeExtractedPaths(tempDir);

    // Find the bundle manifest (might be in root or a subdirectory)
    let bundleDir = tempDir;
    if (!existsSync(join(tempDir, BUNDLE_FILENAME))) {
      // Check if there's a single directory that contains the manifest
      const entries = readdirSync(tempDir);
      for (const entry of entries) {
        const entryPath = join(tempDir, entry);
        if (statSync(entryPath).isDirectory() && existsSync(join(entryPath, BUNDLE_FILENAME))) {
          bundleDir = entryPath;
          break;
        }
      }
    }

    const manifestPath = join(bundleDir, BUNDLE_FILENAME);
    if (!existsSync(manifestPath)) {
      throw new Error('Bundle manifest (bundle.json) not found in archive');
    }

    const content = readFileSync(manifestPath, 'utf-8');
    const bundle = JSON.parse(content) as SpacesBundle;
    validateBundle(bundle);

    logger.success('Bundle downloaded and extracted');

    return {
      bundle,
      bundleDir,
      source: url,
    };
  } catch (error) {
    // Clean up temp directory on error
    if (existsSync(tempDir)) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }

    if (error instanceof SpacesError) throw error;
    throw new SpacesError(
      `Failed to fetch bundle from ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'SERVICE_ERROR',
      3
    );
  }
}

/**
 * Validate bundle manifest schema
 */
export function validateBundle(bundle: SpacesBundle): void {
  if (!bundle.version || bundle.version !== '1.0') {
    throw new SpacesError(
      `Unsupported bundle version: ${bundle.version}. Expected "1.0"`,
      'USER_ERROR',
      1
    );
  }

  if (!bundle.name) {
    throw new SpacesError('Bundle must have a name', 'USER_ERROR', 1);
  }

  // Validate onboarding steps if present
  if (bundle.onboarding) {
    const ids = new Set<string>();
    const configKeys = new Map<string, string>();
    const normalizedAliases = new Map<string, { stepId: string; configKey: string }>();

    for (const step of bundle.onboarding) {
      if (!step.id) {
        throw new SpacesError('Each onboarding step must have an id', 'USER_ERROR', 1);
      }
      if (ids.has(step.id)) {
        throw new SpacesError(`Duplicate onboarding step id: ${step.id}`, 'USER_ERROR', 1);
      }
      ids.add(step.id);

      // Keep this list in sync with OnboardingStepType in types/bundle.ts.
      // 'select' was implemented end to end (SelectStep, and both branches in
      // utils/onboarding.ts) but missing here, so every bundle using it died at
      // validation with "Invalid step type: select" before onboarding ran.
      if (!['info', 'confirm', 'secret', 'input', 'select'].includes(step.type)) {
        throw new SpacesError(`Invalid step type: ${step.type}`, 'USER_ERROR', 1);
      }

      // Validate configKey for the steps that persist a value
      if (step.type === 'secret' || step.type === 'input' || step.type === 'select') {
        // Cast to access configKey since TypeScript knows these types should have it
        const stepWithKey = step as { configKey?: string };
        if (!stepWithKey.configKey) {
          throw new SpacesError(
            `Step "${step.id}" of type "${step.type}" must have a configKey`,
            'USER_ERROR',
            1
          );
        }

        const existingConfigKeyStepId = configKeys.get(stepWithKey.configKey);
        if (existingConfigKeyStepId) {
          throw new SpacesError(
            [
              'Bundle configKey collision',
              '',
              `The configKey "${stepWithKey.configKey}" is used by multiple onboarding steps.`,
              `- step "${existingConfigKeyStepId}"`,
              `- step "${step.id}"`,
              '',
              'Fix: each input/secret step must use a unique configKey.',
            ].join('\n'),
            'USER_ERROR',
            1
          );
        }
        configKeys.set(stepWithKey.configKey, step.id);

        const normalizedAlias = normalizeEnvKey(stepWithKey.configKey);
        if (!normalizedAlias) {
          throw new SpacesError(
            `Step "${step.id}" has invalid configKey "${stepWithKey.configKey}" (no usable env alias)`,
            'USER_ERROR',
            1
          );
        }

        if (!isShellEnvKey(normalizedAlias)) {
          throw new SpacesError(
            [
              'Bundle configKey produces non-shell env alias',
              '',
              `Step "${step.id}" configKey "${stepWithKey.configKey}" normalizes to "${normalizedAlias}".`,
              `Scripts cannot access this via $${normalizedAlias}.`,
              '',
              'Shell variable names must match: [A-Za-z_][A-Za-z0-9_]*',
              'Fix: rename the configKey so its normalized alias starts with a letter or underscore.',
            ].join('\n'),
            'USER_ERROR',
            1
          );
        }

        const existingAlias = normalizedAliases.get(normalizedAlias);
        if (existingAlias && existingAlias.configKey !== stepWithKey.configKey) {
          throw new SpacesError(
            [
              'Bundle configKey alias collision',
              '',
              `Multiple config keys normalize to the same script env alias: ${normalizedAlias}`,
              `- step "${existingAlias.stepId}" configKey "${existingAlias.configKey}"`,
              `- step "${step.id}" configKey "${stepWithKey.configKey}"`,
              '',
              `Scripts would read an ambiguous value from $${normalizedAlias}.`,
              'Fix: rename one of the conflicting configKey values so each exported env var is unique.',
            ].join('\n'),
            'USER_ERROR',
            1
          );
        }

        normalizedAliases.set(normalizedAlias, {
          stepId: step.id,
          configKey: stepWithKey.configKey,
        });
      }
    }
  }
}

/**
 * Clean up temporary bundle directory (for URL bundles)
 */
export function cleanupBundleDir(bundleDir: string): void {
  // Only clean up if it's in the temp directory
  if (bundleDir.startsWith(tmpdir())) {
    try {
      rmSync(bundleDir, { recursive: true, force: true });
      logger.debug('Cleaned up temporary bundle directory');
    } catch (error) {
      logger.debug(`Failed to clean up bundle directory: ${error}`);
    }
  }
}
