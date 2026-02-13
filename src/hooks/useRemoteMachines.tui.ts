/**
 * TUI Hook for remote machine directory connections.
 */

import { useCallback, useMemo } from 'react';
import type { Identity } from '../types/identity.js';
import { keypairExists, loadKeypair } from '../core/identity.js';
import { signMessage } from '../relay/signing.js';
import type { MachineInfo } from '../components/index.js';
import {
  useMachineDirectory,
  type RelayStatus,
  nodeRelaySocketAdapter,
  type NodeRelaySocket,
} from '../relay-client/index.js';

export interface RelayConfig {
  url: string;
}

export interface UseRemoteMachinesOptions {
  relayConfig?: RelayConfig;
  onError?: (error: Error) => void;
  /** Optional preloaded identity (avoids password/env lookup). */
  identity?: Identity;
  /** Optional password for loading local identity from disk. */
  identityPassword?: string;
}

export type ConnectionStatus = RelayStatus;

export interface UseRemoteMachinesReturn {
  // Connection state
  status: ConnectionStatus;
  error: string | null;
  identity: Identity | null;

  // Machine list
  machines: MachineInfo[];

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshMachines: () => Promise<void>;

  // Mode
  isRemoteMode: boolean;
  isLocal: (machine: MachineInfo) => boolean;
}

async function resolveIdentity(options: UseRemoteMachinesOptions): Promise<Identity | null> {
  if (options.identity) {
    return options.identity;
  }

  if (!keypairExists()) {
    return null;
  }

  const password = options.identityPassword || process.env.GITSPACE_IDENTITY_PASSWORD;
  if (!password) {
    return null;
  }

  try {
    return await loadKeypair(password);
  } catch {
    return null;
  }
}

export function useRemoteMachines(options: UseRemoteMachinesOptions = {}): UseRemoteMachinesReturn {
  const { relayConfig, onError } = options;
  const isRemoteMode = !!relayConfig;

  const localMachine = useMemo<MachineInfo>(
    () => ({
      machineId: 'local',
      label: 'This Machine',
      online: true,
      isAuthorized: true,
    }),
    []
  );

  const isLocal = useCallback((machine: MachineInfo) => {
    return machine.machineId === 'local';
  }, []);

  const directory = useMachineDirectory<NodeRelaySocket, Identity>({
    enabled: isRemoteMode,
    autoConnect: isRemoteMode,
    socketAdapter: nodeRelaySocketAdapter,
    mapMachines: (remoteMachines) => [localMachine, ...remoteMachines],
    resolveClientConfig: async () => {
      if (!relayConfig) {
        throw new Error('Relay config is required for remote mode');
      }

      const identity = await resolveIdentity(options);
      if (!identity) {
        throw new Error(
          'Remote relay requires an unlocked identity. Set GITSPACE_IDENTITY_PASSWORD or pass identity to useRemoteMachines.'
        );
      }

      return {
        relayUrl: relayConfig.url,
        clientIdentityId: identity.id,
        identity,
        signer: <T extends object>(message: T): T => {
          const privateKey = identity.signing.secretKey.slice(0, 32);
          return signMessage(message, privateKey, identity.signing.publicKey);
        },
      };
    },
    onError,
  });

  const connect = useCallback(async () => {
    if (!isRemoteMode) {
      return;
    }
    await directory.connect();
  }, [directory, isRemoteMode]);

  const disconnect = useCallback(() => {
    if (!isRemoteMode) {
      return;
    }
    directory.disconnect();
  }, [directory, isRemoteMode]);

  const refreshMachines = useCallback(async () => {
    if (!isRemoteMode) {
      return;
    }
    await directory.refreshMachines();
  }, [directory, isRemoteMode]);

  if (!isRemoteMode) {
    return {
      status: 'connected',
      error: null,
      identity: null,
      machines: [localMachine],
      connect,
      disconnect,
      refreshMachines,
      isRemoteMode,
      isLocal,
    };
  }

  return {
    status: directory.status,
    error: directory.error,
    identity: directory.identity,
    machines: directory.machines.length > 0 ? directory.machines : [localMachine],
    connect,
    disconnect,
    refreshMachines,
    isRemoteMode,
    isLocal,
  };
}
