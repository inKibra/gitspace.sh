import type { PlatformAdapters } from '../engine/types.js';
import { createBrowserRemoteSessionBackend } from '../../app/session/createSessionBackend.web.js';
import { browserRelaySocketAdapter } from '../../relay-client/adapters/browser.js';
import { signRelayMessage } from '../../session/crypto/relay-signing.web.js';
import { getStoredDeviceCert } from '../../lib/storage/identity-store.web.js';

export function browserPlatform(): PlatformAdapters {
  return {
    createLocalBackend: null,
    createRemoteBackend: createBrowserRemoteSessionBackend,
    relaySocketAdapter: browserRelaySocketAdapter,
    // Curry identity so the engine can sign individual messages without re-passing identity.
    createRelaySigner: (identity) => (msg) => signRelayMessage(msg, identity),
    // getStoredDeviceCert returns string | null; relay auth requires a string.
    getDeviceCertificate: async () => getStoredDeviceCert() ?? '',
  };
}
