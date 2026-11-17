// What the comment layer of an open workspace shares (CommentLayer.tsx provides it): the comments on the main
// conversation, the Goal, the Change Guide and drive docs, staged and sent, the rows that take new ones, and how to
// stage, edit and remove them.
import type { CommentAnchor, CommentDocument, CommentTarget } from '@gitspace/protocol-runtime/comments';
import { createContext } from 'react';

/** A comment on the conversation, the Goal, the Change Guide or a drive doc. `note` is null for a sent comment whose
 * message is not loaded. `replies`: the agent's Reply blocks answering it, each with its text when its message is
 * loaded. */
export interface CommentNote {
  id: string;
  anchor: CommentAnchor;
  note: string | null;
  state: 'staged' | 'sent';
  replies: readonly { row: string; text: string | null }[];
}

/** The part of a document a comment trigger or a selection is in: a chat message or tool call (`row`, its row id, in a
 * turn), or an entity of the Goal, a Change Guide revision or a drive doc (`row`, its ref, such as `requirement:<id>`
 * or `drive`, in `document`). `editable`: it takes new comments. */
export interface CommentScopeValue { row: string; editable: boolean; document: CommentDocument | null }

export interface CommentLayerValue {
  conversationId: string;
  notes: readonly CommentNote[];
  /** The rows that take new comments: everything the agent wrote since the last message from a person or the project
   * agent, the comment window (its stored messages, before, between and after its tool calls, and its tool calls). */
  open: ReadonlySet<string>;
  /** The turn a loaded row is in. */
  turnOf(row: string): string | undefined;
  /** Who writes comments here, for the margin's initials. */
  author: string;
  /** Stages a comment in a scope: on a row of the comment window, or on the Goal, a Change Guide revision or a drive
   * doc. */
  stage(scope: Pick<CommentScopeValue, 'row' | 'document'>, target: CommentTarget, quote: string, note: string): Promise<void>;
  edit(id: string, note: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Reads the comments on the drive doc at `path` (its drive URL) while it is shown; the returned function stops. */
  showDrive(path: string): () => void;
}

export const CommentLayer = createContext<CommentLayerValue | null>(null);

/** Opens where a comment on the Goal, the Change Guide or a drive doc is (the Inspector's tab, the Guide's section, the
 * drive file); null where there is no Inspector to open. */
export const DocumentNavigation = createContext<((anchor: CommentAnchor) => void) | null>(null);

/** A comment as a Goal or Guide revision or a drive doc shows it: on the revision or version shown, or carried forward to
 * it unchanged; `outdated` when what it is on changed after the revision it was written on (`revision`), so it shows its
 * old quote. `version`: a drive doc comment's file version, as people read it (a short hash). */
export interface DocumentNote extends CommentNote { revision: number; outdated: boolean; version?: string }

/** The Goal, the Change Guide or a drive doc drawn as a document: the revision or version new comments go on (null
 * where it takes none, an older Guide revision), its comments as shown, and how to show the revision an outdated one was
 * written on. */
export interface DocumentCommentsValue {
  document: CommentDocument | null;
  notes: readonly DocumentNote[];
  onShowRevision: ((revision: number) => void) | null;
}

export const DocumentComments = createContext<DocumentCommentsValue | null>(null);
