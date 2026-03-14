/**
 * Relay registries for active machine tracking.
 *
 * In-memory state only; persisted state lives in control store.
 */

import type { ServerWebSocket } from "bun";
import type { WebSocketData } from "./types";

// ============================================================================
// Types
// ============================================================================

/** Registered machine information */
export interface MachineRegistration {
  /** Machine identity ID */
  machineId: string;
  /** Owner user-root ID used for anti-takeover checks */
  ownerUserRootId: string;
  /** Ed25519 signing public key (base64) */
  signingKey: string;
  /** X25519 key exchange public key (base64) */
  keyExchangeKey: string;
  /** Human-readable label */
  label?: string;
  /** WebSocket connection (null if offline) */
  ws: ServerWebSocket<WebSocketData> | null;
  /** When machine was registered */
  registeredAt: number;
  /** When machine last connected */
  lastConnectedAt: number;
  /**
   * Timestamp (ms) of the last application-level heartbeat (ping/pong)
   * received from this machine.  Updated on registration and on each pong.
   * Used by the stale-connection detector.
   */
  lastHeartbeatAt: number;
  /**
   * Whether the connection has been marked as potentially stale (first warning
   * threshold crossed) but the grace period has not expired yet.
   */
  staleWarned: boolean;
}

// ============================================================================
// Machine Registry
// ============================================================================

/** Registered machines by machineId */
const machines = new Map<string, MachineRegistration>();

/** Result of machine registration attempt */
export type RegisterMachineResult =
  | { success: true; registration: MachineRegistration }
  | { success: false; error: string };

/**
 * Register a machine.
 *
 * Security: Re-registration requires matching owner marker and signingKey
 * to prevent machine takeover attacks.
 */
export function registerMachine(
  machineId: string,
  ownerUserRootId: string,
  signingKey: string,
  keyExchangeKey: string,
  ws: ServerWebSocket<WebSocketData>,
  label?: string
): RegisterMachineResult {
  const now = Date.now();

  const existing = machines.get(machineId);
  if (existing) {
    if (existing.ownerUserRootId !== ownerUserRootId) {
      return {
        success: false,
        error: "Machine already registered by different owner",
      };
    }

    if (existing.signingKey !== signingKey) {
      return {
        success: false,
        error: "Signing key mismatch - machine identity has changed",
      };
    }

    existing.ws = ws;
    existing.lastConnectedAt = now;
    existing.lastHeartbeatAt = now;
    existing.staleWarned = false;
    if (label) existing.label = label;
    return { success: true, registration: existing };
  }

  const registration: MachineRegistration = {
    machineId,
    ownerUserRootId,
    signingKey,
    keyExchangeKey,
    label,
    ws,
    registeredAt: now,
    lastConnectedAt: now,
    lastHeartbeatAt: now,
    staleWarned: false,
  };

  machines.set(machineId, registration);
  return { success: true, registration };
}

/** Get a registered machine */
export function getMachine(machineId: string): MachineRegistration | undefined {
  return machines.get(machineId);
}

/** Check if a machine is registered */
export function hasMachine(machineId: string): boolean {
  return machines.has(machineId);
}

/** Check if a machine is online (connected) */
export function isMachineOnline(machineId: string): boolean {
  const machine = machines.get(machineId);
  return machine !== undefined && machine.ws !== null;
}

/** Update machine connection status */
export function setMachineConnection(
  machineId: string,
  ws: ServerWebSocket<WebSocketData> | null
): void {
  const machine = machines.get(machineId);
  if (machine) {
    machine.ws = ws;
    if (ws) {
      machine.lastConnectedAt = Date.now();
    }
  }
}

/** Unregister a machine */
export function unregisterMachine(machineId: string): boolean {
  return machines.delete(machineId);
}

/**
 * Record a heartbeat (application-level ping/pong) from a machine.
 * Also clears the stale-warned flag if the machine had been marked stale.
 */
export function updateMachineHeartbeat(machineId: string): void {
  const machine = machines.get(machineId);
  if (machine) {
    machine.lastHeartbeatAt = Date.now();
    machine.staleWarned = false;
  }
}

/**
 * Mark a machine as having received the first stale warning.
 * Called when the machine crosses the "stale" threshold but is still within
 * the grace period before a forced disconnect.
 */
export function markMachineStaleWarned(machineId: string): void {
  const machine = machines.get(machineId);
  if (machine) {
    machine.staleWarned = true;
  }
}

/** Get all registered machines */
export function getAllMachines(): MachineRegistration[] {
  return Array.from(machines.values());
}

// ============================================================================
// Stats
// ============================================================================

/** Get registry statistics */
export function getRegistryStats(): {
  machineCount: number;
  onlineMachineCount: number;
} {
  let onlineMachineCount = 0;
  for (const machine of machines.values()) {
    if (machine.ws !== null) onlineMachineCount += 1;
  }

  return {
    machineCount: machines.size,
    onlineMachineCount,
  };
}

/** Clear all registries (for testing) */
export function clearAllRegistries(): void {
  machines.clear();
}
