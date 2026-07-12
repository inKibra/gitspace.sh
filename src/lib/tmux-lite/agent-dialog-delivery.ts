/**
 * Host-UI dialog delivery routing (ticket #43).
 *
 * The daemon's coordinator emits a dialog request (agent `ask`, host-UI
 * `select`, etc.) that must reach the client driving the agent session. There
 * are two client topologies and this module picks the right one:
 *
 *   (a) Direct router/CLI/TUI client — one socket both attaches the agent
 *       session AND watches agent-state. The dialog is delivered straight to
 *       that socket and only it may answer (same-socket ownership).
 *
 *   (b) serve+relay app — the socket that attaches the agent session is a
 *       command socket, NOT itself an agent-state watcher. The app consumes
 *       agent-state over its own dedicated watch conduit whose onDialogRequest
 *       broadcasts `agent_dialog_request` to browsers. So when there is no
 *       same-socket owner, fall back to broadcasting the dialog over every
 *       agent-state watcher and mark it conduit-delivered — its response then
 *       resolves by dialogId from whatever command socket the app answers on.
 *
 * Extracted from server.ts so it is unit-testable: importing server.ts boots a
 * daemon (listeners, schedulers), which is not viable in a unit test.
 */

import type { HostUIDialogRequest } from './agents/host-ui-bridge.js';

export interface DialogDeliveryHooks {
  /** The socket that both attached the agent session AND watches agent-state
   *  (path a), or null when the attach owner is not itself a watcher (path b). */
  pickSameSocketOwner: (sessionId: string) => object | null;
  /** All agent-state watcher sockets (the serve-runtime conduit lives here). */
  watchers: () => Iterable<object>;
  /** Write an `agent-dialog-request` router message to a socket. */
  send: (socket: object, request: HostUIDialogRequest) => void;
  /** Record dialogId → owning socket for same-socket delivery (path a). */
  setOwner: (dialogId: string, socket: object) => void;
  /** Mark a dialog as delivered over the watcher conduit (path b). */
  markConduitDelivered: (dialogId: string) => void;
  /** Same-socket send failed — clear the poisoned owner/socket state. */
  onSameSocketError: (socket: object, request: HostUIDialogRequest) => void;
  /** A watcher send failed — drop that watcher from routing. */
  onWatcherError: (socket: object) => void;
}

/**
 * Deliver a host-UI dialog request to a client. Throws when neither path can
 * deliver (no owner and no live watcher) so the coordinator cancels the dialog
 * and unblocks the extension.
 */
export function deliverDialogRequest(request: HostUIDialogRequest, hooks: DialogDeliveryHooks): void {
  // Path (a): a same-socket owner (attached + watching) answers directly.
  const owner = hooks.pickSameSocketOwner(request.sessionId);
  if (owner) {
    try {
      hooks.setOwner(request.id, owner);
      hooks.send(owner, request);
      return;
    } catch (error) {
      hooks.onSameSocketError(owner, request);
      throw error instanceof Error ? error : new Error(String(error));
    }
  }
  // Path (b): conduit fallback — broadcast over every agent-state watcher.
  let delivered = false;
  for (const watcher of hooks.watchers()) {
    try {
      hooks.send(watcher, request);
      delivered = true;
    } catch {
      hooks.onWatcherError(watcher);
    }
  }
  if (!delivered) {
    throw new Error(`No watching client for session ${request.sessionId}`);
  }
  hooks.markConduitDelivered(request.id);
}

/**
 * Whether an `agent-dialog-response` for `dialogId` arriving on `socket` may
 * resolve the pending dialog. Conduit-delivered dialogs (path b) resolve by
 * dialogId from any command socket; same-socket dialogs (path a) only from the
 * socket they were delivered to.
 */
export function isDialogResponseAuthorized(
  dialogId: string,
  socket: object,
  owners: Map<string, object>,
  conduitDelivered: Set<string>,
): boolean {
  if (conduitDelivered.has(dialogId)) return true;
  const owner = owners.get(dialogId);
  return owner !== undefined && owner === socket;
}
