// Comments on what an agent wrote (docs/BLOCK-DOCUMENTS-DESIGN.md §4): the comments people stage for their next
// message, and the lookup derived from the transcript. A sent comment lives in the person's message only (its line and
// data, `commentsMessage`), and a reply in the agent's message (a Reply block); the lookup holds pointers to them, is
// updated after each commit that stores either, and can be rebuilt from the transcript at any time.
import { AssistantEntry, LiveDoc, UserEntry, type Conversation, type ConversationId, type ConversationRecord, type Cursor, type EntryRecord, type Harness, type Storage, type ToolExecutionApi } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context';
import { PI_ENTRY_ORDINALS, openerAt, parseConversationEvents, piMessageRowId, piSessionId, turnRowId, userRowId } from '@gitspace/blocks';
import { blockReplies } from '@gitspace/protocol/gitspace-ui';
import { STAGED_ANSWERS_MAX, STAGED_COMMENTS_MAX, messageComments, type CommentAnchor, type CommentLookup, type OpenDocumentKind, type StagedComment } from '@gitspace/protocol-runtime/comments';
import { questionState } from '@gitspace/protocol-runtime';
import { AutomationRequestsDoc, CommentLookupDoc, QuestionsDoc, StagedCommentsDoc } from './documents.js';
import { messageAnswer, questionRefusal } from './questions.js';
import { BLOCK_FIX_REQUEST, turnOpeners } from './transcript-rows.js';

/** Conversations, entries or submissions one scan reads. */
const SCAN_ENTRIES = 64;

/** The text of a person's input entry. */
function inputText(entry: EntryRecord): string {
  const message = entry.model?.[0];
  if (message?.role !== 'user') return '';
  return typeof message.content === 'string' ? message.content : message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n');
}

/**
 * Whether a person started the conversation's running turn: its first input is neither an automation run's instruction
 * (its request id in `AutomationRequestsDoc`) nor delivered events (`<gitspace-event>` envelopes: workspace reports,
 * jobs, subagents and the rest), as `commentWindow` tells them apart. A continue counts as its run's first entry. False
 * with no running turn.
 */
export async function turnStartedByPerson(api: Pick<ToolExecutionApi, 'snapshot' | 'commit' | 'conversationId'>, context: Context): Promise<boolean> {
  const run = (await api.snapshot(LiveDoc, api.conversationId, context))?.run;
  if (!run) return false;
  const automations = (await api.snapshot(AutomationRequestsDoc, context))?.requests ?? {};
  const first = run.inputs[0];
  return api.commit(async tx => {
    const submission = first === undefined ? undefined : await tx.submission(first);
    if (submission?.requestId !== undefined && automations[submission.requestId]) return false;
    const entryId = submission?.type === 'input' && submission.entry !== undefined ? submission.entry : run.first;
    const entry = entryId === undefined ? undefined : await tx.entry(entryId);
    return entry !== undefined && UserEntry.is(entry) && parseConversationEvents(inputText(entry)) === null;
  }, context);
}

/** Whether a stored entry adds to the lookup: a person's message with comments, or an agent's message with Replies. */
export function carriesComments(entry: EntryRecord): boolean {
  if (UserEntry.is(entry)) return messageComments(inputText(entry)).length > 0;
  return AssistantEntry.is(entry) && (entry.model ?? []).some(message => message.role === 'assistant' && message.content.some(part => part.type === 'text' && blockReplies(part.text).length > 0));
}

/**
 * The turns of a conversation that take comments, oldest first: the one the newest input from a person or the project
 * agent opened, and every turn an automated input opened after it. Empty before the first such input. Automated inputs
 * are recorded as such where they are submitted: an automation run's instruction (a pull request's or CI batch, a
 * schedule, a watch) by its request id in `AutomationRequestsDoc`, and delivered events (background jobs, processes,
 * subagents, machines, workspace reports, browsers, answered questions) as an input of `<gitspace-event>` envelopes
 * (`formatConversationEvents`). A block fix step opens no turn. A fork's turns before the fork are its parent's inputs.
 */
export async function commentWindow(harness: Harness, storage: Storage, conversationId: ConversationId): Promise<string[]> {
  const automations = (await harness.snapshot(AutomationRequestsDoc, BACKGROUND_CONTEXT))?.requests ?? {};
  const session = piSessionId(String(conversationId));
  const turns: string[] = [];
  let current: ConversationId | undefined = conversationId;
  let through = Number.POSITIVE_INFINITY;
  while (current !== undefined) {
    let cursor: Cursor | undefined;
    do {
      const page = await storage.scanSubmissions({ conversationId: current, order: 'descending' }, SCAN_ENTRIES, cursor, BACKGROUND_CONTEXT);
      // Newest placed input first: a steer is placed ahead of the follow-ups admitted before it.
      const inputs = page.items.flatMap(record => record.type === 'input' && record.entry !== undefined && Number(record.entry) <= through && !record.requestId?.startsWith(BLOCK_FIX_REQUEST) ? [{ entry: record.entry, requestId: record.requestId }] : [])
        .sort((left, right) => Number(right.entry) - Number(left.entry));
      for (const input of inputs) {
        turns.unshift(turnRowId(session, Number(input.entry) * PI_ENTRY_ORDINALS));
        if (input.requestId !== undefined && automations[input.requestId]) continue;
        const placed = await storage.entry(current, input.entry, BACKGROUND_CONTEXT);
        if (placed && parseConversationEvents(inputText(placed.entry)) === null) return turns;
      }
      cursor = page.next;
    } while (cursor);
    const parent: ConversationRecord['parent'] = (await storage.conversation(current, BACKGROUND_CONTEXT))?.parent;
    if (!parent) break;
    through = Math.min(through, Number(parent.at));
    current = parent.conversationId;
  }
  return [];
}

