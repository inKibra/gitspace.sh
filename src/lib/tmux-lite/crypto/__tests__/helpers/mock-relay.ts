/**
 * Mock relay for testing handshake flows
 *
 * This provides an in-memory message router that simulates the relay server.
 * Messages are delivered synchronously for easy testing.
 *
 * The mock relay:
 * - Routes messages between "client" and "machine" endpoints
 * - Allows inspection of message history
 * - Supports multiple concurrent connections
 * - Can simulate delays and failures for error testing
 */

import type { HandshakeMessage } from "../../../handshake-handler.js";

/**
 * Message record for history tracking
 */
export interface MessageRecord {
  /** When message was sent */
  timestamp: number;
  /** Sender endpoint */
  from: "client" | "machine";
  /** Receiver endpoint */
  to: "client" | "machine";
  /** Connection ID */
  connectionId: string;
  /** Message content */
  message: HandshakeMessage;
}

/**
 * Message handler callback
 */
export type MessageHandler = (
  connectionId: string,
  message: HandshakeMessage
) => HandshakeMessage | undefined | Promise<HandshakeMessage | undefined> | void;

/**
 * Mock relay options
 */
export interface MockRelayOptions {
  /** Simulate network delay in milliseconds */
  latencyMs?: number;
  /** Drop messages randomly (0-1 probability) */
  dropRate?: number;
  /** Tamper with messages (for security testing) */
  tamperFn?: (message: HandshakeMessage) => HandshakeMessage;
}

/**
 * Mock relay for testing handshake flows
 *
 * @example
 * ```typescript
 * const relay = new MockRelay();
 *
 * relay.onClientMessage(async (connId, msg) => {
 *   // Process on machine side
 *   const result = await handler.processMessage(connId, msg);
 *   if (result.type === "reply") return result.message;
 * });
 *
 * // Send ClientHello
 * const response = await relay.sendFromClient("conn-1", clientHelloMessage);
 * ```
 */
export class MockRelay {
  private messageHistory: MessageRecord[] = [];
  private clientHandler: MessageHandler | null = null;
  private machineHandler: MessageHandler | null = null;
  private options: MockRelayOptions;
  private connectionIdCounter = 0;

  constructor(options: MockRelayOptions = {}) {
    this.options = options;
  }

  /**
   * Register handler for messages arriving at the machine
   */
  onClientMessage(handler: MessageHandler): void {
    this.clientHandler = handler;
  }

  /**
   * Register handler for messages arriving at the client
   */
  onMachineMessage(handler: MessageHandler): void {
    this.machineHandler = handler;
  }

  /**
   * Send a message from client to machine
   *
   * @param connectionId - Connection identifier
   * @param message - Handshake message to send
   * @returns Response from machine (if any)
   */
  async sendFromClient(
    connectionId: string,
    message: HandshakeMessage
  ): Promise<HandshakeMessage | undefined> {
    // Record outgoing message
    this.recordMessage("client", "machine", connectionId, message);

    // Apply tampering if configured
    const finalMessage = this.options.tamperFn
      ? this.options.tamperFn(message)
      : message;

    // Simulate latency
    if (this.options.latencyMs) {
      await this.delay(this.options.latencyMs);
    }

    // Check for drop
    if (this.options.dropRate && Math.random() < this.options.dropRate) {
      return undefined;
    }

    // Deliver to machine handler
    if (!this.clientHandler) {
      throw new Error("No machine handler registered");
    }

    const response = await this.clientHandler(connectionId, finalMessage);

    if (response) {
      this.recordMessage("machine", "client", connectionId, response);
    }

    return response ?? undefined;
  }

  /**
   * Send a message from machine to client
   *
   * @param connectionId - Connection identifier
   * @param message - Handshake message to send
   * @returns Response from client (if any)
   */
  async sendFromMachine(
    connectionId: string,
    message: HandshakeMessage
  ): Promise<HandshakeMessage | undefined> {
    // Record outgoing message
    this.recordMessage("machine", "client", connectionId, message);

    // Apply tampering if configured
    const finalMessage = this.options.tamperFn
      ? this.options.tamperFn(message)
      : message;

    // Simulate latency
    if (this.options.latencyMs) {
      await this.delay(this.options.latencyMs);
    }

    // Check for drop
    if (this.options.dropRate && Math.random() < this.options.dropRate) {
      return undefined;
    }

    // Deliver to client handler
    if (!this.machineHandler) {
      throw new Error("No client handler registered");
    }

    const response = await this.machineHandler(connectionId, finalMessage);

    if (response) {
      this.recordMessage("client", "machine", connectionId, response);
    }

    return response ?? undefined;
  }

  /**
   * Generate a unique connection ID
   */
  generateConnectionId(): string {
    this.connectionIdCounter++;
    return `conn-${this.connectionIdCounter}`;
  }

  /**
   * Get message history
   *
   * @param connectionId - Optional filter by connection ID
   * @returns Array of message records
   */
  getMessageHistory(connectionId?: string): MessageRecord[] {
    if (connectionId) {
      return this.messageHistory.filter((m) => m.connectionId === connectionId);
    }
    return [...this.messageHistory];
  }

  /**
   * Get messages by phase
   *
   * @param phase - Handshake phase to filter by
   * @returns Array of message records with that phase
   */
  getMessagesByPhase(
    phase: HandshakeMessage["phase"]
  ): MessageRecord[] {
    return this.messageHistory.filter((m) => m.message.phase === phase);
  }

  /**
   * Clear message history
   */
  clearHistory(): void {
    this.messageHistory = [];
  }

  /**
   * Reset the relay (clear handlers and history)
   */
  reset(): void {
    this.clientHandler = null;
    this.machineHandler = null;
    this.messageHistory = [];
    this.connectionIdCounter = 0;
  }

  private recordMessage(
    from: "client" | "machine",
    to: "client" | "machine",
    connectionId: string,
    message: HandshakeMessage
  ): void {
    this.messageHistory.push({
      timestamp: Date.now(),
      from,
      to,
      connectionId,
      message,
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a mock relay with default settings
 */
export function createMockRelay(options?: MockRelayOptions): MockRelay {
  return new MockRelay(options);
}

/**
 * Create a message tampering function for security tests
 *
 * @param modifications - Fields to modify in the message data
 * @returns Tamper function
 */
export function createTamperFn(
  modifications: Record<string, unknown>
): (msg: HandshakeMessage) => HandshakeMessage {
  return (msg: HandshakeMessage) => ({
    ...msg,
    data: {
      ...(msg.data as Record<string, unknown>),
      ...modifications,
    },
  });
}

/**
 * Create a message that replays with a stale timestamp
 *
 * @param staleByMs - How stale the timestamp should be (default: 10 minutes)
 * @returns Tamper function
 */
export function createStaleTimestampTamperFn(
  staleByMs = 10 * 60 * 1000
): (msg: HandshakeMessage) => HandshakeMessage {
  return (msg: HandshakeMessage) => ({
    ...msg,
    data: {
      ...(msg.data as Record<string, unknown>),
      timestamp: Date.now() - staleByMs,
    },
  });
}
