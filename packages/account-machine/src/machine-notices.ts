import type { RelayNotice, RelayNoticeTopic } from '@gitspace/protocol';
import { CloudControlError } from './cloud-runtime-client.js';
import type { WorkspaceIdentity } from './runtime-executor.js';

/** What reads the cloud state each topic names. Every read coalesces repeats itself. */
export interface MachineNoticeTargets {
  /** The project of a workspace this machine holds or held a checkout of, or null. */
  projectOf(workspaceId: string): string | null;
  /** One workspace's assignments, or the machine's when null; through them every ready checkout read also applies its
   * workspace's cloud version. */
  assignments(workspace: WorkspaceIdentity | null): Promise<void>;
  snapshot(workspaceId: string): Promise<void>;
  release(): Promise<void>;
  devices(): void;
  settings(): Promise<void>;
  /** Lifecycle streams of the workspace, or of every workspace when null. */
  environment(workspaceId: string | null): void;
  /** A read failed; `workspace` names the workspace whose assignments it read, null for a machine-wide read. */
  failed(topic: RelayNoticeTopic, error: unknown, workspace?: WorkspaceIdentity | null): void;
}

/** Relay notices carry no state: each names what changed, and the machine reads the authoritative state over HTTP.
 * A batch triggers each read once. An `assignments` notice naming a workspace whose project is known (from the notice,
 * or from a checkout of it) reads that workspace's assignments; any other reads the machine's, which also brings every
 * ready checkout's snapshot. */
export function receiveMachineNotices(notices: readonly RelayNotice[], targets: MachineNoticeTargets): void {
  const topics = new Set(notices.flatMap(notice => notice.topics));
  const workspaces = (topic: RelayNoticeTopic) => new Set(notices.flatMap(notice => notice.topics.includes(topic) ? [notice.workspaceId ?? null] : []));
  const identify = (workspaceId: string, projectId?: string): WorkspaceIdentity | null => {
    const project = projectId ?? targets.projectOf(workspaceId);
    return project === null ? null : { projectId: project, workspaceId };
  };
  const targeted = new Map<string, WorkspaceIdentity>();
  let machineWide = workspaces('workspace.snapshot').has(null);
  for (const notice of notices) {
    if (!notice.topics.includes('assignments')) continue;
    const workspace = notice.workspaceId === undefined ? null : identify(notice.workspaceId, notice.projectId);
    if (workspace) targeted.set(workspace.workspaceId, workspace);
    else machineWide = true;
  }
  /** A workspace read the cloud refused (the workspace or its project is being deleted) gives way to the machine-wide
   * read, which releases checkouts of workspaces no longer assigned here. */
  const readWorkspace = async (workspace: WorkspaceIdentity) => {
    try { await targets.assignments(workspace); }
    catch (error) {
      if (!(error instanceof CloudControlError)) throw error;
      await targets.assignments(null);
    }
  };
  if (machineWide) void targets.assignments(null).catch(error => targets.failed('assignments', error, null));
  else {
    for (const workspace of targeted.values()) void readWorkspace(workspace).catch(error => targets.failed('assignments', error, workspace));
    for (const workspaceId of workspaces('workspace.snapshot')) {
      if (workspaceId !== null && !targeted.has(workspaceId)) void targets.snapshot(workspaceId).catch(error => targets.failed('workspace.snapshot', error, identify(workspaceId)));
    }
  }
  if (topics.has('release')) void targets.release().catch(error => targets.failed('release', error));
  if (topics.has('devices')) targets.devices();
  if (topics.has('settings')) void targets.settings().catch(error => targets.failed('settings', error));
  const environments = workspaces('environment');
  if (environments.has(null)) targets.environment(null);
  else for (const workspaceId of environments) if (workspaceId !== null) targets.environment(workspaceId);
}

/** The longest wait between two retries of a failed read. */
const NOTICE_RETRY_MAX_MS = 60_000;

export interface NoticeRetries {
  /** A read a notice asked for failed: it is asked for again with backoff, 1 s doubling to a minute. */
  failed(topic: RelayNoticeTopic, workspace?: WorkspaceIdentity | null): void;
  /** The topic's read (of `workspace`'s assignments, when given) succeeded: its next failure starts again from the
   * shortest wait. */
  settled(topic: RelayNoticeTopic, workspace?: WorkspaceIdentity | null): void;
}

/** Retries failed notice reads until they succeed. One retry per topic, and per workspace for assignments, waits at a
 * time: a failure while it waits, of the retry chain or of a read a new notice asked for, only lengthens the next wait,
 * so chains never multiply, and one slow workspace never delays another's. A failed snapshot read retries as its
 * workspace's assignments read (the machine's when its project is unknown), which applies its ready checkouts'
 * version. */
export function createNoticeRetries(read: (topic: RelayNoticeTopic, workspace: WorkspaceIdentity | null) => void, schedule: (run: () => void, delayMs: number) => void = (run, delayMs) => { setTimeout(run, delayMs); }): NoticeRetries {
  const attempts = new Map<string, number>();
  const waiting = new Set<string>();
  return {
    failed(topic, workspace = null) {
      const retry = topic === 'workspace.snapshot' ? 'assignments' : topic;
      const key = `${retry}\n${workspace?.workspaceId ?? ''}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      if (waiting.has(key)) return;
      waiting.add(key);
      schedule(() => { waiting.delete(key); read(retry, workspace); }, Math.min(NOTICE_RETRY_MAX_MS, 1000 * 2 ** attempt));
    },
    settled(topic, workspace = null) { attempts.delete(`${topic}\n${workspace?.workspaceId ?? ''}`); },
  };
}
