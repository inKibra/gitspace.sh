/**
 * Convention-based script runner
 * Discovers and runs executable scripts from project scripts/ directories
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import { logger } from './logger.js';

/**
 * Discover executable scripts in a directory
 * Returns scripts sorted alphabetically for predictable execution order
 */
export function discoverScripts(scriptsDir: string): string[] {
  if (!existsSync(scriptsDir)) {
    logger.debug(`Scripts directory does not exist: ${scriptsDir}`);
    return [];
  }

  try {
    const files = readdirSync(scriptsDir);
    const scripts: string[] = [];

    for (const file of files) {
      const filePath = join(scriptsDir, file);
      const stats = statSync(filePath);

      // Check if file is executable (has execute permission)
      // On Unix: check if any execute bit is set
      if (stats.isFile() && (stats.mode & 0o111) !== 0) {
        scripts.push(filePath);
      }
    }

    // Sort alphabetically for predictable order
    scripts.sort();

    logger.debug(`Discovered ${scripts.length} executable scripts in ${scriptsDir}`);
    return scripts;
  } catch (error) {
    logger.debug(`Error discovering scripts: ${error}`);
    return [];
  }
}

/**
 * Options for running scripts
 */
export interface RunScriptsOptions {
  /** Bundle values to pass as SPACE_VALUE_* environment variables */
  bundleValues?: Record<string, string>;
  /** Secret values to pass as SPACE_SECRET_* environment variables */
  bundleSecrets?: Record<string, string>;
  /**
   * Run scripts in non-interactive mode (for daemon/remote contexts).
   * - stdin is closed immediately (scripts can't prompt for input)
   * - stdout/stderr are captured and logged on failure
   * - Prevents scripts from blocking indefinitely
   */
  nonInteractive?: boolean;
}

/**
 * Run scripts in the current terminal
 * Used for pre-scripts that run before tmux session
 *
 * Bundle values are passed as environment variables:
 * - SPACE_VALUE_<KEY> for regular values (key is uppercased)
 * - SPACE_SECRET_<KEY> for secret values (key is uppercased)
 */
export async function runScriptsInTerminal(
  scriptsDir: string,
  workspacePath: string,
  workspaceName: string,
  repository: string,
  options?: RunScriptsOptions
): Promise<void> {
  const scripts = discoverScripts(scriptsDir);

  if (scripts.length === 0) {
    logger.debug(`No scripts to run in ${scriptsDir}`);
    return;
  }

  const phaseName = scriptsDir.split('/').pop() || 'scripts';
  logger.info(`Running ${phaseName} scripts...`);

  // Build environment variables from bundle values
  const scriptEnv: Record<string, string> = { ...process.env } as Record<string, string>;

  // Add bundle values as SPACE_VALUE_<KEY>
  if (options?.bundleValues) {
    for (const [key, value] of Object.entries(options.bundleValues)) {
      const envKey = `SPACE_VALUE_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      scriptEnv[envKey] = value;
    }
  }

  // Add bundle secrets as SPACE_SECRET_<KEY>
  if (options?.bundleSecrets) {
    for (const [key, value] of Object.entries(options.bundleSecrets)) {
      const envKey = `SPACE_SECRET_${key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
      scriptEnv[envKey] = value;
    }
  }

  for (const scriptPath of scripts) {
    await new Promise<void>((resolve, reject) => {
      const scriptName = scriptPath.split('/').pop() || scriptPath;
      logger.dim(`  $ ${scriptName} ${workspaceName} ${repository}`);

      // Non-interactive mode: stdin=ignore, capture stdout/stderr
      // Interactive mode: inherit all stdio
      const stdio: 'inherit' | ['ignore', 'pipe', 'pipe'] = options?.nonInteractive
        ? ['ignore', 'pipe', 'pipe']
        : 'inherit';

      const child = spawn(scriptPath, [workspaceName, repository], {
        stdio,
        shell: false,
        cwd: workspacePath,
        env: scriptEnv,
      });

      // Capture output in non-interactive mode for logging on failure
      let output = '';
      if (options?.nonInteractive && child.stdout && child.stderr) {
        child.stdout.on('data', (data: Buffer) => { output += data.toString(); });
        child.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      }

      child.on('close', (code: number | null) => {
        if (code !== 0) {
          // Log captured output on failure in non-interactive mode
          if (options?.nonInteractive && output) {
            logger.debug(`Script output:\n${output}`);
          }
          reject(
            new SpacesError(
              `Script failed with exit code ${code}: ${scriptName}`,
              'SYSTEM_ERROR',
              2
            )
          );
        } else {
          resolve();
        }
      });

      child.on('error', (error: Error) => {
        reject(
          new SpacesError(
            `Failed to run script: ${error.message}`,
            'SYSTEM_ERROR',
            2
          )
        );
      });
    });
  }

  logger.success(`${phaseName} scripts completed`);
}

