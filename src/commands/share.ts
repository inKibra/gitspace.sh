/**
 * Share command implementation
 * Handles workspace sharing via invite tokens
 */

import { logger } from '../utils/logger.js';
import { promptPassword, promptConfirm } from '../utils/prompts.js';
import {
  loadKeypair,
  keypairExists,
  readRelayConfig,
  getPublicKeyWithoutPassword,
} from '../core/identity.js';
import {
  isRelayTrusted,
  addTrustedRelay,
  getTrustedRelay,
  isLocalhost,
  computeRelayFingerprint,
} from '../core/trusted-relays.js';
import { createInviteToken, parseInviteToken } from '../lib/tmux-lite/crypto/invites.js';
import { signMessage } from '../relay/signing.js';
import { PROTOCOL_VERSION } from '../relay/protocol.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import type { CreateInviteOptions, Identity } from '../types/identity.js';
import { SpacesError, NoIdentityError, InvalidPasswordError } from '../types/errors.js';
import chalk from 'chalk';
import { createHash } from 'crypto';

/**
 * Duration string formats supported:
 * - "1h" -> 1 hour
 * - "24h" -> 24 hours
 * - "7d" -> 7 days
 * - "1w" -> 1 week
 */
interface ParsedDuration {
  milliseconds: number;
  humanReadable: string;
}

/**
 * Parse a duration string into milliseconds
 *
 * @param duration - Duration string (e.g., "1h", "24h", "7d", "1w")
 * @returns Parsed duration with milliseconds and human-readable format
 * @throws {SpacesError} If duration format is invalid
 */
function parseDuration(duration: string): ParsedDuration {
  const match = duration.match(/^(\d+)(h|d|w)$/);

  if (!match) {
    throw new SpacesError(
      `Invalid duration format: ${duration}\nExpected format: number + unit (h=hours, d=days, w=weeks)\nExamples: 1h, 24h, 7d, 1w`,
      'USER_ERROR',
      1
    );
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  let milliseconds: number;
  let humanReadable: string;

  switch (unit) {
    case 'h':
      milliseconds = value * 60 * 60 * 1000;
      humanReadable = value === 1 ? '1 hour' : `${value} hours`;
      break;
    case 'd':
      milliseconds = value * 24 * 60 * 60 * 1000;
      humanReadable = value === 1 ? '1 day' : `${value} days`;
      break;
    case 'w':
      milliseconds = value * 7 * 24 * 60 * 60 * 1000;
      humanReadable = value === 1 ? '1 week' : `${value} weeks`;
      break;
    default:
      throw new SpacesError(
        `Unsupported duration unit: ${unit}`,
        'USER_ERROR',
        1
      );
  }

  return { milliseconds, humanReadable };
}

/**
 * Format a timestamp as a human-readable date/time
 *
 * @param timestamp - Unix timestamp in milliseconds
 * @returns Formatted date string
 */
function formatExpiryTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = timestamp - now.getTime();
  const diffHours = Math.floor(diffMs / (60 * 60 * 1000));
  const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));

  // Show relative time if less than 7 days
  let relative = '';
  if (diffDays > 0) {
    relative = ` (in ${diffDays} ${diffDays === 1 ? 'day' : 'days'})`;
  } else if (diffHours > 0) {
    relative = ` (in ${diffHours} ${diffHours === 1 ? 'hour' : 'hours'})`;
  }

  // Format absolute time
  const absolute = date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  return `${absolute}${relative}`;
}

/**
 * Generate an invite ID from the token
 * Uses SHA-256 hash of the token for unique identification
 */
function generateInviteId(token: string): string {
  const hash = createHash('sha256').update(token).digest('hex');
  return hash.substring(0, 16); // Use first 16 chars for brevity
}

/**
 * Public identity type for registration
 */
interface PublicIdentity {
  id: string;
  signingPublicKey: string;
  keyExchangePublicKey: string;
  label?: string;
}

