import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { batchFetchTransport, createBrowserClient } from 'result-rpc/client';
import { currentDevice, deviceRejected } from './device-session.js';
import { createDeviceSignedFetch } from './device.js';

export const homeRpcUrl = '/rpc';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

/** Direct client to one machine, signed by this browser's device. Used only where the destination is chosen explicitly (moves). */
export function createGitSpaceBrowserClient(options: { url: string }) {
  return createBrowserClient({
    contract: gitspaceContract,
    transport: batchFetchTransport({ url: options.url, fetch: signedFetch, maxItems: 32 }),
  });
}

/** The account app routes home calls through its tenant; space calls go directly to the current holder. */
export const routedTransport = createRoutedTransport({ homeUrl: homeRpcUrl, fetch: signedFetch });
export const rpcClient = createBrowserClient({ contract: gitspaceContract, transport: routedTransport });
