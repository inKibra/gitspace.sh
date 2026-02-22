/**
 * Serve daemon management
 *
 * Handles daemonization, PID/socket management, and status queries
 * for the `gssh machine serve` command group.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getSpacesDir } from '../core/config.js';
import { assertControlOwner, listCloudWorkspaces, readControlMeta } from '../relay/control/store.js';
import type { CloudWorkspaceRecord } from '../relay/control/types.js';

// ============================================================================
// File paths
// ============================================================================

/** Get serve daemon directory */
export function getServeDaemonDir(): string {
  return join(getSpacesDir(), '.serve');
}

/** Get serve PID file path */
export function getServePidFile(): string {
  return join(getServeDaemonDir(), 'serve.pid');
}

/** Get serve status socket path */
export function getServeSocketPath(): string {
  return join(getServeDaemonDir(), 'serve.sock');
}

/** Get serve log file path */
export function getServeLogFile(): string {
  return join(getServeDaemonDir(), 'serve.log');
}

/** Ensure daemon directory exists */
export function ensureServeDaemonDir(): void {
  const dir = getServeDaemonDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// PID Management
// ============================================================================

/**
 * Check if a process is running by PID
 */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get serve daemon PID from file
 * Returns null if not found or invalid
 */
export function getServePid(): number | null {
  const pidFile = getServePidFile();
  if (!existsSync(pidFile)) return null;

  try {
    const content = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(content, 10);
    if (isNaN(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

/**
 * Write serve PID file
 */
export function writeServePid(pid: number): void {
  ensureServeDaemonDir();
  writeFileSync(getServePidFile(), String(pid));
}

/**
 * Clean up serve daemon files
 */
export function cleanupServeFiles(): void {
  const pidFile = getServePidFile();
  const socketPath = getServeSocketPath();

  try { unlinkSync(pidFile); } catch {}
  try { unlinkSync(socketPath); } catch {}
}

/**
 * Check if serve daemon is running
 * Cleans up stale files if process is dead
 */
export function isServeRunning(): boolean {
  const pid = getServePid();
  if (pid === null) return false;

  if (isProcessRunning(pid)) {
    return true;
  }

  // Process is dead, clean up stale files
  cleanupServeFiles();
  return false;
}

// ============================================================================
// Status Socket Protocol
// ============================================================================

/** Status query message */
export interface StatusQuery {
  type: 'status';
}

/** Status response */
export interface StatusResponse {
  type: 'status';
  version: string;
  pid: number;
  uptime: number;
  relay: {
    url: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  };
  clients: number;
  hosting?: {
    subdomain: string;
    tunnelActive: boolean;
  };
}

/** Control messages */
export type ControlMessage =
  | { type: 'status' }
  | { type: 'shutdown' }
  | { type: 'control_meta' }
  | { type: 'assert_owner'; identityId: string }
  | { type: 'list_cloud_workspaces'; identityId: string };

/** Control response */
export type ControlResponse =
  | StatusResponse
  | {
      type: 'control_meta';
      ownerIdentityId?: string;
      relayIdentityId?: string;
      relaySigningPublicKey?: string;
      relayFingerprint?: string;
      schemaVersion: number;
      updatedAt: string;
    }
  | { type: 'cloud_workspaces'; workspaces: CloudWorkspaceRecord[] }
  | { type: 'ok' }
  | { type: 'error'; message: string };

// ============================================================================
// Daemon State (for status socket server)
// ============================================================================

/** Global daemon state - updated by serve and queried by status socket */
export interface DaemonState {
  version: string;
  startTime: number;
  relay: {
    url: string;
    status: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  };
  clients: number;
  hosting?: {
    subdomain: string;
    tunnelActive: boolean;
  };
}

/** Current daemon state - set by serve, read by status socket */
let daemonState: DaemonState | null = null;

export function setDaemonState(state: DaemonState): void {
  daemonState = state;
}

export function getDaemonState(): DaemonState | null {
  return daemonState;
}

export function updateDaemonState(updates: Partial<DaemonState>): void {
  if (daemonState) {
    Object.assign(daemonState, updates);
  }
}

// ============================================================================
// Status Socket Server
// ============================================================================

let statusServer: ReturnType<typeof Bun.listen> | null = null;

/**
 * Start the status socket server
 */
export function startStatusServer(): void {
  const socketPath = getServeSocketPath();

  // Clean up old socket
  try { unlinkSync(socketPath); } catch {}

  statusServer = Bun.listen({
    unix: socketPath,
    socket: {
      async data(socket, data) {
        try {
          const msg = JSON.parse(data.toString()) as ControlMessage;

          if (msg.type === 'status') {
            const state = getDaemonState();
            if (state) {
              const response: StatusResponse = {
                type: 'status',
                version: state.version,
                pid: process.pid,
                uptime: Math.floor((Date.now() - state.startTime) / 1000),
                relay: state.relay,
                clients: state.clients,
                hosting: state.hosting,
              };
              socket.write(JSON.stringify(response));
            } else {
              socket.write(JSON.stringify({ type: 'error', message: 'State not initialized' }));
            }
          } else if (msg.type === 'shutdown') {
            socket.write(JSON.stringify({ type: 'ok' }));
            socket.end();
            // Trigger graceful shutdown
            process.emit('SIGTERM');
          } else if (msg.type === 'control_meta') {
            const meta = readControlMeta();
            socket.write(JSON.stringify({
              type: 'control_meta',
              ownerIdentityId: meta.ownerIdentityId,
              relayIdentityId: meta.relayIdentityId,
              relaySigningPublicKey: meta.relaySigningPublicKey,
              relayFingerprint: meta.relayFingerprint,
              schemaVersion: meta.schemaVersion,
              updatedAt: meta.updatedAt,
            }));
          } else if (msg.type === 'assert_owner') {
            try {
              assertControlOwner(msg.identityId);
              socket.write(JSON.stringify({ type: 'ok' }));
            } catch (error) {
              socket.write(JSON.stringify({
                type: 'error',
                message: error instanceof Error ? error.message : 'Owner assertion failed',
              }));
            }
          } else if (msg.type === 'list_cloud_workspaces') {
            try {
              assertControlOwner(msg.identityId);
              const workspaces = listCloudWorkspaces();
              socket.write(JSON.stringify({
                type: 'cloud_workspaces',
                workspaces,
              }));
            } catch (error) {
              socket.write(JSON.stringify({
                type: 'error',
                message: error instanceof Error ? error.message : 'Failed to list cloud workspaces',
              }));
            }
          } else {
            socket.write(JSON.stringify({ type: 'error', message: 'Unknown command' }));
          }
        } catch (err) {
          socket.write(JSON.stringify({ type: 'error', message: 'Invalid message' }));
        }
        socket.end();
      },
      error(socket, error) {
        // Ignore socket errors
      },
    },
  });
}

/**
 * Stop the status socket server
 */
export function stopStatusServer(): void {
  if (statusServer) {
    statusServer.stop();
    statusServer = null;
  }
  try { unlinkSync(getServeSocketPath()); } catch {}
}

// ============================================================================
// Status Client (for querying running daemon)
// ============================================================================

/**
 * Query the running serve daemon for status
 */
export async function queryServeStatus(): Promise<StatusResponse | null> {
  const socketPath = getServeSocketPath();
  if (!existsSync(socketPath)) return null;

  return new Promise((resolve) => {
    const socket = Bun.connect({
      unix: socketPath,
      socket: {
        data(socket, data) {
          try {
            const response = JSON.parse(data.toString());
            if (response.type === 'status') {
              resolve(response as StatusResponse);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
        error() {
          resolve(null);
        },
        close() {
          // Handled by data or error
        },
        open(socket) {
          socket.write(JSON.stringify({ type: 'status' }));
        },
        connectError() {
          resolve(null);
        },
      },
    }).catch(() => {
      resolve(null);
    });

    // Timeout after 2 seconds
    setTimeout(() => resolve(null), 2000);
  });
}

/**
 * Send shutdown command to running daemon
 */
export async function sendShutdownCommand(): Promise<boolean> {
  const socketPath = getServeSocketPath();
  if (!existsSync(socketPath)) return false;

  return new Promise((resolve) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        data(socket, data) {
          try {
            const response = JSON.parse(data.toString());
            resolve(response.type === 'ok');
          } catch {
            resolve(false);
          }
        },
        error() {
          resolve(false);
        },
        open(socket) {
          socket.write(JSON.stringify({ type: 'shutdown' }));
        },
        connectError() {
          resolve(false);
        },
      },
    }).catch(() => {
      resolve(false);
    });

    // Timeout after 2 seconds
    setTimeout(() => resolve(false), 2000);
  });
}

/**
 * Query control relay metadata from running daemon
 */
export async function queryControlMeta(): Promise<{
  ownerIdentityId?: string;
  relayIdentityId?: string;
  relaySigningPublicKey?: string;
  relayFingerprint?: string;
  schemaVersion: number;
  updatedAt: string;
} | null> {
  const socketPath = getServeSocketPath();
  if (!existsSync(socketPath)) return null;

  return new Promise((resolve) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        data(socket, data) {
          try {
            const response = JSON.parse(data.toString()) as ControlResponse;
            if (response.type === 'control_meta') {
              resolve({
                ownerIdentityId: response.ownerIdentityId,
                relayIdentityId: response.relayIdentityId,
                relaySigningPublicKey: response.relaySigningPublicKey,
                relayFingerprint: response.relayFingerprint,
                schemaVersion: response.schemaVersion,
                updatedAt: response.updatedAt,
              });
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        },
        error() {
          resolve(null);
        },
        open(socket) {
          socket.write(JSON.stringify({ type: 'control_meta' }));
        },
        connectError() {
          resolve(null);
        },
      },
    }).catch(() => {
      resolve(null);
    });

    setTimeout(() => resolve(null), 2000);
  });
}

/**
 * Assert caller identity is the control relay owner
 */
export async function sendAssertOwnerCommand(identityId: string): Promise<{ success: boolean; error?: string }> {
  const socketPath = getServeSocketPath();
  if (!existsSync(socketPath)) return { success: false, error: 'Daemon not running' };

  return new Promise((resolve) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        data(socket, data) {
          try {
            const response = JSON.parse(data.toString()) as ControlResponse;
            if (response.type === 'ok') {
              resolve({ success: true });
            } else if (response.type === 'error') {
              resolve({ success: false, error: response.message });
            } else {
              resolve({ success: false, error: 'Unexpected response' });
            }
          } catch {
            resolve({ success: false, error: 'Invalid response' });
          }
        },
        error() {
          resolve({ success: false, error: 'Connection error' });
        },
        open(socket) {
          socket.write(JSON.stringify({ type: 'assert_owner', identityId }));
        },
        connectError() {
          resolve({ success: false, error: 'Could not connect to daemon' });
        },
      },
    }).catch(() => {
      resolve({ success: false, error: 'Connection failed' });
    });

    setTimeout(() => resolve({ success: false, error: 'Timeout' }), 5000);
  });
}

