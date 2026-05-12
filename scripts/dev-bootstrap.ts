import { basename } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';

interface KeypairStorage {
  id?: string;
}

interface MachineIdentityLike {
  machineId?: string;
}

interface RelayConfigLike {
  machineId?: string;
}

export interface SandboxBootstrapPaths {
  keypairPath: string;
  secretsPath: string;
  devIdentityPath: string;
  machineIdentityPath: string;
  relayConfigPath: string;
}

export interface SandboxBootstrapValidation {
  valid: boolean;
  reason?: string;
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function validateMachineBoundFile(args: {
  path: string;
  fieldName: string;
  expectedMachineId: string;
}): SandboxBootstrapValidation {
  if (!existsSync(args.path)) {
    return { valid: true };
  }

  let parsed: MachineIdentityLike | RelayConfigLike;
  try {
    parsed = parseJsonFile(args.path) as MachineIdentityLike | RelayConfigLike;
  } catch {
    return { valid: false, reason: `malformed ${basename(args.path)}` };
  }

  if (!parsed.machineId) {
    return { valid: false, reason: `${basename(args.path)} missing ${args.fieldName}` };
  }

  if (parsed.machineId !== args.expectedMachineId) {
    return {
      valid: false,
      reason: `${basename(args.path)} machineId does not match keypair id`,
    };
  }

  return { valid: true };
}

/**
 * Check that all interdependent bootstrap artifacts exist and parse. The
 * identity keypair, the test secrets file (with USER_ROOT_IDENTITY), the
 * browser identity, and any persisted machine metadata must all agree.
 * If any part is missing, malformed, or bound to a different machine id,
 * the sandbox is considered incomplete and must be regenerated from scratch.
 */
export function validateSandboxBootstrap(paths: SandboxBootstrapPaths): SandboxBootstrapValidation {
  if (!existsSync(paths.keypairPath)) {
    return { valid: false, reason: `missing ${basename(paths.keypairPath)}` };
  }
  if (!existsSync(paths.secretsPath)) {
    return { valid: false, reason: `missing ${basename(paths.secretsPath)}` };
  }
  if (!existsSync(paths.devIdentityPath)) {
    return { valid: false, reason: `missing ${basename(paths.devIdentityPath)}` };
  }

  let keypairStorage: KeypairStorage;
  try {
    keypairStorage = parseJsonFile(paths.keypairPath) as KeypairStorage;
  } catch {
    return { valid: false, reason: `malformed ${basename(paths.keypairPath)}` };
  }

  if (!keypairStorage.id) {
    return { valid: false, reason: 'keypair.json missing id' };
  }

  try {
    parseJsonFile(paths.devIdentityPath);
  } catch {
    return { valid: false, reason: `malformed ${basename(paths.devIdentityPath)}` };
  }

  try {
    const outer = parseJsonFile(paths.secretsPath) as {
      entries?: Record<string, string>;
    };
    const blob = outer.entries?.['com.gitspace:secrets'];
    if (!blob) return { valid: false, reason: 'secrets.json missing com.gitspace:secrets entry' };
    const parsed = JSON.parse(blob) as { global?: Record<string, string> };
    if (!parsed.global?.USER_ROOT_IDENTITY) {
      return { valid: false, reason: 'secrets.json missing USER_ROOT_IDENTITY' };
    }
  } catch {
    return { valid: false, reason: `malformed ${basename(paths.secretsPath)}` };
  }

  const machineIdentityValidation = validateMachineBoundFile({
    path: paths.machineIdentityPath,
    fieldName: 'machineId',
    expectedMachineId: keypairStorage.id,
  });
  if (!machineIdentityValidation.valid) {
    return machineIdentityValidation;
  }

  const relayConfigValidation = validateMachineBoundFile({
    path: paths.relayConfigPath,
    fieldName: 'machineId',
    expectedMachineId: keypairStorage.id,
  });
  if (!relayConfigValidation.valid) {
    return relayConfigValidation;
  }

  return { valid: true };
}

/**
 * Remove machine-bound metadata that becomes invalid when the sandbox identity
 * is regenerated. The next successful serve start will re-write these files.
 */
export function clearSandboxBootstrapMetadata(paths: SandboxBootstrapPaths): void {
  for (const path of [paths.machineIdentityPath, paths.relayConfigPath]) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch {
      // Best-effort cleanup. Startup will fail later with a concrete error if a
      // stale file remains unreadable or undeletable.
    }
  }
}
