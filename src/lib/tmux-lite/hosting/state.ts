import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { readMachineIdentity } from '../../../core/identity.js';
import { getTmuxLitePaths } from '../protocol.js';
import { normalizeHostLabel } from '../../../utils/hostnames.js';

export interface TmuxHostingState {
  baseHost?: string;
  machineName?: string;
  enabled: boolean;
  cloudflaredPid?: number;
  cloudflaredConfigPath?: string;
  updatedAt: number;
}

function getHostingStatePath(): string {
  return join(getTmuxLitePaths().sessionDir, '.gitspace-hosting.json');
}

function getDefaultMachineName(): string {
  const machineIdentity = readMachineIdentity();
  if (machineIdentity?.machineName?.trim()) {
    return normalizeHostLabel(machineIdentity.machineName);
  }
  return normalizeHostLabel(os.hostname());
}

export function readTmuxHostingState(): TmuxHostingState | null {
  const filePath = getHostingStatePath();
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<TmuxHostingState>;
    return {
      baseHost: parsed.baseHost?.trim() || undefined,
      machineName: parsed.machineName?.trim() || undefined,
      enabled: parsed.enabled !== false,
      cloudflaredPid: typeof parsed.cloudflaredPid === 'number' ? parsed.cloudflaredPid : undefined,
      cloudflaredConfigPath: parsed.cloudflaredConfigPath?.trim() || undefined,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
    };
  } catch {
    return null;
  }
}

export function writeTmuxHostingState(next: Partial<TmuxHostingState>): TmuxHostingState {
  const current = readTmuxHostingState();
  const filePath = getHostingStatePath();
  mkdirSync(dirname(filePath), { recursive: true });

  const state: TmuxHostingState = {
    baseHost: next.baseHost?.trim() || current?.baseHost,
    machineName: normalizeHostLabel(next.machineName?.trim() || current?.machineName || getDefaultMachineName()),
    enabled: next.enabled ?? current?.enabled ?? true,
    cloudflaredPid: Object.prototype.hasOwnProperty.call(next, 'cloudflaredPid')
      ? next.cloudflaredPid
      : current?.cloudflaredPid,
    cloudflaredConfigPath: Object.prototype.hasOwnProperty.call(next, 'cloudflaredConfigPath')
      ? next.cloudflaredConfigPath
      : current?.cloudflaredConfigPath,
    updatedAt: Date.now(),
  };

  writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
  return state;
}

export function clearTmuxHostingState(): void {
  const filePath = getHostingStatePath();
  if (existsSync(filePath)) {
    rmSync(filePath);
  }
}

export function resolveTmuxHostingState(): TmuxHostingState {
  return readTmuxHostingState() ?? {
    enabled: false,
    machineName: getDefaultMachineName(),
    updatedAt: Date.now(),
  };
}
