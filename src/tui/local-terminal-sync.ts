export type AppView = 'machines' | 'projects' | 'terminal' | 'replay' | 'inbox' | 'scripts' | 'events'

export type LocalSessionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'
export type LocalSessionMode = 'browsing' | 'attached'

export interface LocalScriptState {
  isRunning: boolean
  error?: string
}

export type LocalTerminalSyncAction =
  | 'none'
  | 'show-connection-error'
  | 'return-to-projects'

export function resolveLocalTerminalSyncAction(params: {
  isLocalMachineContext: boolean
  view: AppView
  localSessionStatus: LocalSessionStatus
  localSessionMode: LocalSessionMode
  localScriptState: LocalScriptState | null
  isSessionSwitching: boolean
}): LocalTerminalSyncAction {
  if (!params.isLocalMachineContext || params.view !== 'terminal') {
    return 'none'
  }

  if (params.isSessionSwitching) {
    return 'none'
  }

  if (params.localSessionStatus === 'error') {
    return 'show-connection-error'
  }

  if (params.localSessionMode === 'browsing' && params.localScriptState === null) {
    return 'return-to-projects'
  }

  return 'none'
}
