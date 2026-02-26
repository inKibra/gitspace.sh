/**
 * Hook for relay connection before terminal session.
 */

import { useCallback, useRef } from 'react';
import {
  getUnlockedIdentity,
  hasStoredMnemonic,
  storeMnemonic,
  unlockMnemonic,
} from '../lib/storage/identity-store.web';
import {
  createSelfSignedDeviceCertificate,
  exportUserRootPublicKey,
  isValidMnemonic,
  normalizeMnemonic,
} from '../session/crypto/identity.web';
import { signRelayMessage } from '../session/crypto/relay-signing.web';
import type { Identity } from '../types/identity';
import {
  useMachineDirectory,
} from '../relay-client/useMachineDirectory.js';
import { browserRelaySocketAdapter } from '../relay-client/adapters/browser.js';

export function useRelayConnection() {
  const unlockedIdentityRef = useRef<Identity | null>(null);

  const resolveOwnerIdentity = useCallback(async (): Promise<Identity> => {
    if (unlockedIdentityRef.current) {
      return unlockedIdentityRef.current;
    }

    const sessionIdentity = getUnlockedIdentity('Browser Owner');
    if (sessionIdentity) {
      unlockedIdentityRef.current = sessionIdentity;
      return sessionIdentity;
    }

    if (hasStoredMnemonic()) {
      const passphrase = window.prompt('Enter your browser unlock PIN/password:') ?? '';
      if (!passphrase.trim()) {
        throw new Error('Browser identity unlock cancelled.');
      }

      await unlockMnemonic(passphrase);
      const unlocked = getUnlockedIdentity('Browser Owner');
      if (!unlocked) {
        throw new Error('Failed to unlock browser identity.');
      }

      unlockedIdentityRef.current = unlocked;
      return unlocked;
    }

    const mnemonicInput = window.prompt('Enter your 24-word recovery phrase to authorize this browser:');
    if (!mnemonicInput) {
      throw new Error('Browser identity setup cancelled.');
    }

    const normalizedMnemonic = normalizeMnemonic(mnemonicInput);
    if (!isValidMnemonic(normalizedMnemonic)) {
      throw new Error('Invalid 24-word recovery phrase.');
    }

    const passphrase = window.prompt('Create a local unlock PIN/password for this browser:') ?? '';
    if (!passphrase.trim()) {
      throw new Error('Unlock PIN/password is required.');
    }

    const confirmPassphrase = window.prompt('Confirm your browser unlock PIN/password:') ?? '';
    if (passphrase !== confirmPassphrase) {
      throw new Error('Unlock PIN/password confirmation does not match.');
    }

    await storeMnemonic(normalizedMnemonic, passphrase);
    const initialized = getUnlockedIdentity('Browser Owner');
    if (!initialized) {
      throw new Error('Failed to initialize browser identity.');
    }

    unlockedIdentityRef.current = initialized;
    return initialized;
  }, []);

  const machineDirectory = useMachineDirectory<
    WebSocket,
    Identity,
    { publicKey: string; deviceCertificate: string }
  >({
    socketAdapter: browserRelaySocketAdapter,
    resolveClientConfig: async () => {
      const identity = await resolveOwnerIdentity();
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
