import { z } from 'zod';
import type { WorkspacePhase, WorkspaceReport, WorkspaceStatusSummary } from '@gitspace/protocol-workspace';

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
  pullRequest: number | null;
  /** When its activity (working, waiting on a person, idle, failed) or what it waits on last changed. */
  since: string | null;
  /** Its main agent's latest message, as the workspace last reported it. */
  lastReply: string | null;
  /** Its journal's newest entries, newest first, as the workspace last reported them. */
  journal: WorkspaceJournalLine[];
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

/** What the workspace's agents are doing: working, waiting on a person (and on what), idle or failed. */
export function workspaceActivity(row: Pick<WorkspaceBoardRow, 'status' | 'waitingOn'>): string {
  if (!row.status) return 'no status yet';
  switch (row.status.primaryColor) {
    case 'red': return 'failed';
    case 'green': return 'working';
    case 'orange': {
      if (row.waitingOn) {
        const prompt = row.waitingOn.prompt.replace(/\s+/gu, ' ').trim();
        const cut = prompt.length > PROMPT_CHARACTERS ? `${prompt.slice(0, PROMPT_CHARACTERS)}…` : prompt;
        return `waiting on a person ${row.waitingOn.kind === 'approval' ? 'to approve' : 'to answer'} "${cut}"`;
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

/** `Name (id) · phase · activity · PR #n · since HH:MM`, the lifecycle only when the workspace is not active; then its
 * latest message and its newest journal entries, each on its own indented line when it has them. */
export function workspaceBoardLine(row: WorkspaceBoardRow, at: Date): string {
  const head = [
    `${row.name} (${row.workspaceId})`, row.phase ?? 'no phase', ...(row.lifecycle === 'active' ? [] : [row.lifecycle]), workspaceActivity(row),
    ...(row.pullRequest === null ? [] : [`PR #${row.pullRequest}`]), ...(row.since === null ? [] : [`since ${clock(new Date(row.since), at)}`]),
  ].join(' · ');
  const reply = row.lastReply?.replace(/\s+/gu, ' ').trim();
  const lines = [head];
  if (reply) lines.push(`  last message: "${reply.length > REPLY_CHARACTERS ? `${reply.slice(0, REPLY_CHARACTERS)}…` : reply}"`);
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
