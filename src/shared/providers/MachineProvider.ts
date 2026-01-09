/**
 * MachineProvider Interface
 *
 * Abstraction for accessing machine resources (projects, workspaces, sessions).
 * Implementations include:
 * - LocalMachineProvider: Direct access to local machine
 * - RemoteMachineProvider: Access via encrypted relay connection
 */

import type {
  MachineInfo,
  Project,
  Workspace,
  InboxItem,
  SessionStream,
} from '../types.js';

/**
 * Options for creating a new session
 */
export interface CreateSessionOptions {
  /** Session name (user-friendly identifier) */
  sessionName?: string;
  /** Working directory for the session */
  cwd?: string;
  /** Shell to use (defaults to $SHELL or /bin/bash) */
  shell?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Initial terminal size */
  cols?: number;
  rows?: number;
}

/**
 * Options for attaching to an existing session
 */
export interface AttachSessionOptions {
  /** Terminal size */
  cols: number;
  rows: number;
  /** Client type for session tracking */
  clientType?: 'cli' | 'web';
  /** Force attach (detach other clients) */
  force?: boolean;
}

/**
 * MachineProvider interface
 *
 * Provides a unified API for accessing machine resources,
 * whether local or remote.
 *
 * @example
 * ```typescript
 * // Local machine
 * const local = new LocalMachineProvider();
 * const projects = await local.listProjects();
 *
 * // Remote machine
 * const remote = new RemoteMachineProvider(relayClient, machineId);
 * const workspaces = await remote.listWorkspaces('my-project');
 * ```
 */
export interface MachineProvider {
  /**
   * Get information about this machine
   */
  getMachineInfo(): Promise<MachineInfo>;

  /**
   * List all projects on this machine
   */
  listProjects(): Promise<Project[]>;

  /**
   * List workspaces for a project
   *
   * @param projectName - Name of the project
   */
  listWorkspaces(projectName: string): Promise<Workspace[]>;

  /**
   * Create a new session in a workspace
   *
   * @param projectName - Name of the project
   * @param workspaceName - Name of the workspace
   * @param options - Session creation options
   * @returns Session ID of the created session
   */
  createSession(
    projectName: string,
    workspaceName: string,
    options?: CreateSessionOptions
  ): Promise<string>;

  /**
   * Attach to an existing session
   *
   * @param sessionId - ID of the session to attach to
   * @param options - Attachment options
   * @returns Stream for terminal I/O
   */
  attachSession(
    sessionId: string,
    options: AttachSessionOptions
  ): Promise<SessionStream>;

  /**
   * Detach from a session
   *
   * @param sessionId - ID of the session to detach from
   */
  detachSession(sessionId: string): Promise<void>;

  /**
   * Get inbox notifications
   */
  getInbox(): Promise<InboxItem[]>;

  /**
   * Mark inbox item as read
   *
   * @param itemId - ID of the inbox item
   */
  markInboxRead(itemId: string): Promise<void>;

  /**
   * Clear all inbox items
   */
  clearInbox(): Promise<void>;

  /**
   * Dispose of the provider and clean up resources
   */
  dispose(): void;
}

/**
 * Events emitted by MachineProvider
 */
export type MachineProviderEvent =
  | { type: 'connected' }
  | { type: 'disconnected'; reason: string }
  | { type: 'error'; error: Error }
  | { type: 'inbox_updated'; items: InboxItem[] }
  | { type: 'session_updated'; sessionId: string };

/**
 * Event handler for MachineProvider events
 */
export type MachineProviderEventHandler = (event: MachineProviderEvent) => void;

/**
 * Extended MachineProvider with event support
 */
export interface EventedMachineProvider extends MachineProvider {
  /**
   * Subscribe to provider events
   *
   * @param handler - Event handler
   * @returns Unsubscribe function
   */
  onEvent(handler: MachineProviderEventHandler): () => void;
}
