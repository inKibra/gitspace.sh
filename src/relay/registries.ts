/**
 * Relay registries for machine, invite, and authorization tracking
 *
 * In-memory storage for v1. State is lost on restart.
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
  /** Account that registered this machine */
  accountId: string;
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
}

/** Registered invite information */
export interface InviteRegistration {
  /** Invite ID (hash of token or random) */
  inviteId: string;
  /** Machine this invite is for */
  machineId: string;
  /** When invite expires */
  expiresAt: number;
  /** Max number of uses (null = unlimited) */
  maxUses: number | null;
  /** Number of times invite has been used */
  usedCount: number;
  /** When invite was registered */
  registeredAt: number;
}

/** Client authorization for a machine */
export interface ClientAuthorization {
  /** Client's identity ID */
  clientIdentityId: string;
  /** Client's signing public key (base64) */
  signingKey: string;
  /** Client's key exchange public key (base64) */
  keyExchangeKey: string;
  /** Access type: 'full' or 'session-invite' */
  accessType: 'full' | 'session-invite';
  /** For session-invite: specific session ID */
  sessionId?: string;
  /** When authorization was granted */
  grantedAt: number;
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
 * Register a machine
 *
 * Security: Re-registration requires matching accountId and signingKey
 * to prevent machine takeover attacks.
 */
export function registerMachine(
  machineId: string,
  accountId: string,
  signingKey: string,
  keyExchangeKey: string,
  ws: ServerWebSocket<WebSocketData>,
  label?: string
): RegisterMachineResult {
  const now = Date.now();

  // Check if already registered
  const existing = machines.get(machineId);
  if (existing) {
    // Security: Verify ownership - must be same account
    if (existing.accountId !== accountId) {
      return {
        success: false,
        error: "Machine already registered by different account",
      };
    }

    // Security: Verify signing key matches - prevents key substitution attacks
    if (existing.signingKey !== signingKey) {
      return {
        success: false,
        error: "Signing key mismatch - machine identity has changed",
      };
    }

    // Safe to update connection
    existing.ws = ws;
    existing.lastConnectedAt = now;
    if (label) existing.label = label;
    return { success: true, registration: existing };
  }

  const registration: MachineRegistration = {
    machineId,
    accountId,
    signingKey,
    keyExchangeKey,
    label,
    ws,
    registeredAt: now,
    lastConnectedAt: now,
  };

  machines.set(machineId, registration);
  return { success: true, registration };
}

/**
 * Get a registered machine
 */
export function getMachine(machineId: string): MachineRegistration | undefined {
  return machines.get(machineId);
}

/**
 * Check if a machine is registered
 */
export function hasMachine(machineId: string): boolean {
  return machines.has(machineId);
}

/**
 * Check if a machine is online (connected)
 */
export function isMachineOnline(machineId: string): boolean {
  const machine = machines.get(machineId);
  return machine !== undefined && machine.ws !== null;
}

/**
 * Update machine connection status
 */
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

/**
 * Unregister a machine
 */
export function unregisterMachine(machineId: string): boolean {
  return machines.delete(machineId);
}

/**
 * Get all registered machines
 */
export function getAllMachines(): MachineRegistration[] {
  return Array.from(machines.values());
}

// ============================================================================
// Invite Registry
// ============================================================================

/** Registered invites by inviteId */
const invites = new Map<string, InviteRegistration>();

/**
 * Register an invite
 */
export function registerInvite(
  inviteId: string,
  machineId: string,
  expiresAt: number,
  maxUses: number | null = null
): InviteRegistration {
  const registration: InviteRegistration = {
    inviteId,
    machineId,
    expiresAt,
    maxUses,
    usedCount: 0,
    registeredAt: Date.now(),
  };

  invites.set(inviteId, registration);
  return registration;
}

/**
 * Get an invite registration
 */
export function getInvite(inviteId: string): InviteRegistration | undefined {
  return invites.get(inviteId);
}

/**
 * Check if an invite is valid (exists, not expired, not exhausted)
 */
export function isInviteValid(inviteId: string): boolean {
  const invite = invites.get(inviteId);
  if (!invite) return false;
  if (Date.now() > invite.expiresAt) return false;
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) return false;
  return true;
}

/**
 * Use an invite (increment use count)
 */
