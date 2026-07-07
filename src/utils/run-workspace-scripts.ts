/**
 * Workspace script execution with phase tracking
 *
 * Consolidates the logic for running pre/setup/select scripts with
 * proper error handling and phase identification.
 *
 * The automatic (open/attach) path is idempotent: setup and select each run at
 * most once per input fingerprint and are not retried after an unchanged
 * failure. Explicit rerun (rerunWorkspaceBundleScripts) always runs the
 * requested phases and updates the persisted lock state.
 */

import { join } from 'path';
import {
  buildPhaseScriptManifest,
  discoverScripts,
  runScriptsInTerminal,
  type RunScriptsOptions,
  isScriptExecutionCancelledError,
} from './run-scripts';
import {
  buildBundleStepFingerprints,
  buildSetupState,
  computeSelectFingerprint,
  computeSetupFingerprint,
  createEmptyWorkspaceLockState,
  getBundleStepKey,
  readWorkspaceLockState,
  type WorkspaceLockState,
  writeWorkspaceLockState,
} from './workspace-state';
import { readProjectConfig } from '../core/config';
import { detectBundleChanges } from '../core/bundle-refresh';
import { clearSecretsCache, getProjectSecrets } from './secrets';
import { logger } from './logger';
import type { ConfirmStepResult, SpacesBundle } from '../types/bundle.js';
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

/**
 * Discriminated result of the automatic lifecycle path.
 *
 * - `ran`: one or more phases actually executed (see `phasesRun`).
 * - `skipped-current`: everything was already current — nothing ran. Passive UI
 *   must NOT create a task/toast for this.
 * - `blocked-previous-failure`: a phase failed on a prior run with the same
 *   fingerprint, so it was not retried automatically. Passive UI must NOT create
 *   a task/toast; surface intentionally if needed.
 * - `failed`: a phase ran and failed this time.
 */
export type ScriptLifecycleOutcome =
  | { kind: 'ran'; phasesRun: ScriptPhase[] }
  | { kind: 'skipped-current' }
  | { kind: 'blocked-previous-failure'; blockedPhase: ScriptPhase; error?: string }
  | { kind: 'failed'; phase: ScriptPhase; error: string; cancelled?: boolean };

export type RunWorkspaceScriptsResult =
  | { success: true }
  | { success: false; phase: ScriptPhase; error: string; cancelled?: boolean };

function phaseDir(workspacePath: string, phase: ScriptPhase): string {
  return join(workspacePath, '.gitspace', 'scripts', phase);
}

interface LifecycleInputs {
  currentBundle: SpacesBundle | undefined;
  bundleHash: string | undefined;
  stepFingerprints: Record<string, string>;
  bundleValues: Record<string, string>;
  bundleSecrets: Record<string, string>;
  confirmResults: Record<string, ConfirmStepResult>;
  preManifest: string;
  setupManifest: string;
  selectManifest: string;
  scriptOptions: RunScriptsOptions;
}

/** Load bundle/config/secret/manifest inputs shared by auto + rerun paths. */
async function loadLifecycleInputs(
  options: Pick<RunWorkspaceScriptsOptions, 'projectName' | 'workspacePath' | 'interactive' | 'onOutput' | 'signal'>,
): Promise<{ inputs: LifecycleInputs } | { parseError: string }> {
  const { projectName, workspacePath, interactive = false, onOutput, signal } = options;

  const changes = detectBundleChanges(projectName, workspacePath);
  if (changes.parseError) {
    return { parseError: changes.parseError };
  }

  const currentBundle = changes.currentBundle;
  const bundleHash = changes.currentHash;
  const config = readProjectConfig(projectName);

  const bundleSecretKeys = new Set(config.bundleSecretKeys || []);
  for (const step of currentBundle?.onboarding || []) {
    if (step.type === 'secret') {
      bundleSecretKeys.add(step.configKey);
    }
  }

  // Bundle config updates can be applied by the tmux-lite server while workspace
  // script operations run in the machine daemon. The secrets module has a
  // process-local cache, so refresh before script env construction.
  clearSecretsCache();

  const bundleSecrets = bundleSecretKeys.size > 0
    ? await getProjectSecrets(projectName, [...bundleSecretKeys])
    : {};

  const stepFingerprints = currentBundle ? buildBundleStepFingerprints(currentBundle) : {};
  const confirmResults = resolveCurrentConfirmResults(
    currentBundle,
    stepFingerprints,
    config.bundleConfirmHistory || {},
  );

  return {
    inputs: {
      currentBundle,
      bundleHash,
      stepFingerprints,
      bundleValues: config.bundleValues || {},
      bundleSecrets,
      confirmResults,
      preManifest: buildPhaseScriptManifest(phaseDir(workspacePath, 'pre')),
      setupManifest: buildPhaseScriptManifest(phaseDir(workspacePath, 'setup')),
      selectManifest: buildPhaseScriptManifest(phaseDir(workspacePath, 'select')),
      scriptOptions: {
        bundleValues: config.bundleValues,
        bundleSecrets,
        nonInteractive: !interactive,
        onOutput,
        signal,
      },
    },
  };
}

