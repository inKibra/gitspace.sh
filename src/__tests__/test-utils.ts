/**
 * Test Utilities for Type-Safe Mocking
 *
 * Provides type-safe mock factories and type guards for testing.
 * Avoids the need for `as any` casts in test files.
 */

import type {
  ProcessResult,
  HandshakeMessage,
  EstablishedSession,
} from "../lib/tmux-lite/handshake-handler.js";

// ============================================================================
// WebSocket Mocks
// ============================================================================

/**
 * WebSocket data interface used by the relay server
 */
export interface WebSocketData {
  machineId: string;
  role: "machine" | "client";
  connectionId: string;
  accountId: string;
  clientIdentityId?: string;
}

/**
 * Mock WebSocket configuration
 */
export interface MockWebSocketConfig {
  data?: Partial<WebSocketData>;
  sendMock?: (data: string) => void;
  closeMock?: (code?: number, reason?: string) => void;
}

/**
 * Type-safe mock WebSocket interface
 */
export interface MockWebSocket {
  data: WebSocketData;
  send: MockFn<[string], void>;
  close: MockFn<[number?, string?], void>;
  readyState: number;
}

/**
 * Mock function type with call tracking
 */
interface MockFn<Args extends unknown[] = unknown[], Return = void> {
  (...args: Args): Return;
  calls: Args[];
  callCount: number;
}

/**
 * Create a mock function that tracks calls
 */
function createMockFn<Args extends unknown[] = unknown[], Return = void>(
  impl?: (...args: Args) => Return
): MockFn<Args, Return> {
  const calls: Args[] = [];
  const fn = ((...args: Args) => {
    calls.push(args);
    return impl?.(...args) as Return;
  }) as MockFn<Args, Return>;
  fn.calls = calls;
  Object.defineProperty(fn, "callCount", {
    get() {
      return calls.length;
    },
  });
  return fn;
}

/**
 * Create a type-safe mock WebSocket for testing
 *
 * @example
 * const mockWs = createMockWebSocket({
 *   data: { machineId: "test-machine", role: "machine" },
 * });
 * expect(mockWs.send.callCount).toBe(0);
 */
export function createMockWebSocket(config: MockWebSocketConfig = {}): MockWebSocket {
  return {
    data: {
      machineId: config.data?.machineId ?? "test-machine",
      role: config.data?.role ?? "machine",
      connectionId: config.data?.connectionId ?? "conn-1",
      accountId: config.data?.accountId ?? "test-account",
      clientIdentityId: config.data?.clientIdentityId,
    },
    send: createMockFn<[string], void>(config.sendMock),
    close: createMockFn<[number?, string?], void>(config.closeMock),
    readyState: 1, // OPEN
  };
}

/**
 * Cast a mock WebSocket to any type for use with functions that expect
 * specific WebSocket types (like ServerWebSocket<WebSocketData>).
 *
 * This is a deliberate type assertion for testing purposes - the mock
 * implements the minimal interface needed for the tests.
 *
 * @example
 * const mockWs = asMockWs(createMockWebSocket({ data: { machineId: "test" } }));
 * registerMachine("id", "account", "key", "kxKey", mockWs);
 */
export function asMockWs<T>(mock: MockWebSocket): T {
  return mock as unknown as T;
}

// ============================================================================
// Handler Result Type Guards
// ============================================================================

// Re-export types from handshake-handler for convenience
export type { ProcessResult, HandshakeMessage, EstablishedSession };

/** Reply result from handshake processing */
export type ReplyResult = Extract<ProcessResult, { type: "reply" }>;

/** Established result from handshake processing */
export type EstablishedResult = Extract<ProcessResult, { type: "established" }>;

/** Error result from handshake processing */
export type ErrorResult = Extract<ProcessResult, { type: "error" }>;

/**
 * Type guard for reply results
 */
export function isReplyResult(result: ProcessResult): result is ReplyResult {
  return result.type === "reply";
}

