import type { UseFlowReturn } from '../../components/Flow.js';
import {
  useAttachController,
  type UseAttachControllerOptions,
  type UseAttachControllerResult,
} from '../session/useAttachController.js';
import {
  resolveAttachCancelledTransition,
  resolveAttachErrorTransition,
  resolveAttachSuccessTransition,
} from '../session/resolveAttachTransition.js';

export type UseAttachActionsOptions = UseAttachControllerOptions;

export function useAttachActions(options: UseAttachActionsOptions): UseAttachControllerResult {
  return useAttachController(options);
}

export interface UseTuiAttachActionsOptions {
  base: UseAttachControllerOptions & {
    flow: Pick<UseFlowReturn, 'showInput' | 'showMessage' | 'close' | 'showConfirm'>;
  };
  view: string;
  dispatch: (action: any) => void;
  setAttachedAgentSession: (value: { workspaceId: string; sessionId: string } | null) => void;
  setScriptWorkspaceName: (value: string) => void;
  refreshWorkspaces: () => Promise<void>;
  localSessions: Array<{ id: string; attached: boolean }>;
}

export function useTuiAttachActions(options: UseTuiAttachActionsOptions): UseAttachControllerResult {
  return useAttachController({
    ...options.base,
    preflightSessionAttach: async (sessionId) => {
      const sessionInfo = options.localSessions.find((session) => session.id === sessionId);
      if (!sessionInfo) {
        await options.refreshWorkspaces();
        options.dispatch({ type: 'SET_ERROR', error: 'Session no longer exists. The session list has been refreshed.' });
        return false;
      }

      if (!sessionInfo.attached) {
        return true;
      }

      return new Promise<boolean>((resolve) => {
        options.base.flow.showConfirm({
          title: 'Session In Use',
          message: 'This session is currently attached. Steal it?',
          variant: 'warning',
          confirmLabel: 'Steal',
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
        });
      });
    },
    onBeforeAttach: ({ target, params }) => {
      options.setAttachedAgentSession(null);
      options.base.onBeforeAttach?.({
        target,
        params,
        projectName: null,
      } as any);
      if (target === 'workspace' && params.workspaceId && !params.command && options.view !== 'workspace-detail') {
        options.setScriptWorkspaceName(params.workspaceId.split(':').slice(-1)[0] ?? params.workspaceId);
        options.dispatch({ type: 'SET_VIEW', view: 'scripts' });
      }
    },
    onAttachSuccess: ({ params }) => {
      const transition = resolveAttachSuccessTransition({ view: options.view as any, command: params.command });
      if (transition.nextView) {
        options.dispatch({ type: 'SET_VIEW', view: transition.nextView });
      }
    },
    onAttachCancelled: ({ target }) => {
      const transition = resolveAttachCancelledTransition({ view: options.view as any, target });
      if (transition.nextView) {
        options.dispatch({ type: 'SET_VIEW', view: transition.nextView });
      }
    },
    onAttachError: ({ target, message }) => {
      const transition = resolveAttachErrorTransition({ view: options.view as any, target, message });
      if (transition.nextView) {
        options.dispatch({ type: 'SET_VIEW', view: transition.nextView });
      }
      options.base.flow.showMessage({
        title: transition.isWorkspaceScriptFailure ? 'Workspace Script Failed' : 'Session Failed',
        message,
        variant: 'error',
      });
    },
  });
}