function setupFingerprintOptions(inputs: LifecycleInputs) {
  return {
    bundle: inputs.currentBundle,
    bundleHash: inputs.bundleHash,
    stepFingerprints: inputs.stepFingerprints,
    bundleValues: inputs.bundleValues,
    bundleSecrets: inputs.bundleSecrets,
    confirmResults: inputs.confirmResults,
    preManifest: inputs.preManifest,
    setupManifest: inputs.setupManifest,
  };
}

/**
 * Automatic lifecycle path (workspace open / session attach).
 *
 * Idempotent and driven by persisted lock fingerprints: setup and select each
 * run at most once per fingerprint, and are not auto-retried after an unchanged
 * failure. Returns a discriminated {@link ScriptLifecycleOutcome}.
 */
export async function runWorkspaceScripts(
  options: RunWorkspaceScriptsOptions,
): Promise<ScriptLifecycleOutcome> {
  const {
    workspacePath,
    workspaceName,
    repository,
    noSetup = false,
    onPhaseStart,
    scriptPolicy = 'auto',
  } = options;

  if (scriptPolicy === 'skip') {
    return { kind: 'skipped-current' };
  }

  const loaded = await loadLifecycleInputs(options);
  if ('parseError' in loaded) {
    return { kind: 'failed', phase: 'setup', error: loaded.parseError };
  }
  const inputs = loaded.inputs;
  const { scriptOptions } = inputs;

  let lockState: WorkspaceLockState = readWorkspaceLockState(workspacePath) || createEmptyWorkspaceLockState();
  const currentSetupFingerprint = computeSetupFingerprint(setupFingerprintOptions(inputs));
  const phasesRun: ScriptPhase[] = [];

  // ---- Setup phase (idempotent) ----------------------------------------
  if (!noSetup) {
    const setupCurrent = lockState.setup.setupFingerprint === currentSetupFingerprint;
    if (setupCurrent && lockState.setup.status === 'success') {
      // up to date — skip
    } else if (setupCurrent && lockState.setup.status === 'failed') {
      return { kind: 'blocked-previous-failure', blockedPhase: 'setup', error: lockState.setup.error };
    } else {
      let preSucceeded = false;
      try {
        onPhaseStart?.('pre');
        const preDir = phaseDir(workspacePath, 'pre');
        if (discoverScripts(preDir).length > 0) {
          logger.warning('Bundle script phase "pre" is deprecated. Move scripts into ordered setup scripts.');
        }
        await runScriptsInTerminal(preDir, workspacePath, workspaceName, repository, scriptOptions);
        preSucceeded = true;

        onPhaseStart?.('setup');
        await runScriptsInTerminal(phaseDir(workspacePath, 'setup'), workspacePath, workspaceName, repository, scriptOptions);

        lockState = {
          ...lockState,
          bundle: inputs.bundleHash ? { bundleHash: inputs.bundleHash, stepFingerprints: inputs.stepFingerprints } : lockState.bundle,
          setup: buildSetupState(setupFingerprintOptions(inputs)),
        };
        writeWorkspaceLockState(workspacePath, lockState);
        phasesRun.push('setup');
      } catch (error) {
        const phase: ScriptPhase = preSucceeded ? 'setup' : 'pre';
        const message = error instanceof Error ? error.message : String(error);
        const cancelled = isScriptExecutionCancelledError(error);
        // Persist the attempted fingerprint on failure so an unchanged failure is
        // detected and not auto-retried.
        lockState = {
          ...lockState,
          bundle: inputs.bundleHash ? { bundleHash: inputs.bundleHash, stepFingerprints: inputs.stepFingerprints } : lockState.bundle,
          setup: {
            ...lockState.setup,
            status: 'failed',
            ranAt: new Date().toISOString(),
            error: message,
            setupFingerprint: currentSetupFingerprint,
          },
        };
        writeWorkspaceLockState(workspacePath, lockState);
        return { kind: 'failed', phase, error: message, cancelled };
      }
    }
  }

  // Select depends on setup: if setup was required and is not currently
  // successful, do not run select.
  const setupStatusForSelect = noSetup ? undefined : lockState.setup.status;
  if (!noSetup && lockState.setup.status !== 'success') {
    return { kind: 'blocked-previous-failure', blockedPhase: 'setup', error: lockState.setup.error };
  }

  // ---- Select phase (idempotent) ---------------------------------------
  const currentSelectFingerprint = computeSelectFingerprint({
    selectManifest: inputs.selectManifest,
    setupFingerprint: currentSetupFingerprint,
    setupStatus: setupStatusForSelect,
  });
  const selectCurrent = lockState.select.selectFingerprint === currentSelectFingerprint;
  if (selectCurrent && lockState.select.status === 'success') {
    // up to date — skip
  } else if (selectCurrent && lockState.select.status === 'failed') {
    return { kind: 'blocked-previous-failure', blockedPhase: 'select', error: lockState.select.error };
  } else {
    try {
      onPhaseStart?.('select');
      await runScriptsInTerminal(phaseDir(workspacePath, 'select'), workspacePath, workspaceName, repository, scriptOptions);
      lockState = {
        ...lockState,
        select: { status: 'success', ranAt: new Date().toISOString(), selectFingerprint: currentSelectFingerprint },
      };
      writeWorkspaceLockState(workspacePath, lockState);
      phasesRun.push('select');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = isScriptExecutionCancelledError(error);
      lockState = {
        ...lockState,
        select: { status: 'failed', ranAt: new Date().toISOString(), error: message, selectFingerprint: currentSelectFingerprint },
      };
      writeWorkspaceLockState(workspacePath, lockState);
      return { kind: 'failed', phase: 'select', error: message, cancelled };
    }
  }

  return phasesRun.length > 0 ? { kind: 'ran', phasesRun } : { kind: 'skipped-current' };
}

