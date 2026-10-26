import type { RuntimeAccountBrowserPairing, RuntimeBrowserTrust } from '@gitspace/protocol-runtime';
import type { AccountBrowserRelay } from '../../src/browser-relay.js';
import type { UserRelayDO } from '../../src/index.js';

type Driven = Pick<AccountBrowserRelay, 'fetch' | 'pair' | 'redeemPairingCode' | 'status' | 'confirm' | 'setChrome' | 'placement' | 'unpair' | 'execute' | 'scriptBegin' | 'projectSettings' | 'setProjectSettings' | 'retireWorkspace' | 'powers' | 'everything'>;

/** `pair` starts a pairing and redeems its short code, as GitSpace and then the extension do, answering the pairing's
 * details; `start` and `redeem` are those two steps apart. */
export type HostedBrowserRelay = Omit<Driven, 'pair' | 'redeemPairingCode'> & {
  pair(trust: RuntimeBrowserTrust, endpoint: string): Promise<RuntimeAccountBrowserPairing>;
  start: AccountBrowserRelay['pair'];
  redeem: AccountBrowserRelay['redeemPairingCode'];
};

/** A browser relay as tests drive it: a relay object's (`hostedBrowserRelay`) or one constructed over the same storage,
 * as a relay woken from hibernation would be. */
export function drivenBrowserRelay(relay: Driven): HostedBrowserRelay {
  return {
    fetch: request => relay.fetch(request),
    pair: async (trust, endpoint) => {
      const redeemed = await relay.redeemPairingCode((await relay.pair(trust)).code, '198.51.100.1', endpoint);
      if (!redeemed.ok) throw new Error(redeemed.message);
      return redeemed.value;
    },
    start: trust => relay.pair(trust),
    redeem: (code, ip, endpoint) => relay.redeemPairingCode(code, ip, endpoint),
    status: () => relay.status(),
    confirm: (pairingId, fingerprint) => relay.confirm(pairingId, fingerprint),
    setChrome: (pairingId, change) => relay.setChrome(pairingId, change),
    placement: (projectId, pairingId) => relay.placement(projectId, pairingId),
    unpair: pairingId => relay.unpair(pairingId),
    execute: authorization => relay.execute(authorization),
    scriptBegin: authorization => relay.scriptBegin(authorization),
    projectSettings: projectId => relay.projectSettings(projectId),
    setProjectSettings: (projectId, expectedRevision, preferences) => relay.setProjectSettings(projectId, expectedRevision, preferences),
    retireWorkspace: (projectId, workspaceId) => relay.retireWorkspace(projectId, workspaceId),
    powers: (projectId, workspaceId) => relay.powers(projectId, workspaceId),
    everything: (projectId, workspaceId, pairingId, on) => relay.everything(projectId, workspaceId, pairingId, on),
  };
}

/** The browser relay of a live relay object. Extension sockets are hibernatable, so their frames reach the relay object
 * that accepted them, never a separately constructed `AccountBrowserRelay`. */
export function hostedBrowserRelay(relay: UserRelayDO): HostedBrowserRelay {
  return drivenBrowserRelay({
    fetch: request => relay.fetch(request),
    pair: trust => relay.browserRelayPair(trust),
    redeemPairingCode: (code, ip, endpoint) => relay.browserRelayRedeemPairingCode(code, ip, endpoint),
    status: () => relay.browserRelayStatus(),
    confirm: (pairingId, fingerprint) => relay.browserRelayConfirm(pairingId, fingerprint),
    setChrome: (pairingId, change) => relay.browserRelaySetChrome(pairingId, change),
    placement: (projectId, pairingId) => relay.browserRelayPlacement(projectId, pairingId),
    unpair: pairingId => relay.browserRelayUnpair(pairingId),
    execute: authorization => relay.browserRelayExecute(authorization),
    scriptBegin: authorization => relay.browserRelayScriptBegin(authorization),
    projectSettings: projectId => relay.browserRelayProjectSettings(projectId),
    setProjectSettings: (projectId, expectedRevision, preferences) => relay.browserRelaySetProjectSettings(projectId, expectedRevision, preferences),
    retireWorkspace: (projectId, workspaceId) => relay.browserRelayRetireWorkspace(projectId, workspaceId),
    powers: (projectId, workspaceId) => relay.browserRelayPowers(projectId, workspaceId),
    everything: (projectId, workspaceId, pairingId, on) => relay.browserRelayEverything(projectId, workspaceId, pairingId, on),
  });
}
