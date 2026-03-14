/**
 * Connect command implementation
 *
 * Handles 'gssh client connect <target>' to connect to a remote machine
 * via owner identity authorization, or lists available machines
 * when no target is provided.
 */

import { logger } from '../utils/logger.js';
import { promptConfirm, promptInput, selectOne } from '../utils/prompts.js';
import {
  loadKeypair,
  readRelayConfig,
} from '../core/identity.js';
import { createLocalDeviceCertificate } from '../core/user-identity.js';
import WebSocket from 'ws';
import chalk from 'chalk';
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
  RelayMachineDirectoryClient,
  nodeRelaySocketAdapter,
} from '../relay-client/index.js';
import {
  SpacesError,
} from '../types/errors.js';
import {
  createDeviceIdentityPasswordContext,
  ensureDeviceIdentityPassword,
} from './device-identity-password.js';
import { ensureUserRootIdentityWithRecovery } from './identity-recovery.js';
import {
  addTrustedRelay,
  getTrustedRelay,
  isLocalhost,
} from '../core/trusted-relays.js';
import { formatRelayFingerprint } from '../relay/identity.js';
import type {
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';

export interface RelayIdentityProbe {
  publicKey: string;
  fingerprint: string;
  label?: string;
}

function relayHealthUrl(relayUrl: string): string {
  const parsed = new URL(relayUrl);
  const protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${parsed.host}/health`;
}

export async function fetchRelayIdentity(relayUrl: string): Promise<RelayIdentityProbe> {
  const healthUrl = relayHealthUrl(relayUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(healthUrl, { signal: controller.signal });
    if (!response.ok) {
      throw new SpacesError(
        `Could not fetch relay identity from ${healthUrl} (${response.status} ${response.statusText}).`,
        'USER_ERROR',
        1,
      );
    }

    const body = await response.json() as {
      relayPublicKey?: string;
      relayFingerprint?: string;
      relayLabel?: string;
    };

    if (!body.relayPublicKey || typeof body.relayPublicKey !== 'string') {
      throw new SpacesError(
        `Relay at ${healthUrl} did not provide relayPublicKey.`,
        'USER_ERROR',
        1,
      );
    }

    const fingerprint = formatRelayFingerprint(body.relayPublicKey);
    if (typeof body.relayFingerprint === 'string' && body.relayFingerprint !== fingerprint) {
      logger.error(
        `Relay at ${healthUrl} reported fingerprint ${body.relayFingerprint}, but computed ${fingerprint} from relayPublicKey.`,
      );
      throw new SpacesError(
        `Relay at ${healthUrl} returned inconsistent identity metadata.`,
        'USER_ERROR',
        1,
      );
    }

    return {
      publicKey: body.relayPublicKey,
      fingerprint,
      label: typeof body.relayLabel === 'string' ? body.relayLabel : undefined,
    };
  } catch (error) {
    if (error instanceof SpacesError) {
      throw error;
    }

    throw new SpacesError(
      `Failed to verify relay identity (${error instanceof Error ? error.message : String(error)}).`,
      'USER_ERROR',
      1,
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyClientRelayTrust(
  relayUrl: string,
  relayIdentity: RelayIdentityProbe,
  options: { relayPubkey?: string; yes?: boolean } = {},
): Promise<void> {
  const trustedRelay = getTrustedRelay(relayUrl);

  if (trustedRelay && trustedRelay.publicKey !== relayIdentity.publicKey) {
    logger.log('');
    logger.error('SECURITY WARNING: Relay public key mismatch!');
    logger.error(`Expected:  ${trustedRelay.fingerprint}`);
    logger.error(`Received:  ${relayIdentity.fingerprint}`);
    logger.log('');
    throw new SpacesError(
      'Relay identity mismatch - possible security threat. Remove the old entry from ~/gitspace/.identity/trusted-relays.json and retry only if expected.',
      'USER_ERROR',
      1,
    );
  }

  if (trustedRelay && trustedRelay.publicKey === relayIdentity.publicKey) {
    return;
  }

  if (options.relayPubkey) {
    if (options.relayPubkey !== relayIdentity.publicKey) {
      throw new SpacesError(
        `Relay public key does not match --relay-pubkey (expected ${formatRelayFingerprint(options.relayPubkey)}, got ${relayIdentity.fingerprint}).`,
        'USER_ERROR',
        1,
      );
    }

    addTrustedRelay(relayUrl, relayIdentity.publicKey, relayIdentity.label);
    logger.success('Relay trusted via explicit --relay-pubkey.');
    return;
  }

  if (isLocalhost(relayUrl)) {
    addTrustedRelay(relayUrl, relayIdentity.publicKey, relayIdentity.label);
    logger.dim(`Trusted localhost relay ${relayIdentity.fingerprint}`);
    return;
  }

  logger.log('');
  logger.bold('Unknown Relay');
  logger.log(`  URL:         ${relayUrl}`);
  logger.log(`  Fingerprint: ${relayIdentity.fingerprint}`);
  if (relayIdentity.label) {
    logger.log(`  Label:       ${relayIdentity.label}`);
  }
  logger.log('');

  if (options.yes) {
    logger.error('Unknown relay requires interactive approval or --relay-pubkey.');
    throw new SpacesError(
      'Unknown relay requires interactive approval or --relay-pubkey.',
      'USER_ERROR',
      1,
    );
  }

  const shouldTrust = await promptConfirm('Trust this relay?', true);
  if (!shouldTrust) {
    throw new SpacesError('Relay not trusted, aborting connection.', 'USER_ERROR', 1);
  }

  addTrustedRelay(relayUrl, relayIdentity.publicKey, relayIdentity.label);
  logger.success('Relay trusted and saved.');
}

/**
 * Connect to a remote machine as the owner identity.
 *
 * @param target - Machine ID
 * @param options - Command options
 */
export async function connectToRemote(
  target?: string,
  options: { relay?: string; machine?: string; relayPubkey?: string; yes?: boolean; passwordStdin?: boolean } = {}
): Promise<void> {
  const devicePasswordContext = createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });
  if (!target && !options.machine) {
    throw new SpacesError(
      'Connection target required.\n\nUsage:\n  gssh client connect <machine-id> --relay <url>\n  gssh client connect --machine <id> --relay <url>\n\nList available machines:\n  gssh client machines list --relay <url>',
      'USER_ERROR',
      1
    );
  }

  const machineId = options.machine ?? target;
  if (!machineId) {
    throw new SpacesError('Machine ID is required.', 'USER_ERROR', 1);
  }

  const relayUrl = options.relay ?? readRelayConfig()?.relayUrl;
  if (!relayUrl) {
    throw new SpacesError('Relay URL is required. Pass --relay <url>.', 'USER_ERROR', 1);
  }

  logger.log('');
  logger.bold('Remote Connection Details:');
  logger.log('');
  logger.log(`  Machine:     ${machineId}`);
  logger.log('  Access:      Owner identity required');
  logger.log(`  Relay:       ${relayUrl}`);
  logger.log('');

  const confirmed = options.yes || await promptConfirm('Connect to this machine?', true);
  if (!confirmed) {
    logger.info('Cancelled');
    return;
  }

  const relayIdentity = await fetchRelayIdentity(relayUrl);
  await verifyClientRelayTrust(relayUrl, relayIdentity, {
    relayPubkey: options.relayPubkey,
    yes: options.yes,
  });

  await ensureUserRootIdentityWithRecovery({
    devicePasswordContext,
    yes: options.yes,
    context: 'remote client authorization',
  });

  // Step 3: Load local identity
  const password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
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

  const deviceCertificate = await createLocalDeviceCertificate(identity);

  logger.info('Connecting to relay...');

  const backend = createRemoteBackend(relayUrl, machineId, identity, deviceCertificate);

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
  logger.dim('Access: Full access');

  try {
    const terminalSize = getTerminalSize();
    let attachWait: {
      promise: Promise<Extract<BackendEvent, { type: 'attached' }>>;
      cancel: () => void;
    };

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

    const attached = await attachWait.promise;
    logger.success(`Attached to ${attached.sessionName ?? attached.sessionId}`);
    logger.log('');
    logger.dim('Press Ctrl+D to disconnect');
    logger.log('');

    // Build reconnect context so startTerminalSession can re-attach
    // automatically if the relay or machine drops.
    const reconnectCtx: ReconnectContext = {
      relayUrl,
      machineId,
      identity,
      deviceCertificate,
      tmuxSessionId: attached.sessionId,
    };

    await startTerminalSession(backend, reconnectCtx);
    backendConnected = false;
  } finally {
    await disconnectBackend();
  }
}

export async function listRemoteMachines(options: {
  relay?: string;
  relayPubkey?: string;
  json?: boolean;
  yes?: boolean;
  passwordStdin?: boolean;
}): Promise<void> {
  const devicePasswordContext = createDeviceIdentityPasswordContext({ passwordStdin: options.passwordStdin });
  if (!options.relay) {
    throw new SpacesError('Relay URL is required. Use --relay <url>.', 'USER_ERROR', 1);
  }

  const relayIdentity = await fetchRelayIdentity(options.relay);
  await verifyClientRelayTrust(options.relay, relayIdentity, {
    relayPubkey: options.relayPubkey,
    yes: options.yes,
  });

  await ensureUserRootIdentityWithRecovery({
    devicePasswordContext,
    yes: options.yes,
    context: 'remote machine directory authorization',
  });

  const password = await ensureDeviceIdentityPassword({ yes: options.yes }, devicePasswordContext);
  if (!password) {
    logger.info('Cancelled');
    return;
  }

  const identity = await loadKeypair(password);
  const deviceCertificate = await createLocalDeviceCertificate(identity);
  const signer = createNodeRelaySigner(identity);

  const relayUrl = options.relay;

  type MachineRow = {
    machineId: string;
    label?: string;
    online: boolean;
    isAuthorized: boolean;
    accessType?: 'full' | 'view';
    sessionId?: string;
    lastConnectedAt?: number;
  };

  const machines = await new Promise<MachineRow[]>((resolve, reject) => {
    const client = new RelayMachineDirectoryClient<WebSocket>({
      relayUrl,
      clientIdentityId: identity.id,
      deviceCertificate,
      socketAdapter: nodeRelaySocketAdapter,
      signer,
      onMachineList: (listed) => {
        finish(undefined, listed as MachineRow[]);
      },
      onError: (message) => {
        finish(new Error(message));
      },
    });

    const timeout = setTimeout(() => {
      finish(new Error('Timed out waiting for machine list'));
    }, 15000);

    let finished = false;
    const finish = (error?: Error, listed?: MachineRow[]) => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      client.disconnect();

      if (error) {
        reject(error);
        return;
      }

      resolve(listed ?? []);
    };

    void client.connect().catch((error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });
  });

  if (options.json) {
    console.log(JSON.stringify(machines, null, 2));
    return;
  }

  if (machines.length === 0) {
    logger.info('No machines available for this identity.');
    return;
  }

  logger.bold('Machines:');
  logger.log('');
  const machineWidth = 20;
  const labelWidth = 24;
  logger.dim('MACHINE ID'.padEnd(machineWidth) + 'LABEL'.padEnd(labelWidth) + 'STATUS');
  logger.dim('─'.repeat(machineWidth + labelWidth + 10));

  for (const machine of machines) {
    const machineCol = machine.machineId.slice(0, machineWidth - 1).padEnd(machineWidth);
    const labelCol = (machine.label || '-').slice(0, labelWidth - 1).padEnd(labelWidth);
    const status = machine.online ? 'online' : 'offline';
    logger.log(chalk.cyan(machineCol) + labelCol + (machine.online ? chalk.green(status) : chalk.dim(status)));
  }
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

/** Context required to create a new backend for reconnection */
interface ReconnectContext {
  relayUrl: string;
  machineId: string;
  identity: Awaited<ReturnType<typeof import('../core/identity.js').loadKeypair>>;
  deviceCertificate: string;
  /** tmux-lite session ID to re-attach to after reconnect */
  tmuxSessionId: string;
  // cols/rows are intentionally omitted: the reconnect loop reads live
  // process.stdout values so it always uses the current terminal size,
  // not the (possibly stale) size captured at initial attach time.
}

/** Build a fresh RemoteSessionBackend + WebSocket */
function createRemoteBackend(
  relayUrl: string,
  machineId: string,
  identity: NonNullable<Awaited<ReturnType<typeof import('../core/identity.js').loadKeypair>>>,
  deviceCertificate: string,
): RemoteSessionBackend<WebSocket, import('../lib/tmux-lite/crypto/handshake.js').X3DHClientState, import('../types/identity.js').X3DHResponseMessage, import('../types/identity.js').X3DHResultMessage> {
  const socketUrl = new URL(relayUrl);
  socketUrl.searchParams.set('role', 'client');
  const backendKey = buildRemoteBackendKey(relayUrl, machineId);
  return new RemoteSessionBackend({
    descriptor: {
      key: backendKey,
      kind: 'remote',
      label: machineId,
      relayUrl,
      machineId,
    },
    socket: new WebSocket(socketUrl.toString()),
    socketAdapter: nodeRemoteSocketAdapter,
    identity,
    machineId,
    deviceCertificate,
    signer: (message, id) => createNodeRelaySigner(id)(message),
    crypto: nodeRemoteCryptoAdapter,
    handshake: nodeRemoteHandshakeAdapter,
  });
}

async function startTerminalSession(
  initialBackend: ConnectedTerminalBackend,
  reconnectCtx?: ReconnectContext,
): Promise<void> {
  const handlers: Array<() => void> = [];
  let cleanedUp = false;
  // currentBackend may be swapped out by the reconnect logic.
  let currentBackend = initialBackend;

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
    let reconnecting = false;

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
        await currentBackend.disconnect();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to disconnect cleanly: ${detail}`);
      } finally {
        resolve();
      }
    };

    // ---------------------------------------------------------------------------
    // Reconnection logic
    //
    // When the relay or machine drops, we attempt to transparently rebuild the
    // backend and re-attach to the same tmux-lite session.  The terminal state
    // is fully preserved by xterm-headless on the machine side.
    //
    // Strategy:
    //   - 10 attempts with exponential backoff capped at 30 s
    //   - On success: swap currentBackend and resume the session
    //   - On exhaustion: fall through to stop() with an error message
    // ---------------------------------------------------------------------------

    const MAX_RECONNECT_ATTEMPTS = 10;
    const BASE_RECONNECT_DELAY_MS = 1_000;
    const MAX_RECONNECT_DELAY_MS = 30_000;

    const attemptReconnect = async () => {
      if (reconnecting || stopping || !reconnectCtx) {
        if (!reconnectCtx) {
          void stop('Disconnected');
        }
        return;
      }
      reconnecting = true;

      const { relayUrl, machineId, identity, deviceCertificate, tmuxSessionId } = reconnectCtx;
      // Read current terminal size at reconnect time (not the stale size from
      // initial attach, which may differ if the user resized the window).
      const { cols, rows } = getTerminalSize();

      for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
        if (stopping) break;

        const delay = attempt === 1
          ? 0
          : Math.min(BASE_RECONNECT_DELAY_MS * Math.pow(2, attempt - 2) + Math.random() * 1_000, MAX_RECONNECT_DELAY_MS);

        if (delay > 0) {
          logger.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})...`);
          await new Promise<void>((r) => setTimeout(r, delay));
        } else {
          logger.log(`Reconnecting... (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`);
        }

        if (stopping) break;

        try {
          const newBackend = createRemoteBackend(relayUrl, machineId, identity, deviceCertificate);
          newBackend.setPtyOutputHandler((data) => {
            process.stdout.write(Buffer.from(data));
          });

          let attachSucceeded = false;
          try {
            await newBackend.connect();

            // Re-attach to the same tmux-lite session.
            const attachWait = waitForBackendEvent(
              newBackend,
              (event): event is Extract<BackendEvent, { type: 'attached' }> => event.type === 'attached',
              30000,
              'attach confirmation'
            );

            try {
              await newBackend.attachSession({
                sessionId: tmuxSessionId,
                cols,
                rows,
              });
            } catch (attachErr) {
              attachWait.cancel();
              throw attachErr;
            }

            // This can also throw (timeout or command_error) — caught below.
            await attachWait.promise;

            attachSucceeded = true;
          } finally {
            // Disconnect the new backend if anything above failed so we don't
            // leak open WebSocket connections across retry attempts.
            if (!attachSucceeded) {
              await newBackend.disconnect().catch(() => {});
            }
          }

          // Swap backend and wire stdin/resize to the new one.
          const oldUnsub = unsubEvents;
          currentBackend = newBackend;

          // Rewire the new backend's events.
          unsubEvents = newBackend.onEvent(handleBackendEvent);

          // Remove old unsub from handlers and add new one.
          const idx = handlers.indexOf(oldUnsub);
          if (idx !== -1) handlers.splice(idx, 1);
          handlers.push(unsubEvents);

          logger.log('Reconnected!');
          logger.log('');

          reconnecting = false;
          return;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          logger.log(`Reconnect attempt ${attempt} failed: ${detail}`);
          // Continue to next attempt
        }
      }

      // All attempts exhausted
      reconnecting = false;
      void stop('Failed to reconnect after multiple attempts');
    };

    // handleBackendEvent is declared as a var so it can be referenced before
    // unsubEvents is assigned.
    const handleBackendEvent = (event: BackendEvent) => {
      if (event.type === 'session_exited') {
        void stop(`Session exited${typeof event.exitCode === 'number' ? ` (${event.exitCode})` : ''}`);
      }

      if (event.type === 'detached') {
        void stop('Detached');
      }

      if (event.type === 'status' && event.status === 'disconnected') {
        void attemptReconnect();
      }

      if (event.type === 'error') {
        logger.error(`Connection error: ${event.message}`);
      }
    };

    let unsubEvents = initialBackend.onEvent(handleBackendEvent);
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

      currentBackend.writePtyData?.(new Uint8Array(data))?.catch((error: unknown) => {
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
        currentBackend.resizePty?.(cols, rows)?.catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to send PTY resize: ${detail}`);
        });
      };
      process.stdout.on('resize', onResize);
      handlers.push(() => process.stdout.removeListener('resize', onResize));

    // Send initial size
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      currentBackend.resizePty?.(cols, rows)?.catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to send initial PTY size: ${detail}`);
      });
  }

  // Handle SIGINT (Ctrl+C)
    const onSigInt = () => {
    // Forward Ctrl+C to remote instead of terminating
      currentBackend.writePtyData?.(new Uint8Array([0x03]))?.catch((error: unknown) => {
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