/**
 * Register an invite with the relay server using challenge-response authentication
 *
 * @param relayUrl - Relay WebSocket URL
 * @param machineId - Machine ID to register invite for
 * @param identity - Machine identity for signing
 * @param publicIdentity - Public identity for registration
 * @param inviteId - Unique ID for the invite
 * @param expiresAt - When the invite expires (Unix ms)
 * @param maxUses - Maximum uses (null for unlimited)
 */
async function registerInviteWithRelay(
  relayUrl: string,
  machineId: string,
  identity: Identity,
  publicIdentity: PublicIdentity,
  inviteId: string,
  expiresAt: number,
  maxUses: number | null
): Promise<void> {
  // Extract signing private key for challenge-response
  const signingPrivateKey = identity.signing.secretKey.slice(0, 32);
  const signingPublicKeyBytes = new Uint8Array(Buffer.from(publicIdentity.signingPublicKey, 'base64'));

  return new Promise((resolve, reject) => {
    const url = new URL(relayUrl);
    url.searchParams.set('role', 'machine');

    const ws = new WebSocket(url.toString());
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timeout waiting for relay response'));
    }, 15000);

    let registered = false;
    let inviteSent = false;

    // Helper to sign and send a message
    const signAndSend = (msg: object) => {
      const signed = signMessage(msg, signingPrivateKey, signingPublicKeyBytes);
      ws.send(JSON.stringify(signed));
    };

    ws.onopen = () => {
      // Wait for relay_identity message with challenge
      logger.dim('Connected to relay, authenticating...');
    };

    ws.onmessage = async (event) => {
      try {
        const data = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(data);

        switch (msg.type) {
          case 'relay_identity': {
            // Relay is identifying itself and providing a challenge
            const relayPublicKey = msg.publicKey;
            const relayFingerprint = msg.fingerprint;
            const relayLabel = msg.label;
            const challenge = msg.challenge;

            // Verify relay trust
            const trustStatus = isRelayTrusted(relayUrl, relayPublicKey);

            if (trustStatus === 'mismatch') {
              // SECURITY: Relay key changed - HARD FAIL
              clearTimeout(timeout);
              ws.close();
              reject(new Error(
                `Relay identity mismatch! Expected ${getTrustedRelay(relayUrl)?.fingerprint}, got ${relayFingerprint}. ` +
                `This could indicate a security threat. If expected, run: gssh relay untrust ${relayUrl}`
              ));
              return;
            }

            if (trustStatus === 'unknown') {
              // Unknown relay - auto-trust localhost, otherwise prompt
              if (isLocalhost(relayUrl)) {
                addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
              } else {
                // For share command, we require the relay to already be trusted
                // (user should have run serve first which establishes trust)
                clearTimeout(timeout);
                ws.close();
                reject(new Error(
                  `Unknown relay ${relayFingerprint}. Please start 'gssh serve' first to establish trust with this relay.`
                ));
                return;
              }
            }

            // Sign the challenge and send register_machine
            try {
              const nonceBytes = new Uint8Array(Buffer.from(challenge, 'base64'));
              const signature = ed25519.sign(nonceBytes, signingPrivateKey);
              const challengeResponse = Buffer.from(signature).toString('base64');

              // Send register_machine with challenge response
              signAndSend({
                type: 'register_machine',
                machineId,
                signingKey: publicIdentity.signingPublicKey,
                keyExchangeKey: publicIdentity.keyExchangePublicKey,
                label: publicIdentity.label,
                protocolVersion: PROTOCOL_VERSION,
                challengeResponse,
              });
            } catch (err) {
              clearTimeout(timeout);
              ws.close();
              reject(new Error(`Failed to sign challenge: ${err instanceof Error ? err.message : String(err)}`));
            }
            break;
          }

          case 'registered':
            // Machine registered, now send register_invite
            if (!inviteSent) {
              inviteSent = true;
              signAndSend({
                type: 'register_invite',
                inviteId,
                machineId,
                expiresAt,
                maxUses,
              });
            }
            break;

          case 'invite_registered':
            // Invite registered successfully
            registered = true;
            clearTimeout(timeout);
            ws.close();
            resolve();
            break;

          case 'error':
            clearTimeout(timeout);
            ws.close();
            reject(new Error(msg.message || 'Failed to register invite with relay'));
            break;
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    };

    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket connection failed'));
    };

    ws.onclose = () => {
      clearTimeout(timeout);
      if (!registered && !inviteSent) {
        // Connection closed without registering
      }
    };
  });
}