/** Stages a comment: on a turn of the comment window (`commentWindow`) of the conversation a turn anchor names, or on
 * the Goal, a Change Guide revision or a drive doc, whose comments never lock. A comment staged in the window stays
 * staged while automated inputs extend it. */
export async function stageComment(harness: Harness, storage: Storage, conversation: Conversation, anchor: CommentAnchor, note: string, deviceId: string | null): Promise<StagedComment> {
  if (anchor.document.kind === 'turn') {
    if (anchor.document.conversationId !== String(conversation.id)) throw new Error('The comment names another conversation');
    if (!(await commentWindow(harness, storage, conversation.id)).includes(anchor.document.turnId)) throw new Error('Comments go on what the agent wrote since the last message');
  }
  const comment: StagedComment = { id: `cm-${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, anchor, note, stagedAt: new Date().toISOString(), deviceId };
  await harness.commit(async tx => {
    const staged = await tx.doc(StagedCommentsDoc);
    if (staged.items.length >= STAGED_COMMENTS_MAX) throw new Error(`At most ${STAGED_COMMENTS_MAX} comments wait for a message`);
    staged.items.push(comment);
  }, BACKGROUND_CONTEXT);
  return comment;
}

/** Changes a staged comment's note. */
export async function editStagedComment(harness: Harness, id: string, note: string): Promise<void> {
  await harness.commit(async tx => {
    const comment = (await tx.doc(StagedCommentsDoc)).items.find(item => item.id === id);
    if (!comment) throw new Error('The comment is no longer staged');
    comment.note = note;
  }, BACKGROUND_CONTEXT);
}

/** Takes staged comments back (or out, once a message carries them). */
export async function unstageComments(harness: Harness, ids: readonly string[]): Promise<void> {
  await harness.commit(async tx => {
    const staged = await tx.doc(StagedCommentsDoc);
    staged.items = staged.items.filter(item => !ids.includes(item.id));
  }, BACKGROUND_CONTEXT);
}

/** The staged comments `ids` names, in staging order; each must still be staged. */
export async function stagedComments(harness: Harness, ids: readonly string[]): Promise<StagedComment[]> {
  const items = (await harness.snapshot(StagedCommentsDoc, BACKGROUND_CONTEXT))?.items ?? [];
  const found = items.filter(item => ids.includes(item.id));
  if (found.length !== new Set(ids).size) throw new Error('A comment in this message is no longer staged');
  return found;
}

/** Stages a person's answer to the open question `questionId` of the conversation for their next message, replacing
 * one staged for it before. The answer must be one the question takes from a message (`messageAnswer`). */
export async function stageAnswer(harness: Harness, conversation: Conversation, questionId: string, answer: unknown, canApprove: boolean, deviceId: string | null): Promise<void> {
  await harness.commit(async tx => {
    const question = (await tx.doc(QuestionsDoc)).items.find(item => item.id === questionId);
    if (!question) throw new Error(`Question ${questionId} is not one this workspace's agents asked`);
    if (question.conversationId !== String(conversation.id)) throw new Error(`Question ${questionId} belongs to another conversation`);
    if (questionState(question) !== 'open') throw new Error(questionRefusal(question));
    const staged = await tx.doc(StagedCommentsDoc);
    const answers = staged.answers ?? [];
    const next = { questionId, answer: messageAnswer(question, answer, canApprove), stagedAt: new Date().toISOString(), deviceId };
    if (answers.some(item => item.questionId === questionId)) { staged.answers = answers.map(item => item.questionId === questionId ? next : item); return; }
    if (answers.length >= STAGED_ANSWERS_MAX) throw new Error(`At most ${STAGED_ANSWERS_MAX} answers wait for a message`);
    staged.answers = [...answers, next];
  }, BACKGROUND_CONTEXT);
}

/** Takes a staged answer back: its question waits for an answer again. */
export async function unstageAnswer(harness: Harness, questionId: string): Promise<void> {
  await harness.commit(async tx => {
    const staged = await tx.doc(StagedCommentsDoc);
    staged.answers = (staged.answers ?? []).filter(item => item.questionId !== questionId);
  }, BACKGROUND_CONTEXT);
}

