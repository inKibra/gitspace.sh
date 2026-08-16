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
import { shouldSkipSecretDependentScripts } from './secret-runtime.js';
import {
  runWorkspaceScripts,
  rerunWorkspaceBundleScripts,
  type RunWorkspaceScriptsResult,
  type ScriptLifecycleOutcome,
  type WorkspaceScriptRunSelection,
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
  /** Script selection for explicit reruns. */
  selection?: WorkspaceScriptRunSelection;
  /** Script execution policy for attach attempts. */
  scriptPolicy?: 'auto' | 'skip';
  /** Optional cancellation signal for in-flight script execution. */
  signal?: AbortSignal;
}

/**
 * Result of the automatic workspace preparation path. A discriminated superset
 * of the lifecycle outcome that keeps a `success` boolean for existing callers
 * (attach/shell/server) while exposing `kind` so the open path can distinguish a
 * real run from a no-op. Note that `skipped-current` and `blocked-previous-failure`
 * are `success: true` — they are intentional no-ops, not errors, so passive
 * callers proceed without surfacing a task or error.
 */
export type PrepareWorkspaceForSessionResult =
  | { success: true; kind: 'ran'; phasesRun: ScriptPhase[] }
  | { success: true; kind: 'skipped-current' }
  | { success: true; kind: 'blocked-previous-failure'; blockedPhase: ScriptPhase; priorError?: string }
  | { success: false; kind: 'failed'; phase: ScriptPhase; error: string; cancelled?: boolean; bundleNeedsRefresh?: boolean };

function outcomeToPrepareResult(outcome: ScriptLifecycleOutcome): PrepareWorkspaceForSessionResult {
  switch (outcome.kind) {
    case 'ran':
      return { success: true, kind: 'ran', phasesRun: outcome.phasesRun };
    case 'skipped-current':
      return { success: true, kind: 'skipped-current' };
    case 'blocked-previous-failure':
      return { success: true, kind: 'blocked-previous-failure', blockedPhase: outcome.blockedPhase, priorError: outcome.error };
    case 'failed':
      return { success: false, kind: 'failed', phase: outcome.phase, error: outcome.error, cancelled: outcome.cancelled };
  }
}

const BUNDLE_REFRESH_REQUIRED_MESSAGE =
  'Run "gssh workspace bundle refresh --project <name> --workspace <name>" and retry.';

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
    signal,
  } = options;

  const projectConfig = readProjectConfig(projectName);

  if (shouldSkipSecretDependentScripts(projectName, projectConfig.bundleSecretKeys)) {
    const bundleReady = await ensureBundleReady({
      projectName,
      workspacePath,
      mode: 'skip',
    });

    if (!bundleReady.success) {
      return { success: false, kind: 'failed', phase: 'pre', error: bundleReady.error };
    }

    logger.warning(
      `Skipping workspace scripts for "${workspaceName}" because --ignore-keychain-and-skip-secrets is enabled.`
    );
    return { success: true, kind: 'skipped-current' };
  }

  const bundleReady = await ensureBundleReady({
    projectName,
    workspacePath,
    mode: bundleMode,
  });

  if (!bundleReady.success) {
    return {
      success: false,
      kind: 'failed',
      phase: 'pre',
      error: bundleReady.error,
      bundleNeedsRefresh: bundleReady.bundleNeedsRefresh,
    };
  }

  if (projectConfig.bundleSecretKeys && projectConfig.bundleSecretKeys.length > 0) {
    await preloadProjectSecrets(projectName, projectConfig.bundleSecretKeys);
  }

  return outcomeToPrepareResult(await runWorkspaceScripts({
    projectName,
    workspacePath,
    workspaceName,
    repository: repository || projectConfig.repository,
    noSetup,
    interactive: interactiveScripts,
    onOutput,
    onPhaseStart,
    scriptPolicy,
    signal,
  }));
}

export async function rerunWorkspaceScriptsForSession(
  options: PrepareWorkspaceForSessionOptions
): Promise<RunWorkspaceScriptsResult> {
  const {
    projectName,
    workspacePath,
    workspaceName,
    repository,
    interactiveScripts = false,
    onOutput,
    onPhaseStart,
    signal,
    selection = 'setup-select',
  } = options;

  return rerunWorkspaceBundleScripts({
    projectName,
    workspacePath,
    workspaceName,
    repository: repository || readProjectConfig(projectName).repository,
    interactive: interactiveScripts,
    onOutput,
    onPhaseStart,
    signal,
    selection,
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
