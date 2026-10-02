import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport, tagRpcProcedures } from '@gitspace/protocol/routed-transport';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
import { currentDevice, deviceRejected } from './device-session.js';
import { createDeviceSignedFetch } from './device.js';

export const homeRpcUrl = '/rpc';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);
const taggedFetch = tagRpcProcedures(signedFetch);

/** Explicit placement operations can restore a repository and its saved agent session. */
export function createGitSpaceBrowserClient(options: { url: string }) {
  return createBrowserClient({
    contract: gitspaceContract,
    transport: fetchTransport({ url: options.url, fetch: taggedFetch, timeoutMs: 300_000 }),
  });
}

/** The account app sends every call through its tenant, which forwards machine work to the current holder. */
export const rpcClient = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({ homeUrl: homeRpcUrl, fetch: signedFetch }) });
