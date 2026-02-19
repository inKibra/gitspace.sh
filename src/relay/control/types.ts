export type CloudWorkspaceStatus =
  | 'provisioning'
  | 'bootstrapping'
  | 'ready'
  | 'hibernated'
  | 'offline'
  | 'destroyed'
  | 'error';

export interface ControlMeta {
  schemaVersion: number;
  ownerIdentityId?: string;
  relayIdentityId?: string;
  relaySigningPublicKey?: string;
  relayFingerprint?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudWorkspaceRecord {
  id: string;
  provider: 'sprites';
  providerWorkspaceId: string;
  machineId?: string;
  machinePublicKey?: string;
  repo?: string;
  branch?: string;
  status: CloudWorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export type CloudBootstrapState =
  | 'pending'
  | 'vm_created'
  | 'unlock_granted'
  | 'machine_registered'
  | 'ready'
  | 'failed';

export interface CloudBootstrapTokenRecord {
  tokenId: string;
  workspaceId: string;
  ownerIdentityId: string;
  tokenHash: string;
  state: CloudBootstrapState;
  expiresAt: string;
  consumedAt?: string;
  machineId?: string;
  machinePublicKey?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}
