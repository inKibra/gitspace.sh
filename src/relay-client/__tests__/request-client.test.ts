/**
 * Tests for RelayRequestClient.sendRequest.
 *
 * All tests use a fake in-process socket adapter — no real network.
 */

import { describe, expect, test } from 'bun:test';
import { RelayRequestClient, type RelayRequestClientOptions } from '../request-client.js';
import type { RelaySocketAdapter, RelaySocketHandlers } from '../machine-directory-client.js';

// ── fake socket infrastructure ────────────────────────────────────────────────

interface FakeSocket {
  url: string;
  sent: string[];
  readyState: number;
  handlers: RelaySocketHandlers | null;
}

const OPEN = 1;
const CLOSED = 3;

function createFakeAdapter(
  sockets: FakeSocket[]
): RelaySocketAdapter<FakeSocket> {
  return {
    createSocket: (url: string) => {
      const socket: FakeSocket = { url, sent: [], readyState: 0, handlers: null };
      sockets.push(socket);
      return socket;
    },
    setHandlers: (socket, handlers) => { socket.handlers = handlers; },
    clearHandlers: (socket) => { socket.handlers = null; },
    send: (socket, data) => { socket.sent.push(data); },
    close: (socket) => {
      socket.readyState = CLOSED;
      socket.handlers?.onClose();
    },
    getReadyState: (socket) => socket.readyState,
    getOpenReadyStateValue: () => OPEN,
  };
}

function buildClient(
  sockets: FakeSocket[],
  extra: Partial<RelayRequestClientOptions<FakeSocket>> = {}
): RelayRequestClient<FakeSocket> {
  return new RelayRequestClient<FakeSocket>({
    relayUrl: 'ws://localhost:4480/ws',
    socketAdapter: createFakeAdapter(sockets),
    timeoutMs: 100,
    ...extra,
  });
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('RelayRequestClient.sendRequest', () => {
  test('sends payload on open and resolves when onMessage returns non-null', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'ping', seq: 1 }),
      (msg) => msg.type === 'pong' ? { pong: true } : null,
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();

    // Simulate server response
    socket.handlers!.onMessage(JSON.stringify({ type: 'pong' }));

    const result = await requestPromise;
    expect(result).toEqual({ pong: true });

    // Payload was sent
    expect(socket.sent).toHaveLength(1);
    const sent = JSON.parse(socket.sent[0]);
    expect(sent.type).toBe('ping');
    expect(sent.seq).toBe(1);
  });

  test('rejects with timeout error when server does not respond within timeoutMs', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets, { timeoutMs: 50 });

    const requestPromise = client.sendRequest(
      () => ({ type: 'ping' }),
      (_msg) => null,  // never matches → timeout
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();

    // Do NOT send any matching response — let timeout fire

    await expect(requestPromise).rejects.toThrow(/timed out/i);
  });

  test('rejects with relay error when server sends error message', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'list_machines' }),
      (_msg) => null,
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();

    socket.handlers!.onMessage(JSON.stringify({
      type: 'error',
      code: 'UNAUTHORIZED',
      message: 'Access denied',
    }));

    await expect(requestPromise).rejects.toThrow(/\[UNAUTHORIZED\].*access denied/i);
  });

  test('rejects when relay closes connection before request completes', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'list_machines' }),
      (_msg) => null,
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();

    // Close without sending a response
    socket.readyState = CLOSED;
    socket.handlers!.onClose();

    await expect(requestPromise).rejects.toThrow(/closed connection before request completed/i);
  });

  test('rejects on socket error', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'list_machines' }),
      (_msg) => null,
    );

    const socket = sockets[0];
    socket.handlers!.onError(new Error('Network unreachable'));

    await expect(requestPromise).rejects.toThrow(/network unreachable/i);
  });

  test('ignores messages that do not match (onMessage returns null) and stays pending', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets, { timeoutMs: 200 });

    const matches: unknown[] = [];
    const requestPromise = client.sendRequest(
      () => ({ type: 'ping' }),
      (msg) => {
        if (msg.type === 'pong') { matches.push(msg); return msg; }
        return null;
      },
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();

    // Send non-matching message first
    socket.handlers!.onMessage(JSON.stringify({ type: 'info', data: 'ignored' }));
    expect(matches).toHaveLength(0);

    // Then send matching response
    socket.handlers!.onMessage(JSON.stringify({ type: 'pong', ts: 999 }));

    const result = await requestPromise;
    expect(result).toMatchObject({ type: 'pong' });
    expect(matches).toHaveLength(1);
  });

  test('does not call fail or succeed twice (idempotent finish)', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'ping' }),
      (msg) => msg.type === 'pong' ? 'done' : null,
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();

    // Succeed with first message
    socket.handlers!.onMessage(JSON.stringify({ type: 'pong' }));

    // Then close — should NOT double-reject
    socket.readyState = CLOSED;
    socket.handlers?.onClose();

    // Should still resolve cleanly
    const result = await requestPromise;
    expect(result).toBe('done');
  });

  test('appends role=client to the relay URL', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'ping' }),
      (msg) => msg.type === 'pong' ? 'ok' : null,
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    socket.handlers!.onMessage(JSON.stringify({ type: 'pong' }));
    await requestPromise;

    expect(socket.url).toContain('role=client');
  });

  test('cleans up socket (closes and clears handlers) after success', async () => {
    const sockets: FakeSocket[] = [];
    const client = buildClient(sockets);

    const requestPromise = client.sendRequest(
      () => ({ type: 'ping' }),
      (msg) => msg.type === 'pong' ? 'ok' : null,
    );

    const socket = sockets[0];
    socket.readyState = OPEN;
    socket.handlers!.onOpen();
    socket.handlers!.onMessage(JSON.stringify({ type: 'pong' }));
    await requestPromise;

    // clearHandlers was called → handlers null, socket closed
    expect(socket.handlers).toBeNull();
    expect(socket.readyState).toBe(CLOSED);
  });
});
