/**
 * RemoteMachineProvider - Remote Machine Access via Relay
 *
 * Implements MachineProvider interface for accessing remote machines
 * through the relay server with encrypted communication.
 */

import WebSocket from 'ws';
import type {
  MachineProvider,
  CreateSessionOptions,
  AttachSessionOptions,
} from './MachineProvider.js';
import type {
  MachineInfo,
  Project,
  Workspace,
  InboxItem,
  SessionStream,
} from '../types.js';

/**
 * Common WebSocket interface for both Node.js (ws package) and browser environments
 */
interface WebSocketLike {
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  readyState: number;
}

/**
 * Adapt the 'ws' package WebSocket to our common interface.
 * The 'ws' package uses EventEmitter-style on/off which matches our interface.
 */
function adaptWebSocket(ws: {
  send(data: string): void;
  close(): void;
  on(event: string, handler: (...args: unknown[]) => void): void;
  off(event: string, handler: (...args: unknown[]) => void): void;
  readyState: number;
}): WebSocketLike {
  return ws;
}

const OPEN = 1;

// ============================================================================
// Types
// ============================================================================

export interface RemoteMachineProviderConfig {
  relayUrl: string;
  /** Optional identity for the TUI client (generated if not provided) */
  clientIdentityId?: string;
  /** Machine ID to connect to (selected from list) */
  machineId?: string;
}

interface RelayMessage {
  type: string;
  [key: string]: unknown;
}

// ============================================================================
// Provider Implementation
// ============================================================================

export class RemoteMachineProvider implements MachineProvider {
  private ws: WebSocketLike | null = null;
  private config: RemoteMachineProviderConfig;
  private messageHandlers = new Map<string, (msg: RelayMessage) => void>();
  private messageQueue: RelayMessage[] = [];
  private connected = false;
  private machineId: string | null = null;

  constructor(config: RemoteMachineProviderConfig) {
    this.config = config;
    this.machineId = config.machineId ?? null;
  }

  /**
   * Connect to relay server
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.config.relayUrl);
      url.searchParams.set('role', 'client');
      // Note: Authentication is now via challenge-response, not URL tokens
      if (this.config.clientIdentityId) {
        url.searchParams.set('clientId', this.config.clientIdentityId);
      }

      const ws = adaptWebSocket(new WebSocket(url.toString()));
      this.ws = ws;

      ws.on('open', () => {
        this.connected = true;
        // Send any queued messages
        for (const msg of this.messageQueue) {
          this.send(msg);
        }
        this.messageQueue = [];
        resolve();
      });

      ws.on('message', (data: unknown) => {
        try {
          const dataStr = typeof data === 'string' ? data : String(data);
          const msg = JSON.parse(dataStr) as RelayMessage;
          this.handleMessage(msg);
        } catch (e) {
          console.error('Failed to parse relay message:', e);
        }
      });

      ws.on('error', (err: unknown) => {
        reject(err);
      });

      ws.on('close', () => {
        this.connected = false;
        this.ws = null;
      });
    });
  }

  /**
   * Send message to relay
   */
  private send(msg: RelayMessage): void {
    if (!this.connected || !this.ws) {
      this.messageQueue.push(msg);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  /**
   * Handle incoming relay message
   */
  private handleMessage(msg: RelayMessage): void {
    const handler = this.messageHandlers.get(msg.type);
    if (handler) {
      handler(msg);
    }
  }

  /**
   * Send request and wait for response
   */
  private async request<T>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    return new Promise((resolve, reject) => {
      const responseType = `${type}_response`;
      const errorType = `${type}_error`;

      const cleanup = () => {
        this.messageHandlers.delete(responseType);
        this.messageHandlers.delete(errorType);
      };

      this.messageHandlers.set(responseType, (msg) => {
        cleanup();
        resolve(msg as T);
      });

      this.messageHandlers.set(errorType, (msg) => {
        cleanup();
        reject(new Error((msg.message as string) || 'Request failed'));
      });

      // Also handle generic error
      this.messageHandlers.set('error', (msg) => {
        cleanup();
        reject(new Error((msg.message as string) || 'Request failed'));
      });

      this.send({
        type,
        machineId: this.machineId,
        ...payload,
      });
    });
  }

  /**
   * Set the target machine ID
   */
  setMachineId(machineId: string): void {
    this.machineId = machineId;
  }

  // ============================================================================
  // MachineProvider Interface
  // ============================================================================

  async getMachineInfo(): Promise<MachineInfo> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    const response = await this.request<{ machine: MachineInfo }>('get_machine_info', {
      machineId: this.machineId,
    });

    return response.machine;
  }