export function useInvite(inviteId: string): boolean {
  const invite = invites.get(inviteId);
  if (!invite) return false;

  invite.usedCount++;

  // Remove if exhausted
  if (invite.maxUses !== null && invite.usedCount >= invite.maxUses) {
    invites.delete(inviteId);
  }

  return true;
}

/**
 * Revoke an invite
 */
export function revokeInvite(inviteId: string): boolean {
  return invites.delete(inviteId);
}

/**
 * Get invites for a machine
 */
export function getInvitesForMachine(machineId: string): InviteRegistration[] {
  return Array.from(invites.values()).filter(inv => inv.machineId === machineId);
}

/**
 * Clean up expired invites
 */
export function cleanupExpiredInvites(): number {
  const now = Date.now();
  let removed = 0;

  for (const [id, invite] of invites) {
    if (now > invite.expiresAt) {
      invites.delete(id);
      removed++;
    }
  }

  return removed;
}

// ============================================================================
// Authorization Registry
// ============================================================================

/** Client authorizations by machineId */
const authorizations = new Map<string, Map<string, ClientAuthorization>>();

/**
 * Authorize a client for a machine
 */
export function authorizeClient(
  machineId: string,
  clientIdentityId: string,
  signingKey: string,
  keyExchangeKey: string,
  accessType: 'full' | 'session-invite',
  sessionId?: string
): ClientAuthorization {
  let machineAuths = authorizations.get(machineId);
  if (!machineAuths) {
    machineAuths = new Map();
    authorizations.set(machineId, machineAuths);
  }

  const auth: ClientAuthorization = {
    clientIdentityId,
    signingKey,
    keyExchangeKey,
    accessType,
    sessionId,
    grantedAt: Date.now(),
  };

  machineAuths.set(clientIdentityId, auth);
  return auth;
}

/**
 * Check if a client is authorized for a machine
 */
export function isClientAuthorized(machineId: string, clientIdentityId: string): boolean {
  const machineAuths = authorizations.get(machineId);
  return machineAuths?.has(clientIdentityId) ?? false;
}

/**
 * Get client authorization for a machine
 */
export function getClientAuthorization(
  machineId: string,
  clientIdentityId: string
): ClientAuthorization | undefined {
  return authorizations.get(machineId)?.get(clientIdentityId);
}

/**
 * Revoke client authorization
 */
export function revokeClientAuthorization(
  machineId: string,
  clientIdentityId: string
): boolean {
  const machineAuths = authorizations.get(machineId);
  if (!machineAuths) return false;
  return machineAuths.delete(clientIdentityId);
}

/**
 * Get all clients authorized for a machine
 */
export function getAuthorizedClients(machineId: string): ClientAuthorization[] {
  const machineAuths = authorizations.get(machineId);
  if (!machineAuths) return [];
  return Array.from(machineAuths.values());
}

/**
 * Get all machines a client is authorized for
 */
export function getMachinesForClient(clientIdentityId: string): {
  machineId: string;
  machine: MachineRegistration | undefined;
  authorization: ClientAuthorization;
}[] {
  const results: {
    machineId: string;
    machine: MachineRegistration | undefined;
    authorization: ClientAuthorization;
  }[] = [];

  for (const [machineId, machineAuths] of authorizations) {
    const auth = machineAuths.get(clientIdentityId);
    if (auth) {
      results.push({
        machineId,
        machine: machines.get(machineId),
        authorization: auth,
      });
    }
  }

  return results;
}

/**
 * Get all registered machines with authorization status for a client
 *
 * Returns all machines (not just authorized ones) so clients can see
 * what's available and understand they need authorization.
 */
export function getAllMachinesWithAuthStatus(clientIdentityId: string): {
  machineId: string;
  machine: MachineRegistration;
  isAuthorized: boolean;
  accessType?: 'full' | 'session-invite';
  sessionId?: string;
}[] {
  const results: {
    machineId: string;
    machine: MachineRegistration;
    isAuthorized: boolean;
    accessType?: 'full' | 'session-invite';
    sessionId?: string;
  }[] = [];

  for (const [machineId, machine] of machines) {
    const machineAuths = authorizations.get(machineId);
    const auth = machineAuths?.get(clientIdentityId);

    results.push({
      machineId,
      machine,
      isAuthorized: !!auth,
      accessType: auth?.accessType,
      sessionId: auth?.sessionId,
    });
  }

  return results;
}

// ============================================================================
// Global Access List Registry
// ============================================================================

