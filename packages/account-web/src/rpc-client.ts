import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
import { currentDevice, deviceRejected } from './device-session.js';
import { createDeviceSignedFetch } from './device.js';

export const homeRpcUrl = '/rpc';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

/** Explicit placement operations can restore a repository and its saved agent session. */
export function createGitSpaceBrowserClient(options: { url: string }) {
  return createBrowserClient({
    contract: gitspaceContract,
    transport: fetchTransport({ url: options.url, fetch: signedFetch, timeoutMs: 300_000 }),
  });
}

/** The account app routes home calls through its tenant; space calls go directly to the current holder. */
export const routedTransport = createRoutedTransport({ homeUrl: homeRpcUrl, fetch: signedFetch });
export const rpcClient = createBrowserClient({ contract: gitspaceContract, transport: routedTransport });
