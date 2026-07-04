/**
 * Convention-based script runner
 * Discovers and runs executable scripts from project scripts/ directories
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { spawn } from 'child_process';
import { basename, join } from 'path';
import { createHash } from 'crypto';
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

/** Result of scanning a phase directory. */
export interface PhaseScriptScan {
  /** Absolute paths of runnable (executable) scripts, sorted lexicographically. */
  executable: string[];
  /**
   * Absolute paths of script-looking files that are NOT executable and were
   * therefore skipped (files with a script extension or a shebang line). These
   * are surfaced as errors rather than silently ignored.
   */
  ignored: string[];
}

const SCRIPT_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.js', '.ts', '.mjs']);

/** True if a non-executable regular file looks like it was meant to be a script. */
function looksLikeScript(filePath: string): boolean {
  const name = basename(filePath);
  const dot = name.lastIndexOf('.');
  if (dot > 0 && SCRIPT_EXTENSIONS.has(name.slice(dot).toLowerCase())) {
    return true;
  }
  try {
    const fd = readFileSync(filePath);
    return fd.length >= 2 && fd[0] === 0x23 && fd[1] === 0x21; // "#!"
  } catch {
    return false;
  }
}

/**
 * Scan a phase directory, separating runnable executable scripts from
 * script-looking files that are missing an executable bit (which we must not
 * silently skip). Executable scripts are sorted lexicographically for
 * predictable serial execution order.
 */
export function discoverPhaseScripts(scriptsDir: string): PhaseScriptScan {
  if (!existsSync(scriptsDir)) {
    logger.debug(`Scripts directory does not exist: ${scriptsDir}`);
    return { executable: [], ignored: [] };
  }

  try {
    const files = readdirSync(scriptsDir);
    const executable: string[] = [];
    const ignored: string[] = [];

    for (const file of files) {
      const filePath = join(scriptsDir, file);
      const stats = statSync(filePath);
      if (!stats.isFile()) continue;

      // Executable on Unix = any execute bit set.
      if ((stats.mode & 0o111) !== 0) {
        executable.push(filePath);
      } else if (looksLikeScript(filePath)) {
        ignored.push(filePath);
      }
    }

    executable.sort();
    ignored.sort();

    logger.debug(`Discovered ${executable.length} executable scripts (${ignored.length} ignored) in ${scriptsDir}`);
    return { executable, ignored };
  } catch (error) {
    logger.debug(`Error discovering scripts: ${error}`);
    return { executable: [], ignored: [] };
  }
}

/**
 * Discover executable scripts in a directory, sorted lexicographically.
 * Thin wrapper over {@link discoverPhaseScripts} for callers that only need the
 * runnable set.
 */
export function discoverScripts(scriptsDir: string): string[] {
  return discoverPhaseScripts(scriptsDir).executable;
}

/**
 * Error thrown when a phase directory contains script-looking files that are not
 * executable — so they'd be silently skipped. Names each file and the fix.
 */
export class NonExecutableScriptError extends SpacesError {
  readonly files: string[];
  constructor(phase: string, files: string[]) {
    const list = files.map((f) => `  - ${f}`).join('\n');
    const fix = files.map((f) => `chmod +x ${f}`).join('\n  ');
    super(
      `Non-executable script${files.length > 1 ? 's' : ''} found in "${phase}" phase (skipped because the executable bit is not set):\n${list}\n\nFix:\n  ${fix}`,
      'USER_ERROR',
      1,
    );
    this.name = 'NonExecutableScriptError';
    this.files = files;
  }
}

export function isNonExecutableScriptError(error: unknown): error is NonExecutableScriptError {
  return error instanceof NonExecutableScriptError;
}

/**
 * Centralized script-manifest fingerprint for a phase directory. Captures
 * discovery-relevant state so lifecycle decisions invalidate when scripts
 * change: phase name, directory absent/empty/present, sorted executable
 * relative paths with content hashes, and the set of ignored (non-executable)
 * script-looking files (so a `chmod +x` invalidates the phase). Never uses
 * mtimes.
 */
