import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getWorkspaceRoot } from '../core/paths.js';

const CRASH_LOG_DIR = join(getWorkspaceRoot(), '.logs');
const CRASH_LOG_PATH = join(CRASH_LOG_DIR, 'gssh-crash.log');
const REDACTED = '[REDACTED]';
const SENSITIVE_FLAGS = new Set([
  '--bootstrap-token',
  '--enrollment-token',
  '--invite',
  '--linear-key',
  '--machine-key-exchange-key',
  '--machine-signing-key',
  '--relay-private-key',
  '--unlock-token',
]);

function toText(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getCrashLogPath(): string {
  return CRASH_LOG_PATH;
}

function isSensitiveFlag(arg: string): boolean {
  return SENSITIVE_FLAGS.has(arg);
}

export function redactArgv(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;

  for (const arg of argv) {
    if (redactNext) {
      redacted.push(REDACTED);
      redactNext = false;
      continue;
    }

    if (!arg.startsWith('--')) {
      redacted.push(arg);
      continue;
    }

    const [flag] = arg.split('=', 1);
    if (!isSensitiveFlag(flag)) {
      redacted.push(arg);
      continue;
    }

    if (arg.includes('=')) {
      redacted.push(`${flag}=${REDACTED}`);
      continue;
    }

    redacted.push(arg);
    redactNext = true;
  }

  return redacted;
}

export function writeCrashLog(kind: string, error: unknown, context?: Record<string, unknown>): string {
  try {
    mkdirSync(CRASH_LOG_DIR, { recursive: true });

    const lines = [
      '---',
      `[${new Date().toISOString()}] ${kind}`,
      `pid=${process.pid}`,
      `argv=${JSON.stringify(redactArgv(process.argv))}`,
    ];

    if (context && Object.keys(context).length > 0) {
      lines.push(`context=${toText(context)}`);
    }

    lines.push(toText(error), '');
    appendFileSync(CRASH_LOG_PATH, `${lines.join('\n')}\n`, 'utf-8');
    return CRASH_LOG_PATH;
  } catch (writeError) {
    try {
      process.stderr.write(
        `[gssh] Failed to write crash log at ${CRASH_LOG_PATH}: ${toText(writeError)}\n`,
      );
    } catch {
      // Best effort only.
    }

    return '';
  }
}
