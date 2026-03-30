/**
 * Core SDK types — platform-neutral configuration for the GitSpace engine.
 *
 * The engine needs exactly five platform-specific adapters to bridge browser vs.
 * bun/node differences. Everything else (state management, relay discovery,
 * action routing) is shared.
 */

import type { BackendKey, SessionBackend } from '../../session/backend.js';
import type { Identity } from '../../types/identity.js';
import type { RelayDescriptor, RelaySocketAdapter, RelaySigner } from '../../relay-client/index.js';

// ─── Platform adapters ────────────────────────────────────────────────────────

/** Parameters passed to createRemoteBackend when a relay-discovered machine registers. */
export interface CreateRemoteBackendParams {
  relayUrl: string;
  identity: Identity;
  machineId: string;
  deviceCertificate: string;
  machineLabel?: string;
}

/**
 * Platform-specific adapters that differ between browser and bun/node.
 *
 * These are the only seams the SDK requires. Pre-built sets are available
 * via `browserPlatform()` and `bunPlatform()`.
 */
export interface PlatformAdapters {
  /**
   * Factory for the local session backend (e.g., Bun Unix socket → tmux-lite).
   * Pass `null` or omit to skip local backend (browser has no local backend).
   */
  createLocalBackend?: (() => SessionBackend) | null;

  /**
   * Factory for remote session backends discovered via relay.
   * Required when a relay is configured.
   */
  createRemoteBackend?: (params: CreateRemoteBackendParams) => {
    backendKey: BackendKey;
    backend: SessionBackend;
  };

  /**
   * WebSocket transport adapter for the relay directory client.
   * Required when a relay is configured.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  relaySocketAdapter?: RelaySocketAdapter<any>;

  /**
   * Creates a relay message signer from an identity.
   * Required when a relay is configured.
   */
  createRelaySigner?: (identity: Identity) => RelaySigner;

  /**
   * Produces a device certificate string from an identity.
   * Browser: reads from localStorage. Bun: signs via keychain.
   * Required when a relay is configured.
   */
  getDeviceCertificate?: (identity: Identity) => Promise<string>;
}

// ─── Engine configuration ─────────────────────────────────────────────────────

/**
 * Configuration for `GitSpaceEngine` and `GitSpace()`.
 *
 * ```ts
 * const gs = GitSpace({
 *   platform: bunPlatform(),
 *   relay: { url: 'wss://relay.gitspace.sh/ws' },
 *   identity: loadedIdentity,
 * });
 * ```
 */
export interface GitSpaceConfig {
  /** Platform-specific adapter bag. Use `browserPlatform()` or `bunPlatform()`. */
  platform: PlatformAdapters;

  /** Relay descriptor for remote machine discovery. Omit for local-only. */
  relay?: RelayDescriptor | null;

  /** Unlocked identity for relay auth and remote machine connections. */
  identity?: Identity | null;
}
