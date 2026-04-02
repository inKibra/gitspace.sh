import type { Identity } from '../../types/identity.js'
import type { KeyValueStorage } from '../../sdk/engine/types.js'
import type { X3DHClientState, X3DHResponseMessage, X3DHResultMessage } from '../../session/crypto/handshake.web.js'
import {
  createClientHello,
  processServerHello,
  createClientAuth,
  processServerAuth,
  isX3DHResponseMessage,
  isX3DHResultMessage,
} from '../../session/crypto/handshake.web.js'
import {
  createFrame,
  openFrame,
  MASTER_STREAM_ID,
} from '../../session/crypto/frames.web.js'
import { signRelayMessage } from '../../session/crypto/relay-signing.web.js'
import {
  RemoteSessionBackend,
} from '../../session/backends/remote-session-backend.js'
import {
  browserRemoteSocketAdapter,
  createBrowserRemoteCryptoAdapter,
  createBrowserRemoteHandshakeAdapter,
  deriveRelayUrlFromBrowserSocket,
} from '../../session/adapters/browser-remote.js'
import {
  buildRemoteBackendKey,
} from '../../session/backend-key.js'
import type {
  BackendKey,
} from '../../session/backend.js'
import type { RemoteSessionPtyBackend } from '../../session/useRemoteSessionClient.js'

const CONTROL_STREAM_ID = 1

const browserCryptoAdapter = createBrowserRemoteCryptoAdapter(
  {
    masterStreamId: MASTER_STREAM_ID,
    createFrame,
    openFrame,
  },
  {
    controlStreamId: CONTROL_STREAM_ID,
  }
)

const browserHandshakeAdapter = createBrowserRemoteHandshakeAdapter<
  X3DHClientState,
  X3DHResponseMessage,
  X3DHResultMessage
>({
  createClientHello,
  isServerHello: isX3DHResponseMessage,
  processServerHello,
  createClientAuth,
  isServerAuth: isX3DHResultMessage,
  processServerAuth,
})

export interface WebRemoteSessionConnectParams {
  ws: WebSocket
  identity: Identity
  machineId: string
  deviceCertificate: string
  relayUrl?: string
}

/**
 * Parameters for creating a browser remote backend from a relay URL.
 * Mirrors BunRemoteSessionConnectParams — creates its own WebSocket internally.
 */
export interface BrowserRemoteSessionConnectParams {
  relayUrl: string
  identity: Identity
  machineId: string
  deviceCertificate: string
  machineLabel?: string
  storage?: KeyValueStorage | null
}

/**
 * Create a browser remote session backend from a relay URL.
 * Creates its own WebSocket — matches the signature used by useMultiBackends
 * for auto-discovered machines.
 */
export function createBrowserRemoteSessionBackend(
  params: BrowserRemoteSessionConnectParams
): {
  backendKey: BackendKey
  backend: RemoteSessionPtyBackend
} {
  const relayUrl = new URL(params.relayUrl)
  relayUrl.searchParams.set('role', 'client')
  const ws = new WebSocket(relayUrl.toString())
  const backendKey = buildRemoteBackendKey(params.relayUrl, params.machineId)
  return {
    backendKey,
    backend: new RemoteSessionBackend<
      WebSocket,
      X3DHClientState,
      X3DHResponseMessage,
      X3DHResultMessage
    >({
      descriptor: {
        key: backendKey,
        kind: 'remote',
        label: params.machineLabel ?? params.machineId,
        relayUrl: params.relayUrl,
        machineId: params.machineId,
      },
      socket: ws,
      socketAdapter: browserRemoteSocketAdapter,
      identity: params.identity,
      machineId: params.machineId,
      deviceCertificate: params.deviceCertificate,
      signer: signRelayMessage,
      crypto: browserCryptoAdapter,
      handshake: browserHandshakeAdapter,
      storage: params.storage,
    }),
  }
}

export function createWebRemoteSessionBackend(
  params: WebRemoteSessionConnectParams
): {
  backendKey: BackendKey
  backend: RemoteSessionPtyBackend
} {
  const relayUrl = params.relayUrl ?? deriveRelayUrlFromBrowserSocket(params.ws)
  const backendKey = buildRemoteBackendKey(relayUrl, params.machineId)

  return {
    backendKey,
    backend: new RemoteSessionBackend<
      WebSocket,
      X3DHClientState,
      X3DHResponseMessage,
      X3DHResultMessage
    >({
      descriptor: {
        key: backendKey,
        kind: 'remote',
        label: params.machineId,
        relayUrl,
        machineId: params.machineId,
      },
      socket: params.ws,
      socketAdapter: browserRemoteSocketAdapter,
      identity: params.identity,
      machineId: params.machineId,
      deviceCertificate: params.deviceCertificate,
      signer: signRelayMessage,
      crypto: browserCryptoAdapter,
      handshake: browserHandshakeAdapter,
    }),
  }
}
