/**
 * Workspace script execution with phase tracking
 *
 * Consolidates the logic for running pre/setup/select scripts with
 * proper error handling and phase identification.
 */

import { join } from 'path';
import {
  discoverScripts,
  runScriptsInTerminal,
  type RunScriptsOptions,
  isScriptExecutionCancelledError,
} from './run-scripts';
import {
  buildBundleStepFingerprints,
  buildSetupState,
  createEmptyWorkspaceLockState,
  fingerprintValue,
  getBundleStepKey,
  readWorkspaceLockState,
  type WorkspaceLockState,
  writeWorkspaceLockState,
} from './workspace-state';
import { readProjectConfig } from '../core/config';
import { detectBundleChanges } from '../core/bundle-refresh';
import { getProjectSecrets } from './secrets';
import { logger } from './logger';
import type { ConfirmStepResult, OnboardingStep, SpacesBundle } from '../types/bundle.js';
import type { WorkspaceScriptPhase } from '../types/script-phase';

export type ScriptPhase = WorkspaceScriptPhase;

export interface RunWorkspaceScriptsOptions {
  projectName: string;
  workspacePath: string;
  workspaceName: string;
  repository: string;
  /** If true, skip pre/setup scripts on first-time workspace access. */
  noSetup?: boolean;
  /** If true, scripts can prompt for input. If false (default), stdin is closed. */
  interactive?: boolean;
  /**
   * Callback to receive ANSI output as it arrives (for TUI/Web terminal display).
   * Called with raw output from stdout/stderr.
   */
  onOutput?: (data: Buffer) => void;
  /**
   * Callback when a new phase starts (for displaying phase name in UI).
   */
  onPhaseStart?: (phase: ScriptPhase) => void;
  /** Script execution policy for session attach attempts. */
  scriptPolicy?: 'auto' | 'skip';
  /** Optional cancellation signal for script execution. */
  signal?: AbortSignal;
}

export type RunWorkspaceScriptsResult =
  | { success: true }
  | { success: false; phase: ScriptPhase; error: string; cancelled?: boolean };

/**
 * Run workspace scripts based on setup state.
 *
 * - If setup has already been run: runs select scripts only
 * - If first time: runs pre scripts, then setup scripts, then marks setup complete
 *
 * Returns success or failure with the specific phase that failed.
 */
