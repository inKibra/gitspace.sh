/**
 * Convention-based script runner
 * Discovers and runs executable scripts from project scripts/ directories
 */

import { existsSync, readdirSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { join } from 'path';
import { SpacesError } from '../types/errors.js';
import { logger } from './logger.js';
import { isShellEnvKey, normalizeEnvKey } from './normalize-env-key.js';

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

type BundleValueKind = 'value' | 'secret';

interface EnvBinding {
  envName: string;
  configKey: string;
  sourceKind: BundleValueKind;
  exportKind: 'exact' | 'normalized';
  value: string;
}

function describeBinding(binding: EnvBinding): string {
  return `${binding.configKey} (${binding.exportKind} ${binding.sourceKind})`;
}

function describeValue(binding: EnvBinding): string {
  return binding.sourceKind === 'secret' ? '[redacted]' : JSON.stringify(binding.value);
}

function formatEnvCollisionMessage(existing: EnvBinding, incoming: EnvBinding): string {
  return [
    'Bundle script env collision',
    '',
    `Multiple config keys resolve to the same environment variable: ${incoming.envName}`,
    `- ${incoming.envName} <- ${describeBinding(existing)}`,
    `- ${incoming.envName} <- ${describeBinding(incoming)}`,
    '',
    `Scripts would read an ambiguous value from $${incoming.envName}.`,
    'Fix: rename one of the conflicting configKey values in .gitspace/bundle.json so each exported env var is unique.',
  ].join('\n');
}

function formatDuplicateValueMessage(existing: EnvBinding, incoming: EnvBinding): string {
  return [
    'Bundle script env conflict',
    '',
    `The same configKey is exported with different values: ${incoming.configKey}`,
    `- ${describeBinding(existing)} => ${describeValue(existing)}`,
    `- ${describeBinding(incoming)} => ${describeValue(incoming)}`,
    '',
    `This would silently overwrite $${incoming.envName}.`,
    `Fix: ensure configKey "${incoming.configKey}" is defined once with a single value.`,
  ].join('\n');
}

function formatInvalidNormalizedAliasMessage(configKey: string, normalizedAlias: string): string {
  return [
    'Bundle script env alias is not shell-safe',
    '',
    `configKey "${configKey}" normalizes to "${normalizedAlias}".`,
    `Scripts cannot access this via $${normalizedAlias}.`,
    '',
    'Shell variable names must match: [A-Za-z_][A-Za-z0-9_]*',
    'Fix: rename the configKey so its normalized alias starts with a letter or underscore.',
  ].join('\n');
}

function registerEnvBinding(
  env: Record<string, string>,
  bindings: Map<string, EnvBinding>,
  binding: EnvBinding
): void {
  const existing = bindings.get(binding.envName);

  if (existing && existing.configKey !== binding.configKey) {
    throw new SpacesError(formatEnvCollisionMessage(existing, binding), 'USER_ERROR', 1);
  }

  if (existing && existing.configKey === binding.configKey && existing.value !== binding.value) {
    throw new SpacesError(formatDuplicateValueMessage(existing, binding), 'USER_ERROR', 1);
  }

  bindings.set(binding.envName, binding);
  env[binding.envName] = binding.value;
}

function setScriptEnvVars(
  env: Record<string, string>,
  bindings: Map<string, EnvBinding>,
  key: string,
  value: string,
  sourceKind: BundleValueKind
): void {
  registerEnvBinding(env, bindings, {
    envName: key,
    configKey: key,
    sourceKind,
    exportKind: 'exact',
    value,
  });

  const normalizedKey = normalizeEnvKey(key);
  if (!normalizedKey) {
    return;
  }

  if (!isShellEnvKey(normalizedKey)) {
    throw new SpacesError(formatInvalidNormalizedAliasMessage(key, normalizedKey), 'USER_ERROR', 1);
  }

  if (normalizedKey === key) {
    return;
  }

  // Uppercase snake-case alias for shell-friendly access when key uses
  // camelCase or punctuation (for example, apiToken -> API_TOKEN).
  registerEnvBinding(env, bindings, {
    envName: normalizedKey,
    configKey: key,
    sourceKind,
    exportKind: 'normalized',
    value,
  });
}

/**
 * Run scripts in the current terminal
 * Used for pre-scripts that run before tmux session
 *
 * Bundle values are passed as environment variables:
 * - <KEY> using the exact bundle config key name
 * - <NORMALIZED_KEY> uppercase snake-case alias (for example, apiToken -> API_TOKEN)
 * - Throws a user-facing error when multiple keys collide on the same env name
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
  const envBindings = new Map<string, EnvBinding>();

  // Add bundle values using configured key names.
  if (options?.bundleValues) {
    for (const [key, value] of Object.entries(options.bundleValues)) {
      setScriptEnvVars(scriptEnv, envBindings, key, value, 'value');
    }
  }

  // Add bundle secrets using configured key names.
  if (options?.bundleSecrets) {
    for (const [key, value] of Object.entries(options.bundleSecrets)) {
      setScriptEnvVars(scriptEnv, envBindings, key, value, 'secret');
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
