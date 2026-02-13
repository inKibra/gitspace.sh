import { useSessionClient } from '../app/session/useSessionClient.js'
import {
  createBunRemoteSessionBackend,
  type BunRemoteSessionConnectParams,
} from '../app/session/createSessionBackend.bun.js'
import type {
  SessionClientConnectionStatus,
  SessionClientMode,
  SessionClientScriptState,
} from '../app/session/types.js'

export type ConnectionStatus = SessionClientConnectionStatus
export type SessionMode = SessionClientMode
export type ScriptState = SessionClientScriptState

export type ConnectionParams = BunRemoteSessionConnectParams

export function useRemoteTerminal() {
  return useSessionClient<ConnectionParams>({
    createBackend: createBunRemoteSessionBackend,
  })
}
