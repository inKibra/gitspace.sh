import { describe, expect, it } from 'bun:test';
import { PiCoordinator } from '../pi-coordinator.js';
import type { HostUIBridgeEmitter, HostUIDialogRequest } from '../host-ui-bridge.js';

// BUG B: a dialog that fired while a client was disconnected must be re-pushed on
// reconnect so the client re-renders it. The coordinator retains the full pending
// request (same dialogId); serve-runtime's connect-time catch-up reads it via
// getPendingDialogRequests() and re-broadcasts it.

function recordingEmitter(): { emitter: HostUIBridgeEmitter; dialogs: HostUIDialogRequest[]; events: unknown[] } {
  const dialogs: HostUIDialogRequest[] = [];
  const events: unknown[] = [];
  return {
    dialogs,
    events,
    emitter: {
      emitDialogRequest: (request) => { dialogs.push(request); },
      emitEvent: (event) => { events.push(event); },
    },
  };
}

const SELECT_REQUEST: HostUIDialogRequest = {
  type: 'select', id: 'dlg-1', sessionId: 'sess-A', title: 'Pick a color', options: ['red', 'green', 'blue'],
};

function fire(coord: PiCoordinator, request: HostUIDialogRequest): void {
  (coord as unknown as { handleDialogRequest(r: HostUIDialogRequest): void }).handleDialogRequest(request);
}

describe('PiCoordinator pending-dialog catch-up (BUG B)', () => {
  it('retains a fired dialog with its ORIGINAL dialogId for connect-time catch-up', () => {
    const coord = new PiCoordinator();
    const { emitter, dialogs } = recordingEmitter();
    coord.setHostUIEmitter(emitter);

    // A dialog fires (the sink funnels every host dialog through handleDialogRequest).
    fire(coord, SELECT_REQUEST);
    expect(dialogs).toHaveLength(1); // original live broadcast

    // A freshly connected client catches up by reading the retained request.
    const pending = coord.getPendingDialogRequests();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe('dlg-1');
    expect(pending[0]).toEqual(SELECT_REQUEST);
  });

  it('stops reporting a dialog once it has been answered', async () => {
    const coord = new PiCoordinator();
    const { emitter } = recordingEmitter();
    coord.setHostUIEmitter(emitter);
    fire(coord, SELECT_REQUEST);
    expect(coord.getPendingDialogRequests()).toHaveLength(1);

    // Client answered — no host is registered here so it resolves to false, but
    // the pending-request tracking is cleared regardless (first valid wins).
    await coord.resolveDialogResponse({ type: 'select', id: 'dlg-1', value: 'green' });

    expect(coord.getPendingDialogRequests()).toHaveLength(0);
  });

  it('reports pending dialogs across multiple sessions', () => {
    const coord = new PiCoordinator();
    const { emitter } = recordingEmitter();
    coord.setHostUIEmitter(emitter);
    fire(coord, SELECT_REQUEST);
    fire(coord, { type: 'confirm', id: 'dlg-2', sessionId: 'sess-B', title: 'OK?', message: 'Proceed?' });

    const pending = coord.getPendingDialogRequests();
    expect(pending.map((r) => r.id).sort()).toEqual(['dlg-1', 'dlg-2']);
  });
});
