/**
 * Serve runtime hosted INSIDE the tmux-lite daemon (docs/DAEMON-UNIFICATION.md
 * P1): the relay client + E2E client session manager + agent-state bridge,
 * started by the `serve-activate` socket command and torn down by
 * `serve-deactivate`. The daemon stays passwordless/local by default; the
 * activator (gssh machine serve start) resolves relay trust interactively
 * FIRST, then hands over the decrypted identity + a pinned relay pubkey, so
 * nothing here ever prompts.
 *
 * P1 keeps the agent-state bridge on the socket-to-self path (cli.ts
 * getAgentState/watchAgentState) — direct dispatch is P3.
 */

import type { Identity, PublicIdentity } from '../../types/identity.js';
import type { ServeEventHandler } from '../../serve/types.js';
import type { AgentStateUpdateDelta, WorkspaceAgentState } from './agent-event-manager.js';
import { SpacesError } from '../../types/errors.js';

export interface ServeRuntimeConfig {
  relayUrl: string;
  /** Pinned by the activator after ITS interactive trust check — mismatch fails. */
  relayPubkey: string;
  machineId: string;
  ownerUserRootId?: string;
  identity: Identity;
  publicIdentity: PublicIdentity;
  bootstrapToken?: string;
  registerPermit?: string;
  enrollmentToken?: string;
  deviceCertificate?: string;
}

export interface ServeRuntimeStatus {
  active: boolean;
  relayUrl?: string;
  relayStatus?: 'connecting' | 'connected' | 'disconnected' | 'reconnecting';
  clients?: number;
  machineId?: string;
  startedAt?: number;
}

/** Injectable seams so the runtime is unit-testable with zero network. */
export interface ServeRuntimeDeps {
  createSessionManager?: (opts: { relay: string; identity: Identity; ownerUserRootId?: string }) => SessionManagerLike;
  connectRelay?: (
    config: ServeRuntimeConfig,
    sessionManager: SessionManagerLike,
    eventHandler: ServeEventHandler,
    lifecycle: { onStop: (stop: () => void) => void },
  ) => Promise<void>;
  getAgentState?: () => Promise<WorkspaceAgentState[]>;
  watchAgentState?: (handlers: {
    onSnapshot: (workspaces: WorkspaceAgentState[]) => void;
    onUpdate: (delta: AgentStateUpdateDelta) => void;
    onDialogRequest: (request: unknown) => void;
    onUIEvent: (event: unknown) => void;
    onError: (error: Error) => void;
  }) => Promise<() => void>;
  log?: (message: string) => void;
}

/** The slice of ClientSessionManager the runtime touches (test seam). */
export interface SessionManagerLike {
  initialize(): Promise<void>;
  onEvent(handler: ServeEventHandler): void;
  broadcastAgentStateUpdate(delta: AgentStateUpdateDelta): Promise<void> | void;
  broadcastRawMessage(message: unknown): Promise<void> | void;
  sendAgentStateSnapshot(connectionId: string, snapshot: Record<string, WorkspaceAgentState>): Promise<void> | void;
  readonly establishedSessionCount: number;
  handleDisconnect?(connectionId: string, reason: string): void;
}

interface ActiveRuntime {
  config: ServeRuntimeConfig;
  sessionManager: SessionManagerLike;
  stopRelay: (() => void) | null;
  stopAgentWatch: (() => void) | null;
  status: ServeRuntimeStatus;
}

let active: ActiveRuntime | null = null;

async function defaultConnectRelay(
  config: ServeRuntimeConfig,
  sessionManager: SessionManagerLike,
  eventHandler: ServeEventHandler,
  lifecycle: { onStop: (stop: () => void) => void },
): Promise<void> {
  const { connectMachineRelay } = await import('../../relay-client/machine-relay-client.js');
  await connectMachineRelay(
    config.relayUrl,
    config.machineId,
    config.publicIdentity,
    sessionManager as never,
    eventHandler,
    // Non-interactive trust: the activator pinned the pubkey; anything else fails.
    async (_url, relayPublicKey) => {
      if (relayPublicKey !== config.relayPubkey) {
        return { trusted: false, reason: `Relay key mismatch (expected ${config.relayPubkey.slice(0, 12)}…, got ${relayPublicKey.slice(0, 12)}…) — re-run gssh machine serve start` } as never;
      }
      return { trusted: true } as never;
    },
    config.identity.signing.secretKey.slice(0, 32),
    config.relayPubkey,
    config.bootstrapToken,
    config.registerPermit,
    config.enrollmentToken,
    config.deviceCertificate,
    lifecycle,
  );
}

