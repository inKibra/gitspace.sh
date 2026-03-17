import type { ScriptRuntimeState } from '../../session/types.js'

export type SessionClientConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'established'
  | 'reconnecting'
  | 'error'

/**
 * Human-readable labels for each connection status.
 * Typed as an exhaustive Record so adding a new status to the union
 * causes a compile error until a label is provided here.
 */
export const CONNECTION_STATUS_LABELS: Record<SessionClientConnectionStatus, string> = {
  disconnected: 'Disconnected',
  connecting: 'Connecting to relay...',
  reconnecting: 'Connection lost. Reconnecting...',
  established: 'Connected!',
  error: 'Connection failed',
}

export type SessionClientMode = 'browsing' | 'attached'

export type SessionClientScriptState = ScriptRuntimeState

export interface SessionClientCommandError {
  code?: string
  message: string
}
