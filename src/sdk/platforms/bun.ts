import type { PlatformAdapters } from '../engine/types.js';
import { LOCAL_BACKEND_KEY } from '../engine/engine.js';
import { createBunLocalSessionBackend, createBunRemoteSessionBackend } from '../../machine/local/createSessionBackend.bun.js';
import { nodeRelaySocketAdapter } from '../../relay-client/index.js';
import { createNodeRelaySigner } from '../../session/index.js';
import { createLocalDeviceCertificate } from '../../core/user-identity.js';

export function bunPlatform(): PlatformAdapters {
  return {
    createLocalBackend: () => createBunLocalSessionBackend(LOCAL_BACKEND_KEY),
    createRemoteBackend: createBunRemoteSessionBackend,
    relaySocketAdapter: nodeRelaySocketAdapter,
    createRelaySigner: createNodeRelaySigner,
    getDeviceCertificate: createLocalDeviceCertificate,
    storage: null,
    copyToClipboard: undefined,
  };
}
