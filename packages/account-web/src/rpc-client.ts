import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { currentDevice, deviceRejected } from './device-session.js';
import { createDeviceSignedFetch } from './device.js';

export const homeRpcUrl = '/rpc';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

/** The account app sends every call through its tenant; machine effects name their cache explicitly. */
export const rpcClient = createBrowserClient({ contract: gitspaceContract, transport: createRoutedTransport({ homeUrl: homeRpcUrl, fetch: signedFetch }) });
