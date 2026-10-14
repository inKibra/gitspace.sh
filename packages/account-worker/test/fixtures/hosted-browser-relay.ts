import type { AccountBrowserRelay } from '../../src/browser-relay.js';
import type { UserRelayDO } from '../../src/index.js';

export type HostedBrowserRelay = Pick<AccountBrowserRelay, 'fetch' | 'pair' | 'status' | 'confirm' | 'placement' | 'unpair' | 'execute' | 'projectSettings' | 'setProjectSettings'>;

/** The browser relay of a live relay object. Extension sockets are hibernatable, so their frames reach the relay object
 * that accepted them, never a separately constructed `AccountBrowserRelay`. */
export function hostedBrowserRelay(relay: UserRelayDO): HostedBrowserRelay {
  return {
    fetch: request => relay.browserRelayFetch(request),
    pair: (trust, endpoint) => relay.browserRelayPair(trust, endpoint),
    status: () => relay.browserRelayStatus(),
    confirm: (pairingId, fingerprint) => relay.browserRelayConfirm(pairingId, fingerprint),
    placement: (projectId, pairingId) => relay.browserRelayPlacement(projectId, pairingId),
    unpair: pairingId => relay.browserRelayUnpair(pairingId),
    execute: authorization => relay.browserRelayExecute(authorization),
    projectSettings: projectId => relay.browserRelayProjectSettings(projectId),
    setProjectSettings: (projectId, expectedRevision, preferences) => relay.browserRelaySetProjectSettings(projectId, expectedRevision, preferences),
  };
}
