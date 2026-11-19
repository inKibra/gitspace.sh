import { defineDoc, type ConversationId, type Harness } from '@earendil-works/pi-durable';
import type { Context } from '@earendil-works/chord/context';
import { boundedReplay } from './documents.js';
import type { Message, UserMessage } from '@earendil-works/pi-ai';
import { workspaceBoard, workspaceBoardChanges, type WorkspaceBoardRow } from '@gitspace/protocol-runtime';

/** Characters of board changes a conversation may get after its last full board; a change that would pass it comes as a
 * full board instead, so the current state never depends on a long replay. */
export const BOARD_CHANGES_CHARACTERS = 2_000;

/** The project agent's instruction about its board. It is the same on every turn: what changes goes into the
 * conversation, never into the instructions, whose every change would invalidate the prompt cache. */
export const PROJECT_BOARD_INSTRUCTION = 'Workspace board: your turns carry this project\'s workspaces, one line each (phase; working, waiting on a person and on what, idle or failed; pull request; since when). A full board comes on your first turn, after a compaction and now and then; later turns carry only the lines that changed since your previous turn. The latest full board plus the changes after it is the current state; workspace statuses earlier in this conversation are history. space_workspace board reads the full board now. When the board or a space_workspace read fails, tell the person you could not read the current state and why; never answer from memory instead.';

/** A stack head's instruction about its stack board, in its instructions only while it heads a stack (its board doc
 * holds members), so it changes only when the workspace becomes or stops being a head. */
export const STACK_BOARD_INSTRUCTION = 'Stack board: this workspace heads a stack, so your turns carry its members (every workspace stacked on it, at any depth) in stack order, one line each: the workspace it is stacked on and how its branch stands against it (commits behind, base rewritten, parent merged), then phase, activity, pull request and since when. A full board comes on your first turn as head, after a compaction and now and then; later turns carry only the lines that changed since your previous turn. The latest full board plus the changes after it is the current state of your stack. You lead your members as the project agent leads the project: space_workspace start instructs one, questions and answer answer its plain questions with the person\'s approval (the space-chain skill says when to have members sync). Members instruct no one. When the board fails to read, tell the person you could not read your stack\'s state and why; never answer from memory instead.';

/** The board a main conversation's turns carry: the project agent's (`project`, every workspace of the project), or a
 * stack head's (`stack`, its members in stack order). `read` is null while the workspace heads no stack. */
export type TurnBoard = { kind: 'project' | 'stack'; read(): Promise<WorkspaceBoardRow[] | null> };
const BOARD_WORDS: Record<TurnBoard['kind'], { title: string; subject: string }> = {
  project: { title: 'Workspace board', subject: 'this project\'s workspaces' },
  stack: { title: 'Stack board', subject: 'your stack\'s members' },
};

/** What a conversation was last told: the rows of its last board read and when it was read, the first line of its last
 * full board (null: the next turn gets a full one), the characters of changes since that board, and the run that read it.
 * Rows of an earlier version lack fields the current line reads (version 1 `lastReply` and `journal`, version 2 every
 * pull request with its state, `pullRequests`, version 3 `lastReplySource`); they were only the baseline of the next
 * changes, so an earlier state becomes the initial one and the next turn gets a full board. */
const initialBoard = () => ({ rows: [], at: 0, full: null, changes: 0, turn: null });
export const ProjectBoardDoc = defineDoc<{ rows: WorkspaceBoardRow[]; at: number; full: string | null; changes: number; turn: string | null }>({ kind: 'gitspace.project-board', version: 4, scope: 'conversation', history: 'latest', fork: 'current', initial: initialBoard, migrate: initialBoard, checkpointWhen: boundedReplay });

/**
 * The board message a turn of the project agent or a stack's head starts with, read once per turn (`turn`, its run) and
 * appended to the conversation, so every later request carries it at the same place and the cached prefix stays as it
 * was. A full board when the conversation's last one is no longer in `messages` (a compaction or rewind removed it) or
 * the changes since it would pass BOARD_CHANGES_CHARACTERS; otherwise the lines that changed since the previous turn, or
 * none. A failed read is said, with its reason. A workspace that heads no stack (`read` null) gets nothing, and its
 * board starts over: once it heads one, its next turn gets a full board. Null when nothing is appended.
 */
export async function boardForTurn(harness: Harness, conversationId: ConversationId, turn: string, messages: readonly Message[], board: TurnBoard, context: Context): Promise<UserMessage | null> {
  const words = BOARD_WORDS[board.kind];
  const state = await harness.snapshot(ProjectBoardDoc, conversationId, context);
  if (state?.turn === turn) return null;
  const at = new Date();
  let text: string | null = null;
  let next = { rows: state?.rows ?? [], at: state?.at ?? 0, full: state?.full ?? null, changes: state?.changes ?? 0, turn };
  const read = await board.read().then(rows => ({ rows, error: null }), (error: unknown) => ({ rows: null, error: error instanceof Error ? error.message : String(error) }));
  if (read.error !== null) text = `The ${words.title.toLowerCase()} could not be read at ${at.toISOString()}: ${read.error}\nTell the person you could not read the current state of ${words.subject}; do not answer from memory.`;
  else if (read.rows === null) next = { ...initialBoard(), turn };
  else {
    const rows = read.rows;
    const full = state?.full ?? null;
    const shown = full !== null && messages.some(message => message.role === 'user' && (typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : '').join('')).includes(full));
    const changes = shown ? workspaceBoardChanges(next.rows, rows, new Date(next.at), at, words.title) : null;
    if (shown && next.changes + (changes?.length ?? 0) <= BOARD_CHANGES_CHARACTERS) {
      text = changes;
      next = { ...next, rows, at: at.getTime(), changes: next.changes + (changes?.length ?? 0) };
    } else {
      text = workspaceBoard(rows, at, words.title);
      next = { rows, at: at.getTime(), full: text.split('\n', 1)[0]!, changes: 0, turn };
    }
  }
  const message: UserMessage | null = text === null ? null : { role: 'user', content: text, timestamp: at.getTime() };
  await harness.commit(async tx => {
    Object.assign(await tx.doc(ProjectBoardDoc, conversationId), next);
    if (message) await tx.appendEntry(conversationId, { kind: 'gitspace.workspace-board', data: {}, model: [message] });
  }, context);
  return message;
}

/** A compaction summarizes the conversation's board away: the summary ends with a full board, and the next request gets
 * a full board of its own. The summary is kept without one when the board cannot be read or the workspace heads no
 * stack. */
export async function boardAfterCompaction(harness: Harness, conversationId: ConversationId, summary: string, board: TurnBoard, context: Context): Promise<string> {
  await harness.commit(async tx => {
    const doc = await tx.doc(ProjectBoardDoc, conversationId);
    doc.full = null;
    doc.turn = null;
  }, context);
  try {
    const rows = await board.read();
    return rows === null ? summary : `${summary}\n\n${workspaceBoard(rows, new Date(), BOARD_WORDS[board.kind].title)}`;
  } catch { return summary; }
}
