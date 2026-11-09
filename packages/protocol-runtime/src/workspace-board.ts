import { z } from 'zod';
import { cutForAgent, type TextSource, type WorkspacePhase, type WorkspaceReport, type WorkspaceStatusSummary } from '@gitspace/protocol-workspace';

/** One workspace as the project agent's board shows it, from stored rows only: the project's definition, the account's
 * status row and the project's pull-request links. No workspace object is read. */
export type WorkspaceBoardRow = {
  workspaceId: string;
  name: string;
  phase: WorkspacePhase | null;
  /** The definition's lifecycle: active, provisioning, archived, failed, … */
  lifecycle: string;
  /** Null until the workspace first reported. */
  status: WorkspaceStatusSummary | null;
  /** The main conversation's oldest unanswered question or approval. */
  waitingOn: WorkspaceReport['waitingOn'];
  /** Every pull request linked to it, newest link first (see `BoardPullRequest`). */
  pullRequests: BoardPullRequest[];
  /** When its activity (working, waiting on a person, idle, failed) or what it waits on last changed. */
  since: string | null;
  /** Its main agent's latest message, as the workspace last reported it. */
  lastReply: string | null;
  /** Where the whole of `lastReply` is; null when the row predates sources. */
  lastReplySource: TextSource | null;
  /** Its journal's newest entries, newest first, as the workspace last reported them. */
  journal: WorkspaceJournalLine[];
};
/** A pull request linked to a workspace, with its state and checks as last read from GitHub (null until first read). */
export type BoardPullRequest = {
  number: number;
  state: 'open' | 'draft' | 'merged' | 'closed' | null;
  checks: 'passing' | 'failing' | 'pending' | 'none' | null;
};
/** Journal entries an index row keeps, and a board line names. */
export const BOARD_JOURNAL_ENTRIES = 3;
/** A workspace's newest journal entries as its index row keeps them, newest first: each entry's kind, title and time. */
export const WorkspaceJournalLinesSchema = z.array(z.object({ kind: z.string().max(64), title: z.string().max(200), at: z.iso.datetime() }).strict()).max(BOARD_JOURNAL_ENTRIES);
export type WorkspaceJournalLine = z.infer<typeof WorkspaceJournalLinesSchema>[number];

/** Characters of a waited-on prompt a board line carries. */
const PROMPT_CHARACTERS = 120;
/** Characters of the latest message a board line carries. */
const REPLY_CHARACTERS = 200;

/** What the workspace's agents are doing: working, waiting on a person (and on what), idle or failed. A cut question
 * says how long it is and that `space_workspace questions` reads it whole. */
export function workspaceActivity(row: Pick<WorkspaceBoardRow, 'status' | 'waitingOn' | 'workspaceId'>): string {
  if (!row.status) return 'no status yet';
  switch (row.status.primaryColor) {
    case 'red': return 'failed';
    case 'green': return 'working';
    case 'orange': {
      if (row.waitingOn) {
        const prompt = row.waitingOn.prompt.replace(/\s+/gu, ' ').trim();
        const whole = row.waitingOn.characters ?? prompt.length;
        const cut = prompt.length > PROMPT_CHARACTERS || whole > prompt.length
          ? `"${prompt.slice(0, PROMPT_CHARACTERS)}…" (${Math.min(PROMPT_CHARACTERS, prompt.length)} of ${whole.toLocaleString('en-US')} characters; whole: space_workspace questions { workspaceId: "${row.workspaceId}" })`
          : `"${prompt}"`;
        return `waiting on a person ${row.waitingOn.kind === 'approval' ? 'to approve' : 'to answer'} ${cut}`;
      }
      return row.status.sync.conflicts > 0 ? 'waiting on a person to resolve sync conflicts' : 'waiting on a person';
    }
    case 'blue': case 'dim': return 'idle';
  }
}

/** `HH:MM` UTC on the day of `at`, `MM-DD HH:MM` on another day. */
function clock(time: Date, at: Date): string {
  const stamp = time.toISOString();
  return stamp.slice(0, 10) === at.toISOString().slice(0, 10) ? stamp.slice(11, 16) : `${stamp.slice(5, 10)} ${stamp.slice(11, 16)}`;
}

