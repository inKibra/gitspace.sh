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

  it('reconnects the agent watch after a watch failure (deltas resume, snapshot resynced)', async () => {
    const sm = fakeSessionManager();
    let watchStarts = 0;
    let snapshotReads = 0;
    let lastHandlers: { onError: (e: Error) => void } | null = null;
    const deps = fakeDeps(sm);
    deps.getAgentState = async () => {
      snapshotReads += 1;
      return [];
    };
    (deps as { watchAgentState: unknown }).watchAgentState = async (handlers: { onError: (e: Error) => void }) => {
      watchStarts += 1;
      lastHandlers = handlers;
      return () => undefined;
    };

    await activateServeRuntime(fakeConfig(), deps);
    expect(watchStarts).toBe(1);
    const readsBeforeFailure = snapshotReads;

    // Simulate the watch socket dying — the bridge must come back on its own
    // (first backoff step is 1s) and refresh the retained snapshot.
    lastHandlers!.onError(new Error('Agent watch connection closed'));
    await new Promise((r) => setTimeout(r, 1300));
    expect(watchStarts).toBe(2);
    expect(snapshotReads).toBeGreaterThan(readsBeforeFailure);
  });

  it('rebroadcasts the full agent snapshot to established clients on watch (re)subscribe', async () => {
    const sm = fakeSessionManager();
    const rawBroadcasts: unknown[] = [];
    sm.broadcastRawMessage = ((message: unknown) => { rawBroadcasts.push(message); }) as never;
    let lastHandlers: { onSnapshot: (w: unknown[]) => void } | null = null;
    const deps = fakeDeps(sm);
    (deps as { watchAgentState: unknown }).watchAgentState = async (handlers: { onSnapshot: (w: unknown[]) => void }) => {
      lastHandlers = handlers;
      return () => undefined;
    };

    await activateServeRuntime(fakeConfig(), deps);
    const workspaces = [{ workspaceId: 'ws-1', sessions: [], statuses: {}, pendingPermissions: {}, pendingQuestions: {}, lastMessages: {}, errorMessages: {}, todoPhases: {}, modelInfo: {}, queuedMessages: {} }];

    // No established clients — nothing to catch up.
    lastHandlers!.onSnapshot(workspaces);
    expect(rawBroadcasts).toHaveLength(0);

    // With established clients, the resubscribe snapshot is pushed to them.
    (sm as { establishedSessionCount: number }).establishedSessionCount = 1;
    lastHandlers!.onSnapshot(workspaces);
    expect(rawBroadcasts).toEqual([{ type: 'agent_state_snapshot', workspaces }]);
  });

  it('does not restart the agent watch after deactivation', async () => {
    const sm = fakeSessionManager();
    let watchStarts = 0;
    let lastHandlers: { onError: (e: Error) => void } | null = null;
    const deps = fakeDeps(sm);
    (deps as { watchAgentState: unknown }).watchAgentState = async (handlers: { onError: (e: Error) => void }) => {
      watchStarts += 1;
      lastHandlers = handlers;
      return () => undefined;
    };

    await activateServeRuntime(fakeConfig(), deps);
    lastHandlers!.onError(new Error('Agent watch connection closed'));
    await deactivateServeRuntime(); // cancels the pending restart
    await new Promise((r) => setTimeout(r, 1300));
    expect(watchStarts).toBe(1);
  });
});
