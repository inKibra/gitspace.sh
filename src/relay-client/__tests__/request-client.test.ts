import { describe, expect, it } from 'bun:test';
import { RelayRequestClient, RelayRequestError } from '../request-client.js';
import type {
  RelaySocketAdapter,
  RelaySocketHandlers,
} from '../machine-directory-client.js';

interface FakeSocket {
  readyState: number;
  sent: string[];
  handlers: RelaySocketHandlers | null;
}

const OPEN = 1;
const CLOSED = 3;

function createFakeAdapter(holder: { socket: FakeSocket | null }): RelaySocketAdapter<FakeSocket> {
  return {
    createSocket: () => {
      const socket: FakeSocket = {
        readyState: 0,
        sent: [],
        handlers: null,
      };
      holder.socket = socket;
      return socket;
    },
    setHandlers: (socket, handlers) => {
      socket.handlers = handlers;
    },
    clearHandlers: (socket) => {
      socket.handlers = null;
    },
    send: (socket, data) => {
      socket.sent.push(data);
    },
    close: (socket) => {
      socket.readyState = CLOSED;
      socket.handlers?.onClose();
    },
    getReadyState: (socket) => socket.readyState,
    getOpenReadyStateValue: () => OPEN,
  };
}

describe('RelayRequestClient', () => {
  it('throws structured RelayRequestError for relay error messages', async () => {
    const holder = { socket: null as FakeSocket | null };

    const client = new RelayRequestClient<FakeSocket>({
      relayUrl: 'ws://localhost:4480/ws',
      socketAdapter: createFakeAdapter(holder),
      timeoutMs: 250,
    });

    const promise = client.sendRequest(
      () => ({ type: 'example' }),
      () => null,
    );

    const socket = holder.socket!;
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    socket.handlers!.onMessage(JSON.stringify({
      type: 'error',
      code: 'CONFLICT',
      message: 'revision mismatch',
    }));

    await expect(promise).rejects.toBeInstanceOf(RelayRequestError);
    await expect(promise).rejects.toMatchObject({
      code: 'CONFLICT',
      relayMessage: 'revision mismatch',
    });
  });

  it('resolves when parser returns a value', async () => {
    const holder = { socket: null as FakeSocket | null };

    const client = new RelayRequestClient<FakeSocket>({
      relayUrl: 'ws://localhost:4480/ws',
      socketAdapter: createFakeAdapter(holder),
      timeoutMs: 250,
    });

    const promise = client.sendRequest(
      () => ({ type: 'ping' }),
      (msg) => (msg.type === 'pong' ? 'ok' : null),
    );

    const socket = holder.socket!;
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    socket.handlers!.onMessage(JSON.stringify({ type: 'pong' }));

    await expect(promise).resolves.toBe('ok');
  });
});
