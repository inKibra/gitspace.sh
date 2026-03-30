import type { ReplayFrame, ReplayFrameTarget, ReplayTimeline } from '../../lib/tmux-lite/replay/index.js';
import type { ReviewOperation, ReviewResult } from '../../types/review.js';
import type { AppClientContext } from './context.js';
import { agentSessionFailure, agentSessionSuccess, describeAppClientError, type AgentSessionCommandResult } from './errors.js';

export interface AppReplayReviewClient {
  sendReviewRequest: (backendKey: string, workspaceId: string, operation: ReviewOperation) => Promise<AgentSessionCommandResult<ReviewResult>>;
  dismissReplay: (backendKey: string, replayId: string) => Promise<AgentSessionCommandResult<{ replayId: string }>>;
  undismissReplay: (backendKey: string, replayId: string) => Promise<AgentSessionCommandResult<{ replayId: string }>>;
  cancelReplayRequests: (backendKey: string) => void;
  getReplayFrame: (backendKey: string, replayId: string, target?: ReplayFrameTarget) => Promise<AgentSessionCommandResult<ReplayFrame>>;
  getReplayTimeline: (backendKey: string, replayId: string) => Promise<AgentSessionCommandResult<ReplayTimeline>>;
}

export function createAppReplayReviewClient(context: AppClientContext): AppReplayReviewClient {
  return {
    sendReviewRequest: async (backendKey, workspaceId, operation) => {
      const backend = context.multi.getBackend(backendKey);
      if (!backend) {
        return agentSessionFailure({ code: 'backend-unavailable', message: `Backend ${backendKey} is not available`, workspaceId, backendKey });
      }
      try {
        const value = await backend.sendReviewRequest(operation);
        return agentSessionSuccess(value);
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to send review request'), workspaceId, backendKey, cause: error });
      }
    },
    dismissReplay: async (backendKey, replayId) => {
      const backend = context.multi.getBackend(backendKey);
      if (!backend?.dismissReplay) {
        return agentSessionFailure({ code: 'operation-unavailable', message: 'Replay dismissal unavailable', workspaceId: '', backendKey });
      }
      try {
        await backend.dismissReplay(replayId);
        return agentSessionSuccess({ replayId });
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to dismiss replay'), workspaceId: '', backendKey, cause: error });
      }
    },
    undismissReplay: async (backendKey, replayId) => {
      const backend = context.multi.getBackend(backendKey);
      if (!backend?.undismissReplay) {
        return agentSessionFailure({ code: 'operation-unavailable', message: 'Replay restore unavailable', workspaceId: '', backendKey });
      }
      try {
        await backend.undismissReplay(replayId);
        return agentSessionSuccess({ replayId });
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to restore replay'), workspaceId: '', backendKey, cause: error });
      }
    },
    cancelReplayRequests: (backendKey) => {
      const backend = context.multi.getBackend(backendKey);
      backend?.cancelPendingReplayRequests?.();
    },
    getReplayFrame: async (backendKey, replayId, target) => {
      const backend = context.multi.getBackend(backendKey);
      if (!backend?.getReplayFrame) {
        return agentSessionFailure({ code: 'operation-unavailable', message: 'Replay frames unavailable', workspaceId: '', backendKey });
      }
      try {
        return agentSessionSuccess(await backend.getReplayFrame(replayId, target));
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to load replay frame'), workspaceId: '', backendKey, cause: error });
      }
    },
    getReplayTimeline: async (backendKey, replayId) => {
      const backend = context.multi.getBackend(backendKey);
      if (!backend?.getReplayTimeline) {
        return agentSessionFailure({ code: 'operation-unavailable', message: 'Replay timeline unavailable', workspaceId: '', backendKey });
      }
      try {
        return agentSessionSuccess(await backend.getReplayTimeline(replayId));
      } catch (error) {
        return agentSessionFailure({ code: 'operation-unavailable', message: describeAppClientError(error, 'Failed to load replay timeline'), workspaceId: '', backendKey, cause: error });
      }
    },
  };
}
