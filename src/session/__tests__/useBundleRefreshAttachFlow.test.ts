import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { renderHook } from '@testing-library/react'
import { Window } from 'happy-dom'
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js'
import { useBundleRefreshAttachFlow } from '../useBundleRefreshAttachFlow.js'

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

function makePlan(overrides: Partial<BundleRefreshPlan> = {}): BundleRefreshPlan {
  return {
    projectName: 'test-project',
    workspaceId: 'test-project:test-workspace',
    workspaceName: 'test-workspace',
    workspacePath: '/tmp/test-workspace',
    hasBundle: true,
    hasChanged: true,
    details: 'Bundle changed',
    steps: [],
    autoConfirmResults: {},
    ...overrides,
  }
}

describe('useBundleRefreshAttachFlow', () => {
  it('does not silently retry attach when plan reports no changes', async () => {
    const confirmCalls: Array<any> = []
    const showMessage = mock(() => {})

    const attachSession = mock(async () => {
      const error = new Error('refresh required') as Error & { code?: string }
      error.code = 'BUNDLE_REFRESH_REQUIRED'
      throw error
    })

    const getPlan = mock(async () => makePlan({ hasChanged: false, details: 'No step changes' }))

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage,
          showConfirm: (opts) => {
            confirmCalls.push(opts)
          },
          showWizard: () => {},
          close: () => {},
        },
        commandError: null,
        attachSession,
        getBundleRefreshPlan: getPlan,
        applyBundleRefresh: async () => {},
      })
    )

    const promise = result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(confirmCalls.length).toBe(1)
    expect(attachSession).toHaveBeenCalledTimes(1)

    const confirm = confirmCalls[0]
    confirm.onCancel?.()

    const attached = await promise
    expect(attached).toBe(false)
    expect(showMessage).toHaveBeenCalled()
  })

  it('applies refresh plan and retries attach after confirmation', async () => {
    let attachCalls = 0
    const attachSession = mock(async () => {
      attachCalls += 1
      if (attachCalls === 1) {
        const error = new Error('refresh required') as Error & { code?: string }
        error.code = 'BUNDLE_REFRESH_REQUIRED'
        throw error
      }
    })

    const applySubmissionCalls: BundleRefreshSubmission[] = []
    const applyBundleRefresh = mock(async (
      _projectName: string,
      _workspaceId: string,
      submission: BundleRefreshSubmission
    ) => {
      applySubmissionCalls.push(submission)
    })

    const getPlan = mock(async () =>
      makePlan({
        details: 'Input changed',
        steps: [
          {
            id: 'region-step',
            type: 'input',
            title: 'Region',
            description: 'Cloud region',
            configKey: 'REGION',
            required: true,
          },
        ],
      })
    )

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: () => {},
          showConfirm: (opts) => {
            void opts.onConfirm()
          },
          showWizard: (opts) => {
            void opts.onComplete({ 'region-step': 'us-east-1' })
          },
          close: () => {},
        },
        commandError: null,
        attachSession,
        getBundleRefreshPlan: getPlan,
        applyBundleRefresh,
      })
    )

    const attached = await result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
    })

    expect(attached).toBe(true)
    expect(attachCalls).toBe(2)
    expect(applySubmissionCalls.length).toBe(1)
    expect(applySubmissionCalls[0]?.inputValues).toEqual({ REGION: 'us-east-1' })
  })

  it('validates wizard input against trimmed values for regex checks', async () => {
    let attachCalls = 0
    const attachSession = mock(async () => {
      attachCalls += 1
      if (attachCalls === 1) {
        const error = new Error('refresh required') as Error & { code?: string }
        error.code = 'BUNDLE_REFRESH_REQUIRED'
        throw error
      }
    })

    const getPlan = mock(async () =>
      makePlan({
        details: 'Input changed',
        steps: [
          {
            id: 'name-step',
            type: 'input',
            title: 'Name',
            description: 'Simple alpha name',
            configKey: 'NAME',
            required: true,
            validationPattern: '^[a-z]+$',
          },
        ],
      })
    )

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: () => {},
          showConfirm: (opts) => {
            void opts.onConfirm()
          },
          showWizard: (opts) => {
            const validation = opts.steps[0]?.validation
            expect(validation?.('  hello  ')).toBeNull()
            void opts.onComplete({ 'name-step': 'hello' })
          },
          close: () => {},
        },
        commandError: null,
        attachSession,
        getBundleRefreshPlan: getPlan,
        applyBundleRefresh: async () => {},
      })
    )

    const attached = await result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
    })

    expect(attached).toBe(true)
    expect(attachCalls).toBe(2)
  })

  it('does not overwrite existing secret when wizard value is only whitespace', async () => {
    let attachCalls = 0
    const attachSession = mock(async () => {
      attachCalls += 1
      if (attachCalls === 1) {
        const error = new Error('refresh required') as Error & { code?: string }
        error.code = 'BUNDLE_REFRESH_REQUIRED'
        throw error
      }
    })

    const applySubmissionCalls: BundleRefreshSubmission[] = []
    const applyBundleRefresh = mock(async (
      _projectName: string,
      _workspaceId: string,
      submission: BundleRefreshSubmission
    ) => {
      applySubmissionCalls.push(submission)
    })

    const getPlan = mock(async () =>
      makePlan({
        details: 'Secret changed',
        steps: [
          {
            id: 'token-step',
            type: 'secret',
            title: 'Token',
            description: 'API token',
            configKey: 'API_TOKEN',
            hasExistingSecret: true,
            required: false,
          },
        ],
      })
    )

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: () => {},
          showConfirm: (opts) => {
            void opts.onConfirm()
          },
          showWizard: (opts) => {
            void opts.onComplete({ 'token-step': '   ' })
          },
          close: () => {},
        },
        commandError: null,
        attachSession,
        getBundleRefreshPlan: getPlan,
        applyBundleRefresh,
      })
    )

    const attached = await result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
    })

    expect(attached).toBe(true)
    expect(attachCalls).toBe(2)
    expect(applySubmissionCalls.length).toBe(1)
    expect(applySubmissionCalls[0]?.secretValues).toEqual({})
  })

  it('runs wizard when unchanged bundle still has missing required steps', async () => {
    let attachCalls = 0
    const attachSession = mock(async () => {
      attachCalls += 1
      if (attachCalls === 1) {
        const error = new Error('refresh required') as Error & { code?: string }
        error.code = 'BUNDLE_REFRESH_REQUIRED'
        throw error
      }
    })

    const applySubmissionCalls: BundleRefreshSubmission[] = []
    const applyBundleRefresh = mock(async (
      _projectName: string,
      _workspaceId: string,
      submission: BundleRefreshSubmission
    ) => {
      applySubmissionCalls.push(submission)
    })

    const getPlan = mock(async () =>
      makePlan({
        hasChanged: false,
        details: 'Missing required secrets: PULUMI_ACCESS_TOKEN.',
        steps: [
          {
            id: 'pulumi-secret',
            type: 'secret',
            title: 'Pulumi token',
            description: 'Required token',
            configKey: 'PULUMI_ACCESS_TOKEN',
            required: true,
          },
        ],
      })
    )

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: () => {},
          showConfirm: (opts) => {
            void opts.onConfirm()
          },
          showWizard: (opts) => {
            void opts.onComplete({ 'pulumi-secret': 'token-value' })
          },
          close: () => {},
        },
        commandError: null,
        attachSession,
        getBundleRefreshPlan: getPlan,
        applyBundleRefresh,
      })
    )

    const attached = await result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
    })

    expect(attached).toBe(true)
    expect(attachCalls).toBe(2)
    expect(applySubmissionCalls.length).toBe(1)
    expect(applySubmissionCalls[0]?.secretValues).toEqual({ PULUMI_ACCESS_TOKEN: 'token-value' })
  })

  it('offers attach-anyway retry after setup/select script failure', async () => {
    const attachParamsSeen: Array<{ scriptPolicy?: 'auto' | 'skip' }> = []
    const attachSession = mock(async (params: { scriptPolicy?: 'auto' | 'skip' }) => {
      attachParamsSeen.push({ scriptPolicy: params.scriptPolicy })
      if (!params.scriptPolicy || params.scriptPolicy === 'auto') {
        const error = new Error('Workspace scripts failed during setup phase') as Error & { code?: string }
        error.code = 'SETUP_SCRIPT_FAILED'
        throw error
      }
    })

    const confirmCalls: Array<any> = []

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: () => {},
          showConfirm: (opts) => {
            confirmCalls.push(opts)
          },
          showWizard: () => {},
          close: () => {},
        },
        commandError: null,
        attachSession,
      })
    )

    const promise = result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
      scriptPolicy: 'auto',
    })

    await Promise.resolve()
    expect(confirmCalls.length).toBe(1)
    confirmCalls[0].onConfirm?.()

    const attached = await promise
    expect(attached).toBe(true)
    expect(attachParamsSeen.length).toBe(2)
    expect(attachParamsSeen[0]?.scriptPolicy).toBe('auto')
    expect(attachParamsSeen[1]?.scriptPolicy).toBe('skip')
  })

  it('does not replay stale script errors on a later attach attempt', async () => {
    const staleError = {
      code: 'SETUP_SCRIPT_FAILED',
      message: 'old script failure',
    }
    const confirmCalls: Array<any> = []
    const attachSession = mock(async () => {})

    const { result, rerender } = renderHook(
      ({ commandError }: { commandError: { code?: string; message: string } | null }) =>
        useBundleRefreshAttachFlow({
          flow: {
            showLoading: () => {},
            showMessage: () => {},
            showConfirm: (opts) => {
              confirmCalls.push(opts)
            },
            showWizard: () => {},
            close: () => {},
          },
          commandError,
          attachSession,
        }),
      {
        initialProps: { commandError: staleError },
      }
    )

    const attached = await result.current.attachSessionWithBundleRefresh({
      workspaceId: 'test-project:test-workspace',
    })
    expect(attached).toBe(true)
    expect(attachSession).toHaveBeenCalledTimes(1)

    rerender({ commandError: staleError })
    await Promise.resolve()
    await Promise.resolve()

    expect(confirmCalls.length).toBe(0)
    expect(attachSession).toHaveBeenCalledTimes(1)
  })
})
