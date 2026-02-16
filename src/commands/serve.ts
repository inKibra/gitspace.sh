/**
 * Serve command implementation
 *
 * Handles 'gssh serve' to start a machine-side daemon that accepts
 * remote connections, authenticates clients via X3DH, and spawns PTY sessions.
 *
 * Also handles gitspace.sh hosting via Cloudflare Tunnels when configured.
 *
 * Supports daemon mode with start/stop/status subcommands.
 */

import { watch, appendFileSync, existsSync, writeFileSync } from 'fs';
import { spawn, type Subprocess } from 'bun';
import { logger } from '../utils/logger.js';
import { promptPassword, promptConfirm } from '../utils/prompts.js';
import { getSecret } from '../utils/secrets.js';
import {
  isRelayTrusted,
  addTrustedRelay,
  getTrustedRelay,
  isLocalhost,
  computeRelayFingerprint,
  type RelayTrustStatus,
} from '../core/trusted-relays.js';
import {
  loadKeypair,
  keypairExists,
  readMachineIdentity,
  getPublicKeyWithoutPassword,
  writeRelayConfig,
  clearRelayConfig,
} from '../core/identity.js';
import { readAccessList, getAccessListPath } from '../core/access.js';
import { AccessControlList } from '../lib/tmux-lite/crypto/access-control.js';
import { ClientSessionManager } from '../serve/client-session-manager.js';
import type { ServeEventHandler } from '../serve/types.js';
import type { AccessEntry } from '../types/identity.js';
import {
  NoIdentityError,
  SpacesError,
} from '../types/errors.js';
import { readHostConfig } from './host.js';
import { createRelayServer } from '../relay/server.js';
import { generateRelayIdentity } from '../relay/identity.js';
import { signMessage } from '../relay/signing.js';
import { PROTOCOL_VERSION } from '../relay/protocol.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  isServeRunning,
  getServePid,
  writeServePid,
  cleanupServeFiles,
  startStatusServer,
  stopStatusServer,
  setDaemonState,
  updateDaemonState,
  queryServeStatus,
  sendShutdownCommand,
  getServeLogFile,
  setAccessCommandHandler,
  ensureServeDaemonDir,
  type StatusResponse,
} from '../serve/daemon.js';
import { initializeSecretRuntime } from '../core/secret-runtime.js';

/** Package version for daemon status */
const PACKAGE_VERSION = '1.0.0';

/** Default relay URL */
// No default relay - must use hosting or explicit --relay

/** Local relay port for gitspace.sh hosting */
const LOCAL_RELAY_PORT = 4480;

/** Cloudflared process reference */
let cloudflaredProcess: Subprocess | null = null;
let cloudflaredSubdomain: string | null = null;
let cloudflaredRestartAttempts = 0;
const MAX_CLOUDFLARED_RESTARTS = 5;
const CLOUDFLARED_RESTART_DELAY = 5000;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate that an access entry has required keys
 * @param entry - Access entry to validate
 * @param logLabel - Label for logging if validation fails
 * @returns true if valid, false if missing required keys
 */
function isValidAccessEntry(entry: AccessEntry, logLabel?: string): boolean {
  const label = logLabel || entry.label || entry.identityId.substring(0, 12) + '...';

  if (!entry.keyExchangePublicKey || entry.keyExchangePublicKey.length === 0) {
    logger.warning(`Skipping access entry with missing keyExchangePublicKey: ${label}`);
    return false;
  }
  if (!entry.signingPublicKey || entry.signingPublicKey.length === 0) {
    logger.warning(`Skipping access entry with missing signingPublicKey: ${label}`);
    return false;
  }
  return true;
}

/**
 * Create a ServeEventHandler that logs events
 * @param sessionManager - Session manager for tracking active sessions
 * @param isLocalRelay - Whether this is for a local relay (affects log messages)
 * @returns Event handler function
 */
function createEventHandler(
  sessionManager: ClientSessionManager,
  isLocalRelay: boolean
): ServeEventHandler {
  const relayName = isLocalRelay ? 'local relay' : 'relay';

  return (event) => {
    const timestamp = new Date().toLocaleTimeString();

    switch (event.type) {
      case 'client_connected':
        logger.dim(`[${timestamp}] Client ${event.connectionId.substring(0, 12)}... connecting`);
        break;

      case 'client_authenticated':
        logger.success(`[${timestamp}] Client ${event.identityId.substring(0, 12)}... authenticated`);
        logger.dim(`           Access: ${event.accessType === 'full' ? 'Full access' : `Session invite${event.sessionId ? ` (${event.sessionId})` : ''}`}`);
        updateSessionDisplay(sessionManager);
        break;

      case 'client_disconnected':
        logger.dim(`[${timestamp}] Client ${event.connectionId.substring(0, 12)}... disconnected: ${event.reason}`);
        updateSessionDisplay(sessionManager);
        break;

      case 'relay_connected':
        logger.success(isLocalRelay ? 'Machine registered with local relay' : 'Connected to relay');
        break;

      case 'relay_disconnected':
        logger.warning(`Disconnected from ${relayName}: ${event.code} ${event.reason}`);
        break;

      case 'relay_reconnecting':
        logger.dim(`Reconnecting to ${relayName} (attempt ${event.attempt})...`);
        break;

      case 'error':
        logger.error(`Error${event.connectionId ? ` (${event.connectionId.substring(0, 12)}...)` : ''}: ${event.error.message}`);
        break;
    }
  };
}

/**
 * Result of relay trust verification
 */
type RelayTrustResult =
  | { trusted: true }
  | { trusted: false; reason: string };

