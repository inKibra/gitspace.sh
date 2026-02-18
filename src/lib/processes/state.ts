/**
 * Process state helpers (started + last exit)
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getProcessControlDir } from './control.js';

export interface ProcessExitInfo {
  exitCode: number;
  exitedAt: number;
}

function getStartedDir(workspacePath: string): string {
  return join(getProcessControlDir(workspacePath), 'started');
}

function getExitDir(workspacePath: string): string {
  return join(getProcessControlDir(workspacePath), 'exit');
}

function getStartedPath(workspacePath: string, name: string, instance: number): string {
  return join(getStartedDir(workspacePath), `${name}-${instance}`);
}

function getExitPath(workspacePath: string, name: string, instance: number): string {
  return join(getExitDir(workspacePath), `${name}-${instance}.json`);
}

export function markProcessStarted(workspacePath: string, name: string, instance: number): void {
  const dir = getStartedDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  const file = getStartedPath(workspacePath, name, instance);
  writeFileSync(file, String(Date.now()), 'utf-8');
}

export function hasProcessStarted(workspacePath: string, name: string, instance: number): boolean {
  return existsSync(getStartedPath(workspacePath, name, instance));
}

export function recordProcessExit(
  workspacePath: string,
  name: string,
  instance: number,
  exitCode: number,
  exitedAt = Date.now()
): void {
  const dir = getExitDir(workspacePath);
  mkdirSync(dir, { recursive: true });
  const file = getExitPath(workspacePath, name, instance);
  const payload = JSON.stringify({ exitCode, exitedAt });
  writeFileSync(file, payload, 'utf-8');
}

export function readProcessExit(
  workspacePath: string,
  name: string,
  instance: number
): ProcessExitInfo | null {
  const file = getExitPath(workspacePath, name, instance);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf-8');
    const parsed = JSON.parse(raw) as ProcessExitInfo;
    if (
      parsed &&
      typeof parsed.exitCode === 'number' &&
      typeof parsed.exitedAt === 'number'
    ) {
      return parsed;
    }
  } catch {}
  return null;
}

export function clearProcessExit(workspacePath: string, name: string, instance: number): void {
  const file = getExitPath(workspacePath, name, instance);
  if (existsSync(file)) {
    rmSync(file, { force: true });
  }
}
