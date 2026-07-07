/** Serve runtime (daemon-unification P1) — activation lifecycle with injected
 *  seams: no network, no real session manager, no socket. */
import { afterEach, describe, expect, it } from 'bun:test';
import {
  activateServeRuntime,
  deactivateServeRuntime,
  getServeRuntimeStatus,
  type ServeRuntimeConfig,
  type ServeRuntimeDeps,
  type SessionManagerLike,
} from '../serve-runtime.js';
import type { ServeEventHandler } from '../../../serve/types.js';

function fakeConfig(): ServeRuntimeConfig {
  const key = (n: number): Uint8Array => new Uint8Array(n).fill(7);
  return {
    relayUrl: 'ws://fake:1/ws',
    relayPubkey: 'PINNED',
    machineId: 'm-test',
    identity: {
      id: 'id-test',
      createdAt: 0,
      signing: { publicKey: key(32), secretKey: key(64) },
      keyExchange: { publicKey: key(32), privateKey: key(32) },
    },
    publicIdentity: { id: 'id-test', signingPublicKey: 'pk', keyExchangePublicKey: 'kx' },
  };
}

function fakeSessionManager(): SessionManagerLike & { initialized: boolean; events: ServeEventHandler[] } {
  return {
    initialized: false,
    events: [],
    async initialize() { this.initialized = true; },
    onEvent(h: ServeEventHandler) { this.events.push(h); },
    broadcastAgentStateUpdate() {},
    broadcastRawMessage() {},
    sendAgentStateSnapshot() {},
    establishedSessionCount: 0,
  };
}

function fakeDeps(sm: SessionManagerLike, hooks: { stopRelay?: () => void; onConnect?: (c: ServeRuntimeConfig) => void; failConnect?: boolean } = {}): ServeRuntimeDeps & { agentWatchStopped: boolean } {
  const state = {
    agentWatchStopped: false,
    createSessionManager: () => sm,
    connectRelay: async (config: ServeRuntimeConfig, _sm: SessionManagerLike, _eh: ServeEventHandler, lifecycle: { onStop: (stop: () => void) => void }) => {
      hooks.onConnect?.(config);
      if (hooks.failConnect) throw new Error('relay unreachable');
      lifecycle.onStop(hooks.stopRelay ?? (() => undefined));
    },
    getAgentState: async () => [],
    watchAgentState: async () => () => { state.agentWatchStopped = true; },
    log: () => undefined,
  };
  return state as never;
}

afterEach(async () => {
  await deactivateServeRuntime();
});

describe('serve runtime activation', () => {
  it('activates: session manager initialized, relay connected with pinned config, status live', async () => {
    const sm = fakeSessionManager();
    let connectedWith: ServeRuntimeConfig | null = null;
    const deps = fakeDeps(sm, { onConnect: (c) => { connectedWith = c; } });

    const status = await activateServeRuntime(fakeConfig(), deps);
    expect(sm.initialized).toBe(true);
    expect(connectedWith!.relayPubkey).toBe('PINNED');
    expect(status.active).toBe(true);
    expect(status.relayStatus).toBe('connected');
    expect(getServeRuntimeStatus().machineId).toBe('m-test');
    // client events drive the status counter
    (sm as { establishedSessionCount: number }).establishedSessionCount = 2;
    for (const h of sm.events) h({ type: 'client_authenticated', connectionId: 'c1' } as never);
    expect(getServeRuntimeStatus().clients).toBe(2);
  });

  it('refuses double activation; deactivate stops relay + agent watch', async () => {
    const sm = fakeSessionManager();
    let relayStopped = false;
    const deps = fakeDeps(sm, { stopRelay: () => { relayStopped = true; } });

    await activateServeRuntime(fakeConfig(), deps);
    await expect(activateServeRuntime(fakeConfig(), deps)).rejects.toThrow('already active');

    await deactivateServeRuntime();
    expect(relayStopped).toBe(true);
    expect(deps.agentWatchStopped).toBe(true);
    expect(getServeRuntimeStatus().active).toBe(false);
    // reactivation after deactivate works
    const status = await activateServeRuntime(fakeConfig(), fakeDeps(fakeSessionManager()));
    expect(status.active).toBe(true);
  });

  it('fails closed: a connect failure leaves the runtime inactive and re-activatable', async () => {
    const sm = fakeSessionManager();
    await expect(activateServeRuntime(fakeConfig(), fakeDeps(sm, { failConnect: true }))).rejects.toThrow('relay unreachable');
    expect(getServeRuntimeStatus().active).toBe(false);
    const ok = await activateServeRuntime(fakeConfig(), fakeDeps(fakeSessionManager()));
    expect(ok.active).toBe(true);
  });
});