/**
 * Adds to the lookup every comment and reply stored after `CommentLookupDoc.through` (every one when it is null), moves
 * `through` to the newest entry read, and drops the sent comments from the staged ones, in one commit. A person's
 * message row is `userRowId` of the turn its input opened; an agent message row is `piMessageRowId`, as the transcript
 * reader names them. A failed or aborted reply, and a reply before its conversation's first input, answer nothing.
 */
export async function repairCommentLookup(harness: Harness, storage: Storage): Promise<void> {
  const through = (await harness.snapshot(CommentLookupDoc, BACKGROUND_CONTEXT))?.through ?? null;
  let newest = through ?? 0;
  const comments: Record<string, { conversationId: string; message: string; anchor: CommentAnchor }> = {};
  const replies: Record<string, string[]> = {};
  let conversations: Cursor | undefined;
  do {
    const page = await storage.scanConversations({}, SCAN_ENTRIES, conversations, BACKGROUND_CONTEXT);
    for (const conversation of page.items) {
      const conversationId = String(conversation.id);
      let openers: readonly number[] | undefined;
      let cursor: Cursor | undefined;
      scan: do {
        const entries = await storage.scanEntries({ conversationId: conversation.id }, SCAN_ENTRIES, cursor, BACKGROUND_CONTEXT);
        for (const entry of entries.items) {
          const entryId = Number(entry.id);
          // Newest first: an entry at or below the last scan ends this conversation's scan.
          if (through !== null && entryId <= through) break scan;
          newest = Math.max(newest, entryId);
          if (String(entry.conversationId) !== conversationId || !carriesComments(entry)) continue;
          openers ??= await turnOpeners(storage, conversation.id, BACKGROUND_CONTEXT);
          const opener = openerAt(openers, entryId);
          if (opener === undefined) continue;
          const turn = turnRowId(piSessionId(conversationId), opener * PI_ENTRY_ORDINALS);
          if (UserEntry.is(entry)) {
            for (const comment of messageComments(inputText(entry))) comments[comment.id] = { conversationId, message: userRowId(turn), anchor: comment.anchor };
            continue;
          }
          for (const [index, message] of (entry.model ?? []).entries()) {
            if (message.role !== 'assistant' || message.stopReason === 'error' || message.stopReason === 'aborted') continue;
            for (const [part, content] of message.content.entries()) {
              const answered = content.type === 'text' ? blockReplies(content.text).map(reply => reply.comment) : [];
              if (answered.length > 0) replies[piMessageRowId(conversationId, opener, entryId, index, part)] = answered;
            }
          }
        }
        cursor = entries.next;
      } while (cursor);
    }
    conversations = page.next;
  } while (conversations);
  if (through !== null && newest === through) return;
  const sent = Object.keys(comments);
  await harness.commit(async tx => {
    const lookup = await tx.doc(CommentLookupDoc);
    if (sent.length > 0 || Object.keys(replies).length > 0) lookup.revision++;
    Object.assign(lookup.comments, comments);
    Object.assign(lookup.replies, replies);
    lookup.through = Math.max(lookup.through ?? 0, newest);
    if (sent.length > 0) {
      const staged = await tx.doc(StagedCommentsDoc);
      staged.items = staged.items.filter(item => !sent.includes(item.id));
    }
  }, BACKGROUND_CONTEXT);
}

/** Rebuilds the lookup from the whole transcript. */
export async function rebuildCommentLookup(harness: Harness, storage: Storage): Promise<void> {
  await harness.commit(async tx => {
    const lookup = await tx.doc(CommentLookupDoc);
    lookup.through = null;
    lookup.comments = {};
    lookup.replies = {};
  }, BACKGROUND_CONTEXT);
  await repairCommentLookup(harness, storage);
}

/** The lookup's comments on the turns `turnIds` and on every revision of the open documents `documents` (the Goal, the
 * Change Guide, drive docs: only those of the files `drivePaths` names when it is given), and the replies to them, with
 * the comments the replies in those turns answer. */
export async function commentLookup(harness: Harness, turnIds: readonly string[], documents: readonly OpenDocumentKind[] = [], drivePaths?: readonly string[]): Promise<CommentLookup> {
  const lookup = await harness.snapshot(CommentLookupDoc, BACKGROUND_CONTEXT);
  if (!lookup) return { comments: [], replies: [] };
  const turns = new Set(turnIds);
  const local = new Map(Object.entries(lookup.replies).filter(([row]) => turnIds.some(turn => row.startsWith(`${turn}:`))));
  const answered = new Set([...local.values()].flat());
  const comments = Object.entries(lookup.comments).filter(([id, { anchor: { document } }]) => {
    if (answered.has(id)) return true;
    if (document.kind === 'turn') return turns.has(document.turnId);
    return documents.includes(document.kind) && (document.kind !== 'drive' || drivePaths === undefined || drivePaths.includes(document.path));
  });
  const ids = new Set(comments.map(([id]) => id));
  return {
    comments: comments.map(([id, comment]) => ({ id, ...comment })),
    replies: Object.entries(lookup.replies).flatMap(([row, answers]) => answers.flatMap(comment => ids.has(comment) || local.has(row) ? [{ row, comment }] : [])),
  };
}
