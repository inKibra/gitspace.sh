/**
 * Connect command implementation
 *
 * Handles 'gssh connect <invite>' to connect to a remote machine
 * via an invite token or URL, or lists available machines when no
 * invite is provided.
 */

import { logger } from '../utils/logger.js';
import { promptPassword, promptConfirm } from '../utils/prompts.js';
import { loadKeypair, keypairExists } from '../core/identity.js';
import { parseInviteToken, isInviteExpired } from '../lib/tmux-lite/crypto/invites.js';
import { RelayClient } from '../lib/tmux-lite/relay-client.js';
import {
  NoIdentityError,
  SpacesError,
} from '../types/errors.js';
import type { InviteToken } from '../types/identity.js';

/**
 * Connect to a remote machine via invite token
 *
 * @param inviteTokenOrUrl - Invite token (base64url) or URL containing token
 * @param options - Command options
 */
export async function connectToRemote(
  inviteTokenOrUrl?: string,
  options: { relay?: string } = {}
): Promise<void> {
  // Invite is required for connection
  if (!inviteTokenOrUrl) {
    throw new SpacesError(
      'Invite token or URL required.\n\nUsage:\n  gssh connect <invite-url>\n  gssh connect <invite-token>\n\nGet an invite from the machine owner using:\n  gssh share create',
      'USER_ERROR',
      1
    );
  }

  // Step 1: Parse invite from URL or raw token
  const token = extractAndValidateToken(inviteTokenOrUrl);

  // Step 2: Display connection details and confirm
  displayConnectionDetails(token);

  const confirmed = await promptConfirm('Connect to this machine?', true);
  if (!confirmed) {
    logger.info('Cancelled');
    return;
  }

  // Step 3: Load local identity
  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  const password = await promptPassword('Enter password to unlock identity:');
  if (!password) {
    logger.info('Cancelled');
    return;
  }

  const identity = await loadKeypair(password);
  if (!identity) {
    throw new SpacesError(
      'Failed to unlock identity. Check your password.',
      'USER_ERROR',
      1
    );
  }

  // Step 4: Connect to relay and perform handshake
  const relayUrl = options.relay ?? token.relayUrl;

  logger.info('Connecting to relay...');

  const client = new RelayClient(
    {
      relayUrl,
      machineId: token.machineId,
      identity,
      inviteToken: inviteTokenOrUrl.includes('#')
        ? extractTokenFromUrl(inviteTokenOrUrl) ?? inviteTokenOrUrl
        : inviteTokenOrUrl,
    },
    {
      onConnect: () => {
        logger.success('Connected!');
      },
      onDisconnect: (code, reason) => {
        logger.info(`Disconnected: ${code} ${reason}`);
        process.exit(0);
      },
      onError: (error) => {
        logger.error(`Connection error: ${error.message}`);
        process.exit(1);
      },
      onStateChange: (state) => {
        if (state === 'handshaking') {
          logger.info('Authenticating...');
        }
      },
      onHandshakeComplete: (peerIdentityId, accessType, sessionId) => {
        logger.success(`Session established with ${peerIdentityId.substring(0, 12)}...`);
        logger.log('');
        logger.dim(`Access: ${accessType === 'full' ? 'Full access' : 'Session invite'}`);
        if (sessionId) {
          logger.dim(`Session: ${sessionId}`);
        }
        logger.log('');
        logger.dim('Press Ctrl+D to disconnect');
        logger.log('');

        // Enter terminal session
        startTerminalSession(client);
      },
      onMessage: (_streamId, data) => {
        // Write received data to stdout
        process.stdout.write(data);
      },
    }
  );

  try {
    await client.connect();
  } catch (error) {
    if (error instanceof Error) {
      throw new SpacesError(
        `Connection failed: ${error.message}`,
        'SYSTEM_ERROR',
        2
      );
    }
    throw error;
  }

  // Keep process alive
  await new Promise(() => {
    // Never resolves - process stays alive until disconnect
  });
}

