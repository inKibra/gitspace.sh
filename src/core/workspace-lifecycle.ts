/**
 * Shared workspace lifecycle orchestration used by CLI, TUI, and remote flows.
 */

import {
  checkAndRefreshBundle,
  detectBundleChanges,
  formatBundleChangeDetails,
  getBundleRefreshPlan,
  syncBundleWorkspaceState,
} from './bundle-refresh.js';
import { readProjectConfig } from './config.js';
import { logger } from '../utils/logger.js';
import { preloadProjectSecrets } from '../utils/secrets.js';
import {
  runWorkspaceScripts,
  type RunWorkspaceScriptsResult,
  type ScriptPhase,
} from '../utils/run-workspace-scripts.js';

/**
 * How to handle bundle changes before running workspace scripts.
 */
export type BundlePreparationMode =
  | 'prompt-refresh'
  | 'error-if-changed'
  | 'skip';

export interface PrepareWorkspaceForSessionOptions {
  projectName: string;
  workspacePath: string;
  workspaceName: string;
  /** Repository name (owner/repo). If omitted, read from project config. */
  repository?: string;
  /** If true, skip setup scripts on first run. */
  noSetup?: boolean;
  /** If true, script processes can prompt for input. */
  interactiveScripts?: boolean;
  /** Bundle readiness mode before running scripts. */
  bundleMode?: BundlePreparationMode;
  /** Stream script output (stdout/stderr). */
  onOutput?: (data: Buffer) => void;
  /** Called when script phase starts. */
  onPhaseStart?: (phase: ScriptPhase) => void;
  /** Script execution policy for attach attempts. */
  scriptPolicy?: 'auto' | 'skip';
}

export type PrepareWorkspaceForSessionResult =
  | RunWorkspaceScriptsResult
  | {
      success: false;
      phase: 'pre';
      error: string;
      bundleNeedsRefresh?: boolean;
    };

const BUNDLE_REFRESH_REQUIRED_MESSAGE =
  'Run "gssh bundle refresh" and retry.';

/**
 * Prepare a workspace for session use.
 *
 * This handles bundle readiness checks, secret preload, and script lifecycle
 * execution (pre/setup/select).
 */
export async function prepareWorkspaceForSession(
  options: PrepareWorkspaceForSessionOptions
): Promise<PrepareWorkspaceForSessionResult> {
  const {
    projectName,
    workspacePath,
    workspaceName,
    repository,
    noSetup = false,
    interactiveScripts = false,
    bundleMode = 'error-if-changed',
    onOutput,
    onPhaseStart,
    scriptPolicy = 'auto',
  } = options;

  const bundleReady = await ensureBundleReady({
    projectName,
    workspacePath,
    mode: bundleMode,
  });

  if (!bundleReady.success) {
    return {
      success: false,
      phase: 'pre',
      error: bundleReady.error,
      bundleNeedsRefresh: bundleReady.bundleNeedsRefresh,
    };
  }

  const projectConfig = readProjectConfig(projectName);

  if (projectConfig.bundleSecretKeys && projectConfig.bundleSecretKeys.length > 0) {
    await preloadProjectSecrets(projectName, projectConfig.bundleSecretKeys);
  }

  return runWorkspaceScripts({
    projectName,
    workspacePath,
    workspaceName,
    repository: repository || projectConfig.repository,
    noSetup,
    interactive: interactiveScripts,
    onOutput,
    onPhaseStart,
    scriptPolicy,
  });
}

interface EnsureBundleReadyOptions {
  projectName: string;
  workspacePath: string;
  mode: BundlePreparationMode;
}

async function ensureBundleReady(
  options: EnsureBundleReadyOptions
): Promise<{ success: true } | { success: false; error: string; bundleNeedsRefresh?: boolean }> {
  const { projectName, workspacePath, mode } = options;

  if (mode === 'skip') {
    const syncResult = syncBundleWorkspaceState(projectName, workspacePath);
    if (syncResult.parseError) {
      return {
        success: false,
        error: `Bundle parse error: ${syncResult.parseError}`,
      };
    }

    return { success: true };
  }

  if (mode === 'prompt-refresh') {
    const ready = await checkAndRefreshBundle(projectName, workspacePath);
    if (!ready) {
      return {
        success: false,
        error: 'Bundle refresh was not completed',
        bundleNeedsRefresh: true,
      };
    }

    return { success: true };
  }

  // mode === 'error-if-changed'
  const changes = detectBundleChanges(projectName, workspacePath);
  if (changes.parseError) {
    return {
      success: false,
      error: `Bundle parse error: ${changes.parseError}`,
    };
  }

  if (changes.hasBundle && changes.hasChanged) {
    logger.info('Bundle configuration has changed for this workspace');
    const details = formatBundleChangeDetails(changes);
    return {
      success: false,
      error: `${details}\n${BUNDLE_REFRESH_REQUIRED_MESSAGE}`,
      bundleNeedsRefresh: true,
    };
  }

  if (changes.hasBundle) {
    const plan = await getBundleRefreshPlan(projectName, workspacePath);
    const hasRequiredSteps = plan.steps.some((step) => step.required !== false);

    if (hasRequiredSteps) {
      return {
        success: false,
        error: `${plan.details}\n${BUNDLE_REFRESH_REQUIRED_MESSAGE}`,
        bundleNeedsRefresh: true,
      };
    }
  }

  const syncResult = syncBundleWorkspaceState(projectName, workspacePath);
  if (syncResult.parseError) {
    return {
      success: false,
      error: `Bundle parse error: ${syncResult.parseError}`,
    };
  }

  return { success: true };
}
