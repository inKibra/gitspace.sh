import { useEffect, useRef, useState } from 'react';
import type { DeploymentStatusView } from '@gitspace/protocol';
import type { RevertProgress } from './LaunchSheet.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

export interface BackToStable {
  /** The followed revert while it runs, or how it failed; null otherwise. */
  progress: RevertProgress | null;
  /** Starts Back to stable and follows it until the account records how it ended. */
  revert(): Promise<void>;
  /** Stops following: another action took this page over. The account still finishes the revert. */
  stop(): void;
}

/**
 * Back to stable runs in the account, which records it as `status.revert` whether or not this page stays. The page
 * follows it by reading status until it ends: a success reloads into the stable frontend, a failure shows the
 * account's reason. A revert already running when the page opens is followed too.
 */
export function useBackToStable(status: DeploymentStatusView | null | undefined, refresh: () => unknown, reload: () => void = () => window.location.reload()): BackToStable {
  const [followed, setFollowed] = useState<string | null>(null);
  const [progress, setProgress] = useState<RevertProgress | null>(null);
  const operation = useRef(0);
  // Once this page has started or stopped a revert itself, it follows only the revert its own request names.
  const local = useRef(false);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const reloadRef = useRef(reload);
  reloadRef.current = reload;
  useEffect(() => () => { operation.current++; }, []);
  useEffect(() => {
    const revert = status?.revert;
    if (!revert) return;
    if (followed === null) {
      if (revert.status !== 'running' || local.current) return;
      setFollowed(revert.revertId);
      setProgress({ status: 'running', error: null });
      return;
    }
    if (revert.revertId !== followed || revert.status === 'running') return;
    setFollowed(null);
    if (revert.status === 'failed') {
      setProgress({ status: 'failed', error: revert.error ?? 'Back to stable failed.' });
      return;
    }
    setProgress(null);
    reloadRef.current();
  }, [status?.revert, followed]);
  useEffect(() => {
    if (followed === null) return;
    const timer = setInterval(() => { void Promise.resolve().then(() => refreshRef.current()).catch(() => {}); }, 1500);
    return () => clearInterval(timer);
  }, [followed]);
  const revert = async () => {
    const token = ++operation.current;
    local.current = true;
    setFollowed(null);
    setProgress({ status: 'running', error: null });
    try {
      const result = await rpcClient.deployment.revert({});
      if (result.status === 'error') throw result.error;
      if (operation.current !== token) return;
      if (!result.value.revert) throw new Error('The account did not start Back to stable.');
      setFollowed(result.value.revert.revertId);
    } catch (error) {
      if (operation.current === token) setProgress({ status: 'failed', error: rpcErrorMessage(error, 'Back to stable') });
      throw error;
    }
    // Following reads status again on its own; this read only shortens the wait for the first one.
    try { await refreshRef.current(); } catch {}
  };
  const stop = () => {
    operation.current++;
    local.current = true;
    setFollowed(null);
    setProgress(null);
  };
  return { progress, revert, stop };
}
