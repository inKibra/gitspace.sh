/**
 * Connect command implementation
 *
 * Handles 'gssh client connect <target>' to connect to a remote machine
 * via relay + machine ACL authorization, or lists available machines
 * when no target is provided.
 */

import { logger } from '../utils/logger.js';
import { promptPassword, promptConfirm, promptInput, selectOne } from '../utils/prompts.js';
import { loadKeypair, keypairExists, readRelayConfig } from '../core/identity.js';
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
  NoIdentityError,
  SpacesError,
} from '../types/errors.js';
import type {
  WorkspaceInfo,
} from '../lib/remote-session/protocol.js';

/**
 * Connect to a remote machine using relay + machine ACL authorization.
 *
 * @param target - Machine ID
 * @param options - Command options
 */
export async function connectToRemote(
  target?: string,
  options: { relay?: string; machine?: string } = {}
): Promise<void> {
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
  logger.log('  Access:      Full access (relay + machine ACL required)');
  logger.log(`  Relay:       ${relayUrl}`);
  logger.log('');

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

  const deviceCertificate = await createLocalDeviceCertificate(identity);

  logger.info('Connecting to relay...');

  const socketUrl = new URL(relayUrl);
  socketUrl.searchParams.set('role', 'client');

  const backendKey = buildRemoteBackendKey(relayUrl, machineId);
  const backend = new RemoteSessionBackend({
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

    await startTerminalSession(backend);
    backendConnected = false;
  } finally {
    await disconnectBackend();
  }
}

export async function listRemoteMachines(options: {
  relay?: string;
  json?: boolean;
}): Promise<void> {
  if (!options.relay) {
    throw new SpacesError('Relay URL is required. Use --relay <url>.', 'USER_ERROR', 1);
  }

  if (!keypairExists()) {
    throw new NoIdentityError();
  }

  const password = await promptPassword('Enter password to unlock identity:');
  if (!password) {
    logger.info('Cancelled');
    return;
  }

  const identity = await loadKeypair(password);
  const deviceCertificate = await createLocalDeviceCertificate(identity);
  const signer = createNodeRelaySigner(identity);

  const relayUrl = options.relay;
  const socketUrl = new URL(relayUrl);
  socketUrl.searchParams.set('role', 'client');

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
    const ws = new WebSocket(socketUrl.toString());
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for machine list'));
    }, 15000);

    ws.onopen = () => {
      const message = signer({
        type: 'list_machines' as const,
        clientIdentityId: identity.id,
        deviceCertificate,
      });
      ws.send(JSON.stringify(message));
    };

    ws.onerror = (error) => {
      clearTimeout(timeout);
      reject(new Error(error.message || 'WebSocket connection failed'));
    };

    ws.onmessage = (event) => {
      try {
        const text = typeof event.data === 'string'
          ? event.data
          : new TextDecoder().decode(event.data as ArrayBuffer);
        const msg = JSON.parse(text) as { type?: string; machines?: MachineRow[]; message?: string };

        if (msg.type === 'error') {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(msg.message || 'Relay returned an error'));
          return;
        }

        if (msg.type === 'machine_list') {
          clearTimeout(timeout);
          ws.close();
          resolve(Array.isArray(msg.machines) ? msg.machines : []);
        }
      } catch (error) {
        clearTimeout(timeout);
        ws.close();
        reject(error);
      }
    };
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
