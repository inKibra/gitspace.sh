import type { AccountBrowserRelay } from '../../src/browser-relay.js';
import type { UserRelayDO } from '../../src/index.js';

export type HostedBrowserRelay = Pick<AccountBrowserRelay, 'fetch' | 'pair' | 'status' | 'confirm' | 'rename' | 'placement' | 'unpair' | 'execute' | 'scriptBegin' | 'projectSettings' | 'setProjectSettings' | 'retireWorkspace'>;

/** The browser relay of a live relay object. Extension sockets are hibernatable, so their frames reach the relay object
 * that accepted them, never a separately constructed `AccountBrowserRelay`. */
export function hostedBrowserRelay(relay: UserRelayDO): HostedBrowserRelay {
  return {
    fetch: request => relay.fetch(request),
    pair: (trust, endpoint) => relay.browserRelayPair(trust, endpoint),
    status: () => relay.browserRelayStatus(),
    confirm: (pairingId, fingerprint) => relay.browserRelayConfirm(pairingId, fingerprint),
    rename: (pairingId, name) => relay.browserRelayRename(pairingId, name),
    placement: (projectId, pairingId) => relay.browserRelayPlacement(projectId, pairingId),
    unpair: pairingId => relay.browserRelayUnpair(pairingId),
    execute: authorization => relay.browserRelayExecute(authorization),
    scriptBegin: authorization => relay.browserRelayScriptBegin(authorization),
    projectSettings: projectId => relay.browserRelayProjectSettings(projectId),
    setProjectSettings: (projectId, expectedRevision, preferences) => relay.browserRelaySetProjectSettings(projectId, expectedRevision, preferences),
    retireWorkspace: (projectId, workspaceId) => relay.browserRelayRetireWorkspace(projectId, workspaceId),
  };
}
