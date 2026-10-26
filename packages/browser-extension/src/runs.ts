/** What scripts (`browser.run`) on your Chrome look like to you (docs/APERTURE-DESIGN.md §6.1): a marked group title
 * while they run, and a local log of each one. */

const RUNNING = '▶ ';
/** The mark of a group whose workspace's agent has Everything (`powers.ts`). */
const EVERYTHING = '⚡ ';

/** A workspace group's Chrome title: marked with "▶ " while at least one script runs on it and with "⚡ " while its
 * agent has Everything (`everything`), unmarked otherwise. */
export function groupTitle(title: string, running: boolean, everything = false): string {
  let plain = title;
  while (plain.startsWith(RUNNING) || plain.startsWith(EVERYTHING)) plain = plain.slice((plain.startsWith(RUNNING) ? RUNNING : EVERYTHING).length);
  return (running ? RUNNING : '') + (everything ? EVERYTHING : '') + plain;
}

/** Why a script ended: its session released it, you stopped it, its deadline passed, or the relay connection went. */
export type RunEndReason = 'released' | 'stopped' | 'deadline' | 'disconnected';

/** A script while it runs, as the extension keeps it. */
export type LiveRun = {
  body: { scope: { attemptId: string; projectId: string; workspaceId: string }; command: { grant: { body: { groupName: string } } } };
  /** SHA-256 (hex) of the signed script text. */
  scriptSha256: string;
  /** The sites the script may use. */
  sites: string[];
  startedAt: string;
  /** Commands the script sent, and how many of them the extension refused. */
  commands: number;
  refused: number;
};

/** One entry of the extension's local run log (IndexedDB `run-log`, newest first). */
export type RunLogEntry = {
  attemptId: string;
  workspace: { projectId: string; workspaceId: string; groupName: string };
  scriptSha256: string;
  sites: string[];
  startedAt: string;
  endedAt: string;
  endReason: RunEndReason;
  commands: number;
  refused: number;
};

/** The entries the log keeps. */
export const RUN_LOG_LIMIT = 50;

/** The log entry of a script that ended now. */
export function runLogEntry(run: LiveRun, endReason: RunEndReason, endedAt: string): RunLogEntry {
  const { scope, command } = run.body;
  return {
    attemptId: scope.attemptId,
    workspace: { projectId: scope.projectId, workspaceId: scope.workspaceId, groupName: command.grant.body.groupName },
    scriptSha256: run.scriptSha256, sites: run.sites, startedAt: run.startedAt, endedAt, endReason, commands: run.commands, refused: run.refused,
  };
}
