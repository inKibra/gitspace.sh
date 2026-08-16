import type {
  RemoteSessionCryptoAdapter,
  RemoteSessionHandshakeAdapter,
  RemoteSessionSocketAdapter,
} from '../backends/remote-session-backend.js'
import { SpacesError } from '../../types/errors.js'

const DEFAULT_CONTROL_STREAM_ID = 1

export type BrowserRemoteSocket = WebSocket

const HIGH_WATER_BYTES = 512 * 1024
const LOW_WATER_BYTES = 256 * 1024

interface SendQueueState {
  control: string[]
  bulk: string[]
  timer: ReturnType<typeof setTimeout> | null
}

const sendQueues = new WeakMap<WebSocket, SendQueueState>()

function getSendQueue(socket: WebSocket): SendQueueState {
  let queue = sendQueues.get(socket)
  if (!queue) {
    queue = { control: [], bulk: [], timer: null }
    sendQueues.set(socket, queue)
  }
  return queue
}

function clearSendQueue(socket: WebSocket): void {
  const queue = sendQueues.get(socket)
  if (!queue) return
  if (queue.timer) clearTimeout(queue.timer)
  sendQueues.delete(socket)
}

function isControlPayload(data: string): boolean {
  try {
    const message = JSON.parse(data) as { priority?: string; type?: string }
    if (message.priority === 'bulk') return false
    if (message.priority === 'control') return true
    return message.type !== 'pty_input'
  } catch {
    return true
  }
}

function pumpSendQueue(socket: WebSocket): void {
  const queue = getSendQueue(socket)
  queue.timer = null
  while (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= LOW_WATER_BYTES) {
    const next = queue.control.shift() ?? queue.bulk.shift()
    if (!next) return
    socket.send(next)
  }
  if (queue.control.length > 0 || queue.bulk.length > 0) {
    queue.timer = setTimeout(() => pumpSendQueue(socket), 8)
  }
}

function enqueueSend(socket: WebSocket, data: string): void {
  const queue = getSendQueue(socket)
  if (isControlPayload(data)) queue.control.push(data)
  else queue.bulk.push(data)
  if (!queue.timer) queue.timer = setTimeout(() => pumpSendQueue(socket), 0)
}

function sendWithBackpressure(socket: WebSocket, data: string): void {
  const queue = getSendQueue(socket)
  if (socket.readyState !== WebSocket.OPEN) return
  if (socket.bufferedAmount <= HIGH_WATER_BYTES && queue.control.length === 0 && queue.bulk.length === 0) {
    socket.send(data)
    return
  }
  enqueueSend(socket, data)
}

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
    clearSendQueue(socket)
  },
  send: (socket, data) => sendWithBackpressure(socket, data),
  close: (socket) => {
    clearSendQueue(socket)
    socket.close()
  },
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
