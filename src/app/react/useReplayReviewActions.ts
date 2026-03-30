import { useCallback } from 'react';
import type { ReviewOperation } from '../../types/review.js';
import type { ReplayFrameTarget } from '../../lib/tmux-lite/replay/index.js';
import type { AppClient, AppClientContext, AgentSessionCommandError } from '../client/index.js';
import { useAppClient } from './useAppClient.js';

export interface UseReplayReviewActionsOptions {
  client?: AppClient | AppClientContext | null;
  onError?: (message: string, error: AgentSessionCommandError) => void;
}

export function useReplayReviewActions(options: UseReplayReviewActionsOptions) {
  const client = useAppClient(options.client ?? null);

  const report = useCallback((result: { ok: false; error: AgentSessionCommandError }) => {
    options.onError?.(result.error.message, result.error);
  }, [options.onError]);

  return {
    sendReviewRequest: useCallback(async (backendKey: string, workspaceId: string, operation: ReviewOperation) => {
      const result = await client.replayReview.sendReviewRequest(backendKey, workspaceId, operation);
      if (!result.ok) {
        report(result);
        throw result.error.cause ?? new Error(result.error.message);
      }
      return result.value;
    }, [client, report]),
    toggleReplayDismissed: useCallback(async (backendKey: string, replayId: string, dismissed: boolean) => {
      const result = dismissed
        ? await client.replayReview.undismissReplay(backendKey, replayId)
        : await client.replayReview.dismissReplay(backendKey, replayId);
      if (!result.ok) {
        report(result);
        throw result.error.cause ?? new Error(result.error.message);
      }
      return !dismissed;
    }, [client, report]),
    cancelReplayRequests: useCallback((backendKey: string) => {
      client.replayReview.cancelReplayRequests(backendKey);
    }, [client]),
    loadReplayFrame: useCallback(async (backendKey: string, replayId: string, target?: ReplayFrameTarget) => {
      const result = await client.replayReview.getReplayFrame(backendKey, replayId, target);
      if (!result.ok) {
        report(result);
        throw result.error.cause ?? new Error(result.error.message);
      }
      return result.value;
    }, [client, report]),
    loadReplayTimeline: useCallback(async (backendKey: string, replayId: string) => {
      const result = await client.replayReview.getReplayTimeline(backendKey, replayId);
      if (!result.ok) {
        report(result);
        throw result.error.cause ?? new Error(result.error.message);
      }
      return result.value;
    }, [client, report]),
  };
}
