/**
 * Process control helpers (disable/enable restarts)
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { encodeProcessNameForPath } from './names.js';

export function getProcessControlDir(workspacePath: string): string {
  return join(workspacePath, '.gitspace', '.processes');
}

export function getProcessDisableDir(workspacePath: string): string {
  return join(getProcessControlDir(workspacePath), 'disabled');
}

export function getProcessDisablePath(
  workspacePath: string,
  name: string,
  instance: number
): string {
  return join(getProcessDisableDir(workspacePath), `${encodeProcessNameForPath(name)}-${instance}`);
}

export function disableProcessRestart(
  workspacePath: string,
  name: string,
  instance: number
): void {
  const dir = getProcessDisableDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  const file = getProcessDisablePath(workspacePath, name, instance);
  writeFileSync(file, new Date().toISOString(), 'utf-8');
}

export function enableProcessRestart(
  workspacePath: string,
  name: string,
  instance: number
): void {
  const file = getProcessDisablePath(workspacePath, name, instance);
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
}

export function isProcessRestartDisabled(
  workspacePath: string,
  name: string,
  instance: number
): boolean {
  return existsSync(getProcessDisablePath(workspacePath, name, instance));
}
