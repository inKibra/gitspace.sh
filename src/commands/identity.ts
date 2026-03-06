/**
 * Identity command handlers
 *
 * Implements user root identity management:
 *   gssh user identity init     — generate mnemonic, derive keys, store in keychain
 *   gssh user identity show     — display identity info
 *   gssh user identity recover  — recover from 24-word mnemonic
 *   gssh user identity export   — output public key in gssh-user: format
 *   gssh user identity remove   — remove from keychain
 *
 * @module commands/identity
 */

import { logger } from '../utils/logger.js';
import { promptConfirm, promptInput, promptPassword } from '../utils/prompts.js';
import {
  generateNewMnemonic,
  initFromMnemonic,
  loadUserRootIdentity,
  getUserRootPublicInfo,
  userRootIdentityExists,
  removeUserRootIdentity,
  formatFingerprint,
} from '../core/user-identity.js';
import {
  backupCurrentUserRootToCloud,
  deleteCloudIdentityBackup,
  getCloudIdentityBackup,
  getCloudIdentityBackupStatus,
  recoverUserRootFromCloudBackup,
} from '../core/identity-backup.js';
import { formatUserRootPublicKey } from '../lib/tmux-lite/crypto/user-identity.js';
import { SpacesError } from '../types/errors.js';

// ============================================================================
// gssh user identity init
// ============================================================================

/**
 * Initialize a new user root identity.
 *
 * Generates a 24-word BIP39 mnemonic, stores the mnemonic in the OS keychain,
 * derives keys on demand, and displays the mnemonic
 * ONCE to the user.
 */
