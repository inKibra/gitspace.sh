/**
 * TUI Hook for remote machine directory connections.
 */

import { useCallback, useMemo } from 'react';
import type { Identity } from '../types/identity.js';
import { keypairExists, loadKeypair } from '../core/identity.js';
import { createLocalDeviceCertificate } from '../core/user-identity.js';
import { getLocalStorePasswordFromEnv } from '../commands/local-store-password.js';
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
  label?: string;
  source?: 'account' | 'cached' | 'local' | 'explicit';
  autoConnected?: boolean;
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

  const password = options.identityPassword || getLocalStorePasswordFromEnv();
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
  const hasUnlockedMachineIdentity = useMemo(() => {
    if (options.identity) {
      return true;
    }

    const password = options.identityPassword || getLocalStorePasswordFromEnv();
    return !!password && keypairExists();
  }, [options.identity, options.identityPassword]);
  const shouldAutoConnect = isRemoteMode
    && relayConfig?.autoConnected === true
    && hasUnlockedMachineIdentity;

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
    autoConnect: shouldAutoConnect,
    socketAdapter: nodeRelaySocketAdapter,
    mapMachines: (remoteMachines) => [localMachine, ...remoteMachines],
    resolveClientConfig: async () => {
      if (!relayConfig) {
        throw new Error('Relay config is required for remote mode');
      }

      const identity = await resolveIdentity(options);
      if (!identity) {
        throw new Error(
          'Remote relay requires an unlocked local secure store identity.'
        );
      }

      let deviceCertificate: string;
      try {
        deviceCertificate = await createLocalDeviceCertificate(identity);
      } catch {
        throw new Error(
          'Remote relay requires a user root identity certificate. Run `gssh user identity init` first.'
        );
      }

      return {
        relayUrl: relayConfig.url,
        clientIdentityId: identity.id,
        deviceCertificate,
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

  return useMemo(() => {
    if (!isRemoteMode) {
      return {
        status: 'connected' as const,
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
  }, [
    directory.error,
    directory.identity,
    directory.machines,
    directory.status,
    localMachine,
    connect,
    disconnect,
    refreshMachines,
    isRemoteMode,
    isLocal,
  ]);
}
