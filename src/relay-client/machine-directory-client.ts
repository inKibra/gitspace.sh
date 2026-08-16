/**
 * Shared relay machine-directory client.
 *
 * Handles list_machines, keepalive ping/pong, and normalized machine list state.
 * Used by both web and TUI remote machine browsing flows.
 */

import type { MachineInfo } from '../components/MachineList.js';

export type RelayStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RelaySocketHandlers {
  onOpen: () => void;
  onMessage: (raw: string) => void;
  onClose: () => void;
  onError: (error: Error) => void;
}

export interface RelaySocketAdapter<TSocket> {
  createSocket: (url: string) => TSocket;
  setHandlers: (socket: TSocket, handlers: RelaySocketHandlers) => void;
  clearHandlers?: (socket: TSocket) => void;
  send: (socket: TSocket, data: string) => void;
  close: (socket: TSocket) => void;
  getReadyState: (socket: TSocket) => number;
  getOpenReadyStateValue: () => number;
}

export type RelaySigner = <T extends object>(message: T) => T;

export interface RelayMachineDirectoryClientOptions<TSocket> {
  relayUrl: string;
  clientIdentityId: string;
  deviceCertificate: string;
  socketAdapter: RelaySocketAdapter<TSocket>;
  signer?: RelaySigner;
  pingIntervalMs?: number;
  onStatusChange?: (status: RelayStatus) => void;
  onMachineList?: (machines: MachineInfo[]) => void;
  onError?: (message: string) => void;
}

interface RelayMachineListMessage {
  type: 'machine_list';
  machines: Array<{
    machineId: string;
    label?: string;
    online: boolean;
    isAuthorized: boolean;
    lastConnectedAt?: number;
  }>;
}

interface RelayErrorMessage {
  type: 'error';
  message?: string;
}

type RelayIncomingMessage = RelayMachineListMessage | RelayErrorMessage | { type: 'pong' };

/**
 * Framework/runtime-agnostic relay client for machine directory listing.
 */
export class RelayMachineDirectoryClient<TSocket> {
  private readonly options: RelayMachineDirectoryClientOptions<TSocket>;
  private readonly pingIntervalMs: number;
  private readonly pongLivenessTimeoutMs: number;
  private socket: TSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private status: RelayStatus = 'disconnected';
  private machines: MachineInfo[] = [];
  private lastPongAtMs = 0;
  private manualDisconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 10;

  constructor(options: RelayMachineDirectoryClientOptions<TSocket>) {
    this.options = options;
    this.pingIntervalMs = options.pingIntervalMs ?? 15000;
    // Three missed pings (min 45s) ⇒ the relay connection is dead even if the
    // socket never emitted close (half-open TCP).
    this.pongLivenessTimeoutMs = Math.max(this.pingIntervalMs * 3, 45000);
  }

  getStatus(): RelayStatus {
    return this.status;
  }

  getMachines(): MachineInfo[] {
    return this.machines;
  }

  getSocket(): TSocket | null {
    return this.socket;
  }

  async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    this.manualDisconnect = false;
    this.cancelReconnect();
    this.setStatus('connecting');

    const url = new URL(this.options.relayUrl);
    url.searchParams.set('role', 'client');

    await new Promise<void>((resolve, reject) => {
      const socket = this.options.socketAdapter.createSocket(url.toString());
      this.socket = socket;

      let opened = false;

      this.options.socketAdapter.setHandlers(socket, {
        onOpen: () => {
          opened = true;
          this.startPing();
          this.requestMachineList();
          resolve();
        },
        onMessage: (raw) => {
          this.handleMessage(raw);
        },
        onClose: () => {
          this.stopPing();
          this.socket = null;
          this.setStatus('disconnected');
          // Unexpected close (liveness failure, relay restart): reconnect with
          // backoff so machine discovery doesn't silently stay stale.
          this.scheduleReconnect();
        },
        onError: (error) => {
          const message = error.message || 'Relay connection failed';
          this.emitError(message);
          this.setStatus('error');
          if (!opened) {
            reject(error);
          }
        },
      });
    });
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.cancelReconnect();
    this.stopPing();

