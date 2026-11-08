import { defineDoc, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { workspaceBoard, workspaceBoardChanges, type WorkspaceBoardRow } from '@gitspace/protocol-runtime';

/** Characters of board changes a conversation may get after its last full board; a change that would pass it comes as a
 * full board instead, so the current state never depends on a long replay. */
export const BOARD_CHANGES_CHARACTERS = 2_000;

/** The project agent's instruction about its board. It is the same on every turn: what changes goes into the
 * conversation, never into the instructions, whose every change would invalidate the prompt cache. */
export const PROJECT_BOARD_INSTRUCTION = 'Workspace board: your turns carry this project\'s workspaces, one line each (phase; working, waiting on a person and on what, idle or failed; pull request; since when). A full board comes on your first turn, after a compaction and now and then; later turns carry only the lines that changed since your previous turn. The latest full board plus the changes after it is the current state; workspace statuses earlier in this conversation are history. space_workspace board reads the full board now. When the board or a space_workspace read fails, tell the person you could not read the current state and why; never answer from memory instead.';

/** What a conversation was last told: the rows of its last board read and when it was read, the first line of its last
 * full board (null: the next turn gets a full one), the characters of changes since that board, and the run that read it. */
export const ProjectBoardDoc = defineDoc<{ rows: WorkspaceBoardRow[]; at: number; full: string | null; changes: number; turn: string | null }>({ kind: 'gitspace.project-board', version: 1, scope: 'conversation', history: 'latest', fork: 'current', initial: () => ({ rows: [], at: 0, full: null, changes: 0, turn: null }) });

/**
 * The board message a turn of the project agent starts with, read once per turn (`turn`, its run) and appended to the
 * conversation, so every later request carries it at the same place and the cached prefix stays as it was. A full board
 * when the conversation's last one is no longer in `messages` (a compaction or rewind removed it) or the changes since
 * it would pass BOARD_CHANGES_CHARACTERS; otherwise the lines that changed since the previous turn, or none. A failed
 * read is said, with its reason. Null when nothing is appended.
 */
export async function boardForTurn(harness: Harness, conversationId: ConversationId, turn: string, messages: readonly Message[], read: () => Promise<WorkspaceBoardRow[]>, context: Context): Promise<UserMessage | null> {
  const state = await harness.snapshot(ProjectBoardDoc, conversationId, context);
  if (state?.turn === turn) return null;
  const at = new Date();
  let text: string | null;
  let next = { rows: state?.rows ?? [], at: state?.at ?? 0, full: state?.full ?? null, changes: state?.changes ?? 0, turn };
  try {
    const rows = await read();
    const full = state?.full ?? null;
    const shown = full !== null && messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join('')).includes(full));
    const changes = shown ? workspaceBoardChanges(next.rows, rows, new Date(next.at), at) : null;
    if (shown && next.changes + (changes?.length ?? 0) <= BOARD_CHANGES_CHARACTERS) {
      text = changes;
      next = { ...next, rows, at: at.getTime(), changes: next.changes + (changes?.length ?? 0) };
    } else {
      text = workspaceBoard(rows, at);
      next = { rows, at: at.getTime(), full: text.split('\n', 1)[0]!, changes: 0, turn };
    }
  } catch (error) {
    text = `The workspace board could not be read at ${at.toISOString()}: ${error instanceof Error ? error.message : String(error)}\nTell the person you could not read the current state of this project's workspaces; do not answer from memory.`;
  }
  const message: UserMessage | null = text === null ? null : { role: 'user', content: text, timestamp: at.getTime() };
  await harness.commit(async tx => {
    Object.assign(await tx.doc(ProjectBoardDoc, conversationId), next);
    if (message) await tx.appendEntry(conversationId, { kind: 'gitspace.workspace-board', data: {}, model: [message] });
  }, context);
  return message;
}

/** A compaction summarizes the conversation's board away: the summary ends with a full board, and the next request gets
 * a full board of its own. The summary is kept without one when the board cannot be read. */
export async function boardAfterCompaction(harness: Harness, conversationId: ConversationId, summary: string, read: () => Promise<WorkspaceBoardRow[]>, context: Context): Promise<string> {
  await harness.commit(async tx => {
    const doc = await tx.doc(ProjectBoardDoc, conversationId);
    doc.full = null;
    doc.turn = null;
  }, context);
  try { return `${summary}\n\n${workspaceBoard(await read(), new Date())}`; }
  catch { return summary; }
}
