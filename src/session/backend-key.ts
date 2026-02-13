import type { BackendKey } from './backend.js';

export function buildRemoteBackendKey(relayUrl: string, machineId: string): BackendKey {
  return `remote:${relayUrl}:${machineId}`;
}
