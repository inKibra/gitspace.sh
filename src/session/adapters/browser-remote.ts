import type {
  RemoteSessionCryptoAdapter,
  RemoteSessionHandshakeAdapter,
  RemoteSessionSocketAdapter,
} from '../backends/remote-session-backend.js'
import { SpacesError } from '../../types/errors.js'

const DEFAULT_CONTROL_STREAM_ID = 1

export type BrowserRemoteSocket = WebSocket

export const browserRemoteSocketAdapter: RemoteSessionSocketAdapter<WebSocket> = {
  setHandlers: (socket, handlers) => {
    socket.onopen = handlers.onOpen
    socket.onclose = handlers.onClose
    socket.onmessage = (event) => {
      handlers.onMessage(String(event.data))
    }
    socket.onerror = () => {
      handlers.onError(new SpacesError('Connection failed', 'SYSTEM_ERROR', 2))
    }
  },
  clearHandlers: (socket) => {
    socket.onopen = null
    socket.onclose = null
    socket.onmessage = null
    socket.onerror = null
  },
  send: (socket, data) => socket.send(data),
  close: (socket) => socket.close(),
  getReadyState: (socket) => socket.readyState,
  getOpenReadyStateValue: () => WebSocket.OPEN,
}

export interface BrowserRemoteFrameCodec {
  masterStreamId: number
  createFrame: (streamId: number, data: Uint8Array, key: Uint8Array) => Promise<Uint8Array>
  openFrame: (
    frame: Uint8Array,
    key: Uint8Array
  ) => Promise<{ streamId: number; data: Uint8Array } | null>
}

function encodeBase64(data: Uint8Array): string {
  const chunkSize = 0x8000
  let binary = ''
  for (let index = 0; index < data.length; index += chunkSize) {
    const chunk = data.subarray(index, index + chunkSize)
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function createBrowserRemoteCryptoAdapter(
  codec: BrowserRemoteFrameCodec,
  options: { controlStreamId?: number } = {}
): RemoteSessionCryptoAdapter {
  return {
    masterStreamId: codec.masterStreamId,
    controlStreamId: options.controlStreamId ?? DEFAULT_CONTROL_STREAM_ID,
    createFrame: codec.createFrame,
    openFrame: codec.openFrame,
    encodeBase64,
    decodeBase64,
  }
}

export function createBrowserRemoteHandshakeAdapter<
  THandshakeState,
  TServerHello,
  TServerAuth,
>(
  adapter: RemoteSessionHandshakeAdapter<THandshakeState, TServerHello, TServerAuth>
): RemoteSessionHandshakeAdapter<THandshakeState, TServerHello, TServerAuth> {
  return adapter
}

export function deriveRelayUrlFromBrowserSocket(socket: Pick<WebSocket, 'url'>): string {
  let parsedUrl: URL
  try {
    parsedUrl = new URL(socket.url)
  } catch {
    throw new SpacesError(
      `Unable to derive relay URL from socket URL: ${socket.url}`,
      'SYSTEM_ERROR',
      2
    )
  }
  parsedUrl.search = ''
  parsedUrl.hash = ''
  return parsedUrl.toString()
}
