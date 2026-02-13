import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { Window } from 'happy-dom'
import type { AttachSessionParams, BackendEvent, SessionBackend } from '../../session/index.js'
import type { NotificationConfig } from '../../notifications/types.js'
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js'
import { SpacesError } from '../../types/errors.js'
import {
  useLocalSession,
  type UseLocalSessionOptions,
} from '../useLocalSession.tui.js'

const domWindow = new Window()
const originalWindow = globalThis.window
const originalDocument = globalThis.document

beforeAll(() => {
  // @ts-expect-error test DOM setup
  globalThis.window = domWindow
  // @ts-expect-error test DOM setup
  globalThis.document = domWindow.document
})

afterAll(() => {
  globalThis.window = originalWindow
  globalThis.document = originalDocument
})

type SessionEngineApi = NonNullable<UseLocalSessionOptions['engine']>

type BackendStateShape = {
  status: 'disconnected' | 'connecting' | 'connected' | 'error'
  mode: 'browsing' | 'attached'
  projects: unknown[]
  workspaces: unknown[]
  sessions: unknown[]
  inbox: unknown[]
  inboxUnreadCount: number
  notificationConfig: NotificationConfig | null
  attachedSessionId: string | null
  attachedSessionName: string | null
  scriptState: {
    phase: 'pre' | 'setup' | 'select' | 'remove'
    isRunning: boolean
    error?: string
    exitCode?: number
  } | null
}

class FakeLocalBackend implements SessionBackend {
  readonly descriptor = {
    key: 'local',
    kind: 'local' as const,
    label: 'Local',
  }

  private ptyOutputHandler: ((data: Uint8Array) => void) | null = null

  writeCalls: Uint8Array[] = []
  resizeCalls: Array<{ cols: number; rows: number }> = []

  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.ptyOutputHandler = handler
  }

  emitPtyText(text: string): void {
    this.ptyOutputHandler?.(new TextEncoder().encode(text))
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async listProjects(): Promise<void> {}

  async listWorkspaces(): Promise<void> {}

  async listSessions(_workspaceId?: string): Promise<void> {}

  async attachSession(_params: AttachSessionParams): Promise<void> {}

  async detachSession(): Promise<void> {}

  async killSession(_sessionId: string): Promise<void> {}

  async deleteWorkspace(_projectName: string, _workspaceId: string): Promise<void> {}

  async getBundleRefreshPlan(
    _projectName: string,
    workspaceId: string
  ): Promise<BundleRefreshPlan> {
    return {
      projectName: 'project',
      workspaceId,
      workspaceName: workspaceId,
      workspacePath: `/tmp/${workspaceId}`,
      hasBundle: true,
      hasChanged: true,
      details: 'bundle changed',
      steps: [],
      autoConfirmResults: {},
    }
  }

  async applyBundleRefresh(
    _projectName: string,
    _workspaceId: string,
    _submission: BundleRefreshSubmission
  ): Promise<void> {}

  async requestInbox(): Promise<void> {}

  async clearInbox(_id?: string): Promise<void> {}

  async markInboxRead(_id: string): Promise<void> {}

  async getNotificationConfig(): Promise<void> {}

  async updateNotificationConfig(_config: NotificationConfig): Promise<void> {}

  async writePtyData(data: Uint8Array): Promise<void> {
    this.writeCalls.push(new Uint8Array(data))
  }

  async resizePty(cols: number, rows: number): Promise<void> {
    this.resizeCalls.push({ cols, rows })
  }

  onEvent(_handler: (event: BackendEvent) => void): () => void {
    return () => {}
  }
}

function createEngineStub(
  backendState: BackendStateShape,
  options: {
    initialHasBackend?: boolean
    overrides?: Partial<SessionEngineApi>
  } = {}
): SessionEngineApi {
  let hasBackend = options.initialHasBackend ?? false

  const baseEngine = {
    state: { revision: 1 },
    activeBackendKey: null,
    activeBackendState: null,
    backendKeys: [],
    getBackendState: mock(() => (hasBackend ? backendState : null)),
    registerBackend: mock(() => {
      hasBackend = true
    }),
    unregisterBackend: mock(async () => {
      hasBackend = false
    }),
    setActiveBackend: mock(() => {}),
    connectBackend: mock(async () => {}),
    disconnectBackend: mock(async () => {}),
    listProjects: mock(async () => {}),
    listWorkspaces: mock(async () => {}),
    listSessions: mock(async () => {}),
    attachSession: mock(async () => {}),
    detachSession: mock(async () => {}),
    killSession: mock(async () => {}),
    deleteWorkspace: mock(async () => {}),
    getBundleRefreshPlan: mock(async () => ({
      projectName: 'project',
      workspaceId: 'workspace',
      workspaceName: 'workspace',
      workspacePath: '/tmp/workspace',
      hasBundle: true,
      hasChanged: true,
      details: 'bundle changed',
      steps: [],
      autoConfirmResults: {},
    })),
    applyBundleRefresh: mock(async () => {}),
    requestInbox: mock(async () => {}),
    clearInbox: mock(async () => {}),
    markInboxRead: mock(async () => {}),
    getNotificationConfig: mock(async () => {}),
    updateNotificationConfig: mock(async () => {}),
  }

  return {
    ...baseEngine,
    ...options.overrides,
  } as unknown as SessionEngineApi
}