/**
 * Verify and establish trust with a relay
 *
 * @param relayUrl - The relay URL
 * @param relayPublicKey - The relay's public key
 * @param relayFingerprint - The relay's fingerprint
 * @param relayLabel - Optional relay label
 * @param explicitPubkey - Optional explicit public key to trust
 * @returns Result indicating if trust was established
 */
async function verifyRelayTrust(
  relayUrl: string,
  relayPublicKey: string,
  relayFingerprint: string,
  relayLabel: string | undefined,
  explicitPubkey?: string
): Promise<RelayTrustResult> {
  const trustStatus = isRelayTrusted(relayUrl, relayPublicKey);

  if (trustStatus === 'mismatch') {
    // SECURITY: Relay key changed - HARD FAIL
    logger.log('');
    logger.error('SECURITY WARNING: Relay public key mismatch!');
    logger.error(`Expected:  ${getTrustedRelay(relayUrl)?.fingerprint}`);
    logger.error(`Received:  ${relayFingerprint}`);
    logger.log('');
    logger.error('The relay identity has changed. This could indicate a man-in-the-middle attack.');
    logger.error('If this is expected, remove the old trust with: gssh relay untrust ' + relayUrl);
    return { trusted: false, reason: 'Relay identity mismatch - possible security threat' };
  }

  if (trustStatus === 'unknown') {
    // Unknown relay - check if explicit trust was provided or auto-trust localhost
    if (isLocalhost(relayUrl)) {
      // Localhost auto-trust
      console.log('[serve] Localhost relay - auto-trusting');
      addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
    } else if (explicitPubkey) {
      // Explicit trust provided via --relay-pubkey
      if (explicitPubkey === relayPublicKey) {
        console.log('[serve] Explicit trust match - trusting relay');
        addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
      } else {
        logger.error('Relay public key does not match --relay-pubkey');
        logger.error(`Expected:  ${computeRelayFingerprint(explicitPubkey)}`);
        logger.error(`Received:  ${relayFingerprint}`);
        return { trusted: false, reason: 'Relay public key does not match --relay-pubkey' };
      }
    } else {
      // Unknown remote relay - prompt for confirmation
      logger.log('');
      logger.bold('Unknown Relay');
      logger.log(`  URL:         ${relayUrl}`);
      logger.log(`  Fingerprint: ${relayFingerprint}`);
      if (relayLabel) {
        logger.log(`  Label:       ${relayLabel}`);
      }
      logger.log('');

      // Ask for confirmation
      const shouldTrust = await promptConfirm('Trust this relay?');

      if (!shouldTrust) {
        logger.info('Relay not trusted, aborting connection');
        return { trusted: false, reason: 'User declined to trust relay' };
      }

      // Save trust
      addTrustedRelay(relayUrl, relayPublicKey, relayLabel);
      logger.success('Relay trusted and saved');
    }
  }

  return { trusted: true };
}

/**
 * Sign a challenge and create registration message
 *
 * @param challenge - Base64 challenge from relay
 * @param signingPrivateKey - Private key for signing
 * @param machineId - Machine ID
 * @param publicIdentity - Public identity info
 * @returns Signed message data or null on error
 */
