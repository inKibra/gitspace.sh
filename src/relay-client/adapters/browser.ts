import type { RelaySocketAdapter } from '../machine-directory-client.js';

export type BrowserRelaySocket = WebSocket;

export const browserRelaySocketAdapter: RelaySocketAdapter<WebSocket> = {
  createSocket: (url) => new WebSocket(url),
  setHandlers: (socket, handlers) => {
    socket.onopen = handlers.onOpen;
    socket.onclose = handlers.onClose;
    socket.onmessage = (event) => {
      handlers.onMessage(String(event.data));
    };
    socket.onerror = () => {
      handlers.onError(new Error('Connection failed'));
    };
  },
  clearHandlers: (socket) => {
    socket.onopen = null;
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;
  },
  send: (socket, data) => socket.send(data),
  close: (socket) => socket.close(),
  getReadyState: (socket) => socket.readyState,
  getOpenReadyStateValue: () => WebSocket.OPEN,
};
