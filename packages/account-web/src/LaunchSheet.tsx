import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Elevated, useShape } from '@gitspace/ui';
import { Rocket02, XClose } from '@untitledui/icons';
import { StatusDot } from './GitSpaceShell.js';
import { latestLaunchProgress, launchMessageTarget, RELEASE_TARGET_LABEL, RELEASE_TARGETS, shortSha, type LaunchTrack } from './release.js';
import { useState } from 'react';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema } from '@gitspace/protocol-runtime';
import type { InspectorView } from '@gitspace/protocol';
import { useWorkspaceRuntime } from './useWorkspaceRuntime.js';
import { useWorkspaceRunMachine } from './useWorkspaceRunMachine.js';
import { rpcClient } from './rpc-client.js';
import { rpcErrorMessage } from './rpc-error-message.js';

/** Resolve the selected workspace, not whichever workspace happens to be open behind its menu. */
export function LaunchMachineDialog({ projectId, workspaceId, machines, onClose, onLaunch }: {
  projectId: string;
  workspaceId: string;
  machines: InspectorView['machines'];
  onClose(): void;
  onLaunch(machineId: string): Promise<void>;
}) {
  const runtime = useWorkspaceRuntime(projectId, workspaceId);
  const selection = useWorkspaceRunMachine(runtime.snapshot);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await operation(); } catch (cause) { setError(rpcErrorMessage(cause, 'Launch workspace')); } finally { setBusy(false); }
  };
  const machine = selection.machine;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <DialogContent size="sm">
      <DialogHeader><DialogTitle>Launch GitSpace from here</DialogTitle><DialogDescription>Choose the workspace machine that will build this release. No other online machine will be used.</DialogDescription></DialogHeader>
      {runtime.error ? <p role="alert" className="text-caption text-destructive">{runtime.error}<Button variant="ghost" onClick={runtime.retry}>Retry machines</Button></p> : null}
      <label className="flex flex-col gap-2 text-caption">Build machine<select aria-label="Build machine" className="min-h-10 rounded-md bg-surface-3 px-3 text-body" value={machine?.id ?? ''} disabled={busy} onChange={event => selection.select(event.target.value)}>
        <option value="">Choose a machine</option>
        {selection.machines.map(candidate => <option key={candidate.id} value={candidate.id}>{machines.find(item => item.id === candidate.id)?.label ?? candidate.id} · {candidate.state}</option>)}
      </select></label>
      {!runtime.snapshot ? <p role="status">Loading workspace machines…</p> : !machine ? <p role="status" className="text-caption text-muted-foreground">{selection.machines.length ? 'Choose a machine to build the release.' : 'Attach a machine to this workspace to launch GitSpace.'}</p> : !machine.ready ? <p role="status" className="text-caption text-muted-foreground">Resume this cache and wait until it is live before launching. Resuming does not launch a release.</p> : null}
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
      <DialogFooter>
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        {machine && !machine.ready ? <Button variant="secondary" disabled={busy || !runtime.connected} onClick={() => void perform(async () => {
          const result = await rpcClient.runtime.attachment.cache.request({ ...RuntimeIdentitySchema.parse({ projectId, workspaceId }), machineId: RuntimeMachineIdSchema.parse(machine.id), requestId: crypto.randomUUID() });
          if (result.status === 'error') throw result.error;
        })}>Resume cache</Button> : null}
        <Button variant="primary" disabled={busy || !runtime.connected || !machine?.ready} onClick={() => void perform(async () => {
          if (!machine?.ready) throw new Error('Attach and choose a live machine to launch GitSpace.');
          await onLaunch(machine.id);
        })}>Launch</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

export type LaunchStepState = 'done' | 'active' | 'pending' | 'failed';
export interface LaunchStep {
  id: string;
  label: string;
  state: LaunchStepState;
  /** The newest message for the step while it runs, or the failure for a failed one. */
  detail: string | null;
  /** Build only: one line per target. */
  sub: Array<{ label: string; state: LaunchStepState }>;
}

/** Sheet step each launcher phase belongs to; `restart` / `reload` are appended by the browser. */
const PHASE_STEP: Record<string, number> = { queued: 0, install: 0, build: 1, upload: 2, stage: 3, launch: 4, launched: 4, restart: 5, reload: 6 };
const STEP_LABELS = ['Install', 'Build', 'Upload', 'Stage', 'Launch', 'Restart this machine', 'Reload'] as const;
const DOT_COLOR: Record<LaunchStepState, { color: 'green' | 'blue' | 'dim' | 'red'; pulse: boolean }> = {
  done: { color: 'green', pulse: false },
  active: { color: 'blue', pulse: true },
  pending: { color: 'dim', pulse: false },
  failed: { color: 'red', pulse: false },
};