export async function initIdentity(options: { force?: boolean } = {}): Promise<void> {
  // Check for existing identity
  const exists = await userRootIdentityExists();

  if (exists && !options.force) {
    throw new SpacesError(
      'Identity already exists. Use --force to overwrite (you will need your mnemonic to recover the old one).',
      'USER_ERROR',
      1,
    );
  }

  if (exists && options.force) {
    const confirmed = await promptConfirm(
      'This will overwrite your existing identity. You will need your 24-word mnemonic to recover it. Continue?',
      false,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  // Generate mnemonic
  const mnemonic = generateNewMnemonic();

  // Derive and store
  logger.info('Generating identity from new mnemonic...');
  const identity = await initFromMnemonic(mnemonic, options.force ?? false);

  const publicKeyString = formatUserRootPublicKey(identity);
  const fingerprint = formatFingerprint(identity.signing.publicKey);

  // Display mnemonic (one-time only)
  logger.log('');
  logger.bold('=== YOUR 24-WORD RECOVERY PHRASE ===');
  logger.log('');

  const words = mnemonic.split(' ');
  // Display in 4 columns of 6 words
  for (let row = 0; row < 6; row++) {
    const cols = [0, 6, 12, 18].map((base) => {
      const idx = base + row;
      const num = String(idx + 1).padStart(2, ' ');
      return `${num}. ${words[idx].padEnd(10)}`;
    });
    logger.log(`  ${cols.join('  ')}`);
  }

  logger.log('');
  logger.bold('=== WRITE THIS DOWN AND STORE IT SAFELY ===');
  logger.log('');
  logger.dim('This phrase is the ONLY way to recover your identity on a new device.');
  logger.dim('It will NOT be shown again after this step.');
  logger.dim('The mnemonic is stored in your OS keychain on this machine.');
  logger.log('');

  // Display identity info
  logger.success('Identity created and stored in keychain');
  logger.log('');
  logger.bold('Identity Information:');
  logger.log(`  ID:          ${identity.id}`);
  logger.log(`  Fingerprint: ${fingerprint}`);
  logger.log('');
  logger.bold('Public Key:');
  logger.log(`  ${publicKeyString}`);
}

// ============================================================================
// gssh user identity show
// ============================================================================

/**
 * Show identity information.
 * Reads from keychain (no mnemonic needed).
 */
export async function showIdentity(
  options: { fingerprint?: boolean; json?: boolean } = {},
): Promise<void> {
  const info = await getUserRootPublicInfo();

  if (!info) {
    throw new SpacesError(
      'No identity found. Run `gssh user identity init` to create one.',
      'USER_ERROR',
      1,
    );
  }

  if (options.json) {
    console.log(JSON.stringify({
      id: info.id,
      signingPublicKey: info.signingPublicKey,
      keyExchangePublicKey: info.keyExchangePublicKey,
      publicKey: info.publicKeyString,
      fingerprint: info.fingerprint,
      createdAt: info.createdAt,
    }, null, 2));
    return;
  }

  if (options.fingerprint) {
    logger.log(info.fingerprint);
    return;
  }

  logger.bold('Identity Information:');
  logger.log(`  ID:          ${info.id}`);
  logger.log(`  Fingerprint: ${info.fingerprint}`);
  logger.log(`  Created:     ${new Date(info.createdAt).toISOString()}`);
  logger.log('');
  logger.bold('Public Key:');
  logger.log(`  ${info.publicKeyString}`);
}

// ============================================================================
// gssh user identity recover
// ============================================================================

/**
 * Recover identity from a 24-word mnemonic.
 * Prompts the user to enter their mnemonic, derives keys, stores in keychain.
 */
export async function recoverIdentity(
  options: { force?: boolean; cloud?: boolean; yes?: boolean } = {},
): Promise<void> {
  if (options.cloud) {
    await recoverIdentityFromCloud(options);
    return;
  }

  const exists = await userRootIdentityExists();

  if (exists && !options.force) {
    throw new SpacesError(
      'Identity already exists. Use --force to overwrite.',
      'USER_ERROR',
      1,
    );
  }

  if (exists && options.force && !options.yes) {
    const confirmed = await promptConfirm(
      'This will replace your current identity. Continue?',
      false,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  // Prompt for mnemonic
  logger.log('Enter your 24-word recovery phrase (space-separated):');
  const mnemonic = await promptInput('Mnemonic:', {
    default: '',
  });

  if (!mnemonic || !mnemonic.trim()) {
    logger.info('Cancelled');
    return;
  }

  // Normalize: trim, lowercase, collapse whitespace
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');

  // Derive and store
  logger.info('Deriving identity from mnemonic...');
  const identity = await initFromMnemonic(normalized, options.force ?? exists ?? false);
  logIdentityRecovered(identity, 'Identity recovered and stored in keychain');
}

export async function recoverIdentityFromCloud(options: { force?: boolean; yes?: boolean } = {}): Promise<void> {
  const exists = await userRootIdentityExists();

  if (exists && !options.force) {
    throw new SpacesError(
      'Identity already exists. Use --force to overwrite.',
      'USER_ERROR',
      1,
    );
  }

  if (exists && options.force && !options.yes) {
    const confirmed = await promptConfirm(
      'This will replace your current identity using cloud backup. Continue?',
      false,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const backupPassword = await promptPassword('Enter your identity backup password:');
  if (!backupPassword) {
    logger.info('Cancelled');
    return;
  }

  logger.info('Recovering identity from cloud backup...');
  const identity = await recoverUserRootFromCloudBackup(backupPassword, {
    force: options.force ?? exists ?? false,
  });

  logIdentityRecovered(identity, 'Identity recovered from cloud backup and stored in keychain');
}

function logIdentityRecovered(identity: Awaited<ReturnType<typeof initFromMnemonic>>, successMessage: string): void {
  const publicKeyString = formatUserRootPublicKey(identity);
  const fingerprint = formatFingerprint(identity.signing.publicKey);

  logger.success(successMessage);
  logger.log('');
  logger.bold('Identity Information:');
  logger.log(`  ID:          ${identity.id}`);
  logger.log(`  Fingerprint: ${fingerprint}`);
  logger.log('');
  logger.bold('Public Key:');
  logger.log(`  ${publicKeyString}`);
}

// ============================================================================
// gssh user identity export
// ============================================================================

/**
 * Export the public key in gssh-user: format.
 * Outputs just the key string (suitable for piping).
 */
export async function exportIdentity(): Promise<void> {
  const info = await getUserRootPublicInfo();

  if (!info) {
    throw new SpacesError(
      'No identity found. Run `gssh user identity init` to create one.',
      'USER_ERROR',
      1,
    );
  }

  // Output just the key (no decoration) for piping
  console.log(info.publicKeyString);
}

// ============================================================================
// gssh user identity import
// ============================================================================

/**
 * Import a public key.
 *
 * NOTE: This imports a PEER's public key for reference/trust purposes.
 * It does NOT replace the local identity. That distinction will matter
 * when we build the user-root-keyed ACL (Phase 4).
 *
 * For now, this is a stub that validates the key format.
 */
export async function importIdentity(key: string): Promise<void> {
  const { parseUserRootPublicKey } = await import('../lib/tmux-lite/crypto/user-identity.js');

  try {
    const parsed = parseUserRootPublicKey(key);
    logger.success('Valid user root public key');
    logger.log(`  User Root ID: ${parsed.userRootId}`);
    logger.dim('Peer key import for ACL is not yet implemented (Phase 4).');
  } catch (error) {
    throw new SpacesError(
      `Invalid key format: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'USER_ERROR',
      1,
    );
  }
}

// ============================================================================
// gssh user identity remove
// ============================================================================

/**
 * Remove the user root identity from keychain.
 * Requires confirmation since the identity can only be recovered with the mnemonic.
 */
export async function removeIdentity(options: { force?: boolean } = {}): Promise<void> {
  const exists = await userRootIdentityExists();

  if (!exists) {
    logger.info('No identity to remove.');
    return;
  }

  if (!options.force) {
    logger.bold('WARNING: Removing your identity is irreversible without your 24-word mnemonic.');
    logger.log('');
    const confirmed = await promptConfirm(
      'Are you sure you want to remove your identity?',
      false,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const deleted = await removeUserRootIdentity();
  if (deleted) {
    logger.success('Identity removed from keychain.');
    logger.dim('Use `gssh user identity recover` with your mnemonic to restore it.');
  } else {
    logger.info('No identity found in keychain.');
  }
}

export async function enableIdentityBackup(options: { yes?: boolean } = {}): Promise<void> {
  const identity = await loadUserRootIdentity();
  if (!identity) {
    throw new SpacesError(
      'No identity found. Run `gssh user identity init` or `gssh user identity recover` first.',
      'USER_ERROR',
      1,
    );
  }

  const existing = await getCloudIdentityBackup();
  if (existing && !options.yes) {
    const confirmed = await promptConfirm(
      'An identity backup already exists in the cloud. Overwrite it?',
      false,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const backupPassword = await promptPassword('Create identity backup password:');
  if (!backupPassword) {
    logger.info('Cancelled');
    return;
  }

  const confirmPassword = await promptPassword('Confirm identity backup password:');
  if (backupPassword !== confirmPassword) {
    throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
  }

  const record = await backupCurrentUserRootToCloud(backupPassword);
  logger.success('Encrypted identity backup saved to GitSpace cloud');
  logger.log(`  Owner ID: ${record.ownerUserRootId}`);
  logger.log(`  Updated:  ${new Date(record.updatedAt).toISOString()}`);
}

export async function showIdentityBackupStatus(): Promise<void> {
  const status = await getCloudIdentityBackupStatus();
  if (!status.enabled) {
    logger.info('Cloud identity backup is not enabled for this account.');
    logger.dim('Run `gssh user identity backup enable` to create one.');
    return;
  }

  logger.bold('Cloud Identity Backup');
  logger.log(`  Enabled:  yes`);
  if (status.ownerUserRootId) {
    logger.log(`  Owner ID: ${status.ownerUserRootId}`);
  }
  if (status.createdAt) {
    logger.log(`  Created:  ${new Date(status.createdAt).toISOString()}`);
  }
  if (status.updatedAt) {
    logger.log(`  Updated:  ${new Date(status.updatedAt).toISOString()}`);
  }
}

export async function disableIdentityBackup(options: { yes?: boolean } = {}): Promise<void> {
  if (!options.yes) {
    const confirmed = await promptConfirm(
      'Delete your cloud identity backup? You will need your mnemonic to recover if no backup exists.',
      false,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const removed = await deleteCloudIdentityBackup();
  if (!removed) {
    logger.info('No cloud identity backup found.');
    return;
  }

  logger.success('Cloud identity backup deleted');
}

export async function rotateIdentityBackupPassword(options: { yes?: boolean } = {}): Promise<void> {
  const existing = await getCloudIdentityBackup();
  if (!existing) {
    throw new SpacesError(
      'No cloud identity backup found. Run `gssh user identity backup enable` first.',
      'USER_ERROR',
      1,
    );
  }

  if (!options.yes) {
    const confirmed = await promptConfirm(
      'Rotate cloud backup password now?',
      true,
    );
    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  const backupPassword = await promptPassword('Enter new identity backup password:');
  if (!backupPassword) {
    logger.info('Cancelled');
    return;
  }

  const confirmPassword = await promptPassword('Confirm new identity backup password:');
  if (backupPassword !== confirmPassword) {
    throw new SpacesError('Password confirmation does not match.', 'USER_ERROR', 1);
  }

  const record = await backupCurrentUserRootToCloud(backupPassword);
  logger.success('Cloud identity backup password rotated');
  logger.log(`  Updated: ${new Date(record.updatedAt).toISOString()}`);
}
