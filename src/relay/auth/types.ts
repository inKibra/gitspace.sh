/**
 * Auth domain types for relay/machine ACL and root invites.
 */

export interface RelayAccessListEntry {
  id: number;
  ownerUserRootId: string;
  clientUserRootId: string;
  label?: string;
  grantedAt: string;
}

export interface MachineAccessListEntry {
  id: number;
  machineId: string;
  ownerUserRootId: string;
  clientUserRootId: string;
  label?: string;
  grantedAt: string;
}

export type RootInviteRecordType = 'relay-user' | 'relay-machine' | 'machine-user';

export interface RootInviteRecord {
  inviteId: string;
  ownerUserRootId: string;
  inviteType: RootInviteRecordType;
  relayUrl: string;
  tokenHash: string;
  label?: string;
  maxUses: number | null;
  usedCount: number;
  expiresAt: string;
  createdAt: string;
  revokedAt?: string;
  targetUserRootId?: string;
  machineId?: string;
  targetMachineSigningKey?: string;
  targetMachineKeyExchangeKey?: string;
}
