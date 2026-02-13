import WebSocket from 'ws'
import type { X3DHClientState } from '../../lib/tmux-lite/crypto/handshake.js'
import type { Identity, X3DHResponseMessage, X3DHResultMessage } from '../../types/identity.js'
import {
  RemoteSessionBackend,
  LocalSessionBackend,
  buildRemoteBackendKey,
  nodeRemoteSocketAdapter,
  nodeRemoteCryptoAdapter,
  nodeRemoteHandshakeAdapter,
  createNodeRelaySigner,
  type BackendKey,
} from '../../session/index.js'
import type { RemoteSessionPtyBackend } from '../../session/useRemoteSessionClient.js'

export interface BunRemoteSessionConnectParams {
  relayUrl: string
  identity: Identity
  machineId: string
  machineLabel?: string
  inviteId?: string
  inviteToken?: string
}

export function createBunRemoteSessionBackend(
  params: BunRemoteSessionConnectParams
): {
  backendKey: BackendKey
  backend: RemoteSessionPtyBackend
} {
  const relayUrl = new URL(params.relayUrl)
  relayUrl.searchParams.set('role', 'client')
  const socket = new WebSocket(relayUrl.toString())

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
        label: params.machineLabel || params.machineId,
        relayUrl: params.relayUrl,
        machineId: params.machineId,
      },
      socket,
      socketAdapter: nodeRemoteSocketAdapter,
      identity: params.identity,
      machineId: params.machineId,
      inviteId: params.inviteId,
      inviteToken: params.inviteToken,
      signer: (message, identity) => createNodeRelaySigner(identity)(message),
      crypto: nodeRemoteCryptoAdapter,
      handshake: nodeRemoteHandshakeAdapter,
    }),
  }
}

export function createBunLocalSessionBackend(
  backendKey: BackendKey,
  label = 'Local'
): LocalSessionBackend {
  return new LocalSessionBackend({
    descriptor: {
      key: backendKey,
      kind: 'local',
      label,
    },
  })
}
