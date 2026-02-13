import { describe, expect, it } from 'bun:test'
import { resolveLocalTerminalSyncAction } from '../local-terminal-sync.js'

describe('resolveLocalTerminalSyncAction', () => {
  it('keeps current view outside local terminal context', () => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: false,
      view: 'terminal',
      localSessionStatus: 'connected',
      localSessionMode: 'attached',
      localScriptState: null,
      isSessionSwitching: false,
    })

    expect(action).toBe('none')
  })

  it('returns error action when backend status becomes error in terminal', () => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: true,
      view: 'terminal',
      localSessionStatus: 'error',
      localSessionMode: 'attached',
      localScriptState: null,
      isSessionSwitching: false,
    })

    expect(action).toBe('show-connection-error')
  })

  it('does not navigate away during an explicit session switch', () => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: true,
      view: 'terminal',
      localSessionStatus: 'connected',
      localSessionMode: 'browsing',
      localScriptState: null,
      isSessionSwitching: true,
    })

    expect(action).toBe('none')
  })

  it('suppresses transient errors during an explicit session switch', () => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: true,
      view: 'terminal',
      localSessionStatus: 'error',
      localSessionMode: 'attached',
      localScriptState: null,
      isSessionSwitching: true,
    })

    expect(action).toBe('none')
  })

  it('returns to projects after detach when no script state is active', () => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: true,
      view: 'terminal',
      localSessionStatus: 'connected',
      localSessionMode: 'browsing',
      localScriptState: null,
      isSessionSwitching: false,
    })

    expect(action).toBe('return-to-projects')
  })

  it('keeps terminal view after a failed script so output remains visible', () => {
    const action = resolveLocalTerminalSyncAction({
      isLocalMachineContext: true,
      view: 'terminal',
      localSessionStatus: 'connected',
      localSessionMode: 'browsing',
      localScriptState: { isRunning: false, error: 'script failed' },
      isSessionSwitching: false,
    })

    expect(action).toBe('none')
  })
})