describe('useLocalSession', () => {
  it('initializes backend and routes attach/send/resize/detach commands', async () => {
    const backendState: BackendStateShape = {
      status: 'connected',
      mode: 'attached',
      projects: [],
      workspaces: [],
      sessions: [],
      inbox: [],
      inboxUnreadCount: 0,
      notificationConfig: null,
      attachedSessionId: 'sess-1',
      attachedSessionName: 'alpha:ws-1:1',
      scriptState: null,
    }
    const engine = createEngineStub(backendState)
    const backend = new FakeLocalBackend()
    const outputs: string[] = []

    const { result, unmount } = renderHook(() =>
      useLocalSession({
        enabled: true,
        engine,
        createBackend: () => backend,
      })
    )

    await act(async () => {
      await Bun.sleep(0)
    })

    expect(engine.registerBackend).toHaveBeenCalledTimes(1)
    expect(engine.setActiveBackend).toHaveBeenCalledWith('local')
    expect(engine.connectBackend).toHaveBeenCalledWith('local')
    expect(engine.listProjects).toHaveBeenCalledWith('local')
    expect(engine.listWorkspaces).toHaveBeenCalledWith('local')
    expect(engine.requestInbox).toHaveBeenCalledWith('local')
    expect(engine.getNotificationConfig).toHaveBeenCalledWith('local')

    act(() => {
      result.current.setWriteCallback((data) => {
        outputs.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backend.emitPtyText('hello')
    })

    expect(outputs).toEqual(['hello'])

    await act(async () => {
      await result.current.attachSession({ workspaceId: 'alpha:ws-1', sessionName: 'debug' })
    })

    expect(engine.attachSession).toHaveBeenCalledWith('local', {
      workspaceId: 'alpha:ws-1',
      sessionName: 'debug',
    })

    const payload = new TextEncoder().encode('ls -la\n')
    await act(async () => {
      result.current.send(payload)
      result.current.resize(120, 40)
      await Bun.sleep(0)
    })

    expect(backend.writeCalls).toEqual([payload])
    expect(backend.resizeCalls).toEqual([{ cols: 120, rows: 40 }])

    await act(async () => {
      await result.current.detachSession()
    })

    expect(engine.detachSession).toHaveBeenCalledWith('local')

    unmount()

    expect(engine.disconnectBackend).toHaveBeenCalledWith('local')
    expect(engine.unregisterBackend).toHaveBeenCalledWith('local')
  })

  it('switches PTY write callbacks without duplicating output delivery', async () => {
    const backendState: BackendStateShape = {
      status: 'connected',
      mode: 'attached',
      projects: [],
      workspaces: [],
      sessions: [],
      inbox: [],
      inboxUnreadCount: 0,
      notificationConfig: null,
      attachedSessionId: 'sess-1',
      attachedSessionName: 'alpha:ws-1:1',
      scriptState: null,
    }
    const engine = createEngineStub(backendState)
    const backend = new FakeLocalBackend()

    const callbackOneOutput: string[] = []
    const callbackTwoOutput: string[] = []

    const { result } = renderHook(() =>
      useLocalSession({
        enabled: true,
        engine,
        createBackend: () => backend,
      })
    )

    await act(async () => {
      await Bun.sleep(0)
    })

    act(() => {
      result.current.setWriteCallback((data) => {
        callbackOneOutput.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backend.emitPtyText('first')
    })

    act(() => {
      result.current.setWriteCallback((data) => {
        callbackTwoOutput.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backend.emitPtyText('second')
    })

    expect(callbackOneOutput).toEqual(['first'])
    expect(callbackTwoOutput).toEqual(['second'])
  })

  it('supports clearing PTY callback during terminal transitions', async () => {
    const backendState: BackendStateShape = {
      status: 'connected',
      mode: 'attached',
      projects: [],
      workspaces: [],
      sessions: [],
      inbox: [],
      inboxUnreadCount: 0,
      notificationConfig: null,
      attachedSessionId: 'sess-1',
      attachedSessionName: 'alpha:ws-1:1',
      scriptState: null,
    }
    const engine = createEngineStub(backendState)
    const backend = new FakeLocalBackend()

    const callbackOneOutput: string[] = []
    const callbackTwoOutput: string[] = []

    const { result } = renderHook(() =>
      useLocalSession({
        enabled: true,
        engine,
        createBackend: () => backend,
      })
    )

    await act(async () => {
      await Bun.sleep(0)
    })

    act(() => {
      result.current.setWriteCallback((data) => {
        callbackOneOutput.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backend.emitPtyText('before-clear')
      result.current.setWriteCallback(null)
      backend.emitPtyText('while-cleared')
      result.current.setWriteCallback((data) => {
        callbackTwoOutput.push(new TextDecoder().decode(data))
      })
      backend.emitPtyText('after-restore')
    })

    expect(callbackOneOutput).toEqual(['before-clear'])
    expect(callbackTwoOutput).toEqual(['after-restore'])
  })

  it('skips backend registration and command dispatch when disabled', async () => {
    const backendState: BackendStateShape = {
      status: 'disconnected',
      mode: 'browsing',
      projects: [],
      workspaces: [],
      sessions: [],
      inbox: [],
      inboxUnreadCount: 0,
      notificationConfig: null,
      attachedSessionId: null,
      attachedSessionName: null,
      scriptState: null,
    }
    const engine = createEngineStub(backendState)
    const backend = new FakeLocalBackend()
    const createBackend = mock(() => backend)

    const { result } = renderHook(() =>
      useLocalSession({
        enabled: false,
        engine,
        createBackend,
      })
    )

    await act(async () => {
      await result.current.attachSession({ workspaceId: 'alpha:ws-1' })
      await result.current.detachSession()
      await result.current.killSession('sess-1')
      await result.current.deleteWorkspace('alpha', 'ws-1')
      result.current.requestProjects()
      result.current.requestWorkspaces()
      result.current.requestSessions('alpha:ws-1')
      result.current.requestInbox()
      result.current.clearInbox()
      result.current.markInboxRead('item-1')
      result.current.getNotificationConfig()
      result.current.updateNotificationConfig({
        enabled: true,
        minCommandDurationMs: 1000,
        types: {
          exit: true,
          idle: true,
          bell: true,
          title: true,
          osc: true,
        },
        toast: {
          enabled: true,
          holdWhenIdleMs: 5000,
        },
      })
      result.current.send(new Uint8Array([0x41]))
      result.current.resize(80, 24)
      await Bun.sleep(0)
    })

    expect(createBackend).not.toHaveBeenCalled()
    expect(engine.registerBackend).not.toHaveBeenCalled()
    expect(engine.connectBackend).not.toHaveBeenCalled()
    expect(engine.attachSession).not.toHaveBeenCalled()
    expect(engine.detachSession).not.toHaveBeenCalled()
    expect(engine.killSession).not.toHaveBeenCalled()
    expect(engine.deleteWorkspace).not.toHaveBeenCalled()
    expect(backend.writeCalls).toEqual([])
    expect(backend.resizeCalls).toEqual([])
  })

  it('recovers backend and retries attach on backend-not-found race', async () => {
    const backendState: BackendStateShape = {
      status: 'connected',
      mode: 'browsing',
      projects: [],
      workspaces: [],
      sessions: [],
      inbox: [],
      inboxUnreadCount: 0,
      notificationConfig: null,
      attachedSessionId: null,
      attachedSessionName: null,
      scriptState: null,
    }

    let attachAttempts = 0
    const engine = createEngineStub(backendState, {
      initialHasBackend: true,
      overrides: {
        attachSession: mock(async () => {
          attachAttempts += 1
          if (attachAttempts === 1) {
            throw new SpacesError('Backend not found: local', 'SYSTEM_ERROR', 2)
          }
        }),
      },
    })

    const { result } = renderHook(() =>
      useLocalSession({
        enabled: true,
        engine,
        createBackend: () => new FakeLocalBackend(),
      })
    )

    await act(async () => {
      await Bun.sleep(0)
    })

    await act(async () => {
      await result.current.attachSession({ workspaceId: 'alpha:ws-1', sessionName: 'debug' })
    })

    expect(engine.attachSession).toHaveBeenCalledTimes(2)
    expect(engine.connectBackend).toHaveBeenCalledTimes(2)
  })

  it('throws when backend cannot be recovered for strict attach actions', async () => {
    const backendState: BackendStateShape = {
      status: 'connected',
      mode: 'browsing',
      projects: [],
      workspaces: [],
      sessions: [],
      inbox: [],
      inboxUnreadCount: 0,
      notificationConfig: null,
      attachedSessionId: null,
      attachedSessionName: null,
      scriptState: null,
    }

    let connectAttempts = 0
    const engine = createEngineStub(backendState, {
      initialHasBackend: true,
      overrides: {
        connectBackend: mock(async () => {
          connectAttempts += 1
          if (connectAttempts > 1) {
            throw new Error('reconnect failed')
          }
        }),
        attachSession: mock(async () => {
          throw new SpacesError('Backend not found: local', 'SYSTEM_ERROR', 2)
        }),
      },
    })

    const { result } = renderHook(() =>
      useLocalSession({
        enabled: true,
        engine,
        createBackend: () => new FakeLocalBackend(),
      })
    )

    await act(async () => {
      await Bun.sleep(0)
    })

    await expect(
      result.current.attachSession({ workspaceId: 'alpha:ws-1', sessionName: 'debug' })
    ).rejects.toThrow('Backend not found: local')
  })
})