/**
 * Create a share invite token
 *
 * @param options - Share creation options
 */
export async function createShare(options: {
  expires?: string;
  session?: string;
  relay?: string;
}): Promise<void> {
  // Check if identity exists
  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  // Check if relay config exists (means serve is or was running)
  const relayConfig = readRelayConfig();
  if (!relayConfig) {
    throw new SpacesError(
      'Machine is not registered with relay.\n\nStart the serve daemon first:\n  gssh serve --relay <url>\n\nThen create invites in another terminal.',
      'USER_ERROR',
      1
    );
  }

  // Prompt for password to unlock keypair
  const password = await promptPassword('Enter password to unlock identity:');
  if (!password) {
    logger.info('Cancelled');
    return;
  }

  // Load identity
  logger.info('Loading identity...');
  let identity;
  try {
    identity = await loadKeypair(password);
  } catch (error) {
    if (error instanceof InvalidPasswordError) {
      throw error;
    }
    throw new SpacesError(
      `Failed to load identity: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2
    );
  }

  // Get public identity for relay registration
  const publicIdentity = getPublicKeyWithoutPassword();
  if (!publicIdentity) {
    throw new SpacesError(
      'Failed to read public identity',
      'SYSTEM_ERROR',
      2
    );
  }

  // Parse expires duration (default: 24h)
  const expiresStr = options.expires || '24h';
  const duration = parseDuration(expiresStr);

  // Use relay URL from config or override
  const relayUrl = options.relay || relayConfig.relayUrl;

  // Create invite token options
  // Share invites are always session-invite (view-only)
  const inviteOptions: CreateInviteOptions = {
    accessType: 'session-invite',
    sessionId: options.session,
    validityMs: duration.milliseconds,
    singleUse: false,
  };

  // Create invite token
  logger.info('Creating invite token...');
  const token = createInviteToken(identity, relayUrl, inviteOptions);

  // Calculate expiry timestamp
  const expiresAt = Date.now() + duration.milliseconds;

  // Generate invite ID for relay registration
  const inviteId = generateInviteId(token);

  // Register invite with relay using challenge-response auth
  logger.info('Registering invite with relay...');

  try {
    await registerInviteWithRelay(
      relayConfig.relayUrl,
      relayConfig.machineId,
      identity,
      publicIdentity,
      inviteId,
      expiresAt,
      null // Unlimited uses
    );
  } catch (error) {
    throw new SpacesError(
      `Failed to register invite with relay: ${error instanceof Error ? error.message : String(error)}\n\nMake sure 'gssh serve' is running.`,
      'SYSTEM_ERROR',
      2
    );
  }

  // Display results
  logger.log('');
  logger.success('Share invite created!');
  logger.log('');

  // Token
  logger.log(chalk.bold('Token:'));
  logger.log(chalk.cyan(token));
  logger.log('');

  // URL
  const shareUrl = `https://gitspace.sh/join#${token}`;
  logger.log(chalk.bold('Share URL:'));
  logger.log(chalk.cyan(shareUrl));
  logger.log('');

  // Access type
  logger.log(chalk.bold('Access:'));
  logger.log(`  Session invite (view-only)`);
  if (inviteOptions.sessionId) {
    logger.log(`  Session: ${inviteOptions.sessionId}`);
  }
  logger.log('');

  // Expiry
  logger.log(chalk.bold('Expires:'));
  logger.log(`  ${formatExpiryTime(expiresAt)}`);
  logger.log(`  Valid for: ${duration.humanReadable}`);
  logger.log('');

  // Relay
  logger.dim(`Relay: ${relayUrl}`);
  logger.dim(`Invite ID: ${inviteId}`);
  logger.log('');

  // Usage hint
  logger.log(chalk.dim('Share this URL with collaborators to grant access to your workspace.'));
}
