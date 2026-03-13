/**
 * Hook for relay connection before terminal session.
 *
 * Identity is now resolved externally by IdentityGate and passed in.
 * This hook no longer uses window.prompt() — it just takes the identity
 * and wires up the relay connection.
 */

import { useCallback, useRef } from 'react';
import {
  createSelfSignedDeviceCertificate,
  exportUserRootPublicKey,
} from '../session/crypto/identity.web';
import { signRelayMessage } from '../session/crypto/relay-signing.web';
import type { Identity } from '../types/identity';
import {
  useMachineDirectory,
} from '../relay-client/useMachineDirectory.js';
import { browserRelaySocketAdapter } from '../relay-client/adapters/browser.js';

interface UseRelayConnectionOptions {
  /** Pre-resolved identity from IdentityGate */
  identity: Identity | null;
}

export function useRelayConnection(options?: UseRelayConnectionOptions) {
  const identityRef = useRef<Identity | null>(options?.identity ?? null);

  // Keep ref in sync with prop (handle null transitions for logout)
  identityRef.current = options?.identity ?? null;

  const machineDirectory = useMachineDirectory<
    WebSocket,
    Identity,
    { publicKey: string; deviceCertificate: string }
  >({
    socketAdapter: browserRelaySocketAdapter,
    resolveClientConfig: async () => {
      const identity = identityRef.current;
      if (!identity) {
        throw new Error('No identity available. Complete identity setup first.');
      }

      const publicKey = exportUserRootPublicKey(identity);
      const deviceCertificate = createSelfSignedDeviceCertificate(identity);

      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const relayUrl = `${wsProtocol}//${location.host}/ws`;

      return {
        relayUrl,
        clientIdentityId: identity.id,
        identity,
        deviceCertificate,
        context: { publicKey, deviceCertificate },
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
    deviceCertificate: machineDirectory.context?.deviceCertificate ?? null,
    connect,
    disconnect: machineDirectory.disconnect,
    refreshMachines: machineDirectory.refreshMachines,
    getWebSocket: machineDirectory.getSocket,
  };
}