export async function activateServeRuntime(config: ServeRuntimeConfig, deps: ServeRuntimeDeps = {}): Promise<ServeRuntimeStatus> {
  if (active) {
    throw new SpacesError(`Serve runtime already active (relay ${active.config.relayUrl}) — deactivate first.`, 'USER_ERROR', 1);
  }
  const log = deps.log ?? ((m: string) => console.error(`[serve-runtime] ${m}`));

  const createSessionManager = deps.createSessionManager ?? ((opts) => {
    const { ClientSessionManager } = require('../../serve/client-session-manager.js') as typeof import('../../serve/client-session-manager.js');
    return new ClientSessionManager(opts) as unknown as SessionManagerLike;
  });

  const runtime: ActiveRuntime = {
    config,
    sessionManager: createSessionManager({ relay: config.relayUrl, identity: config.identity, ownerUserRootId: config.ownerUserRootId }),
    stopRelay: null,
    stopAgentWatch: null,
    status: { active: true, relayUrl: config.relayUrl, relayStatus: 'connecting', clients: 0, machineId: config.machineId, startedAt: Date.now() },
  };
  active = runtime;

  try {
    await runtime.sessionManager.initialize();

    // Agent-state bridge (socket-to-self in P1): keep a live snapshot for
    // newly authenticated clients + fan deltas out to connected ones.
    let currentAgentSnapshot: Record<string, WorkspaceAgentState> = {};
    const cliMod = await import('./cli.js');
    const getAgentState = deps.getAgentState ?? cliMod.getAgentState;
    const watchAgentState = deps.watchAgentState ?? (cliMod.watchAgentState as NonNullable<ServeRuntimeDeps['watchAgentState']>);
    const { applyAgentDeltaToAgentState } = await import('./agent-state-reducer.js');

    currentAgentSnapshot = Object.fromEntries((await getAgentState()).map((w) => [w.workspaceId, w]));
    runtime.stopAgentWatch = await watchAgentState({
      onSnapshot: (workspaces) => {
        currentAgentSnapshot = Object.fromEntries(workspaces.map((w) => [w.workspaceId, w]));
      },
      onUpdate: (delta) => {
        currentAgentSnapshot = applyAgentDeltaToAgentState(currentAgentSnapshot, delta);
        void runtime.sessionManager.broadcastAgentStateUpdate(delta);
      },
      onDialogRequest: (request) => {
        void runtime.sessionManager.broadcastRawMessage({ type: 'agent_dialog_request', request });
      },
      onUIEvent: (event) => {
        void runtime.sessionManager.broadcastRawMessage({ type: 'agent_ui_event', event });
      },
      onError: (error) => log(`agent watch failed: ${error.message}`),
    });

    const eventHandler: ServeEventHandler = (event) => {
      switch (event.type) {
        case 'relay_connected':
          runtime.status.relayStatus = 'connected';
          break;
        case 'relay_disconnected':
          runtime.status.relayStatus = 'disconnected';
          break;
        case 'relay_reconnecting':
          runtime.status.relayStatus = 'reconnecting';
          break;
        case 'client_authenticated':
          runtime.status.clients = runtime.sessionManager.establishedSessionCount;
          if (Object.keys(currentAgentSnapshot).length > 0) {
            void runtime.sessionManager.sendAgentStateSnapshot((event as { connectionId: string }).connectionId, currentAgentSnapshot);
          }
          break;
        case 'client_disconnected':
          runtime.status.clients = runtime.sessionManager.establishedSessionCount;
          break;
      }
    };
    runtime.sessionManager.onEvent(eventHandler);

    const connectRelay = deps.connectRelay ?? defaultConnectRelay;
    await connectRelay(config, runtime.sessionManager, eventHandler, {
      onStop: (stop) => { runtime.stopRelay = stop; },
    });
    runtime.status.relayStatus = 'connected';
    log(`activated — relay ${config.relayUrl}, machine ${config.machineId}`);
    return { ...runtime.status };
  } catch (error) {
    // Fail closed: never leave a half-activated runtime behind.
    await deactivateServeRuntime().catch(() => undefined);
    throw error instanceof SpacesError ? error : new SpacesError(
      `serve activation failed: ${error instanceof Error ? error.message : String(error)}`,
      'SYSTEM_ERROR',
      2,
    );
  }
}

export async function deactivateServeRuntime(): Promise<ServeRuntimeStatus> {
  const runtime = active;
  active = null;
  if (!runtime) return { active: false };
  try { runtime.stopRelay?.(); } catch { /* already closed */ }
  try { runtime.stopAgentWatch?.(); } catch { /* already stopped */ }
  return { active: false };
}

export function getServeRuntimeStatus(): ServeRuntimeStatus {
  return active ? { ...active.status } : { active: false };
}

/** The activated machine identity/config — share-link minting signs with the
 *  REGISTERED machine key so the relay can verify against its registry.
 *  Null when serve is inactive (no public surface = no links, by design). */
export function getActiveServeContext(): { identity: Identity; machineId: string; relayUrl: string } | null {
  return active ? { identity: active.config.identity, machineId: active.config.machineId, relayUrl: active.config.relayUrl } : null;
}
