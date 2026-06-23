import { useCallback } from 'react'
import type { UseFlowReturn } from '../../components/Flow.js'
import type {
  BundleRefreshAttachParams,
  UseBundleRefreshAttachFlowResult,
} from '../../session/useBundleRefreshAttachFlow.js'
import type { BackendKey } from '../../session/backend.js'
import type { BackendScopedWorkspaceRef } from '../../machine/multi/types.js'

export interface AttachSelectionParams {
  sessionId?: string
  workspaceId?: string
  viewOnly?: boolean
  backendKey?: BackendKey
  paneId?: string
}

export type AttachTarget = 'session' | 'workspace'

export interface AttachContext {
  target: AttachTarget
  params: BundleRefreshAttachParams
  projectName: string | null
  workspaceRef?: BackendScopedWorkspaceRef
}

interface WorkspaceScopedBundleRefreshAttachParams extends BundleRefreshAttachParams {
  backendKey?: BackendKey
}

export interface AttachErrorContext extends AttachContext {
  error: unknown
  message: string
}

export interface SessionNamePromptConfig {
  title: string
  label: string
  placeholder?: string
}

export interface AttachTerminalSize {
  cols: number
  rows: number
}

export interface UseAttachControllerOptions {
  flow: Pick<UseFlowReturn, 'showInput' | 'showMessage' | 'close'>
  attachSessionWithBundleRefresh: UseBundleRefreshAttachFlowResult['attachSessionWithBundleRefresh']
  /**
   * When non-null, a previous workspace attach failed in a recoverable way.
   * Provided by `useBundleRefreshAttachFlow().recoverableParams`.
   * `attachAnyway()` will retry with `scriptPolicy: 'skip'` using these params.
   */
  recoverableAttachParams?: BundleRefreshAttachParams | null
  defaultProjectName?: string | null
  defaultBackendKey?: BackendKey
  resolveWorkspaceRef?: (workspaceId: string) => BackendScopedWorkspaceRef | null
  resolveProjectName?: (workspaceId: string) => string | null
  getAttachSize?: () => AttachTerminalSize | null
  sessionNamePrompt?: SessionNamePromptConfig
  closePromptOnSubmit?: boolean
  preflightSessionAttach?: (sessionId: string) => boolean | Promise<boolean>
  onBeforeAttach?: (context: AttachContext) => void | Promise<void>
  onAttachSuccess?: (context: AttachContext) => void | Promise<void>
  onAttachCancelled?: (context: AttachContext) => void | Promise<void>
  onAttachError?: (context: AttachErrorContext) => void | Promise<void>
}

export interface UseAttachControllerResult {
  attach: (params: BundleRefreshAttachParams, backendKeyOverride?: BackendKey) => Promise<boolean>
  attachFromSelection: (selection: AttachSelectionParams) => Promise<void>
  /** True when the last workspace attach failed in a recoverable way. */
  canAttachAnyway: boolean
  /** Retry the last failed workspace attach with `scriptPolicy: 'skip'`. */
  attachAnyway: () => Promise<boolean>
}

function parseProjectNameFromWorkspaceId(workspaceId: string): string | null {
  const separator = workspaceId.indexOf(':')
  if (separator <= 0) {
    return null
  }
  return workspaceId.slice(0, separator) || null
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (typeof error === 'string' && error.length > 0) {
    return error
  }

  return 'Failed to attach session'
}

const DEFAULT_PROMPT: SessionNamePromptConfig = {
  title: 'New Session',
  label: 'Session name (required):',
  placeholder: 'Enter a session name, e.g. "debug" or "feature-x"',
}

