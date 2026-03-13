import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CRASH_LOG_DIR = join(homedir(), 'gitspace', '.logs');
const CRASH_LOG_PATH = join(CRASH_LOG_DIR, 'gssh-crash.log');

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

export function writeCrashLog(kind: string, error: unknown, context?: Record<string, unknown>): string {
  mkdirSync(CRASH_LOG_DIR, { recursive: true });

  const lines = [
    '---',
    `[${new Date().toISOString()}] ${kind}`,
    `pid=${process.pid}`,
    `argv=${JSON.stringify(process.argv)}`,
  ];

  if (context && Object.keys(context).length > 0) {
    lines.push(`context=${toText(context)}`);
  }

  lines.push(toText(error), '');
  appendFileSync(CRASH_LOG_PATH, `${lines.join('\n')}\n`, 'utf-8');
  return CRASH_LOG_PATH;
}