/**
 * List cloud workspaces from control relay store
 */
export async function sendListCloudWorkspacesCommand(identityId: string): Promise<{
  success: boolean;
  workspaces?: CloudWorkspaceRecord[];
  error?: string;
}> {
  const socketPath = getServeSocketPath();
  if (!existsSync(socketPath)) return { success: false, error: 'Daemon not running' };

  return new Promise((resolve) => {
    Bun.connect({
      unix: socketPath,
      socket: {
        data(socket, data) {
          try {
            const response = JSON.parse(data.toString()) as ControlResponse;
            if (response.type === 'cloud_workspaces') {
              resolve({ success: true, workspaces: response.workspaces });
            } else if (response.type === 'error') {
              resolve({ success: false, error: response.message });
            } else {
              resolve({ success: false, error: 'Unexpected response' });
            }
          } catch {
            resolve({ success: false, error: 'Invalid response' });
          }
        },
        error() {
          resolve({ success: false, error: 'Connection error' });
        },
        open(socket) {
          socket.write(JSON.stringify({ type: 'list_cloud_workspaces', identityId }));
        },
        connectError() {
          resolve({ success: false, error: 'Could not connect to daemon' });
        },
      },
    }).catch(() => {
      resolve({ success: false, error: 'Connection failed' });
    });

    setTimeout(() => resolve({ success: false, error: 'Timeout' }), 5000);
  });
}
