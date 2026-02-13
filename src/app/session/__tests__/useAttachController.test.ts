import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { Window } from 'happy-dom'
import { useAttachController } from '../useAttachController.js'

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
        workspaceId: 'my-project:my-workspace',
        sessionName: 'custom-name',
      },
      {
        projectName: 'my-project',
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
        sessionId: 'session-2',
      },
      {
        projectName: null,
      }
    )
  })

  it('runs lifecycle callbacks for cancelled and failed attach attempts', async () => {
    const onAttachCancelled = mock(() => {})
    const onAttachError = mock(() => {})
    const attachSessionWithBundleRefresh = mock(async (params: { sessionId?: string }) => {
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
        sessionId: 'session-3',
        cols: 132,
        rows: 41,
      },
      {
        projectName: null,
      }
    )

    expect(attachSessionWithBundleRefresh).toHaveBeenNthCalledWith(
      2,
      {
        sessionId: 'session-4',
        cols: 90,
        rows: 22,
      },
      {
        projectName: null,
      }
    )
  })
})
