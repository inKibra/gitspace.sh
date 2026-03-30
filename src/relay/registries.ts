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
  /** Last observed message or keepalive from this machine */
  lastSeenAt: number;
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
    lastSeenAt: now,
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
      const now = Date.now();
      machine.lastConnectedAt = now;
      machine.lastSeenAt = now;
    }
  }
}

/** Update machine liveness without changing the socket reference */
export function markMachineSeen(machineId: string): void {
  const machine = machines.get(machineId);
  if (machine) {
    machine.lastSeenAt = Date.now();
  }
}

/** Unregister a machine */
export function unregisterMachine(machineId: string): boolean {
  return machines.delete(machineId);
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
