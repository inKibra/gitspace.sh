import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { setupTestDom, teardownTestDom } from '../../../test/setup-dom.js'
import { useAttachController } from '../useAttachController.js'

beforeAll(() => setupTestDom())
afterAll(() => teardownTestDom())

describe('useAttachController', () => {
  it('prompts for session name and attaches workspace after submit', async () => {
    const close = mock(() => {})
    const showInputCalls: Array<{
      onSubmit: (value: string) => Promise<void> | void
    }> = []

    const attachSessionWithBundleRefresh = mock(async () => true)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: (opts) => {
            showInputCalls.push({ onSubmit: opts.onSubmit })
          },
          showMessage: () => {},
          close,
        },
        attachSessionWithBundleRefresh,
      })
    )

    await result.current.attachFromSelection({ workspaceId: 'my-project:my-workspace' })
    expect(showInputCalls.length).toBe(1)

    await showInputCalls[0]?.onSubmit('custom-name')

    expect(close).toHaveBeenCalledTimes(1)
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledTimes(1)
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'local',
        workspaceId: 'my-project:my-workspace',
      },
      {
        sessionName: 'custom-name',
        backendKey: 'local',
        workspaceId: 'my-project:my-workspace',
      }
    )
  })

  it('uses preflight gate for existing session attaches', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)
    const preflightSessionAttach = mock(async () => false)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        preflightSessionAttach,
      })
    )

    await result.current.attachFromSelection({ sessionId: 'session-1' })

    expect(preflightSessionAttach).toHaveBeenCalledTimes(1)
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledTimes(0)
  })

  it('waits for async preflight approval before attaching existing session', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)
    const resolver: { current: ((value: boolean) => void) | null } = { current: null }
    const preflightSessionAttach = mock(() =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve
      })
    )

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        preflightSessionAttach,
      })
    )

    const attachPromise = result.current.attachFromSelection({ sessionId: 'session-2' })
    await Promise.resolve()
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledTimes(0)

    if (!resolver.current) {
      throw new Error('Expected preflight resolver to be set')
    }
    resolver.current(true)
    await attachPromise

    expect(preflightSessionAttach).toHaveBeenCalledTimes(1)
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledTimes(1)
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'local',
        workspaceId: '',
      },
      {
        sessionId: 'session-2',
      }
    )
  })

  it('passes through viewOnly on existing session attaches', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
      })
    )

    await result.current.attachFromSelection({ sessionId: 'session-view', viewOnly: true })

    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'local',
        workspaceId: '',
      },
      {
        sessionId: 'session-view',
        viewOnly: true,
      }
    )
  })

  it('keeps existing session attaches classified as sessions when scoped to a workspace', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)
    const onBeforeAttach = mock(() => {})

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        resolveWorkspaceRef: (workspaceId) => ({ backendKey: 'remote:machine-1', workspaceId }),
        onBeforeAttach,
      })
    )

    await result.current.attachFromSelection({
      sessionId: 'session-view',
      workspaceId: 'my-project:my-workspace',
      viewOnly: true,
    })

    expect(onBeforeAttach).toHaveBeenCalledWith(expect.objectContaining({
      target: 'session',
      workspaceRef: undefined,
    }))
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'remote:machine-1',
        workspaceId: 'my-project:my-workspace',
      },
      {
        sessionId: 'session-view',
        workspaceId: 'my-project:my-workspace',
        viewOnly: true,
      }
    )
  })

  it('resolves workspace attaches against the owning backend', async () => {
    const close = mock(() => {})
    const showInputCalls: Array<{
      onSubmit: (value: string) => Promise<void> | void
    }> = []

    const attachSessionWithBundleRefresh = mock(async () => true)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: (opts) => {
            showInputCalls.push({ onSubmit: opts.onSubmit })
          },
          showMessage: () => {},
          close,
        },
        attachSessionWithBundleRefresh,
        resolveWorkspaceRef: (workspaceId) => ({ backendKey: 'remote:machine-1', workspaceId }),
      })
    )

    await result.current.attachFromSelection({ workspaceId: 'my-project:my-workspace' })
    await showInputCalls[0]?.onSubmit('remote-shell')

    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'remote:machine-1',
        workspaceId: 'my-project:my-workspace',
      },
      {
        sessionName: 'remote-shell',
        backendKey: 'remote:machine-1',
        workspaceId: 'my-project:my-workspace',
      }
    )
  })

  it('uses the selected session backend when provided', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
      })
    )

    await result.current.attachFromSelection({
      sessionId: 'session-remote',
      backendKey: 'remote:machine-1',
      viewOnly: true,
    })

    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'remote:machine-1',
        workspaceId: '',
      },
      {
        sessionId: 'session-remote',
        viewOnly: true,
      }
    )
  })

  it('runs lifecycle callbacks for cancelled and failed attach attempts', async () => {
    const onAttachCancelled = mock(() => {})
    const onAttachError = mock(() => {})
    const attachSessionWithBundleRefresh = mock(async (_ref: { backendKey: string; workspaceId: string }, params: { sessionId?: string }) => {
      if (params.sessionId === 'cancelled') {
        return false
      }

      throw new Error('boom')
    })

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        onAttachCancelled,
        onAttachError,
      })
    )

    const cancelled = await result.current.attach({ sessionId: 'cancelled' })
    const failed = await result.current.attach({ sessionId: 'failed' })

    expect(cancelled).toBe(false)
    expect(failed).toBe(false)
    expect(onAttachCancelled).toHaveBeenCalledTimes(1)
    expect(onAttachError).toHaveBeenCalledTimes(1)
  })

  it('injects terminal size into attach params when available', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        getAttachSize: () => ({ cols: 132, rows: 41 }),
      })
    )

    await result.current.attach({ sessionId: 'session-3' })
    await result.current.attach({ sessionId: 'session-4', cols: 90, rows: 22 })

    expect(attachSessionWithBundleRefresh).toHaveBeenNthCalledWith(
      1,
      {
        backendKey: 'local',
        workspaceId: '',
      },
      {
        sessionId: 'session-3',
        cols: 132,
        rows: 41,
      }
    )

    expect(attachSessionWithBundleRefresh).toHaveBeenNthCalledWith(
      2,
      {
        backendKey: 'local',
        workspaceId: '',
      },
      {
        sessionId: 'session-4',
        cols: 90,
        rows: 22,
      }
    )
  })

  it('canAttachAnyway is true when recoverableAttachParams is provided and calls attach with scriptPolicy skip', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)

    const recoverableParams = {
      workspaceId: 'my-project:my-workspace',
      sessionName: 'debug-shell',
      cols: 120,
      rows: 40,
    }

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        recoverableAttachParams: recoverableParams,
      })
    )

    expect(result.current.canAttachAnyway).toBe(true)

    let retried = false
    await act(async () => {
      retried = await result.current.attachAnyway()
    })

    expect(retried).toBe(true)
    expect(attachSessionWithBundleRefresh).toHaveBeenCalledWith(
      {
        backendKey: 'local',
        workspaceId: 'my-project:my-workspace',
      },
      {
        workspaceId: 'my-project:my-workspace',
        sessionName: 'debug-shell',
        cols: 120,
        rows: 40,
        backendKey: 'local',
        scriptPolicy: 'skip',
      }
    )
  })

  it('canAttachAnyway is false when recoverableAttachParams is null', async () => {
    const attachSessionWithBundleRefresh = mock(async () => true)

    const { result } = renderHook(() =>
      useAttachController({
        flow: {
          showInput: () => {},
          showMessage: () => {},
          close: () => {},
        },
        attachSessionWithBundleRefresh,
        recoverableAttachParams: null,
      })
    )

    expect(result.current.canAttachAnyway).toBe(false)

    let retried = true
    await act(async () => {
      retried = await result.current.attachAnyway()
    })
    expect(retried).toBe(false)
  })
})
