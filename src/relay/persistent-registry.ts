/**
 * Persistent Machine Registry
 *
 * Combines SQLite-backed vault_machines table with in-memory connection tracking.
 * Machine registrations survive relay restarts; WebSocket connections are transient.
 *
 * This module is intended to gradually replace the in-memory registries.ts
 * for machine registration. Invite and authorization registries remain in-memory
 * for now (Phase 4 will migrate authorization to vault_access_list).
 */

import type { ServerWebSocket } from 'bun';
import type { WebSocketData } from './types.js';
import type { VaultMachineRecord } from './control/types.js';
import {
  upsertVaultMachine,
  getVaultMachine,
  getVaultMachineBySigningKey,
  listVaultMachines,
  updateVaultMachineLastConnected,
  removeVaultMachine,
} from './control/store.js';

// ============================================================================
// Types
// ============================================================================

/** Combined persistent record + transient connection state */
export interface PersistentMachineRegistration {
  /** Persisted machine data from SQLite */
  record: VaultMachineRecord;
  /** WebSocket connection (null if offline) */
  ws: ServerWebSocket<WebSocketData> | null;
}

/** Result of machine registration attempt */
export type PersistentRegisterResult =
  | { success: true; registration: PersistentMachineRegistration }
  | { success: false; error: string };

// ============================================================================
// In-memory connection tracking
// ============================================================================

/** Active WebSocket connections by machineId */
const connections = new Map<string, ServerWebSocket<WebSocketData>>();

// ============================================================================
// Registration
// ============================================================================

/**
 * Register a machine — persists to SQLite + tracks WebSocket connection.
 *
 * Security: Re-registration requires matching ownerUserRootId and signingKey.
 */
export function registerPersistentMachine(
  machineId: string,
  ownerUserRootId: string,
  signingKey: string,
  keyExchangeKey: string,
  ws: ServerWebSocket<WebSocketData>,
  label?: string
): PersistentRegisterResult {
  const result = upsertVaultMachine({
    machineId,
    ownerUserRootId,
    signingKey,
    keyExchangeKey,
    label,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  // Track connection in memory
  connections.set(machineId, ws);

  return {
    success: true,
    registration: {
      record: result.record,
      ws,
    },
  };
}

// ============================================================================
// Queries
// ============================================================================

/**
 * Get a persistent machine registration (persisted + connection state).
 */
export function getPersistentMachine(
  machineId: string
): PersistentMachineRegistration | undefined {
  const record = getVaultMachine(machineId);
  if (!record) return undefined;

  return {
    record,
    ws: connections.get(machineId) ?? null,
  };
}

/**
 * Get a persistent machine by its signing key.
 */
export function getPersistentMachineBySigningKey(
  signingKey: string
): PersistentMachineRegistration | undefined {
  const record = getVaultMachineBySigningKey(signingKey);
  if (!record) return undefined;

  return {
    record,
    ws: connections.get(record.machineId) ?? null,
  };
}

/**
 * Check if a machine is registered (persisted).
 */
export function hasPersistentMachine(machineId: string): boolean {
  return getVaultMachine(machineId) !== undefined;
}

/**
 * Check if a machine is currently online (has active WebSocket).
 */
export function isPersistentMachineOnline(machineId: string): boolean {
  return connections.has(machineId);
}

/**
 * Get all persistent machines, optionally filtered by owner.
 */
export function getAllPersistentMachines(
  ownerUserRootId?: string
): PersistentMachineRegistration[] {
  const records = listVaultMachines(ownerUserRootId);
  return records.map((record) => ({
    record,
    ws: connections.get(record.machineId) ?? null,
  }));
}

/**
 * Get all machines for a specific owner.
 */
export function getPersistentMachinesForOwner(
  ownerUserRootId: string
): PersistentMachineRegistration[] {
  return getAllPersistentMachines(ownerUserRootId);
}

// ============================================================================
// Connection Management
// ============================================================================

/**
 * Update machine connection state.
 */
export function setPersistentMachineConnection(
  machineId: string,
  ws: ServerWebSocket<WebSocketData> | null
): void {
  if (ws) {
    connections.set(machineId, ws);
    updateVaultMachineLastConnected(machineId);
  } else {
    connections.delete(machineId);
  }
}

/**
 * Unregister a machine — removes from SQLite and clears connection.
 */
export function unregisterPersistentMachine(machineId: string): boolean {
  connections.delete(machineId);
  return removeVaultMachine(machineId);
}

// ============================================================================
// Stats
// ============================================================================

/**
 * Get persistent registry statistics.
 */
export function getPersistentRegistryStats(): {
  machineCount: number;
  onlineMachineCount: number;
} {
  const allMachines = listVaultMachines();
  return {
    machineCount: allMachines.length,
    onlineMachineCount: connections.size,
  };
}

// ============================================================================
// Testing Helpers
// ============================================================================

/**
 * Clear in-memory connections — FOR TESTING ONLY.
 * Does NOT clear persisted data (use separate test cleanup for SQLite).
 */
export function _clearConnections(): void {
  connections.clear();
}
