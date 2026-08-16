import type { AttachTarget } from './useAttachController.js'

/** App view identifiers used by the attach-transition logic. */
export type AppView = 'projects' | 'workspace-detail' | 'terminal' | 'replay' | 'inbox' | 'scripts' | 'events'

export interface AttachSuccessTransitionParams {
  view: AppView
  command?: string
}

export interface AttachOutcomeTransitionParams {
  view: AppView
  target: AttachTarget
}

export function resolveAttachSuccessTransition(params: AttachSuccessTransitionParams): {
  nextView: AppView | null
  resetSessionSwitching: boolean
} {
  if (params.view === 'workspace-detail') {
    return {
      nextView: null,
      resetSessionSwitching: true,
    }
  }

  return {
    nextView: 'terminal',
    resetSessionSwitching: false,
  }
}

export function resolveAttachCancelledTransition(params: AttachOutcomeTransitionParams): {
  nextView: AppView | null
  resetSessionSwitching: boolean
} {
  if (params.target === 'workspace' && (params.view === 'scripts' || params.view === 'workspace-detail')) {
    return {
      nextView: null,
      resetSessionSwitching: true,
    }
  }

  return {
    nextView: 'projects',
    resetSessionSwitching: true,
  }
}

export function resolveAttachErrorTransition(params: AttachOutcomeTransitionParams & { message: string }): {
  nextView: AppView | null
  resetSessionSwitching: boolean
  isWorkspaceScriptFailure: boolean
} {
  const isWorkspaceScriptFailure = params.message.startsWith('Workspace scripts failed during')

  if (
    params.target === 'workspace'
    && (isWorkspaceScriptFailure || params.view === 'workspace-detail')
  ) {
    return {
      nextView: null,
      resetSessionSwitching: true,
      isWorkspaceScriptFailure,
    }
  }

  return {
    nextView: 'projects',
    resetSessionSwitching: true,
    isWorkspaceScriptFailure,
  }
}