  async listProjects(): Promise<Project[]> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    const response = await this.request<{ projects: Project[] }>('list_projects');
    return response.projects;
  }

  async listWorkspaces(projectName: string): Promise<Workspace[]> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    const response = await this.request<{ workspaces: Workspace[] }>('list_workspaces', {
      projectName,
    });
    return response.workspaces;
  }

  async createSession(
    projectName: string,
    workspaceName: string,
    options?: CreateSessionOptions
  ): Promise<string> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    const response = await this.request<{ sessionId: string }>('create_session', {
      projectName,
      workspaceName,
      sessionName: options?.sessionName,
      shell: options?.shell,
    });
    return response.sessionId;
  }

  async attachSession(
    sessionId: string,
    options: AttachSessionOptions
  ): Promise<SessionStream> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    // Create a session stream that communicates over the relay
    const stream = new RemoteSessionStream(
      this.ws!,
      sessionId,
      this.machineId,
      options
    );

    await stream.attach();
    return stream;
  }

  async detachSession(sessionId: string): Promise<void> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    await this.request('detach_session', { sessionId });
  }

  async getInbox(): Promise<InboxItem[]> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    const response = await this.request<{ items: InboxItem[] }>('get_inbox');
    return response.items;
  }

  async markInboxRead(itemId: string): Promise<void> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    await this.request('mark_inbox_read', { itemId });
  }

  async clearInbox(): Promise<void> {
    if (!this.machineId) {
      throw new Error('No machine selected');
    }

    await this.request('clear_inbox');
  }

  dispose(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.messageHandlers.clear();
  }
}

// ============================================================================
// Remote Session Stream
// ============================================================================

class RemoteSessionStream implements SessionStream {
  private ws: WebSocketLike;
  private sessionId: string;
  private machineId: string;
  private options: AttachSessionOptions;
  private dataHandler: ((data: Uint8Array) => void) | null = null;
  private closeHandler: ((exitCode?: number) => void) | null = null;
  private messageListener: ((data: unknown) => void) | null = null;

  constructor(
    ws: WebSocketLike,
    sessionId: string,
    machineId: string,
    options: AttachSessionOptions
  ) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.machineId = machineId;
    this.options = options;
  }

  async attach(): Promise<void> {
    // Set up message listener for session data
    this.messageListener = (data: unknown) => {
      try {
        const dataStr = typeof data === 'string' ? data : String(data);
        const msg = JSON.parse(dataStr);
        if (msg.type === 'session_data' && msg.sessionId === this.sessionId) {
          if (this.dataHandler && msg.data) {
            const decoded = Buffer.from(msg.data, 'base64');
            this.dataHandler(new Uint8Array(decoded));
          }
        } else if (msg.type === 'session_closed' && msg.sessionId === this.sessionId) {
          if (this.closeHandler) {
            this.closeHandler(msg.exitCode);
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    this.ws.on('message', this.messageListener);

    // Send attach request
    this.ws.send(JSON.stringify({
      type: 'attach_session',
      machineId: this.machineId,
      sessionId: this.sessionId,
      cols: this.options.cols,
      rows: this.options.rows,
      force: this.options.force ?? false,
    }));
  }

  write(data: Uint8Array): void {
    const encoded = Buffer.from(data).toString('base64');
    this.ws.send(JSON.stringify({
      type: 'session_input',
      machineId: this.machineId,
      sessionId: this.sessionId,
      data: encoded,
    }));
  }

  resize(cols: number, rows: number): void {
    this.ws.send(JSON.stringify({
      type: 'session_resize',
      machineId: this.machineId,
      sessionId: this.sessionId,
      cols,
      rows,
    }));
  }

  detach(): void {
    this.ws.send(JSON.stringify({
      type: 'detach_session',
      machineId: this.machineId,
      sessionId: this.sessionId,
    }));
    this.cleanup();
  }

  close(): void {
    this.ws.send(JSON.stringify({
      type: 'close_session',
      machineId: this.machineId,
      sessionId: this.sessionId,
    }));
    this.cleanup();
  }

  onData(handler: (data: Uint8Array) => void): void {
    this.dataHandler = handler;
  }

  onClose(handler: (exitCode?: number) => void): void {
    this.closeHandler = handler;
  }

  private cleanup(): void {
    if (this.messageListener) {
      this.ws.off('message', this.messageListener);
      this.messageListener = null;
    }
    this.dataHandler = null;
    this.closeHandler = null;
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a RemoteMachineProvider connected to the relay
 */
export async function createRemoteMachineProvider(
  config: RemoteMachineProviderConfig
): Promise<RemoteMachineProvider> {
  const provider = new RemoteMachineProvider(config);
  await provider.connect();
  return provider;
}
