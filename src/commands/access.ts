/**
 * Access control command implementations
 * Handles 'gssh access add', 'gssh access list', and 'gssh access remove'
 */

import chalk from 'chalk';
import { logger } from '../utils/logger.js';
import { promptInput, promptConfirm } from '../utils/prompts.js';
import {
  readAccessList,
  addAccess,
  removeAccess,
  getAccessEntry,
  parsePublicKey,
  formatFingerprint,
  formatAccessType,
} from '../core/access.js';
import type { AccessEntry } from '../types/identity.js';
import { SpacesError } from '../types/errors.js';
import {
  isServeRunning,
  sendAddAccessCommand,
  sendRemoveAccessCommand,
} from '../serve/daemon.js';

/**
 * Sync access change to relay via serve daemon
 * Falls back to local-only if daemon not running
 *
 * @param action - 'add' or 'remove'
 * @param entry - Access entry being modified
 * @returns true if synced to relay, false if local-only
 */
async function syncToRelay(
  action: 'add' | 'remove',
  entry: AccessEntry
): Promise<boolean> {
  if (!isServeRunning()) {
    logger.dim('(serve daemon not running - saved locally only)');
    return false;
  }

  try {
    if (action === 'add') {
      const result = await sendAddAccessCommand({
        clientIdentityId: entry.identityId,
        signingKey: entry.signingPublicKey,
        keyExchangeKey: entry.keyExchangePublicKey || '',
        label: entry.label,
        accessType: entry.accessType,
        sessionId: entry.sessionId,
      });

      if (result.success) {
        logger.dim('(synced to relay)');
        return true;
      } else {
        logger.dim(`(relay sync failed: ${result.error})`);
        return false;
      }
    } else {
      const result = await sendRemoveAccessCommand(entry.identityId);

      if (result.success) {
        logger.dim('(synced to relay)');
        return true;
      } else {
        logger.dim(`(relay sync failed: ${result.error})`);
        return false;
      }
    }
  } catch (err) {
    logger.dim(`(relay sync error: ${err instanceof Error ? err.message : 'unknown'})`);
    return false;
  }
}

/**
 * Add a new access key (grants full access)
 *
 * @param pubkey - Public key string (gssh-pub:SIGNING:KEYEXCHANGE or just SIGNING)
 * @param options - Command options
 */
export async function addAccessKey(
  pubkey: string,
  options: {
    label?: string;
  }
): Promise<void> {
  // Parse the public key
  let publicIdentity;
  try {
    publicIdentity = parsePublicKey(pubkey);
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }
    throw new SpacesError(
      `Invalid public key format: ${error instanceof Error ? error.message : String(error)}`,
      'USER_ERROR',
      1
    );
  }

  // Check if key exchange key is missing (only signing key was provided)
  if (!publicIdentity.keyExchangePublicKey) {
    logger.warning('Only signing key provided. Key exchange key is required for full functionality.');
    const keyExchangeKey = await promptInput(
      'Enter key exchange public key (base64, or press Enter to skip):'
    );
    if (keyExchangeKey && keyExchangeKey.trim()) {
      publicIdentity.keyExchangePublicKey = keyExchangeKey.trim();
    } else {
      logger.warning('Proceeding without key exchange key. Encrypted connections will not be possible.');
    }
  }

  // Get label if not provided
  let label = options.label;
  if (!label) {
    const input = await promptInput('Enter a label for this key (optional):');
    label = input || undefined;
  }

  // Check if this identity already exists
  const existing = getAccessEntry(publicIdentity.id);
  if (existing) {
    logger.warning(`Identity ${formatFingerprint(publicIdentity.id)} already exists with label "${existing.label}"`);
    const replace = await promptConfirm('Replace existing entry?', false);
    if (!replace) {
      logger.info('Cancelled');
      return;
    }
  }

  // Add to access list with full access
  const entry = addAccess(publicIdentity, label, 'full');

  logger.success('Access key added');
  logger.log(`  ID:          ${chalk.cyan(entry.identityId)}`);
  logger.log(`  Fingerprint: ${chalk.dim(formatFingerprint(entry.identityId))}`);
  if (entry.label) {
    logger.log(`  Label:       ${chalk.yellow(entry.label)}`);
  }
  logger.log(`  Access:      ${formatAccessType(entry.accessType)}`);

  // Sync to relay (if serve daemon running)
  await syncToRelay('add', entry);
}

