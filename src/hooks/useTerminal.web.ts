/**
 * Web terminal hook backed by shared session client facade.
 */

import type {
  WorkspaceInfo,
  SessionInfo,
  ProjectInfo,
} from '../lib/remote-session/protocol'
import { useSessionClient } from '../app/session/useSessionClient.js'
import {
  createWebRemoteSessionBackend,
  type WebRemoteSessionConnectParams,
} from '../app/session/createSessionBackend.web.js'
import type {
  SessionClientConnectionStatus,
  SessionClientMode,
  SessionClientScriptState,
  SessionClientCommandError,
} from '../app/session/types.js'

export type ConnectionStatus = SessionClientConnectionStatus
export type SessionMode = SessionClientMode

export type { WorkspaceInfo, SessionInfo, ProjectInfo }

export type ScriptState = SessionClientScriptState
export type CommandErrorState = SessionClientCommandError

export type ConnectionParams = WebRemoteSessionConnectParams

export function useTerminal() {
  return useSessionClient<ConnectionParams>({
    createBackend: createWebRemoteSessionBackend,
  })
}
