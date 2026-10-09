import { useEffect, useRef, useState } from 'react';
import type { DeploymentStatusView, LaunchProgressView, ReleaseTarget } from '@gitspace/protocol';
import { appendLaunchProgress, launchTrackFrom, shortSha, type LaunchTrack } from './release.js';
import { LAUNCHED_STORAGE_KEY, readLaunchedMark, type LaunchedMark, type RevertProgress } from './LaunchSheet.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

const reloadFrontend = () => window.location.reload();
export const REVERT_ACTIVATION_TIMEOUT_MS = 60_000;
export interface RuntimeLaunch {
  launch: LaunchTrack | null;
  revertProgress: RevertProgress | null;
  open: boolean;
  setOpen(open: boolean): void;
  mark: LaunchedMark | null;
  dismiss(): void;
  start(workspaceId: string, targets: readonly ReleaseTarget[]): Promise<void>;
  revert(): Promise<void>;
}

/** Follow accepted launch progress through the machine swap; never infer build success from a disconnect. */
export function useRuntimeLaunch(status: DeploymentStatusView | null | undefined, refresh: () => unknown, reload = reloadFrontend): RuntimeLaunch {
  const [launch, setLaunch] = useState<LaunchTrack | null>(null);
  const [open, setOpen] = useState(false);
  const [revertProgress, setRevertProgress] = useState<RevertProgress | null>(null);
  const [mark, setMark] = useState(() => readLaunchedMark(window.sessionStorage, Date.now()));
  const followed = useRef<string | null>(null);
  const reloaded = useRef<string | null>(null);
  const operation = useRef(0);
  const [reverting, setReverting] = useState<{ operation: number; acceptedStatus: DeploymentStatusView | null | undefined; deadline: number } | null>(null);
  const statusRef = useRef(status);
  statusRef.current = status;
  const localAttempt = useRef(false);
  useEffect(() => () => { operation.current++; }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const accept = (progress: LaunchProgressView) => {
    setLaunch(previous => previous?.launchId === progress.launchId
      ? appendLaunchProgress(previous, { phase: progress.phase, message: progress.message, at: progress.updatedAt }, { sha: progress.sha, status: progress.status, error: progress.error })
      : launchTrackFrom(progress));
  };
  useEffect(() => {
    const progress = status?.launch;
    if (localAttempt.current && progress?.launchId !== followed.current) return;
    if (!progress) return;
    if (progress.status === 'running' && followed.current !== progress.launchId) {
      followed.current = progress.launchId;
      setOpen(true);
    }
    accept(progress);
  }, [status?.launch]);
  useEffect(() => {
    if (!launch || launch.status === 'failed' || followed.current !== launch.launchId || reloaded.current === launch.launchId) return;
    const timer = setInterval(() => { void refreshRef.current(); }, 1500);
    return () => clearInterval(timer);
  }, [launch?.launchId, launch?.status, launch?.log.at(-1)?.phase]);
  useEffect(() => {
    if (!status || !launch?.sha || launch.status !== 'succeeded' || followed.current !== launch.launchId || reloaded.current === launch.launchId) return;
    const at = new Date().toISOString();
    if (launch.targets.includes('machine') && Object.entries(status.current.machines).some(([machineId, machine]) => machine.sha !== launch.sha && status.releases.find(release => release.sha === launch.sha)?.status.machines[machineId] !== 'failed')) {
      setLaunch(previous => previous && previous.log.some(entry => entry.phase === 'restart') ? previous : previous && appendLaunchProgress(previous, { phase: 'restart', message: 'Waiting for the machine to swap', at }));
      return;
    }
    if (launch.targets.includes('frontend') && (status.desired.frontend !== launch.sha || status.releases.find(release => release.sha === launch.sha)?.status.frontend !== 'applied')) return;
    if (launch.targets.includes('worker') && status.current.worker.sha !== launch.sha) return;
    reloaded.current = launch.launchId;
    const nextMark = { sha: launch.sha, label: status.releases.find(release => release.sha === launch.sha)?.label ?? shortSha(launch.sha), at: Date.now() };
    setLaunch(previous => previous && appendLaunchProgress(previous, { phase: 'reload', message: 'Reloading the launched frontend', at }));
    window.sessionStorage.setItem(LAUNCHED_STORAGE_KEY, JSON.stringify(nextMark));
    reload();
  }, [status, launch, reload]);
  useEffect(() => {
    if (!reverting || reverting.operation !== operation.current) return;
    const expire = () => {
      if (operation.current !== reverting.operation) return;
      operation.current++;
      setReverting(null);
      setRevertProgress({ status: 'failed', error: 'The stable frontend did not activate within 60 seconds. Retry going back to stable.' });
      setOpen(true);
    };
    const timer = setInterval(() => {
      if (operation.current !== reverting.operation) return;
      if (performance.now() >= reverting.deadline) { expire(); return; }
      void Promise.resolve().then(() => {
        if (operation.current === reverting.operation && performance.now() < reverting.deadline) return refreshRef.current();
      }).catch(() => {});
    }, 1500);
    const deadline = setTimeout(expire, Math.max(0, reverting.deadline - performance.now()));
    return () => { clearInterval(timer); clearTimeout(deadline); };
  }, [reverting]);
  useEffect(() => {
    if (!reverting || reverting.operation !== operation.current || performance.now() >= reverting.deadline || !status || status === reverting.acceptedStatus) return;
    // frontend() selects channel assets synchronously; those assets belong to the
    // active worker, so a cleared selection alone does not prove a stable frontend.
    if (status.desired.frontend !== null || status.desired.worker !== null || status.current.worker.sha !== null || !status.current.worker.version) return;
    setReverting(null);
    operation.current++;
    setRevertProgress(null);
    setOpen(false);
    window.sessionStorage.removeItem(LAUNCHED_STORAGE_KEY);
    setMark(null);
    reload();
  }, [status, reverting, reload]);
  const start = async (workspaceId: string, targets: readonly ReleaseTarget[]) => {
    const token = ++operation.current;
    setReverting(null);
    setRevertProgress(null);
    localAttempt.current = true;
    followed.current = null;
    setOpen(true);
    try {
      const result = await rpcClient.deployment.launch({ workspaceId, targets: [...targets] });
      if (result.status === 'error') throw result.error;
      if (operation.current !== token) return;
      followed.current = result.value.launchId;
      accept(result.value);
    } catch (error) {
      if (operation.current === token) {
        const message = rpcErrorMessage(error, 'Launch workspace');
        setLaunch({ launchId: `rejected:${token}`, workspaceId, targets: [...targets], sha: null, status: 'failed', error: message, log: [{ phase: 'failed', message, at: new Date().toISOString() }] });
      }
      throw error;
    }
    await refreshRef.current();
  };
  const revert = async () => {
    const token = ++operation.current;
    setReverting(null);
    setRevertProgress({ status: 'running', error: null });
    setOpen(true);
    localAttempt.current = true;
    followed.current = null;
    // Do not keep a previous launch's polling loop alive during the revert.
    setLaunch(null);
    try {
      const result = await rpcClient.deployment.revert({});
      if (result.status === 'error') throw result.error;
      if (operation.current !== token) return;
      setReverting({ operation: token, acceptedStatus: statusRef.current, deadline: performance.now() + REVERT_ACTIVATION_TIMEOUT_MS });
    } catch (error) {
      if (operation.current === token) {
        setRevertProgress({ status: 'failed', error: rpcErrorMessage(error, 'Back to stable') });
      }
      throw error;
    }
    // The activation deadline, not transport availability, settles this attempt.
    try { await refreshRef.current(); } catch {}
  };
  const dismiss = () => { window.sessionStorage.removeItem(LAUNCHED_STORAGE_KEY); setMark(null); };
  return { launch, revertProgress, open, setOpen, mark, dismiss, start, revert };
}