function timestamp(at: Date): string {
  return `${at.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

/** Archived and deleting workspaces leave the board. */
function onBoard(row: WorkspaceBoardRow): boolean {
  return row.lifecycle !== 'archived' && row.lifecycle !== 'deleting';
}

/** Checks as a board line says them; none is left unsaid. */
const CHECKS_WORDS: Record<NonNullable<BoardPullRequest['checks']>, string | null> = { passing: 'checks pass', failing: 'checks fail', pending: 'checks running', none: null };

/** `PR #15 (open, checks fail)`: a merged or closed pull request without its checks, one not read yet as its number. */
function pullRequestWords(pull: BoardPullRequest): string {
  if (pull.state === null) return `PR #${pull.number}`;
  const checks = pull.state === 'open' || pull.state === 'draft' ? CHECKS_WORDS[pull.checks ?? 'none'] : null;
  return `PR #${pull.number} (${pull.state}${checks ? `, ${checks}` : ''})`;
}

/** `Name (id) · phase · activity · PR #n (state) · since HH:MM`, the lifecycle only when the workspace is not active;
 * its pull requests open and draft first, then merged and closed, each in the order it was linked. Then its latest
 * message and its newest journal entries, each on its own indented line when it has them. */
export function workspaceBoardLine(row: WorkspaceBoardRow, at: Date): string {
  // A stable sort: merged and closed after the rest, each group in the order it was linked.
  const pulls = [...row.pullRequests].sort((left, right) => Number(left.state === 'merged' || left.state === 'closed') - Number(right.state === 'merged' || right.state === 'closed'));
  const head = [
    `${row.name} (${row.workspaceId})`, row.phase ?? 'no phase', ...(row.lifecycle === 'active' ? [] : [row.lifecycle]), workspaceActivity(row),
    ...pulls.map(pullRequestWords), ...(row.since === null ? [] : [`since ${clock(new Date(row.since), at)}`]),
  ].join(' · ');
  const lines = [head];
  if (row.lastReply?.trim()) lines.push(`  last message: ${cutForAgent(row.lastReply, REPLY_CHARACTERS, { workspaceId: row.workspaceId, source: row.lastReplySource })}`);
  if (row.journal.length) lines.push(`  journal: ${row.journal.map(entry => `${entry.kind} "${entry.title}" (${clock(new Date(entry.at), at)})`).join(' · ')}`);
  return lines.join('\n');
}

/** Every workspace on the board, one line each, stamped with the time it was read. */
export function workspaceBoard(rows: readonly WorkspaceBoardRow[], at: Date): string {
  const shown = rows.filter(onBoard);
  if (shown.length === 0) return `Workspace board, ${timestamp(at)}: no workspaces.`;
  return [`Workspace board, ${timestamp(at)} (${shown.length} workspace${shown.length === 1 ? '' : 's'}):`, ...shown.map(row => `- ${workspaceBoardLine(row, at)}`)].join('\n');
}

/** The workspaces whose line changed between two reads, new ones and those that left the board; null when none did. */
export function workspaceBoardChanges(previous: readonly WorkspaceBoardRow[], current: readonly WorkspaceBoardRow[], since: Date, at: Date): string | null {
  const before = new Map(previous.filter(onBoard).map(row => [row.workspaceId, row]));
  const after = new Map(current.filter(onBoard).map(row => [row.workspaceId, row]));
  const lines: string[] = [];
  for (const row of after.values()) {
    const earlier = before.get(row.workspaceId);
    const line = workspaceBoardLine(row, at);
    if (!earlier) lines.push(`- New: ${line}`);
    else if (workspaceBoardLine(earlier, at) !== line) lines.push(`- ${line}`);
  }
  for (const row of before.values()) {
    if (after.has(row.workspaceId)) continue;
    const left = current.find(item => item.workspaceId === row.workspaceId);
    lines.push(`- Removed: ${row.name} (${row.workspaceId}), ${left ? left.lifecycle : 'deleted'}`);
  }
  if (lines.length === 0) return null;
  return [`Workspace board changes since ${clock(since, at)} (now ${timestamp(at)}); each line replaces that workspace's line:`, ...lines].join('\n');
}
