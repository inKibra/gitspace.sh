/**
 * Convention-based script runner
 * Discovers and runs executable scripts from project scripts/ directories
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import { logger } from './logger.js';

const FAILURE_OUTPUT_TAIL_MAX_LINES = 25;
const FAILURE_OUTPUT_TAIL_MAX_CHARS = 4000;

function truncateScriptOutputTail(output: string): { tail: string; truncated: boolean } {
  if (!output) {
    return { tail: '', truncated: false };
  }

  const normalized = output.replace(/\r/g, '');

  let tailByChars = normalized;
  let truncated = false;

  if (tailByChars.length > FAILURE_OUTPUT_TAIL_MAX_CHARS) {
    tailByChars = tailByChars.slice(-FAILURE_OUTPUT_TAIL_MAX_CHARS);
    truncated = true;
  }

  const lines = tailByChars.split('\n');
  if (lines.length > FAILURE_OUTPUT_TAIL_MAX_LINES) {
    tailByChars = lines.slice(-FAILURE_OUTPUT_TAIL_MAX_LINES).join('\n');
    truncated = true;
  }

  return {
    tail: tailByChars.trimEnd(),
    truncated,
  };
}

function formatScriptFailureMessage(scriptName: string, code: number | null, output: string): string {
  const header = `Script failed with exit code ${code}: ${scriptName}`;
  if (!output.trim()) {
    return header;
  }

  const { tail, truncated } = truncateScriptOutputTail(output);
  if (!tail) {
    return header;
  }

  const intro = truncated ? 'Last output (truncated):' : 'Last output:';
  return `${header}\n\n${intro}\n${tail}`;
}

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
  /** Bundle values to pass as environment variables */
  bundleValues?: Record<string, string>;
  /** Secret values to pass as environment variables */
  bundleSecrets?: Record<string, string>;
  /**
   * Run scripts in non-interactive mode (for daemon/remote contexts).
   * - stdin is closed immediately (scripts can't prompt for input)
   * - stdout/stderr are captured and logged on failure
   * - Prevents scripts from blocking indefinitely
   */
  nonInteractive?: boolean;
  /**
   * Callback to receive ANSI output as it arrives (for TUI/Web terminal display).
   * Called with raw output from stdout/stderr. Only works when nonInteractive is true.
   */
  onOutput?: (data: Buffer) => void;
}

function normalizeEnvKey(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function setCompatibilityAliases(
  env: Record<string, string>,
  key: string,
  value: string,
  prefix: 'SPACE_VALUE_' | 'SPACE_SECRET_'
): void {
  const normalizedKey = normalizeEnvKey(key);

  // Legacy namespaced key for backwards compatibility.
  env[`${prefix}${normalizedKey}`] = value;

  // Uppercase normalized alias for shell-friendly access when key contains
  // non-shell characters (for example, api-key -> API_KEY).
  env[normalizedKey] = value;
}

/**
 * Run scripts in the current terminal
 * Used for pre-scripts that run before tmux session
 *
 * Bundle values are passed as environment variables:
 * - <KEY> using the exact bundle config key name
 * - Backward-compatible aliases: SPACE_VALUE_<KEY>, SPACE_SECRET_<KEY>, and normalized <KEY>
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

  // Add bundle values using configured key names.
  if (options?.bundleValues) {
    for (const [key, value] of Object.entries(options.bundleValues)) {
      scriptEnv[key] = value;
      setCompatibilityAliases(scriptEnv, key, value, 'SPACE_VALUE_');
    }
  }

  // Add bundle secrets using configured key names.
  if (options?.bundleSecrets) {
    for (const [key, value] of Object.entries(options.bundleSecrets)) {
      scriptEnv[key] = value;
      setCompatibilityAliases(scriptEnv, key, value, 'SPACE_SECRET_');
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
      // Also stream to onOutput callback if provided (for TUI/Web terminal display)
      let output = '';
      if (options?.nonInteractive && child.stdout && child.stderr) {
        child.stdout.on('data', (data: Buffer) => {
          output += data.toString();
          options?.onOutput?.(data);
        });
        child.stderr.on('data', (data: Buffer) => {
          output += data.toString();
          options?.onOutput?.(data);
        });
      }

      child.on('close', (code: number | null) => {
        if (code !== 0) {
          // Log captured output on failure in non-interactive mode
          if (options?.nonInteractive && output) {
            logger.debug(`Script output:\n${output}`);
          }
          reject(
            new SpacesError(
              formatScriptFailureMessage(scriptName, code, output),
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