/**
 * List all access keys
 *
 * @param options - Command options
 */
export async function listAccessKeys(
  options: {
    json?: boolean;
  } = {}
): Promise<void> {
  const entries = readAccessList();

  if (entries.length === 0) {
    if (options.json) {
      console.log(JSON.stringify([], null, 2));
      return;
    }

    logger.info('No access keys configured');
    logger.log('\nAdd a key:\n  gssh access add <pubkey>');
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(entries, null, 2));
    return;
  }

  // Display as table
  logger.bold('Access Keys:');
  logger.log('');

  // Header
  const labelWidth = 18;
  const idWidth = 18;
  const accessWidth = 16;
  const dateWidth = 12;

  logger.dim(
    'Label'.padEnd(labelWidth) +
    'ID'.padEnd(idWidth) +
    'Access'.padEnd(accessWidth) +
    'Added'
  );
  logger.dim('─'.repeat(labelWidth + idWidth + accessWidth + dateWidth));

  // Entries
  for (const entry of entries) {
    const label = (entry.label || '<no label>').substring(0, labelWidth - 1);
    const id = formatFingerprint(entry.identityId);
    const access = formatAccessType(entry.accessType, entry.sessionId);
    const date = new Date(entry.grantedAt).toISOString().split('T')[0];

    const labelCol = label.padEnd(labelWidth);
    const idCol = chalk.cyan(id).padEnd(idWidth + 9); // +9 for ANSI color codes
    const accessCol = access.padEnd(accessWidth);
    const dateCol = chalk.dim(date);

    logger.log(labelCol + idCol + accessCol + dateCol);
  }

  logger.log('');
  logger.dim(`Total: ${entries.length} key(s)`);
}

/**
 * Remove an access key
 *
 * @param pubkeyOrLabel - Public key, identity ID prefix, or label
 * @param options - Command options
 */
export async function removeAccessKey(
  pubkeyOrLabel: string,
  options: {
    force?: boolean;
  }
): Promise<void> {
  // Try to find the entry
  let entry = getAccessEntry(pubkeyOrLabel);

  // If not found, try parsing as a public key
  if (!entry) {
    try {
      const publicIdentity = parsePublicKey(pubkeyOrLabel);
      entry = getAccessEntry(publicIdentity.id);
    } catch {
      // Not a valid public key, continue
    }
  }

  if (!entry) {
    // Provide helpful suggestions
    const entries = readAccessList();
    if (entries.length === 0) {
      throw new SpacesError(
        'No access keys configured',
        'USER_ERROR',
        1
      );
    }

    logger.error(`No access key found matching: ${pubkeyOrLabel}`);
    logger.log('\nAvailable keys:');
    for (const e of entries) {
      logger.log(`  ${e.label || '<no label>'} (${formatFingerprint(e.identityId)})`);
    }
    throw new SpacesError('Key not found', 'USER_ERROR', 1);
  }

  // Confirm removal unless --force
  if (!options.force) {
    logger.log('Found access key:');
    logger.log(`  ID:          ${chalk.cyan(entry.identityId)}`);
    logger.log(`  Fingerprint: ${chalk.dim(formatFingerprint(entry.identityId))}`);
    if (entry.label) {
      logger.log(`  Label:       ${chalk.yellow(entry.label)}`);
    }
    logger.log(`  Access:      ${formatAccessType(entry.accessType, entry.sessionId)}`);
    logger.log('');

    const confirmed = await promptConfirm('Remove this key?', false);
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  // Sync removal to relay (before local remove, so we have entry data)
  await syncToRelay('remove', entry);

  // Remove the entry locally
  const removed = removeAccess(entry.identityId);

  if (!removed) {
    throw new SpacesError(
      'Failed to remove key (this should not happen)',
      'SYSTEM_ERROR',
      2
    );
  }

  logger.success('Access key removed');
  if (removed.label) {
    logger.log(`  Removed: ${removed.label} (${formatFingerprint(removed.identityId)})`);
  } else {
    logger.log(`  Removed: ${formatFingerprint(removed.identityId)}`);
  }
}
