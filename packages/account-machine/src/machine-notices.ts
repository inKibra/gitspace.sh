import type { RelayNotice, RelayNoticeTopic } from '@gitspace/protocol';

/** What reads the cloud state each topic names. Every read coalesces repeats itself. */
export interface MachineNoticeTargets {
  /** Machine-wide assignments; through them every ready checkout also applies its workspace's cloud version. */
  assignments(): Promise<void>;
  snapshot(workspaceId: string): Promise<void>;
  release(): Promise<void>;
  devices(): void;
  settings(): Promise<void>;
  /** Lifecycle streams of the workspace, or of every workspace when null. */
  environment(workspaceId: string | null): void;
  failed(topic: RelayNoticeTopic, error: unknown): void;
}

/** Relay notices carry no state: each names what changed, and the machine reads the authoritative state over HTTP.
 * A batch triggers each read once; an `assignments` read already brings every ready checkout's snapshot. */
export function receiveMachineNotices(notices: readonly RelayNotice[], targets: MachineNoticeTargets): void {
  const topics = new Set(notices.flatMap(notice => notice.topics));
  const workspaces = (topic: RelayNoticeTopic) => new Set(notices.flatMap(notice => notice.topics.includes(topic) ? [notice.workspaceId ?? null] : []));
  const assignments = topics.has('assignments') || workspaces('workspace.snapshot').has(null);
  if (assignments) void targets.assignments().catch(error => targets.failed('assignments', error));
  else for (const workspaceId of workspaces('workspace.snapshot')) {
    if (workspaceId !== null) void targets.snapshot(workspaceId).catch(error => targets.failed('workspace.snapshot', error));
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
  failed(topic: RelayNoticeTopic): void;
  /** The topic's read succeeded: the next failure starts again from the shortest wait. */
  settled(topic: RelayNoticeTopic): void;
}

/** Retries failed notice reads until they succeed. One retry per topic waits at a time: a failure while it waits, of
 * the retry chain or of a read a new notice asked for, only lengthens the next wait, so chains never multiply. A
 * failed workspace read retries as an assignments read, which applies every ready checkout's version. */
export function createNoticeRetries(read: (topic: RelayNoticeTopic) => void, schedule: (run: () => void, delayMs: number) => void = (run, delayMs) => { setTimeout(run, delayMs); }): NoticeRetries {
  const attempts = new Map<RelayNoticeTopic, number>();
  const waiting = new Set<RelayNoticeTopic>();
  return {
    failed(topic) {
      const retry = topic === 'workspace.snapshot' ? 'assignments' : topic;
      const attempt = (attempts.get(retry) ?? 0) + 1;
      attempts.set(retry, attempt);
      if (waiting.has(retry)) return;
      waiting.add(retry);
      schedule(() => { waiting.delete(retry); read(retry); }, Math.min(NOTICE_RETRY_MAX_MS, 1000 * 2 ** attempt));
    },
    settled(topic) { attempts.delete(topic); },
  };
}