export function useAttachController(options: UseAttachControllerOptions): UseAttachControllerResult {
  const {
    flow,
    attachSessionWithBundleRefresh,
    recoverableAttachParams,
    defaultProjectName,
    defaultBackendKey = 'local',
    resolveWorkspaceRef,
    resolveProjectName,
    getAttachSize,
    sessionNamePrompt,
    closePromptOnSubmit,
    preflightSessionAttach,
    onBeforeAttach,
    onAttachSuccess,
    onAttachCancelled,
    onAttachError,
  } = options

  const withAttachSize = useCallback((params: BundleRefreshAttachParams): BundleRefreshAttachParams => {
    const hasCols = typeof params.cols === 'number' && params.cols > 0
    const hasRows = typeof params.rows === 'number' && params.rows > 0
    if (hasCols && hasRows) {
      return params
    }

    const size = getAttachSize?.()
    if (!size || size.cols <= 0 || size.rows <= 0) {
      return params
    }

    return {
      ...params,
      cols: hasCols ? params.cols : size.cols,
      rows: hasRows ? params.rows : size.rows,
    }
  }, [getAttachSize])

  const attach = useCallback(async (
    params: BundleRefreshAttachParams,
    backendKeyOverride?: BackendKey,
  ): Promise<boolean> => {
    const attachParams = withAttachSize(params)
    const target: AttachTarget = attachParams.sessionId || !attachParams.workspaceId ? 'session' : 'workspace'
    const projectName = attachParams.workspaceId
      ? resolveProjectName?.(attachParams.workspaceId) ??
        parseProjectNameFromWorkspaceId(attachParams.workspaceId) ??
        defaultProjectName ??
        null
      : defaultProjectName ?? null

    const defaultBackend = backendKeyOverride ?? defaultBackendKey
    const resolvedWorkspaceRef = attachParams.workspaceId
      ? resolveWorkspaceRef?.(attachParams.workspaceId)
      : null
    const ref: BackendScopedWorkspaceRef = attachParams.workspaceId
      ? resolvedWorkspaceRef ?? {
          backendKey: defaultBackend,
          workspaceId: attachParams.workspaceId,
        }
      : {
          backendKey: defaultBackend,
          workspaceId: '',
        }
    const attachParamsWithBackend: WorkspaceScopedBundleRefreshAttachParams =
      attachParams.workspaceId && !attachParams.sessionId
        ? {
            ...attachParams,
            backendKey: ref.backendKey,
          }
        : attachParams

    const context: AttachContext = {
      target,
      params: attachParams,
      projectName,
      workspaceRef: target === 'workspace' && attachParams.workspaceId ? ref : undefined,
    }

    await onBeforeAttach?.(context)

    try {
      const attached = await attachSessionWithBundleRefresh(ref, attachParamsWithBackend)

      if (!attached) {
        await onAttachCancelled?.(context)
        return false
      }

      await onAttachSuccess?.(context)
      return true
    } catch (error) {
      const message = toErrorMessage(error)
      if (onAttachError) {
        await onAttachError({
          ...context,
          error,
          message,
        })
      } else {
        flow.showMessage({
          title: 'Session Failed',
          message,
          variant: 'error',
        })
      }

      return false
    }
  }, [
    attachSessionWithBundleRefresh,
    defaultBackendKey,
    defaultProjectName,
    flow,
    onAttachCancelled,
    onAttachError,
    onAttachSuccess,
    onBeforeAttach,
    resolveProjectName,
    resolveWorkspaceRef,
    withAttachSize,
  ])

  const attachAnyway = useCallback(async (): Promise<boolean> => {
    if (!recoverableAttachParams) {
      return false
    }

    const params = recoverableAttachParams as WorkspaceScopedBundleRefreshAttachParams

    return attach(
      {
        ...params,
        scriptPolicy: 'skip',
      },
      params.backendKey,
    )
  }, [attach, recoverableAttachParams])

  const attachFromSelection = useCallback(async (selection: AttachSelectionParams): Promise<void> => {
    if (selection.sessionId) {
      const proceed = (await preflightSessionAttach?.(selection.sessionId)) ?? true
      if (!proceed) {
        return
      }

      const attachParams: BundleRefreshAttachParams = {
        sessionId: selection.sessionId,
      }
      if (selection.workspaceId !== undefined) {
        attachParams.workspaceId = selection.workspaceId
      }
      if (selection.viewOnly !== undefined) {
        attachParams.viewOnly = selection.viewOnly
      }
      if (selection.paneId !== undefined) {
        attachParams.paneId = selection.paneId
      }

      await attach(attachParams, selection.backendKey)
      return
    }

    if (!selection.workspaceId) {
      return
    }

    const prompt = sessionNamePrompt ?? DEFAULT_PROMPT
    flow.showInput({
      ...prompt,
      validation: (value) => (value.trim().length > 0 ? null : 'Session name is required'),
      onSubmit: async (sessionName) => {
        if (closePromptOnSubmit ?? true) {
          flow.close()
        }
        await attach({
          workspaceId: selection.workspaceId,
          sessionName: sessionName.trim() || undefined,
          paneId: selection.paneId,
        }, selection.backendKey)
      },
    })
  }, [attach, closePromptOnSubmit, flow, preflightSessionAttach, sessionNamePrompt])

  return {
    attach,
    attachFromSelection,
    canAttachAnyway: !!recoverableAttachParams,
    attachAnyway,
  }
}
