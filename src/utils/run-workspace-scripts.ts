/**
 * Workspace script execution with phase tracking
 *
 * Consolidates the logic for running pre/setup/select scripts with
 * proper error handling and phase identification.
 */

import { runScriptsInTerminal, type RunScriptsOptions } from './run-scripts';
import { hasSetupBeenRun, markSetupComplete } from './workspace-state';
import { getScriptsPhaseDir, readProjectConfig } from '../core/config';
import { getProjectSecrets } from './secrets';

export type ScriptPhase = 'pre' | 'setup' | 'select';

export interface RunWorkspaceScriptsOptions {
  projectName: string;
  workspacePath: string;
  workspaceName: string;
  repository: string;
  /** If true, scripts can prompt for input. If false (default), stdin is closed. */
  interactive?: boolean;
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
  const { projectName, workspacePath, workspaceName, repository, interactive = false } = options;

  // Read project config for bundle values and secrets
  const config = readProjectConfig(projectName);

  // Build script options
  const scriptOptions: RunScriptsOptions = {
    bundleValues: config.bundleValues,
    nonInteractive: !interactive,
  };

  // Fetch secrets from OS keychain if we have secret keys
  if (config.bundleSecretKeys && config.bundleSecretKeys.length > 0) {
    scriptOptions.bundleSecrets = await getProjectSecrets(projectName, config.bundleSecretKeys);
  }

  // Check if setup has been run for this workspace
  const setupAlreadyRun = hasSetupBeenRun(workspacePath);

  if (setupAlreadyRun) {
    // Run select scripts for existing workspace
    const selectScriptsDir = getScriptsPhaseDir(projectName, 'select');
    try {
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
      const preScriptsDir = getScriptsPhaseDir(projectName, 'pre');
      await runScriptsInTerminal(preScriptsDir, workspacePath, workspaceName, repository, scriptOptions);
      preScriptsSucceeded = true;

      const setupScriptsDir = getScriptsPhaseDir(projectName, 'setup');
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