/**
 * Extract token from URL or validate raw token
 */
function extractAndValidateToken(input: string): InviteToken {
  // Try to extract from URL
  let rawToken = input;

  if (input.includes('#')) {
    const extracted = extractTokenFromUrl(input);
    if (extracted) {
      rawToken = extracted;
    }
  }

  // Parse and validate token
  const token = parseInviteToken(rawToken);
  if (!token) {
    throw new SpacesError(
      'Invalid invite token. Check that the token is complete and not corrupted.',
      'USER_ERROR',
      1
    );
  }

  if (isInviteExpired(token)) {
    throw new SpacesError(
      'This invite has expired. Please request a new one.',
      'USER_ERROR',
      1
    );
  }

  return token;
}

/**
 * Extract token from a URL like https://gitspace.sh/join#TOKEN
 */
function extractTokenFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const hash = urlObj.hash;
    if (hash && hash.length > 1) {
      return hash.substring(1); // Remove leading #
    }
    return null;
  } catch {
    // Not a valid URL, might be raw token
    if (url.includes('#')) {
      return url.split('#')[1] || null;
    }
    return null;
  }
}

/**
 * Display connection details from invite token
 */
function displayConnectionDetails(token: InviteToken): void {
  const expiresAt = new Date(token.expiresAt);
  const now = new Date();
  const hoursRemaining = Math.round(
    (expiresAt.getTime() - now.getTime()) / (1000 * 60 * 60)
  );

  let expiryStr: string;
  if (hoursRemaining < 1) {
    const minutesRemaining = Math.round(
      (expiresAt.getTime() - now.getTime()) / (1000 * 60)
    );
    expiryStr = `${minutesRemaining} minutes`;
  } else if (hoursRemaining < 24) {
    expiryStr = `${hoursRemaining} hours`;
  } else {
    const daysRemaining = Math.round(hoursRemaining / 24);
    expiryStr = `${daysRemaining} days`;
  }

  logger.log('');
  logger.bold('Remote Connection Details:');
  logger.log('');
  logger.log(`  Machine:     ${token.machineId}`);
  logger.log(`  Access:      ${token.accessType === 'full' ? 'Full access' : 'Session invite'}`);
  if (token.sessionId) {
    logger.log(`  Session:     ${token.sessionId}`);
  }
  logger.log(`  Expires:     ${expiryStr} (${expiresAt.toLocaleString()})`);
  logger.log(`  Relay:       ${token.relayUrl}`);
  if (token.singleUse) {
    logger.dim('  (Single-use invite)');
  }
  logger.log('');
}

/**
 * Start interactive terminal session
 */
function startTerminalSession(client: RelayClient): void {
  // Set stdin to raw mode for character-by-character input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Forward stdin to remote
  process.stdin.on('data', (data) => {
    // Check for Ctrl+D (EOF)
    if (data.length === 1 && data[0] === 0x04) {
      logger.log('');
      logger.info('Disconnecting...');
      client.disconnect();
      process.exit(0);
    }

    client.send(data);
  });

  // Handle terminal resize
  if (process.stdout.isTTY) {
    process.stdout.on('resize', () => {
      // Send resize event to remote (using a control message)
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      const resizeMsg = JSON.stringify({ type: 'resize', cols, rows });
      client.send(Buffer.from(resizeMsg), 1); // Stream ID 1 for control
    });

    // Send initial size
    const cols = process.stdout.columns;
    const rows = process.stdout.rows;
    const resizeMsg = JSON.stringify({ type: 'resize', cols, rows });
    client.send(Buffer.from(resizeMsg), 1);
  }

  // Handle SIGINT (Ctrl+C)
  process.on('SIGINT', () => {
    // Forward Ctrl+C to remote instead of terminating
    client.send(Buffer.from([0x03]));
  });

  // Handle process termination
  process.on('SIGTERM', () => {
    client.disconnect();
    process.exit(0);
  });
}
