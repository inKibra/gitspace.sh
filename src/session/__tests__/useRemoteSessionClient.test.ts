import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { Window } from 'happy-dom'
import type { NotificationConfig } from '../../notifications/types.js'
import type {
  AttachSessionParams,
  BackendDescriptor,
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  ReplayFrameTarget,
  ReplayTimeline,
} from '../backend.js'
import type { BackendEvent } from '../events.js'
import { buildRemoteBackendKey } from '../backend-key.js'
import type { RemoteSessionPtyBackend } from '../useRemoteSessionClient.js'
import { useRemoteSessionClient } from '../useRemoteSessionClient.js'
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js'
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config.js'

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

class FakeRemoteBackend implements RemoteSessionPtyBackend {
  readonly descriptor: BackendDescriptor

  private readonly handlers = new Set<(event: BackendEvent) => void>()
  private ptyOutputHandler: ((data: Uint8Array) => void) | null = null

  connectCalls = 0
  disconnectCalls = 0
  listProjectsCalls = 0
  listWorkspacesCalls = 0
  listSessionsCalls: Array<string | undefined> = []
  listReplaysCalls: Array<{ workspaceId?: string; includeDismissed?: boolean }> = []
  attachCalls: AttachSessionParams[] = []
  detachCalls = 0
  killCalls: string[] = []
  deleteCalls: Array<{ projectName: string; workspaceId: string }> = []
  inboxCalls = 0
  clearInboxCalls: Array<string | undefined> = []
  markInboxReadCalls: string[] = []
  getNotificationConfigCalls = 0
  updateNotificationConfigCalls: NotificationConfig[] = []
  bundlePlanCalls: Array<{ projectName: string; workspaceId: string }> = []
  bundleApplyCalls: Array<{ projectName: string; workspaceId: string; submission: BundleRefreshSubmission }> = []
  bundleConfigStateCalls: Array<{ projectName: string; workspaceId: string }> = []
  bundleConfigUpdateCalls: Array<{ projectName: string; workspaceId: string; submission: BundleConfigSubmission }> = []
  replayAnsiCalls: Array<{ replayId: string; target?: ReplayFrameTarget }> = []
  replayTimelineCalls: string[] = []
  dismissReplayCalls: string[] = []
  undismissReplayCalls: string[] = []
  ptyWrites: Uint8Array[] = []
  ptyResizes: Array<{ cols: number; rows: number }> = []

  constructor(key: string, machineId: string) {
    this.descriptor = {
      key,
      kind: 'remote',
      label: machineId,
      machineId,
      relayUrl: 'wss://relay.test/ws',
    }
  }

  onEvent(handler: (event: BackendEvent) => void): () => void {
    this.handlers.add(handler)
    return () => {
      this.handlers.delete(handler)
    }
  }

  setPtyOutputHandler(handler: ((data: Uint8Array) => void) | null): void {
    this.ptyOutputHandler = handler
  }

  emit(event: BackendEvent): void {
    for (const handler of this.handlers) {
      handler(event)
    }
  }

  emitPtyText(text: string): void {
    this.ptyOutputHandler?.(new TextEncoder().encode(text))
  }

  async connect(): Promise<void> {
    this.connectCalls += 1
    this.emit({ type: 'status', status: 'connected' })
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1
    this.emit({ type: 'status', status: 'disconnected' })
  }

  async listProjects(): Promise<void> {
    this.listProjectsCalls += 1
  }

  async listGithubRepos(_org?: string): Promise<string[]> {
    return []
  }

  async listRemoteBranches(_projectName: string): Promise<string[]> {
    return []
  }

  async listLinearIssues(_projectName: string): Promise<never[]> {
    return []
  }

  async listWorkspaces(): Promise<void> {
    this.listWorkspacesCalls += 1
  }

  async listSessions(workspaceId?: string): Promise<void> {
    this.listSessionsCalls.push(workspaceId)
  }

  async listReplays(workspaceId?: string, includeDismissed?: boolean): Promise<void> {
    this.listReplaysCalls.push({ workspaceId, includeDismissed })
  }

  async createProject(_params: CreateProjectParams): Promise<void> {}

  async createWorkspace(_params: CreateWorkspaceParams): Promise<void> {}

  async deleteProject(_projectName: string, _params?: DeleteProjectParams): Promise<void> {}