/**
 * Type guard for established results
 */
export function isEstablishedResult(result: ProcessResult): result is EstablishedResult {
  return result.type === "established";
}

/**
 * Type guard for error results
 */
export function isErrorResult(result: ProcessResult): result is ErrorResult {
  return result.type === "error";
}

/**
 * Extract message data from a reply result with proper typing
 */
export function getReplyData<T>(result: ProcessResult): T {
  if (!isReplyResult(result)) {
    throw new Error(`Expected reply result, got: ${result.type}`);
  }
  return result.message.data as T;
}

/**
 * Get error reason from an error result
 */
export function getErrorReason(result: ProcessResult): string {
  if (!isErrorResult(result)) {
    throw new Error(`Expected error result, got: ${result.type}`);
  }
  return result.reason;
}

// ============================================================================
// Object Utilities
// ============================================================================

/**
 * Create a copy of an object with specific properties omitted.
 * Safer alternative to `delete (obj as any).prop`.
 *
 * @example
 * const authWithoutSignature = omit(clientAuth, 'identitySignature');
 */
export function omit<T extends object, K extends keyof T>(
  obj: T,
  ...keys: K[]
): Omit<T, K> {
  const result = { ...obj };
  for (const key of keys) {
    delete result[key];
  }
  return result;
}

/**
 * Create a copy of an object with only specific properties included.
 *
 * @example
 * const minimalAuth = pick(clientAuth, 'version', 'identityKey');
 */
export function pick<T extends object, K extends keyof T>(
  obj: T,
  ...keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in obj) {
      result[key] = obj[key];
    }
  }
  return result;
}

// ============================================================================
// Private Property Access for Testing
// ============================================================================

/**
 * Interface for accessing RelayClient internal state in tests.
 * This should only be used for test verification, not production code.
 */
export interface RelayClientTestAccess {
  readKey: Buffer | null;
  writeKey: Buffer | null;
  handshakeState: unknown;
  sessionKeys: unknown;
  peerIdentityId: string | null;
}

/**
 * Get test access to RelayClient private properties.
 * This uses a type assertion to access private fields for testing verification.
 *
 * @example
 * const testAccess = getRelayClientTestAccess(client);
 * expect(testAccess.writeKey).toBeDefined();
 */
export function getRelayClientTestAccess(client: object): RelayClientTestAccess {
  // This is a deliberate type assertion for test purposes
  // RelayClient has private properties that we need to verify in tests
  const internal = client as {
    readKey: Buffer | null;
    writeKey: Buffer | null;
    handshakeState: unknown;
    sessionKeys: unknown;
    peerIdentityId: string | null;
  };
  return {
    readKey: internal.readKey,
    writeKey: internal.writeKey,
    handshakeState: internal.handshakeState,
    sessionKeys: internal.sessionKeys,
    peerIdentityId: internal.peerIdentityId,
  };
}

// ============================================================================
// Assertion Helpers
// ============================================================================

/**
 * Assert that a value is defined (not null or undefined)
 */
export function assertDefined<T>(
  value: T | null | undefined,
  message = "Expected value to be defined"
): asserts value is T {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
}

/**
 * Assert that a result is a reply type
 */
export function assertReply(result: ProcessResult): asserts result is ReplyResult {
  if (!isReplyResult(result)) {
    throw new Error(`Expected reply result, got: ${result.type}`);
  }
}

/**
 * Assert that a result is an established type
 */
export function assertEstablished(result: ProcessResult): asserts result is EstablishedResult {
  if (!isEstablishedResult(result)) {
    throw new Error(`Expected established result, got: ${result.type}`);
  }
}

/**
 * Assert that a result is an error type
 */
export function assertError(result: ProcessResult): asserts result is ErrorResult {
  if (!isErrorResult(result)) {
    throw new Error(`Expected error result, got: ${result.type}`);
  }
}
