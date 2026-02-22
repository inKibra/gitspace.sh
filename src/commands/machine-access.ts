/**
 * Machine access control command implementations.
 *
 * Persistent grants are user-root keyed and machine-scoped.
 * Read-only session behavior is runtime-scoped and is not managed here.
 */

import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { promptConfirm } from '../utils/prompts.js';
import { readRelayConfig } from '../core/identity.js';
import { loadUserRootIdentity } from '../core/user-identity.js';
import { parseUserRootPublicKey } from '../lib/tmux-lite/crypto/user-identity.js';
import {
  grantMachineAccess,
  listMachineAccessList,
  revokeMachineAccess,
} from '../relay/auth/store.js';
import type { MachineAccessListEntry } from '../relay/auth/types.js';
import { SpacesError } from '../types/errors.js';

function resolveMachineId(explicitMachineId?: string): string {
  if (explicitMachineId && explicitMachineId.trim()) {
    return explicitMachineId.trim();
  }

  const relayConfig = readRelayConfig();
  if (relayConfig?.machineId) {
    return relayConfig.machineId;
  }

  throw new SpacesError(
    'Machine ID is required. Pass --machine <id> or run `gssh machine serve start` first.',
    'USER_ERROR',
    1,
  );
}

function resolveClientUserRootId(user: string): string {
  const trimmed = user.trim();
  if (!trimmed) {
    throw new SpacesError('User key is required', 'USER_ERROR', 1);
  }

  if (trimmed.startsWith('gssh-user:')) {
    return parseUserRootPublicKey(trimmed).userRootId;
  }

  return trimmed;
}

function formatUserRootId(userRootId: string): string {
  return userRootId.length > 16 ? `${userRootId.slice(0, 12)}...` : userRootId;
}

function findMachineAccessEntry(
  entries: MachineAccessListEntry[],
  query: string,
): MachineAccessListEntry | null {
  const trimmed = query.trim();
  if (!trimmed) {
    return null;
  }

  const clientUserRootId = trimmed.startsWith('gssh-user:')
    ? parseUserRootPublicKey(trimmed).userRootId
    : trimmed;

  const exactById = entries.find((entry) => entry.clientUserRootId === clientUserRootId);
  if (exactById) {
    return exactById;
  }

  const prefixMatches = entries.filter((entry) => entry.clientUserRootId.startsWith(clientUserRootId));
  if (prefixMatches.length === 1) {
    return prefixMatches[0] ?? null;
  }

  const labelMatch = entries.find((entry) => entry.label?.toLowerCase() === trimmed.toLowerCase());
  return labelMatch ?? null;
}

export async function addAccessKey(
  user: string,
  options: {
    label?: string;
    machine?: string;
  },
): Promise<void> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError(
      'User root identity is required. Run `gssh user identity init` first.',
      'USER_ERROR',
      1,
    );
  }

  const machineId = resolveMachineId(options.machine);
  const clientUserRootId = resolveClientUserRootId(user);

  if (clientUserRootId === owner.id) {
    throw new SpacesError('Owner does not need a machine access grant.', 'USER_ERROR', 1);
  }

  const entry = grantMachineAccess({
    machineId,
    ownerUserRootId: owner.id,
    clientUserRootId,
    label: options.label,
  });

  logger.success('Machine access granted');
  logger.log(`  Machine: ${chalk.cyan(entry.machineId)}`);
  logger.log(`  User:    ${chalk.cyan(entry.clientUserRootId)}`);
  if (entry.label) {
    logger.log(`  Label:   ${chalk.yellow(entry.label)}`);
  }
  logger.log(`  Role:    full`);
}

export async function listAccessKeys(
  options: {
    json?: boolean;
    machine?: string;
  } = {},
): Promise<void> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError(
      'User root identity is required. Run `gssh user identity init` first.',
      'USER_ERROR',
      1,
    );
  }

  const machineId = resolveMachineId(options.machine);
  const entries = listMachineAccessList(machineId, owner.id);

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  if (entries.length === 0) {
    logger.info(`No machine access grants for ${machineId}`);
    return;
  }

  logger.bold(`Machine Access Grants (${machineId}):`);
  logger.log('');

  const userWidth = 18;
  const labelWidth = 22;
  const dateWidth = 12;

  logger.dim('USER ROOT'.padEnd(userWidth) + 'LABEL'.padEnd(labelWidth) + 'ROLE'.padEnd(8) + 'GRANTED');
  logger.dim('─'.repeat(userWidth + labelWidth + 8 + dateWidth));

  for (const entry of entries) {
    const userCol = formatUserRootId(entry.clientUserRootId).padEnd(userWidth);
    const labelCol = (entry.label || '-').slice(0, labelWidth - 1).padEnd(labelWidth);
    const roleCol = 'full'.padEnd(8);
    const dateCol = entry.grantedAt.split('T')[0] ?? entry.grantedAt;
    logger.log(chalk.cyan(userCol) + labelCol + roleCol + chalk.dim(dateCol));
  }

  logger.log('');
  logger.dim(`Total: ${entries.length} grant(s)`);
}

export async function removeAccessKey(
  userOrLabel: string,
  options: {
    force?: boolean;
    machine?: string;
  },
): Promise<void> {
  const owner = await loadUserRootIdentity();
  if (!owner) {
    throw new SpacesError(
      'User root identity is required. Run `gssh user identity init` first.',
      'USER_ERROR',
      1,
    );
  }

  const machineId = resolveMachineId(options.machine);
  const entries = listMachineAccessList(machineId, owner.id);
  const entry = findMachineAccessEntry(entries, userOrLabel);

  if (!entry) {
    throw new SpacesError(
      `No machine access grant found for '${userOrLabel}' on machine '${machineId}'.`,
      'USER_ERROR',
      1,
    );
  }

  if (!options.force) {
    logger.log('Remove machine access grant:');
    logger.log(`  Machine: ${chalk.cyan(entry.machineId)}`);
    logger.log(`  User:    ${chalk.cyan(entry.clientUserRootId)}`);
    if (entry.label) {
      logger.log(`  Label:   ${chalk.yellow(entry.label)}`);
    }
    logger.log('');
    const confirmed = await promptConfirm('Continue?', false);
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const removed = revokeMachineAccess(machineId, owner.id, entry.clientUserRootId);
  if (!removed) {
    throw new SpacesError('Failed to remove machine access grant.', 'SYSTEM_ERROR', 2);
  }

  logger.success('Machine access removed');
  logger.log(`  Machine: ${chalk.cyan(machineId)}`);
  logger.log(`  User:    ${chalk.cyan(entry.clientUserRootId)}`);
}
