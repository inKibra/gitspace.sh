/**
 * Connect command implementation
 *
 * Handles 'gssh connect <invite>' to connect to a remote machine
 * via an invite token or URL, or lists available machines when no
 * invite is provided.
 */

import { logger } from '../utils/logger.js';
import { promptPassword, promptConfirm, promptInput, selectOne } from '../utils/prompts.js';
import { loadKeypair, keypairExists } from '../core/identity.js';
import { parseInviteToken, isInviteExpired } from '../lib/tmux-lite/crypto/invites.js';
import WebSocket from 'ws';
import { createHash } from 'crypto';
import { buildRemoteBackendKey } from './connect-key.js';
import {
  RemoteSessionBackend,
  nodeRemoteSocketAdapter,
  nodeRemoteCryptoAdapter,
  nodeRemoteHandshakeAdapter,
  createNodeRelaySigner,
  type BackendEvent,
} from '../session/index.js';
import {
  NoIdentityError,
  SpacesError,
} from '../types/errors.js';
import type { InviteToken } from '../types/identity.js';
import type {
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';

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

  // Step 4: Connect to relay and establish remote session backend
  const relayUrl = options.relay ?? token.relayUrl;
  const rawInviteToken =
    inviteTokenOrUrl.includes('#')
      ? extractTokenFromUrl(inviteTokenOrUrl) ?? inviteTokenOrUrl
      : inviteTokenOrUrl;
  const inviteId = createHash('sha256').update(rawInviteToken).digest('hex').substring(0, 16);

  logger.info('Connecting to relay...');

  const socketUrl = new URL(relayUrl);
  socketUrl.searchParams.set('role', 'client');

  const backendKey = buildRemoteBackendKey(relayUrl, token.machineId);
  const backend = new RemoteSessionBackend({
    descriptor: {
      key: backendKey,
      kind: 'remote',
      label: token.machineId,
      relayUrl,
      machineId: token.machineId,
    },
    socket: new WebSocket(socketUrl.toString()),
    socketAdapter: nodeRemoteSocketAdapter,
    identity,
    machineId: token.machineId,
    inviteId,
    inviteToken: rawInviteToken,
    signer: (message, identity) => createNodeRelaySigner(identity)(message),
    crypto: nodeRemoteCryptoAdapter,
    handshake: nodeRemoteHandshakeAdapter,
  });

  backend.setPtyOutputHandler((data) => {
    process.stdout.write(Buffer.from(data));
  });

  let backendConnected = false;
  const disconnectBackend = async () => {
    if (!backendConnected) {
      return;
    }

    try {
      await backend.disconnect();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to disconnect cleanly: ${detail}`);
    } finally {
      backendConnected = false;
    }
  };

  try {
    await backend.connect();
    backendConnected = true;
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

  logger.success('Connected!');
  logger.log('');
  logger.dim(`Access: ${token.accessType === 'full' ? 'Full access' : 'Session invite'}`);

  try {
    const terminalSize = getTerminalSize();
    let attachWait: {
      promise: Promise<Extract<BackendEvent, { type: 'attached' }>>;
      cancel: () => void;
    };

    if (token.accessType === 'session-invite' && token.sessionId) {
      logger.dim(`Session: ${token.sessionId}`);
      attachWait = waitForBackendEvent(
        backend,
        (event): event is Extract<BackendEvent, { type: 'attached' }> => event.type === 'attached',
        30000,
        'attach confirmation'
      );
      try {
        await backend.attachSession({
          sessionId: token.sessionId,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
        });
      } catch (error) {
        attachWait.cancel();
        throw error;
      }
    } else {
      const workspace = await selectWorkspaceForFullAccess(backend);
      if (!workspace) {
        logger.info('Cancelled');
        return;
      }

      const sessionName = await promptInput('Session name (optional):');
      if (sessionName === null) {
        logger.info('Cancelled');
        return;
      }

      attachWait = waitForBackendEvent(
        backend,
        (event): event is Extract<BackendEvent, { type: 'attached' }> => event.type === 'attached',
        30000,
        'attach confirmation'
      );

      try {
        await backend.attachSession({
          workspaceId: workspace.id,
          sessionName: sessionName || undefined,
          cols: terminalSize.cols,
          rows: terminalSize.rows,
        });
      } catch (error) {
        attachWait.cancel();
        throw error;
      }
    }

    const attached = await attachWait.promise;
    logger.success(`Attached to ${attached.sessionName ?? attached.sessionId}`);
    logger.log('');
    logger.dim('Press Ctrl+D to disconnect');
    logger.log('');

    await startTerminalSession(backend);
    backendConnected = false;
  } finally {
    await disconnectBackend();
  }
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
interface ConnectedTerminalBackend {
  disconnect: () => Promise<void>;
  writePtyData?: (data: Uint8Array) => Promise<void>;
  resizePty?: (cols: number, rows: number) => Promise<void>;
  onEvent: (handler: (event: BackendEvent) => void) => () => void;
}

async function startTerminalSession(backend: ConnectedTerminalBackend): Promise<void> {
  const handlers: Array<() => void> = [];
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;

    for (const handler of handlers) {
      handler();
    }

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  };

  await new Promise<void>((resolve) => {
    let stopping = false;
    const stop = async (message?: string) => {
      if (stopping) {
        return;
      }
      stopping = true;

      if (message) {
        logger.info(message);
      }
      cleanup();
      try {
        await backend.disconnect();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to disconnect cleanly: ${detail}`);
      } finally {
        resolve();
      }
    };

    const unsubEvents = backend.onEvent((event) => {
      if (event.type === 'session_exited') {
        void stop(`Session exited${typeof event.exitCode === 'number' ? ` (${event.exitCode})` : ''}`);
      }

      if (event.type === 'detached') {
        void stop('Detached');
      }

      if (event.type === 'status' && event.status === 'disconnected') {
        void stop('Disconnected');
      }

      if (event.type === 'error') {
        logger.error(`Connection error: ${event.message}`);
      }
    });
    handlers.push(unsubEvents);

  // Set stdin to raw mode for character-by-character input
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();

  // Forward stdin to remote
    const onData = (data: Buffer) => {
    // Check for Ctrl+D (EOF)
    if (data.length === 1 && data[0] === 0x04) {
      logger.log('');
        void stop('Disconnecting...');
      return;
    }

      backend.writePtyData?.(new Uint8Array(data))?.catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to send PTY input: ${detail}`);
      });
    };
    process.stdin.on('data', onData);
    handlers.push(() => process.stdin.removeListener('data', onData));

  // Handle terminal resize
  if (process.stdout.isTTY) {
      const onResize = () => {
        const cols = process.stdout.columns;
        const rows = process.stdout.rows;
        backend.resizePty?.(cols, rows)?.catch((error) => {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to send PTY resize: ${detail}`);
        });
      };
      process.stdout.on('resize', onResize);
      handlers.push(() => process.stdout.removeListener('resize', onResize));

    // Send initial size
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      backend.resizePty?.(cols, rows)?.catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to send initial PTY size: ${detail}`);
      });
  }

  // Handle SIGINT (Ctrl+C)
    const onSigInt = () => {
    // Forward Ctrl+C to remote instead of terminating
      backend.writePtyData?.(new Uint8Array([0x03]))?.catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to send Ctrl+C to remote: ${detail}`);
      });
    };
    process.on('SIGINT', onSigInt);
    handlers.push(() => process.removeListener('SIGINT', onSigInt));

  // Handle process termination
    const onSigTerm = () => {
      void stop('Disconnecting...');
    };
    process.on('SIGTERM', onSigTerm);
    handlers.push(() => process.removeListener('SIGTERM', onSigTerm));
  });
}

