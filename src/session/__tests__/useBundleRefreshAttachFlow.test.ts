import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { act, renderHook } from '@testing-library/react'
import { setupTestDom, teardownTestDom } from '../../test/setup-dom.js'
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh.js'
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js'
import { useBundleRefreshAttachFlow } from '../useBundleRefreshAttachFlow.js'

const TEST_REF: BackendScopedWorkspaceRef = { backendKey: 'local', workspaceId: 'test-project:test-workspace' }

beforeAll(() => setupTestDom())

afterAll(() => teardownTestDom())

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

    const promise = result.current.attachSessionWithBundleRefresh(TEST_REF, {
      workspaceId: TEST_REF.workspaceId,
    })

    await Promise.resolve()
    await Promise.resolve()

    expect(confirmCalls.length).toBe(1)
    expect(attachSession).toHaveBeenCalledTimes(1)

    const confirm = confirmCalls[0]
    await act(async () => {
      confirm.onCancel?.()
      await promise
    })

    expect(showMessage).not.toHaveBeenCalled()
    expect(result.current.recoverableParams).toMatchObject({
      workspaceId: TEST_REF.workspaceId,
    })
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
      _ref: BackendScopedWorkspaceRef,
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

    const attached = await result.current.attachSessionWithBundleRefresh(TEST_REF, {
      workspaceId: TEST_REF.workspaceId,
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

    const attached = await result.current.attachSessionWithBundleRefresh(TEST_REF, {
      workspaceId: TEST_REF.workspaceId,
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
      _ref: BackendScopedWorkspaceRef,
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

    const attached = await result.current.attachSessionWithBundleRefresh(TEST_REF, {
      workspaceId: TEST_REF.workspaceId,
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
      _ref: BackendScopedWorkspaceRef,
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

    const attached = await result.current.attachSessionWithBundleRefresh(TEST_REF, {
      workspaceId: TEST_REF.workspaceId,
    })

    expect(attached).toBe(true)
    expect(attachCalls).toBe(2)
    expect(applySubmissionCalls.length).toBe(1)
    expect(applySubmissionCalls[0]?.secretValues).toEqual({ PULUMI_ACCESS_TOKEN: 'token-value' })
  })

  it('bypasses bundle refresh handling when retrying with scriptPolicy skip', async () => {
    const showMessage = mock(() => {})
    const showConfirm = mock(() => {})
    const attachSession = mock(async () => undefined)

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage,
          showConfirm,
          showWizard: () => {},
          close: () => {},
        },
        commandError: { code: 'BUNDLE_REFRESH_REQUIRED', message: 'stale' },
        attachSession,
        getBundleRefreshPlan: async () => makePlan({ hasChanged: true }),
        applyBundleRefresh: async () => {},
      })
    )

    await act(async () => {
      await result.current.attachSessionWithBundleRefresh(TEST_REF, {
        workspaceId: TEST_REF.workspaceId,
        scriptPolicy: 'skip',
      })
    })

    expect(showConfirm).not.toHaveBeenCalled()
    expect(showMessage).not.toHaveBeenCalled()
    expect(attachSession).toHaveBeenCalledTimes(1)
    expect(attachSession).toHaveBeenCalledWith({
      workspaceId: TEST_REF.workspaceId,
      scriptPolicy: 'skip',
    })
    expect(result.current.recoverableParams).toBeNull()
  })

  it('shows script failure message and sets recoverableParams', async () => {
    const attachParamsSeen: Array<{ scriptPolicy?: 'auto' | 'skip' }> = []
    const attachSession = mock(async (params: { scriptPolicy?: 'auto' | 'skip' }) => {
      attachParamsSeen.push({ scriptPolicy: params.scriptPolicy })
      if (!params.scriptPolicy || params.scriptPolicy === 'auto') {
        const error = new Error('Workspace scripts failed during setup phase') as Error & { code?: string }
        error.code = 'SETUP_SCRIPT_FAILED'
        throw error
      }
    })

    const messageCalls: Array<any> = []

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: (opts) => {
            messageCalls.push(opts)
          },
          showConfirm: () => {},
          showWizard: () => {},
          close: () => {},
        },
        commandError: null,
        attachSession,
      })
    )

    const attachParams = {
      workspaceId: 'test-project:test-workspace',
      scriptPolicy: 'auto' as const,
    }

    let attached = false
    await act(async () => {
      attached = await result.current.attachSessionWithBundleRefresh(TEST_REF, attachParams)
    })

    expect(attached).toBe(false)
    expect(attachParamsSeen.length).toBe(1)
    expect(attachParamsSeen[0]?.scriptPolicy).toBe('auto')
    expect(messageCalls.length).toBe(1)
    expect(messageCalls[0]).toMatchObject({
      title: 'Workspace Script Failed',
      variant: 'error',
    })
    // Recovery params must be set so callers can offer "attach anyway"
    expect(result.current.recoverableParams).toMatchObject({
      workspaceId: 'test-project:test-workspace',
    })
  })

  it('clears recoverableParams at the start of the next attach attempt', async () => {
    let calls = 0
    const attachSession = mock(async () => {
      calls += 1
      if (calls === 1) {
        const error = new Error('Script failed') as Error & { code?: string }
        error.code = 'SETUP_SCRIPT_FAILED'
        throw error
      }
    })

    const { result } = renderHook(() =>
      useBundleRefreshAttachFlow({
        flow: {
          showLoading: () => {},
          showMessage: () => {},
          showConfirm: () => {},
          showWizard: () => {},
          close: () => {},
        },
        commandError: null,
        attachSession,
      })
    )

    await act(async () => {
      await result.current.attachSessionWithBundleRefresh(TEST_REF, { workspaceId: TEST_REF.workspaceId })
    })
    expect(result.current.recoverableParams).not.toBeNull()

    await act(async () => {
      await result.current.attachSessionWithBundleRefresh(TEST_REF, { workspaceId: TEST_REF.workspaceId })
    })
    // Second attempt succeeded; recovery should be cleared
    expect(result.current.recoverableParams).toBeNull()
  })

  it('does not replay stale script errors on a later attach attempt', async () => {
    const staleError = {
      code: 'SETUP_SCRIPT_FAILED',
      message: 'old script failure',
    }
    const messageCalls: Array<any> = []
    const attachSession = mock(async () => {})

    const { result, rerender } = renderHook(
      ({ commandError }: { commandError: { code?: string; message: string } | null }) =>
        useBundleRefreshAttachFlow({
          flow: {
            showLoading: () => {},
            showMessage: (opts) => {
              messageCalls.push(opts)
            },
            showConfirm: () => {},
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

    const attached = await result.current.attachSessionWithBundleRefresh(TEST_REF, {
      workspaceId: TEST_REF.workspaceId,
    })
    expect(attached).toBe(true)
    expect(attachSession).toHaveBeenCalledTimes(1)

    rerender({ commandError: staleError })
    await Promise.resolve()
    await Promise.resolve()

    expect(messageCalls.length).toBe(0)
    expect(attachSession).toHaveBeenCalledTimes(1)
  })
})