    if (this.socket) {
      if (this.options.socketAdapter.clearHandlers) {
        this.options.socketAdapter.clearHandlers(this.socket);
      }
      this.options.socketAdapter.close(this.socket);
    }

    this.socket = null;
    this.machines = [];
    this.setStatus('disconnected');
    this.options.onMachineList?.([]);
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.reconnectTimer || this.socket) {
      return;
    }
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.emitError(`Relay directory connection lost (gave up after ${this.maxReconnectAttempts} reconnect attempts)`);
      this.setStatus('error');
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts - 1) + Math.random() * 1000, 30000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.manualDisconnect || this.socket) return;
      this.connect().catch(() => {
        // onError already surfaced the failure; schedule the next attempt.
        this.scheduleReconnect();
      });
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  refreshMachines(): void {
    this.requestMachineList();
  }

  private startPing(): void {
    this.stopPing();
    this.lastPongAtMs = Date.now();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (!socket) {
        return;
      }

      const openState = this.options.socketAdapter.getOpenReadyStateValue();
      if (this.options.socketAdapter.getReadyState(socket) !== openState) {
        return;
      }

      const sincePongMs = Date.now() - this.lastPongAtMs;
      if (sincePongMs > this.pongLivenessTimeoutMs) {
        // Half-open socket: no pong despite pings. Close it so the onClose
        // path (status + reconnect) runs instead of hanging silently.
        this.emitError(`Relay connection lost (no pong for ${Math.round(sincePongMs / 1000)}s)`);
        this.stopPing();
        this.options.socketAdapter.close(socket);
        return;
      }

      this.sendJson({ type: 'ping', timestamp: Date.now() });
    }, this.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private requestMachineList(): void {
    if (!this.options.deviceCertificate) {
      this.emitError('Device certificate is required for machine listing');
      return;
    }

    const baseMessage = {
      type: 'list_machines' as const,
      clientIdentityId: this.options.clientIdentityId,
      deviceCertificate: this.options.deviceCertificate,
    };

    const message = this.options.signer
      ? this.options.signer(baseMessage)
      : baseMessage;

    this.sendJson(message);
  }

  private sendJson(message: object): void {
    const socket = this.socket;
    if (!socket) {
      return;
    }

    const openState = this.options.socketAdapter.getOpenReadyStateValue();
    if (this.options.socketAdapter.getReadyState(socket) !== openState) {
      return;
    }

    this.options.socketAdapter.send(socket, JSON.stringify(message));
  }

  private handleMessage(raw: string): void {
    let msg: RelayIncomingMessage;

    try {
      msg = JSON.parse(raw) as RelayIncomingMessage;
    } catch {
      return;
    }

    if (msg.type === 'pong') {
      this.lastPongAtMs = Date.now();
      return;
    }

    if (msg.type === 'machine_list') {
      this.reconnectAttempts = 0;
      this.setStatus('connected');
      this.machines = msg.machines.map((machine) => ({
        machineId: machine.machineId,
        label: machine.label,
        online: machine.online,
        isAuthorized: machine.isAuthorized,
        lastConnectedAt: machine.lastConnectedAt,
      }));
      this.options.onMachineList?.(this.machines);
      return;
    }

    if (msg.type === 'error') {
      this.machines = [];
      this.options.onMachineList?.([]);
      this.emitError(msg.message || 'Relay error');
      this.setStatus('error');
      return;
    }

    // Unknown messages are intentionally ignored.
  }

  private setStatus(status: RelayStatus): void {
    if (this.status === status) {
      return;
    }

    this.status = status;
    this.options.onStatusChange?.(status);
  }

  private emitError(message: string): void {
    this.options.onError?.(message);
  }
}
