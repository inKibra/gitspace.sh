import WebSocket from 'ws';
import type {
  Identity,
  X3DHResponseMessage,
  X3DHResultMessage,
} from '../../types/identity.js';
import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processServerAuth,
  type X3DHClientState,
} from '../../lib/tmux-lite/crypto/handshake.js';
import {
  createFrame as createEncryptedFrame,
  openFrame as openEncryptedFrame,
  MASTER_STREAM_ID,
} from '../../lib/tmux-lite/crypto/frames.js';
import { signMessage } from '../../relay/signing.js';
import type {
  RemoteSessionCryptoAdapter,
  RemoteSessionHandshakeAdapter,
  RemoteSessionSocketAdapter,
} from '../backends/remote-session-backend.js';

const CONTROL_STREAM_ID = 1;

export type NodeRemoteSocket = WebSocket;

export const nodeRemoteSocketAdapter: RemoteSessionSocketAdapter<WebSocket> = {
  setHandlers: (socket, handlers) => {
    socket.on('open', handlers.onOpen);
    socket.on('close', (code, reason) => {
      handlers.onClose({
        code,
        reason: typeof reason === 'string' ? reason : reason?.toString() || '',
      });
    });
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

export const nodeRemoteCryptoAdapter: RemoteSessionCryptoAdapter = {
  masterStreamId: MASTER_STREAM_ID,
  controlStreamId: CONTROL_STREAM_ID,
  createFrame: async (streamId, data, key) => {
    const frame = createEncryptedFrame(streamId, Buffer.from(data), key);
    return new Uint8Array(frame);
  },
  openFrame: async (frame, key) => {
    const result = openEncryptedFrame(Buffer.from(frame), key);
    if (!result) {
      return null;
    }
    return {
      streamId: result.streamId,
      data: new Uint8Array(result.data),
    };
  },
  encodeBase64: (data) => Buffer.from(data).toString('base64'),
  decodeBase64: (base64) => new Uint8Array(Buffer.from(base64, 'base64')),
};

function isServerHello(data: unknown): data is X3DHResponseMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const value = data as Record<string, unknown>;
  return (
    typeof value.version === 'number' &&
    typeof value.identityKey === 'string' &&
    typeof value.keyExchangeKey === 'string' &&
    typeof value.ephemeralKey === 'string' &&
    typeof value.signedPreKey === 'string' &&
    typeof value.preKeySignature === 'string' &&
    typeof value.serverNonce === 'string' &&
    typeof value.timestamp === 'number'
  );
}

function isServerAuth(data: unknown): data is X3DHResultMessage {
  if (!data || typeof data !== 'object') {
    return false;
  }
  const value = data as Record<string, unknown>;
  if (
    typeof value.version !== 'number' ||
    typeof value.identityKey !== 'string' ||
    typeof value.identityProof !== 'string'
  ) {
    return false;
  }
  const result = value.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== 'object' || typeof result.type !== 'string') {
    return false;
  }
  if (result.type === 'accepted') {
    return result.accessType === 'full' || result.accessType === 'view';
  }
  if (result.type === 'rejected') {
    return typeof result.reason === 'string';
  }
  return false;
}

export const nodeRemoteHandshakeAdapter: RemoteSessionHandshakeAdapter<
  X3DHClientState,
  X3DHResponseMessage,
  X3DHResultMessage
> = {
  createClientHello,
  isServerHello,
  processServerHello,
  createClientAuth,
  isServerAuth,
  processServerAuth,
};

export function createNodeRelaySigner(identity: Identity) {
  return <T extends object>(message: T): T => {
    const privateKey = identity.signing.secretKey.slice(0, 32);
    return signMessage(message, privateKey, identity.signing.publicKey);
  };
}
