import { gitspaceContract } from '@gitspace/protocol/rpc-contract';
import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { createBrowserClient } from 'result-rpc/client';
import { currentDevice, deviceRejected } from './device-session.js';
import { createDeviceSignedFetch } from './device.js';

export const homeRpcUrl = '/rpc';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);

let updated = false;
const updateListeners = new Set<() => void>();
/** Set once any call sees a server contract that differs from this page's bundle; only a reload recovers. */
export const appUpdate = {
  subscribe(listener: () => void) { updateListeners.add(listener); return () => { updateListeners.delete(listener); }; },
  current: () => updated,
};

/** The account app sends every call through its tenant; machine effects name their cache explicitly. */
export const rpcClient = createBrowserClient({
  contract: gitspaceContract,
  transport: createRoutedTransport({ homeUrl: homeRpcUrl, fetch: signedFetch }),
  onEvent: event => {
    if (event.type !== 'skew' || updated) return;
    updated = true;
    for (const listener of updateListeners) listener();
  },
});