  async attachSession(params: AttachSessionParams): Promise<void> {
    this.attachCalls.push(params)
  }

  async detachSession(): Promise<void> {
    this.detachCalls += 1
  }

  async killSession(sessionId: string): Promise<void> {
    this.killCalls.push(sessionId)
  }

  async deleteWorkspace(
    projectName: string,
    workspaceId: string,
    _params?: DeleteWorkspaceParams
  ): Promise<void> {
    this.deleteCalls.push({ projectName, workspaceId })
  }

  async requestInbox(): Promise<void> {
    this.inboxCalls += 1
  }

  async getBundleRefreshPlan(projectName: string, workspaceId: string): Promise<BundleRefreshPlan> {
    this.bundlePlanCalls.push({ projectName, workspaceId })
    return {
      projectName,
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
    projectName: string,
    workspaceId: string,
    submission: BundleRefreshSubmission
  ): Promise<void> {
    this.bundleApplyCalls.push({ projectName, workspaceId, submission })
  }

  async getBundleConfigState(projectName: string, workspaceId: string): Promise<BundleConfigState> {
    this.bundleConfigStateCalls.push({ projectName, workspaceId })
    return {
      projectName,
      workspaceId,
      workspaceName: workspaceId,
      workspacePath: `/tmp/${workspaceId}`,
      hasBundle: true,
      details: 'bundle state',
      steps: [],
    }
  }

  async applyBundleConfigUpdate(
    projectName: string,
    workspaceId: string,
    submission: BundleConfigSubmission
  ): Promise<void> {
    this.bundleConfigUpdateCalls.push({ projectName, workspaceId, submission })
  }

  async clearInbox(id?: string): Promise<void> {
    this.clearInboxCalls.push(id)
  }

  async markInboxRead(id: string): Promise<void> {
    this.markInboxReadCalls.push(id)
  }

  async getNotificationConfig(): Promise<void> {
    this.getNotificationConfigCalls += 1
  }

  async updateNotificationConfig(config: NotificationConfig): Promise<void> {
    this.updateNotificationConfigCalls.push(config)
  }

  async sendReviewRequest(): Promise<never> {
    throw new Error('not implemented')
  }

  async getReplayAnsi(replayId: string, target?: ReplayFrameTarget): Promise<Uint8Array> {
    this.replayAnsiCalls.push({ replayId, target })
    return new Uint8Array([1, 2, 3])
  }

  async getReplayTimeline(replayId: string): Promise<ReplayTimeline> {
    this.replayTimelineCalls.push(replayId)
    return {
      replayId,
      durationMs: 50,
      latestTimeMs: 50,
      steps: [{ timeMs: 0, seq: 0 }, { timeMs: 50, seq: 1 }],
      checkpointSteps: [{ timeMs: 0, seq: 0 }],
    }
  }

  async dismissReplay(replayId: string): Promise<void> {
    this.dismissReplayCalls.push(replayId)
  }

  async undismissReplay(replayId: string): Promise<void> {
    this.undismissReplayCalls.push(replayId)
  }

  async writePtyData(data: Uint8Array): Promise<void> {
    this.ptyWrites.push(new Uint8Array(data))
  }

  async resizePty(cols: number, rows: number): Promise<void> {
    this.ptyResizes.push({ cols, rows })
  }
}

describe('useRemoteSessionClient', () => {
  it('keeps connect and disconnect stable across backend state updates', async () => {
    const backends: FakeRemoteBackend[] = []
    const createBackend = ({ machineId }: { machineId: string }) => {
      const backendKey = buildRemoteBackendKey('wss://relay.test/ws', machineId)
      const backend = new FakeRemoteBackend(backendKey, machineId)
      backends.push(backend)
      return { backendKey, backend }
    }

    const { result } = renderHook(() =>
      useRemoteSessionClient<{ machineId: string }>({
        createBackend,
      })
    )

    const initialConnect = result.current.connect
    const initialDisconnect = result.current.disconnect

    await act(async () => {
      await result.current.connect({ machineId: 'machine-a' })
    })

    expect(result.current.connect).toBe(initialConnect)
    expect(result.current.disconnect).toBe(initialDisconnect)

    act(() => {
      backends[0].emit({
        type: 'projects',
        projects: [{ name: 'demo', repository: 'owner/demo', workspaceCount: 0, isCurrent: false }],
      })
    })

    expect(result.current.connect).toBe(initialConnect)
    expect(result.current.disconnect).toBe(initialDisconnect)
  })

  it('connects through session engine and forwards PTY I/O', async () => {
    const backends: FakeRemoteBackend[] = []
    const receivedOutput: string[] = []

    const { result } = renderHook(() =>
      useRemoteSessionClient<{ machineId: string }>({
        createBackend: ({ machineId }) => {
          const backendKey = buildRemoteBackendKey('wss://relay.test/ws', machineId)
          const backend = new FakeRemoteBackend(backendKey, machineId)
          backends.push(backend)
          return { backendKey, backend }
        },
      })
    )

    act(() => {
      result.current.setWriteCallback((data) => {
        receivedOutput.push(new TextDecoder().decode(data))
      })
    })

    await act(async () => {
      await result.current.connect({ machineId: 'machine-a' })
    })

    expect(backends).toHaveLength(1)
    expect(backends[0].connectCalls).toBe(1)

    act(() => {
      backends[0].emitPtyText('hello from backend')
    })
    expect(receivedOutput).toEqual(['hello from backend'])

    const payload = new TextEncoder().encode('ls -la\n')
    await act(async () => {
      result.current.send(payload)
      result.current.resize(120, 40)
      await Bun.sleep(0)
    })

    expect(backends[0].ptyWrites).toEqual([payload])
    expect(backends[0].ptyResizes).toEqual([{ cols: 120, rows: 40 }])
  })

  it('exposes command_error as commandError while keeping transport status established', async () => {
    const backends: FakeRemoteBackend[] = []

    const { result } = renderHook(() =>
      useRemoteSessionClient<{ machineId: string }>({
        createBackend: ({ machineId }) => {
          const backendKey = buildRemoteBackendKey('wss://relay.test/ws', machineId)
          const backend = new FakeRemoteBackend(backendKey, machineId)
          backends.push(backend)
          return { backendKey, backend }
        },
      })
    )

    await act(async () => {
      await result.current.connect({ machineId: 'machine-a' })
    })

    act(() => {
      backends[0].emit({
        type: 'command_error',
        code: 'SCRIPT_FAILED',
        message: 'Workspace scripts failed during setup',
      })
    })

    expect(result.current.status).toBe('established')
    expect(result.current.commandError).toEqual({
      code: 'SCRIPT_FAILED',
      message: 'Workspace scripts failed during setup',
    })
  })

  it('switches PTY write callbacks without duplicating output delivery', async () => {
    const backends: FakeRemoteBackend[] = []
    const callbackOneOutput: string[] = []
    const callbackTwoOutput: string[] = []

    const { result } = renderHook(() =>
      useRemoteSessionClient<{ machineId: string }>({
        createBackend: ({ machineId }) => {
          const backendKey = buildRemoteBackendKey('wss://relay.test/ws', machineId)
          const backend = new FakeRemoteBackend(backendKey, machineId)
          backends.push(backend)
          return { backendKey, backend }
        },
      })
    )

    await act(async () => {
      await result.current.connect({ machineId: 'machine-a' })
    })

    act(() => {
      result.current.setWriteCallback((data) => {
        callbackOneOutput.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backends[0].emitPtyText('first')
    })

    act(() => {
      result.current.setWriteCallback((data) => {
        callbackTwoOutput.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backends[0].emitPtyText('second')
    })

    expect(callbackOneOutput).toEqual(['first'])
    expect(callbackTwoOutput).toEqual(['second'])
  })

  it('supports clearing PTY callback during terminal transitions', async () => {
    const backends: FakeRemoteBackend[] = []
    const callbackOneOutput: string[] = []
    const callbackTwoOutput: string[] = []

    const { result } = renderHook(() =>
      useRemoteSessionClient<{ machineId: string }>({
        createBackend: ({ machineId }) => {
          const backendKey = buildRemoteBackendKey('wss://relay.test/ws', machineId)
          const backend = new FakeRemoteBackend(backendKey, machineId)
          backends.push(backend)
          return { backendKey, backend }
        },
      })
    )

    await act(async () => {
      await result.current.connect({ machineId: 'machine-a' })
    })

    act(() => {
      result.current.setWriteCallback((data) => {
        callbackOneOutput.push(new TextDecoder().decode(data))
      })
    })

    act(() => {
      backends[0].emitPtyText('before-clear')
      result.current.setWriteCallback(null)
      backends[0].emitPtyText('while-cleared')
      result.current.setWriteCallback((data) => {
        callbackTwoOutput.push(new TextDecoder().decode(data))
      })
      backends[0].emitPtyText('after-restore')
    })

    expect(callbackOneOutput).toEqual(['before-clear'])
    expect(callbackTwoOutput).toEqual(['after-restore'])
  })

  it('disconnects previous backend when reconnecting and routes commands', async () => {
    const backends: FakeRemoteBackend[] = []

    const { result } = renderHook(() =>
      useRemoteSessionClient<{ machineId: string }>({
        createBackend: ({ machineId }) => {
          const backendKey = buildRemoteBackendKey('wss://relay.test/ws', machineId)
          const backend = new FakeRemoteBackend(backendKey, machineId)
          backends.push(backend)
          return { backendKey, backend }
        },
      })
    )

    await act(async () => {
      await result.current.connect({ machineId: 'machine-a' })
      await result.current.connect({ machineId: 'machine-b' })
    })

    expect(backends).toHaveLength(2)
    expect(backends[0].disconnectCalls).toBeGreaterThanOrEqual(1)

    await act(async () => {
      result.current.requestProjects()
      result.current.selectProject('alpha')
      result.current.requestSessions('workspace-1')
      result.current.requestReplays('workspace-1', true)
      result.current.attachSession({ workspaceId: 'workspace-1', sessionName: 'debug' })
      result.current.detachSession()
      result.current.killSession('session-1')
      result.current.deleteWorkspace('alpha', 'workspace-1')
      result.current.requestInbox()
      result.current.clearInboxItem()
      result.current.clearInboxItem('item-1')
      result.current.markInboxItemRead('item-2')
      result.current.requestNotificationConfig()
      result.current.updateNotificationConfig({
        enabled: true,
        minCommandDurationMs: 500,
        types: {
          exit: true,
          idle: false,
          bell: true,
          title: true,
          osc: false,
        },
        toast: {
          enabled: true,
          holdWhenIdleMs: 12000,
        },
      })
      await result.current.getReplayAnsi('replay-1', { atMs: 50 })
      await result.current.getReplayTimeline('replay-1')
      await result.current.dismissReplay('replay-1')
      await result.current.undismissReplay('replay-1')
      await Bun.sleep(0)
    })

    const activeBackend = backends[1]
    expect(activeBackend.listProjectsCalls).toBe(1)
    expect(activeBackend.listWorkspacesCalls).toBe(1)
    expect(activeBackend.listSessionsCalls).toEqual([undefined, 'workspace-1'])
    expect(activeBackend.listReplaysCalls).toEqual([{ workspaceId: 'workspace-1', includeDismissed: true }])
    expect(activeBackend.attachCalls).toEqual([
      { workspaceId: 'workspace-1', sessionName: 'debug' },
    ])
    expect(activeBackend.detachCalls).toBe(1)
    expect(activeBackend.killCalls).toEqual(['session-1'])
    expect(activeBackend.deleteCalls).toEqual([{ projectName: 'alpha', workspaceId: 'workspace-1' }])
    expect(activeBackend.inboxCalls).toBe(1)
    expect(activeBackend.clearInboxCalls).toEqual([undefined, 'item-1'])
    expect(activeBackend.markInboxReadCalls).toEqual(['item-2'])
    expect(activeBackend.getNotificationConfigCalls).toBe(1)
    expect(activeBackend.updateNotificationConfigCalls).toHaveLength(1)
    expect(activeBackend.replayAnsiCalls).toEqual([{ replayId: 'replay-1', target: { atMs: 50 } }])
    expect(activeBackend.replayTimelineCalls).toEqual(['replay-1'])
    expect(activeBackend.dismissReplayCalls).toEqual(['replay-1'])
    expect(activeBackend.undismissReplayCalls).toEqual(['replay-1'])

    await act(async () => {
      result.current.disconnect()
      await Bun.sleep(0)
    })
    expect(result.current.selectedProjectName).toBeNull()
  })
})