function signChallengeAndCreateRegistration(
  challenge: string,
  signingPrivateKey: Uint8Array,
  machineId: string,
  publicIdentity: PublicIdentity
): { challengeResponse: string; message: object } | null {
  try {
    const nonceBytes = new Uint8Array(Buffer.from(challenge, 'base64'));
    const signature = ed25519.sign(nonceBytes, signingPrivateKey);
    const challengeResponse = Buffer.from(signature).toString('base64');

    return {
      challengeResponse,
      message: {
        type: 'register_machine',
        machineId,
        signingKey: publicIdentity.signingPublicKey,
        keyExchangeKey: publicIdentity.keyExchangePublicKey,
        label: publicIdentity.label,
        protocolVersion: PROTOCOL_VERSION,
        challengeResponse,
      },
    };
  } catch (err) {
    logger.error(`Failed to sign challenge: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Create a data message for sending to a client via relay
 */
function createDataMessage(connectionId: string, data: Uint8Array | Buffer): string {
  return JSON.stringify({
    type: 'data',
    connectionId,
    data: Buffer.from(data).toString('base64'),
  });
}

/**
 * Create a send callback for a client connection
 */
function createSendCallback(
  ws: WebSocket,
  connectionId: string
): (data: Uint8Array | Buffer) => void {
  return (sendData) => {
    ws.send(createDataMessage(connectionId, sendData));
  };
}

// ============================================================================
// Cloudflared Management
// ============================================================================

/**
 * Check if cloudflared is installed
 */
async function isCloudflaredInstalled(): Promise<boolean> {
  try {
    const proc = spawn(['which', 'cloudflared'], { stdout: 'pipe', stderr: 'pipe' });
    const exitCode = await proc.exited;
    return exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Start cloudflared tunnel for a subdomain
 *
 * @param subdomain - The subdomain to tunnel (e.g., 'brad' for brad.gitspace.sh)
 * @returns true if started successfully
 */
async function startCloudflared(subdomain: string): Promise<boolean> {
  // Get tunnel token from keychain
  const tunnelToken = await getSecret(`TUNNEL_TOKEN_${subdomain}`);
  if (!tunnelToken) {
    logger.warning(`No tunnel token found for ${subdomain}.gitspace.sh`);
    logger.dim('Run: gssh host reserve ' + subdomain + ' (to get token)');
    return false;
  }

  // Check if cloudflared is installed
  if (!await isCloudflaredInstalled()) {
    logger.warning('cloudflared is not installed');
    logger.dim('Install: brew install cloudflared (macOS) or see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
    return false;
  }

  cloudflaredSubdomain = subdomain;

  // Start cloudflared with tunnel token via TUNNEL_TOKEN env var to avoid argv exposure
  logger.info(`Starting tunnel for ${subdomain}.gitspace.sh...`);

  try {
    cloudflaredProcess = spawn(['cloudflared', 'tunnel', 'run'], {
      env: { ...process.env, TUNNEL_TOKEN: tunnelToken },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Handle cloudflared output
    handleCloudflaredOutput(cloudflaredProcess);

    // Monitor process exit
    cloudflaredProcess.exited.then((exitCode) => {
      if (exitCode !== 0 && cloudflaredSubdomain) {
        logger.warning(`cloudflared exited with code ${exitCode}`);
        handleCloudflaredCrash();
      }
    });

    logger.success(`Tunnel active: https://${subdomain}.gitspace.sh`);
    logger.dim(`  Wildcard: https://*.${subdomain}.gitspace.sh`);
    return true;
  } catch (error) {
    logger.error(`Failed to start cloudflared: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Handle cloudflared stdout/stderr
 */
function handleCloudflaredOutput(proc: Subprocess): void {
  // Read stdout
  const stdout = proc.stdout;
  if (stdout && typeof stdout !== 'number') {
    (async () => {
      const reader = stdout.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          // Only log important messages, skip routine output
          if (text.includes('ERR') || text.includes('error') || text.includes('failed')) {
            logger.dim(`[cloudflared] ${text.trim()}`);
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }

  // Read stderr
  const stderr = proc.stderr;
  if (stderr && typeof stderr !== 'number') {
    (async () => {
      const reader = stderr.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = new TextDecoder().decode(value);
          // cloudflared logs most output to stderr
          if (text.includes('ERR') || text.includes('error') || text.includes('failed')) {
            logger.warning(`[cloudflared] ${text.trim()}`);
          }
        }
      } catch {
        // Stream closed
      }
    })();
  }
}

/**
 * Handle cloudflared crash and restart
 */
function handleCloudflaredCrash(): void {
  if (!cloudflaredSubdomain) return;

  cloudflaredRestartAttempts++;

  if (cloudflaredRestartAttempts > MAX_CLOUDFLARED_RESTARTS) {
    logger.error(`cloudflared crashed ${MAX_CLOUDFLARED_RESTARTS} times, giving up`);
    logger.dim('Check your tunnel token or network connection');
    cloudflaredSubdomain = null;
    return;
  }

  logger.info(`Restarting cloudflared (attempt ${cloudflaredRestartAttempts}/${MAX_CLOUDFLARED_RESTARTS})...`);

  setTimeout(async () => {
    if (cloudflaredSubdomain) {
      await startCloudflared(cloudflaredSubdomain);
    }
  }, CLOUDFLARED_RESTART_DELAY);
}

/**
 * Stop cloudflared process
 */
function stopCloudflared(): void {
  if (cloudflaredProcess) {
    logger.dim('Stopping cloudflared...');
    cloudflaredProcess.kill();
    cloudflaredProcess = null;
    cloudflaredSubdomain = null;
  }
}

// ============================================================================
// Serve Command
// ============================================================================

/**
 * Start the serve daemon
 *
 * @param options - Command options
 */
export async function serve(options: {
  relay?: string;
  relayPubkey?: string;
  ignoreKeychainAndSkipSecrets?: boolean;
} = {}): Promise<void> {
  // Step 1: Load machine identity
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

  // Extract signing private key for challenge-response
  // Ed25519 secret key is 64 bytes, but ed25519.sign() expects the 32-byte seed
  const signingPrivateKey = identity.signing.secretKey.slice(0, 32);

  // Get public identity for registration
  const publicIdentity = getPublicKeyWithoutPassword();
  if (!publicIdentity) {
    throw new SpacesError(
      'Failed to read public identity',
      'SYSTEM_ERROR',
      2
    );
  }

  // Step 2: Load access control list
  const accessList = new AccessControlList();
  const entries = readAccessList();
  accessList.import(entries);

  await initializeSecretRuntime({
    ignoreKeychainAndSkipSecrets: options.ignoreKeychainAndSkipSecrets,
  });

  // Step 3: Check for gitspace.sh hosting or explicit relay
  const hostConfig = readHostConfig();
  const relayUrl = options.relay; // No default - must use hosting or explicit --relay

  // If no hosting config and no explicit relay, error out
  if (!hostConfig?.subdomain && !relayUrl) {
    throw new SpacesError(
      'No relay configured.\n\n' +
      'Either set up gitspace.sh hosting:\n' +
      '  gssh auth login\n' +
      '  gssh host reserve <subdomain>\n\n' +
      'Or specify a relay explicitly:\n' +
      '  gssh serve start --relay ws://localhost:4480/ws',
      'USER_ERROR'
    );
  }

  // Display info
  const machineIdentity = readMachineIdentity();
  const machineId = machineIdentity?.machineId ?? identity.id;

  logger.log('');
  logger.bold('Machine Identity:');
  logger.log(`  ID:    ${machineId}`);
  if (relayUrl) {
    logger.log(`  Relay: ${relayUrl}`);
  }
  logger.log('');
  logger.dim(`Access list: ${entries.length} authorized ${entries.length === 1 ? 'client' : 'clients'}`);
  logger.log('');
  let localRelayServer: ReturnType<typeof createRelayServer> | null = null;
  let localRelayIdentity: ReturnType<typeof generateRelayIdentity> | null = null;

  if (hostConfig?.subdomain) {
    logger.bold('gitspace.sh Hosting:');

    // Generate an ephemeral identity for local relay
    localRelayIdentity = generateRelayIdentity('local-relay');

    // Start local relay server with this machine pre-authorized
    try {
      localRelayServer = createRelayServer({
        port: LOCAL_RELAY_PORT,
        bind: '127.0.0.1', // Only listen locally, cloudflared handles external
        identity: localRelayIdentity,
        preAuthorizedMachines: [publicIdentity.signingPublicKey],
      });
      logger.success(`Local relay started on port ${LOCAL_RELAY_PORT}`);
    } catch (error) {
      logger.error(`Failed to start local relay: ${error instanceof Error ? error.message : String(error)}`);
      throw new SpacesError('Failed to start local relay server', 'SYSTEM_ERROR', 2);
    }

    // Start cloudflared tunnel
    const tunnelStarted = await startCloudflared(hostConfig.subdomain);
    if (tunnelStarted) {
      logger.log('');
      logger.dim(`Web terminal: https://${hostConfig.subdomain}.gitspace.sh`);
      logger.log('');
    } else {
      // Stop local relay if tunnel failed
      localRelayServer.stop();
      localRelayServer = null;
      logger.dim('  Hosting not active (tunnel token missing)');
      logger.log('');
    }
  }

  // If gitspace.sh hosting is active, connect to local relay instead of external
  if (localRelayServer && localRelayIdentity) {
    // For local relay, we auto-authorize this machine (it's the same machine running both)
    // The relay identity was generated above; machine authenticates via challenge-response
    const localRelayUrl = `ws://127.0.0.1:${LOCAL_RELAY_PORT}/ws`;

    // Step 4: Create session manager for local relay
    const sessionManager = new ClientSessionManager({
      relay: localRelayUrl,
      identity,
      accessList,
    });

    // Initialize session manager (starts tmux-lite server)
    await sessionManager.initialize();

    // Set up event handling
    const eventHandler = createEventHandler(sessionManager, true);
    sessionManager.onEvent(eventHandler);

    // Connect to local relay (no token needed - uses challenge-response auth)
    logger.info('Registering with local relay...');
    try {
      await connectToRelay(localRelayUrl, machineId, publicIdentity, sessionManager, eventHandler, accessList, signingPrivateKey);
    } catch (error) {
      logger.error(`Failed to register with local relay: ${error instanceof Error ? error.message : String(error)}`);
      localRelayServer.stop();
      stopCloudflared();
      throw new SpacesError('Failed to register with local relay', 'SYSTEM_ERROR', 2);
    }

    logger.log('');
    logger.dim('Waiting for connections via gitspace.sh... (Ctrl+C to stop)');
    logger.log('');

    // Set up shutdown handler for gitspace.sh mode
    const shutdown = () => {
      logger.log('');
      logger.info('Shutting down...');
      stopCloudflared();
      sessionManager.cleanup();
      localRelayServer?.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    await new Promise(() => {});
    return;
  }

  // If we get here, relayUrl must be defined (checked earlier)
  if (!relayUrl) {
    throw new SpacesError('No relay URL configured', 'USER_ERROR');
  }

  // Step 4: Create session manager
  const sessionManager = new ClientSessionManager({
    relay: relayUrl,
    identity,
    accessList,
  });

  // Initialize session manager (starts tmux-lite server)
  await sessionManager.initialize();

  // Set up event handling
  const eventHandler = createEventHandler(sessionManager, false);
  sessionManager.onEvent(eventHandler);

  // Step 5: Connect to relay
  logger.info('Connecting to relay...');

  try {
    await connectToRelay(relayUrl, machineId, publicIdentity, sessionManager, eventHandler, accessList, signingPrivateKey, options.relayPubkey);

    // Save relay config for share command
    writeRelayConfig({
      relayUrl,
      machineId,
      savedAt: Date.now(),
    });
    logger.dim('Relay config saved');
  } catch (error) {
    throw new SpacesError(
      `Failed to connect to relay: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2
    );
  }

  logger.log('');
  logger.dim('Waiting for connections... (Ctrl+C to stop)');
  logger.log('');

  // Step 6: Handle shutdown
  setupShutdownHandlers(sessionManager);

  // Keep process alive
  await new Promise(() => {
    // Never resolves - process stays alive until shutdown
  });
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
 * Connect to relay WebSocket with protocol message support
 */
async function connectToRelay(
  relayUrl: string,
  machineId: string,
  publicIdentity: PublicIdentity,
  sessionManager: ClientSessionManager,
  eventHandler: ServeEventHandler,
  accessList: AccessControlList,
  signingPrivateKey?: Uint8Array,
  relayPubkey?: string
): Promise<void> {
  // Build WebSocket URL with machine role (no token in URL - auth via challenge-response)
  const url = new URL(relayUrl);
  url.searchParams.set('role', 'machine');

  // Track current entries for diffing
  let currentEntries = readAccessList();
  let accessWatcher: ReturnType<typeof watch> | null = null;

  return new Promise((resolve, reject) => {
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 10;
    const baseReconnectDelay = 1000;
    const maxReconnectDelay = 30000;
    let resolved = false;
    let currentWs: WebSocket | null = null;

    // Decode public key for message signing
    const signingPublicKey = signingPrivateKey
      ? new Uint8Array(Buffer.from(publicIdentity.signingPublicKey, 'base64'))
      : null;

    // Helper to sign and send a message
    const signAndSend = (ws: WebSocket, msg: object) => {
      if (signingPrivateKey && signingPublicKey) {
        const signed = signMessage(msg, signingPrivateKey, signingPublicKey);
        ws.send(JSON.stringify(signed));
      } else {
        ws.send(JSON.stringify(msg));
      }
    };

    // Watch access list file for changes
    const startAccessWatcher = () => {
      const accessPath = getAccessListPath();

      // Create empty access list if it doesn't exist (watcher requires file to exist)
      if (!existsSync(accessPath)) {
        writeFileSync(accessPath, '[]', 'utf-8');
      }

      // Debounce to avoid multiple triggers
      let debounceTimeout: ReturnType<typeof setTimeout> | null = null;

      accessWatcher = watch(accessPath, (eventType) => {
        if (eventType !== 'change') return;

        // Debounce
        if (debounceTimeout) clearTimeout(debounceTimeout);
        debounceTimeout = setTimeout(() => {
          syncAccessList();
        }, 100);
      });

      logger.dim('Watching access list for changes');
    };

    // Sync access list changes to relay
    const syncAccessList = () => {
      if (!currentWs || currentWs.readyState !== WebSocket.OPEN) return;

      try {
        const newEntries = readAccessList();

        // Find added entries
        const added = newEntries.filter(
          (newEntry) => !currentEntries.find((e) => e.identityId === newEntry.identityId)
        );

        // Find removed entries
        const removed = currentEntries.filter(
          (oldEntry) => !newEntries.find((e) => e.identityId === oldEntry.identityId)
        );

        // Send authorize messages for new entries (signed)
        for (const entry of added) {
          // Validate entry before sending - skip entries with missing keys
          if (!isValidAccessEntry(entry)) {
            continue;
          }

          signAndSend(currentWs, {
            type: 'authorize_client',
            machineId,
            clientIdentityId: entry.identityId,
            signingKey: entry.signingPublicKey,
            keyExchangeKey: entry.keyExchangePublicKey,
            accessType: entry.accessType,
            sessionId: entry.sessionId,
          });
          logger.success(`Access granted: ${entry.label || entry.identityId.substring(0, 12)}...`);

          // Also update local access list
          accessList.addEntry({
            id: entry.identityId,
            signingPublicKey: entry.signingPublicKey,
            keyExchangePublicKey: entry.keyExchangePublicKey,
          }, entry.accessType, entry.sessionId);
        }

        // Send revoke messages for removed entries (signed)
        for (const entry of removed) {
          signAndSend(currentWs, {
            type: 'revoke_client',
            machineId,
            clientIdentityId: entry.identityId,
          });
          logger.warning(`Access revoked: ${entry.label || entry.identityId.substring(0, 12)}...`);

          // Also update local access list
          accessList.removeEntry(entry.identityId);
        }

        // Update current entries
        currentEntries = newEntries;
      } catch (error) {
        logger.error(`Failed to sync access list: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const connect = () => {
      console.log(`[serve] Connecting to relay: ${url.toString()}`);
      const ws = new WebSocket(url.toString());
      ws.binaryType = 'arraybuffer';
      currentWs = ws;

      ws.onopen = () => {
        console.log('[serve] WebSocket connected, waiting for relay identity...');
        reconnectAttempts = 0;
        // Don't send register_machine yet - wait for relay_identity message
      };

      ws.onclose = (event) => {
        console.log(`[serve] WebSocket closed: code=${event.code} reason=${event.reason || 'none'}`);
        eventHandler({
          type: 'relay_disconnected',
          code: event.code,
          reason: event.reason || 'Connection closed',
        });

        // Clear relay config on disconnect
        clearRelayConfig();

        // Attempt reconnection
        if (reconnectAttempts < maxReconnectAttempts) {
          reconnectAttempts++;
          const delay = Math.min(
            baseReconnectDelay * Math.pow(2, reconnectAttempts - 1) + Math.random() * 1000,
            maxReconnectDelay
          );
          eventHandler({ type: 'relay_reconnecting', attempt: reconnectAttempts });
          setTimeout(connect, delay);
        }
      };

      ws.onerror = (err) => {
        console.log('[serve] WebSocket error:', err);
        // Only reject on initial connection
        if (!resolved && reconnectAttempts === 0) {
          reject(new Error('WebSocket connection failed'));
        }
      };

      ws.onmessage = async (event) => {
        try {
          // Parse message
          const data = event.data;
          let msg: any;

          if (typeof data === 'string') {
            msg = JSON.parse(data);
          } else {
            const str = new TextDecoder().decode(data as ArrayBuffer);
            try {
              msg = JSON.parse(str);
            } catch {
              logger.warning('Received binary data without JSON envelope');
              return;
            }
          }

          // Handle protocol messages
          switch (msg.type) {
            case 'relay_identity': {
              // Relay is identifying itself and providing a challenge
              const { publicKey: relayPublicKey, fingerprint: relayFingerprint, label: relayLabel, challenge } = msg;

              console.log(`[serve] Received relay identity: ${relayFingerprint}${relayLabel ? ` (${relayLabel})` : ''}`);

              // Step 1: Verify relay trust
              const trustResult = await verifyRelayTrust(
                relayUrl,
                relayPublicKey,
                relayFingerprint,
                relayLabel,
                relayPubkey
              );

              if (!trustResult.trusted) {
                ws.close(1008, trustResult.reason);
                if (!resolved) {
                  reject(new Error(trustResult.reason));
                }
                return;
              }

              // Step 2: Sign the challenge and send register_machine
              if (!signingPrivateKey) {
                logger.error('No signing key available for challenge-response');
                ws.close(1008, 'No signing key');
                return;
              }

              const registration = signChallengeAndCreateRegistration(
                challenge,
                signingPrivateKey,
                machineId,
                publicIdentity
              );

              if (!registration) {
                ws.close(1008, 'Challenge signing failed');
                return;
              }

              signAndSend(ws, registration.message);
              console.log('[serve] Sent register_machine with challenge response');
              break;
            }

            case 'registered':
              // Machine registered successfully
              eventHandler({ type: 'relay_connected' });

              // Send initial access list entries to relay (signed)
              for (const entry of currentEntries) {
                // Validate entry before sending - skip entries with missing keys
                if (!isValidAccessEntry(entry)) {
                  continue;
                }

                signAndSend(ws, {
                  type: 'authorize_client',
                  machineId,
                  clientIdentityId: entry.identityId,
                  signingKey: entry.signingPublicKey,
                  keyExchangeKey: entry.keyExchangePublicKey,
                  accessType: entry.accessType,
                  sessionId: entry.sessionId,
                });
                logger.dim(`Synced access: ${entry.label || entry.identityId.substring(0, 12)}...`);
              }

              // Start watching access list for changes
              if (!accessWatcher) {
                startAccessWatcher();
              }

              // Register access command handler for CLI commands
              setAccessCommandHandler({
                async addAccess(entry) {
                  if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
                    return { success: false, error: 'Not connected to relay' };
                  }
                  try {
                    signAndSend(currentWs, {
                      type: 'add_global_access',
                      clientIdentityId: entry.clientIdentityId,
                      signingKey: entry.signingKey,
                      keyExchangeKey: entry.keyExchangeKey,
                      label: entry.label,
                      accessType: entry.accessType,
                      sessionId: entry.sessionId,
                    });
                    return { success: true };
                  } catch (err) {
                    return { success: false, error: err instanceof Error ? err.message : 'Send failed' };
                  }
                },
                async removeAccess(clientIdentityId) {
                  if (!currentWs || currentWs.readyState !== WebSocket.OPEN) {
                    return { success: false, error: 'Not connected to relay' };
                  }
                  try {
                    signAndSend(currentWs, {
                      type: 'remove_global_access',
                      clientIdentityId,
                    });
                    return { success: true };
                  } catch (err) {
                    return { success: false, error: err instanceof Error ? err.message : 'Send failed' };
                  }
                },
              });

              if (!resolved) {
                resolved = true;
                resolve();
              }
              break;

            case 'client_connected':
              // New client connection
              sessionManager.handleConnect(msg.connectionId);
              // Set up send callback for this connection
              sessionManager.setSendCallback(msg.connectionId, createSendCallback(ws, msg.connectionId));
              break;

            case 'client_disconnected':
              // Client disconnected
              sessionManager.handleDisconnect(msg.connectionId, msg.reason || 'Client disconnected');
              break;

            case 'data':
              // Data from client - connectionId tells us which client
              if (msg.data && msg.connectionId) {
                const messageData = Buffer.from(msg.data, 'base64');

                // Ensure send callback is set
                if (!sessionManager.getSession(msg.connectionId)) {
                  sessionManager.setSendCallback(msg.connectionId, createSendCallback(ws, msg.connectionId));
                }

                const response = await sessionManager.handleMessage(
                  msg.connectionId,
                  messageData
                );

                if (response) {
                  ws.send(createDataMessage(msg.connectionId, response));
                }
              }
              break;

            case 'error':
              logger.error(`Relay error: ${msg.message} (${msg.code})`);
              if (!resolved) {
                reject(new Error(msg.message));
              }
              break;

            case 'access_list':
              // Full access list from relay - sync to local access list
              logger.dim(`Received ${msg.entries?.length || 0} access entries from relay`);
              if (msg.entries && Array.isArray(msg.entries)) {
                for (const entry of msg.entries) {
                  accessList.addEntry({
                    id: entry.clientIdentityId,
                    signingPublicKey: entry.signingKey,
                    keyExchangePublicKey: entry.keyExchangeKey,
                  }, entry.accessType === 'full' ? 'full' : 'session-invite', entry.sessionId);
                }
              }
              break;

            case 'access_update':
              // Incremental access update from relay
              if (msg.added && Array.isArray(msg.added)) {
                for (const entry of msg.added) {
                  accessList.addEntry({
                    id: entry.clientIdentityId,
                    signingPublicKey: entry.signingKey,
                    keyExchangePublicKey: entry.keyExchangeKey,
                  }, entry.accessType === 'full' ? 'full' : 'session-invite', entry.sessionId);
                  logger.success(`Access granted (from relay): ${entry.label || entry.clientIdentityId.substring(0, 12)}...`);
                }
              }
              if (msg.removed && Array.isArray(msg.removed)) {
                for (const clientId of msg.removed) {
                  accessList.removeEntry(clientId);
                  logger.warning(`Access revoked (from relay): ${clientId.substring(0, 12)}...`);
                }
              }
              break;

            case 'client_authorized':
              // Acknowledgment that client authorization was registered with relay
              // No action needed - the authorization was already applied locally
              break;

            case 'client_revoked':
              // Acknowledgment that client revocation was registered with relay
              // No action needed - the revocation was already applied locally
              break;

            default:
              logger.dim(`Unknown message type: ${msg.type}`);
          }
        } catch (error) {
          logger.error(`Message handling error: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
    };

    connect();
  });
}

/**
 * Update session display
 */
function updateSessionDisplay(sessionManager: ClientSessionManager): void {
  const count = sessionManager.establishedSessionCount;
  if (count > 0) {
    logger.dim(`Active sessions: ${count}`);
  }
}

/**
 * Set up shutdown handlers
 */
function setupShutdownHandlers(sessionManager: ClientSessionManager, isDaemon: boolean = false): void {
  const shutdown = () => {
    logger.log('');
    logger.info('Shutting down...');

    // Stop cloudflared if running
    stopCloudflared();

    clearRelayConfig();
    sessionManager.cleanup();

    // Clean up daemon files if in daemon mode
    if (isDaemon) {
      stopStatusServer();
      cleanupServeFiles();
    }

    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// ============================================================================
// Daemon Commands
// ============================================================================

/**
 * Format uptime in human-readable format
 */
function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Start serve daemon
 */
export async function serveStart(options: {
  relay?: string;
  relayPubkey?: string;
  passwordStdin?: boolean;
  foreground?: boolean;
  ignoreKeychainAndSkipSecrets?: boolean;
} = {}): Promise<void> {
  // Check if already running
  if (isServeRunning()) {
    const pid = getServePid();
    logger.info(`serve daemon already running${pid ? ` (pid ${pid})` : ''}`);
    return;
  }

  // Load identity (need password)
  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  let password: string | null = null;

  if (options.passwordStdin) {
    // Read password from stdin
    const reader = process.stdin;
    const chunks: Buffer[] = [];

    const onData = (chunk: Buffer) => chunks.push(chunk);
    reader.on('data', onData);

    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => reject(new Error('Timeout reading password from stdin')), 10000);
      const onEnd = () => {
        clearTimeout(timeoutId);
        resolve();
      };
      const onError = (err: Error) => {
        clearTimeout(timeoutId);
        reject(err);
      };
      reader.once('end', onEnd);
      reader.once('error', onError);
    });

    // Clean up stdin to allow process to exit
    reader.removeListener('data', onData);
    reader.pause();

    password = Buffer.concat(chunks).toString().trim();
    if (!password) {
      throw new SpacesError('No password provided via stdin', 'USER_ERROR', 1);
    }
  } else {
    // Interactive prompt
    password = await promptPassword('Enter password to unlock identity:');
    if (!password) {
      logger.info('Cancelled');
      return;
    }
  }

  // Validate password by loading keypair
  const identity = await loadKeypair(password);
  if (!identity) {
    throw new SpacesError(
      'Failed to unlock identity. Check your password.',
      'USER_ERROR',
      1
    );
  }

  // Extract signing private key for challenge-response
  const signingPrivateKey = identity.signing.secretKey.slice(0, 32);

  // If not foreground mode, fork to background
  if (!options.foreground) {
    logger.log('Starting serve daemon...');

    // Build args for background process
    // Detect if we're running as a compiled binary vs dev mode
    const isCompiled = !process.execPath.endsWith('bun');

    const serveArgs = ['serve', 'start', '--foreground'];
    if (options.relay) serveArgs.push('--relay', options.relay);
    if (options.relayPubkey) serveArgs.push('--relay-pubkey', options.relayPubkey);
    if (options.ignoreKeychainAndSkipSecrets) {
      serveArgs.push('--ignore-keychain-and-skip-secrets');
    }
    serveArgs.push('--password-stdin');

    // Build command: compiled binary runs directly, dev mode uses bun
    const cmd = isCompiled
      ? [process.execPath, ...serveArgs]
      : ['bun', process.argv[1], ...serveArgs];

    // Write output to log file for debugging
    const logFile = getServeLogFile();
    ensureServeDaemonDir();

    // Truncate log file at start
    await Bun.write(logFile, `[${new Date().toISOString()}] Starting serve daemon...\n`);

    const child = spawn({
      cmd,
      stdin: 'pipe',
      stdout: Bun.file(logFile),
      stderr: Bun.file(logFile),
      env: process.env,
    });

    // Send password via stdin
    child.stdin.write(password);
    child.stdin.end();

    // Wait a bit for process to start
    await Bun.sleep(1000);

    // Check if it started
    if (isServeRunning()) {
      const pid = getServePid();
      logger.success(`serve daemon started${pid ? ` (pid ${pid})` : ''}`);
      // Force exit since inquirer prompts may keep event loop alive
      process.exit(0);
    } else {
      // Read log file for error message
      const logContent = await Bun.file(logFile).text();
      logger.error('Daemon log:');
      logger.log(logContent);
      throw new SpacesError('Failed to start serve daemon. Check log above for details.', 'SYSTEM_ERROR', 2);
    }
  }

  // Foreground/daemon mode - write PID and start status server
  writeServePid(process.pid);
  startStatusServer();

  // Get public identity for registration
  const publicIdentity = getPublicKeyWithoutPassword();
  if (!publicIdentity) {
    cleanupServeFiles();
    throw new SpacesError('Failed to read public identity', 'SYSTEM_ERROR', 2);
  }

  // Load access control list
  const accessList = new AccessControlList();
  const entries = readAccessList();
  accessList.import(entries);

  try {
    await initializeSecretRuntime({
      ignoreKeychainAndSkipSecrets: options.ignoreKeychainAndSkipSecrets,
    });
  } catch (error) {
    stopStatusServer();
    cleanupServeFiles();
    throw error;
  }

  // Get config
  const machineIdentity = readMachineIdentity();
  const machineId = machineIdentity?.machineId ?? identity.id;

  // Check for gitspace.sh hosting
  const hostConfig = readHostConfig();
  const relayUrl = options.relay; // No default - must use hosting or explicit --relay

  // If no hosting config and no explicit relay, error out
  if (!hostConfig?.subdomain && !relayUrl) {
    cleanupServeFiles();
    throw new SpacesError(
      'No relay configured.\n\n' +
      'Either set up gitspace.sh hosting:\n' +
      '  gssh auth login\n' +
      '  gssh host reserve <subdomain>\n\n' +
      'Or specify a relay explicitly:\n' +
      '  gssh serve start --relay ws://localhost:4480/ws',
      'USER_ERROR'
    );
  }

  let localRelayServer: ReturnType<typeof createRelayServer> | null = null;
  let localRelayIdentity: ReturnType<typeof generateRelayIdentity> | null = null;
  let effectiveRelayUrl = relayUrl || '';

  // Initialize daemon state
  setDaemonState({
    version: PACKAGE_VERSION,
    startTime: Date.now(),
    relay: {
      url: effectiveRelayUrl,
      status: 'connecting',
    },
    clients: 0,
    hosting: hostConfig?.subdomain ? {
      subdomain: hostConfig.subdomain,
      tunnelActive: false,
    } : undefined,
  });

  if (hostConfig?.subdomain) {
    // Generate an ephemeral identity for local relay
    localRelayIdentity = generateRelayIdentity('local-relay');

    // Start local relay server with this machine pre-authorized
    try {
      localRelayServer = createRelayServer({
        port: LOCAL_RELAY_PORT,
        bind: '127.0.0.1',
        identity: localRelayIdentity,
        preAuthorizedMachines: [publicIdentity.signingPublicKey],
      });
      logger.success(`Local relay started on port ${LOCAL_RELAY_PORT}`);
    } catch (error) {
      cleanupServeFiles();
      throw new SpacesError('Failed to start local relay server', 'SYSTEM_ERROR', 2);
    }

    // Start cloudflared tunnel
    const tunnelStarted = await startCloudflared(hostConfig.subdomain);
    if (tunnelStarted) {
      updateDaemonState({
        hosting: {
          subdomain: hostConfig.subdomain,
          tunnelActive: true,
        },
      });
    }

    // Use local relay (machine will authenticate via challenge-response)
    effectiveRelayUrl = `ws://127.0.0.1:${LOCAL_RELAY_PORT}/ws`;
  }

  // Create session manager
  const sessionManager = new ClientSessionManager({
    relay: effectiveRelayUrl,
    identity,
    accessList,
  });

  // Initialize session manager (starts tmux-lite server)
  await sessionManager.initialize();

  // Event handler - update daemon state
  const eventHandler: ServeEventHandler = (event) => {
    switch (event.type) {
      case 'relay_connected':
        updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'connected' } });
        break;
      case 'relay_disconnected':
        updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'disconnected' } });
        break;
      case 'relay_reconnecting':
        updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'reconnecting' } });
        break;
      case 'client_authenticated':
      case 'client_disconnected':
        updateDaemonState({ clients: sessionManager.establishedSessionCount });
        break;
    }
  };

  sessionManager.onEvent(eventHandler);

  // Connect to relay
  try {
    await connectToRelay(effectiveRelayUrl, machineId, publicIdentity, sessionManager, eventHandler, accessList, signingPrivateKey, options.relayPubkey);
    updateDaemonState({ relay: { url: effectiveRelayUrl, status: 'connected' } });
  } catch (error) {
    localRelayServer?.stop();
    stopCloudflared();
    cleanupServeFiles();
    throw new SpacesError(
      `Failed to connect to relay: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2
    );
  }

  // Save relay config for share/access commands
  writeRelayConfig({
    relayUrl: effectiveRelayUrl,
    machineId,
    savedAt: Date.now(),
  });

  // Set up shutdown handlers with daemon cleanup
  setupShutdownHandlers(sessionManager, true);

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Stop serve daemon
 */
export async function serveStop(): Promise<void> {
  if (!isServeRunning()) {
    logger.info('serve daemon not running');
    return;
  }

  logger.log('Stopping serve daemon...');

  // Try graceful shutdown via socket first
  const success = await sendShutdownCommand();

  if (success) {
    // Wait for process to exit
    await Bun.sleep(1000);

    if (!isServeRunning()) {
      logger.success('serve daemon stopped');
      return;
    }
  }

  // Fallback: send SIGTERM directly
  const pid = getServePid();
  if (pid) {
    try {
      process.kill(pid, 'SIGTERM');
      await Bun.sleep(1000);

      if (!isServeRunning()) {
        logger.success('serve daemon stopped');
        return;
      }

      // Force kill
      process.kill(pid, 'SIGKILL');
      cleanupServeFiles();
      logger.success('serve daemon stopped (forced)');
    } catch {
      cleanupServeFiles();
      logger.success('serve daemon stopped');
    }
  }
}

/**
 * Show serve daemon status
 */
export async function serveStatus(): Promise<void> {
  // Build status output
  const box = (lines: string[]) => {
    const width = 44;
    const top = '┌─ serve daemon ' + '─'.repeat(width - 16) + '┐';
    const bottom = '└' + '─'.repeat(width) + '┘';
    const padded = lines.map((l) => {
      const visible = l.replace(/\x1b\[[0-9;]*m/g, ''); // Strip ANSI for length calc
      const padding = width - visible.length;
      return '│ ' + l + ' '.repeat(Math.max(0, padding - 1)) + '│';
    });
    return [top, ...padded, bottom].join('\n');
  };

  if (!isServeRunning()) {
    const lines = [
      'Status:   \x1b[90m○ not running\x1b[0m',
      '',
      'Run: \x1b[36mgssh serve start\x1b[0m',
    ];
    logger.log(box(lines));
    return;
  }

  // Query daemon for status
  const status = await queryServeStatus();

  if (status) {
    const statusIcon = status.relay.status === 'connected' ? '\x1b[32m●\x1b[0m' : '\x1b[33m●\x1b[0m';
    const relayStatus = status.relay.status === 'connected' ? 'connected' : status.relay.status;

    const lines = [
      `Status:   ${statusIcon} running (pid ${status.pid})`,
      `Version:  ${status.version}`,
      `Relay:    ${status.relay.url}`,
      `          ${relayStatus}`,
      `Clients:  ${status.clients} active`,
      `Uptime:   ${formatUptime(status.uptime)}`,
    ];

    if (status.hosting) {
      const tunnelIcon = status.hosting.tunnelActive ? '\x1b[32m●\x1b[0m' : '\x1b[31m●\x1b[0m';
      lines.push(`Hosting:  ${tunnelIcon} ${status.hosting.subdomain}.gitspace.sh`);
    }

    logger.log(box(lines));
  } else {
    // Fallback if status query fails
    const pid = getServePid();
    const lines = [
      `Status:   \x1b[32m●\x1b[0m running${pid ? ` (pid ${pid})` : ''}`,
      `Version:  ${PACKAGE_VERSION}`,
    ];
    logger.log(box(lines));
  }
}
