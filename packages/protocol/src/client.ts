import { createBrowserClient } from 'result-rpc/client';
import { decodeApiKey, createSignedRpcFetch, deviceProtocolBase64, type ApiKey } from './device-grant.js';
import { gitspaceContract } from './rpc-contract.js';
import { createRoutedTransport } from './routed-transport.js';

export interface GitSpaceClientOptions {
  /** `gsk_…` API key from Settings → Connections → New API client. */
  key: string | ApiKey;
  /** Override the home RPC endpoint baked into the key. Other machines are reached by placement from there. */
  url?: string;
  fetch?: typeof globalThis.fetch;
}

export class InvalidApiKeyError extends Error {
  constructor() {
    super('The GitSpace API key is malformed');
    this.name = 'InvalidApiKeyError';
  }
}

/**
 * Typed GitSpace client for scripts and services. Every call returns a
 * `Result`; subscriptions are async iterators. Requests are signed with the
 * key's device identity and routed to whichever machine holds the space they
 * name - the caller sees one account, not a fleet.
 */
export function createGitSpaceClient(options: GitSpaceClientOptions) {
  const key = typeof options.key === 'string' ? decodeApiKey(options.key) : options.key;
  if (!key) throw new InvalidApiKeyError();
  return createBrowserClient({
    contract: gitspaceContract,
    transport: createRoutedTransport({
      homeUrl: options.url ?? key.rpcUrl,
      fetch: createSignedRpcFetch({ deviceId: key.deviceId, signingPrivateKey: deviceProtocolBase64.decode(key.signingPrivateKey), ...(options.fetch ? { fetch: options.fetch } : {}) }),
    }),
  });
}
export type GitSpaceClient = ReturnType<typeof createGitSpaceClient>;
