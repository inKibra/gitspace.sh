/**
 * Host-UI dialog delivery routing (ticket #43).
 *
 * The serve+relay app dropped every agent ask/host-UI dialog because the
 * daemon only delivered to a same-socket owner (a socket that both attached the
 * agent session and watched agent-state). In that app those are different
 * sockets, so no owner was found and the coordinator cancelled the dialog.
 *
 * These tests pin the fix: with no same-socket owner the dialog falls back to
 * the agent-state watcher conduit and resolves by dialogId from any command
 * socket, while the direct-router same-socket path keeps its strict ownership.
 */

import { describe, expect, test } from 'bun:test';
import {
  deliverDialogRequest,
  isDialogResponseAuthorized,
  type DialogDeliveryHooks,
} from '../agent-dialog-delivery.js';
import type { HostUIDialogRequest } from '../agents/host-ui-bridge.js';

function makeRequest(overrides: Partial<HostUIDialogRequest> = {}): HostUIDialogRequest {
  return {
    type: 'select',
    id: 'dlg-1',
    sessionId: 'sess-1',
    title: 'pick a color',
    options: ['red', 'green', 'blue'],
    ...overrides,
  } as HostUIDialogRequest;
}

interface Harness {
  owners: Map<string, object>;
  conduitDelivered: Set<string>;
  sent: Array<{ socket: object; request: HostUIDialogRequest }>;
  watcherErrors: object[];
  sameSocketErrors: object[];
  hooks: DialogDeliveryHooks;
}

function makeHarness(opts: {
  owner?: object | null;
  watchers?: object[];
  failSendFor?: Set<object>;
}): Harness {
  const owners = new Map<string, object>();
  const conduitDelivered = new Set<string>();
  const sent: Array<{ socket: object; request: HostUIDialogRequest }> = [];
  const watcherErrors: object[] = [];
  const sameSocketErrors: object[] = [];
  const failSendFor = opts.failSendFor ?? new Set<object>();
  const hooks: DialogDeliveryHooks = {
    pickSameSocketOwner: () => opts.owner ?? null,
    watchers: () => opts.watchers ?? [],
    send: (socket, request) => {
      if (failSendFor.has(socket)) throw new Error('socket write failed');
      sent.push({ socket, request });
    },
    setOwner: (dialogId, socket) => owners.set(dialogId, socket),
    markConduitDelivered: (dialogId) => conduitDelivered.add(dialogId),
    onSameSocketError: (socket) => sameSocketErrors.push(socket),
    onWatcherError: (socket) => watcherErrors.push(socket),
  };
  return { owners, conduitDelivered, sent, watcherErrors, sameSocketErrors, hooks };
}

describe('deliverDialogRequest', () => {
  test('conduit fallback: no same-socket owner routes to every agent-state watcher and marks conduit-delivered', () => {
    const w1 = { id: 'watcher-1' };
    const w2 = { id: 'watcher-2' };
    const h = makeHarness({ owner: null, watchers: [w1, w2] });
    const request = makeRequest();

    deliverDialogRequest(request, h.hooks);

    expect(h.sent.map((s) => s.socket)).toEqual([w1, w2]);
    expect(h.conduitDelivered.has('dlg-1')).toBe(true);
    // No same-socket owner is recorded for conduit delivery.
    expect(h.owners.size).toBe(0);
  });

  test('conduit-delivered dialog resolves by dialogId from ANY command socket (not the watcher)', () => {
    const watcher = { id: 'watcher' };
    const h = makeHarness({ owner: null, watchers: [watcher] });
    deliverDialogRequest(makeRequest(), h.hooks);

    // The app answers over a fresh command socket, distinct from the watcher.
    const freshCommandSocket = { id: 'fresh-command-socket' };
    expect(
      isDialogResponseAuthorized('dlg-1', freshCommandSocket, h.owners, h.conduitDelivered),
    ).toBe(true);
  });

  test('same-socket path: delivers to the owner and records ownership', () => {
    const owner = { id: 'owner-socket' };
    const h = makeHarness({ owner, watchers: [{ id: 'other-watcher' }] });
    deliverDialogRequest(makeRequest(), h.hooks);

    expect(h.sent).toEqual([{ socket: owner, request: makeRequest() }]);
    expect(h.owners.get('dlg-1')).toBe(owner);
    expect(h.conduitDelivered.size).toBe(0);
  });

  test('same-socket dialog may only be answered by its owning socket', () => {
    const owner = { id: 'owner-socket' };
    const h = makeHarness({ owner });
    deliverDialogRequest(makeRequest(), h.hooks);

    expect(isDialogResponseAuthorized('dlg-1', owner, h.owners, h.conduitDelivered)).toBe(true);
    expect(
      isDialogResponseAuthorized('dlg-1', { id: 'someone-else' }, h.owners, h.conduitDelivered),
    ).toBe(false);
  });

  test('no owner and no watcher throws so the coordinator cancels the dialog', () => {
    const h = makeHarness({ owner: null, watchers: [] });
    expect(() => deliverDialogRequest(makeRequest(), h.hooks)).toThrow(/No watching client/);
    expect(h.conduitDelivered.size).toBe(0);
  });

  test('a failing watcher is dropped but delivery still succeeds via a live watcher', () => {
    const dead = { id: 'dead-watcher' };
    const live = { id: 'live-watcher' };
    const h = makeHarness({ owner: null, watchers: [dead, live], failSendFor: new Set([dead]) });

    deliverDialogRequest(makeRequest(), h.hooks);

    expect(h.watcherErrors).toEqual([dead]);
    expect(h.sent.map((s) => s.socket)).toEqual([live]);
    expect(h.conduitDelivered.has('dlg-1')).toBe(true);
  });

  test('same-socket send failure clears poisoned state and rethrows', () => {
    const owner = { id: 'owner-socket' };
    const h = makeHarness({ owner, failSendFor: new Set([owner]) });

    expect(() => deliverDialogRequest(makeRequest(), h.hooks)).toThrow(/socket write failed/);
    expect(h.sameSocketErrors).toEqual([owner]);
    expect(h.conduitDelivered.size).toBe(0);
  });
});

describe('isDialogResponseAuthorized', () => {
  test('unknown dialog (never delivered) is unauthorized', () => {
    expect(
      isDialogResponseAuthorized('ghost', { id: 's' }, new Map(), new Set()),
    ).toBe(false);
  });

  test('conduit membership beats socket identity', () => {
    const conduit = new Set(['dlg-9']);
    expect(isDialogResponseAuthorized('dlg-9', { id: 'anything' }, new Map(), conduit)).toBe(true);
  });
});