/**
 * Derives dot states from the log. Build and upload interleave per target on
 * the machine, so Build stays active until every target's build has been
 * logged; the per-target sub-lines carry the exact position.
 */
export function launchSteps(track: LaunchTrack): LaunchStep[] {
  const swaps = track.targets.includes('machine');
  const count = swaps ? STEP_LABELS.length : 5;
  const progress = track.log.filter((entry) => entry.phase !== 'failed');
  const latest = latestLaunchProgress(track);
  const failed = track.status === 'failed';
  let current = latest ? PHASE_STEP[latest.phase] ?? 0 : 0;
  let currentDone = false;
  if (latest?.phase === 'launched') {
    if (swaps) current = 5;
    else currentDone = true;
  }
  const builds = progress.filter((entry) => entry.phase === 'build');
  const allBuilt = track.targets.every((target) => builds.some((entry) => launchMessageTarget(entry.message) === target));
  const stateOf = (index: number): LaunchStepState => {
    if (index < current) return 'done';
    if (index > current) return 'pending';
    if (failed) return 'failed';
    return currentDone ? 'done' : 'active';
  };
  return STEP_LABELS.slice(0, count).map((label, index) => {
    let state = stateOf(index);
    // Build is not finished by the first upload: the next target still has to build.
    if (index === 1 && current === 2 && !allBuilt) state = failed ? 'done' : 'active';
    const sub = index === 1
      ? RELEASE_TARGETS.filter((target) => track.targets.includes(target)).map((target) => {
          const built = builds.find((entry) => launchMessageTarget(entry.message) === target) ?? null;
          const isLatest = built !== null && built === latest;
          const subState: LaunchStepState = built === null
            ? (state === 'done' ? 'done' : 'pending')
            : isLatest ? (failed ? 'failed' : 'active') : 'done';
          return { label: RELEASE_TARGET_LABEL[target], state: subState };
        })
      : [];
    const detail = state === 'failed'
      ? track.error ?? track.log.find((entry) => entry.phase === 'failed')?.message ?? 'Launch failed'
      : state === 'active' && index !== 1
        ? (latest && (PHASE_STEP[latest.phase] ?? 0) === index ? latest.message : index === 5 ? 'Waiting for the machine to swap' : null)
        : null;
    return { id: label, label, state, detail, sub };
  });
}

export interface LaunchSheetProps {
  launch: LaunchTrack;
  open: boolean;
  onOpenChange(open: boolean): void;
  /** Re-launch the same workspace and targets after a failure. */
  onRetry(): void | Promise<void>;
}

/**
 * Bottom-left progress sheet for a launch. Not a Fluid `Dialog`: that one
 * always renders a full-viewport backdrop and centres the panel with an
 * inline transform, so it cannot sit in a corner while the app stays usable.
 */
export function LaunchSheet({ launch, open, onOpenChange, onRetry }: LaunchSheetProps) {
  const shape = useShape();
  if (!open) return null;
  const steps = launchSteps(launch);
  const settled = launch.status === 'succeeded' && (!launch.targets.includes('machine') || launch.log.some((entry) => entry.phase === 'reload'));
  const title = launch.status === 'failed' ? 'Launch failed' : settled ? 'GitSpace launched' : 'Launching GitSpace';
  return <Elevated offset={4} role="dialog" aria-label="Launch progress" className={`${shape.container} fixed bottom-4 left-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-3 p-4`}>
    <header className="flex items-start gap-2">
      <span className="mt-0.5 text-muted-foreground"><Rocket02 width={16} height={16} strokeWidth={1.5} /></span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-semibold text-foreground">{title}</span>
        <span className="block truncate font-mono text-caption text-muted-foreground">{launch.sha ? shortSha(launch.sha) : 'resolving commit'} · {launch.targets.map((target) => RELEASE_TARGET_LABEL[target].toLowerCase()).join(', ')}</span>
      </span>
      <Button variant="ghost" size="icon-compact" aria-label="Close launch progress" onClick={() => onOpenChange(false)}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
    </header>
    <ol className="flex flex-col gap-1.5" aria-label="Launch phases">
      {steps.map((step) => <li key={step.id} data-state={step.state} className="flex flex-col gap-1">
        <span className="flex items-center gap-2 text-caption">
          <StatusDot {...DOT_COLOR[step.state]} />
          <span className={step.state === 'pending' ? 'text-muted-foreground' : step.state === 'failed' ? 'text-destructive' : 'text-foreground'}>{step.label}</span>
          {step.detail ? <span className={`min-w-0 truncate ${step.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`} title={step.detail}>· {step.detail}</span> : null}
        </span>
        {step.sub.length ? <span className="flex items-center gap-3 pl-5 text-caption text-muted-foreground">
          {step.sub.map((line) => <span key={line.label} data-state={line.state} className="flex items-center gap-1.5"><StatusDot {...DOT_COLOR[line.state]} />{line.label}</span>)}
        </span> : null}
      </li>)}
    </ol>
    {launch.status === 'failed' ? <footer className="flex flex-col gap-2">
      <p role="alert" className="text-caption text-destructive">{launch.error ?? 'The launch did not finish.'}</p>
      <span className="flex justify-end gap-2">
        <Button variant="ghost" size="compact" onClick={() => onOpenChange(false)}>Close</Button>
        <Button variant="primary" size="compact" onClick={() => void onRetry()}>Retry</Button>
      </span>
    </footer> : null}
  </Elevated>;
}

