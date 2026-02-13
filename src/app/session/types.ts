import type { ScriptRuntimeState } from '../../session/types.js'

export type SessionClientConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'established'
  | 'error'

export type SessionClientMode = 'browsing' | 'attached'

export type SessionClientScriptState = ScriptRuntimeState

export interface SessionClientCommandError {
  code?: string
  message: string
}