export type WorkspaceScriptRunSelection = 'setup' | 'select' | 'setup-select';

/**
 * Explicit rerun (user command). Always runs the requested phases regardless of
 * lock state, then updates the lock so future automatic opens observe the
 * outcome. Returns success/failure (callers surface errors directly).
 */
export async function rerunWorkspaceBundleScripts(
  options: Omit<RunWorkspaceScriptsOptions, 'noSetup' | 'scriptPolicy'> & {
    selection?: WorkspaceScriptRunSelection;
  },
): Promise<RunWorkspaceScriptsResult> {
  const {
    workspacePath,
    workspaceName,
    repository,
    onPhaseStart,
    selection = 'setup-select',
  } = options;

  const loaded = await loadLifecycleInputs(options);
  if ('parseError' in loaded) {
    return { success: false, phase: 'setup', error: loaded.parseError };
  }
  const inputs = loaded.inputs;
  const { scriptOptions } = inputs;

  const lockState = readWorkspaceLockState(workspacePath) || createEmptyWorkspaceLockState();
  const currentSetupFingerprint = computeSetupFingerprint(setupFingerprintOptions(inputs));

  if (selection === 'setup' || selection === 'setup-select') {
    try {
      onPhaseStart?.('setup');
      await runScriptsInTerminal(phaseDir(workspacePath, 'setup'), workspacePath, workspaceName, repository, scriptOptions);
      lockState.bundle = inputs.bundleHash ? { bundleHash: inputs.bundleHash, stepFingerprints: inputs.stepFingerprints } : lockState.bundle;
      lockState.setup = buildSetupState(setupFingerprintOptions(inputs));
      writeWorkspaceLockState(workspacePath, lockState);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lockState.setup = {
        ...lockState.setup,
        status: 'failed',
        ranAt: new Date().toISOString(),
        error: message,
        setupFingerprint: currentSetupFingerprint,
      };
      writeWorkspaceLockState(workspacePath, lockState);
      return { success: false, phase: 'setup', error: message, cancelled: isScriptExecutionCancelledError(error) };
    }
  }

  if (selection === 'setup') {
    return { success: true };
  }

  const currentSelectFingerprint = computeSelectFingerprint({
    selectManifest: inputs.selectManifest,
    setupFingerprint: currentSetupFingerprint,
    setupStatus: lockState.setup.status,
  });
  try {
    onPhaseStart?.('select');
    await runScriptsInTerminal(phaseDir(workspacePath, 'select'), workspacePath, workspaceName, repository, scriptOptions);
    lockState.select = { status: 'success', ranAt: new Date().toISOString(), selectFingerprint: currentSelectFingerprint };
    writeWorkspaceLockState(workspacePath, lockState);
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lockState.select = {
      ...lockState.select,
      status: 'failed',
      ranAt: new Date().toISOString(),
      error: message,
      selectFingerprint: currentSelectFingerprint,
    };
    writeWorkspaceLockState(workspacePath, lockState);
    return { success: false, phase: 'select', error: message, cancelled: isScriptExecutionCancelledError(error) };
  }
}

function resolveCurrentConfirmResults(
  bundle: SpacesBundle | undefined,
  stepFingerprints: Record<string, string>,
  confirmHistory: Record<string, { status: ConfirmStepResult['status'] }>,
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
