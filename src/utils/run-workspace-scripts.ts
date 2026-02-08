/**
 * Workspace script execution with phase tracking
 *
 * Consolidates the logic for running pre/setup/select scripts with
 * proper error handling and phase identification.
 */

import { join } from 'path';
import { runScriptsInTerminal, type RunScriptsOptions } from './run-scripts';
import { hasSetupBeenRun, markSetupComplete } from './workspace-state';
import { readProjectConfig } from '../core/config';
import { getProjectSecrets } from './secrets';

export type ScriptPhase = 'pre' | 'setup' | 'select';

export interface RunWorkspaceScriptsOptions {
  projectName: string;
  workspacePath: string;
  workspaceName: string;
  repository: string;
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
}

export type RunWorkspaceScriptsResult =
  | { success: true }
  | { success: false; phase: ScriptPhase; error: string };

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
    interactive = false,
    onOutput,
    onPhaseStart,
  } = options;

  // Read project config for bundle values and secrets
  const config = readProjectConfig(projectName);

  // Build script options
  const scriptOptions: RunScriptsOptions = {
    bundleValues: config.bundleValues,
    nonInteractive: !interactive,
    onOutput,
  };

  // Fetch secrets from OS keychain if we have secret keys
  if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
    scriptOptions.bundleSecrets = await getProjectSecrets(projectName, config.bundleSecretKeys);
  }

  // Check if setup has been run for this workspace
  const setupAlreadyRun = hasSetupBeenRun(workspacePath);

  if (setupAlreadyRun) {
    // Run select scripts for existing workspace
    const selectScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'select');
    try {
      onPhaseStart?.('select');
      await runScriptsInTerminal(selectScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, phase: 'select', error: message };
    }
  } else {
    // First time accessing this workspace - run pre scripts, then setup scripts
    let preScriptsSucceeded = false;

    try {
      onPhaseStart?.('pre');
      const preScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'pre');
      await runScriptsInTerminal(preScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
      preScriptsSucceeded = true;

      onPhaseStart?.('setup');
      const setupScriptsDir = join(workspacePath, '.gitspace', 'scripts', 'setup');
      await runScriptsInTerminal(setupScriptsDir, workspacePath, workspaceName, repository, scriptOptions);

      // Only mark complete if both phases succeeded
      markSetupComplete(workspacePath);
      return { success: true };
    } catch (error) {
      const phase: ScriptPhase = preScriptsSucceeded ? 'setup' : 'pre';
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, phase, error: message };
    }
  }
}