/** Global access entry (applies to all machines or specific machines) */
export interface GlobalAccessEntry {
  /** Client identity ID */
  clientIdentityId: string;
  /** Client's signing public key (base64) */
  signingKey: string;
  /** Client's key exchange public key (base64) */
  keyExchangeKey: string;
  /** Human-readable label */
  label?: string;
  /** Access type: 'full' or 'session-invite' */
  accessType: 'full' | 'session-invite';
  /** For session-invite: specific session ID */
  sessionId?: string;
  /** When access was granted */
  grantedAt: number;
  /** Account that granted this access */
  grantedBy: string;
  /** If set, only applies to these machines (empty = all machines) */
  machineIds?: string[];
}

/** Global access list - applies to all machines owned by an account */
const globalAccessList = new Map<string, GlobalAccessEntry[]>(); // accountId → entries

/**
 * Get the global access list for an account
 */
export function getGlobalAccessList(accountId: string): GlobalAccessEntry[] {
  return globalAccessList.get(accountId) || [];
}

/**
 * Get effective access list for a machine
 * Combines global entries (for the account) with machine-specific overrides
 */
export function getEffectiveAccessList(accountId: string, machineId: string): GlobalAccessEntry[] {
  const entries = globalAccessList.get(accountId) || [];
  return entries.filter(entry => {
    // If no machineIds specified, applies to all
    if (!entry.machineIds || entry.machineIds.length === 0) {
      return true;
    }
    // Otherwise, check if this machine is in the list
    return entry.machineIds.includes(machineId);
  });
}

/**
 * Add a global access entry
 */
export function addGlobalAccess(
  accountId: string,
  entry: Omit<GlobalAccessEntry, 'grantedAt' | 'grantedBy'>
): GlobalAccessEntry {
  let entries = globalAccessList.get(accountId);
  if (!entries) {
    entries = [];
    globalAccessList.set(accountId, entries);
  }

  // Check if already exists
  const existingIndex = entries.findIndex(e => e.clientIdentityId === entry.clientIdentityId);

  const fullEntry: GlobalAccessEntry = {
    ...entry,
    grantedAt: Date.now(),
    grantedBy: accountId,
  };

  if (existingIndex >= 0) {
    entries[existingIndex] = fullEntry;
  } else {
    entries.push(fullEntry);
  }

  return fullEntry;
}

/**
 * Remove a global access entry
 */
export function removeGlobalAccess(accountId: string, clientIdentityId: string): boolean {
  const entries = globalAccessList.get(accountId);
  if (!entries) return false;

  const index = entries.findIndex(e => e.clientIdentityId === clientIdentityId);
  if (index < 0) return false;

  entries.splice(index, 1);
  return true;
}

/**
 * Broadcast access list update to all connected machines for an account
 * @param accountId - Account that owns the machines
 * @param added - New access entries
 * @param removed - Removed client identity IDs
 * @param signFn - Optional signing function for message authentication
 */
export function broadcastAccessUpdate(
  accountId: string,
  added: GlobalAccessEntry[],
  removed: string[],
  signFn?: <T extends object>(msg: T) => T
): void {
  // Find all machines owned by this account
  for (const machine of machines.values()) {
    if (machine.accountId === accountId && machine.ws) {
      const msg = {
        type: 'access_update' as const,
        added,
        removed,
      };
      // Sign the message if signing function is provided
      const signedMsg = signFn ? signFn(msg) : msg;
      machine.ws.send(JSON.stringify(signedMsg));
    }
  }
}

/**
 * Get all machines for an account
 */
export function getMachinesForAccount(accountId: string): MachineRegistration[] {
  return Array.from(machines.values()).filter(m => m.accountId === accountId);
}

// ============================================================================
// Stats
// ============================================================================

/**
 * Get registry statistics
 */
export function getRegistryStats(): {
  machineCount: number;
  onlineMachineCount: number;
  inviteCount: number;
  authorizationCount: number;
} {
  let onlineMachineCount = 0;
  for (const machine of machines.values()) {
    if (machine.ws !== null) onlineMachineCount++;
  }

  let authorizationCount = 0;
  for (const machineAuths of authorizations.values()) {
    authorizationCount += machineAuths.size;
  }

  return {
    machineCount: machines.size,
    onlineMachineCount,
    inviteCount: invites.size,
    authorizationCount,
  };
}

/**
 * Clear all registries (for testing)
 */
export function clearAllRegistries(): void {
  machines.clear();
  invites.clear();
  authorizations.clear();
}