function getTerminalSize(): { cols: number; rows: number } {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return { cols, rows };
}

function waitForBackendEvent<TEvent extends BackendEvent>(
  backend: { onEvent: (handler: (event: BackendEvent) => void) => () => void },
  predicate: (event: BackendEvent) => event is TEvent,
  timeoutMs: number,
  label: string
): { promise: Promise<TEvent>; cancel: () => void } {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let unsubscribe: (() => void) | null = null;
  let settled = false;

  const cleanup = () => {
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }

    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };

  const settle = (done: () => void) => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    done();
  };

  const promise = new Promise<TEvent>((resolve, reject) => {
    timeout = setTimeout(() => {
      settle(() => {
        reject(new SpacesError(`Timed out waiting for ${label}`, 'SYSTEM_ERROR', 2));
      });
    }, timeoutMs);

    unsubscribe = backend.onEvent((event) => {
      if (predicate(event)) {
        settle(() => {
          resolve(event);
        });
        return;
      }

      if (event.type === 'command_error') {
        settle(() => {
          const message = event.code ? `[${event.code}] ${event.message}` : event.message;
          reject(new SpacesError(message, 'SYSTEM_ERROR', 2));
        });
        return;
      }

      if (event.type === 'error') {
        settle(() => {
          reject(new SpacesError(event.message, 'SYSTEM_ERROR', 2));
        });
      }
    });
  });

  const cancel = () => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
  };

  return { promise, cancel };
}

async function selectWorkspaceForFullAccess(
  backend: {
    listWorkspaces: () => Promise<void>;
    onEvent: (handler: (event: BackendEvent) => void) => () => void;
  }
): Promise<WorkspaceInfo | null> {
  const workspacesWait = waitForBackendEvent(
    backend,
    (event): event is Extract<BackendEvent, { type: 'workspaces' }> => event.type === 'workspaces',
    15000,
    'workspace list'
  );

  try {
    await backend.listWorkspaces();
  } catch (error) {
    workspacesWait.cancel();
    throw error;
  }

  const response = await workspacesWait.promise;
  const workspaces = response.workspaces;

  if (workspaces.length === 0) {
    throw new SpacesError('No workspaces available on remote machine', 'USER_ERROR', 1);
  }

  const selectedId = await selectOne(
    workspaces.map((workspace) => ({
      label: workspace.name,
      value: workspace.id,
      description: workspace.projectName,
    })),
    'Select workspace to open:'
  );

  if (!selectedId) {
    return null;
  }

  return workspaces.find((workspace) => workspace.id === selectedId) ?? null;
}