export interface RevertProgress {
  status: 'running' | 'failed';
  error: string | null;
}

export function RevertSheet({ progress, open, onOpenChange, onRetry }: { progress: RevertProgress; open: boolean; onOpenChange(open: boolean): void; onRetry(): void | Promise<void> }) {
  const shape = useShape();
  if (!open) return null;
  const failed = progress.status === 'failed';
  return <Elevated offset={4} role="dialog" aria-label="Back to stable progress" className={`${shape.container} fixed bottom-4 left-4 z-50 flex w-[calc(100%-2rem)] max-w-sm flex-col gap-3 p-4`}>
    <header className="flex items-start gap-2">
      <span className="min-w-0 flex-1 text-body font-semibold text-foreground">{failed ? 'Back to stable failed' : 'Going back to stable'}</span>
      <Button variant="ghost" size="icon-compact" aria-label="Close revert progress" onClick={() => onOpenChange(false)}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
    </header>
    {failed ? <p role="alert" className="text-caption text-destructive">{progress.error}</p> : <span className="flex items-center gap-2 text-caption text-muted-foreground"><StatusDot color="blue" pulse />Waiting for the stable frontend to activate</span>}
    {failed ? <footer className="flex justify-end gap-2">
      <Button variant="ghost" size="compact" onClick={() => onOpenChange(false)}>Close</Button>
      <Button variant="primary" size="compact" onClick={() => void onRetry()}>Retry</Button>
    </footer> : null}
  </Elevated>;
}

export const LAUNCHED_STORAGE_KEY = 'gitspace.launched';
/** How long after the reload the `Now running` strip is still worth showing. */
export const LAUNCHED_BANNER_MAX_AGE_MS = 60_000;
export interface LaunchedMark { sha: string; label: string; at: number }

/** The launch this page was reloaded into, when the mark is fresh; anything older or malformed is dropped. */
export function readLaunchedMark(storage: Pick<Storage, 'getItem' | 'removeItem'>, now: number): LaunchedMark | null {
  const raw = storage.getItem(LAUNCHED_STORAGE_KEY);
  if (raw === null) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  const mark = parsed !== null && typeof parsed === 'object' && 'sha' in parsed && 'label' in parsed && 'at' in parsed && typeof parsed.sha === 'string' && typeof parsed.label === 'string' && typeof parsed.at === 'number'
    ? { sha: parsed.sha, label: parsed.label, at: parsed.at }
    : null;
  if (mark === null || now - mark.at > LAUNCHED_BANNER_MAX_AGE_MS) {
    storage.removeItem(LAUNCHED_STORAGE_KEY);
    return null;
  }
  return mark;
}

/** Post-reload strip at the top of the agent canvas: what this page now runs, and the way back. */
export function LaunchedBanner({ mark, onRevert, onDismiss }: { mark: LaunchedMark; onRevert(): void | Promise<void>; onDismiss(): void }) {
  const shape = useShape();
  return <Elevated offset={2} role="status" className={`${shape.container} flex items-center gap-2 px-3 py-2 text-caption`}>
    <span className="text-muted-foreground"><Rocket02 width={14} height={14} strokeWidth={1.5} /></span>
    <span className="text-foreground">Now running <strong>{mark.label}</strong></span>
    <span className="text-muted-foreground">·</span>
    <Button variant="ghost" size="compact" onClick={() => { void onRevert(); }}>Back to stable</Button>
    <Button variant="ghost" size="icon-compact" aria-label="Dismiss" onClick={onDismiss}><XClose width={14} height={14} strokeWidth={1.5} /></Button>
  </Elevated>;
}