export async function runWorkspaceScripts(
  options: RunWorkspaceScriptsOptions
): Promise<RunWorkspaceScriptsResult> {
  const {
    projectName,
    workspacePath,
    workspaceName,
    repository,
    noSetup = false,
    interactive = false,
    onOutput,
    onPhaseStart,
    scriptPolicy = 'auto',
    signal,
  } = options;

  const changes = detectBundleChanges(projectName, workspacePath);
  if (changes.parseError) {
    return {
      success: false,
      phase: 'pre',
      error: changes.parseError,
    };
  }

  const currentBundle = changes.currentBundle;
  const bundleHash = changes.currentHash;

  // Read project config for bundle values and secrets
  const config = readProjectConfig(projectName);

  const bundleSecretKeys = new Set(config.bundleSecretKeys || []);
  for (const step of currentBundle?.onboarding || []) {
    if (step.type === 'secret') {
      bundleSecretKeys.add(step.configKey);
    }
  }

  const bundleSecrets = bundleSecretKeys.size > 0
    ? await getProjectSecrets(projectName, [...bundleSecretKeys])
    : {};

  // Build script options
  const scriptOptions: RunScriptsOptions = {
    bundleValues: config.bundleValues,
    bundleSecrets,
    nonInteractive: !interactive,
    onOutput,
    signal,
  };

  if (scriptPolicy === 'skip') {
    return { success: true };
  }

  const existingLock = readWorkspaceLockState(workspacePath) || createEmptyWorkspaceLockState();
  const stepFingerprints = currentBundle ? buildBundleStepFingerprints(currentBundle) : {};

  const setupNeeded = !noSetup && shouldRunSetup({
    lock: existingLock,
    bundle: currentBundle,
    bundleHash,
    stepFingerprints,
    bundleValues: config.bundleValues || {},
    bundleSecrets,
    confirmHistory: config.bundleConfirmHistory || {},
  });

  let lockState: WorkspaceLockState = {
    ...existingLock,
  };

  if (setupNeeded) {
    const preScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'pre');
    const preScripts = discoverScripts(preScriptsDir);
    if (preScripts.length > 0) {
      logger.warning('Bundle script phase "pre" is deprecated. Move scripts into ordered setup scripts.');
    }

    let preScriptsSucceeded = false;
    try {
      onPhaseStart?.('pre');
      await runScriptsInTerminal(preScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
      preScriptsSucceeded = true;

      onPhaseStart?.('setup');
      const setupScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'setup');
      await runScriptsInTerminal(setupScriptsDir, workspacePath, workspaceName, repository, scriptOptions);

      const confirmResults = resolveCurrentConfirmResults(
        currentBundle,
        stepFingerprints,
        config.bundleConfirmHistory || {}
      );

      lockState = {
        ...lockState,
        bundle: bundleHash
          ? {
              bundleHash,
              stepFingerprints,
            }
          : lockState.bundle,
        setup: buildSetupState({
          bundle: currentBundle,
          bundleHash,
          stepFingerprints,
          bundleValues: config.bundleValues || {},
          bundleSecrets,
          confirmResults,
        }),
      };
      writeWorkspaceLockState(workspacePath, lockState);
    } catch (error) {
      const phase: ScriptPhase = preScriptsSucceeded ? 'setup' : 'pre';
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = isScriptExecutionCancelledError(error);
      lockState = {
        ...lockState,
        bundle: bundleHash
          ? {
              bundleHash,
              stepFingerprints,
            }
          : lockState.bundle,
        setup: {
          ...lockState.setup,
          status: 'failed',
          ranAt: new Date().toISOString(),
          error: message,
        },
      };
      writeWorkspaceLockState(workspacePath, lockState);
      return { success: false, phase, error: message, cancelled };
    }
  }


  // Always run select scripts on terminal attach (new session path).
  const selectScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'select');
  try {
    onPhaseStart?.('select');
    await runScriptsInTerminal(selectScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
    lockState = {
      ...lockState,
      select: {
        status: 'success',
        ranAt: new Date().toISOString(),
      },
    };
    writeWorkspaceLockState(workspacePath, lockState);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = isScriptExecutionCancelledError(error);
    lockState = {
      ...lockState,
      select: {
        status: 'failed',
        ranAt: new Date().toISOString(),
        error: message,
      },
    };
    writeWorkspaceLockState(workspacePath, lockState);
    return { success: false, phase: 'select', error: message, cancelled };
  }
}

export type WorkspaceScriptRunSelection = 'setup' | 'select' | 'setup-select';

