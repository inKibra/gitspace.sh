import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkspaceRoot } from '../core/paths.js';

function getAgentLogPath(): string {
  const dir = join(getWorkspaceRoot(), '.agent');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return join(dir, 'agent-runtime.log');
}

export function writeAgentLog(message: string, details?: unknown): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}${details === undefined ? '' : ` ${JSON.stringify(details)}`}\n`;
    appendFileSync(getAgentLogPath(), line, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // never fail the app on logging
  }
}
