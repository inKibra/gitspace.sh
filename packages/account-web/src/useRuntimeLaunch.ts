import { useEffect, useRef, useState } from 'react';
import type { DeploymentStatusView, LaunchProgressView, LaunchSourceView, ReleaseTarget } from '@gitspace/protocol';
import { appendLaunchProgress, launchTrackFrom, shortSha, type LaunchTrack } from './release.js';
import { LAUNCHED_STORAGE_KEY, readLaunchedMark, type LaunchedMark, type RevertProgress } from './LaunchSheet.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { useBackToStable } from './useBackToStable.js';

const reloadFrontend = () => window.location.reload();
export interface RuntimeLaunch {
  launch: LaunchTrack | null;
  revertProgress: RevertProgress | null;
  open: boolean;
  setOpen(open: boolean): void;
  mark: LaunchedMark | null;
  dismiss(): void;
  start(source: LaunchSourceView, machineId: string, targets: readonly ReleaseTarget[]): Promise<void>;
  revert(): Promise<void>;
  /** Stop following a running launch whose building machine is gone; a later report from that machine still wins. */
  discard(launchId: string): Promise<void>;
}

/** Follow accepted launch progress through the machine swap; never infer build success from a disconnect. */
export function useRuntimeLaunch(status: DeploymentStatusView | null | undefined, refresh: () => unknown, reload = reloadFrontend): RuntimeLaunch {
  const [launch, setLaunch] = useState<LaunchTrack | null>(null);
  const [open, setOpen] = useState(false);
  const [mark, setMark] = useState(() => readLaunchedMark(window.sessionStorage, Date.now()));
  const followed = useRef<string | null>(null);
  const reloaded = useRef<string | null>(null);
  const operation = useRef(0);
  const localAttempt = useRef(false);
  useEffect(() => () => { operation.current++; }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const stable = useBackToStable(status, refresh, () => {
    window.sessionStorage.removeItem(LAUNCHED_STORAGE_KEY);
    setMark(null);
    setOpen(false);
    reload();
  });
  useEffect(() => { if (stable.progress) setOpen(true); }, [stable.progress]);
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
  const start = async (source: LaunchSourceView, machineId: string, targets: readonly ReleaseTarget[]) => {
    const token = ++operation.current;
    stable.stop();
    localAttempt.current = true;
    followed.current = null;
    setOpen(true);
    try {
      if (!machineId.trim()) throw new Error('Attach and choose a machine to launch GitSpace.');
      const result = await rpcClient.deployment.launch({ source, machineId, targets: [...targets] });
      if (result.status === 'error') throw result.error;
      if (operation.current !== token) return;
      followed.current = result.value.launchId;
      accept(result.value);
    } catch (error) {
      if (operation.current === token) {
        const message = rpcErrorMessage(error, 'Launch workspace');
        setLaunch({ launchId: `rejected:${token}`, source, targets: [...targets], sha: null, status: 'failed', error: message, log: [{ phase: 'failed', message, at: new Date().toISOString() }] });
      }
      throw error;
    }
    await refreshRef.current();
  };
  const revert = async () => {
    ++operation.current;
    localAttempt.current = true;
    followed.current = null;
    // Do not keep a previous launch's polling loop alive during the revert.
    setLaunch(null);
    await stable.revert();
  };
  const discard = async (launchId: string) => {
    const result = await rpcClient.deployment.discardLaunch({ launchId });
    if (result.status === 'error') throw result.error;
    await refreshRef.current();
  };
  const dismiss = () => { window.sessionStorage.removeItem(LAUNCHED_STORAGE_KEY); setMark(null); };
  return { launch, revertProgress: stable.progress, open, setOpen, mark, dismiss, start, revert, discard };
}
