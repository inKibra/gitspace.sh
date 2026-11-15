// What the comment layer of an open workspace shares (CommentLayer.tsx provides it): the comments on the main
// conversation, staged and sent, the rows that take new ones, and how to stage, edit and remove them.
import type { CommentAnchor, CommentTarget } from '@gitspace/protocol-runtime/comments';
import { createContext } from 'react';

/** A comment on the conversation. `note` is null for a sent comment whose message is not loaded. `replies`: the agent's
 * Reply blocks answering it, each with its text when its message is loaded. */
export interface CommentNote {
  id: string;
  anchor: CommentAnchor;
  note: string | null;
  state: 'staged' | 'sent';
  replies: readonly { row: string; text: string | null }[];
}

export interface CommentLayerValue {
  conversationId: string;
  notes: readonly CommentNote[];
  /** The rows that take new comments: everything the agent wrote since the person's last message (its stored messages,
   * before, between and after its tool calls, and its tool calls). */
  open: ReadonlySet<string>;
  /** The turn a loaded row is in. */
  turnOf(row: string): string | undefined;
  /** Who writes comments here, for the margin's initials. */
  author: string;
  /** Stages a comment on a row of the latest turn. */
  stage(row: string, target: CommentTarget, quote: string, note: string): Promise<void>;
  edit(id: string, note: string): Promise<void>;
  remove(id: string): Promise<void>;
}

export const CommentLayer = createContext<CommentLayerValue | null>(null);
