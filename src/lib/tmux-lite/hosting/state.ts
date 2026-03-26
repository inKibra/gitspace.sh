import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { readMachineIdentity } from '../../../core/identity.js';
import { getTmuxLitePaths } from '../protocol.js';
import { normalizeHostLabel } from '../../../utils/hostnames.js';
import { normalizeTmuxHostingBaseHost } from './base-host.js';

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

function normalizeStoredBaseHost(baseHost: string | undefined): { baseHost?: string; repaired: boolean } {
  const trimmed = baseHost?.trim();
  if (!trimmed) {
    return { baseHost: undefined, repaired: false };
  }
  try {
    const normalized = normalizeTmuxHostingBaseHost(trimmed);
    return { baseHost: normalized, repaired: normalized !== trimmed };
  } catch {
    return { baseHost: trimmed, repaired: false };
  }
}

export function readTmuxHostingState(): TmuxHostingState | null {
  const filePath = getHostingStatePath();
  if (!existsSync(filePath)) {
    return null;
  }

  let parsed: Partial<TmuxHostingState> & { routerPid?: unknown };
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<TmuxHostingState> & { routerPid?: unknown };
  } catch {
    return null;
  }

  const normalizedBaseHost = normalizeStoredBaseHost(parsed.baseHost);
  const state: TmuxHostingState = {
    baseHost: normalizedBaseHost.baseHost,
    machineName: parsed.machineName?.trim() || undefined,
    enabled: parsed.enabled !== false,
    cloudflaredPid: typeof parsed.cloudflaredPid === 'number' ? parsed.cloudflaredPid : undefined,
    cloudflaredConfigPath: parsed.cloudflaredConfigPath?.trim() || undefined,
    updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
  };
  if (normalizedBaseHost.repaired || typeof parsed.routerPid === 'number') {
    try {
      writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');
    } catch {
      // Keep the repaired in-memory state even if best-effort write-back fails.
    }
  }
  return state;
}

export function writeTmuxHostingState(next: Partial<TmuxHostingState>): TmuxHostingState {
  const current = readTmuxHostingState();
  const filePath = getHostingStatePath();
  mkdirSync(dirname(filePath), { recursive: true });

  const state: TmuxHostingState = {
    baseHost: typeof next.baseHost === 'string' ? normalizeTmuxHostingBaseHost(next.baseHost) : current?.baseHost,
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