export async function rerunWorkspaceBundleScripts(
  options: Omit<RunWorkspaceScriptsOptions, 'noSetup' | 'scriptPolicy'> & {
    selection?: WorkspaceScriptRunSelection;
  }
): Promise<RunWorkspaceScriptsResult> {
  const {
    projectName,
    workspacePath,
    workspaceName,
    repository,
    interactive = false,
    onOutput,
    onPhaseStart,
    signal,
    selection = 'setup-select',
  } = options;

  const changes = detectBundleChanges(projectName, workspacePath);
  if (changes.parseError) {
    return { success: false, phase: 'setup', error: changes.parseError };
  }

  const currentBundle = changes.currentBundle;
  const config = readProjectConfig(projectName);
  const bundleSecretKeys = new Set(config.bundleSecretKeys || []);
  for (const step of currentBundle?.onboarding || []) {
    if (step.type === 'secret') {
      bundleSecretKeys.add(step.configKey);
    }
  }
  const bundleSecrets = bundleSecretKeys.size > 0
    ? await getProjectSecrets(projectName, [...bundleSecretKeys])
    : {};

  const scriptOptions: RunScriptsOptions = {
    bundleValues: config.bundleValues,
    bundleSecrets,
    nonInteractive: !interactive,
    onOutput,
    signal,
  };

  const lockState = readWorkspaceLockState(workspacePath) || createEmptyWorkspaceLockState();

  if (selection === 'setup' || selection === 'setup-select') {
    try {
      onPhaseStart?.('setup');
      const setupScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'setup');
      await runScriptsInTerminal(setupScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
      lockState.setup = {
        ...lockState.setup,
        status: 'success',
        ranAt: new Date().toISOString(),
        error: undefined,
      };
      writeWorkspaceLockState(workspacePath, lockState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lockState.setup = {
        ...lockState.setup,
        status: 'failed',
        ranAt: new Date().toISOString(),
        error: message,
      };
      writeWorkspaceLockState(workspacePath, lockState);
      return { success: false, phase: 'setup', error: message, cancelled: isScriptExecutionCancelledError(error) };
    }
  }

  if (selection === 'setup') {
    return { success: true };
  }
  try {
    onPhaseStart?.('select');
    const selectScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'select');
    await runScriptsInTerminal(selectScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
    lockState.select = {
      status: 'success',
      ranAt: new Date().toISOString(),
    };
    writeWorkspaceLockState(workspacePath, lockState);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lockState.select = {
      ...lockState.select,
      status: 'failed',
      ranAt: new Date().toISOString(),
      error: message,
    };
    writeWorkspaceLockState(workspacePath, lockState);
    return { success: false, phase: 'select', error: message, cancelled: isScriptExecutionCancelledError(error) };
  }
}

function resolveCurrentConfirmResults(
  bundle: SpacesBundle | undefined,
  stepFingerprints: Record<string, string>,
  confirmHistory: Record<string, { status: ConfirmStepResult['status'] }>
): Record<string, ConfirmStepResult> {
  const results: Record<string, ConfirmStepResult> = {};
  if (!bundle) {
    return results;
  }

  for (const step of bundle.onboarding || []) {
    if (step.type !== 'confirm') {
      continue;
    }

    const key = getBundleStepKey(step);
    const fingerprint = stepFingerprints[key];
    if (!fingerprint) {
      continue;
    }

    const history = confirmHistory[fingerprint];
    if (!history) {
      continue;
    }

    results[step.id] = {
      status: history.status,
      checkCommand: step.checkCommand,
    };
  }

  return results;
}

interface SetupDecisionOptions {
  lock: WorkspaceLockState;
  bundle: SpacesBundle | undefined;
  bundleHash: string | undefined;
  stepFingerprints: Record<string, string>;
  bundleValues: Record<string, string>;
  bundleSecrets: Record<string, string>;
  confirmHistory: Record<string, { status: ConfirmStepResult['status'] }>;
}

function shouldRunSetup(options: SetupDecisionOptions): boolean {
  const {
    lock,
    bundle,
    bundleHash,
    stepFingerprints,
    bundleValues,
    bundleSecrets,
    confirmHistory,
  } = options;

  if (lock.setup.status !== 'success') {
    return true;
  }

  if (!bundle) {
    return false;
  }

  const previousBundle = lock.bundle;
  if (!previousBundle || !bundleHash) {
    return true;
  }

  const relevantSteps = getRelevantSetupSteps(bundle.onboarding || [], lock.setup.usedOptionalSteps);

  for (const step of relevantSteps) {
    const key = getBundleStepKey(step);
    const currentStepFingerprint = stepFingerprints[key];
    if (!currentStepFingerprint || previousBundle.stepFingerprints[key] !== currentStepFingerprint) {
      return true;
    }

    if (step.type === 'input') {
      const value = bundleValues[step.configKey] ?? '';
      const currentValueFingerprint = fingerprintValue(value);
      if (lock.setup.inputFingerprints[step.configKey] !== currentValueFingerprint) {
        return true;
      }
      continue;
    }

    if (step.type === 'secret') {
      const value = bundleSecrets[step.configKey] ?? '';
      const currentSecretFingerprint = fingerprintValue(value);
      if (lock.setup.secretFingerprints[step.configKey] !== currentSecretFingerprint) {
        return true;
      }
      continue;
    }

    if (step.type === 'confirm') {
      const previous = lock.setup.confirmsUsed[key];
      if (!previous) {
        continue;
      }
      const history = confirmHistory[currentStepFingerprint];
      const currentStatus = history?.status;
      if (previous.status !== currentStatus || previous.fingerprint !== currentStepFingerprint) {
        return true;
      }
    }
  }

  return false;
}

function getRelevantSetupSteps(
  steps: OnboardingStep[],
  usedOptionalSteps: Record<string, true>
): OnboardingStep[] {
  return steps.filter((step) => {
    const required = step.required !== false;
    if (required) {
      return step.type === 'input' || step.type === 'select' || step.type === 'secret' || step.type === 'confirm';
    }

    const key = getBundleStepKey(step);
    if (!usedOptionalSteps[key]) {
      return false;
    }

    return step.type === 'input' || step.type === 'select' || step.type === 'secret' || step.type === 'confirm';
  });
}
