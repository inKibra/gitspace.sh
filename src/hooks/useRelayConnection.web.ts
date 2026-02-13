/**
 * Hook for relay connection before terminal session.
 */

import { useCallback } from 'react';
import { getOrCreateIdentity } from '../lib/storage/identity-store.web';
import { exportPublicKey } from '../session/crypto/identity.web';
import { signRelayMessage } from '../session/crypto/relay-signing.web';
import type { Identity } from '../types/identity';
import {
  useMachineDirectory,
} from '../relay-client/useMachineDirectory.js';
import { browserRelaySocketAdapter } from '../relay-client/adapters/browser.js';

export function useRelayConnection() {
  const machineDirectory = useMachineDirectory<
    WebSocket,
    Identity,
    { publicKey: string }
  >({
    socketAdapter: browserRelaySocketAdapter,
    resolveClientConfig: async () => {
      const identity = await getOrCreateIdentity();
      const publicKey = exportPublicKey(identity);

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const relayUrl = `${wsProtocol}//${location.host}/ws`;

      return {
        relayUrl,
        clientIdentityId: identity.id,
        identity,
        context: { publicKey },
        signer: (message) => signRelayMessage(message, identity),
      };
    },
  });

  const connect = useCallback(async () => {
    await machineDirectory.connect();
  }, [machineDirectory]);

  return {
    status: machineDirectory.status,
    machines: machineDirectory.machines,
    error: machineDirectory.error,
    identity: machineDirectory.identity,
    publicKey: machineDirectory.context?.publicKey ?? null,
    connect,
    disconnect: machineDirectory.disconnect,
    refreshMachines: machineDirectory.refreshMachines,
    getWebSocket: machineDirectory.getSocket,
  };
}
