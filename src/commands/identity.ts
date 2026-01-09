/**
 * Identity command implementation
 * Handles 'gssh identity init' and 'gssh identity show'
 */

import { createHash } from 'crypto';
import { logger } from '../utils/logger.js';
import { promptPassword, promptInput, promptConfirm } from '../utils/prompts.js';
import {
  generateAndSaveKeypair,
  loadKeypair,
  keypairExists,
  getPublicKeyWithoutPassword,
} from '../core/identity.js';
import {
  NoIdentityError,
  IdentityExistsError,
  SpacesError,
} from '../types/errors.js';

/**
 * Initialize a new identity keypair
 */
export async function initIdentity(options: { force?: boolean } = {}): Promise<void> {
  // Check if keypair already exists
  if (keypairExists() && !options.force) {
    throw new IdentityExistsError();
  }

  // If force flag is set and keypair exists, confirm
  if (options.force && keypairExists()) {
    const confirmed = await promptConfirm(
      'This will overwrite your existing identity. Are you sure?',
      false
    );

    if (!confirmed) {
      logger.info('Cancelled');
      return;
    }
  }

  // Prompt for password (twice for confirmation)
  const password = await promptPassword('Enter password to encrypt your identity:');

  if (!password) {
    logger.info('Cancelled');
    return;
  }

  if (password.length < 8) {
    throw new SpacesError(
      'Password must be at least 8 characters long',
      'USER_ERROR',
      1
    );
  }

  const confirmPassword = await promptPassword('Confirm password:');

  if (!confirmPassword) {
    logger.info('Cancelled');
    return;
  }

  if (password !== confirmPassword) {
    throw new SpacesError(
      'Passwords do not match',
      'USER_ERROR',
      1
    );
  }

  // Prompt for optional label
  const label = await promptInput('Enter an optional label for this identity (e.g., "My Laptop"):', {
    default: '',
  });

  // Generate and save keypair
  logger.info('Generating keypair...');
  const identity = await generateAndSaveKeypair(
    password,
    label || undefined,
    options.force || false
  );

  logger.success('Identity created successfully');

  // Display public key info (identity is PublicIdentity, keys are base64 strings)
  const signingKeyBytes = Buffer.from(identity.signingPublicKey, 'base64');
  const keyExchangeKeyBytes = Buffer.from(identity.keyExchangePublicKey, 'base64');
  const fingerprint = formatFingerprint(signingKeyBytes);
  const publicKeyString = formatPublicKey(signingKeyBytes, keyExchangeKeyBytes);

  logger.log('');
  logger.bold('Identity Information:');
  logger.log(`  ID:          ${identity.id}`);
  logger.log(`  Fingerprint: ${fingerprint}`);
  if (identity.label) {
    logger.log(`  Label:       ${identity.label}`);
  }
  logger.log('');
  logger.bold('Public Key:');
  logger.log(`  ${publicKeyString}`);
  logger.log('');
  logger.dim('Keep your password safe. You will need it to use this identity.');
}

/**
 * Show identity information
 */
export async function showIdentity(
  options: { fingerprint?: boolean; json?: boolean } = {}
): Promise<void> {
  // Check if keypair exists
  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  // Read public key (no password needed)
  const publicIdentity = getPublicKeyWithoutPassword();

  if (!publicIdentity) {
    throw new NoIdentityError();
  }

  // JSON output
  if (options.json) {
    console.log(JSON.stringify(publicIdentity, null, 2));
    return;
  }

  // Fingerprint output
  if (options.fingerprint) {
    const signingPublicKeyBytes = Buffer.from(publicIdentity.signingPublicKey, 'base64');
    const fingerprint = formatFingerprint(signingPublicKeyBytes);
    logger.log(fingerprint);
    return;
  }

  // Default output: full public key
  const publicKeyString = formatPublicKey(
    Buffer.from(publicIdentity.signingPublicKey, 'base64'),
    Buffer.from(publicIdentity.keyExchangePublicKey, 'base64')
  );

  logger.bold('Identity Information:');
  logger.log(`  ID:          ${publicIdentity.id}`);
  if (publicIdentity.label) {
    logger.log(`  Label:       ${publicIdentity.label}`);
  }
  logger.log('');
  logger.bold('Public Key:');
  logger.log(`  ${publicKeyString}`);
  logger.log('');
  logger.bold('Fingerprint:');
  logger.log(`  ${formatFingerprint(Buffer.from(publicIdentity.signingPublicKey, 'base64'))}`);
}

/**
 * Format fingerprint as first 16 hex chars of SHA-256 hash with colons
 */
function formatFingerprint(signingPublicKey: Uint8Array): string {
  const hash = createHash('sha256').update(signingPublicKey).digest('hex');
  const first16 = hash.substring(0, 16);

  // Add colons every 2 characters
  const parts: string[] = [];
  for (let i = 0; i < first16.length; i += 2) {
    parts.push(first16.substring(i, i + 2));
  }

  return parts.join(':');
}

/**
 * Format public key as gssh-pub:BASE64_SIGNING:BASE64_KEYEXCHANGE
 */
function formatPublicKey(signingPublicKey: Uint8Array, keyExchangePublicKey: Uint8Array): string {
  const signingB64 = Buffer.from(signingPublicKey).toString('base64');
  const keyExchangeB64 = Buffer.from(keyExchangePublicKey).toString('base64');

  return `gssh-pub:${signingB64}:${keyExchangeB64}`;
}
