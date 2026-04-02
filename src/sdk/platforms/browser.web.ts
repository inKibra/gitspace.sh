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
    // Returns empty string when no cert exists yet — the relay auth flow may
    // still succeed (e.g. during enrollment) or fail with a clear auth error.
    // Throwing here would crash the engine before it can show the identity gate.
    getDeviceCertificate: async () => getStoredDeviceCert() ?? '',
    storage: {
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
      removeItem: (key) => localStorage.removeItem(key),
    },
    copyToClipboard: (text) => navigator.clipboard.writeText(text),
  };
}
