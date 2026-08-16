/**
 * Relay connection descriptor — "which relay to connect to."
 * Passed from the CLI into useMultiBackends to enable auto-discovery.
 * Distinct from RelayEnrollment (persisted machine-side enrollment in relay.json)
 * and RelayServerConfig (relay server startup config).
 */
export interface RelayDescriptor {
  /** WebSocket URL of the relay */
  url: string;
  /** Human-readable label for this relay */
  label?: string;
  /** How this relay was discovered */
  source?: 'account' | 'cached' | 'local' | 'explicit';
  /** True when auto-connected without explicit user action */
  autoConnected?: boolean;
}

export type {
  RelayStatus,
  RelaySocketAdapter,
  RelaySocketHandlers,
  RelaySigner,
  RelayMachineDirectoryClientOptions,
} from './machine-directory-client.js';

export { RelayMachineDirectoryClient } from './machine-directory-client.js';

export type {
  NodeRelaySocket,
} from './adapters/node.js';

export {
  nodeRelaySocketAdapter,
} from './adapters/node.js';

export type {
  BrowserRelaySocket,
} from './adapters/browser.js';

export {
  browserRelaySocketAdapter,
} from './adapters/browser.js';

export type {
  RelayRequestClientOptions,
} from './request-client.js';

export {
  RelayRequestError,
  RelayRequestClient,
} from './request-client.js';

export type {
  RelayTrustResult,
  PublicIdentity,
  MachineSessionBridge,
  UnlockGrantResponse,
} from './machine-relay-client.js';

export {
  requestUnlockGrantViaRelay,
  connectMachineRelay,
} from './machine-relay-client.js';

export type {
  MachineDirectoryClientConfig,
  UseMachineDirectoryOptions,
  UseMachineDirectoryReturn,
} from './useMachineDirectory.js';

export { useMachineDirectory } from './useMachineDirectory.js';
