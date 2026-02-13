import WebSocket from 'ws';
import type { RelaySocketAdapter } from '../machine-directory-client.js';

export type NodeRelaySocket = WebSocket;

export const nodeRelaySocketAdapter: RelaySocketAdapter<WebSocket> = {
  createSocket: (url) => new WebSocket(url),
  setHandlers: (socket, handlers) => {
    socket.on('open', handlers.onOpen);
    socket.on('close', handlers.onClose);
    socket.on('message', (data) => {
      const raw = typeof data === 'string' ? data : data.toString();
      handlers.onMessage(raw);
    });
    socket.on('error', (error) => {
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    });
  },
  clearHandlers: (socket) => {
    socket.removeAllListeners('open');
    socket.removeAllListeners('close');
    socket.removeAllListeners('message');
    socket.removeAllListeners('error');
  },
  send: (socket, data) => socket.send(data),
  close: (socket) => socket.close(),
  getReadyState: (socket) => socket.readyState,
  getOpenReadyStateValue: () => WebSocket.OPEN,
};
