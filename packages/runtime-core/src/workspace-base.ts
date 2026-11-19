import { defineDoc, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import type { UserMessage } from '@earendil-works/pi-ai';
import { boundedReplay } from './documents.js';

/** A workspace agent's instruction about Base lines. It is the same on every turn, so the prompt cache holds: what
 * changes goes into the conversation. */
export const WORKSPACE_BASE_INSTRUCTION = 'Base lines: a turn may start with one line beginning "Base ·". It says that what your branch builds on (your stack parent\'s branch when this workspace is stacked, else the project\'s base branch) moved, merged or changed since you were last told: its latest commit, and how far behind your branch is when the cloud can tell. The latest Base line is the current state; earlier ones are history. No line comes while nothing changed.';

/** What a workspace builds on, as read at a turn's start. */
export type WorkspaceBase = {
  baseBranch: string;
  /** The stack parent; null when the workspace merges into `baseBranch` itself. `merged`: its branch is in `baseBranch`. */
  parent: { id: string; name: string; branch: string; merged: boolean } | null;
  /** The head of the parent's branch, or of `baseBranch` when unstacked; null when the cloud holds none. */
  head: string | null;
  /** The first line of `head`'s message; null when unread. */
  subject: string | null;
  /** Commits `head` has that the workspace's branch lacks; null when the cloud cannot tell. */
  behind: number | null;
  /** Files changed both on the branch and on `head` since their merge base; null when not read. */
  overlapping: number | null;
};

/** What a conversation was last told: the parent, the head and whether the parent had merged. */
type BaseMark = { parentId: string | null; head: string; merged: boolean };
const initialBase = () => ({ told: null, turn: null });
export const WorkspaceBaseDoc = defineDoc<{ told: BaseMark | null; turn: string | null }>({ kind: 'gitspace.workspace-base', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: initialBase, checkpointWhen: boundedReplay });

/** The Base line for `base` given what the conversation was last told; null when there is nothing new. A first reading
 * is said only when the branch is behind or its parent merged. */
function baseLine(told: BaseMark | null, base: WorkspaceBase): string | null {
  const { parent, head, behind, overlapping, baseBranch } = base;
  if (head === null) return null;
  const merged = parent?.merged ?? false;
  const restacked = told !== null && told.parentId !== (parent?.id ?? null);
  if (told === null ? !merged && !behind : !restacked && told.head === head && told.merged === merged) return null;
  const target = parent ? `${parent.name} (your stack parent)` : baseBranch;
  if (parent && merged) return `Base · ${restacked ? `Restacked onto ${target}, which` : target} merged into ${baseBranch}; restack onto ${baseBranch}: \`git rebase --onto ${baseBranch} ${parent.branch}\`.`;
  const subject = base.subject === null ? '' : ` (latest: “${base.subject.length > 120 ? `${base.subject.slice(0, 119)}…` : base.subject}”)`;
  const where = `${restacked ? `Restacked onto ${target} at` : told === null ? `${target} is at` : `${target} moved to`} ${head.slice(0, 7)}${subject}.`;
  const files = overlapping ? `; ${overlapping} ${overlapping === 1 ? 'file' : 'files'} you changed also changed there` : '';
  const position = behind === null ? '' : behind === 0 ? ' Your branch has all of it.' : ` Your branch is ${behind} behind${files}.`;
  return `Base · ${where}${position}`;
}

/**
 * The Base line a workspace agent's turn (`turn`, its run) starts with, read once per turn and appended to the
 * conversation as a notice, so later requests carry it at the same place. Null when nothing is appended: nothing
 * changed since the conversation was last told, or the base could not be read (logged; the next turn reads again).
 */
export async function baseForTurn(harness: Harness, conversationId: ConversationId, turn: string, read: () => Promise<WorkspaceBase | null>, context: Context): Promise<UserMessage | null> {
  const state = await harness.snapshot(WorkspaceBaseDoc, conversationId, context);
  if (state?.turn === turn) return null;
  let base: WorkspaceBase | null = null;
  try { base = await read(); }
  catch (error) { console.warn(JSON.stringify({ event: 'workspace_base_unread', conversationId: String(conversationId), error: error instanceof Error ? error.message : String(error) })); }
  const told = state?.told ?? null;
  const text = base === null ? null : baseLine(told, base);
  const message: UserMessage | null = text === null ? null : { role: 'user', content: text, timestamp: Date.now() };
  await harness.commit(async tx => {
    const doc = await tx.doc(WorkspaceBaseDoc, conversationId);
    doc.turn = turn;
    if (base?.head) doc.told = { parentId: base.parent?.id ?? null, head: base.head, merged: base.parent?.merged ?? false };
    if (message) await tx.appendEntry(conversationId, { kind: 'gitspace.machine-notice', data: { source: 'Base' }, model: [message] });
  }, context);
  return message;
}

/** A compaction summarizes the Base lines away: the next turn says the base again when the branch is behind. */
export async function baseAfterCompaction(harness: Harness, conversationId: ConversationId, context: Context): Promise<void> {
  await harness.commit(async tx => {
    const doc = await tx.doc(WorkspaceBaseDoc, conversationId);
    doc.told = null;
    doc.turn = null;
  }, context);
}
