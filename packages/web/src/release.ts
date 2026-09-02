import type { DeploymentStatusView, LaunchProgressView, ReleaseStatus, ReleaseTarget } from '@gitspace/protocol';
import type { BadgeProps } from '@gitspace/ui';

/** One release as the machine reports it; the wire shape, not the zod one. */
export type ReleaseRecordView = DeploymentStatusView['releases'][number];

export const RELEASE_TARGETS: readonly ReleaseTarget[] = ['worker', 'machine', 'frontend'];
export const RELEASE_TARGET_LABEL: Record<ReleaseTarget, string> = { worker: 'Worker', machine: 'Machine', frontend: 'Frontend' };
export const RELEASE_STATUS_COLOR: Record<ReleaseStatus, NonNullable<BadgeProps['color']>> = { pending: 'amber', applied: 'green', failed: 'red', skipped: 'gray' };

/** `channel:<version>` shas name our build; git shas are shown truncated. */
export function shortSha(sha: string): string {
  return sha.startsWith('channel:') ? sha.slice('channel:'.length) : sha.slice(0, 10);
}

/** The release the tenant asked for, by label; `Channel build` when `desired.sha` is null. */
export function desiredLabel(status: DeploymentStatusView): string {
  if (status.desired.sha === null) return 'Channel build';
  return status.releases.find((release) => release.sha === status.desired.sha)?.label ?? shortSha(status.desired.sha);
}

/** Newest release built from a workspace, or null when it never launched. */
export function workspaceRelease(status: DeploymentStatusView, workspaceId: string): ReleaseRecordView | null {
  let newest: ReleaseRecordView | null = null;
  for (const release of status.releases) {
    if (release.workspaceId !== workspaceId) continue;
    if (!newest || release.createdAt > newest.createdAt) newest = release;
  }
  return newest;
}

/** Machine roll-up for one release: how many reported applied out of those that reported at all. */
export function machineRollup(record: ReleaseRecordView): { status: ReleaseStatus; text: string } {
  const entries = Object.values(record.status.machines);
  if (entries.length === 0) return { status: 'pending', text: 'Machines · waiting' };
  if (entries.includes('failed')) return { status: 'failed', text: `Machines · ${entries.filter((status) => status === 'failed').length} failed` };
  const applied = entries.filter((status) => status === 'applied').length;
  return applied === entries.length
    ? { status: 'applied', text: `Machines · ${applied} applied` }
    : { status: 'pending', text: `Machines · ${applied}/${entries.length} applied` };
}

/**
 * Whether the fleet is still moving toward `desired`: a launched target has
 * not applied yet, or a machine that reported in still runs another sha and
 * has not failed the swap. Drives the status poll while a launch is in flight.
 */
export function converging(status: DeploymentStatusView): boolean {
  const sha = status.desired.sha;
  const record = sha === null ? null : status.releases.find((release) => release.sha === sha) ?? null;
  if (sha !== null && !record) return false;
  const targets = status.desired.targets;
  if (record && targets.includes('worker') && record.status.worker === 'pending') return true;
  if (record && targets.includes('frontend') && record.status.frontend === 'pending') return true;
  // `desired.targets` is empty on the channel build: machines still on a workspace release are not converging toward anything.
  if (!targets.includes('machine')) return false;
  const machines: Array<[string, string | null]> = [[status.thisMachine.machineId, status.thisMachine.sha]];
  for (const [machineId, running] of Object.entries(status.current.machines)) if (machineId !== status.thisMachine.machineId) machines.push([machineId, running.sha]);
  return machines.some(([machineId, running]) => running !== sha && record?.status.machines[machineId] !== 'failed');
}

/** One progress line of a launch, as the `deployment` fact events deliver it. */
export interface LaunchLogEntry { phase: string; message: string; at: string }

/**
 * A launch as this browser follows it: `deployment.status.launch` seeds it,
 * fact events append to it, and the browser adds `restart` / `reload` once the
 * machine swaps. `status` and `error` mirror the machine's view.
 */