export function buildPhaseScriptManifest(scriptsDir: string): string {
  const phase = basename(scriptsDir);
  if (!existsSync(scriptsDir)) {
    return hashManifest({ phase, state: 'absent' });
  }
  const { executable, ignored } = discoverPhaseScripts(scriptsDir);
  if (executable.length === 0 && ignored.length === 0) {
    return hashManifest({ phase, state: 'empty' });
  }
  const executableEntries = executable.map((filePath) => {
    let contentHash = 'unreadable';
    try {
      contentHash = createHash('sha256').update(readFileSync(filePath)).digest('hex').slice(0, 16);
    } catch {
      /* keep sentinel */
    }
    return { rel: basename(filePath), contentHash };
  });
  return hashManifest({
    phase,
    state: 'present',
    executable: executableEntries,
    ignored: ignored.map((filePath) => basename(filePath)),
  });
}

function hashManifest(manifest: unknown): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);
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
  /** Optional cancellation signal for in-flight script execution. */
  signal?: AbortSignal;
}

export class ScriptExecutionCancelledError extends Error {
  readonly code = 'SCRIPT_CANCELLED';

  constructor(message: string = 'Script execution cancelled by user.') {
    super(message);
    this.name = 'ScriptExecutionCancelledError';
  }
}

export function isScriptExecutionCancelledError(error: unknown): error is ScriptExecutionCancelledError {
  return error instanceof ScriptExecutionCancelledError;
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
  if (options?.signal?.aborted) {
    throw new ScriptExecutionCancelledError();
  }

  const phaseName = basename(scriptsDir) || 'scripts';
  const { executable: scripts, ignored } = discoverPhaseScripts(scriptsDir);

  // Never silently skip script-looking files that just lack the executable bit —
  // surface them as a phase error with the exact chmod fix.
  if (ignored.length > 0) {
    throw new NonExecutableScriptError(phaseName, ignored);
  }

  if (scripts.length === 0) {
    logger.debug(`No scripts to run in ${scriptsDir}`);
    return;
  }

  logger.info(`Running ${phaseName} scripts...`);
  // Stream a visible phase banner into the task transcript (not just the console)
  // so phase boundaries are preserved across the run.
  if (options?.nonInteractive) {
    options?.onOutput?.(Buffer.from(`\r\n==> ${phaseName} scripts\r\n`));
  }

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
    if (options?.signal?.aborted) {
      throw new ScriptExecutionCancelledError();
    }

    await new Promise<void>((resolve, reject) => {
      const scriptName = basename(scriptPath) || scriptPath;
      logger.dim(`  $ ${scriptName} ${workspaceName} ${repository}`);
      // Stream each script's start line into the transcript so individual script
      // boundaries (and ordering) are visible in the task bar.
      if (options?.nonInteractive) {
        options?.onOutput?.(Buffer.from(`$ ${scriptName} ${workspaceName} ${repository}\r\n`));
      }

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

      let settled = false;
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

      const settle = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;

        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
          forceKillTimer = null;
        }

        if (options?.signal) {
          options.signal.removeEventListener('abort', handleAbort);
        }

        fn();
      };

      const handleAbort = () => {
        if (settled) {
          return;
        }

        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 1500);
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', handleAbort, { once: true });
      }

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
        if (options?.signal?.aborted) {
          settle(() => reject(new ScriptExecutionCancelledError()));
          return;
        }

        if (code !== 0) {
          settle(() => {
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
          });
          return;
        }

        settle(resolve);
      });

      child.on('error', (error: Error) => {
        if (options?.signal?.aborted) {
          settle(() => reject(new ScriptExecutionCancelledError()));
          return;
        }

        settle(() => reject(
          new SpacesError(
            `Failed to run script: ${error.message}`,
            'SYSTEM_ERROR',
            2
          )
        ));
      });
    });
  }

  logger.success(`${phaseName} scripts completed`);
}