export interface LaunchTrack {
  launchId: string;
  workspaceId: string;
  targets: readonly ReleaseTarget[];
  sha: string | null;
  status: LaunchProgressView['status'];
  error: string | null;
  log: LaunchLogEntry[];
}

export function launchTrackFrom(launch: LaunchProgressView): LaunchTrack {
  return { launchId: launch.launchId, workspaceId: launch.workspaceId, targets: launch.targets, sha: launch.sha, status: launch.status, error: launch.error, log: [{ phase: launch.phase, message: launch.message, at: launch.updatedAt }] };
}

/** Launcher phases in the order they happen; build and upload interleave per target and share a rank. `restart` / `reload` are appended by the browser. */
const LAUNCH_PHASE_RANK: Record<string, number> = { queued: 0, install: 1, build: 2, upload: 2, stage: 3, launch: 4, launched: 5, restart: 6, reload: 7 };

/** The furthest progress line (latest among equals): polls and events interleave, so the log is not phase-ordered. */
export function latestLaunchProgress(track: LaunchTrack): LaunchLogEntry | null {
  let furthest: LaunchLogEntry | null = null;
  for (const entry of track.log) {
    if (entry.phase === 'failed') continue;
    if (!furthest || (LAUNCH_PHASE_RANK[entry.phase] ?? 0) >= (LAUNCH_PHASE_RANK[furthest.phase] ?? 0)) furthest = entry;
  }
  return furthest;
}

/** Appends a progress line unless the log already holds it (status polls and events overlap, and clocks may skew). */
export function appendLaunchProgress(track: LaunchTrack, entry: LaunchLogEntry, update: Partial<Pick<LaunchTrack, 'sha' | 'status' | 'error'>> = {}): LaunchTrack {
  const seen = track.log.some((line) => line.phase === entry.phase && line.message === entry.message);
  return { ...track, ...update, log: seen ? track.log : [...track.log, entry] };
}

/** The build target a `build` / `upload` message names; the launcher's messages are `building tenant worker`, `uploading …/machine.js`, … */
export function launchMessageTarget(message: string): ReleaseTarget | null {
  if (/worker/i.test(message)) return 'worker';
  if (/machine/i.test(message)) return 'machine';
  if (/frontend/i.test(message)) return 'frontend';
  return null;
}

const LAUNCH_PHASE_LABEL: Record<string, string> = {
  queued: 'Preparing…',
  install: 'Installing…',
  upload: 'Uploading…',
  stage: 'Staging release…',
  launch: 'Launching…',
  launched: 'Launched',
  restart: 'Restarting this machine…',
  reload: 'Reloading…',
  failed: 'Launch failed',
};

/** Short human label for the pill: `Building machine…`, `Uploading…`. */
export function launchPhaseLabel(entry: LaunchLogEntry): string {
  if (entry.phase === 'build') {
    const target = launchMessageTarget(entry.message);
    return target ? `Building ${RELEASE_TARGET_LABEL[target].toLowerCase()}…` : 'Building…';
  }
  return LAUNCH_PHASE_LABEL[entry.phase] ?? `${entry.phase}…`;
}

/** Machines already on `desired.sha` out of every machine the status knows, for the `converging n/m` pill. */
export function machineConvergence(status: DeploymentStatusView): { applied: number; total: number } {
  const running: Array<string | null> = [status.thisMachine.sha];
  for (const [machineId, machine] of Object.entries(status.current.machines)) if (machineId !== status.thisMachine.machineId) running.push(machine.sha);
  return { applied: running.filter((sha) => sha === status.desired.sha).length, total: running.length };
}

/** Label of the release this machine runs, or `stable` on the channel build. */
export function runningLabel(status: DeploymentStatusView): string {
  const sha = status.thisMachine.sha;
  if (sha === null) return 'stable';
  return status.releases.find((release) => release.sha === sha)?.label ?? shortSha(sha);
}
